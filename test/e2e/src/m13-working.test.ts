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
// 👀 держится весь ход (#52 × #55; живая проверка: «Нарисую…» снял 👀, а агент ещё 2 минуты рисовал — в чате не было знака,
// что он работает над сообщением): ответ на событие хода 👀 не снимает (журнал out — receipt_held); снимает конец хода —
// working off, другой набор (отпущенное событие), «стоп», обрыв переходника, срок хода — журнал receipts_released; done в
// ходе — 👌 сразу, конец хода его не снимает; без working — как раньше (ответ снимает 👀, как ушёл); перезапуск шлюза
// посреди хода — 👀 снят при старте (журнал start.receipts_released).
// Действие в заголовке (working.action): upload_photo — «отправляет фото…» вместо «печатает…», сразу; без поля
// (переходник до action) — «печатает…»; ход идёт, а посылка агента грузится в чат — «отправляет файл…» (upload_document) или
// «отправляет фото…», загрузилась — снова действие хода; без хода — как раньше.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { STOPPED_TEXT, type GatewayMessage, type Update } from 'stg-core';
import type { FakeChannel } from 'stg-fake-channel';
import { reply as fakeReply } from 'stg-fake-telegram';
import { connectAdapter, makeTempDir, pump, q1, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, reactionOf, receiptCleared, setup, statusLineOf, type Setup } from './m1-common.js';
import { press, waitSent } from './m2-common.js';

