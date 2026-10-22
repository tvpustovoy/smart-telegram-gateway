// Клиент сокета шлюза со стороны канала (TECH-SPEC 5.10). Состояния:
//  idle        — ещё не начали: hello шлюзу — только после `initialized` от Claude Code;
//  connecting  — соединения нет или ждём welcome; переподключение с паузой 1…30 с;
//  leased      — welcome получен: события идут в сессию (сначала probe — на него отвечает модель done);
//  busy        — очередь держит другая сессия (или нашу предварительную аренду вытеснили): hello снова через 30 с;
//  unverified  — проба осталась без done 120 с: сессия, похоже, открыта без флага канала. Сами не переподключаемся —
//                только по вызову инструмента (модель жива — значит, может и ответить на новую пробу);
//  mismatch    — версии протокола не совпали: ждём вызова инструмента;
//  closed      — канал завершается (закрыт stdin).
// Своя проверка связи: ping шлюзу каждые 15 с; ни одного кадра от шлюза 45 с — соединение рвётся и поднимается заново
// (шлюз отвечает pong сразу, при любых своих часах).
// События толкаются в сессию строго по порядку прихода; толкнул — delivered.
// Та же сессия (0.3.2, R-4 а): в hello — instance_id процесса канала (случайный, заводится при
// старте и не меняется, пока процесс жив) и prev_lease — аренда из последнего welcome. Шлюз узнаёт тот же процесс и ту же
// сессию и не шлёт проверочное событие (хода модели нет). Шлюз до 0.3.2 этих полей не знает — bad_request
// «нераспознанные ключи»: канал запоминает это и повторяет hello без них (как переходник до 0.3.2) ⟨предл.⟩.
// Кадры шлюза читаются до MAX_MEDIA_FRAME_BYTES (8 МБ): ответ на media — картинка в base64 (0.3); свои кадры шлюзу — по-
// прежнему до 1 МБ.

import net from 'node:net';
import {
  FrameDecoder,
  MAX_MEDIA_FRAME_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
  parseGatewayLine,
  type EventMessage,
  type GatewayMessage,
  type Mode,
} from 'stg-core';
import type { ChannelTiming } from './timing.js';

export type ClientState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'leased'; leaseId: string }
  | { kind: 'busy'; holder: string | null; since: number | null }
  | { kind: 'unverified'; text: string }
  | { kind: 'mismatch'; text: string }
  | { kind: 'closed' };

export interface GatewayClientOptions {
  socketPath: string;
  adapter: string;
  timing: ChannelTiming;
  hint: { cwd: string; pid: number };
  /** Ключ процесса канала (0.3.2): случайный, на всю жизнь процесса; шлюзу — в hello. */
  instanceId?: string;
  log: (line: string) => void;
  /** Событие → в сессию. true — толкнули (шлюзу уйдёт delivered). */
  onEvent: (ev: EventMessage) => Promise<boolean>;
  /** Режим или ход сменились (welcome или mode). */
  onMode: (state: Mode, turn: number, previous: Mode | null) => void;
}

/** Шлюза нет: запрос не ушёл. */
export class GatewayGoneError extends Error {}
/** Запрос ушёл в сокет, а соединение оборвалось до ответа шлюза: могло дойти (шлюз записал, ответ потерян). */
export class GatewayLostError extends Error {}
/** Шлюз не ответил за срок запроса. */
export class GatewayTimeoutError extends Error {}

