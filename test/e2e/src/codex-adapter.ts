// Адаптер stg-codex дочерним процессом (#55): тесты — против поддельного app-server (stg-fake-codex), учения drill-codex —
// против настоящего `codex app-server`. Лента (stdout) и журнал (stderr) копятся; ждать можно строку ленты. Обвязку
// тестов (harness.ts) не грузит: её подключает node:test.

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const CODEX_ADAPTER_ENTRY = path.join(path.dirname(require.resolve('stg-codex/package.json')), 'dist', 'index.js');

export interface CodexAdapterOptions {
  /** Каталог бота (STG_HOME). */
  home: string;
  agentDir: string;
  /** Путь к codex (настоящий или подделка). */
  codex: string;
  /** Дополнительные переменные (FAKE_CODEX_DIR и т. п.). */
  env?: Record<string, string>;
  /** Ужатые сроки (STG_TEST_CHANNEL_TIME_SCALE, STG_TEST_CODEX_TIME_SCALE); учения с настоящим Codex — по настоящим. */
  fast?: boolean;
  /** Печатать ленту в этот поток по ходу (учения). */
  echo?: NodeJS.WritableStream;
  /** Окружение этого процесса целиком (без STG_*): учения с настоящим Codex — как у пользователя. */
  inheritEnv?: boolean;
}

const live = new Set<ChildProcess>();
process.on('exit', () => {
  for (const p of live) {
    try {
      p.kill('SIGKILL');
    } catch {
      // уже нет
    }
  }
});

export class CodexAdapter {
  feed = '';
  log = '';
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  private constructor(readonly child: ChildProcess) {
    live.add(child);
    this.exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => {
        live.delete(child);
        this.exitInfo = { code, signal };
        resolve(this.exitInfo);
      });
    });
  }

  static start(opts: CodexAdapterOptions): CodexAdapter {
    const inherited = opts.inheritEnv ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('STG_'))) : {};
    const env: NodeJS.ProcessEnv = {
      ...inherited,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? os.homedir(),
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      LANG: 'ru_RU.UTF-8',
      STG_HOME: opts.home,
      STG_TEST: '1',
      ...(opts.fast !== false ? { STG_TEST_CHANNEL_TIME_SCALE: '0.1', STG_TEST_CODEX_TIME_SCALE: '0.01' } : {}),
      ...opts.env,
    };
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CODEX_ADAPTER_ENTRY, '--agent-dir', opts.agentDir, '--codex', opts.codex, '--no-color'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const a = new CodexAdapter(child);
    child.stdout?.on('data', (d: Buffer) => {
      a.feed += d.toString();
      opts.echo?.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => (a.log += d.toString()));
    return a;
  }

  get alive(): boolean {
    return this.exitInfo === null;
  }

  /** Строки ленты. */
  lines(): string[] {
    return this.feed.split('\n').filter((l) => l.trim());
  }

  /** Дождаться строки ленты (по настоящему времени). */
  async waitFeed(pred: (line: string) => boolean, timeoutMs = 10_000, what = 'строки ленты'): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.lines().find(pred);
      if (hit) return hit;
      if (!this.alive) throw new Error(`stg-codex вышел (${JSON.stringify(this.exitInfo)}) — не дождались ${what}; журнал: ${this.log.slice(-1500)}`);
      if (Date.now() > deadline) throw new Error(`не дождались ${what} за ${timeoutMs} мс; лента: ${this.feed.slice(-1500)}; журнал: ${this.log.slice(-1500)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** SIGTERM и выход. */
  async stop(timeoutMs = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.alive) this.child.kill('SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`stg-codex не вышел за ${timeoutMs} мс; журнал: ${this.log.slice(-1000)}`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async kill9(): Promise<void> {
    if (this.alive) this.child.kill('SIGKILL');
    await this.exited;
  }
}
