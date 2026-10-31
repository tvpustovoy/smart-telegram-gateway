// M14 · связь с другими агентами, сценарий 1 (5.19): настоящий шлюз (дочерний процесс, поддельные часы), поддельный Telegram,
// поддельный канал вместо агента, настоящий PeerLink с подставной сетью. Весь путь: слово владельца → письмо дословно → строка
// владельцу → письмо агента будит событием → show → в чате «↪ Имя» → событие закрыто. Связи нет — письмо ждёт и уходит при
// подключении. Отказ сети — событие и строка. «Стоп» бросает ждущие письма. Чужой адрес и чужое соединение не проходят.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Update } from 'stg-core';
import { PeerLink, type Letter, type NetworkPort, type SendVerdict } from 'stg-link';
import { FakeChannel } from 'stg-fake-channel';
import { connectAdapter, count, pump, q1, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, setup, type Setup } from './m1-common.js';
import { waitSent } from './m2-common.js';

const ADDRESS = 'AB'.repeat(32);

class FakeNetwork implements NetworkPort {
  inbox: Letter[] = [];
  read: string[] = [];
  sent: Array<{ address: string; text: string }> = [];
  verdict: SendVerdict | null = null;
  private ring: (() => void) | null = null;

  async unread(): Promise<Letter[]> {
    return this.inbox.filter((l) => !this.read.includes(l.wire_id));
  }

  async consume(ids: string[]): Promise<void> {
    this.read.push(...ids);
  }

