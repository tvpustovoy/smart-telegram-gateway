// Связь stg-link — модульно: настоящий PeerLink против подставного сокета шлюза и подставной сети. Проверяется то, что
// нельзя потерять: письмо не читается без ack шлюза, повтор не даёт второго письма, сбой сети доходит до шлюза.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { FrameDecoder, MAX_REPLY_TEXT, encodeFrame } from 'stg-core';
import { PeerLink, letterText } from './link.js';
import { loadPort, type Letter, type NetworkPort, type SendVerdict } from './port.js';

const dirs: string[] = [];
after(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

class FakeNetwork implements NetworkPort {
  inbox: Letter[] = [];
  read: string[] = [];
  sent: Array<{ address: string; text: string }> = [];
  verdicts: Array<SendVerdict | Error> = [];
  hangUnread = false;
  hangSend = false;
  private ring: (() => void) | null = null;

  async unread(): Promise<Letter[]> {
    if (this.hangUnread) return new Promise(() => undefined);
    return this.inbox.filter((l) => !this.read.includes(l.wire_id));
  }

  async consume(ids: string[]): Promise<void> {
    this.read.push(...ids);
  }

  async send(address: string, text: string): Promise<SendVerdict> {
    if (this.hangSend) return new Promise(() => undefined);
    const v = this.verdicts.shift() ?? { sent: true as const, wire_id: `wire-${this.sent.length + 1}` };
    if (v instanceof Error) throw v;
    this.sent.push({ address, text });
    return v;
  }

  async *wakes(signal: AbortSignal): AsyncIterable<void> {
    while (!signal.aborted) {
      await new Promise<void>((resolve) => {
        this.ring = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (!signal.aborted) yield;
    }
  }

  async close(): Promise<void> {}

  letter(wire_id: string, text = 'текст'): void {
    this.inbox.push({ wire_id, from: 'ADDR', kind: 'text', text, reply_to: null });
    this.ring?.();
  }
}

/** Подставной шлюз: ack на всё, кроме того, что тест велел не подтверждать. */
class FakeGateway {
  frames: Array<Record<string, any>> = [];
  sock: net.Socket | null = null;
  refuse = false;
  badRequest: string | null = null;
  unavailable = 0;
  private constructor(private readonly server: net.Server) {}

  static async start(file: string): Promise<FakeGateway> {
    const g: FakeGateway = new FakeGateway(net.createServer((s) => g.accept(s)));
    await new Promise<void>((r) => g.server.listen(file, r));
    return g;
  }

  private accept(sock: net.Socket): void {
    this.sock = sock;
    const decoder = new FrameDecoder();
    sock.on('error', () => undefined);
    sock.on('data', (chunk: Buffer) => {
      for (const f of decoder.push(chunk)) {
        if (f.kind !== 'line') continue;
        const m = JSON.parse(f.line) as Record<string, any>;
        this.frames.push(m);
        if (this.refuse && m.type === 'peer_in') sock.write(encodeFrame({ type: 'error', req_id: m.req_id, code: 'unavailable', text: 'нет' }));
        else if (this.badRequest !== null && m.text === this.badRequest) sock.write(encodeFrame({ type: 'error', req_id: m.req_id, code: 'bad_request', text: 'нет' }));
        else if (this.unavailable > 0 && m.type === 'peer_sent') {
          this.unavailable--;
          sock.write(encodeFrame({ type: 'error', req_id: m.req_id, code: 'unavailable', text: 'диск полон' }));
        }
        else sock.write(encodeFrame({ type: 'ack', req_id: m.req_id, result: 'ok' }));
      }
    });
  }

  of(type: string): Array<Record<string, any>> {
    return this.frames.filter((f) => f.type === type);
  }

  push(frame: object): void {
    this.sock!.write(encodeFrame(frame));
  }

  async stop(): Promise<void> {
    this.sock?.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

async function until(fn: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function rig(timing = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stg-link-')));
  dirs.push(dir);
  const file = path.join(dir, 's');
  const gw = await FakeGateway.start(file);
  const network = new FakeNetwork();
  const stop = new AbortController();
  const logs: string[] = [];
  const running = new PeerLink({ socketPath: file, port: network, log: (l) => logs.push(l), timing: { reconnect_ms: 10, poll_ms: 20, retry_ms: 1, attempts: 2, ...timing } }).run(stop.signal);
  await until(() => gw.of('hello').length > 0, 'hello');
  return {
    gw,
    network: network,
    logs,
    async close() {
      stop.abort();
      await running;
      await gw.stop();
    },
  };
}

describe('stg-link: входящие', () => {
  it('hello с ролью peer_link', async () => {
    const r = await rig();
    assert.equal(r.gw.of('hello')[0]?.role, 'peer_link');
    await r.close();
  });

  it('письмо читается после ack шлюза; будит поток уведомлений', async () => {
    const r = await rig({ poll_ms: 60_000 });
    await new Promise((res) => setTimeout(res, 20));
    r.network.letter('w1', 'ответ');
    await until(() => r.network.read.includes('w1'), 'прочтения');
    assert.deepEqual(r.gw.of('peer_in').map((f) => [f.address, f.wire_id, f.text]), [['ADDR', 'w1', 'ответ']]);
    await r.close();
  });

  it('шлюз не принял: письмо остаётся непрочитанным и приходит снова', async () => {
    const r = await rig();
    r.gw.refuse = true;
    r.network.letter('w1');
    await until(() => r.gw.of('peer_in').length >= 2, 'повтора');
    assert.deepEqual(r.network.read, []);
    r.gw.refuse = false;
    await until(() => r.network.read.includes('w1'), 'прочтения');
    await r.close();
  });

  it('письмо, которое шлюз не примет никогда, не держит ящик; слишком длинный reply_to отбрасывается', async () => {
    const r = await rig();
    r.gw.badRequest = 'плохое';
    r.network.inbox.push({ wire_id: 'bad', from: 'ADDR', kind: 'text', text: 'плохое', reply_to: null });
    r.network.inbox.push({ wire_id: 'good', from: 'ADDR', kind: 'text', text: 'хорошее', reply_to: 'x'.repeat(300) });
    await until(() => r.network.read.includes('good') && r.network.read.includes('bad'), 'обоих снятых писем');
    assert.equal(r.gw.of('peer_in').find((f) => f.wire_id === 'good')?.reply_to, undefined);
    await r.close();
  });

  it('зависшая сеть не останавливает приём навсегда', async () => {
    const r = await rig({ network_ms: 20 });
    r.network.hangUnread = true;
    await new Promise((res) => setTimeout(res, 60));
    r.network.hangUnread = false;
    r.network.letter('w1');
    await until(() => r.network.read.includes('w1'), 'прочтения после зависания');
    await r.close();
  });

  it('опрос подбирает письмо, о котором поток не сообщил', async () => {
    const r = await rig();
    r.network.inbox.push({ wire_id: 'w9', from: 'ADDR', kind: 'text', text: 'тихо', reply_to: null });
    await until(() => r.network.read.includes('w9'), 'прочтения');
    await r.close();
  });
});

describe('stg-link: исходящие', () => {
  const send = { type: 'peer_send', id: 7, address: 'ADDR', text: 'слово' };

  it('ушло: peer_sent с wire_id', async () => {
    const r = await rig();
    r.gw.push(send);
    await until(() => r.gw.of('peer_sent').length === 1, 'peer_sent');
    assert.deepEqual(r.network.sent, [{ address: 'ADDR', text: 'слово' }]);
    assert.equal(r.gw.of('peer_sent')[0]?.wire_id, 'wire-1');
    await r.close();
  });

  it('повтор peer_send того же id второго письма не даёт', async () => {
    const r = await rig();
    r.gw.push(send);
    r.gw.push(send);
    await until(() => r.gw.of('peer_sent').length === 2, 'двух peer_sent');
    assert.equal(r.network.sent.length, 1);
    await r.close();
  });

  it('отказ сети: peer_failed сразу, без попыток', async () => {
    const r = await rig();
    r.network.verdicts = [{ sent: false, reason: 'сеть не приняла письмо: refused' }];
    r.gw.push(send);
    await until(() => r.gw.of('peer_failed').length === 1, 'peer_failed');
    assert.equal(r.gw.of('peer_failed')[0]?.reason, 'сеть не приняла письмо: refused');
    await r.close();
  });

  it('сбой сети: попытки, затем ушло', async () => {
    const r = await rig();
    r.network.verdicts = [new Error('нет связи')];
    r.gw.push(send);
    await until(() => r.gw.of('peer_sent').length === 1, 'peer_sent');
    assert.equal(r.gw.of('peer_failed').length, 0);
    await r.close();
  });

  it('сбой сети на всех попытках: peer_failed с причиной', async () => {
    const r = await rig();
    r.network.verdicts = [new Error('нет связи'), new Error('нет связи')];
    r.gw.push(send);
    await until(() => r.gw.of('peer_failed').length === 1, 'peer_failed');
    assert.match(r.gw.of('peer_failed')[0]?.reason, /сеть недоступна: нет связи/);
    await r.close();
  });
});

describe('stg-link: исходящие, сбои', () => {
  const send = { type: 'peer_send', id: 7, address: 'ADDR', text: 'слово' };

  it('шлюз не записал исход (диск полон): повтор, пока не запишет; письмо одно', async () => {
    const r = await rig();
    r.gw.unavailable = 2;
    r.gw.push(send);
    await until(() => r.gw.of('peer_sent').length === 3, 'трёх peer_sent');
    assert.equal(r.network.sent.length, 1);
    await r.close();
  });

  it('сеть зависла на отправке: peer_failed без повтора — письмо могло уйти', async () => {
    const r = await rig({ network_ms: 20 });
    r.network.hangSend = true;
    r.gw.push(send);
    await until(() => r.gw.of('peer_failed').length === 1, 'peer_failed');
    assert.match(r.gw.of('peer_failed')[0]?.reason, /письмо могло уйти/);
    await r.close();
  });
});

describe('модуль порта', () => {
  it('файл с openPort загружается; без него — понятный отказ', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stg-port-')));
    dirs.push(dir);
    const good = path.join(dir, 'good.mjs');
    const bad = path.join(dir, 'bad.mjs');
    fs.writeFileSync(good, 'export async function openPort(o) { return { name: o.identity }; }\n');
    fs.writeFileSync(bad, 'export const x = 1;\n');
    assert.deepEqual(await (await loadPort(good))({ identity: 'gw', home: dir }), { name: 'gw' });
    await assert.rejects(loadPort(bad), /нет функции openPort/);
  });
});

describe('текст письма', () => {
  const base: Letter = { wire_id: 'w', from: 'a', kind: 'text', text: 'привет', reply_to: null };

  it('как есть', () => assert.equal(letterText(base), 'привет'));

  it('без текста: видно, что письмо было', () => {
    assert.match(letterText({ ...base, kind: 'file', text: null }), /вид file/);
    assert.match(letterText({ ...base, text: '  ' }), /без текста/);
  });

  it('длинное обрезается в предел шлюза с пометкой', () => {
    const t = letterText({ ...base, text: 'я'.repeat(MAX_REPLY_TEXT + 10) });
    assert.ok(t.length <= MAX_REPLY_TEXT);
    assert.match(t, /обрезано шлюзом/);
  });
});