interface Pending {
  resolve: (m: GatewayMessage) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class GatewayClient {
  private st: ClientState = { kind: 'idle' };
  private sock: net.Socket | null = null;
  private decoder = new FrameDecoder(MAX_MEDIA_FRAME_BYTES);
  private readonly pending = new Map<string, Pending>();
  private reqSeq = 0;
  private helloReq: string | null = null;
  private backoff: number;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private modeNow: Mode | null = null;
  private turnNow = 0;
  /** Аренда из последнего welcome (0.3.2): шлюзу — prev_lease в следующем hello. */
  private lastLease: string | null = null;
  /** Шлюз до 0.3.2 не знает instance_id и prev_lease — hello без них. */
  private legacyHello = false;

  constructor(private readonly opts: GatewayClientOptions) {
    this.backoff = opts.timing.reconnectMinMs;
  }

  get state(): ClientState {
    return this.st;
  }

  /** Последний известный ход: из welcome и mode (5.10); агенту не показывается. */
  get turn(): number {
    return this.turnNow;
  }

  get mode(): Mode | null {
    return this.modeNow;
  }

  get connected(): boolean {
    return this.sock !== null && !this.sock.destroyed;
  }

  /** После `initialized` от Claude Code. */
  start(): void {
    if (this.st.kind !== 'idle') return;
    this.connect();
  }

  /** Вызов инструмента в unverified/mismatch: попробовать снова сейчас. */
  kick(): void {
    if (this.st.kind === 'unverified' || this.st.kind === 'mismatch' || (this.st.kind === 'connecting' && !this.sock)) {
      this.clearRetry();
      this.connect();
    }
  }

  /** Канал завершается: соединение закрыть (шлюз снимет аренду), таймеры — стоп. */
  stop(): Promise<void> {
    this.setState({ kind: 'closed' });
    this.clearRetry();
    this.stopPing();
    this.failPending(new GatewayGoneError('канал завершается'));
    const sock = this.sock;
    this.sock = null;
    if (!sock || sock.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        sock.destroy();
        resolve();
      }, this.opts.timing.exitFlushMs);
      sock.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      sock.end();
    });
  }

  /**
   * Запрос с req_id: ack, error или where_result с тем же req_id. Нет соединения — GatewayGoneError сразу; соединение
   * оборвалось после записи кадра — GatewayLostError; срок вышел — GatewayTimeoutError.
   */
  request(type: string, fields: Record<string, unknown> = {}, timeoutMs = this.opts.timing.requestTimeoutMs): Promise<GatewayMessage> {
    const sock = this.sock;
    if (!sock || sock.destroyed || this.st.kind !== 'leased') return Promise.reject(new GatewayGoneError('нет соединения со шлюзом'));
    return this.send(type, fields, timeoutMs);
  }

  private send(type: string, fields: Record<string, unknown>, timeoutMs: number): Promise<GatewayMessage> {
    const sock = this.sock;
    if (!sock || sock.destroyed) return Promise.reject(new GatewayGoneError('нет соединения со шлюзом'));
    const req_id = `ch-${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new GatewayTimeoutError(`шлюз не ответил на ${type} за ${timeoutMs} мс`));
      }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timer });
      try {
        sock.write(encodeFrame({ type, req_id, ...fields }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(req_id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private setState(s: ClientState): void {
    const prev = this.st.kind;
    this.st = s;
    if (prev !== s.kind) this.opts.log(`состояние: ${s.kind}${'text' in s ? ` (${s.text})` : ''}`);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private schedule(ms: number): void {
    this.clearRetry();
    if (this.st.kind === 'closed') return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, ms);
  }

  private connect(): void {
    if (this.st.kind === 'closed') return;
    if (this.sock && !this.sock.destroyed) this.sock.destroy();
    this.decoder = new FrameDecoder(MAX_MEDIA_FRAME_BYTES);
    if (this.st.kind !== 'busy') this.setState({ kind: 'connecting' });
    const sock = net.connect(this.opts.socketPath);
    this.sock = sock;
    sock.on('connect', () => {
      this.lastFrameAt = Date.now();
      this.startPing();
      this.helloReq = `ch-hello-${++this.reqSeq}`;
      const same =
        this.opts.instanceId && !this.legacyHello
          ? { instance_id: this.opts.instanceId, ...(this.lastLease !== null ? { prev_lease: this.lastLease } : {}) }
          : {};
      sock.write(
        encodeFrame({ type: 'hello', req_id: this.helloReq, adapter: this.opts.adapter, version: PROTOCOL_VERSION, role: 'adapter', session_hint: this.opts.hint, ...same }),
      );
    });
    sock.on('data', (chunk: Buffer) => {
      if (this.sock !== sock) return;
      this.lastFrameAt = Date.now();
      for (const f of this.decoder.push(chunk)) {
        if (f.kind !== 'line') continue;
        const p = parseGatewayLine(f.line);
        if (!p.ok) {
          this.opts.log(`кадр шлюза не разобрался: ${p.text}`);
          continue;
        }
        this.onMessage(p.message, sock);
      }
    });
    sock.on('error', (err) => {
      if (this.sock === sock) this.opts.log(`сокет: ${err.message}`);
    });
    sock.on('close', () => this.onClose(sock));
  }

  private onClose(sock: net.Socket): void {
    if (this.sock !== sock) return;
    this.sock = null;
    this.stopPing();
    // Запросы в пути уже записаны в сокет: шлюз мог их исполнить — это не «не ушло».
    this.failPending(new GatewayLostError('соединение со шлюзом оборвалось после отправки'));
    const k = this.st.kind;
    if (k === 'closed' || k === 'unverified' || k === 'mismatch') return;
    if (k === 'busy') {
      this.schedule(this.opts.timing.busyRetryMs);
      return;
    }
    this.setState({ kind: 'connecting' });
    const wait = this.backoff;
    this.backoff = Math.min(this.opts.timing.reconnectMaxMs, this.backoff * 2);
    this.schedule(wait);
  }

  private failPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const sock = this.sock;
      if (!sock || sock.destroyed) return;
      if (Date.now() - this.lastFrameAt >= this.opts.timing.pongTimeoutMs) {
        this.opts.log('шлюз молчит — переподключаюсь');
        sock.destroy();
        return;
      }
      try {
        sock.write(encodeFrame({ type: 'ping' }));
      } catch {
        // сокет уже закрывается
      }
    }, this.opts.timing.pingMs);
    this.pingTimer.unref();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private onMessage(m: GatewayMessage, sock: net.Socket): void {
    switch (m.type) {
      case 'ping':
        sock.write(encodeFrame({ type: 'pong' }));
        return;
      case 'pong':
        return;
      case 'welcome':
        if (m.req_id !== this.helloReq) return;
        this.backoff = this.opts.timing.reconnectMinMs;
        this.lastLease = m.lease_id;
        this.setState({ kind: 'leased', leaseId: m.lease_id });
        this.applyMode(m.mode, m.turn);
        return;
      case 'mode':
        this.applyMode(m.state, m.turn);
        return;
      case 'event':
        this.enqueueEvent(m, sock);
        return;
      case 'error':
        if (m.req_id !== null && m.req_id === this.helloReq) {
          this.onHelloRefused(m, sock);
          return;
        }
        if (m.req_id === null) {
          this.onUnsolicitedError(m, sock);
          return;
        }
        this.settle(m.req_id, m);
        return;
      case 'ack':
      case 'where_result':
        this.settle(m.req_id, m);
        return;
    }
  }

  private settle(reqId: string, m: GatewayMessage): void {
    const p = this.pending.get(reqId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(reqId);
    p.resolve(m);
  }

  private applyMode(state: Mode, turn: number): void {
    const prev = this.modeNow;
    this.turnNow = turn;
    this.modeNow = state;
    this.opts.onMode(state, turn, prev);
  }

  private onHelloRefused(m: Extract<GatewayMessage, { type: 'error' }>, sock: net.Socket): void {
    if (m.code === 'busy') {
      this.setState({ kind: 'busy', holder: m.holder ?? null, since: m.since ?? null });
      sock.end();
      return;
    }
    if (m.code === 'version_mismatch') {
      this.setState({ kind: 'mismatch', text: m.text });
      sock.end();
      return;
    }
    // Шлюз до 0.3.2: instance_id и prev_lease ему незнакомы — дальше hello без них (проба на каждую аренду, как раньше).
    if (m.code === 'bad_request' && !this.legacyHello && /нераспознанн/i.test(m.text) && /instance_id|prev_lease/.test(m.text)) {
      this.legacyHello = true;
      this.opts.log('шлюз старой версии: hello без instance_id — проверочное событие на каждую аренду');
      this.backoff = this.opts.timing.reconnectMinMs;
      sock.destroy();
      return;
    }
    // unavailable (диск полон у шлюза) и прочее — переподключиться с паузой.
    this.opts.log(`hello: ${m.code} — ${m.text}`);
    sock.destroy();
  }

  private onUnsolicitedError(m: Extract<GatewayMessage, { type: 'error' }>, sock: net.Socket): void {
    if (m.code === 'unverified') {
      this.setState({ kind: 'unverified', text: m.text });
      sock.end();
      return;
    }
    if (m.code === 'busy') {
      // Предварительную аренду вытеснила другая сессия.
      this.setState({ kind: 'busy', holder: m.holder ?? null, since: m.since ?? null });
      sock.end();
      return;
    }
    this.opts.log(`шлюз: ${m.code} — ${m.text}`);
  }

  /** События — строго по порядку: следующее толкается, когда предыдущее ушло в сессию. */
  private enqueueEvent(ev: EventMessage, sock: net.Socket): void {
    this.chain = this.chain.then(async () => {
      if (this.sock !== sock || this.st.kind !== 'leased') return;
      let pushed = false;
      try {
        pushed = await this.opts.onEvent(ev);
      } catch (err) {
        this.opts.log(`№ ${ev.seq} в сессию не ушёл: ${(err as Error).message}`);
      }
      if (!pushed || this.sock !== sock) return;
      this.send('delivered', { seq: ev.seq }, this.opts.timing.requestTimeoutMs).then(
        (r) => {
          if (r.type === 'error') this.opts.log(`delivered № ${ev.seq}: ${r.code} — ${r.text}`);
        },
        () => undefined,
      );
    });
  }
}
