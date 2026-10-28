// Предел памяти процесса (N-2). Куча V8 ограничена флагами службы (--max-old-space-size), но память вне кучи — буферы,
// сокеты, TLS, нативные части Node — флагами не ограничена. 24.10.2026 два шлюза на одном Mac выросли до 12 ГБ каждый за
// три часа (отчёт macOS JetsamEvent: node — самый большой процесс), система встала. Пока причина не найдена, шлюз:
// - раз в минуту смотрит process.memoryUsage();
// - пишет в журнал `memory` раз в час и при росте rss на 25 % с прошлой записи — чтобы следующий рост было видно по
//   кривой и по частям (куча, external, arrayBuffers);
// - rss выше предела (STG_RSS_LIMIT_MB, по умолчанию 1024) — запись `memory_limit` и остановка с кодом ошибки: launchd
//   (KeepAlive) поднимет шлюз заново, принятое лежит в базе — ничего не теряется, а система не умирает.

import type { Journal } from 'stg-core';

export const MEMGUARD_EVERY_MS = 60_000;
export const MEMGUARD_LOG_EVERY_MS = 3600_000;
export const MEMGUARD_GROWTH = 1.25;
export const RSS_LIMIT_MB_DEFAULT = 1024;

const MB = 1024 * 1024;

export interface MemorySample {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export function memorySnapshotMb(m: MemorySample): Record<string, number> {
  return {
    rss_mb: Math.round(m.rss / MB),
    heap_used_mb: Math.round(m.heapUsed / MB),
    heap_total_mb: Math.round(m.heapTotal / MB),
    external_mb: Math.round(m.external / MB),
    array_buffers_mb: Math.round(m.arrayBuffers / MB),
  };
}

/** Предел rss из окружения; неверное значение — по умолчанию. */
export function rssLimitMb(env: NodeJS.ProcessEnv): number {
  const raw = env.STG_RSS_LIMIT_MB;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 64 ? Math.floor(n) : RSS_LIMIT_MB_DEFAULT;
}

export interface MemoryGuardOptions {
  limitMb: number;
  /** Источник замеров (под тестом — поддельный). */
  sample?: () => MemorySample;
  now?: () => number;
  everyMs?: number;
}

export class MemoryGuard {
  private timer: NodeJS.Timeout | null = null;
  private lastLogAt = -Infinity;
  private lastLoggedRss = 0;
  private tripped = false;
  private readonly sample: () => MemorySample;
  private readonly now: () => number;

  constructor(
    private readonly journal: Journal,
    private readonly opts: MemoryGuardOptions,
    /** Предел превышен: остановить шлюз (один раз). */
    private readonly onLimit: () => void,
  ) {
    this.sample = opts.sample ?? (() => process.memoryUsage());
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), this.opts.everyMs ?? MEMGUARD_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Один замер; true — предел превышен. */
  check(): boolean {
    if (this.tripped) return true;
    const m = this.sample();
    const now = this.now();
    const snap = memorySnapshotMb(m);
    if (m.rss > this.opts.limitMb * MB) {
      this.tripped = true;
      this.stop();
      this.journal.write('memory_limit', { ...snap, limit_mb: this.opts.limitMb });
      this.onLimit();
      return true;
    }
    if (now - this.lastLogAt >= MEMGUARD_LOG_EVERY_MS || m.rss >= this.lastLoggedRss * MEMGUARD_GROWTH) {
      this.lastLogAt = now;
      this.lastLoggedRss = m.rss;
      this.journal.write('memory', snap);
    }
    return false;
  }
}
