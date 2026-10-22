// Часы — одно устройство для всех сроков и пауз шлюза (TECH-SPEC §7).
// Настоящие — Date.now и таймеры Node. Поддельные (STG_CLOCK=fake, только при STG_TEST=1) — время стоит,
// пока тест не скажет «advance <N>s» через тестовый сокет; время переживает перезапуск (файл в каталоге теста).

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileAtomicSync } from './fsutil.js';

export interface Timer {
  cancel(): void;
}

export interface Clock {
  readonly kind: 'real' | 'fake';
  /** Миллисекунды с начала эпохи Unix. */
  now(): number;
  /** Пауза; при отмене сигналом — отказ с причиной сигнала. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  setTimeout(fn: () => void, ms: number): Timer;
  setInterval(fn: () => void, ms: number): Timer;
}

export class RealClock implements Clock {
  readonly kind = 'real' as const;

  now(): number {
    return Date.now();
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await delay(Math.max(0, ms), undefined, signal ? { signal } : undefined);
  }

  setTimeout(fn: () => void, ms: number): Timer {
    const h = setTimeout(fn, Math.max(0, ms));
    return { cancel: () => clearTimeout(h) };
  }

  setInterval(fn: () => void, ms: number): Timer {
    const h = setInterval(fn, Math.max(1, ms));
    return { cancel: () => clearInterval(h) };
  }
}

interface FakeTimer {
  id: number;
  due: number;
  interval: number | null;
  fn: () => void;
  cancelled: boolean;
}

/** Даёт отработать обещаниям и вводу-выводу между срабатываниями таймеров. */
async function flushIo(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export interface FakeClockFile {
  now_ms: number;
}

export function readFakeClockFile(file: string): number | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<FakeClockFile>;
    return typeof data.now_ms === 'number' && Number.isFinite(data.now_ms) ? data.now_ms : null;
  } catch {
    return null;
  }
}

export function writeFakeClockFile(file: string, nowMs: number): void {
  writeFileAtomicSync(file, JSON.stringify({ now_ms: nowMs } satisfies FakeClockFile) + '\n');
}

export class FakeClock implements Clock {
  readonly kind = 'fake' as const;
  private t: number;
  private seq = 0;
  private timers: FakeTimer[] = [];
  private advancing: Promise<void> = Promise.resolve();

