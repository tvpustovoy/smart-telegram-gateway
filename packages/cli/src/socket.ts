// CLI ⇄ шлюз через gateway.sock (TECH-SPEC 5, 5.10): ping — «шлюз запущен»; hello с role cli (аренда не берётся) и
// запросы: where («где мы») и deferred_retry (повтор отложенного — пишет в базу только шлюз).

import net from 'node:net';
import { FrameDecoder, PROTOCOL_VERSION, encodeFrame, type WhereData } from 'stg-core';

export function pingSocket(socketPath: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    const sock = net.connect(socketPath);
    const finish = (alive: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write('{"type":"ping"}\n'));
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.includes('"pong"')) finish(true);
    });
    sock.on('error', () => finish(false));
    sock.on('close', () => finish(false));
  });
}

interface Reply {
  type?: string;
  req_id?: string | null;
  text?: unknown;
  data?: unknown;
  result?: unknown;
  code?: unknown;
}

export type CliAsk = { ok: true; reply: Reply } | { ok: false; reason: 'no_gateway' | 'timeout' | 'closed' };

/** hello role cli → запрос → ответ с тем же req_id (ack, error, where_result). */
export function askGateway(socketPath: string, type: string, fields: Record<string, unknown>, timeoutMs = 3000): Promise<CliAsk> {
  return new Promise((resolve) => {
    let done = false;
    let connected = false;
    const decoder = new FrameDecoder();
    const sock = net.connect(socketPath);
    const finish = (r: CliAsk): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    sock.on('connect', () => {
      connected = true;
      sock.write(encodeFrame({ type: 'hello', req_id: 'cli-hello', adapter: 'stg-cli', version: PROTOCOL_VERSION, role: 'cli' }));
    });
    sock.on('data', (chunk: Buffer) => {
      for (const f of decoder.push(chunk)) {
        if (f.kind !== 'line') continue;
        let m: Reply;
        try {
          m = JSON.parse(f.line) as Reply;
        } catch {
          continue;
        }
        if (m.type === 'ack' && m.req_id === 'cli-hello') sock.write(encodeFrame({ type, req_id: 'cli-req', ...fields }));
        else if (m.req_id === 'cli-req') finish({ ok: true, reply: m });
        else if (m.type === 'error' && m.req_id === 'cli-hello') finish({ ok: true, reply: m });
      }
    });
    sock.on('error', () => finish({ ok: false, reason: connected ? 'closed' : 'no_gateway' }));
    sock.on('close', () => finish({ ok: false, reason: connected ? 'closed' : 'no_gateway' }));
  });
}

/** «Где мы» у живого шлюза: текст и поля. null — шлюз не ответил. */
export async function askWhereFull(socketPath: string, timeoutMs = 3000): Promise<{ text: string; data: WhereData | null } | null> {
  const r = await askGateway(socketPath, 'where', {}, timeoutMs);
  if (!r.ok || r.reply.type !== 'where_result' || typeof r.reply.text !== 'string') return null;
  return { text: r.reply.text, data: (r.reply.data as WhereData | undefined) ?? null };
}

/** «Где мы» у живого шлюза — словами. null — шлюз не ответил. */
export async function askWhere(socketPath: string, timeoutMs = 3000): Promise<string | null> {
  return (await askWhereFull(socketPath, timeoutMs))?.text ?? null;
}
