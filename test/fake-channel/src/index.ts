// Поддельный переходник (ACCEPTANCE §1): клиент сокета шлюза — кадры, запросы с req_id, ожидание ответа; ответ на
// probe (done) и на ping (pong) — по умолчанию сам, выключается («молчание на probe», «молчание на ping»); обрыв,
// повторный hello. events() — события для агента (без probe); пробы — probes().

import net from 'node:net';
import {
  FrameDecoder,
  MAX_MEDIA_FRAME_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
  parseGatewayLine,
  type GatewayMessage,
} from 'stg-core';

export interface FakeChannelOptions {
  /** Отвечать pong на ping шлюза (выключить — «молчание на ping»). */
  autoPong?: boolean;
  /** Отвечать done на событие probe (выключить — «молчание на probe»). */
  autoProbeDone?: boolean;
}

export interface Received {
  at: number;
  line: string;
  message: GatewayMessage | null;
  error: string | null;
}

let reqSeq = 0;

export class FakeChannel {
  readonly received: Received[] = [];
  /** Кадры шлюза — до 8 МБ: ответ на media — картинка в base64 (0.3). */
  private readonly decoder = new FrameDecoder(MAX_MEDIA_FRAME_BYTES);
  private waiters: Array<{ pred: (r: Received) => boolean; resolve: (r: Received) => void }> = [];
  private closed = false;
  /** Ответы шлюза на done по пробам (сам ответил на probe). */
  readonly probeAcks: Array<Promise<GatewayMessage>> = [];

  private constructor(
    private readonly sock: net.Socket,
    private readonly opts: Required<FakeChannelOptions>,
  ) {
    sock.on('data', (chunk: Buffer) => this.onData(chunk));
    sock.on('close', () => {
      this.closed = true;
    });
    sock.on('error', () => undefined);
  }

  static connect(socketPath: string, opts: FakeChannelOptions = {}): Promise<FakeChannel> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(socketPath);
      sock.once('connect', () => {
        sock.off('error', reject);
        resolve(new FakeChannel(sock, { autoPong: opts.autoPong ?? true, autoProbeDone: opts.autoProbeDone ?? true }));
      });
      sock.once('error', reject);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** События для агента, которые прислал шлюз (по порядку прихода), — без проверочных probe и правил канала (0.3.5). */
  events(): Array<Extract<GatewayMessage, { type: 'event' }>> {
    const out: Array<Extract<GatewayMessage, { type: 'event' }>> = [];
    for (const r of this.received) if (r.message?.type === 'event' && r.message.kind !== 'probe' && r.message.kind !== 'instructions') out.push(r.message);
    return out;
  }

  /** События «правила канала» (0.3.5, issue #47) — только если hello назвал версию правил. */
  instructions(): Array<Extract<GatewayMessage, { type: 'event' }>> {
    const out: Array<Extract<GatewayMessage, { type: 'event' }>> = [];
    for (const r of this.received) if (r.message?.type === 'event' && r.message.kind === 'instructions') out.push(r.message);
    return out;
  }

  /** Проверочные события probe (5.10). */
  probes(): Array<Extract<GatewayMessage, { type: 'event' }>> {
    const out: Array<Extract<GatewayMessage, { type: 'event' }>> = [];
    for (const r of this.received) if (r.message?.type === 'event' && r.message.kind === 'probe') out.push(r.message);
    return out;
  }

  /** Ошибки без req_id (unverified, busy при вытеснении). */
  unsolicitedErrors(): Array<Extract<GatewayMessage, { type: 'error' }>> {
    const out: Array<Extract<GatewayMessage, { type: 'error' }>> = [];
    for (const r of this.received) if (r.message?.type === 'error' && r.message.req_id === null) out.push(r.message);
    return out;
  }

