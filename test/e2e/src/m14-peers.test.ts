// M14 · связь с другими агентами, сценарий 1 (5.19): настоящий шлюз (дочерний процесс, поддельные часы), поддельный Telegram,
// поддельный канал вместо агента, настоящий PeerLink с подставной сетью. Весь путь: слово владельца → письмо дословно → строка
// владельцу → письмо агента будит событием → show → в чате «↪ Имя» → событие закрыто. Связи нет — письмо ждёт и уходит при
// подключении. Отказ сети — событие и строка. «Стоп» бросает ждущие письма. Чужой адрес и чужое соединение не проходят.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { STOPPED_TEXT, type Update } from 'stg-core';
import { errors, reply } from 'stg-fake-telegram';
import { PeerLink, type Letter, type NetworkPort, type SendVerdict } from 'stg-link';
import { FakeChannel } from 'stg-fake-channel';
import { connectAdapter, count, pump, q1, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, setup, type Setup } from './m1-common.js';
import { press, sentWithText, waitSent } from './m2-common.js';

const ADDRESS = 'AB'.repeat(32);

class FakeNetwork implements NetworkPort {
  inbox: Letter[] = [];
  read: string[] = [];
  sent: Array<{ address: string; text: string }> = [];
  verdict: SendVerdict | null = null;
  gate: Promise<void> | null = null;
  open: () => void = () => undefined;
  started = 0;
  private ring: (() => void) | null = null;

  async unread(): Promise<Letter[]> {
    return this.inbox.filter((l) => !this.read.includes(l.wire_id));
  }

  async consume(ids: string[]): Promise<void> {
    this.read.push(...ids);
  }