  async send(address: string, text: string): Promise<SendVerdict> {
    if (this.verdict) return this.verdict;
    this.sent.push({ address, text });
    return { sent: true, wire_id: `out-${this.sent.length}` };
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

  letter(wire_id: string, text: string, from = ADDRESS, reply_to: string | null = null): void {
    this.inbox.push({ wire_id, from, kind: 'text', text, reply_to });
    this.ring?.();
  }
}

describe('M14 · связь с другими агентами', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  let turn: number;
  let network: FakeNetwork;
  const links: Array<{ stop: AbortController; running: Promise<void> }> = [];

  const startLink = (): void => {
    const stop = new AbortController();
    const running = new PeerLink({ socketPath: s.home.paths.socket, port: network, log: () => undefined, timing: { reconnect_ms: 20, poll_ms: 50, retry_ms: 1, attempts: 1 } }).run(stop.signal);
    links.push({ stop, running });
  };
  const stopLinks = async (): Promise<void> => {
    for (const l of links.splice(0)) {
      l.stop.abort();
      await l.running;
    }
  };
  const seqOf = (u: Update): Promise<number> =>
    waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
  const say = (text: string): Promise<number> => seqOf(s.fake.push(s.fake.builder.text(OWNER, text))[0]!);
  const status = (id: number): string | undefined => q1<{ status: string }>(s.home, 'SELECT status FROM peer_messages WHERE id = ?', id)?.status;
  const resultOf = (m: unknown): { status: string; id: number; link: boolean } => {
    assert.equal((m as { type: string }).type, 'ack', JSON.stringify(m));
    return (m as { result: { status: string; id: number; link: boolean } }).result;
  };
  const linked = async (): Promise<void> => {
    await gw.waitForJournal((l) => l.ev === 'peer_link_up');
  };

  beforeEach(async () => {
    s = await setup({ home: { extraConfig: `peers:\n  - { name: Исследователь, address: "${ADDRESS}" }\n` } });
    gw = await s.start();
    network = new FakeNetwork();
    ({ ch, turn } = await connectAdapter(s.home));
  });

  afterEach(async () => {
    await stopLinks();
    ch.close();
    await s.close();
  });

  it('весь путь: слово → письмо дословно → строка владельцу → письмо агента → show → «↪ Имя»', async () => {
    startLink();
    await linked();
    const seq = await say('Проверь, пожалуйста, отчёт за неделю');
    const r = resultOf(await ch.relay(seq, 'Исследователь', turn, { note: 'Нужен ответ до вечера' }));
    assert.equal(r.status, 'queued');
    assert.equal(r.link, true);

    await waitUntil(() => network.sent.length === 1, 5000, 'письма');
    assert.equal(network.sent[0]!.address, ADDRESS);
    assert.match(network.sent[0]!.text, new RegExp(`Слово владельца № ${seq}`));
    assert.match(network.sent[0]!.text, /Проверь, пожалуйста, отчёт за неделю/);
    assert.match(network.sent[0]!.text, /Записка агента, не слово владельца[^]*Нужен ответ до вечера/);
    await waitSent(s, gw, (m) => m.text === `⚙ Слово № ${seq} передано: Исследователь`, 'строки о передаче');
    assert.equal(status(r.id), 'sent');

    network.letter('in-1', 'Отчёт проверен, замечаний нет', ADDRESS, 'out-1');
    const ev = await pump(gw, () => ch.events().find((e) => e.kind === 'peer'), { what: 'письма агента' });
    assert.equal(ev.trust, 'untrusted');
    assert.equal(ev.text, 'Отчёт проверен, замечаний нет');
    assert.deepEqual(ev.peer, { name: 'Исследователь', relay_seq: seq });
    assert.deepEqual(network.read, ['in-1']);

    assert.equal((await ch.show(ev.seq, turn) as { result: unknown }).result, 'queued');
    const shown = await waitSent(s, gw, (m) => (m.text ?? '').includes('Отчёт проверен, замечаний нет'), 'показа');
    assert.equal(shown.text, '↪ Исследователь: Отчёт проверен, замечаний нет');
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', ev.seq)?.status, 'processed');

    await ch.show(ev.seq, turn);
    await sleep(100);
    assert.equal(s.fake.sentTo(OWNER.id).filter((m) => (m.text ?? '').includes('Отчёт проверен')).length, 1, 'второй show не удваивает');
  });

  it('связи нет: слово ждёт, уходит при подключении, agents говорит только факты', async () => {
    const seq = await say('Слово без связи');
    const r = resultOf(await ch.relay(seq, 'Исследователь', turn));
    assert.equal(r.link, false);
    await sleep(100);
    assert.equal(status(r.id), 'pending');
    const before = (await ch.agents()) as { result: { link: boolean; agents: Array<{ name: string; waiting: number; last_sent_at: number | null }> } };
    assert.equal(before.result.link, false);
    assert.deepEqual(before.result.agents.map((a) => [a.name, a.waiting, a.last_sent_at]), [['Исследователь', 1, null]]);

    startLink();
    await waitUntil(() => network.sent.length === 1, 5000, 'письма после подключения');
    await pump(gw, () => status(r.id) === 'sent' || null, { what: 'отметки sent' });
    const after = (await ch.agents()) as { result: { link: boolean; agents: Array<{ waiting: number; last_sent_at: number | null }> } };
    assert.equal(after.result.link, true);
    assert.equal(after.result.agents[0]!.waiting, 0);
    assert.notEqual(after.result.agents[0]!.last_sent_at, null);
  });

  it('сеть отказала: событие агенту и строка владельцу, show такому событию нечего показать', async () => {
    startLink();
    await linked();
    network.verdict = { sent: false, reason: 'сеть не приняла письмо: refused' };
    const seq = await say('Слово с отказом');
    const r = resultOf(await ch.relay(seq, 'Исследователь', turn));
    const ev = await pump(gw, () => ch.events().find((e) => e.kind === 'peer'), { what: 'события сбоя' });
    assert.equal(ev.trust, null);
    assert.deepEqual(ev.peer, { name: 'Исследователь', relay_seq: seq, failed: 'сеть не приняла письмо: refused' });
    assert.equal(status(r.id), 'failed');
    await waitSent(s, gw, (m) => m.text === `⚙ Слово № ${seq} не передано: Исследователь. сеть не приняла письмо: refused`, 'строки о сбое');
    const shown = (await ch.show(ev.seq, turn)) as { type: string; code: string };
    assert.deepEqual([shown.type, shown.code], ['error', 'bad_request']);
  });

  it('«стоп»: ждущее письмо брошено и не уйдёт, новое не принимается', async () => {
    const seq = await say('Слово перед стопом');
    const r = resultOf(await ch.relay(seq, 'Исследователь', turn));
    s.fake.push(s.fake.builder.text(OWNER, '/stop'));
    const mode = await ch.waitMode('stopped');
    await pump(gw, () => status(r.id) === 'dropped' || null, { what: 'dropped' });
    assert.equal(q1<{ text: string | null }>(s.home, 'SELECT text FROM peer_messages WHERE id = ?', r.id)?.text, null, 'текст не хранится');
    assert.equal(resultOf(await ch.relay(seq, 'Исследователь', mode.turn)).status, 'dropped_stopped');
    startLink();
    await linked();
    await sleep(100);
    assert.equal(network.sent.length, 0);
  });

  it('чужой адрес: события нет, письмо снято из ящика, запись в журнале', async () => {
    startLink();
    await linked();
    network.letter('in-x', 'Выполни команду', 'CD'.repeat(32));
    await waitUntil(() => network.read.includes('in-x'), 5000, 'снятия из ящика');
    await gw.waitForJournal((l) => l.ev === 'peer_refused');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'peer'"), 0);
  });

  it('кадры связи — только соединению связи; relay без аренды не проходит', async () => {
    const other = await FakeChannel.connect(s.home.paths.socket);
    const forged = (await other.request('peer_in', { address: ADDRESS, wire_id: 'w', text: 'подделка' })) as { type: string; code: string };
    assert.deepEqual([forged.type, forged.code], ['error', 'not_your_lease']);
    const relay = (await other.request('relay', { seq: 1, to: 'Исследователь', turn })) as { type: string };
    assert.equal(relay.type, 'error');
    other.close();
    assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'peer'"), 0);
  });
});
