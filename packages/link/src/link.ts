// Связь шлюза с сетью агентов (TECH-SPEC 5.19): письма в обе стороны и ничего больше. Что передать, кому и с какой меткой, решает шлюз.
//
// - Входящее: прочитанным письмо становится только после ack шлюза. Обрыв между ними даёт повтор, а не потерю; повтор шлюз
//   отсекает по wire_id. Будит поток уведомлений сети; опрос раз в poll_ms страхует его: у потока нет гарантии доставки.
// - Исходящее: id письма запоминается вместе с wire_id, поэтому повтор peer_send после перезапуска шлюза не даёт второго письма.
//   Сбой сети — несколько попыток, затем peer_failed: шлюз скажет агенту и владельцу. Отказ сети — peer_failed сразу.
// - Шлюз недоступен — подключается заново; письма ждут: входящие в сети, исходящие в базе шлюза.

import net from 'node:net';
import { FrameDecoder, MAX_REPLY_TEXT, PROTOCOL_VERSION, encodeFrame, parseGatewayLine, type GatewayMessage } from 'stg-core';
import type { Letter, NetworkPort, SendVerdict } from './port.js';

export const LINK_ADAPTER = 'stg-link';

export interface LinkTiming {
  reconnect_ms: number;
  poll_ms: number;
  retry_ms: number;
  attempts: number;
  answer_ms: number;
}

export const DEFAULT_LINK_TIMING: LinkTiming = { reconnect_ms: 2_000, poll_ms: 60_000, retry_ms: 5_000, attempts: 3, answer_ms: 10_000 };

export interface LinkOptions {
  socketPath: string;
  port: NetworkPort;
  log: (line: string) => void;
  timing?: Partial<LinkTiming>;
}

/** Сколько запоминается отправленных id: шлюз повторяет только ждущие, их немного. */
const SENT_MEMORY = 1000;

type PeerSend = Extract<GatewayMessage, { type: 'peer_send' }>;

