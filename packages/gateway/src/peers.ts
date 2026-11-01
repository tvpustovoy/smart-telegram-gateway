// Связь с другими агентами (сценарий 1, TECH-SPEC 5.19): шлюз переносит слово владельца другому агенту и принимает ответ.
// Кому и что передать, решает агент (relay); текст берёт шлюз из базы, поэтому модель-посредник слово не переписывает.
//
// - Канал — отдельное соединение stg-link (hello role peer_link), без аренды: оно только пересылает письма. Вся логика
//   здесь: список агентов, проверки, метки, запись. Связи нет — письмо ждёт в peer_messages и уходит при подключении.
// - Письмо агента — событие вида peer с меткой «чужое»: приходит по обычному курсору аренды и будит агента, как сообщение
//   владельца. Адрес вне peers настроек не принимается. Повтор того же письма (wire_id) второго события не даёт.
// - Текст исходящего хранится, только пока письмо ждёт: дальше он есть в слове владельца и в истории сети.
// - Письма уходят в связь по одному: следующее — после исхода предыдущего. Так «стоп» останавливает всё, что ещё не начато,
//   а в пути бывает не больше одного письма.
// - Правда о передаче — у шлюза: строку владельцу ставит код, когда связь подтвердила отправку или отказала; в ней видно,
//   что ушёл отрывок и что была записка.

import { MAX_FRAME_BYTES, ROUTE_ASK, readTurn, LEASE_PONG_TIMEOUT_MS, MAX_REPLY_TEXT, MESSAGE_EVENT_KINDS, cutGraphemes, sql, transaction, type AdapterMessage, type AgentsResult, type ErrorCode, type Mode, type PeerEventInfo, type RelayResult, type EventStatus, type LineLogResult, type LinesResult } from 'stg-core';
import { enqueueServiceLine, type Ctx } from './context.js';
import { noticeLetters, openLine, showLetter } from './lines.js';
import { requestSent } from './reactions.js';
import type { GatewayConnection } from './socket-server.js';

// Линия (сценарий 2, 5.20): слово владельца на линии уходит кодом, мимо ведущего агента; письмо агента на линии — прямо
// владельцу, ведущий агент его не получает. Письмо с линии, пришедшее вне её, ждёт кнопки владельца.

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
  detail: string | null;
  status: 'pending' | 'sent' | 'failed' | 'dropped' | 'received';
  error: string | null;
  origin: 'relay' | 'line';
  line_id: number | null;
}

interface WordRow {
  route: string | null;
  kind: string;
  trust: string | null;
  text: string | null;
  transcript: string | null;
  attachments_json: string | null;
}

/** Событие с адресом. */
interface LineEvent extends WordRow {
  seq: number;
  route: string;
  forward_json: string | null;
  edit_of: number | null;
  message_id: number | null;
  chat_id: number;
}

interface LinkedOut {
  id: number;
  event_seq: number | null;
  origin: 'relay' | 'line';
  line_id: number | null;
  exact: boolean;
}

export type RelayOutcome = { ok: true; result: RelayResult } | { ok: false; code: ErrorCode; text: string };

export type PeerInResult = { status: 'accepted'; seq: number } | { status: 'duplicate' | 'unknown_peer' };

/** Настоящее время на ответ, как у аренды: часы могли прыгнуть, а связь не успела ответить. */
const LEASE_REAL_GRACE_MS = 1_000;
/** Скобки заголовков письма: в записке агента они заменяются, чтобы записка не выглядела словом владельца. */
const HEAD_OPEN = '⟦';
const HEAD_CLOSE = '⟧';
/** Сколько событий с адресом разбирается за раз. */
const ROUTE_BATCH = 50;
/** Запас на служебные поля строки line_log. */
const LINE_LOG_ROW_BYTES = 128;
/** Сколько отрывка видно в строке владельцу. */
const DETAIL_EXCERPT_MAX = 120;

const REPEAT_STATUS: Record<PeerRow['status'], RelayResult['status']> = {
  pending: 'queued',
  received: 'queued',
  sent: 'sent',
  failed: 'failed',
  dropped: 'dropped_stopped',
};

