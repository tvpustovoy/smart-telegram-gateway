// M12 · квитанция снимается, когда своё сделала (0.3.6, issue #52; TECH-SPEC 5.5; ui.clear_receipts, по умолчанию да).
// Реакция бота на сообщении владельца живёт, пока он ждёт ответа:
// A12.1 reply — 👀 снят (setMessageReaction с пустым списком), 👌 нет; снимается после того, как ответ ушёл в Telegram:
//   первая попытка — 502, пока ответ не ушёл, снятия нет; длинный ответ — после последней части;
// A12.2 send_file(seq) — то же, после документа;
// A12.3 done — 👌; следующее сообщение владельца — 👌 снят (журнал in.receipts_cleared);
// A12.4 несколько done — все 👌 сняты одним следующим сообщением (команда словом «где мы» — тоже сообщение); 👀 на
//   сообщении, которое ждёт ответа, не трогается; нажатие кнопки, реакция владельца на ответ агента и правка 👌 не
//   снимают ⟨предл.⟩;
// A12.5 ui.clear_receipts: false — как раньше: reply — 👌, done — 👌, следующее сообщение 👌 не снимает; /help — прежняя
//   строка;
// A12.6 ошибка Telegram на снятии (502) — повтор, затем снято;
// A12.7 перезапуск шлюза между done и следующим сообщением — при старте ничего не снимается, следующее сообщение снимает;
// A12.8 материал и слова (окно 0.3.6, #51): done на материал, reply на слова — на материале 👌, со слов снято; следующее
//   сообщение — 👌 материала снят;
// A12.9 ответ не ушёл — 👌 вместо 👀 ⟨предл.⟩: Telegram не принял ответ (400); «стоп» бросил ответ — 👌 (сам «стоп» —
//   следующее сообщение: снимает прежние 👌), [продолжить] его не снимает, следующее сообщение — снимает.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { STOPPED_TEXT, type Update } from 'stg-core';
import type { FakeChannel } from 'stg-fake-channel';
import { errors, reply, type CallRecord, type SentMessage } from 'stg-fake-telegram';
import { connectAdapter, makeTempDir, meta, pump, q1, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, reactionOf, reactionsOf, receiptCleared, setup, type Setup } from './m1-common.js';
import { press, sentWithText, waitSent } from './m2-common.js';

/** setMessageReaction с пустым списком — «снять реакцию». */
const isClear = (p: Record<string, unknown>): boolean => Array.isArray(p.reaction) && p.reaction.length === 0;
const messageIdOf = (u: Update): number => (u.message ?? u.edited_message)!.message_id;

