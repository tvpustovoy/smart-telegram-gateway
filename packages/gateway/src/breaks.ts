// Сводка после перерыва (TECH-SPEC 5.3 «Сон ноутбука»). Перерыв — время, когда сообщения владельца ждали: компьютер
// спал, а сообщение было у агента без ответа (пробуждение застало его открытым), или сообщение пришло намного позже, чем
// написано (Telegram держал его, пока шлюз спал или не принимал). Когда все сообщения перерыва закрыты — или ждут дольше
// BREAK_WAIT_MAX_MS после последнего пробуждения, — одна строка владельцу: каждое сообщение с этого времени, что с ним, и
// кнопки с номерами. Кнопка присылает ответ шлюза на само сообщение: по цитате Telegram переходит к нему (ссылок на
// сообщения в личке у Telegram нет). Берутся сообщения ведущему агенту в личке владельца: линия (5.20) — мимо.
//
// Состояние — meta.break_report; reported_seq — граница: сообщения до неё уже были в сводке (при первом запуске —
// последнее сообщение в базе, чтобы прошлое не попало в сводку).

import {
  META_KEYS,
  breakReportText,
  breakShowText,
  breakWhat,
  getMeta,
  localTime,
  setMeta,
  sql,
  transaction,
  type BreakCause,
  type BreakItem,
  type BreakState,
} from 'stg-core';
import { createButton, newGroup } from './buttons.js';
import { enqueueServiceLine, type Ctx } from './context.js';

/** Сообщение пришло позже, чем написано, больше чем на столько — оно ждало в Telegram. */
export const BREAK_LATE_MS = 2 * 60_000;
/** Сводка не ждёт закрытия дольше этого после последнего пробуждения: дальше — с тем, что ещё ждёт. */
export const BREAK_WAIT_MAX_MS = 30 * 60_000;
/** Кнопок в ряд под сводкой. */
const BUTTONS_PER_ROW = 8;
/** Предел кнопок Telegram под одним сообщением — 100; запас. */
const BUTTONS_MAX = 96;

const OPEN = "('new', 'delivered', 'transcribing', 'held')";
const OWNER_MSG = "trust IN ('owner', 'owner_forward') AND kind IN ('text', 'voice', 'photo', 'document') AND route IS NULL AND chat_id = ?";

interface Active {
  /** С какого времени (написано) брать сообщения. */
  from: number;
  /** Когда начался перерыв. */
  slept_from: number;
  /** Последнее пробуждение, при котором сообщения ждали (или последнее опоздавшее). */
  until: number;
  /** Сообщения, которые ждали. */
  seqs: number[];
  wakes: number;
  cause: 'sleep' | 'gap';
}

interface State {
  active: Active | null;
  reported_seq: number;
}

interface MsgRow {
  seq: number;
  kind: string;
  status: string;
  text: string | null;
  transcript: string | null;
  message_id: number | null;
  message_date: number | null;
  created_at: number;
  delivered_at: number | null;
}

function read(ctx: Ctx): State | null {
  try {
    const s = JSON.parse(getMeta(ctx.db, META_KEYS.breakReport) ?? 'null') as State | null;
    return s && typeof s.reported_seq === 'number' ? s : null;
  } catch {
    return null;
  }
}

function write(ctx: Ctx, s: State): void {
  setMeta(ctx.db, META_KEYS.breakReport, JSON.stringify(s));
}

/** Старт шлюза (тикер): первый запуск версии — граница по последнему событию, прошлое в сводку не идёт. */
export function initBreaks(ctx: Ctx): void {
  transaction(ctx.db, () => {
    if (!read(ctx)) init(ctx);
  });
}

function init(ctx: Ctx): State {
  const max = (sql(ctx.db, 'SELECT max(seq) AS m FROM events').get() as { m: number | null }).m ?? 0;
  const s: State = { active: null, reported_seq: max };
  write(ctx, s);
  return s;
}

function lastWake(ctx: Ctx): { at: number; slept_ms: number } | null {
  try {
    const w = JSON.parse(getMeta(ctx.db, META_KEYS.lastWake) ?? 'null') as { at?: unknown; slept_ms?: unknown } | null;
    return w && typeof w.at === 'number' && typeof w.slept_ms === 'number' ? { at: w.at, slept_ms: w.slept_ms } : null;
  } catch {
    return null;
  }
}

const written = (r: MsgRow): number => r.message_date ?? r.created_at;

/** Шлюз проснулся (тикер, 5.3): запомнить пробуждение; сообщения, которые застал открытыми, — в перерыв. */
export function noteWake(ctx: Ctx, now: number, sleptMs: number): void {
  const owner = ctx.config.owner_id;
  transaction(ctx.db, () => {
    setMeta(ctx.db, META_KEYS.lastWake, JSON.stringify({ at: now, slept_ms: sleptMs }));
    if (owner === null) return;
    const st = read(ctx) ?? init(ctx);
    const open = sql(ctx.db, `SELECT seq, message_date, created_at FROM events WHERE ${OWNER_MSG} AND status IN ${OPEN} AND seq > ?`).all(
      owner,
      st.reported_seq,
    ) as unknown as Array<Pick<MsgRow, 'seq' | 'message_date' | 'created_at'>>;
    if (!open.length) return;
    const sleptFrom = now - sleptMs;
    const b: Active = st.active ?? { from: sleptFrom, slept_from: sleptFrom, until: now, seqs: [], wakes: 0, cause: 'sleep' };
    b.from = Math.min(b.from, ...open.map((r) => r.message_date ?? r.created_at));
    b.slept_from = Math.min(b.slept_from, sleptFrom);
    b.until = Math.max(b.until, now);
    b.wakes++;
    b.cause = 'sleep';
    b.seqs = [...new Set([...b.seqs, ...open.map((r) => r.seq)])];
    write(ctx, { ...st, active: b });
  });
}