/**
 * Слова владельца в событии с меткой owner. Подпись — всегда его. Расшифровка — только его собственного звука: голосового или
 * своего файла; звук видео и чужого файла — чужая речь, даже если прислал владелец (как в канале, format.ts: bodyOf).
 */
function ownerWords(ev: WordRow): string {
  const attachments = ev.attachments_json ? (JSON.parse(ev.attachments_json) as Array<{ kind: string; trust: string }>) : [];
  const ownSound = ev.kind === 'voice' || attachments.find((a) => a.kind === 'document')?.trust === 'owner';
  return [ev.text, ownSound ? ev.transcript : null].filter((x): x is string => !!x?.trim()).join('\n');
}

/** Что владелец увидит в строке о передаче: какой отрывок ушёл и была ли записка. */
function detailOf(excerpt: string | undefined, note: string | undefined): string | null {
  const parts: string[] = [];
  if (excerpt !== undefined) {
    const c = cutGraphemes(excerpt.replace(/\s+/g, ' '), DETAIL_EXCERPT_MAX);
    parts.push(`отрывок: «${c.text}${c.cut ? '…' : ''}»`);
  }
  if (note !== undefined) parts.push('с запиской');
  return parts.length ? parts.join(', ') : null;
}

/** Письмо: слово и записка раздельно, заголовки ставит шлюз. */
export function peerLetter(seq: number, words: string, excerpted: boolean, note: string | null, title?: string): string {
  const head = `${HEAD_OPEN}${title ?? `Слово владельца № ${seq}${excerpted ? ', отрывок' : ''}`}. Текст из базы шлюза, агент его не менял${HEAD_CLOSE}`;
  // Скобки заголовков ставит только шлюз: в пересланном тексте и записке они заменяются, иначе чужое выдало бы себя за слово владельца.
  const plain = (t: string): string => t.replaceAll(HEAD_OPEN, '[').replaceAll(HEAD_CLOSE, ']');
  const parts = [head, plain(words)];
  if (note !== null) {
    parts.push(`${HEAD_OPEN}Записка агента, не слово владельца${HEAD_CLOSE}`);
    parts.push(plain(note));
  }
  return parts.join('\n');
}

