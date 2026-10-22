// M3 · аренда на поддельном переходнике (TECH-SPEC 5.10; Оч-3, Оч-6, К-2, К-3, К-9), шлюз — на поддельных часах:
// A3.2 три ждущих — по порядку после пробы · проба: до done ничего не отдаётся, новый hello вытесняет предварительную
// аренду, 120 с без done — unverified (A3.16 на подделке) · A3.4 busy при проверенной · A3.5 done чужого — not_your_lease ·
// A3.13 молчание на ping — аренда снята ≤ 60 с · скачок часов — аренда жива · A3.19 плохие кадры — bad_request, сокет и
// аренда живы, эпизод прежний · «печатает…» — от delivered до ответа, не дольше 2 минут.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CHANNEL_UNVERIFIED_HINT, MAX_FRAME_BYTES, type Update } from 'stg-core';
import { FakeChannel } from 'stg-fake-channel';
import { connectAdapter, count, meta, pump, q1, runCli, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, botTexts, setup, type Setup } from './m1-common.js';

function helpers(s: () => Setup) {
  const seqOf = (u: Update): number | undefined => q1<{ seq: number }>(s().home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
  return {
    send: async (text: string): Promise<number> => {
      const u = s().fake.builder.text(OWNER, text);
      s().fake.push(u);
      return waitUntil(() => seqOf(u), 5000, `приёма «${text}»`);
    },
    status: (seq: number): string | undefined => q1<{ status: string }>(s().home, 'SELECT status FROM events WHERE seq = ?', seq)?.status,
  };
}

/** Сдвинуть часы шлюза на `total` шагами по 15 с с паузой настоящего времени (сроки аренды — не раньше 1 с настоящего). */
async function advanceSlow(gw: GatewayProcess, seconds: number, realMs = 1100): Promise<void> {
  await gw.advance(`${seconds}s`);
  await sleep(realMs);
  await gw.advance('15s');
}

describe('M3 · аренда и проба на поддельном переходнике', () => {
  let s: Setup;
  let gw: GatewayProcess;
  const h = helpers(() => s);
  before(async () => {
    s = await setup();
    gw = await s.start();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('A3.2 и проба: три ждущих; до done на probe — ничего; после — все три по порядку', async () => {
    const waiting = [await h.send('один'), await h.send('два'), await h.send('три')];
    const { ch } = await connectAdapter(s.home, { autoProbeDone: false });
    try {
      const probe = await waitUntil(() => ch.probes()[0], 5000, 'пробы');
      assert.equal(probe.trust, null);
      assert.equal(probe.redelivery, false);
      await sleep(200);
      assert.equal(ch.events().length, 0, 'до done на probe событий нет');
      // До проверки: reply и episode — unverified; done чужого № — unverified; where — можно.
      const r = await ch.reply(waiting[0]!, 'рано', 0);
      assert.ok(r.type === 'error' && r.code === 'unverified', JSON.stringify(r));
      // В отказе нет ни номера пробы, ни кода: сессия без канала не пройдёт проверку, повторив за отказом (К-2).
      assert.ok(!r.text.includes(String(probe.seq)) && !r.text.includes(probe.code!), r.text);
      assert.match(probe.code ?? '', /^[0-9a-f]{8}$/);
      const d = await ch.done([waiting[0]!]);
      assert.ok(d.type === 'error' && (d.code === 'not_your_lease' || d.code === 'unverified'), JSON.stringify(d));
      assert.equal((await ch.where()).type, 'where_result');
      // done на № пробы без кода и с чужим кодом — не проверка.
      for (const code of [undefined, '00000000']) {
        const bad = await ch.done([probe.seq], code);
        assert.ok(bad.type === 'error' && bad.code === 'unverified' && !bad.text.includes(String(probe.seq)), JSON.stringify(bad));
      }
      await sleep(100);
      assert.equal(ch.events().length, 0, 'без кода аренда не проверена');
      assert.equal(h.status(probe.seq), 'delivered');
      const rp = await ch.done([probe.seq], probe.code);
      assert.equal(rp.type, 'ack');
      await waitUntil(() => ch.events().length === 3 || null, 5000, 'трёх событий');
      assert.deepEqual(ch.events().map((e) => e.seq), waiting);
      assert.equal(h.status(probe.seq), 'processed');
      assert.ok(gw.journal().some((l) => l.ev === 'lease_verified'));
      const again = await ch.reply(probe.seq, 'привет', 0);
      assert.ok(again.type === 'error' && again.code === 'bad_request', JSON.stringify(again));
      await ch.done(waiting);
    } finally {
      ch.close();
    }
    await gw.waitForJournal((l) => l.ev === 'lease_released');
  });

  it('новый hello вытесняет предварительную аренду; проверенную — нет (A3.4: busy, второй ничего не отдаётся)', async () => {
    const sq = await h.send('кому достанется');
    const { ch: a } = await connectAdapter(s.home, { autoProbeDone: false });
    await waitUntil(() => a.probes()[0], 5000, 'пробы у первой');
    const { ch: b } = await connectAdapter(s.home);
    try {
      const e = await waitUntil(() => a.unsolicitedErrors()[0], 5000, 'вытеснения');
      assert.equal(e.code, 'busy');
      await waitUntil(() => a.isClosed || null, 5000, 'закрытия первой');
      assert.equal(a.events().length, 0);
      await b.waitEvent(sq);
      // Проверенную аренду не вытеснить: третьей — busy {holder, since}, сокет закрыт, ей ничего не отдаётся.
      const c = await FakeChannel.connect(s.home.paths.socket);
      const w = await c.hello();
      assert.ok(w.type === 'error' && w.code === 'busy' && w.holder === 'fake-channel' && typeof w.since === 'number', JSON.stringify(w));
      await waitUntil(() => c.isClosed || null, 5000, 'закрытия третьей');
      assert.equal(c.events().length + c.probes().length, 0);
      // A3.5: done на событие, отданное другой аренде, — not_your_lease; статус не меняется.
      const before = h.status(sq);
      const c2 = await FakeChannel.connect(s.home.paths.socket);
      const dn = await c2.done([sq]);
      assert.ok(dn.type === 'error' && dn.code === 'not_your_lease', JSON.stringify(dn));
      c2.close();
      assert.equal(h.status(sq), before);
      await b.done([sq]);
    } finally {
      b.close();
    }
    await gw.waitForJournal((l) => l.ev === 'lease_released' && l.reason === 'closed');
  });

  it('A3.16 на подделке: 120 с без done на probe — error unverified, сокет закрыт; «статус» и stg status — «сессия открыта без канала»', async () => {
    const sq = await h.send('ждёт агента');
    const { ch } = await connectAdapter(s.home, { autoProbeDone: false });
    await waitUntil(() => ch.probes()[0], 5000, 'пробы');
    await advanceSlow(gw, 90);
    assert.equal(ch.isClosed, false, 'раньше 120 с — не снята');
    await advanceSlow(gw, 15);
    const e = await waitUntil(() => ch.unsolicitedErrors().find((x) => x.code === 'unverified'), 5000, 'unverified');
    assert.match(e.text, /перезапусти start\.sh/);
    await waitUntil(() => ch.isClosed || null, 5000, 'закрытия');
    assert.equal(h.status(sq), 'new', 'ничего не delivered');
    assert.equal(ch.events().length, 0);
    assert.ok(meta(s.home, 'channel_unverified'));
    const st = await runCli(['status'], s.env);
    assert.ok(st.stdout.includes(`переходник: не на связи — ${CHANNEL_UNVERIFIED_HINT}`), st.stdout);
    s.fake.push(s.fake.builder.text(OWNER, 'статус'));
    await pump(gw, () => botTexts(s.fake).find((t) => t.startsWith('⚙ Статус') && t.includes(CHANNEL_UNVERIFIED_HINT)), { what: 'строки «статус»' });
    // Сессия с флагом: проверка проходит, отметка снята, событие отдано.
    const { ch: ok } = await connectAdapter(s.home);
    try {
      await ok.waitEvent(sq);
      assert.equal(meta(s.home, 'channel_unverified'), null);
      await ok.done([sq]);
    } finally {
      ok.close();
    }
  });

  it('A3.13 на подделке: переходник молчит на ping — аренда снята ≤ 60 с, отданное — снова new; следующий получает аренду', async () => {
    const sq = await h.send('зависнет');
    const { ch } = await connectAdapter(s.home, { autoPong: false });
    await ch.waitEvent(sq);
    await ch.delivered(sq);
    assert.equal(h.status(sq), 'delivered');
    const t0 = await gw.advance('0s');
    let lost: { at: string } | undefined;
    for (let i = 0; i < 6 && !lost; i++) {
      await gw.advance('15s');
      await sleep(600);
      lost = gw.journal().find((l) => l.ev === 'lease_lost' && l.reason === 'no_pong') as { at: string } | undefined;
    }
    assert.ok(lost, 'аренда не снята');
    assert.ok(Date.parse(lost.at) - t0 <= 60_000, `снята через ${(Date.parse(lost.at) - t0) / 1000} с`);
    await waitUntil(() => ch.isClosed || null, 5000, 'обрыва');
    assert.equal(h.status(sq), 'new');
    const { ch: next } = await connectAdapter(s.home);
    try {
      const ev = await next.waitEvent(sq);
      assert.equal(ev.redelivery, true);
      await next.done([sq]);
    } finally {
      next.close();
    }
  });

  it('скачок часов (сон): аренда не снимается — ожидание pong начинается заново', async () => {
    const lostBefore = gw.journal().filter((l) => l.ev === 'lease_lost').length;
    const { ch } = await connectAdapter(s.home);
    try {
      await gw.advance('15s');
      await gw.jump('2h');
      await gw.waitForJournal((l) => l.ev === 'lease_wake');
      await sleep(1100);
      await gw.advance('15s');
      await sleep(200);
      await gw.advance('15s');
      await sleep(200);
      assert.equal(ch.isClosed, false);
      assert.equal(gw.journal().filter((l) => l.ev === 'lease_lost').length, lostBefore, 'аренда не снята');
      const w = await ch.where();
      assert.ok(w.type === 'where_result' && w.data?.agent_online === true, JSON.stringify(w));
    } finally {
      ch.close();
    }
  });
});

describe('M3 · A3.19 протокол: плохие кадры при живой аренде; «печатает…»', () => {
  let s: Setup;
  let gw: GatewayProcess;
  const h = helpers(() => s);
  before(async () => {
    s = await setup();
    gw = await s.start();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('кадр больше 1 МБ, неизвестный type, role в episode — bad_request; сокет и аренда живы; эпизод прежний', async () => {
    await h.send('открыть эпизод');
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const ep = q1<{ id: number; topic: string; role: string }>(s.home, 'SELECT id, topic, role FROM episodes WHERE closed_at IS NULL')!;
      ch.sendRaw(Buffer.from(`{"type":"reply","req_id":"big","seq":null,"turn":${turn},"text":"${'я'.repeat(MAX_FRAME_BYTES / 2 + 10)}"}\n`));
      const big = await ch.waitFor((r) => r.message?.type === 'error' && /1 МБ/.test(r.message.text));
      assert.equal(big.message?.type === 'error' && big.message.code, 'bad_request');
      const unk = await ch.request('teleport', { where: 'Марс' });
      assert.ok(unk.type === 'error' && unk.code === 'bad_request' && /неизвестный type/.test(unk.text), JSON.stringify(unk));
      const role = await ch.request('episode', { action: 'new', topic: 'Юрист', role: 'юрист' });
      assert.ok(role.type === 'error' && role.code === 'bad_request' && /role/.test(role.text), JSON.stringify(role));
      assert.deepEqual({ ...q1<object>(s.home, 'SELECT id, topic, role FROM episodes WHERE closed_at IS NULL') }, { ...ep }, 'эпизод прежний');
      assert.equal(ch.isClosed, false);
      ch.send({ type: 'ping' });
      await ch.waitFor((r) => r.message?.type === 'pong');
      const w = await ch.where();
      assert.ok(w.type === 'where_result' && w.data?.agent_online === true, 'аренда жива');
      assert.equal(count(s.home, "SELECT count(*) AS n FROM outbox WHERE origin = 'agent'"), 0, 'большой reply не принят');
    } finally {
      ch.close();
    }
  });

  it('«печатает…»: от delivered каждые 4 с; ответ — перестаёт; без ответа — не дольше 2 минут', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const a = await h.send('ответишь?');
      await ch.waitEvent(a);
      const n0 = s.fake.chatActions.length;
      await ch.delivered(a);
      await waitUntil(() => s.fake.chatActions.length > n0 || null, 5000, 'первого typing');
      for (let i = 0; i < 3; i++) await gw.advance('4s');
      await waitUntil(() => s.fake.chatActions.length >= n0 + 4 || null, 5000, 'повторов typing');
      assert.ok(s.fake.chatActions.slice(n0).every((x) => x.chat_id === OWNER.id && x.action === 'typing'));
      await ch.reply(a, 'да', turn);
      const n1 = s.fake.chatActions.length;
      for (let i = 0; i < 5; i++) await gw.advance('4s');
      await sleep(200);
      assert.equal(s.fake.chatActions.length, n1, 'после ответа — тишина');
      // Без ответа: не дольше 2 минут.
      const b = await h.send('а это?');
      await ch.waitEvent(b);
      const n2 = s.fake.chatActions.length;
      await ch.delivered(b);
      for (let i = 0; i < 40; i++) await gw.advance('4s');
      await sleep(300);
      const sent = s.fake.chatActions.length - n2;
      assert.ok(sent >= 25 && sent <= 32, `typing за 2 минуты: ${sent}`);
      const n3 = s.fake.chatActions.length;
      for (let i = 0; i < 5; i++) await gw.advance('4s');
      await sleep(200);
      assert.equal(s.fake.chatActions.length, n3, 'после 2 минут — тишина');
      await ch.done([b]);
    } finally {
      ch.close();
    }
  });
});