/** Что стало с сообщением сейчас. */
function stateOf(ctx: Ctx, r: MsgRow): BreakState {
  const answered = (sql(ctx.db, "SELECT min(created_at) AS t FROM outbox WHERE event_seq = ? AND origin = 'agent'").get(r.seq) as { t: number | null }).t;
  if (answered !== null) return { kind: 'answered', at: localTime(answered, ctx.config.timezone) };
  if (r.status === 'processed' || r.status === 'handled') return { kind: 'closed' };
  return r.status === 'delivered' ? { kind: 'given' } : { kind: 'waiting' };
}

function item(ctx: Ctx, r: MsgRow): BreakItem {
  return { hhmm: localTime(written(r), ctx.config.timezone), what: breakWhat(r.kind, r.kind === 'voice' || r.kind === 'document' ? r.transcript : r.text), state: stateOf(ctx, r) };
}

/**
 * Сроки (тикер, раз в минуту и после пробуждения): опоздавшие сообщения — в перерыв; все сообщения перерыва закрыты (или
 * ждут дольше срока) — сводка. true — строка поставлена.
 */
export function checkBreak(ctx: Ctx, now: number): boolean {
  const owner = ctx.config.owner_id;
  if (owner === null) return false;
  return transaction(ctx.db, () => {
    const st = read(ctx) ?? init(ctx);
    let b = st.active;
    const late = sql(ctx.db, `SELECT seq, message_date, created_at FROM events WHERE ${OWNER_MSG} AND seq > ? AND message_date IS NOT NULL AND created_at - message_date > ?`).all(
      owner,
      st.reported_seq,
      BREAK_LATE_MS,
    ) as unknown as Array<Pick<MsgRow, 'seq' | 'message_date' | 'created_at'>>;
    const fresh = late.filter((r) => !b?.seqs.includes(r.seq));
    if (fresh.length) {
      const w = lastWake(ctx);
      const firstIn = Math.min(...fresh.map((r) => r.created_at));
      const lastIn = Math.max(...fresh.map((r) => r.created_at));
      // Пробуждение прямо перед приёмом — их держал сон; иначе шлюз не принимал (остановлен, сети не было).
      const wake = w !== null && w.at <= firstIn && firstIn - w.at <= BREAK_LATE_MS ? w : null;
      const firstWritten = Math.min(...fresh.map((r) => r.message_date ?? r.created_at));
      b ??= wake
        ? { from: firstWritten, slept_from: wake.at - wake.slept_ms, until: wake.at, seqs: [], wakes: 1, cause: 'sleep' }
        : { from: firstWritten, slept_from: firstWritten, until: lastIn, seqs: [], wakes: 0, cause: 'gap' };
      b.from = Math.min(b.from, firstWritten);
      b.until = Math.max(b.until, wake ? wake.at : lastIn);
      b.seqs = [...new Set([...b.seqs, ...fresh.map((r) => r.seq)])];
    }
    if (!b) return false;
    const rows = sql(
      ctx.db,
      `SELECT seq, kind, status, text, transcript, message_id, message_date, created_at, delivered_at FROM events
        WHERE ${OWNER_MSG} AND seq > ? AND (coalesce(message_date, created_at) >= ? OR seq IN (SELECT value FROM json_each(?)))
        ORDER BY coalesce(message_date, created_at), seq`,
    ).all(owner, st.reported_seq, b.from, JSON.stringify(b.seqs)) as unknown as MsgRow[];
    const open = rows.filter((r) => ['new', 'delivered', 'transcribing', 'held'].includes(r.status));
    if (!rows.length || (open.length && now - b.until < BREAK_WAIT_MAX_MS)) {
      write(ctx, { ...st, active: b });
      return false;
    }
    const tz = ctx.config.timezone;
    const cause: BreakCause = b.cause === 'gap' ? 'gap' : b.wakes > 1 ? 'sleeps' : 'sleep';
    const text = breakReportText({ from: localTime(b.slept_from, tz), until: localTime(b.until, tz), cause, items: rows.map((r) => item(ctx, r)) });
    const group = newGroup();
    const shown = rows.slice(0, BUTTONS_MAX).map((r, i) => ({ text: String(i + 1), callback_data: createButton(ctx, 'msg_show', { group, event_seq: r.seq }) }));
    const keyboard: Array<typeof shown> = [];
    for (let i = 0; i < shown.length; i += BUTTONS_PER_ROW) keyboard.push(shown.slice(i, i + BUTTONS_PER_ROW));
    enqueueServiceLine(ctx, text, { replyMarkup: { inline_keyboard: keyboard } });
    write(ctx, { active: null, reported_seq: Math.max(st.reported_seq, ...rows.map((r) => r.seq)) });
    ctx.journal.write('break_report', { from: b.slept_from, until: b.until, cause, messages: rows.length, waiting: open.length });
    return true;
  });
}

/** Кнопка сводки: ответ шлюза на само сообщение с тем, что с ним сейчас. null — сообщения нет. Внутри транзакции. */
export function showBreakMessage(ctx: Ctx, seq: number): number | null {
  const owner = ctx.config.owner_id;
  if (owner === null) return null;
  const r = sql(ctx.db, `SELECT seq, kind, status, text, transcript, message_id, message_date, created_at, delivered_at FROM events WHERE ${OWNER_MSG} AND seq = ?`).get(owner, seq) as
    | MsgRow
    | undefined;
  if (!r || r.message_id === null) return null;
  return enqueueServiceLine(ctx, breakShowText(localTime(written(r), ctx.config.timezone), stateOf(ctx, r)), { replyToMessageId: r.message_id });
}