describe('M13 · ход агента идёт (working): «печатает…» на весь ход', () => {
  let s: Setup;
  let gw: GatewayProcess;
  const seqOf = (u: Update): Promise<number> =>
    waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
  /** Сообщение владельца отдано агенту (delivered) — 👀 встал. */
  const seen = async (ch: FakeChannel, text: string): Promise<{ u: Update; seq: number }> => {
    const u = s.fake.push(s.fake.builder.text(OWNER, text))[0]!;
    const seq = await seqOf(u);
    await ch.waitEvent(seq);
    await ch.delivered(seq);
    await pump(gw, () => reactionOf(s.fake, u) === '👀' || null, { what: `👀 на № ${seq}` });
    return { u, seq };
  };
  /** Ответ на событие ушёл в Telegram, а 👀 держит ход: журнал out — receipt_held. */
  const heldAfterSent = async (seq: number, text: string): Promise<void> => {
    await waitSent(s, gw, (m) => m.text === text, `ответа «${text}»`);
    await waitUntil(() => readJournal(s.home).find((l) => l.ev === 'out' && (l.event_seqs as number[] | undefined)?.includes(seq) && l.receipt_held === true), 5000, 'out с receipt_held');
  };
  const waitCleared = (u: Update, what: string): Promise<true> => pump(gw, () => receiptCleared(s.fake, u) || null, { what });
  const released = (seq: number): boolean => readJournal(s.home).some((l) => l.ev === 'receipts_released' && (l.seqs as number[] | undefined)?.includes(seq));
  const acted = (action: string): number => s.fake.chatActions.filter((a) => a.chat_id === OWNER.id && a.action === action).length;
  /**
   * Сдвинуть часы шлюза шагами (с паузой настоящего времени: pong и «печатает…» успевают дойти); сколько sendChatAction
   * с этим действием (по умолчанию typing) за это время.
   */
  const typedDuring = async (steps: number, step: string, action = 'typing'): Promise<number> => {
    const n = acted(action);
    for (let i = 0; i < steps; i++) {
      await gw.advance(step);
      await sleep(20);
    }
    await sleep(250);
    return acted(action) - n;
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

  it('промежуточный ответ, а ход идёт: «печатает…» дальше и дольше 2 минут, в строке 🟡, 👀 держится (#52); working off — тишина, 🟢, 👀 снят', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const { u, seq: a } = await seen(ch, 'что у нас записано про отпуск?');
      assert.deepEqual(ackOf(await ch.working(true, [a])), { chats: 1, seqs: [a] });
      assert.equal((await ch.reply(a, 'Посмотрю записи и дам пример', turn)).type, 'ack');
      await heldAfterSent(a, 'Посмотрю записи и дам пример');
      // Ответ снял событие, а ход — нет: 160 с (больше 2 минут на событие) — «печатает…» каждые 4 с.
      const sent = await typedDuring(40, '4s');
      assert.ok(sent >= 35, `typing за 160 с хода: ${sent}`);
      await waitStatus((t) => /\n🟡($| · )/u.test(t), '🟡 — ход идёт');
      assert.ok(workingLines().some((l) => l.on === true && JSON.stringify(l.seqs) === JSON.stringify([a]) && l.chats === 1), 'working в журнале');
      assert.equal(reactionOf(s.fake, u), '👀', 'ответ промежуточный — 👀 держится весь ход');
      assert.ok(!receiptCleared(s.fake, u));
      // Ход кончился.
      assert.deepEqual(ackOf(await ch.working(false)), { chats: 0, seqs: [] });
      await waitCleared(u, '👀 снят по концу хода');
      assert.ok(released(a), 'receipts_released в журнале');
      assert.equal(await typedDuring(5, '4s'), 0, 'после конца хода — тишина');
      await waitStatus((t) => /\n🟢($| · )/u.test(t), '🟢 — ход кончился');
      assert.ok(workingLines().some((l) => l.on === false));
    } finally {
      await closeLease(ch);
    }
  });

  it('набор хода сменился: отпущенное событие — 👀 снят, остальное держится до конца хода (#52)', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const first = await seen(ch, 'нарисуй кота');
      const second = await seen(ch, 'и собаку');
      ackOf(await ch.working(true, [first.seq, second.seq]));
      await ch.reply(first.seq, 'Рисую кота', turn);
      await ch.reply(second.seq, 'Собаку тоже', turn);
      await heldAfterSent(first.seq, 'Рисую кота');
      await heldAfterSent(second.seq, 'Собаку тоже');
      assert.equal(reactionOf(s.fake, first.u), '👀');
      assert.equal(reactionOf(s.fake, second.u), '👀');
      assert.deepEqual(ackOf(await ch.working(true, [second.seq])), { chats: 1, seqs: [second.seq] });
      await waitCleared(first.u, '👀 отпущенного события снят');
      await typedDuring(3, '4s');
      assert.equal(reactionOf(s.fake, second.u), '👀', 'событие хода — 👀 держится');
      ackOf(await ch.working(false));
      await waitCleared(second.u, '👀 снят по концу хода');
    } finally {
      await closeLease(ch);
    }
  });

  it('done в ходе — 👌 сразу, конец хода его не снимает; без working (канал Claude Code) ответ снимает 👀, как ушёл — как раньше', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const d = await seen(ch, 'это просто к сведению');
      ackOf(await ch.working(true, [d.seq]));
      assert.equal((await ch.done([d.seq])).type, 'ack');
      await pump(gw, () => reactionOf(s.fake, d.u) === '👌' || null, { what: '👌 на done в ходе' });
      ackOf(await ch.working(false));
      await typedDuring(3, '4s');
      assert.equal(reactionOf(s.fake, d.u), '👌', 'конец хода 👌 не снимает');
      assert.ok(!released(d.seq));
      // Без хода — #52 как был: ответ ушёл — 👀 снят в той же записи.
      const e = await seen(ch, 'а это вопрос');
      await ch.reply(e.seq, 'Ответ сразу', turn);
      await waitCleared(e.u, '👀 снят ответом');
      const out = readJournal(s.home).find((l) => l.ev === 'out' && (l.event_seqs as number[] | undefined)?.includes(e.seq));
      assert.ok(out && out.receipt_cleared === true && out.receipt_held === undefined, JSON.stringify(out));
      assert.ok(!released(e.seq));
    } finally {
      await closeLease(ch);
    }
  });

  it('переходник замолчал: без нового working 15 минут — «печатает…» и 👀 сняты сами (working_expired); повтор working продлевает срок', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const { u, seq: b } = await seen(ch, 'собери пример');
      ackOf(await ch.working(true, [b]));
      await ch.reply(b, 'Собираю', turn);
      await heldAfterSent(b, 'Собираю');
      await typedDuring(10, '60s');
      // 10 минут: повтор — срок снова 15 минут от него.
      assert.deepEqual(ackOf(await ch.working(true, [b])), { chats: 1, seqs: [b] });
      await typedDuring(9, '60s');
      assert.ok((await typedDuring(1, '60s')) >= 10, 'на 20-й минуте (5 минут сверх первого срока) — ещё «печатает…»');
      assert.ok(!readJournal(s.home).some((l) => l.ev === 'working_expired'));
      assert.equal(reactionOf(s.fake, u), '👀', 'ход идёт — 👀 держится');
      await typedDuring(6, '60s');
      await waitUntil(() => readJournal(s.home).find((l) => l.ev === 'working_expired' && l.chat_id === OWNER.id), 5000, 'working_expired');
      await waitCleared(u, '👀 снят по сроку хода');
      assert.equal(await typedDuring(5, '4s'), 0, 'срок вышел — тишина');
      await waitStatus((t) => /\n🟢($| · )/u.test(t), '🟢 — срок вышел');
      assert.equal(ch.isClosed, false, 'аренда жива: снял предел, а не обрыв');
    } finally {
      await closeLease(ch);
    }
  });

  it('«стоп» снимает сразу — и «печатает…», и 👀 после промежуточного ответа; working в «стопе» не действует; после «продолжить» — снова', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const { u, seq: c } = await seen(ch, 'проверь календарь');
      ackOf(await ch.working(true, [c]));
      await ch.reply(c, 'Смотрю календарь', turn);
      await heldAfterSent(c, 'Смотрю календарь');
      assert.ok((await typedDuring(3, '4s')) >= 2);
      assert.equal(reactionOf(s.fake, u), '👀');
      s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
      const stopLine = await waitSent(s, gw, (m) => m.text === STOPPED_TEXT, 'строки «остановлен»');
      await ch.waitMode('stopped');
      await waitCleared(u, '👀 снят «стопом»');
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

  it('обрыв переходника посреди хода — «печатает…» и 👀 сняты сразу (аренда снята)', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    const { u, seq: d } = await seen(ch, 'и ещё одно');
    ackOf(await ch.working(true, [d]));
    await ch.reply(d, 'Сейчас', turn);
    await heldAfterSent(d, 'Сейчас');
    assert.ok((await typedDuring(3, '4s')) >= 2);
    assert.equal(reactionOf(s.fake, u), '👀');
    await closeLease(ch, 'destroy');
    assert.equal(await typedDuring(5, '4s'), 0, 'обрыв — тишина');
    await waitCleared(u, '👀 снят обрывом');
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

  it('working.action: upload_photo — «отправляет фото…» вместо «печатает…», сразу; без action (переходник до action) — снова «печатает…», сразу', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const { seq: p } = await seen(ch, 'нарисуй мне кота');
      await ch.reply(p, 'Нарисую', turn);
      await waitSent(s, gw, (m) => m.text === 'Нарисую', 'промежуточного ответа');
      const photo0 = acted('upload_photo');
      assert.deepEqual(ackOf(await ch.working(true, [p], 'upload_photo')), { chats: 1, seqs: [p] });
      await waitUntil(() => acted('upload_photo') > photo0 || null, 5000, 'upload_photo сразу, без шага часов');
      const typing0 = acted('typing');
      assert.ok((await typedDuring(5, '4s', 'upload_photo')) >= 4, 'пока рисует — «отправляет фото…» каждые 4 с');
      assert.equal(acted('typing') - typing0, 0, 'и не «печатает…»');
      assert.ok(workingLines().some((l) => l.on === true && l.action === 'upload_photo' && JSON.stringify(l.seqs) === JSON.stringify([p])), 'working.action в журнале');
      const typing1 = acted('typing');
      ackOf(await ch.working(true, [p]));
      await waitUntil(() => acted('typing') > typing1 || null, 5000, 'typing сразу, без шага часов');
      const photo1 = acted('upload_photo');
      assert.ok((await typedDuring(5, '4s')) >= 4, 'без action — «печатает…»');
      assert.equal(acted('upload_photo') - photo1, 0);
      const last = workingLines().at(-1)!;
      assert.ok(last.on === true && last.action === undefined, JSON.stringify(last));
      ackOf(await ch.working(false));
    } finally {
      await closeLease(ch);
    }
  });

  it('перезапуск шлюза посреди хода: 👀, который держал ход, снят при старте (ход был в памяти прежнего процесса)', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    const { u, seq: r } = await seen(ch, 'долгая задача');
    ackOf(await ch.working(true, [r]));
    await ch.reply(r, 'Начинаю', turn);
    await heldAfterSent(r, 'Начинаю');
    assert.equal(reactionOf(s.fake, u), '👀');
    await gw.stop();
    ch.destroy();
    gw = await s.start();
    await waitCleared(u, '👀 снят при старте');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'start' && Number(l.receipts_released) >= 1), 'start.receipts_released');
  });
});

