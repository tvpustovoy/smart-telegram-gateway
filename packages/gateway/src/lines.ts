// Линия (сценарий 2, TECH-SPEC 5.20): владелец говорит с агентом из peers напрямую, ведущий агент этого не читает.
//
// - Адрес сообщения решается при приёме, одной транзакцией с записью (events.route): голосовое идёт тому, кто был
//   адресатом, даже если расшифровка пришла после переключения, а повторная доставка адрес не пересчитывает.
// - Порядок: «/команда текст» — ведущему агенту; правка и реплай на своё сообщение — туда же, куда исходное; реплай на
//   чужое — автору; иначе — тому, кто на линии. Линии нет — ведущему агенту, как до сценария 2.
// - Линия — переключатель, куда идут новые сообщения владельца, а разговор живёт в сессии агента и в сети. Владелец молчал дольше
//   line.silence_minutes — линия закрывается сама: по такту или при приёме следующего сообщения. Заметку из другого приложения он
//   шлёт, не видя чата, поэтому без живого разговора адресат — ведущий агент. Письма агента тишину не прерывают.
// - Письмо агента после конца линии в чат само не идёт: владелец видит счётчик и читает, выбрав агента в /agents.
// - Открывает линию только владелец. Письмо агента и ведущий агент этого не могут.

import { DEFAULT_PARCEL_TARGET, ROUTE_ASK, lineIdleText, sql, type PeerEventInfo, type PeerFileInfo } from 'stg-core';
import { createButton, newGroup } from './buttons.js';
import { enqueueServiceLine, insertOutbox, type Ctx } from './context.js';

export interface LineRow {
  id: number;
  peer: string;
  started_at: number;
  last_at: number;
  ended_at: number | null;
  end_reason: string | null;
}

/** Чьё сообщение под реплаем владельца: агента из peers, ведущего агента, ничьё (строка шлюза, своё). */
export type ReplyAuthor = { peer: string } | 'main' | null;

export function openLine(ctx: Ctx): LineRow | null {
  return (sql(ctx.db, 'SELECT * FROM lines WHERE ended_at IS NULL').get() as LineRow | undefined) ?? null;
}

export function touchLine(ctx: Ctx, id: number, now: number): void {
  sql(ctx.db, 'UPDATE lines SET last_at = ? WHERE id = ?').run(now, id);
}

/** Закрыть линию. Внутри транзакции. */
export function closeLine(ctx: Ctx, reason: string, now: number): LineRow | null {
  const line = openLine(ctx);
  if (!line) return null;
  sql(ctx.db, 'UPDATE lines SET ended_at = ?, end_reason = ? WHERE id = ?').run(now, reason, line.id);
  ctx.journal.write('line_closed', { peer: line.peer, reason, ms: now - line.started_at });
  return line;
}

/** Соединить с агентом. Внутри транзакции. */
export function connectLine(ctx: Ctx, peer: string, now: number): LineRow {
  const cur = openLine(ctx);
  if (cur?.peer === peer) {
    touchLine(ctx, cur.id, now);
    return { ...cur, last_at: now };
  }
  if (cur) closeLine(ctx, 'switched', now);
  const r = sql(ctx.db, 'INSERT INTO lines(peer, started_at, last_at) VALUES (?, ?, ?)').run(peer, now, now);
  ctx.journal.write('line_connected', { peer });
  return openLine(ctx) ?? { id: Number(r.lastInsertRowid), peer, started_at: now, last_at: now, ended_at: null, end_reason: null };
}

/** Сообщения с адресом «?» из версии с вопросом «кому»: при старте уходят ведущему агенту. */
export function askedCount(ctx: Ctx): number {
  return (sql(ctx.db, "SELECT count(*) AS n FROM events WHERE route = ? AND status NOT IN ('cancelled', 'processed')").get(ROUTE_ASK) as { n: number }).n;
}