  /**
   * @param startMs начальное время, если файла ещё нет
   * @param file файл, в котором время переживает перезапуск; null — только в памяти
   */
  constructor(startMs: number, private readonly file: string | null = null) {
    const saved = file ? readFakeClockFile(file) : null;
    this.t = saved ?? startMs;
    this.persist();
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = this.addTimer(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms, null);
      const onAbort = (): void => {
        timer.cancel();
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  setTimeout(fn: () => void, ms: number): Timer {
    return this.addTimer(fn, ms, null);
  }

  setInterval(fn: () => void, ms: number): Timer {
    return this.addTimer(fn, ms, Math.max(1, ms));
  }

  /** Сколько таймеров ждёт (для тестов). */
  pendingTimers(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  /**
   * Сдвинуть время вперёд на ms: таймеры срабатывают по порядку сроков, время на каждом — срок таймера.
   * Вызовы встают в очередь, а не идут параллельно.
   */
  advance(ms: number): Promise<number> {
    if (!Number.isFinite(ms) || ms < 0) {
      return Promise.reject(new Error(`advance: недопустимый сдвиг ${ms}`));
    }
    const run = this.advancing.then(() => this.doAdvance(ms));
    this.advancing = run.catch(() => undefined);
    return run.then(() => this.t);
  }

  /**
   * Скачок времени, как после сна ноутбука: время сразу +ms, каждый просроченный таймер срабатывает один раз (уже в
   * новом времени), повторяющиеся считают следующий срок от него. В отличие от advance промежуточных срабатываний нет —
   * так шлюз видит скачок часов и пишет `wake` (5.3).
   */
  jump(ms: number): Promise<number> {
    if (!Number.isFinite(ms) || ms < 0) {
      return Promise.reject(new Error(`jump: недопустимый сдвиг ${ms}`));
    }
    const run = this.advancing.then(() => this.doJump(ms));
    this.advancing = run.catch(() => undefined);
    return run.then(() => this.t);
  }

  private async doJump(ms: number): Promise<void> {
    this.t += ms;
    const fired = new Set<FakeTimer>();
    for (;;) {
      const next = this.nextDue(this.t, fired);
      if (!next) break;
      fired.add(next);
      if (next.interval !== null) next.due = this.t + next.interval;
      else next.cancelled = true;
      try {
        next.fn();
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
      await flushIo();
    }
    this.timers = this.timers.filter((t) => !t.cancelled);
    this.persist();
    await flushIo();
  }

  private async doAdvance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const next = this.nextDue(target);
      if (!next) break;
      this.t = Math.max(this.t, next.due);
      if (next.interval !== null) {
        next.due += next.interval;
      } else {
        next.cancelled = true;
      }
      try {
        next.fn();
      } catch (err) {
        // Ошибка в таймере не должна останавливать ход времени; её увидит тот, кто ставил таймер.
        queueMicrotask(() => {
          throw err;
        });
      }
      await flushIo();
    }
    this.timers = this.timers.filter((t) => !t.cancelled);
    this.t = target;
    this.persist();
    await flushIo();
  }

  private nextDue(target: number, skip?: Set<FakeTimer>): FakeTimer | null {
    let best: FakeTimer | null = null;
    for (const t of this.timers) {
      if (t.cancelled || t.due > target || skip?.has(t)) continue;
      if (!best || t.due < best.due || (t.due === best.due && t.id < best.id)) best = t;
    }
    return best;
  }

  private addTimer(fn: () => void, ms: number, interval: number | null): Timer {
    const timer: FakeTimer = { id: ++this.seq, due: this.t + Math.max(0, ms), interval, fn, cancelled: false };
    // Отменённые таймеры (сроки опросов и отправок) не копятся, если время долго не двигают.
    if (this.timers.length >= 256) this.timers = this.timers.filter((t) => !t.cancelled);
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  private persist(): void {
    if (this.file) writeFakeClockFile(this.file, this.t);
  }
}

/** «600s», «10m», «2h», «1500ms», «1d» → миллисекунды. */
export function parseDuration(text: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/.exec(text);
  if (!m) throw new Error(`не понял срок «${text}»: нужно число и единица ms, s, m, h или d`);
  const n = Number(m[1]);
  const unit = m[2] as 'ms' | 's' | 'm' | 'h' | 'd';
  const k = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return Math.round(n * k);
}

export interface ClockEnvPaths {
  /** Файл поддельного времени. */
  clockFile: string;
  /** Тестовый сокет управления временем. */
  clockSocket: string;
}

export class ClockConfigError extends Error {}

/**
 * Часы по переменным окружения: STG_CLOCK=fake — поддельные (только при STG_TEST=1), иначе настоящие.
 * Начало поддельного времени — из файла, иначе STG_CLOCK_START (ISO или миллисекунды), иначе сейчас.
 */
export function clockFromEnv(env: NodeJS.ProcessEnv, paths: ClockEnvPaths): Clock {
  const mode = env.STG_CLOCK ?? 'real';
  if (mode === 'real' || mode === '') return new RealClock();
  if (mode !== 'fake') throw new ClockConfigError(`STG_CLOCK=${mode}: допустимо real или fake`);
  if (env.STG_TEST !== '1') throw new ClockConfigError('STG_CLOCK=fake работает только при STG_TEST=1');
  const file = env.STG_CLOCK_FILE || paths.clockFile;
  return new FakeClock(parseClockStart(env.STG_CLOCK_START), file);
}

export function parseClockStart(value: string | undefined): number {
  if (!value) return Date.now();
  if (/^\d+$/.test(value)) return Number(value);
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new ClockConfigError(`STG_CLOCK_START=${value}: нужна дата ISO или миллисекунды`);
  return t;
}

/**
 * Тестовый сокет управления поддельными часами. Команды — строки:
 * `advance <срок>` → `ok <now_ms>`; `jump <срок>` (скачок, как после сна) → `ok <now_ms>`; `now` → `ok <now_ms>`;
 * иное → `error <текст>`.
 */
export function startClockControlServer(clock: FakeClock, socketPath: string): Promise<net.Server> {
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    // нет файла — нечего удалять
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        void handle(line).then((reply) => {
          if (!sock.destroyed) sock.write(reply + '\n');
        });
      }
    });
    sock.on('error', () => undefined);
  });
  const handle = async (line: string): Promise<string> => {
    try {
      if (line === 'now') return `ok ${clock.now()}`;
      const m = /^advance\s+(.+)$/.exec(line);
      if (m && m[1]) return `ok ${await clock.advance(parseDuration(m[1]))}`;
      const j = /^jump\s+(.+)$/.exec(line);
      if (j && j[1]) return `ok ${await clock.jump(parseDuration(j[1]))}`;
      return `error неизвестная команда «${line}»`;
    } catch (err) {
      return `error ${(err as Error).message}`;
    }
  };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** Клиент тестового сокета часов: отправить команду, получить время после неё. */
