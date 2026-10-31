// Связь с другими агентами (сценарий 1, TECH-SPEC 5.19): шлюз переносит слово владельца другому агенту и принимает ответ.
// Кому и что передать, решает агент (relay); текст берёт шлюз из базы, поэтому модель-посредник слово не переписывает.
//
// - Канал — отдельное соединение stg-link (hello role peer_link), без аренды: оно только пересылает письма. Вся логика
//   здесь: список агентов, проверки, метки, запись. Связи нет — письмо ждёт в peer_messages и уходит при подключении.
// - Письмо агента — событие вида peer с меткой «чужое»: приходит по обычному курсору аренды и будит агента, как сообщение
//   владельца. Адрес вне peers настроек не принимается. Повтор того же письма (wire_id) второго события не даёт.
// - Текст исходящего хранится, только пока письмо ждёт: дальше он есть в слове владельца и в истории сети.
// - Правда о передаче — у шлюза: строку владельцу ставит код, когда связь подтвердила отправку или отказала.

import { MAX_REPLY_TEXT, MESSAGE_EVENT_KINDS, sql, transaction, type AdapterMessage, type AgentsResult, type ErrorCode, type Mode, type PeerEventInfo, type RelayResult } from 'stg-core';
import { enqueueServiceLine, type Ctx } from './context.js';
import type { GatewayConnection } from './socket-server.js';

export interface PeerHooks {
  /** Новое событие для агента (письмо или сбой передачи). */
  onEvent(): void;
  /** Владельцу поставлена строка. */
  onQueued(): void;
}

interface PeerRow {
  id: number;
  peer: string;
  event_seq: number | null;
  text: string | null;
  status: 'pending' | 'sent' | 'failed' | 'dropped' | 'received';
  error: string | null;
}

interface WordRow {
  kind: string;
  trust: string | null;
  text: string | null;
  transcript: string | null;
}

export type RelayOutcome = { ok: true; result: RelayResult } | { ok: false; code: ErrorCode; text: string };

export type PeerInResult = { status: 'accepted'; seq: number } | { status: 'duplicate' | 'unknown_peer' };

/** Скобки заголовков письма: в записке агента они заменяются, чтобы записка не выглядела словом владельца. */
const HEAD_OPEN = '⟦';
const HEAD_CLOSE = '⟧';

const REPEAT_STATUS: Record<PeerRow['status'], RelayResult['status']> = {
  pending: 'queued',
  received: 'queued',
  sent: 'sent',
  failed: 'failed',
  dropped: 'dropped_stopped',
};

/** Письмо: слово и записка раздельно, заголовки ставит шлюз. */
export function peerLetter(seq: number, words: string, excerpted: boolean, note: string | null): string {
  const head = `${HEAD_OPEN}Слово владельца № ${seq}${excerpted ? ', отрывок' : ''}. Текст из базы шлюза, агент его не менял${HEAD_CLOSE}`;
  const parts = [head, words];
  if (note !== null) {
    parts.push(`${HEAD_OPEN}Записка агента, не слово владельца${HEAD_CLOSE}`);
    parts.push(note.replaceAll(HEAD_OPEN, '[').replaceAll(HEAD_CLOSE, ']'));
  }
  return parts.join('\n');
}

