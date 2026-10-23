// Клиент JSON-RPC к `codex app-server` по stdio (#55): дочерний процесс, сообщения — JSON по одному в строке. Запросы
// сопоставляются ответам по id; уведомления и запросы сервера (item/tool/call, одобрения) отдаются владельцу клиента.
// app-server в режиме stdio выходит сам, когда закрыт его stdin: адаптер упал — Codex не остаётся висеть.

import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';

/** Ошибка JSON-RPC от app-server (или наша — «процесс вышел», «срок вышел»). */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface AppServerOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Уведомление сервера. */
  onNotification: (method: string, params: unknown) => void;
  /** Запрос сервера: вернуть result или бросить RpcError. */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  /** Процесс вышел (сам или по close()). */
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void;
  /** Срок ответа на запрос по умолчанию. */
  requestTimeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const STDERR_TAIL = 4096;

/** Разобрать строку вывода: объект JSON или null (мусор — в журнал). */
export function parseLine(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class AppServer {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closing = false;
  private exitedFlag = false;
  private stderrBuf = '';
  readonly exited: Promise<void>;

  private constructor(
    private readonly child: ChildProcess,
    private readonly opts: AppServerOptions,
  ) {
    this.exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => {
        this.exitedFlag = true;
        this.failPending(new RpcError(`codex app-server вышел (код ${code ?? '—'}${signal ? `, ${signal}` : ''})`, -32099));
        opts.onExit({ code, signal, expected: this.closing });
        resolve();
      });
    });
    child.on('error', (err) => opts.log(`codex app-server: ${err.message}`));
    child.stdin?.on('error', () => undefined);
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => this.onLine(line));
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      this.stderrBuf = (this.stderrBuf + s).slice(-STDERR_TAIL);
      for (const l of s.split('\n')) if (l.trim()) opts.log(`codex stderr: ${l.trimEnd().slice(0, 500)}`);
    });
  }

  static spawn(opts: AppServerOptions): AppServer {
    // Своя группа процессов: Ctrl-C в окне адаптера не убивает app-server посреди хода — адаптер сам закрывает его stdin.
    const child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    return new AppServer(child, opts);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return !this.exitedFlag;
  }

  /** Последние строки stderr app-server — для разбора сбоя. */
  stderrTail(): string {
    return this.stderrBuf;
  }

  request<T>(method: string, params: unknown, timeoutMs = this.opts.requestTimeoutMs ?? 60_000): Promise<T> {
    if (!this.alive || !this.child.stdin || this.child.stdin.destroyed) return Promise.reject(new RpcError('codex app-server не запущен', -32099));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`codex app-server не ответил на ${method} за ${timeoutMs} мс`, -32098));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** Закрыть stdin и дождаться выхода; не вышел за graceMs — SIGTERM, ещё graceMs — SIGKILL. */
  async close(graceMs = 3000): Promise<void> {
    this.closing = true;
    if (!this.alive) return;
    try {
      this.child.stdin?.end();
    } catch {
      // уже закрыт
    }
    const wait = (ms: number): Promise<boolean> =>
      Promise.race([this.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    if (await wait(graceMs)) return;
    this.child.kill('SIGTERM');
    if (await wait(graceMs)) return;
    this.child.kill('SIGKILL');
    await this.exited;
  }

  private write(msg: Record<string, unknown>): void {
    try {
      this.child.stdin?.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      this.opts.log(`codex app-server: запись не удалась: ${(err as Error).message}`);
    }
  }

  private failPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private onLine(line: string): void {
    const msg = parseLine(line);
    if (!msg) {
      if (line.trim()) this.opts.log(`codex app-server: строка не JSON: ${line.slice(0, 200)}`);
      return;
    }
    const method = typeof msg.method === 'string' ? msg.method : null;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (method && hasId) {
      void this.answerServerRequest(msg.id, method, msg.params);
      return;
    }
    if (method) {
      try {
        this.opts.onNotification(method, msg.params);
      } catch (err) {
        this.opts.log(`уведомление ${method}: ${(err as Error).message}`);
      }
      return;
    }
    if (hasId && typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      const e = msg.error as { message?: unknown; code?: unknown; data?: unknown } | undefined;
      if (e) p.reject(new RpcError(typeof e.message === 'string' ? e.message : `ошибка ${p.method}`, typeof e.code === 'number' ? e.code : -32000, e.data));
      else p.resolve(msg.result);
    }
  }

  private async answerServerRequest(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.opts.onRequest(method, params);
      this.write({ id, result });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32000;
      this.write({ id, error: { code, message: (err as Error).message } });
    }
  }
}