export function clockCommand(socketPath: string, command: string, timeoutMs = 30_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`часы не ответили на «${command}» за ${timeoutMs} мс`));
    }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(command + '\n'));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      sock.end();
      const line = buf.slice(0, i);
      const m = /^ok (\d+)$/.exec(line);
      if (m) resolve(Number(m[1]));
      else reject(new Error(`часы: ${line}`));
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // Процесс с часами умер, не ответив, — сразу отказ, а не ожидание до таймаута.
    sock.on('close', () => {
      clearTimeout(timer);
      if (buf.indexOf('\n') < 0) reject(Object.assign(new Error(`часы закрыли соединение без ответа на «${command}»`), { code: 'ECONNRESET' }));
    });
  });
}

/** Срок по часам вышел (clockDeadline). */
export class DeadlineError extends Error {
  constructor(readonly ms: number) {
    super(`срок ${Math.round(ms / 1000)} с вышел`);
  }
}

export interface Deadline {
  readonly signal: AbortSignal;
  /** Сработал ли именно срок (а не внешняя отмена). */
  expired(): boolean;
  cancel(): void;
}

/**
 * Срок внешнего запроса по часам шлюза (поддельным под тестом): отмена через ms — но не раньше, чем у запроса было
 * graceRealMs настоящего времени. Тест двигает поддельные часы на минуты за миллисекунды, и без этого запрос к подделке
 * на этой же машине обрывался бы раньше, чем успевает прийти ответ. На настоящих часах это ничего не меняет (срок ≫
 * запаса). Внешняя отмена (остановка шлюза) — сразу.
 */
export function clockDeadline(clock: Clock, ms: number, opts: { graceRealMs?: number; signal?: AbortSignal } = {}): Deadline {
  const ctl = new AbortController();
  const grace = opts.graceRealMs ?? 200;
  const startReal = performance.now();
  let realTimer: NodeJS.Timeout | null = null;
  const expire = (): void => {
    if (!ctl.signal.aborted) ctl.abort(new DeadlineError(ms));
  };
  const timer = clock.setTimeout(() => {
    const left = grace - (performance.now() - startReal);
    if (left <= 0) expire();
    else {
      realTimer = setTimeout(expire, left);
      realTimer.unref?.();
    }
  }, ms);
  const parent = opts.signal;
  const onParent = (): void => {
    if (!ctl.signal.aborted) ctl.abort(parent?.reason);
  };
  if (parent) {
    if (parent.aborted) onParent();
    else parent.addEventListener('abort', onParent, { once: true });
  }
  return {
    signal: ctl.signal,
    expired: () => ctl.signal.reason instanceof DeadlineError,
    cancel: () => {
      timer.cancel();
      if (realTimer) clearTimeout(realTimer);
      parent?.removeEventListener('abort', onParent);
    },
  };
}