describe('M13 · ход агента идёт: посылка грузится — «отправляет файл…» (#55)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let parcels: string;
  const acted = (action: string): number => s.fake.chatActions.filter((a) => a.chat_id === OWNER.id && a.action === action).length;
  const actedDuring = async (steps: number, action: string): Promise<number> => {
    const n = acted(action);
    for (let i = 0; i < steps; i++) {
      await gw.advance('4s');
      await sleep(20);
    }
    await sleep(100);
    return acted(action) - n;
  };

  before(async () => {
    parcels = path.join(makeTempDir('parcels-'), 'parcels');
    fs.mkdirSync(parcels);
    s = await setup({ home: { extraConfig: `parcels: { dir: "${parcels}" }\n` } });
    gw = await s.start();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('ход идёт, а документ агента грузится в чат — «отправляет файл…» (upload_document); загрузился — снова «печатает…»', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    try {
      fs.mkdirSync(path.join(parcels, 'отчёт'), { recursive: true });
      fs.writeFileSync(path.join(parcels, 'отчёт', 'итоги.txt'), 'итоги недели\n');
      const u = s.fake.push(s.fake.builder.text(OWNER, 'пришли итоги файлом'))[0]!;
      const seq = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
      await ch.waitEvent(seq);
      await ch.delivered(seq);
      assert.equal((await ch.working(true, [seq])).type, 'ack');
      // Загрузка медленная (1,5 с настоящего времени): шаги часов шлюза за это время — «отправляет файл…».
      s.fake.scenario({ method: 'sendDocument', times: 1, reply: fakeReply.delay(1500) });
      const r = await ch.sendFile('отчёт/итоги.txt', seq, turn);
      assert.equal(r.type, 'ack', JSON.stringify(r));
      await pump(gw, () => s.fake.calls.find((c) => c.method === 'sendDocument' && c.status === null), { what: 'загрузки документа' });
      const typing0 = acted('typing');
      assert.ok((await actedDuring(3, 'upload_document')) >= 2, 'пока грузится — «отправляет файл…»');
      assert.equal(acted('typing') - typing0, 0);
      await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.method === 'sendDocument' && m.document?.filename === 'итоги.txt'), { what: 'документа у владельца' });
      const doc0 = acted('upload_document');
      assert.ok((await actedDuring(3, 'typing')) >= 2, 'загрузился — снова «печатает…» (ход идёт)');
      assert.equal(acted('upload_document') - doc0, 0);
      assert.equal((await ch.working(false)).type, 'ack');
    } finally {
      ch.close();
    }
  });
});
