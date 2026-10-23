// M13 · ход агента идёт — `working` (#55; TECH-SPEC 5.5, 5.10) на поддельном переходнике, шлюз — на поддельных часах.
// Живая проверка адаптера Codex: агент сразу ответил промежуточно и работал дальше в том же ходе — ответ снял
// «печатает…», в закреплённой строке было 🟢, владелец не понял, думает агент или завис. Теперь переходник, который видит
// начало и конец хода, говорит шлюзу working {on: true, seqs}:
// - «печатает…» держится в чате и после промежуточного ответа, и дольше 2 минут; в строке — 🟡; working off — тишина, 🟢;
// - переходник замолчал (ход завис, переходник сломался) — без нового working 15 минут шлюз снимает сам (working_expired);
//   повтор working продлевает срок;
// - «стоп» снимает сразу; working в «стопе» не действует; после «продолжить» — снова;
// - обрыв переходника посреди хода — снято сразу (аренда снята);
// - чужие № (не сообщение, нет такого) пропускаются; без проверки аренды — unverified.
// Переходник без working (канал Claude Code) — «печатает…» как раньше: m3-lease.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { STOPPED_TEXT, type GatewayMessage, type Update } from 'stg-core';
import type { FakeChannel } from 'stg-fake-channel';
import { connectAdapter, pump, q1, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, setup, statusLineOf, type Setup } from './m1-common.js';
import { press, waitSent } from './m2-common.js';