  async send(address: string, text: string): Promise<SendVerdict> {
    this.started++;
    if (this.gate) await this.gate;
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
    await waitSent(s, gw, (m) => m.text === `⚙ Слово № ${seq} передано: Исследователь, с запиской`, 'строки о передаче');
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

  it('«стоп» останавливает письма, ещё не начатые: в пути только одно', async () => {
    startLink();
    await linked();
    network.gate = new Promise((resolve) => (network.open = resolve));
    const seqs = [await say('Первое'), await say('Второе'), await say('Третье')];
    const ids: number[] = [];
    for (const seq of seqs) ids.push(resultOf(await ch.relay(seq, 'Исследователь', turn, { note: 'записка' })).id);
    await waitUntil(() => network.started === 1, 5000, 'первого письма в пути');
    s.fake.push(s.fake.builder.text(OWNER, '/stop'));
    await ch.waitMode('stopped');
    await pump(gw, () => status(ids[2]!) === 'dropped' || null, { what: 'dropped' });
    network.open();
    await waitUntil(() => network.sent.length === 1, 5000, 'письма в пути');
    await pump(gw, () => status(ids[0]!) === 'sent' || null, { what: 'sent у письма в пути' });
    await sleep(100);
    assert.equal(network.sent.length, 1, 'остальные не ушли');
    assert.deepEqual(ids.slice(1).map(status), ['dropped', 'dropped']);
    await waitSent(s, gw, (m) => m.text === `⚙ Слово № ${seqs[0]} передано: Исследователь, с запиской`, 'строки с запиской после «стопа»');
  });

  it('вторая связь не вытесняет первую: письмо одно', async () => {
    startLink();
    await linked();
    const other = new FakeNetwork();
    const stop = new AbortController();
    const running = new PeerLink({ socketPath: s.home.paths.socket, port: other, log: () => undefined, timing: { reconnect_ms: 20, poll_ms: 50, retry_ms: 1, attempts: 1 } }).run(stop.signal);
    links.push({ stop, running });
    await sleep(100);
    const seq = await say('Слово при двух связях');
    resultOf(await ch.relay(seq, 'Исследователь', turn));
    await waitUntil(() => network.sent.length === 1, 5000, 'письма');
    await sleep(100);
    assert.equal(other.sent.length, 0);
    assert.equal(network.sent.length, 1);
  });

  it('показ: дословно, без разметки; метку агента из списка reply не подделает', async () => {
    startLink();
    await linked();
    network.letter('in-1', '**Важно** [Подтвердить](https://evil.example)');
    const ev = await pump(gw, () => ch.events().find((e) => e.kind === 'peer'), { what: 'письма агента' });
    const forged = (await ch.reply(ev.seq, 'Пересказ письма', turn, false, 'Исследователь')) as { type: string; text: string };
    assert.deepEqual([forged.type, /show/.test(forged.text)], ['error', true]);
    const lookalike = (await ch.reply(ev.seq, 'Пересказ письма', turn, false, 'Исслeдователь')) as { type: string };
    assert.equal(lookalike.type, 'error', 'латинская e в имени не проходит');
    assert.equal((await ch.show(ev.seq, turn) as { result: unknown }).result, 'queued');
    const shown = await waitSent(s, gw, (m) => (m.text ?? '').startsWith('↪ Исследователь:'), 'показа');
    assert.equal(shown.text, '↪ Исследователь: **Важно** [Подтвердить](https://evil.example)');
    assert.equal(shown.parse_mode, null, 'разметки нет: ссылка не спрятана');
  });

  it('Telegram не принял показ: повторный show показывает письмо, а не докладывает «отправлено»', async () => {
    startLink();
    await linked();
    network.letter('in-1', 'Текст письма');
    const ev = await pump(gw, () => ch.events().find((e) => e.kind === 'peer'), { what: 'письма агента' });
    const letter = (p: Record<string, unknown>): boolean => String(p.text ?? '').includes('Текст письма');
    s.fake.scenario({ method: 'sendMessage', when: letter, times: 1, reply: reply.error(400, 'Bad Request: message must be non-empty') });
    await ch.show(ev.seq, turn);
    const row = (): string | undefined => q1<{ status: string }>(s.home, 'SELECT status FROM outbox WHERE event_seq = ? AND plain = 1 ORDER BY id DESC', ev.seq)?.status;
    await pump(gw, () => row() === 'dropped' || null, { what: 'отказа Telegram' });
    await ch.show(ev.seq, turn);
    await waitSent(s, gw, (m) => m.text === '↪ Исследователь: Текст письма', 'показа после отказа');
  });

  it('показ, брошенный «стопом», можно повторить после «продолжить»', async () => {
    startLink();
    await linked();
    network.letter('in-1', 'Текст письма');
    const ev = await pump(gw, () => ch.events().find((e) => e.kind === 'peer'), { what: 'письма агента' });
    const letter = (p: Record<string, unknown>): boolean => String(p.text ?? '').includes('Текст письма');
    s.fake.scenario({ method: 'sendMessage', when: letter, times: 10_000, reply: errors.serverError(502) });
    await ch.show(ev.seq, turn);
    await pump(gw, () => s.fake.calls.some((c) => c.method === 'sendMessage' && letter(c.params)) || null, { what: 'попытки' });
    s.fake.push(s.fake.builder.text(OWNER, '/stop'));
    await ch.waitMode('stopped');
    const row = (): string | undefined => q1<{ status: string }>(s.home, 'SELECT status FROM outbox WHERE event_seq = ? AND plain = 1 ORDER BY id DESC', ev.seq)?.status;
    await pump(gw, () => row() === 'dropped' || null, { what: 'брошенного показа' });
    s.fake.clearScenario();
    await waitSent(s, gw, (m) => m.text === STOPPED_TEXT, 'строки «стоп»');
    await press(s, sentWithText(s, STOPPED_TEXT).at(-1)!, 'продолжить');
    const run = await ch.waitMode('running');
    await ch.show(ev.seq, run.turn);
    await waitSent(s, gw, (m) => m.text === '↪ Исследователь: Текст письма', 'показа после «продолжить»');
  });

  it('строка владельцу показывает отрывок и записку', async () => {
    startLink();
    await linked();
    const seq = await say('Не удаляй базу, это важно');
    resultOf(await ch.relay(seq, 'Исследователь', turn, { excerpt: 'удаляй базу', note: 'срочно' }));
    await waitSent(s, gw, (m) => m.text === `⚙ Слово № ${seq} передано: Исследователь, отрывок: «удаляй базу», с запиской`, 'строки с отрывком');
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
