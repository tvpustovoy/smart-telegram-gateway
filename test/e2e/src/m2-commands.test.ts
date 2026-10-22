// M2 · команды и режимы (Ш-6, Оч-4; TECH-SPEC 5.6, 5.10 «Ход») на поддельном переходнике, подключённом всё время:
// A2.1 «стоп» трёх видов; правка на «стоп» не команда (хвост M1); A2.2 «стоп» пересылкой, цитатой, через инлайн-бота и от
// незнакомого — не команда; A2.3 «продолжить» текстом в stopped; A2.12–A2.13 пауза и held; A2.4 ответы старого хода и
// в stopped, а после [продолжить] (running) — старый turn всё равно dropped_stale_turn; A2.16 «стоп», 3 сообщения,
// [продолжить]; A2.15 ни одна команда и ни одно нажатие не дошли до переходника; «стоп», пока ответ агента ждёт повтора
// после 429, — ответ не уходит; пауза — ответ со старым № придерживается, как сообщение без seq.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { STOPPED_TEXT, STOP_NEEDS_BUTTON_TEXT, type Update } from 'stg-core';
import type { FakeChannel } from 'stg-fake-channel';
import { errors } from 'stg-fake-telegram';
import { connectAdapter, count, meta, pump, q, q1, waitUntil, type GatewayProcess } from './harness.js';
import { OTHER, OWNER, STRANGER, setup, type Setup } from './m1-common.js';
import { buttonsOf, press, sentWithText, waitSent } from './m2-common.js';
import { currentButtons, currentText } from './m4-common.js';