  /** Аренда проверена: дождаться пробы и ack на свой done по ней. */
  async waitVerified(timeoutMs = 10_000): Promise<void> {
    await this.waitFor((x) => x.message?.type === 'event' && x.message.kind === 'probe', timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (!this.probeAcks.length) {
      if (Date.now() > deadline) throw new Error('поддельный переходник: на пробу не ответил (autoProbeDone выключен?)');
      await new Promise((r) => setTimeout(r, 5));
    }
    const ack = await this.probeAcks[this.probeAcks.length - 1]!;
    if (ack.type !== 'ack') throw new Error(`done на пробу: ${JSON.stringify(ack)}`);
  }

  /** Кадры mode от шлюза (смена режима и хода), по порядку прихода. */
  modes(): Array<Extract<GatewayMessage, { type: 'mode' }>> {
    const out: Array<Extract<GatewayMessage, { type: 'mode' }>> = [];
    for (const r of this.received) if (r.message?.type === 'mode') out.push(r.message);
    return out;
  }

  /** Последний известный ход: из welcome или последнего кадра mode (так его узнаёт канал, 5.10). */
  currentTurn(): number | null {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const m = this.received[i]!.message;
      if (m?.type === 'mode' || m?.type === 'welcome') return m.turn;
    }
    return null;
  }

  /** Дождаться кадра mode с этим состоянием (уже полученный тоже считается). */
  async waitMode(state: 'running' | 'paused' | 'stopped', timeoutMs = 10_000): Promise<Extract<GatewayMessage, { type: 'mode' }>> {
    const r = await this.waitFor((x) => x.message?.type === 'mode' && x.message.state === state, timeoutMs);
    return r.message as Extract<GatewayMessage, { type: 'mode' }>;
  }

  /** Дождаться события с этим №. */
  async waitEvent(seq: number, timeoutMs = 10_000): Promise<Extract<GatewayMessage, { type: 'event' }>> {
    const r = await this.waitFor((x) => x.message?.type === 'event' && x.message.seq === seq, timeoutMs);
    return r.message as Extract<GatewayMessage, { type: 'event' }>;
  }