/** Открытая линия или null. Тишина вышла — закрыть со строкой владельцу и кнопкой вернуться. Внутри транзакции. */
export function liveLine(ctx: Ctx, now: number): LineRow | null {
  const line = openLine(ctx);
  const minutes = ctx.config.line.silence_minutes;
  if (!line || now - line.last_at <= minutes * 60_000) return line;
  closeLine(ctx, 'silence', now);
  enqueueServiceLine(ctx, lineIdleText(line.peer, ctx.config.line.main_name, minutes), {
    replyMarkup: { inline_keyboard: [[{ text: 'Соединить снова', callback_data: createButton(ctx, 'line_connect', { group: newGroup(), peer: line.peer }) }]] },
  });
  return null;
}

/** Письма агента, которые владелец ещё не читал; без имени — всех. */
export function unseenCount(ctx: Ctx, peer?: string): number {
  const where = "direction = 'in' AND unseen = 1";
  const r = peer === undefined ? sql(ctx.db, `SELECT count(*) AS n FROM peer_messages WHERE ${where}`).get() : sql(ctx.db, `SELECT count(*) AS n FROM peer_messages WHERE ${where} AND peer = ?`).get(peer);
  return (r as { n: number }).n;
}

export interface RouteMessage {
  /** «/команда текст» — ведущему агенту. */
  main: boolean;
  editOf: number | null;
  author: ReplyAuthor;
}

/** Кому сообщение владельца в личке: имя агента или null — ведущему агенту. Внутри транзакции приёма. */
export function routeFor(ctx: Ctx, m: RouteMessage, now: number): string | null {
  if (m.main) return null;
  if (m.editOf !== null) return (sql(ctx.db, 'SELECT route FROM events WHERE seq = ?').get(m.editOf) as { route: string | null } | undefined)?.route ?? null;
  if (m.author === 'main') return null;
  const line = liveLine(ctx, now);
  if (m.author !== null) {
    if (line?.peer === m.author.peer) touchLine(ctx, line.id, now);
    return m.author.peer;
  }
  if (!line) return null;
  touchLine(ctx, line.id, now);
  return line.peer;
}

/** Письмо агента владельцу дословно, как show: простым текстом, с меткой, ведущий агент его не видит. Внутри транзакции. */
export function showLetter(ctx: Ctx, seq: number, chatId: number, peer: string, text: string, turn: number, file: PeerFileInfo | null = null): void {
  const outboxId = insertOutbox(ctx, { eventSeq: seq, chatId, threadId: null, kind: 'agent', text: file ? '' : text, origin: 'agent', turn, plain: true, fromName: peer });
  if (!file) return;
  // Файл агента идёт документом, как посылка: очередь отправки, стоп и повторы те же.
  sql(ctx.db,
    `INSERT INTO deliveries(parcel, file, bytes, sha256, copy_ref, target, chat_id, event_seq, outbox_id, status, updated, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
  ).run(peer, file.name, file.bytes, file.sha256, file.copy_ref, DEFAULT_PARCEL_TARGET, chatId, seq, outboxId, ctx.clock.now());
}

/** Файл письма по peer_json события. */
export function peerFileOfEvent(peerJson: string | null): PeerFileInfo | null {
  return peerJson ? ((JSON.parse(peerJson) as PeerEventInfo).file ?? null) : null;
}

/** Показать письма агента, пришедшие вне линии. Внутри транзакции. */
export function showUnseen(ctx: Ctx, peer: string, turn: number): number {
  const owner = ctx.config.owner_id;
  if (owner === null) return 0;
  const rows = sql(ctx.db,
    `SELECT pm.id, pm.event_seq, e.text, e.peer_json FROM peer_messages pm JOIN events e ON e.seq = pm.event_seq
     WHERE pm.direction = 'in' AND pm.peer = ? AND pm.unseen = 1 ORDER BY pm.id`,
  ).all(peer) as Array<{ id: number; event_seq: number; text: string | null; peer_json: string | null }>;
  for (const r of rows) {
    if (r.text !== null) showLetter(ctx, r.event_seq, owner, peer, r.text, turn, peerFileOfEvent(r.peer_json));
    sql(ctx.db, 'UPDATE peer_messages SET unseen = 0 WHERE id = ?').run(r.id);
  }
  return rows.length;
}