export class PeerService {
  private link: GatewayConnection | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly hooks: PeerHooks,
  ) {}

  get linked(): boolean {
    return this.link?.alive ?? false;
  }

  /** Подключилась связь: прежняя закрывается, ждущие письма уходят. */
  attach(conn: GatewayConnection): void {
    if (this.link && this.link !== conn) this.link.close();
    this.link = conn;
    conn.role = 'peer_link';
    const rows = sql(this.ctx.db, "SELECT * FROM peer_messages WHERE status = 'pending' AND direction = 'out' ORDER BY id").all() as unknown as PeerRow[];
    for (const row of rows) this.push(row);
    this.ctx.journal.write('peer_link_up', { waiting: rows.length });
  }

  detach(conn: GatewayConnection): void {
    if (this.link !== conn) return;
    this.link = null;
    this.ctx.journal.write('peer_link_down', {});
  }

  /**
   * relay: порядок проверок — как у reply: ключ повтора, событие, затем ход и режим. В паузе письмо не ставится: шлюз не
   * держит слово до «продолжить», агент скажет владельцу сам.
   */
  relay(msg: Extract<AdapterMessage, { type: 'relay' }>, mode: Mode, turn: number): RelayOutcome {
    if (msg.idem !== undefined) {
      const prev = sql(this.ctx.db, 'SELECT * FROM peer_messages WHERE idem = ?').get(msg.idem) as PeerRow | undefined;
      if (prev) return { ok: true, result: { status: REPEAT_STATUS[prev.status], id: prev.id, link: this.linked, repeated: true, ...(prev.error ? { error: prev.error } : {}) } };
    }
    const peer = this.ctx.config.peers.find((p) => p.name === msg.to);
    if (!peer) {
      const names = this.ctx.config.peers.map((p) => p.name).join(', ');
      return { ok: false, code: 'bad_request', text: `агента «${msg.to.slice(0, 64)}» нет в списке шлюза${names ? `; есть: ${names}` : '; список пуст'}` };
    }
    const ev = sql(this.ctx.db, 'SELECT kind, trust, text, transcript FROM events WHERE seq = ?').get(msg.seq) as WordRow | undefined;
    if (!ev || !(MESSAGE_EVENT_KINDS as readonly string[]).includes(ev.kind)) return { ok: false, code: 'unknown_seq', text: `нет сообщения № ${msg.seq}` };
    if (ev.trust !== 'owner') return { ok: false, code: 'bad_request', text: `№ ${msg.seq} — не слова владельца; передать можно только их, остальное — запиской` };
    const words = [ev.text, ev.transcript].filter((x): x is string => !!x?.trim()).join('\n');
    if (!words) return { ok: false, code: 'bad_request', text: `в № ${msg.seq} нет слов: сообщение без текста или голос ещё не распознан` };
    const excerpt = msg.excerpt?.trim();
    if (excerpt !== undefined && !words.includes(excerpt)) return { ok: false, code: 'bad_request', text: `отрывка нет в № ${msg.seq} дословно` };
    if (msg.turn !== turn) {
      this.ctx.journal.write('relay_dropped', { seq: msg.seq, to: peer.name, reason: 'stale_turn', turn: msg.turn, current: turn });
      return { ok: true, result: { status: 'dropped_stale_turn' } };
    }
    if (mode === 'stopped') {
      this.ctx.journal.write('relay_dropped', { seq: msg.seq, to: peer.name, reason: 'stopped' });
      return { ok: true, result: { status: 'dropped_stopped' } };
    }
    if (mode === 'paused') {
      this.ctx.journal.write('relay_dropped', { seq: msg.seq, to: peer.name, reason: 'paused' });
      return { ok: true, result: { status: 'refused_paused' } };
    }
    const text = peerLetter(msg.seq, excerpt ?? words, excerpt !== undefined, msg.note ?? null);
    // Предел кадра связи: расшифровка длинного голосового может быть больше.
    if (text.length > MAX_REPLY_TEXT) return { ok: false, code: 'bad_request', text: `письмо длиннее ${MAX_REPLY_TEXT} знаков: передай отрывком (excerpt)` };
    const r = sql(this.ctx.db,
      `INSERT INTO peer_messages(direction, peer, event_seq, text, idem, status, created_at) VALUES ('out', ?, ?, ?, ?, 'pending', ?)`,
    ).run(peer.name, msg.seq, text, msg.idem ?? null, this.ctx.clock.now());
    const id = Number(r.lastInsertRowid);
    this.ctx.journal.write('relay', { id, seq: msg.seq, to: peer.name, excerpt: excerpt !== undefined, note: msg.note !== undefined, link: this.linked });
    this.push({ id, peer: peer.name, event_seq: msg.seq, text, status: 'pending', error: null });
    return { ok: true, result: { status: 'queued', id, link: this.linked } };
  }

  /** Письмо от связи. Вне списка — отказ и запись в журнал; письмо дальше не идёт. */
  incoming(msg: Extract<AdapterMessage, { type: 'peer_in' }>): { ok: true; result: PeerInResult } | { ok: false; code: ErrorCode; text: string } {
    const peer = this.ctx.config.peers.find((p) => p.address === msg.address);
    if (!peer) {
      this.ctx.journal.write('peer_refused', { address: msg.address.slice(0, 12), wire_id: msg.wire_id.slice(0, 12) });
      return { ok: true, result: { status: 'unknown_peer' } };
    }
    if (sql(this.ctx.db, 'SELECT 1 FROM peer_messages WHERE wire_id = ?').get(msg.wire_id)) return { ok: true, result: { status: 'duplicate' } };
    const owner = this.ctx.config.owner_id;
    if (owner === null) return { ok: false, code: 'unavailable', text: 'владелец не задан (первая настройка)' };
    const info: PeerEventInfo = { name: peer.name, relay_seq: this.relaySeq(peer.name, msg.reply_to ?? null) };
    const seq = transaction(this.ctx.db, () => {
      const now = this.ctx.clock.now();
      const s = this.insertEvent(owner, 'untrusted', msg.text, info);
      sql(this.ctx.db, `INSERT INTO peer_messages(direction, peer, event_seq, wire_id, reply_to, status, created_at) VALUES ('in', ?, ?, ?, ?, 'received', ?)`).run(
        peer.name,
        s,
        msg.wire_id,
        msg.reply_to ?? null,
        now,
      );
      return s;
    });
    this.ctx.journal.write('peer_in', { seq, from: peer.name, wire_id: msg.wire_id.slice(0, 12), relay_seq: info.relay_seq });
    this.hooks.onEvent();
    return { ok: true, result: { status: 'accepted', seq } };
  }

  /** Связь подтвердила отправку. Письмо, брошенное «стопом» уже в пути, тоже становится sent: оно дошло. */
  sent(msg: Extract<AdapterMessage, { type: 'peer_sent' }>): void {
    const row = sql(this.ctx.db, 'SELECT * FROM peer_messages WHERE id = ?').get(msg.id) as PeerRow | undefined;
    if (!row || (row.status !== 'pending' && row.status !== 'dropped')) return;
    transaction(this.ctx.db, () => {
      sql(this.ctx.db, "UPDATE peer_messages SET status = 'sent', wire_id = ?, text = NULL, sent_at = ? WHERE id = ?").run(msg.wire_id, this.ctx.clock.now(), msg.id);
      enqueueServiceLine(this.ctx, `⚙ Слово № ${row.event_seq ?? '?'} передано: ${row.peer}`);
    });
    this.ctx.journal.write('peer_sent', { id: msg.id, to: row.peer, wire_id: msg.wire_id.slice(0, 12) });
    this.hooks.onQueued();
  }

  /** Связь отказала: письмо закрыто, агент получает событие, владелец — строку. */
  failed(msg: Extract<AdapterMessage, { type: 'peer_failed' }>): void {
    const row = sql(this.ctx.db, 'SELECT * FROM peer_messages WHERE id = ?').get(msg.id) as PeerRow | undefined;
    const owner = this.ctx.config.owner_id;
    if (!row || row.status !== 'pending' || owner === null) return;
    transaction(this.ctx.db, () => {
      sql(this.ctx.db, "UPDATE peer_messages SET status = 'failed', error = ?, text = NULL WHERE id = ?").run(msg.reason, msg.id);
      this.insertEvent(owner, null, null, { name: row.peer, relay_seq: row.event_seq, failed: msg.reason });
      enqueueServiceLine(this.ctx, `⚙ Слово № ${row.event_seq ?? '?'} не передано: ${row.peer}. ${msg.reason}`);
    });
    this.ctx.journal.write('peer_failed', { id: msg.id, to: row.peer, reason: msg.reason });
    this.hooks.onEvent();
    this.hooks.onQueued();
  }

  /** Список из настроек и что о нём известно из базы. Что сессия агента жива, шлюз не знает. */
  list(): AgentsResult {
    const stat = sql(this.ctx.db,
      `SELECT sum(direction = 'out' AND status = 'pending') AS waiting,
              max(CASE WHEN direction = 'out' THEN sent_at END) AS last_sent,
              max(CASE WHEN direction = 'in' THEN created_at END) AS last_received
       FROM peer_messages WHERE peer = ?`,
    );
    return {
      link: this.linked,
      agents: this.ctx.config.peers.map((p) => {
        const s = stat.get(p.name) as { waiting: number | null; last_sent: number | null; last_received: number | null };
        return { name: p.name, waiting: s.waiting ?? 0, last_sent_at: s.last_sent, last_received_at: s.last_received };
      }),
    };
  }

  private push(row: PeerRow): void {
    const address = this.ctx.config.peers.find((p) => p.name === row.peer)?.address;
    if (address === undefined || row.text === null || !this.link?.alive) return;
    this.link.send({ type: 'peer_send', id: row.id, address, text: row.text });
  }

  /** К какому слову письмо: на которое агент ответил, иначе последнее переданное ему. */
  private relaySeq(peer: string, replyTo: string | null): number | null {
    const exact = replyTo !== null ? (sql(this.ctx.db, "SELECT event_seq FROM peer_messages WHERE direction = 'out' AND peer = ? AND wire_id = ?").get(peer, replyTo) as { event_seq: number | null } | undefined) : undefined;
    if (exact) return exact.event_seq;
    const last = sql(this.ctx.db, "SELECT event_seq FROM peer_messages WHERE direction = 'out' AND peer = ? ORDER BY id DESC LIMIT 1").get(peer) as { event_seq: number | null } | undefined;
    return last?.event_seq ?? null;
  }

  private insertEvent(owner: number, trust: 'untrusted' | null, text: string | null, info: PeerEventInfo): number {
    const r = sql(this.ctx.db, `INSERT INTO events(chat_id, kind, trust, text, status, created_at, peer_json) VALUES (?, 'peer', ?, ?, 'new', ?, ?)`).run(
      owner,
      trust,
      text,
      this.ctx.clock.now(),
      JSON.stringify(info),
    );
    return Number(r.lastInsertRowid);
  }
}