  private onData(chunk: Buffer): void {
    for (const f of this.decoder.push(chunk)) {
      if (f.kind !== 'line') continue;
      const p = parseGatewayLine(f.line);
      const r: Received = { at: Date.now(), line: f.line, message: p.ok ? p.message : null, error: p.ok ? null : p.text };
      this.received.push(r);
      if (r.message?.type === 'ping' && this.opts.autoPong) this.send({ type: 'pong' });
      if (r.message?.type === 'event' && r.message.kind === 'probe' && this.opts.autoProbeDone) {
        // Как сессия с каналом: № и код — из самого события (5.10).
        const p = this.request('done', { seqs: [r.message.seq], ...(r.message.code !== undefined ? { code: r.message.code } : {}) });
        p.catch(() => undefined);
        this.probeAcks.push(p);
      }
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(r)) return true;
        w.resolve(r);
        return false;
      });
    }
  }

  /** Отправить сообщение как есть. */
  send(message: object): void {
    this.sock.write(encodeFrame(message));
  }

  /** Отправить сырую строку (для проверок кадров). */
  sendRaw(data: string | Buffer): void {
    this.sock.write(data);
  }

  /** Дождаться сообщения от шлюза (уже полученное тоже считается). */
  waitFor(pred: (r: Received) => boolean, timeoutMs = 10_000): Promise<Received> {
    const found = this.received.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error(`поддельный переходник: ответа не дождались за ${timeoutMs} мс`));
      }, timeoutMs);
      const done = (r: Received): void => {
        clearTimeout(timer);
        resolve(r);
      };
      this.waiters.push({ pred, resolve: done });
    });
  }

  /** Запрос с req_id: ждёт ack, error или where_result с тем же req_id. */
  async request(type: string, fields: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<GatewayMessage> {
    const req_id = `fc${++reqSeq}`;
    this.send({ type, req_id, ...fields });
    const r = await this.waitFor((x) => {
      const m = x.message;
      return !!m && (m.type === 'ack' || m.type === 'error' || m.type === 'where_result' || m.type === 'welcome') && m.req_id === req_id;
    }, timeoutMs);
    if (!r.message) throw new Error(`неразборчивый ответ: ${r.line}`);
    return r.message;
  }

  /**
   * hello. instanceId и prevLease (0.3.2, R-4 а) — как у переходника 0.3.2: ключ процесса и аренда до обрыва; без них —
   * как переходник до 0.3.2. cwd — каталог сессии (session_hint.cwd); по умолчанию — каталог процесса теста.
   */
  hello(
    opts: { adapter?: string; version?: number; role?: 'adapter' | 'cli'; instanceId?: string; prevLease?: string; cwd?: string; instructionsVersion?: string } = {},
  ): Promise<GatewayMessage> {
    return this.request('hello', {
      adapter: opts.adapter ?? 'fake-channel',
      version: opts.version ?? PROTOCOL_VERSION,
      role: opts.role ?? 'adapter',
      session_hint: { cwd: opts.cwd ?? process.cwd(), pid: process.pid },
      ...(opts.instanceId !== undefined ? { instance_id: opts.instanceId } : {}),
      ...(opts.prevLease !== undefined ? { prev_lease: opts.prevLease } : {}),
      // Версия правил канала (0.3.5, issue #47): с ней шлюз присылает событие «правила канала» разговору, который их не получал.
      ...(opts.instructionsVersion !== undefined ? { instructions_version: opts.instructionsVersion } : {}),
    });
  }

  delivered(seq: number): Promise<GatewayMessage> {
    return this.request('delivered', { seq });
  }

  /** reply; from (0.3.2, P-26) — чьи слова агент передаёт. */
  reply(seq: number | null, text: string, turn: number, voice = false, from?: string): Promise<GatewayMessage> {
    return this.request('reply', from !== undefined ? { seq, text, voice, turn, from } : { seq, text, voice, turn });
  }

  done(seqs: number[], code?: string): Promise<GatewayMessage> {
    return this.request('done', code !== undefined ? { seqs, code } : { seqs });
  }

  /** Код последней пробы (из кадра события, как его видит сессия с каналом). */
  probeCode(): string | undefined {
    return this.probes().at(-1)?.code;
  }

  episode(action: 'name' | 'new', topic: string, reason?: string): Promise<GatewayMessage> {
    return this.request('episode', reason ? { action, topic, reason } : { action, topic });
  }

  episodeSummary(episodeId: number, text: string): Promise<GatewayMessage> {
    return this.request('episode_summary', { episode_id: episodeId, text });
  }

  where(): Promise<GatewayMessage> {
    return this.request('where');
  }

  /** Картинка события (0.3): ack с MediaResult или error. */
  media(seq: number, timeoutMs = 30_000): Promise<GatewayMessage> {
    return this.request('media', { seq }, timeoutMs);
  }

  /**
   * Файл из папки посылок (0.3.3): ack с SendFileResult или error. Поля — как у send_file переходника: path, seq, turn;
   * caption, from, target, idem, as (#60) — когда заданы.
   */
  sendFile(
    path: string,
    seq: number | null,
    turn: number,
    opts: { caption?: string; from?: string; target?: string; idem?: string; as?: string } = {},
  ): Promise<GatewayMessage> {
    const fields: Record<string, unknown> = { path, seq, turn };
    for (const k of ['caption', 'from', 'target', 'idem', 'as'] as const) if (opts[k] !== undefined) fields[k] = opts[k];
    return this.request('send_file', fields);
  }

  /** Ход агента идёт (#55): working {on, seqs?} — ack {chats, seqs} или error. */
  working(on: boolean, seqs?: number[]): Promise<GatewayMessage> {
    return this.request('working', seqs !== undefined ? { on, seqs } : { on });
  }

  /** Аккуратно закрыть. */
  close(): void {
    this.sock.end();
  }

  /** Оборвать соединение. */
  destroy(): void {
    this.sock.destroy();
  }
}
