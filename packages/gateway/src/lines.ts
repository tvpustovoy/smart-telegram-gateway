// Линия (сценарий 2, TECH-SPEC 5.20): владелец говорит с агентом из peers напрямую, ведущий агент этого не читает.
//
// - Адрес сообщения решается при приёме, одной транзакцией с записью (events.route): голосовое идёт тому, кто был
//   адресатом, даже если расшифровка пришла после переключения, а повторная доставка адрес не пересчитывает.
// - Порядок: «/команда текст» — ведущему агенту; правка и реплай на своё сообщение — туда же, куда исходное; реплай на
//   чужое — автору; иначе — тому, кто на линии. Линии нет — ведущему агенту, как до сценария 2.
// - Владелец молчал дольше line.silence_minutes — сообщение никуда не уходит: route = ROUTE_ASK, он нажимает, кому оно.
//   Письма агента тишину не прерывают: разговорчивый агент не должен отключать вопрос.
// - Линию меняет только владелец: командой или кнопкой. Письмо агента и ведущий агент этого не могут.

import { DEFAULT_PARCEL_TARGET, ROUTE_ASK, peerNoticeText, sql, type PeerEventInfo, type PeerFileInfo } from 'stg-core';
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

/** Сообщения, ждущие ответа владельца, кому они. */
export function askedCount(ctx: Ctx): number {
  return (sql(ctx.db, "SELECT count(*) AS n FROM events WHERE route = ? AND status NOT IN ('cancelled', 'processed')").get(ROUTE_ASK) as { n: number }).n;
}

/** Ждущие сообщения — этому агенту. Внутри транзакции. */
export function releaseAsked(ctx: Ctx, peer: string): number {
  return Number(sql(ctx.db, 'UPDATE events SET route = ? WHERE route = ?').run(peer, ROUTE_ASK).changes);
}

export interface RouteMessage {
  /** «/команда текст» — ведущему агенту. */
  main: boolean;
  editOf: number | null;
  author: ReplyAuthor;
}

/** Кому сообщение владельца в личке: имя агента, ROUTE_ASK или null — ведущему агенту. Внутри транзакции приёма. */
export function routeFor(ctx: Ctx, m: RouteMessage, now: number): string | null {
  if (m.main) return null;
  if (m.editOf !== null) return (sql(ctx.db, 'SELECT route FROM events WHERE seq = ?').get(m.editOf) as { route: string | null } | undefined)?.route ?? null;
  if (m.author === 'main') return null;
  const line = openLine(ctx);
  if (m.author !== null) {
    if (line?.peer === m.author.peer) touchLine(ctx, line.id, now);
    return m.author.peer;
  }
  if (!line) return null;
  // Уже ждёт ответа — следующее встаёт за ним, порядок не меняется.
  if (askedCount(ctx) > 0 || now - line.last_at > ctx.config.line.silence_minutes * 60_000) return ROUTE_ASK;
  touchLine(ctx, line.id, now);
  return line.peer;
}

/** Строка о письмах вне линии: одна на агента, пока её кнопки живы. Внутри транзакции. */
export function noticeLetters(ctx: Ctx, peer: string, now: number): void {
  const live = sql(ctx.db, "SELECT 1 FROM buttons WHERE kind = 'peer_show' AND used_at IS NULL AND expires_at > ? AND json_extract(payload_json, '$.peer') = ? LIMIT 1").get(now, peer);
  if (live) return;
  const group = newGroup();
  enqueueServiceLine(ctx, peerNoticeText(peer), {
    replyMarkup: {
      inline_keyboard: [
        [
          { text: 'Показать', callback_data: createButton(ctx, 'peer_show', { group, peer }) },
          { text: 'Соединить', callback_data: createButton(ctx, 'line_connect', { group, peer, notice: true }) },
        ],
      ],
    },
  });
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