describe('M2 · команды и режимы', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  const turnNow = (): number => Number(meta(s.home, 'turn') ?? '0');
  const modeNow = (): string => meta(s.home, 'mode') ?? 'running';
  const seqOf = (u: Update): number | undefined => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
  const admitted = (u: Update): Promise<number> => waitUntil(() => seqOf(u), 5000, `приёма ${u.update_id}`);
  /** Дождаться нового кадра mode (после n уже полученных). */
  const nextMode = (n: number, state: string): Promise<unknown> =>
    waitUntil(() => ch.modes().slice(n).find((m) => m.state === state), 5000, `кадра mode ${state}`);

  before(async () => {
    s = await setup();
    gw = await s.start();
    ch = (await connectAdapter(s.home)).ch;
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('правка сообщения на «стоп» — правка: режим и ход не изменились', async () => {
    const orig = s.fake.builder.text(OWNER, 'привет');
    s.fake.push(orig);
    await admitted(orig);
    const ed = s.fake.builder.edited(orig, 'стоп');
    s.fake.push(ed);
    await admitted(ed);
    assert.equal(q1<{ kind: string }>(s.home, 'SELECT kind FROM events WHERE update_id = ?', ed.update_id)?.kind, 'edit');
    assert.equal(modeNow(), 'running');
    assert.equal(turnNow(), 0);
  });

  it('A2.1: «стоп», «Стоп », /stop от владельца — stopped, turn + 1, строка и кнопка [продолжить]', async () => {
    const b = s.fake.builder;
    for (const u of [b.text(OWNER, 'стоп'), b.text(OWNER, 'Стоп '), b.command(OWNER, '/stop')]) {
      const before = turnNow();
      const n = ch.modes().length;
      s.fake.push(u);
      await waitUntil(() => turnNow() === before + 1 || null, 5000, 'хода + 1');
      assert.equal(modeNow(), 'stopped');
      const ev = q1<{ kind: string; status: string }>(s.home, 'SELECT kind, status FROM events WHERE update_id = ?', u.update_id);
      assert.deepEqual({ ...ev }, { kind: 'command', status: 'handled' });
      // Переходник узнаёт режим и новый ход кадром mode.
      await nextMode(n, 'stopped');
      assert.equal(ch.currentTurn(), before + 1);
    }
    const lines = await pump(gw, () => (sentWithText(s, STOPPED_TEXT).length === 3 ? sentWithText(s, STOPPED_TEXT) : null), { what: 'трёх строк «Остановлен»' });
    for (const l of lines) assert.deepEqual(buttonsOf(l).map((x) => x.text), ['продолжить']);
  });

  it('A2.3: «продолжить» и «пауза» текстом в stopped — режим тот же, «стоп снимается кнопкой» и кнопка; [продолжить] — running', async () => {
    const turn = turnNow();
    s.fake.push(s.fake.builder.text(OWNER, 'продолжить'));
    const hint = await waitSent(s, gw, (m) => m.text === STOP_NEEDS_BUTTON_TEXT, 'строки «стоп снимается кнопкой»');
    assert.deepEqual(buttonsOf(hint).map((x) => x.text), ['продолжить']);
    s.fake.push(s.fake.builder.text(OWNER, 'пауза'));
    await pump(gw, () => sentWithText(s, STOP_NEEDS_BUTTON_TEXT).length === 2 || null, { what: 'второй подсказки' });
    assert.equal(modeNow(), 'stopped');
    assert.equal(turnNow(), turn);
    const n = ch.modes().length;
    assert.equal(await press(s, hint, 'продолжить'), null, 'нажатие засчитано — ответ без текста');
    await waitUntil(() => modeNow() === 'running' || null, 5000, 'running');
    assert.equal(turnNow(), turn + 1);
    await nextMode(n, 'running');
    // Строка с нажатой кнопкой правится на месте в одну строку без кнопок — новой строки нет (J-4).
    await pump(gw, () => currentText(hint).startsWith('⚙ Стоп снят') || null, { what: 'правки «Стоп снят»' });
    assert.deepEqual(currentButtons(hint), []);
    assert.ok(!s.fake.sentTo(OWNER.id).some((m) => m.text?.startsWith('⚙ Стоп снят')), 'новая строка «Стоп снят»');
    // Прежняя кнопка [продолжить] после снятия стопа — «уже использовано», ход не меняется.
    assert.equal(await press(s, sentWithText(s, STOPPED_TEXT)[0]!, 'продолжить'), 'уже использовано');
    assert.equal(turnNow(), turn + 1);
    assert.equal(modeNow(), 'running');
  });

  it('A2.2: «стоп» пересланным, цитатой, через инлайн-бота; от незнакомого — не команда: материал с меткой или ничего', async () => {
    const b = s.fake.builder;
    const turn = turnNow();
    const botMsg = sentWithText(s, STOPPED_TEXT)[0]!;
    const forms = [
      { name: 'пересылка чужого', u: b.forward(OWNER, { type: 'user', user: OTHER }, 'стоп'), trust: 'untrusted', mixed: 0 },
      { name: 'своя пересылка', u: b.forward(OWNER, { type: 'user', user: OWNER }, 'стоп'), trust: 'owner_forward', mixed: 0 },
      { name: 'цитата из другого чата', u: b.quoteExternal(OWNER, 'стоп', 'чужая цитата', { type: 'user', user: OTHER }), trust: 'owner', mixed: 1 },
      { name: 'реплай с цитатой из сообщения бота', u: b.replyTo(OWNER, 'стоп', botMsg.message, { quote: 'Остановлен' }), trust: 'owner', mixed: 0 },
      { name: 'инлайн-бот', u: b.viaBot(OWNER, 'стоп', { id: 9000, is_bot: true, first_name: 'gif', username: 'gif' }), trust: 'untrusted', mixed: 0 },
    ];
    for (const f of forms) s.fake.push(f.u);
    const stranger = b.text(STRANGER, 'стоп');
    s.fake.push(stranger);
    await s.fake.waitForOffset(stranger.update_id + 1);
    for (const f of forms) {
      const ev = q1<{ kind: string; trust: string; mixed: number }>(s.home, 'SELECT kind, trust, mixed FROM events WHERE update_id = ?', f.u.update_id);
      assert.deepEqual({ ...ev }, { kind: 'text', trust: f.trust, mixed: f.mixed }, f.name);
    }
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM updates WHERE update_id = ?', stranger.update_id)?.status, 'ignored');
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', stranger.update_id), 0);
    assert.equal(modeNow(), 'running');
    assert.equal(turnNow(), turn);
    // Материал дошёл до агента с меткой.
    const seqs = forms.map((f) => seqOf(f.u)!);
    await waitUntil(() => seqs.every((sq) => ch.events().some((e) => e.seq === sq)), 5000, 'материала у переходника');
    for (const [i, f] of forms.entries()) assert.equal(ch.events().find((e) => e.seq === seqs[i])?.trust, f.trust, f.name);
  });

  it('A2.12, A2.13: «пауза» — ответ на событие ушёл, без seq — held; «продолжить» пересылкой и цитатой — не команда; текстом — held ушли по порядку', async () => {
    const b = s.fake.builder;
    let n = ch.modes().length;
    const pause = b.text(OWNER, 'пауза');
    s.fake.push(pause);
    await waitUntil(() => modeNow() === 'paused' || null, 5000, 'paused');
    await nextMode(n, 'paused');
    // Ответной строки нет — пауза видна в закреплённой строке; сообщение с командой удалено (J-4).
    await pump(gw, () => s.fake.wasDeleted(OWNER.id, pause.message!.message_id) || null, { what: 'удаления команды «пауза»' });
    await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => /⏸ пауза/.test(currentText(m))), { what: 'паузы в закреплённой строке' });
    assert.ok(!s.fake.sentTo(OWNER.id).some((m) => m.text?.startsWith('⚙ Пауза')), 'строка «Пауза»');
    const qn = b.text(OWNER, 'вопрос в паузе');
    s.fake.push(qn);
    const seq = await admitted(qn);
    await ch.waitEvent(seq);
    const turn = ch.currentTurn()!;
    const r1 = await ch.reply(seq, 'ответ на событие', turn);
    const r2 = await ch.reply(null, 'сам первое', turn);
    const r3 = await ch.reply(null, 'сам второе', turn);
    assert.deepEqual([r1, r2, r3].map((r) => (r.type === 'ack' ? r.result : r.type)), ['queued', 'held_paused', 'held_paused']);
    await waitSent(s, gw, (m) => m.text === 'ответ на событие', 'ответа на событие');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM outbox WHERE status = 'held'"), 2);
    // «продолжить» пересылкой и цитатой — не команда.
    const fw = b.forward(OWNER, { type: 'user', user: OWNER }, 'продолжить');
    const qt = b.quoteExternal(OWNER, 'продолжить', 'цитата', { type: 'user', user: OTHER });
    s.fake.push(fw, qt);
    await admitted(qt);
    assert.equal(modeNow(), 'paused');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE update_id IN (?, ?) AND kind = 'command'", fw.update_id, qt.update_id), 0);
    await gw.advance('3s');
    assert.ok(!s.fake.sentTo(OWNER.id).some((m) => m.text?.startsWith('сам')), 'held ушли до «продолжить»');
    // «продолжить» текстом — пауза снята, held ушли по порядку.
    n = ch.modes().length;
    s.fake.push(b.text(OWNER, 'продолжить'));
    await waitUntil(() => modeNow() === 'running' || null, 5000, 'running');
    await nextMode(n, 'running');
    assert.equal(turnNow(), turn, 'пауза ход не меняет');
    await pump(gw, () => s.fake.sentTo(OWNER.id).filter((m) => m.text?.startsWith('сам')).length === 2 || null, { what: 'held' });
    const own = s.fake.sentTo(OWNER.id).filter((m) => m.text?.startsWith('сам')).map((m) => m.text);
    assert.deepEqual(own, ['сам первое', 'сам второе']);
    assert.ok(!s.fake.sentTo(OWNER.id).some((m) => m.text?.startsWith('⚙ Пауза')), 'строка «Пауза снята»');
  });

  /** Событие и ход A2.4 — для проверки старого turn после [продолжить] (A2.16). */
  let a24: { seq: number; oldTurn: number } | null = null;

  it('A2.4: «стоп» во время хода — reply со старым turn: dropped_stale_turn; затем reply в stopped: dropped_stopped; в Telegram не ушло', async () => {
    const qn = s.fake.builder.text(OWNER, 'долгий вопрос');
    s.fake.push(qn);
    const seq = await admitted(qn);
    await ch.waitEvent(seq);
    await ch.delivered(seq);
    const oldTurn = ch.currentTurn()!;
    a24 = { seq, oldTurn };
    const n = ch.modes().length;
    s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
    await nextMode(n, 'stopped');
    const r1 = await ch.reply(seq, 'ответ старого хода', oldTurn);
    assert.ok(r1.type === 'ack' && r1.result === 'dropped_stale_turn', JSON.stringify(r1));
    const r2 = await ch.reply(seq, 'ответ в стопе', ch.currentTurn()!);
    assert.ok(r2.type === 'ack' && r2.result === 'dropped_stopped', JSON.stringify(r2));
    const r3 = await ch.reply(null, 'сам в стопе', ch.currentTurn()!);
    assert.ok(r3.type === 'ack' && r3.result === 'dropped_stopped', JSON.stringify(r3));
    for (let i = 0; i < 5; i++) await gw.advance('2s');
    const texts = s.fake.sentTo(OWNER.id).map((m) => m.text ?? '');
    assert.ok(!texts.some((t) => /старого хода|в стопе/.test(t)), 'ответ ушёл в Telegram');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM outbox WHERE text IN ('ответ старого хода', 'ответ в стопе', 'сам в стопе')"), 0);
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status, 'delivered', 'не обработано: ответ не ушёл');
  });

  it('A2.16: «стоп», 3 сообщения, [продолжить] — 3 события отданы по порядку; ответ из outbox старого хода — dropped', async () => {
    const b = s.fake.builder;
    // Снять стоп из A2.4 и подготовить ответ агента, который застрял в очереди отправки (Telegram отвечает 502).
    let n = ch.modes().length;
    await press(s, sentWithText(s, STOPPED_TEXT).at(-1)!, 'продолжить');
    await nextMode(n, 'running');
    // Оч-4, главный случай: режим снова running, а ход, прерванный «стопом», дорабатывает и отвечает со старым turn.
    const stale = await ch.reply(a24!.seq, 'поздний ответ старого хода', a24!.oldTurn);
    assert.ok(stale.type === 'ack' && stale.result === 'dropped_stale_turn', JSON.stringify(stale));
    assert.equal(count(s.home, "SELECT count(*) AS n FROM outbox WHERE text = 'поздний ответ старого хода'"), 0, 'outbox пуст');
    s.fake.scenario({ method: 'sendMessage', when: (p) => String(p.text).startsWith('застрявший'), reply: errors.serverError(502) });
    const qn = b.text(OWNER, 'вопрос до стопа');
    s.fake.push(qn);
    const seq = await admitted(qn);
    await ch.waitEvent(seq);
    const r = await ch.reply(seq, 'застрявший ответ', ch.currentTurn()!);
    assert.ok(r.type === 'ack' && r.result === 'queued');
    await pump(gw, () => q1<{ attempts: number }>(s.home, "SELECT attempts FROM outbox WHERE text = 'застрявший ответ' AND attempts > 0"), { what: 'отложенной отправки' });
    n = ch.modes().length;
    s.fake.push(b.text(OWNER, 'стоп'));
    await nextMode(n, 'stopped');
    assert.equal(q1<{ status: string }>(s.home, "SELECT status FROM outbox WHERE text = 'застрявший ответ'")?.status, 'dropped');
    const tries = s.fake.callsOf('sendMessage').filter((c) => String(c.params.text).startsWith('застрявший')).length;
    // Три сообщения в stopped: записаны, квитанции идут, агенту не отдаются.
    const before = ch.events().length;
    const msgs = [1, 2, 3].map((i) => b.text(OWNER, `в стопе ${i}`));
    s.fake.push(...msgs);
    const seqs: number[] = [];
    for (const m of msgs) seqs.push(await admitted(m));
    for (let i = 0; i < 3; i++) await gw.advance('2s');
    assert.ok(!ch.events().slice(before).some((e) => seqs.includes(e.seq)), 'в stopped событие отдано');
    n = ch.modes().length;
    await press(s, sentWithText(s, STOPPED_TEXT).at(-1)!, 'продолжить');
    await nextMode(n, 'running');
    await waitUntil(() => seqs.every((sq) => ch.events().some((e) => e.seq === sq)), 5000, 'трёх событий после [продолжить]');
    const order = ch.events().filter((e) => seqs.includes(e.seq)).map((e) => e.seq);
    assert.deepEqual(order, seqs, 'по порядку');
    for (let i = 0; i < 40; i++) await gw.advance('2s');
    assert.equal(s.fake.callsOf('sendMessage').filter((c) => String(c.params.text).startsWith('застрявший')).length, tries, 'ответ старого хода ушёл снова');
    assert.ok(!s.fake.sentTo(OWNER.id).some((m) => m.text?.includes('поздний ответ старого хода')), 'старый turn ушёл в Telegram');
    assert.equal(q1<{ status: string }>(s.home, "SELECT status FROM outbox WHERE text = 'застрявший ответ'")?.status, 'dropped');
    s.fake.clearScenario();
  });

  it('A2.15: все команды и нажатия — ни одна не дошла до поддельного переходника', async () => {
    const b = s.fake.builder;
    const more = [
      b.text(OWNER, 'где мы'),
      b.command(OWNER, '/where'),
      b.text(OWNER, 'статус'),
      b.command(OWNER, '/status'),
      b.text(OWNER, 'новая тема'),
      b.command(OWNER, '/new'),
      b.command(OWNER, '/pause'),
      b.command(OWNER, '/resume'),
      b.command(OWNER, '/stop@test_assistant_bot'),
    ];
    s.fake.push(...more);
    for (const u of more) await admitted(u);
    await press(s, sentWithText(s, STOPPED_TEXT).at(-1)!, 'продолжить');
    const [bogus] = s.fake.push(b.callback(OWNER, 'чужая-кнопка', sentWithText(s, STOPPED_TEXT)[0]!.message));
    await admitted(bogus!);
    for (let i = 0; i < 3; i++) await gw.advance('2s');
    const handled = q<{ seq: number; kind: string }>(s.home, "SELECT seq, kind FROM events WHERE status = 'handled'");
    assert.ok(handled.length >= 20, `команд и нажатий ${handled.length}`);
    assert.ok(handled.every((h) => h.kind === 'command' || h.kind === 'callback'));
    const seen = new Set(ch.events().map((e) => e.seq));
    assert.deepEqual(handled.filter((h) => seen.has(h.seq)), [], 'команда или нажатие ушли переходнику');
    assert.ok(ch.events().every((e) => e.kind !== 'command' && e.kind !== 'callback'));
  });

  /** Снять стоп, если он стоит: нажать любую ещё не погасшую кнопку [продолжить]. */
  const ensureRunning = async (): Promise<void> => {
    if (modeNow() !== 'stopped') return;
    const live = (): Set<string> => new Set(q<{ token: string }>(s.home, "SELECT token FROM buttons WHERE kind = 'resume' AND used_at IS NULL").map((r) => r.token));
    const line = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => buttonsOf(m).some((b) => live().has(b.data))), { what: 'кнопки [продолжить]' });
    const n = ch.modes().length;
    await press(s, line, 'продолжить');
    await nextMode(n, 'running');
  };

  it('«стоп», пока ответ агента ждёт повтора после 429, — после паузы ответ не уходит: send_cancelled, строка dropped', async () => {
    await ensureRunning();
    assert.equal(modeNow(), 'running');
    s.fake.scenario({ method: 'sendMessage', when: (p) => String(p.text).startsWith('после 429'), times: 1, reply: errors.tooManyRequests(20) });
    const qn = s.fake.builder.text(OWNER, 'вопрос перед 429');
    s.fake.push(qn);
    const seq = await admitted(qn);
    await ch.waitEvent(seq);
    const r = await ch.reply(seq, 'после 429', ch.currentTurn()!);
    assert.ok(r.type === 'ack' && r.result === 'queued', JSON.stringify(r));
    const attempts = (): number => s.fake.callsOf('sendMessage').filter((c) => String(c.params.text).startsWith('после 429')).length;
    await pump(gw, () => attempts() === 1 || null, { what: 'попытки с 429' });
    await gw.waitForJournal((l) => l.ev === 'send_retry');
    // Отправитель ждёт retry_after (20 с); владелец говорит «стоп».
    const n = ch.modes().length;
    s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
    await nextMode(n, 'stopped');
    for (let i = 0; i < 15; i++) await gw.advance('2s');
    await gw.waitForJournal((l) => l.ev === 'send_cancelled' && l.during === 'retry');
    assert.equal(attempts(), 1, 'ответ ушёл после «стоп»');
    assert.equal(q1<{ status: string }>(s.home, "SELECT status FROM outbox WHERE text = 'после 429'")?.status, 'dropped');
    assert.ok(!gw.journal().some((l) => l.ev === 'sent_after_stop'));
    s.fake.clearScenario();
    await ensureRunning();
  });

  it('пауза: ответ со старым № (событие уже обработано) придерживается, как сообщение без seq; ответ на ждущее — уходит', async () => {
    await ensureRunning();
    const qn = s.fake.builder.text(OWNER, 'вопрос в паузе');
    s.fake.push(qn);
    const seq = await admitted(qn);
    await ch.waitEvent(seq);
    const n = ch.modes().length;
    s.fake.push(s.fake.builder.text(OWNER, 'пауза'));
    await nextMode(n, 'paused');
    const turn = ch.currentTurn()!;
    const answer = await ch.reply(seq, 'ответ на ждущее', turn);
    assert.ok(answer.type === 'ack' && answer.result === 'queued', JSON.stringify(answer));
    // Тот же № ещё раз — событие уже обработано: это уже не ответ на сообщение, а речь по своей инициативе.
    const again = await ch.reply(seq, 'ещё по старому №', turn);
    assert.ok(again.type === 'ack' && again.result === 'held_paused', JSON.stringify(again));
    await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text === 'ответ на ждущее'), { what: 'ответа на ждущее' });
    for (let i = 0; i < 3; i++) await gw.advance('2s');
    assert.ok(!s.fake.sentTo(OWNER.id).some((m) => m.text === 'ещё по старому №'), 'пауза обойдена старым №');
    assert.equal(q1<{ status: string }>(s.home, "SELECT status FROM outbox WHERE text = 'ещё по старому №'")?.status, 'held');
    const m = ch.modes().length;
    s.fake.push(s.fake.builder.text(OWNER, 'продолжить'));
    await nextMode(m, 'running');
    await pump(gw, () => s.fake.sentTo(OWNER.id).find((x) => x.text === 'ещё по старому №'), { what: 'придержанного после «продолжить»' });
  });
});
