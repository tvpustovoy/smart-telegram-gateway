// Падения (TECH-SPEC 5.3, Ш-15). При старте без маркера чистой остановки строка in_progress получает crash_count + 1.
// На третьем падении, а также если за 60 с было 3 старта и больше, — одной транзакцией status = deferred (содержимое
// остаётся в raw_json) и offset = update_id + 1 (ровно этого обновления, 5.2: не максимум из виденных); владельцу «⚙
// Сообщение от ЧЧ:ММ отложил: на нём шлюз падает. Содержимое сохранено» (реакция, 0.3.4 — «⚙ Реакцию от ЧЧ:ММ
// отложил: на ней…» ⟨предл.⟩). Отложенное само не переигрывается.
//
// Строка in_progress старше суток (по received_at) — тоже в отложенное: Telegram держит неподтверждённое 24 часа и его
// уже не вернёт, а без этого строка висела бы «в работе» невидимо — ни событием, ни отложенным (падение посреди
// скачивания и простой дольше суток, диск полон дольше суток). Проверка — при старте и раз в минуту.
//
// Повтор отложенного (stg deferred retry, M3), на котором шлюз упал снова, — сразу в отложенное и без сдвига offset:
// его номер давно позади.

import { sql, META_KEYS, deferredNotice, getMeta, localTime, setMeta, staleDeferredNotice, transaction, type DeferredWhat, type Update } from 'stg-core';
import { enqueueServiceLine, type Ctx } from './context.js';

export const CRASH_LIMIT = 3;
export const START_WINDOW_MS = 60_000;
export const START_LIMIT = 3;
/** Сколько Telegram держит неподтверждённое: дольше строка in_progress не дождётся повтора. */
export const IN_PROGRESS_STALE_MS = 24 * 3600_000;

export interface StartInfo {
  cleanPrevious: boolean;
  startHistory: number[];
}

export interface RecoveryResult {
  crashed: number[];
  deferred: number[];
}

/**
 * Что отложено и когда — для строки владельцу: по raw_json, время в поясе владельца. Реакция (0.3.4, по проверке) —
 * время реакции и слово «реакцию», а не «сообщение».
 */
function deferredOf(ctx: Ctx, raw: string | null, fallback: number): { hhmm: string; what: DeferredWhat } {
  let ms = fallback;
  let what: DeferredWhat = 'message';
  try {
    const u = JSON.parse(raw ?? 'null') as Update | null;
    const msg = u?.message ?? u?.edited_message;
    if (msg?.date) ms = msg.date * 1000;
    if (u?.message_reaction) {
      what = 'reaction';
      if (u.message_reaction.date) ms = u.message_reaction.date * 1000;
    }
  } catch {
    // raw_json не разобрался — время приёма
  }
  return { hhmm: localTime(ms, ctx.config.timezone), what };
}

interface InProgressRow {
  update_id: number;
  crash_count: number;
  raw_json: string | null;
  received_at: number;
}

export function recoverCrashes(ctx: Ctx, info: StartInfo): RecoveryResult {
  const result: RecoveryResult = { crashed: [], deferred: [] };
  if (info.cleanPrevious) return result;
  const now = ctx.clock.now();
  const recentStarts = info.startHistory.filter((t) => now - t <= START_WINDOW_MS && t <= now).length;
  const rows = sql(ctx.db, "SELECT update_id, crash_count, raw_json, received_at FROM updates WHERE status = 'in_progress' ORDER BY update_id")
    .all() as unknown as InProgressRow[];
  // Повтор отложенного (stg deferred retry): его номер давно позади — offset не трогать.
  const retrying = retryingUpdates(ctx);
  for (const row of rows) {
    const crashes = row.crash_count + 1;
    const loop = recentStarts >= START_LIMIT;
    // Повторённое отложенное упало снова — сразу назад в отложенное: Telegram его уже не вернёт.
    const again = retrying.includes(row.update_id);
    const defer = crashes >= CRASH_LIMIT || loop || again;
    transaction(ctx.db, () => {
      if (!defer) {
        sql(ctx.db, 'UPDATE updates SET crash_count = ? WHERE update_id = ?').run(crashes, row.update_id);
        return;
      }
      sql(ctx.db, "UPDATE updates SET crash_count = ?, status = 'deferred' WHERE update_id = ?").run(crashes, row.update_id);
      if (!retrying.includes(row.update_id)) {
        setMeta(ctx.db, META_KEYS.offset, String(row.update_id + 1));
        setMeta(ctx.db, META_KEYS.lastUpdateAt, String(now));
      }
      const d = deferredOf(ctx, row.raw_json, row.received_at);
      enqueueServiceLine(ctx, deferredNotice(d.hhmm, d.what));
    });
    result.crashed.push(row.update_id);
    if (defer) {
      result.deferred.push(row.update_id);
      ctx.journal.write('deferred', { update_id: row.update_id, crash_count: crashes, reason: again ? 'retry_crashed' : loop ? 'start_loop' : 'crash_limit', starts_60s: recentStarts });
    } else {
      ctx.journal.write('crash_counted', { update_id: row.update_id, crash_count: crashes });
    }
  }
  if (retrying.length) transaction(ctx.db, () => setMeta(ctx.db, META_KEYS.retrying, null));
  return result;
}

/** update_id, которые сейчас повторяет stg deferred retry (meta). */
export function retryingUpdates(ctx: Ctx): number[] {
  try {
    const v: unknown = JSON.parse(getMeta(ctx.db, META_KEYS.retrying) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

/** in_progress старше суток — в отложенное со строкой владельцу (offset не трогается: Telegram его уже не вернёт). */
export function deferStaleInProgress(ctx: Ctx, now: number): number[] {
  const rows = sql(ctx.db, "SELECT update_id, crash_count, raw_json, received_at FROM updates WHERE status = 'in_progress' AND received_at < ? ORDER BY update_id")
    .all(now - IN_PROGRESS_STALE_MS) as unknown as InProgressRow[];
  const out: number[] = [];
  for (const row of rows) {
    transaction(ctx.db, () => {
      sql(ctx.db, "UPDATE updates SET status = 'deferred' WHERE update_id = ? AND status = 'in_progress'").run(row.update_id);
      const d = deferredOf(ctx, row.raw_json, row.received_at);
      enqueueServiceLine(ctx, staleDeferredNotice(d.hhmm, d.what));
    });
    out.push(row.update_id);
    ctx.journal.write('deferred', { update_id: row.update_id, crash_count: row.crash_count, reason: 'stale_in_progress', age_ms: now - row.received_at });
  }
  return out;
}
