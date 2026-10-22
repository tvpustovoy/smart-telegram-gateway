// Сокет шлюза для переходника и CLI (TECH-SPEC 5.10): кадры, проверка схемой, ping/pong (на нём держится проверка
// «один экземпляр»). Аренду и обмен событиями ведёт AdapterService (adapter.ts) через обработчики.
// Диск полон посреди обработки (delivered, reply, done, закрытие соединения) — не падение: переходнику
// `error unavailable` («повтори позже»), общее состояние — disk.ts; процесс живёт. Иная ошибка — как прежде, наверх.

import fs from 'node:fs';
import net from 'node:net';
import { FrameDecoder, encodeFrame, parseAdapterLine, type AdapterMessage, type Journal } from 'stg-core';

export interface SocketHandlers {
  /** Сообщение переходника; вернуть false — не обработано (ответ unavailable). */
  onMessage?: (msg: AdapterMessage, conn: GatewayConnection) => boolean;
  /** Соединение закрылось (аренда снимается). */
  onClose?: (conn: GatewayConnection) => void;
  /** pong от переходника — аренда жива (5.10). */
  onPong?: (conn: GatewayConnection) => void;
  /** Ошибка обработчика: true — это «диск полон», она учтена и процесс не падает. */
  onHandlerError?: (err: unknown, where: string) => boolean;
}

export class GatewayConnection {
  private static seq = 0;
  readonly id = ++GatewayConnection.seq;

  /** Кто на том конце: после `hello role cli` — CLI (аренду не берёт, может просить повтор отложенного). */
  role: 'adapter' | 'cli' | null = null;

  constructor(private readonly sock: net.Socket) {}

  get alive(): boolean {
    return !this.sock.destroyed && !this.sock.writableEnded;
  }

  /** Кадр переходнику; maxBytes — предел кадра (по умолчанию 1 МБ; ответ на media — MAX_MEDIA_FRAME_BYTES, 0.3). */
  send(message: object, maxBytes?: number): void {
    if (this.sock.destroyed || this.sock.writableEnded) return;
    this.sock.write(encodeFrame(message, maxBytes));
  }

  close(): void {
    this.sock.end();
  }

  /** Оборвать: переходник не отвечает на ping — ждать, пока он дочитает, незачем. */
  destroy(): void {
    this.sock.destroy();
  }
}

export class GatewaySocketServer {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    private readonly socketPath: string,
    private readonly journal: Journal,
    private handlers: SocketHandlers = {},
  ) {}

  setHandlers(handlers: SocketHandlers): void {
    this.handlers = handlers;
  }

  /** Удалить старый файл сокета и слушать заново. */
  async listen(): Promise<void> {
    fs.rmSync(this.socketPath, { force: true });
    const server = net.createServer((sock) => this.accept(sock));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    fs.chmodSync(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(sock: net.Socket): void {
    this.sockets.add(sock);
    const conn = new GatewayConnection(sock);
    const decoder = new FrameDecoder();
    sock.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind === 'oversize') {
          this.journal.write('socket_bad_frame', { conn: conn.id, reason: 'oversize', bytes: frame.bytes });
          conn.send({ type: 'error', req_id: null, code: 'bad_request', text: 'кадр длиннее 1 МБ' });
          continue;
        }
        const r = parseAdapterLine(frame.line);
        if (!r.ok) {
          this.journal.write('socket_bad_frame', { conn: conn.id, reason: r.text });
          conn.send({ type: 'error', req_id: r.req_id, code: r.code, text: r.text });
          continue;
        }
        const msg = r.message;
        try {
          this.dispatch(msg, conn);
        } catch (err) {
          if (!this.handlers.onHandlerError?.(err, `socket:${msg.type}`)) throw err;
          conn.send({ type: 'error', req_id: 'req_id' in msg ? msg.req_id : null, code: 'unavailable', text: 'диск полон — повтори позже' });
        }
      }
    });
    sock.on('error', () => undefined);
    sock.on('close', () => {
      this.sockets.delete(sock);
      try {
        this.handlers.onClose?.(conn);
      } catch (err) {
        if (!this.handlers.onHandlerError?.(err, 'socket:close')) throw err;
      }
    });
  }

  private dispatch(msg: AdapterMessage, conn: GatewayConnection): void {
    if (msg.type === 'ping') {
      conn.send({ type: 'pong' });
      return;
    }
    if (msg.type === 'pong') {
      this.handlers.onPong?.(conn);
      return;
    }
    if (this.handlers.onMessage?.(msg, conn)) return;
    conn.send({
      type: 'error',
      req_id: 'req_id' in msg ? msg.req_id : null,
      code: 'unavailable',
      text: `«${msg.type}» не обслуживается`,
    });
  }
}