describe('M13 · ход агента идёт (working): «печатает…» на весь ход', () => {
  let s: Setup;
  let gw: GatewayProcess;
  const seqOf = (u: Update): Promise<number> =>
    waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
  const say = (text: string): Promise<number> => seqOf(s.fake.push(s.fake.builder.text(OWNER, text))[0]!);
  const typing = (): number => s.fake.chatActions.filter((a) => a.chat_id === OWNER.id && a.action === 'typing').length;
  /** Сдвинуть часы шлюза шагами (с паузой настоящего времени: pong и «печатает…» успевают дойти); сколько typing за это время. */
  const typedDuring = async (steps: number, step: string): Promise<number> => {
    const n = typing();
    for (let i = 0; i < steps; i++) {
      await gw.advance(step);
      await sleep(20);
    }
    await sleep(250);
    return typing() - n;
  };
  const waitStatus = (pred: (text: string) => boolean, what: string): Promise<string> =>
    pump(gw, () => {
      const st = statusLineOf(s.fake);
      return st && pred(st.text) ? st.text : null;
    }, { what });
  const ackOf = (m: GatewayMessage): { chats: number; seqs: number[] } => {
    assert.ok(m.type === 'ack', JSON.stringify(m));
    return m.result as { chats: number; seqs: number[] };
  };
  const workingLines = (): Array<Record<string, unknown>> => readJournal(s.home).filter((l) => l.ev === 'working');
  const releases = (): number => readJournal(s.home).filter((l) => l.ev === 'lease_released').length;
  /** Закрыть соединение переходника и дождаться снятия аренды: следующий hello не получит busy. */
  const closeLease = async (ch: FakeChannel, how: 'close' | 'destroy' = 'close'): Promise<void> => {
    const n = releases();
    if (how === 'close') ch.close();
    else ch.destroy();
    await waitUntil(() => releases() > n || null, 5000, 'снятия аренды');
  };

  before(async () => {
    s = await setup();
    gw = await s.start();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('промежуточный ответ, а ход идёт: «печатает…» дальше и дольше 2 минут, в строке 🟡; working off — тишина и 🟢', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const a = await say('что у нас записано про отпуск?');
      await ch.waitEvent(a);
      await ch.delivered(a);
      assert.deepEqual(ackOf(await ch.working(true, [a])), { chats: 1, seqs: [a] });
      assert.equal((await ch.reply(a, 'Посмотрю записи и дам пример', turn)).type, 'ack');
      await waitSent(s, gw, (m) => m.text === 'Посмотрю записи и дам пример', 'промежуточного ответа');
      // Ответ снял событие, а ход — нет: 160 с (больше 2 минут на событие) — «печатает…» каждые 4 с.
      const sent = await typedDuring(40, '4s');
      assert.ok(sent >= 35, `typing за 160 с хода: ${sent}`);
      await waitStatus((t) => /\n🟡($| · )/u.test(t), '🟡 — ход идёт');
      assert.ok(workingLines().some((l) => l.on === true && JSON.stringify(l.seqs) === JSON.stringify([a]) && l.chats === 1), 'working в журнале');
      // Ход кончился.
      assert.deepEqual(ackOf(await ch.working(false)), { chats: 0, seqs: [] });
      assert.equal(await typedDuring(5, '4s'), 0, 'после конца хода — тишина');
      await waitStatus((t) => /\n🟢($| · )/u.test(t), '🟢 — ход кончился');
      assert.ok(workingLines().some((l) => l.on === false));
    } finally {
      await closeLease(ch);
    }
  });

  it('переходник замолчал: без нового working 15 минут — «печатает…» снят сам (working_expired); повтор working продлевает срок', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const b = await say('собери пример');
      await ch.waitEvent(b);
      await ch.delivered(b);
      ackOf(await ch.working(true, [b]));
      await ch.reply(b, 'Собираю', turn);
      await typedDuring(10, '60s');
      // 10 минут: повтор — срок снова 15 минут от него.
      assert.deepEqual(ackOf(await ch.working(true, [b])), { chats: 1, seqs: [b] });
      await typedDuring(9, '60s');
      assert.ok((await typedDuring(1, '60s')) >= 10, 'на 20-й минуте (5 минут сверх первого срока) — ещё «печатает…»');
      assert.ok(!readJournal(s.home).some((l) => l.ev === 'working_expired'));
      await typedDuring(6, '60s');
      await waitUntil(() => readJournal(s.home).find((l) => l.ev === 'working_expired' && l.chat_id === OWNER.id), 5000, 'working_expired');
      assert.equal(await typedDuring(5, '4s'), 0, 'срок вышел — тишина');
      await waitStatus((t) => /\n🟢($| · )/u.test(t), '🟢 — срок вышел');
      assert.equal(ch.isClosed, false, 'аренда жива: снял предел, а не обрыв');
    } finally {
      await closeLease(ch);
    }
  });

  it('«стоп» снимает сразу; working в «стопе» не действует; после «продолжить» — снова', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const c = await say('проверь календарь');
      await ch.waitEvent(c);
      await ch.delivered(c);
      ackOf(await ch.working(true, [c]));
      await ch.reply(c, 'Смотрю календарь', turn);
      assert.ok((await typedDuring(3, '4s')) >= 2);
      s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
      const stopLine = await waitSent(s, gw, (m) => m.text === STOPPED_TEXT, 'строки «остановлен»');
      await ch.waitMode('stopped');
      assert.equal(await typedDuring(5, '4s'), 0, '«стоп» — тишина');
      assert.deepEqual(ackOf(await ch.working(true, [c])), { chats: 0, seqs: [] }, 'в «стопе» working не действует');
      assert.equal(await typedDuring(3, '4s'), 0);
      assert.ok(workingLines().some((l) => l.on === true && l.stopped === true));
      assert.equal(await press(s, stopLine, 'продолжить'), null);
      await ch.waitMode('running');
      assert.deepEqual(ackOf(await ch.working(true, [c])), { chats: 1, seqs: [c] });
      assert.ok((await typedDuring(3, '4s')) >= 2, 'после «продолжить» — снова');
      ackOf(await ch.working(false));
    } finally {
      await closeLease(ch);
    }
  });

  it('обрыв переходника посреди хода — «печатает…» снят сразу (аренда снята)', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    const d = await say('и ещё одно');
    await ch.waitEvent(d);
    await ch.delivered(d);
    ackOf(await ch.working(true, [d]));
    await ch.reply(d, 'Сейчас', turn);
    assert.ok((await typedDuring(3, '4s')) >= 2);
    await closeLease(ch, 'destroy');
    assert.equal(await typedDuring(5, '4s'), 0, 'обрыв — тишина');
  });

  it('чужие № — не сообщение (проба), нет такого — пропускаются; без проверки аренды — unverified', async () => {
    const { ch } = await connectAdapter(s.home);
    try {
      const probe = ch.probes().at(-1)!.seq;
      assert.deepEqual(ackOf(await ch.working(true, [probe, 999_999])), { chats: 0, seqs: [] });
      assert.equal(await typedDuring(3, '4s'), 0);
    } finally {
      await closeLease(ch);
    }
    const { ch: raw } = await connectAdapter(s.home, { autoProbeDone: false });
    try {
      const r = await raw.working(true, [1]);
      assert.ok(r.type === 'error' && r.code === 'unverified', JSON.stringify(r));
    } finally {
      await closeLease(raw);
    }
  });
});
