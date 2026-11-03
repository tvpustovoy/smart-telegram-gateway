// Связь с другими агентами (5.19) — дочерним процессом шлюза. stg-link нужен только шлюзу, поэтому своей службы у него
// нет: шлюз запускает его при старте (раздел `link` в config.yaml), поднимает снова, если тот вышел, и останавливает
// вместе с собой. Нет раздела — связь не запускается; её, как раньше, можно запустить руками.
// - Перезапуск — через паузу: 1 с, дальше вдвое, не больше минуты; проработала минуту — снова с 1 с. Пауза идёт по часам
//   шлюза.
// - Остановка шлюза — SIGTERM связи; не вышла за 5 с — SIGKILL.
// - Связь знает pid шлюза (STG_LINK_PARENT) и выходит сама, если шлюз пропал без остановки: сиротой не остаётся.
// - Что связь пишет в stderr, идёт в журнал строкой link_log (до 500 знаков): там номера писем и причины, текстов нет.
// - Вторая связь при живой первой (скажем, запущенной руками) получает от шлюза busy и ждёт: двух связей не бывает.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Clock, Journal, Timer } from 'stg-core';

export const LINK_RESTART_MIN_MS = 1_000;
export const LINK_RESTART_MAX_MS = 60_000;
/** Проработала столько — пауза перед следующим перезапуском снова минимальная. */
export const LINK_STABLE_MS = 60_000;
export const LINK_KILL_MS = 5_000;
export const LINK_LOG_MAX = 500;

/** stg-link того же дерева: packages/link/dist/index.js рядом с packages/gateway. */
export function defaultLinkEntry(): string {
  return fileURLToPath(new URL('../../link/dist/index.js', import.meta.url));
}

/** «~/…» — от домашнего каталога. */
function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export type LinkSpawn = (
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'ignore', 'pipe'] },
) => ChildProcess;

export interface LinkRunnerOptions {
  /** Модуль порта сети агентов: полный путь или с «~/». */
  port: string;
  /** Имя шлюза в сети. */
  identity: string;
  /** Каталог бота: STG_HOME связи. */
  home: string;
  clock: Clock;
  journal: Journal;
  /** Для тестов: другой stg-link и другой запуск процесса. */
  entry?: string;
  spawn?: LinkSpawn;
}

export class LinkRunner {
  private child: ChildProcess | null = null;
  private startedAt = 0;
  private delay = LINK_RESTART_MIN_MS;
  private timer: Timer | null = null;
  private stopping = false;

  constructor(private readonly opts: LinkRunnerOptions) {}

  start(): void {
    if (this.stopping || this.child !== null) return;
    const entry = this.opts.entry ?? defaultLinkEntry();
    const port = expandHome(this.opts.port);
    if (!fs.existsSync(entry)) return this.retry('link_failed', { error: `нет stg-link: ${entry}` }, 0);
    if (!fs.existsSync(port)) return this.retry('link_failed', { error: `нет модуля порта: ${port}` }, 0);
    const spawn = this.opts.spawn ?? (nodeSpawn as LinkSpawn);
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, '--port', port, '--identity', this.opts.identity], {
        env: { ...process.env, STG_HOME: this.opts.home, STG_LINK_PARENT: String(process.pid) },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      return this.retry('link_failed', { error: (err as Error).message }, 0);
    }
    this.child = child;
    this.startedAt = this.opts.clock.now();
    let done = false;
    const finish = (code: number | null, signal: string | null, error?: string): void => {
      if (done) return;
      done = true;
      this.child = null;
      const ran = this.opts.clock.now() - this.startedAt;
      if (this.stopping) {
        this.opts.journal.write('link_stopped', { code, signal });
        return;
      }
      this.retry('link_exited', { code, signal, ...(error !== undefined ? { error } : {}) }, ran);
    };
    // Процесс не запустился (нет node, нет прав): 'exit' может и не прийти.
    child.once('error', (err) => {
      if (child.pid === undefined) finish(null, null, err.message);
    });
    child.once('exit', (code, signal) => finish(code, signal));
    if (child.stderr) {
      const lines = readline.createInterface({ input: child.stderr });
      lines.on('line', (raw) => {
        const line = raw.replace(/^\S+ stg-link: /, '').slice(0, LINK_LOG_MAX);
        if (line) this.opts.journal.write('link_log', { line });
      });
    }
    this.opts.journal.write('link_started', { pid: child.pid ?? null });
  }

  /** Остановить связь вместе со шлюзом: больше не поднимать; SIGTERM, через 5 с — SIGKILL. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.timer?.cancel();
    this.timer = null;
    const child = this.child;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), LINK_KILL_MS);
      const giveUp = setTimeout(resolve, LINK_KILL_MS * 2);
      child.once('exit', () => {
        clearTimeout(kill);
        clearTimeout(giveUp);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  /** Связь вышла или не запустилась — поднять снова через паузу. */
  private retry(ev: string, fields: Record<string, unknown>, ranMs: number): void {
    if (this.stopping) return;
    if (ranMs >= LINK_STABLE_MS) this.delay = LINK_RESTART_MIN_MS;
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, LINK_RESTART_MAX_MS);
    this.opts.journal.write(ev, { ...fields, ran_ms: ranMs, restart_in_ms: wait });
    this.timer = this.opts.clock.setTimeout(() => {
      this.timer = null;
      this.start();
    }, wait);
  }
}
