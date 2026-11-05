// Распознавание пересланного и аудиофайлов на время выключено (TECH-SPEC 5.8 «Без распознавания»). Пересланную музыку и
// пение распознавать не нужно, а пересланные записи разговоров — нужно; значит, выключать вручную и на время. Владелец выключает его командой /stt (commands.ts) — по умолчанию на час, не дольше суток; срок —
// meta.stt_off_until, переживает перезапуск. Пока выключено, распознаватель (voice.ts) пересланное (голосовое,
// аудиофайл, кружок, видео) и аудиофайлы не скачивает и не распознаёт: событие уходит агенту без расшифровки, с
// пометкой stt_off (схема v18) — сам звук агент получает file(seq); ответа владельцу на такое сообщение нет. Свои
// голосовые, кружки и видео владельца распознаются как всегда: это его слова агенту. Что распознаётся в момент команды,
// дораспознаётся; что ждёт очереди — уже нет. Срок вышел — тикер включает распознавание и пишет владельцу одну строку;
// пока выключено, в закреплённой строке — «🔇 до ЧЧ:ММ».

import { META_KEYS, STT_ON_EXPIRED_TEXT, getMeta, setMeta, transaction, type Db } from 'stg-core';
import { enqueueServiceLine, type Ctx } from './context.js';

/** До какого времени выключено (часы шлюза, мс); включено или срок вышел — null. */
export function sttOffUntil(db: Db, now: number): number | null {
  const v = Number(getMeta(db, META_KEYS.sttOffUntil) ?? NaN);
  return Number.isFinite(v) && v > now ? v : null;
}

/**
 * Касается ли выключение этого звука: пересланное — да, аудиофайл (звук файлом, source audio) — да; своё голосовое,
 * свой кружок и своё видео — нет.
 */
export function sttOffCovers(forwarded: boolean, fileSource: string | null): boolean {
  return forwarded || fileSource === 'audio';
}

/** Выключить до until или включить (null). Внутри транзакции. */
export function setSttOff(ctx: Ctx, until: number | null, by: 'command' | 'expired'): void {
  setMeta(ctx.db, META_KEYS.sttOffUntil, until === null ? null : String(until));
  ctx.journal.write(until === null ? 'stt_on' : 'stt_off', { by, ...(until !== null ? { until } : {}) });
}

/** Тикер: срок вышел — включить и сказать владельцу одной строкой. true — строка в очереди. */
export function expireSttOff(ctx: Ctx, now: number): boolean {
  const raw = getMeta(ctx.db, META_KEYS.sttOffUntil);
  if (raw === null || Number(raw) > now) return false;
  transaction(ctx.db, () => {
    setSttOff(ctx, null, 'expired');
    if (ctx.config.owner_id !== null) enqueueServiceLine(ctx, STT_ON_EXPIRED_TEXT);
  });
  return ctx.config.owner_id !== null;
}