describe('M12 · квитанция снимается, когда своё сделала (0.3.6, #52)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  let turn = 0;
  let parcels = '';
  const t = (): number => ch.currentTurn() ?? turn;
  const seqOf = (u: Update): number | undefined => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
  /** Удачные снятия реакции на сообщении. */
  const clearCalls = (u: Update): CallRecord[] =>
    s.fake.calls.filter((c) => c.method === 'setMessageReaction' && c.status === 200 && Number(c.params.message_id) === messageIdOf(u) && isClear(c.params));
  /** Событие агенту, delivered — 👀 встал. */
  async function seen(u: Update): Promise<number> {
    const seq = await waitUntil(() => seqOf(u), 5000, 'приёма');
    await ch.waitEvent(seq);
    await ch.delivered(seq);
    await pump(gw, () => reactionOf(s.fake, u) === '👀' || null, { what: `👀 на № ${seq}` });
    return seq;
  }
  async function says(text: string): Promise<{ u: Update; seq: number }> {
    const [u] = s.fake.push(s.fake.builder.text(OWNER, text));
    return { u: u!, seq: await seen(u!) };
  }
  /** Ответить на событие и дождаться, что 👀 снят. */
  async function answer(x: { u: Update; seq: number }, text: string): Promise<void> {
    assert.equal((await ch.reply(x.seq, text, t())).type, 'ack');
    await pump(gw, () => receiptCleared(s.fake, x.u) || null, { what: `снятия на № ${x.seq}` });
  }
  const inLine = (seq: number): Record<string, unknown> | undefined => readJournal(s.home).find((l) => l.ev === 'in' && l.seq === seq);

  before(async () => {
    parcels = path.join(makeTempDir('parcels-'), 'parcels');
    fs.mkdirSync(parcels);
    // Окно материала — по умолчанию шлюза (60 с): A12.8 — материал и слова.
    s = await setup({ home: { materialHoldSeconds: null, extraConfig: `parcels: { dir: "${parcels}" }\n` } });
    gw = await s.start();
    ({ ch, turn } = await connectAdapter(s.home));
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  let first: { u: Update; seq: number } | null = null;

  it('A12.1: reply — 👀 снят пустым списком, 👌 нет; снимается после того, как ответ ушёл (502 на первой попытке — снятия нет); длинный ответ — после последней части', async () => {
    const a = await says('что на завтра?');
    first = a;
    const isAnswer = (p: Record<string, unknown>): boolean => String(p.text ?? '').includes('созвон в 10:00');
    s.fake.scenario({ method: 'sendMessage', when: isAnswer, times: 1, reply: errors.serverError(502) });
    assert.equal((await ch.reply(a.seq, 'Завтра — созвон в 10:00', t())).type, 'ack');
    await pump(gw, () => receiptCleared(s.fake, a.u) || null, { what: 'снятия 👀 после ответа' });
    assert.deepEqual(reactionsOf(s.fake, a.u), ['👀', ''], 'снятие, 👌 нет');
    const sends = s.fake.calls.filter((c) => c.method === 'sendMessage' && isAnswer(c.params));
    assert.deepEqual(sends.map((c) => c.status), [502, 200], 'первая попытка — 502, вторая ушла');
    const clears = clearCalls(a.u);
    assert.equal(clears.length, 1);
    assert.ok(clears[0]!.n > sends[1]!.n, 'снято после того, как ответ ушёл, а не раньше');
    await waitUntil(() => q1(s.home, "SELECT 1 FROM reactions WHERE event_seq = ? AND want = '' AND shown = '' AND status = 'done'", a.seq) || null, 5000, 'отметки снятия');
    const out = readJournal(s.home).find((l) => l.ev === 'out' && Array.isArray(l.event_seqs) && (l.event_seqs as number[]).includes(a.seq) && l.label === 'agent');
    assert.equal(out?.receipt_cleared, true, 'журнал out — receipt_cleared');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'reaction' && l.seq === a.seq && l.cleared === true), 'журнал reaction — cleared');

    // Длинный ответ (две части) — снятие после последней части.
    const b = await says('расскажи подробно');
    const long = 'Подробности. '.repeat(400);
    assert.equal((await ch.reply(b.seq, long, t())).type, 'ack');
    await pump(gw, () => receiptCleared(s.fake, b.u) || null, { what: 'снятия после длинного ответа' });
    const parts = s.fake.calls.filter((c) => c.method === 'sendMessage' && c.status === 200 && String(c.params.text ?? '').includes('Подробности.'));
    assert.equal(parts.length, 2, 'две части');
    assert.ok(clearCalls(b.u)[0]!.n > parts[1]!.n, 'после последней части');
    assert.deepEqual(reactionsOf(s.fake, b.u), ['👀', '']);
  });

  it('A12.2: send_file(seq) — 👀 снят, когда документ ушёл; 👌 нет', async () => {
    fs.mkdirSync(path.join(parcels, 'итоги'), { recursive: true });
    fs.writeFileSync(path.join(parcels, 'итоги', 'неделя.txt'), 'итоги недели\n');
    const a = await says('пришли итоги файлом');
    const r = await ch.sendFile('итоги/неделя.txt', a.seq, t(), { caption: 'Итоги недели' });
    assert.equal(r.type, 'ack', JSON.stringify(r));
    await pump(gw, () => receiptCleared(s.fake, a.u) || null, { what: 'снятия после документа' });
    assert.deepEqual(reactionsOf(s.fake, a.u), ['👀', '']);
    const doc = s.fake.calls.filter((c) => c.method === 'sendDocument' && c.status === 200).at(-1)!;
    assert.ok(clearCalls(a.u)[0]!.n > doc.n, 'снято после документа');
  });

  it('A12.3: done — 👌; следующее сообщение владельца — 👌 снят (in.receipts_cleared)', async () => {
    const a = await says('просто запиши: купить хлеб');
    assert.equal((await ch.done([a.seq])).type, 'ack');
    await pump(gw, () => reactionOf(s.fake, a.u) === '👌' || null, { what: '👌 после done' });
    for (let i = 0; i < 3; i++) await gw.advance('1s');
    assert.equal(reactionOf(s.fake, a.u), '👌', '👌 стоит, пока владелец не написал дальше');
    const [n] = s.fake.push(s.fake.builder.text(OWNER, 'и молоко'));
    await pump(gw, () => receiptCleared(s.fake, a.u) || null, { what: 'снятия 👌 следующим сообщением' });
    assert.deepEqual(reactionsOf(s.fake, a.u), ['👀', '👌', '']);
    const nSeq = await seen(n!);
    assert.equal(inLine(nSeq)?.receipts_cleared, 1, 'журнал in — receipts_cleared');
    await answer({ u: n!, seq: nSeq }, 'Записал: хлеб и молоко');
  });

  it('A12.4: несколько done — все 👌 сняты одним следующим сообщением (команда «где мы»); 👀 ждущего не тронут; нажатие, реакция владельца и правка 👌 не снимают', async () => {
    const xs = [await says('раз'), await says('два'), await says('три')];
    // Это ждёт ответа (👀); пришло раньше, чем агент закрыл три первых: иначе оно само сняло бы их 👌.
    const w = await says('а это вопрос');
    assert.equal((await ch.done(xs.map((x) => x.seq))).type, 'ack');
    await pump(gw, () => xs.every((x) => reactionOf(s.fake, x.u) === '👌') || null, { what: '👌 на трёх' });
    // Реакция владельца на сообщение агента — не сообщение: 👌 не снимает.
    assert.equal((await ch.reply(null, 'Напоминаю: созвон в 10:00', t())).type, 'ack');
    const mine: SentMessage = await waitSent(s, gw, (m) => m.text === 'Напоминаю: созвон в 10:00', 'сообщения агента');
    await waitUntil(() => q1(s.home, 'SELECT 1 FROM messages_out WHERE tg_message_id = ?', mine.message_id), 5000, 'messages_out');
    const [ru] = s.fake.push(s.fake.builder.reaction(OWNER, mine.message.chat, mine.message_id, ['👍']));
    const rSeq = await waitUntil(() => seqOf(ru!), 5000, 'события реакции');
    await gw.advance('3s');
    await ch.waitEvent(rSeq);
    assert.equal((await ch.done([rSeq])).type, 'ack');
    // Нажатие кнопки — тоже не сообщение.
    assert.equal((await ch.episode('name', 'Списки')).type, 'ack');
    const ann = await waitSent(s, gw, (m) => (m.text ?? '').startsWith('⚙ ↪ #') && (m.text ?? '').includes('Списки'), 'объявления темы');
    await press(s, ann, 'верно');
    // Правка прежнего сообщения (A12.1, реакция на нём уже снята) — тоже не следующее сообщение ⟨предл.⟩.
    const [ed] = s.fake.push(s.fake.builder.edited(first!.u, 'что на послезавтра?'));
    const edSeq = await waitUntil(() => seqOf(ed!), 5000, 'правки');
    await ch.waitEvent(edSeq);
    for (let i = 0; i < 5; i++) await gw.advance('1s');
    await sleep(50);
    for (const x of xs) {
      assert.equal(reactionOf(s.fake, x.u), '👌', `№ ${x.seq}: 👌 на месте`);
      assert.equal(clearCalls(x.u).length, 0);
    }
    for (const seq of [rSeq, edSeq]) assert.equal(inLine(seq)?.receipts_cleared, undefined);
    // Команда словом — сообщение владельца: снимает все три 👌 одним разом; 👀 ждущего не трогает.
    const [cmd] = s.fake.push(s.fake.builder.text(OWNER, 'где мы'));
    await pump(gw, () => xs.every((x) => receiptCleared(s.fake, x.u)) || null, { what: 'снятия трёх 👌 командой' });
    for (const x of xs) assert.deepEqual(reactionsOf(s.fake, x.u), ['👀', '👌', '']);
    assert.equal(reactionOf(s.fake, w.u), '👀', 'ждёт ответа — 👀 на месте');
    const cmdSeq = await waitUntil(() => seqOf(cmd!), 5000, 'команды');
    assert.equal(q1<{ kind: string }>(s.home, 'SELECT kind FROM events WHERE seq = ?', cmdSeq)?.kind, 'command');
    assert.equal(inLine(cmdSeq)?.receipts_cleared, 3);
    await answer(w, 'Отвечаю на вопрос');
    await ch.delivered(edSeq);
    await answer({ u: ed!, seq: edSeq }, 'Учёл: послезавтра');
  });

  it('A12.6: ошибка Telegram на снятии (502) — повтор, затем снято', async () => {
    const a = await says('запиши: позвонить маме');
    assert.equal((await ch.done([a.seq])).type, 'ack');
    await pump(gw, () => reactionOf(s.fake, a.u) === '👌' || null, { what: '👌' });
    s.fake.scenario({ method: 'setMessageReaction', when: (p) => isClear(p) && Number(p.message_id) === messageIdOf(a.u), times: 1, reply: errors.serverError(502) });
    const [n] = s.fake.push(s.fake.builder.text(OWNER, 'и купить цветы'));
    await pump(gw, () => receiptCleared(s.fake, a.u) || null, { what: 'снятия после 502' });
    const tries = s.fake.calls.filter((c) => c.method === 'setMessageReaction' && Number(c.params.message_id) === messageIdOf(a.u) && isClear(c.params));
    assert.deepEqual(tries.map((c) => c.status), [502, 200], '502 — повтор');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'reaction_failed' && l.seq === a.seq && l.emoji === '' && l.final === false), 'reaction_failed, не final');
    assert.deepEqual(reactionsOf(s.fake, a.u), ['👀', '👌', '']);
    await answer({ u: n!, seq: await seen(n!) }, 'Записал');
  });

  it('A12.8: материал и слова — done на материал, reply на слова: на материале 👌, со слов снято; следующее сообщение — 👌 материала снят', async () => {
    // Слова владельца были меньше минуты назад — материал ушёл бы сразу (правило 3, 5.18): окно — заново.
    await gw.advance('70s');
    const [pu] = s.fake.push(s.fake.builder.photo(OWNER, null));
    const p = await waitUntil(() => seqOf(pu!), 5000, 'приёма фото');
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', p)?.status, 'held', 'материал ждёт слов');
    await gw.advance('10s');
    const [wu] = s.fake.push(s.fake.builder.text(OWNER, 'что на фото?'));
    const w = await waitUntil(() => seqOf(wu!), 5000, 'приёма слов');
    await ch.waitEvent(p);
    await ch.waitEvent(w);
    await ch.delivered(p);
    await ch.delivered(w);
    await pump(gw, () => (reactionOf(s.fake, pu!) === '👀' && reactionOf(s.fake, wu!) === '👀') || null, { what: '👀 на фото и словах' });
    assert.equal((await ch.done([p])).type, 'ack');
    assert.equal((await ch.reply(w, 'На фото — чек из магазина', t())).type, 'ack');
    await pump(gw, () => (reactionOf(s.fake, pu!) === '👌' && receiptCleared(s.fake, wu!)) || null, { what: '👌 на фото и снятия на словах' });
    assert.deepEqual([reactionsOf(s.fake, pu!), reactionsOf(s.fake, wu!)], [['👀', '👌'], ['👀', '']]);
    const [n] = s.fake.push(s.fake.builder.text(OWNER, 'спасибо'));
    await pump(gw, () => receiptCleared(s.fake, pu!) || null, { what: 'снятия 👌 материала' });
    assert.deepEqual(reactionsOf(s.fake, pu!), ['👀', '👌', '']);
    await answer({ u: n!, seq: await seen(n!) }, 'Пожалуйста');
  });

  it('A12.9: ответ не ушёл — 👌 вместо 👀: Telegram не принял (400); «стоп» бросил ответ — 👌 («стоп» снимает прежние 👌), [продолжить] его не снимает, следующее сообщение — снимает', async () => {
    // Telegram не принял ответ (400, не разбор разметки) — строка брошена: событие закрыто, ответа в чате нет — 👌.
    const a = await says('ответь коротко');
    s.fake.scenario({ method: 'sendMessage', when: (p) => String(p.text ?? '').includes('не дойдёт'), times: 1, reply: reply.error(400, 'Bad Request: message must be non-empty') });
    assert.equal((await ch.reply(a.seq, 'Этот ответ не дойдёт', t())).type, 'ack');
    await pump(gw, () => reactionOf(s.fake, a.u) === '👌' || null, { what: '👌 после брошенного ответа' });
    assert.deepEqual(reactionsOf(s.fake, a.u), ['👀', '👌']);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'send_dropped' && l.receipt === '👌'), 'send_dropped — receipt 👌');
    // «Стоп», пока ответ ждёт повтора (502): ответ брошен — 👌; сам «стоп» — сообщение владельца: прежний 👌 (выше) снят.
    const b = await says('долгий вопрос');
    const isLong = (p: Record<string, unknown>): boolean => String(p.text ?? '').includes('долгий ответ');
    s.fake.scenario({ method: 'sendMessage', when: isLong, times: 10_000, reply: errors.serverError(502) });
    assert.equal((await ch.reply(b.seq, 'Это долгий ответ', t())).type, 'ack');
    await pump(gw, () => s.fake.calls.some((c) => c.method === 'sendMessage' && isLong(c.params)) || null, { what: 'первой попытки ответа' });
    s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
    await pump(gw, () => (reactionOf(s.fake, b.u) === '👌' && receiptCleared(s.fake, a.u)) || null, { what: '👌 после «стопа» и снятия прежнего' });
    assert.ok(readJournal(s.home).some((l) => l.ev === 'replies_dropped' && l.reason === 'stopped'));
    assert.deepEqual(reactionsOf(s.fake, b.u), ['👀', '👌']);
    s.fake.clearScenario();
    await waitSent(s, gw, (m) => m.text === STOPPED_TEXT, 'строки «Остановлен»');
    await press(s, sentWithText(s, STOPPED_TEXT).at(-1)!, 'продолжить');
    await waitUntil(() => meta(s.home, 'mode') === 'running' || null, 5000, 'снятия стопа');
    for (let i = 0; i < 12; i++) await gw.advance('1s');
    await sleep(50);
    assert.equal(reactionOf(s.fake, b.u), '👌', '[продолжить] — нажатие, 👌 на месте');
    assert.ok(!s.fake.calls.some((c) => c.method === 'sendMessage' && c.status === 200 && isLong(c.params)), 'брошенный ответ не ушёл');
    const [n] = s.fake.push(s.fake.builder.text(OWNER, 'продолжим'));
    await pump(gw, () => receiptCleared(s.fake, b.u) || null, { what: 'снятия 👌 следующим сообщением' });
    await answer({ u: n!, seq: await seen(n!) }, 'Продолжаем');
  });

  it('A12.7: перезапуск между done и следующим сообщением — при старте ничего не снимается; следующее сообщение снимает', async () => {
    const a = await says('запиши на потом');
    assert.equal((await ch.done([a.seq])).type, 'ack');
    await pump(gw, () => reactionOf(s.fake, a.u) === '👌' || null, { what: '👌' });
    await waitUntil(() => q1(s.home, "SELECT 1 FROM reactions WHERE event_seq = ? AND shown = '👌' AND status = 'done'", a.seq) || null, 5000, 'отметки 👌');
    ch.close();
    await gw.stop();
    const before = s.fake.callsOf('setMessageReaction').length;
    gw = await s.start();
    ({ ch, turn } = await connectAdapter(s.home));
    for (let i = 0; i < 5; i++) await gw.advance('1s');
    await sleep(50);
    assert.equal(s.fake.callsOf('setMessageReaction').length, before, 'при старте массовой чистки нет');
    assert.equal(reactionOf(s.fake, a.u), '👌');
    const [n] = s.fake.push(s.fake.builder.text(OWNER, 'вспомнил'));
    await pump(gw, () => receiptCleared(s.fake, a.u) || null, { what: 'снятия 👌 после перезапуска' });
    assert.deepEqual(reactionsOf(s.fake, a.u), ['👀', '👌', '']);
    await answer({ u: n!, seq: await seen(n!) }, 'Слушаю');
  });
});