export class PeerService {
  private link: GatewayConnection | null = null;
  /** Письмо в пути: отдано связи, исхода ещё нет. */
  private inflight: number | null = null;
  /** ping связи без ответа: время по часам шлюза и настоящее. */
  private ping: { at: number; real: number } | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly hooks: PeerHooks,
  ) {}

  get linked(): boolean {
    return this.link?.alive ?? false;
  }

  /**
   * Занято живой связью — отказ: два процесса вытесняли бы друг друга, а память об отправленном у каждого своя. Отказанный
   * подключается снова и подхватит работу, когда прежний выйдет.
   */
  accepts(conn: GatewayConnection): boolean {
    return !this.link || this.link === conn || !this.link.alive;
  }

  /** Подключилась связь: ждущие письма пойдут по одному. */
  attach(conn: GatewayConnection): void {
    this.link = conn;
    this.inflight = null;
    this.ping = null;
    conn.role = 'peer_link';
    this.ctx.journal.write('peer_link_up', {});
    this.next();
  }

  detach(conn: GatewayConnection): void {
    if (this.link !== conn) return;
    this.link = null;
    this.inflight = null;
    this.ping = null;
    this.ctx.journal.write('peer_link_down', {});
  }

  /** Такт шлюза: зависшая связь держала бы место и письмо в пути; не ответила на ping — соединение закрывается. Сон сбрасывает ожидание. */
  tick(now: number, real: number, woke: boolean): void {
    const link = this.link;
    if (!link) return;
    if (woke) this.ping = null;
    if (!this.ping) {
      this.ping = { at: now, real };
      link.send({ type: 'ping' });
    } else if (now - this.ping.at >= LEASE_PONG_TIMEOUT_MS && real - this.ping.real >= LEASE_REAL_GRACE_MS) {
      this.ctx.journal.write('peer_link_lost', { waited_ms: now - this.ping.at });
      link.destroy();
    }
  }

  pong(conn: GatewayConnection): void {
    if (this.link === conn) this.ping = null;
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
    const ev = sql(this.ctx.db, 'SELECT route, kind, trust, text, transcript, attachments_json FROM events WHERE seq = ?').get(msg.seq) as WordRow | undefined;
    if (!ev || ev.route !== null || !(MESSAGE_EVENT_KINDS as readonly string[]).includes(ev.kind)) return { ok: false, code: 'unknown_seq', text: `нет сообщения № ${msg.seq}` };
    if (ev.trust !== 'owner') return { ok: false, code: 'bad_request', text: `№ ${msg.seq} — не слова владельца; передать можно только их, остальное — запиской` };
    const words = ownerWords(ev);
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
      `INSERT INTO peer_messages(direction, peer, event_seq, text, detail, idem, status, created_at) VALUES ('out', ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(peer.name, msg.seq, text, detailOf(excerpt, msg.note), msg.idem ?? null, this.ctx.clock.now());
    const id = Number(r.lastInsertRowid);
    this.ctx.journal.write('relay', { id, seq: msg.seq, to: peer.name, excerpt: excerpt !== undefined, note: msg.note !== undefined, link: this.linked });
    this.next();
    return { ok: true, result: { status: 'queued', id, link: this.linked } };
  }

  /**
   * События с адресом — по адресу (5.20). Вызывается из pump: новое сообщение, готовая расшифровка, снятая пауза и
   * нажатие кнопки проходят через него. На паузе и в стопе всё ждёт: на линии действует то же, что у ведущего агента.
   */
  routeNew(mode: Mode, voiceHoldMs: number): void {
    if (mode !== 'running') return;
    // Голосовое в распознавании держит следующих, как у ведущего агента: текст не обгоняет сказанное раньше.
    const barrier = sql(this.ctx.db, "SELECT min(seq) AS s FROM events WHERE status = 'transcribing' AND route IS NOT NULL AND created_at > ?").get(this.ctx.clock.now() - voiceHoldMs) as { s: number | null };
    const rows = sql(this.ctx.db,
      `SELECT seq, route, kind, trust, text, transcript, attachments_json, forward_json, edit_of, message_id, chat_id FROM events
       WHERE status = 'new' AND route IS NOT NULL AND route <> ? AND seq < ? ORDER BY seq LIMIT ${ROUTE_BATCH}`,
    ).all(ROUTE_ASK, barrier.s ?? Number.MAX_SAFE_INTEGER) as unknown as LineEvent[];
    if (!rows.length) return;
    for (const ev of rows) {
      transaction(this.ctx.db, () => {
        if (ev.kind === 'peer') showLetter(this.ctx, ev.seq, ev.chat_id, ev.route, ev.text ?? '', readTurn(this.ctx.db));
        else this.sendOnLine(ev);
        sql(this.ctx.db, "UPDATE events SET status = 'processed', processed_at = ?, processed_silent = 0 WHERE seq = ?").run(this.ctx.clock.now(), ev.seq);
      });
    }
    this.next();
    this.hooks.onQueued();
  }

  /** Слово владельца на линии: письмо в очередь или строка, почему нет. Внутри транзакции. */
  private sendOnLine(ev: LineEvent): void {
    const refuse = (why: string): void => {
      this.ctx.journal.write('line_refused', { seq: ev.seq, to: ev.route, reason: why });
      enqueueServiceLine(this.ctx, `⚙ Не передано: ${ev.route}. ${why}`, { replyToMessageId: ev.message_id });
    };
    if (!this.ctx.config.peers.some((p) => p.name === ev.route)) return refuse('агента нет в списке шлюза');
    const attachments = ev.attachments_json ? (JSON.parse(ev.attachments_json) as Array<{ kind: string }>) : [];
    const files = attachments.some((a) => a.kind === 'photo' || a.kind === 'document');
    const words = ownerWords(ev);
    // Правка без слов (живое место шлёт их потоком) — не повод для строки на каждую.
    if (!words && ev.kind === 'edit') return;
    if (!words) return refuse(files ? 'файлы на линии пока не передаются' : 'нет текста: голос не распознан');
    const title = ev.kind === 'edit' ? `Правка слова владельца № ${ev.edit_of ?? '?'}` : ev.forward_json !== null || ev.trust !== 'owner' ? `Переслал владелец, это не его слово, № ${ev.seq}` : undefined;
    const text = peerLetter(ev.seq, words, false, null, title);
    if (text.length > MAX_REPLY_TEXT) return refuse(`письмо длиннее ${MAX_REPLY_TEXT} знаков`);
    const line = openLine(this.ctx);
    sql(this.ctx.db,
      `INSERT INTO peer_messages(direction, peer, event_seq, text, detail, status, created_at, origin, line_id) VALUES ('out', ?, ?, ?, ?, 'pending', ?, 'line', ?)`,
    ).run(ev.route, ev.seq, text, files ? 'без вложения' : null, this.ctx.clock.now(), line?.peer === ev.route ? line.id : null);
    this.ctx.journal.write('line_out', { seq: ev.seq, to: ev.route, link: this.linked });
  }

  /** Письмо от связи. Вне списка — отказ и запись в журнал; письмо дальше не идёт. */
  incoming(msg: Extract<AdapterMessage, { type: 'peer_in' }>): { ok: true; result: PeerInResult } | { ok: false; code: ErrorCode; text: string } {
    const peer = this.ctx.config.peers.find((p) => p.address === msg.address);
    if (!peer) {
      this.ctx.journal.write('peer_refused', { address: msg.address.slice(0, 12), wire_id: msg.wire_id.slice(0, 12) });
      return { ok: true, result: { status: 'unknown_peer' } };
    }
    if (sql(this.ctx.db, "SELECT 1 FROM peer_messages WHERE direction = 'in' AND peer = ? AND wire_id = ?").get(peer.name, msg.wire_id)) return { ok: true, result: { status: 'duplicate' } };
    const owner = this.ctx.config.owner_id;
    if (owner === null) return { ok: false, code: 'unavailable', text: 'владелец не задан (первая настройка)' };
    const linked = this.linkedOut(peer.name, msg.reply_to ?? null);
    const info: PeerEventInfo = { name: peer.name, relay_seq: linked?.event_seq ?? null };
    const seq = transaction(this.ctx.db, () => {
      const now = this.ctx.clock.now();
      const line = openLine(this.ctx);
      // Ответ именно на передачу ведущего агента — ему, с кем бы владелец ни был на линии: он этого ответа ждёт.
      const forMain = linked?.exact === true && linked.origin === 'relay';
      const onLine = !forMain && line?.peer === peer.name;
      // Ответ на слово с линии, а линии с ним уже нет: ведущему агенту его читать нельзя, владелец посмотрит кнопкой.
      const aside = !forMain && !onLine && linked?.origin === 'line';
      const s = this.insertEvent(owner, 'untrusted', msg.text, info, aside ? 'handled' : 'new', onLine || aside ? peer.name : null);
      sql(this.ctx.db,
        `INSERT INTO peer_messages(direction, peer, event_seq, wire_id, reply_to, status, created_at, origin, line_id, unseen) VALUES ('in', ?, ?, ?, ?, 'received', ?, ?, ?, ?)`,
      ).run(peer.name, s, msg.wire_id, msg.reply_to ?? null, now, onLine || aside ? 'line' : 'relay', onLine ? line!.id : aside ? linked!.line_id : null, aside ? 1 : 0);
      if (aside) noticeLetters(this.ctx, peer.name, now);
      return s;
    });
    this.ctx.journal.write('peer_in', { seq, from: peer.name, wire_id: msg.wire_id.slice(0, 12), relay_seq: info.relay_seq });
    this.hooks.onEvent();
    this.hooks.onQueued();
    return { ok: true, result: { status: 'accepted', seq } };
  }

  /** Связь подтвердила отправку. Письмо, брошенное «стопом» уже в пути, тоже становится sent: оно дошло. */
  sent(msg: Extract<AdapterMessage, { type: 'peer_sent' }>): void {
    const row = this.row(msg.id);
    if (row && (row.status === 'pending' || row.status === 'dropped')) {
      transaction(this.ctx.db, () => {
        sql(this.ctx.db, "UPDATE peer_messages SET status = 'sent', wire_id = ?, text = NULL, detail = NULL, sent_at = ? WHERE id = ?").run(msg.wire_id, this.ctx.clock.now(), msg.id);
        // На линии строка на каждое сообщение была бы шумом: 🕊 на самом сообщении. Что-то ушло не целиком — строкой.
        if (row.origin === 'line' && !row.detail && row.event_seq !== null) requestSent(this.ctx, [row.event_seq]);
        else this.ownerLine(row, `⚙ ➡\uFE0F ${row.peer}${row.detail ? `, ${row.detail}` : ''}`);
      });
      this.ctx.journal.write('peer_sent', { id: msg.id, to: row.peer, wire_id: msg.wire_id.slice(0, 12) });
      this.hooks.onQueued();
    }
    this.settled(msg.id);
  }

  /** Связь отказала. */
  failed(msg: Extract<AdapterMessage, { type: 'peer_failed' }>): void {
    const row = this.row(msg.id);
    if (row?.status === 'pending') this.fail(row, msg.reason);
    this.settled(msg.id);
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

  /** Разговоры на линии, новые первыми. Содержимого нет. */
  lines(limit: number): LinesResult {
    const lines = sql(this.ctx.db,
      `SELECT l.id, l.peer, l.started_at, l.ended_at, (SELECT count(*) FROM peer_messages pm WHERE pm.line_id = l.id) AS messages
       FROM lines l ORDER BY l.id DESC LIMIT ?`,
    ).all(limit) as unknown as LinesResult['lines'];
    return { lines };
  }

  /** Содержимое линии: слова — из событий, что вычищено, то вычищено. Больше половины кадра не отдаём: старые письма не входят. */
  lineLog(id: number): LineLogResult | null {
    const line = sql(this.ctx.db, 'SELECT peer FROM lines WHERE id = ?').get(id) as { peer: string } | undefined;
    if (!line) return null;
    const rows = sql(this.ctx.db,
      `SELECT pm.direction, pm.created_at, e.route, e.kind, e.trust, e.text, e.transcript, e.attachments_json, e.forward_json
       FROM peer_messages pm JOIN events e ON e.seq = pm.event_seq WHERE pm.line_id = ? ORDER BY pm.id DESC`,
    ).all(id) as unknown as Array<WordRow & { direction: 'in' | 'out'; created_at: number; forward_json: string | null }>;
    const messages: LineLogResult['messages'] = [];
    let bytes = 0;
    for (const r of rows) {
      const text = r.direction === 'in' ? r.text : ownerWords(r) || null;
      // Считается как в кадре: JSON раздувает кавычки и управляющие знаки.
      bytes += Buffer.byteLength(JSON.stringify(text)) + LINE_LOG_ROW_BYTES;
      if (bytes > MAX_FRAME_BYTES / 2) break;
      messages.unshift({ at: r.created_at, from: r.direction === 'in' ? line.peer : null, forwarded: r.direction === 'out' && (r.forward_json !== null || r.trust !== 'owner'), text });
    }
    return { peer: line.peer, messages, omitted: rows.length - messages.length };
  }

  private row(id: number): PeerRow | undefined {
    return sql(this.ctx.db, 'SELECT * FROM peer_messages WHERE id = ?').get(id) as PeerRow | undefined;
  }

  /** Строка владельцу о письме — ответом на его сообщение, поэтому номер события ему не нужен. */
  private ownerLine(row: PeerRow, text: string): void {
    const ev = sql(this.ctx.db, 'SELECT message_id FROM events WHERE seq = ?').get(row.event_seq) as { message_id: number | null } | undefined;
    enqueueServiceLine(this.ctx, text, { replyToMessageId: ev?.message_id ?? null });
  }

  /** Письмо закрыто с отказом: агент получает событие, владелец — строку. */
  private fail(row: PeerRow, reason: string): void {
    const owner = this.ctx.config.owner_id;
    transaction(this.ctx.db, () => {
      sql(this.ctx.db, "UPDATE peer_messages SET status = 'failed', error = ?, text = NULL, detail = NULL WHERE id = ?").run(reason, row.id);
      if (owner === null) return;
      // Ведущий агент о линии не знает: об отказе на ней говорим только владельцу.
      if (row.origin !== 'line') this.insertEvent(owner, null, null, { name: row.peer, relay_seq: row.event_seq, failed: reason });
      this.ownerLine(row, `⚙ Не передано: ${row.peer}. ${reason}`);
    });
    this.ctx.journal.write('peer_failed', { id: row.id, to: row.peer, reason });
    this.hooks.onEvent();
    this.hooks.onQueued();
  }

  private settled(id: number): void {
    if (this.inflight === id) this.inflight = null;
    this.next();
  }

  /** Отдать связи следующее письмо, если в пути нет другого. Агента убрали из настроек — письмо закрывается с отказом. */
  private next(): void {
    while (this.inflight === null && this.link?.alive) {
      const row = sql(this.ctx.db, "SELECT * FROM peer_messages WHERE status = 'pending' AND direction = 'out' ORDER BY id LIMIT 1").get() as PeerRow | undefined;
      if (!row) return;
      const address = this.ctx.config.peers.find((p) => p.name === row.peer)?.address;
      if (address === undefined || row.text === null) {
        this.fail(row, 'агента нет в списке шлюза');
        continue;
      }
      this.inflight = row.id;
      this.link.send({ type: 'peer_send', id: row.id, address, text: row.text });
    }
  }

  /**
   * К какому письму ответ: на которое агент ответил (exact), иначе последнее ему. Без reply_to и при слове с линии, на
   * которое он ещё не писал, письмо считается ответом на него: ошибка в эту сторону покажет письмо кнопкой владельцу, а в
   * другую отдала бы разговор на линии ведущему агенту.
   */
  private linkedOut(peer: string, replyTo: string | null): LinkedOut | null {
    const fields = "SELECT id, event_seq, origin, line_id FROM peer_messages WHERE direction = 'out' AND peer = ?";
    const exact = replyTo !== null ? (sql(this.ctx.db, `${fields} AND wire_id = ?`).get(peer, replyTo) as Omit<LinkedOut, 'exact'> | undefined) : undefined;
    if (exact) return { ...exact, exact: true };
    const answered = (sql(this.ctx.db, "SELECT max(id) AS id FROM peer_messages WHERE direction = 'in' AND peer = ?").get(peer) as { id: number | null }).id ?? 0;
    const word = sql(this.ctx.db, `${fields} AND origin = 'line' AND id > ? ORDER BY id DESC LIMIT 1`).get(peer, answered) as Omit<LinkedOut, 'exact'> | undefined;
    if (word) return { ...word, exact: false };
    const last = sql(this.ctx.db, `${fields} ORDER BY id DESC LIMIT 1`).get(peer) as Omit<LinkedOut, 'exact'> | undefined;
    return last ? { ...last, exact: false } : null;
  }

  private insertEvent(owner: number, trust: 'untrusted' | null, text: string | null, info: PeerEventInfo, status: EventStatus = 'new', route: string | null = null): number {
    const r = sql(this.ctx.db, `INSERT INTO events(chat_id, kind, trust, text, status, created_at, peer_json, route) VALUES (?, 'peer', ?, ?, ?, ?, ?, ?)`).run(
      owner,
      trust,
      text,
      status,
      this.ctx.clock.now(),
      JSON.stringify(info),
      route,
    );
    return Number(r.lastInsertRowid);
  }
}