/** Текст письма для шлюза: письмо без текста видно агенту, длинное обрезается с пометкой. */
export function letterText(l: Letter): string {
  const text = l.kind === 'text' ? l.text?.trim() : null;
  if (!text) return `(письмо без текста, вид ${l.kind}: шлюз принимает только текст)`;
  if (text.length <= MAX_REPLY_TEXT) return text;
  const tail = `\n… (письмо обрезано шлюзом: ${text.length} знаков)`;
  return text.slice(0, MAX_REPLY_TEXT - tail.length) + tail;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class PeerLink {
  private readonly timing: LinkTiming;
  private sock: net.Socket | null = null;
  private ready = false;
  private nextReq = 0;
  private readonly pending = new Map<string, { resolve: (m: GatewayMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly sent = new Map<number, string>();
  private sending: Promise<void> = Promise.resolve();
  private draining = false;
  private again = false;

  constructor(private readonly opts: LinkOptions) {
    this.timing = { ...DEFAULT_LINK_TIMING, ...opts.timing };
  }

  /** Работает до signal: держит соединение со шлюзом, слушает сеть и опрашивает её. */
  async run(signal: AbortSignal): Promise<void> {
    await Promise.all([this.connectLoop(signal), this.wakeLoop(signal), this.pollLoop(signal)]);
  }

  private async connectLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.session(signal);
      await wait(this.timing.reconnect_ms, signal);
    }
  }

  private async wakeLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const _ of this.opts.port.wakes(signal)) void this.drain();
      } catch (err) {
        if (!signal.aborted) this.opts.log(`поток уведомлений сети: ${(err as Error).message}`);
      }
      await wait(this.timing.reconnect_ms, signal);
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await wait(this.timing.poll_ms, signal);
      if (!signal.aborted) void this.drain();
    }
  }

  /** Одно соединение со шлюзом: до закрытия. */
  private session(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const decoder = new FrameDecoder();
      const sock = net.connect(this.opts.socketPath);
      const stop = (): void => {
        sock.destroy();
      };
      signal.addEventListener('abort', stop, { once: true });
      sock.on('connect', () => {
        this.sock = sock;
        sock.write(encodeFrame({ type: 'hello', req_id: 'link-hello', adapter: LINK_ADAPTER, version: PROTOCOL_VERSION, role: 'peer_link' }));
      });
      sock.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== 'line') continue;
          const r = parseGatewayLine(frame.line);
          if (r.ok) this.onFrame(r.message, sock);
          else this.opts.log(`кадр шлюза не разобран: ${r.text}`);
        }
      });
      sock.on('error', () => undefined);
      sock.on('close', () => {
        signal.removeEventListener('abort', stop);
        this.sock = null;
        this.ready = false;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(new Error('соединение со шлюзом закрыто'));
        }
        resolve();
      });
    });
  }

  private onFrame(m: GatewayMessage, sock: net.Socket): void {
    if (m.type === 'ping') {
      sock.write(encodeFrame({ type: 'pong' }));
      return;
    }
    if (m.type === 'peer_send') {
      this.sending = this.sending.then(() => this.deliver(m));
      return;
    }
    if ((m.type === 'ack' || m.type === 'error') && m.req_id === 'link-hello') {
      if (m.type === 'error') {
        this.opts.log(`шлюз не принял связь: ${m.text}`);
        sock.destroy();
        return;
      }
      this.ready = true;
      this.opts.log('связь со шлюзом установлена');
      void this.drain();
      return;
    }
    if ((m.type === 'ack' || m.type === 'error') && m.req_id !== null) {
      const p = this.pending.get(m.req_id);
      if (!p) return;
      this.pending.delete(m.req_id);
      clearTimeout(p.timer);
      p.resolve(m);
    }
  }

  private ask(type: string, fields: Record<string, unknown>): Promise<GatewayMessage> {
    return new Promise((resolve, reject) => {
      if (!this.sock || !this.ready) return reject(new Error('шлюз не подключён'));
      const req_id = `link-${++this.nextReq}`;
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error('шлюз не ответил'));
      }, this.timing.answer_ms);
      this.pending.set(req_id, { resolve, reject, timer });
      this.sock.write(encodeFrame({ type, req_id, ...fields }));
    });
  }

  /** Непрочитанное → шлюзу → прочитано. Один проход за раз; запрос во время прохода — ещё один проход. */
  private async drain(): Promise<void> {
    if (!this.ready) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.again = false;
        const taken: string[] = [];
        try {
          for (const l of await this.opts.port.unread()) {
            const r = await this.ask('peer_in', { address: l.from, wire_id: l.wire_id, text: letterText(l), ...(l.reply_to ? { reply_to: l.reply_to } : {}) });
            if (r.type !== 'ack') {
              this.opts.log(`шлюз не принял письмо ${l.wire_id.slice(0, 12)}: ${r.type === 'error' ? r.text : r.type}`);
              break;
            }
            taken.push(l.wire_id);
          }
        } finally {
          if (taken.length) await this.opts.port.consume(taken);
        }
      } while (this.again && this.ready);
    } catch (err) {
      this.opts.log(`приём писем: ${(err as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  private async deliver(m: PeerSend): Promise<void> {
    const verdict = await this.sendOnce(m);
    try {
      if (verdict.sent) await this.ask('peer_sent', { id: m.id, wire_id: verdict.wire_id });
      else await this.ask('peer_failed', { id: m.id, reason: verdict.reason.slice(0, 1000) });
    } catch (err) {
      // Шлюз повторит peer_send при подключении; отправленное второй раз не уйдёт.
      this.opts.log(`письмо ${m.id}: исход не передан шлюзу: ${(err as Error).message}`);
    }
  }

  private async sendOnce(m: PeerSend): Promise<SendVerdict> {
    const known = this.sent.get(m.id);
    if (known !== undefined) return { sent: true, wire_id: known };
    let last = '';
    for (let attempt = 1; attempt <= this.timing.attempts; attempt++) {
      try {
        const v = await this.opts.port.send(m.address, m.text);
        if (v.sent) {
          this.sent.set(m.id, v.wire_id);
          if (this.sent.size > SENT_MEMORY) this.sent.delete(this.sent.keys().next().value!);
        }
        return v;
      } catch (err) {
        last = (err as Error).message;
        this.opts.log(`письмо ${m.id}, попытка ${attempt}: ${last}`);
        if (attempt < this.timing.attempts) await new Promise((r) => setTimeout(r, this.timing.retry_ms));
      }
    }
    return { sent: false, reason: `сеть недоступна: ${last}` };
  }
}