describe('M12 · ui.clear_receipts: false — как до 0.3.6 (A12.5)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  let turn = 0;
  before(async () => {
    s = await setup({ home: { extraConfig: 'ui: { material_hold_seconds: 0, clear_receipts: false }\n' } });
    gw = await s.start();
    ({ ch, turn } = await connectAdapter(s.home));
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('A12.5: reply — 👌, done — 👌; следующее сообщение 👌 не снимает; /help — прежняя строка о реакциях', async () => {
    const seqOf = (u: Update): number | undefined => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
    const seen = async (u: Update): Promise<number> => {
      const seq = await waitUntil(() => seqOf(u), 5000, 'приёма');
      await ch.waitEvent(seq);
      await ch.delivered(seq);
      await pump(gw, () => reactionOf(s.fake, u) === '👀' || null, { what: '👀' });
      return seq;
    };
    const [a, b] = s.fake.push(s.fake.builder.text(OWNER, 'вопрос'), s.fake.builder.text(OWNER, 'просто запиши'));
    const aSeq = await seen(a!);
    const bSeq = await seen(b!);
    assert.equal((await ch.reply(aSeq, 'Ответ', turn)).type, 'ack');
    assert.equal((await ch.done([bSeq])).type, 'ack');
    await pump(gw, () => (reactionOf(s.fake, a!) === '👌' && reactionOf(s.fake, b!) === '👌') || null, { what: '👌 на обоих' });
    await waitSent(s, gw, (m) => m.text === 'Ответ', 'ответа агента');
    const [n] = s.fake.push(s.fake.builder.text(OWNER, 'дальше'));
    await seen(n!);
    for (let i = 0; i < 5; i++) await gw.advance('1s');
    await sleep(50);
    assert.deepEqual([reactionsOf(s.fake, a!), reactionsOf(s.fake, b!)], [['👀', '👌'], ['👀', '👌']], '👌 остаются');
    assert.ok(!s.fake.calls.some((c) => c.method === 'setMessageReaction' && isClear(c.params)), 'снятий нет');
    s.fake.push(s.fake.builder.command(OWNER, '/help'));
    const help = await waitSent(s, gw, (m) => (m.text ?? '').startsWith('⚙ Как устроен чат'), 'справки');
    assert.ok((help.text ?? '').includes('На твоём сообщении: 👀 агент увидел · 👌 агент ответил.'), help.text ?? '');
  });
});
