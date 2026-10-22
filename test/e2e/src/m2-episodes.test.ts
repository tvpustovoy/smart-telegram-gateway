// M2 · эпизоды (Ш-12, Ш-13, Ш-19, Ш-25; TECH-SPEC 5.7) на поддельных Telegram и переходнике:
// A2.5 разрыв 34 минуты · A2.6 разрыв 32 минуты · A2.7 «новая тема», темы Telegram · A2.8 смена кодом: строк о смене
// эпизода нет — смена видна в закреплённой строке (закрытый тишиной — «#N · … · закрыт»); нижней клавиатуры и
// подсказки поля ввода нет (0.3.1, P-18), тема и роль — только в закреплённой строке · A2.9 episode(new) и
// [не то] через 5 минут · тема от агента (episode name —
// A3.8 на M2), [верно] и [не то] — объявление правится в одну строку без кнопок, [не то] позже 4 часов — выбор темы ·
// итог и его метка (A3.9 на M2) · episode в stopped и с role. Интерфейс — J-4. По проверке: после [не то] с
// возвратом и тишины в строке (и в «где мы») — тот эпизод, к которому вернулись, а не отвергнутый с бо́льшим номером.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PICK_EPISODE_TEXT, type Update } from 'stg-core';
import type { FakeChannel } from 'stg-fake-channel';
import { connectAdapter, count, meta, pump, q, q1, readJournal, waitUntil, type GatewayProcess } from './harness.js';
import { OTHER, OWNER, chatMessages, setup, statusLineOf, waitRecorded, type Setup } from './m1-common.js';
import { buttonsOf, keyboardOrPlaceholder, press, waitSent } from './m2-common.js';
import { currentButtons, currentText } from './m4-common.js';

interface Ep {
  id: number;
  topic: string;
  opened_by: string;
  closed_at: number | null;
  close_reason: string | null;
  thread_id: number | null;
  summary: string | null;
  summary_trust: string | null;
}

function helpers(s: () => Setup) {
  const seqOf = (u: Update): number | undefined => q1<{ seq: number }>(s().home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
  return {
    seqOf,
    admitted: (u: Update): Promise<number> => waitUntil(() => seqOf(u), 5000, `приёма ${u.update_id}`),
    episodeOf: (seq: number): number => q1<{ episode_id: number }>(s().home, 'SELECT episode_id FROM events WHERE seq = ?', seq)!.episode_id,
    ep: (id: number): Ep => q1<Ep>(s().home, 'SELECT * FROM episodes WHERE id = ?', id)!,
    openEp: (): Ep | undefined => q1<Ep>(s().home, 'SELECT * FROM episodes WHERE closed_at IS NULL'),
  };
}

/**
 * Нижней клавиатуры и подсказки поля ввода нет (0.3.1, P-18: кнопки убраны, команды — в меню): тема и роль — только в
 * закреплённой строке.
 */
const noKeyboard = (m: Parameters<typeof keyboardOrPlaceholder>[0], what: string): void => assert.equal(keyboardOrPlaceholder(m), false, what);

/** Дождаться текста закреплённой строки. */
function waitStatus(s: Setup, gw: GatewayProcess, pred: (text: string) => boolean, what = 'закреплённой строки'): Promise<string> {
  return pump(gw, () => {
    const st = statusLineOf(s.fake);
    return st && pred(st.text) ? st.text : null;
  }, { what });
}

/** Строк о смене эпизода («⚙ #N · …», прежде «⚙ Эп. N · …») в чате нет. */
function assertNoEpisodeLines(s: Setup): void {
  assert.ok(!chatMessages(s.fake).some((m) => /^⚙ (?:Эп\. |#)\d/.test(m.text ?? '')), 'строка о смене эпизода');
}

describe('M2 · эпизоды по коду: тишина, темы Telegram, «новая тема», строка состояния', () => {
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

  it('A2.5, A2.8: разрыв 34 минуты — первый закрыт (в строке «закрыт»), второе в новом эпизоде; строки о смене нет; роли, клавиатуры и подсказки нет; episode_closed с №', async () => {
    const m1 = s.fake.builder.text(OWNER, 'первое');
    s.fake.push(m1);
    const seq1 = await h.admitted(m1);
    await waitRecorded(s, gw, m1);
    const ep1 = h.episodeOf(seq1);
    // Закреплённая строка: одно сообщение бота, закреплено без звука; #N, тема (роль по умолчанию не показывается), агент,
    // ждущие.
    const st1 = await waitStatus(s, gw, (t) => t.startsWith(`📍 #${ep1} `));
    assert.equal(st1, `📍 #${ep1} · тема не названа\n⚪ · 📥 1`);
    const pinned = statusLineOf(s.fake)!.message;
    assert.equal(pinned.disable_notification, true);
    assert.deepEqual(s.fake.pins.map((p) => ({ id: p.message_id, silent: p.disable_notification })), [{ id: pinned.message_id, silent: true }]);
    assert.equal(pinned.reply_markup, null, 'у строки нет клавиатуры — её правят');
    // Служебное сообщение Telegram о закреплении — удалено.
    const notice = s.fake.pinNotices[0]!;
    await pump(gw, () => s.fake.wasDeleted(OWNER.id, notice.message_id) || null, { what: 'удаления «бот закрепил»' });
    await gw.advance('34m');
    // «Агент не на связи» — служебная строка без разметки: нижней клавиатуры и подсказки нет (0.3.1).
    const off = await waitSent(s, gw, (m) => m.text?.startsWith('⚙ Агент сейчас не на связи') ?? false, 'строки «не на связи»');
    assert.equal(off.reply_markup, null, 'без клавиатуры и подсказки');
    // Первый эпизод закрыт тишиной, нового ещё нет — в строке он же с пометкой «закрыт» (по проверке на реальном боте:
    // «Эпизода нет» рядом с «Эп. N» в чате читалось как противоречие).
    await waitStatus(s, gw, (t) => t === `📍 #${ep1} · тема не названа · закрыт\n⚪ · 📥 1`, 'закрытого эпизода в строке');
    const m2 = s.fake.builder.text(OWNER, 'через 34 минуты');
    s.fake.push(m2);
    const seq2 = await h.admitted(m2);
    const ep2 = h.episodeOf(seq2);
    assert.notEqual(ep2, ep1);
    assert.equal(h.ep(ep1).close_reason, 'idle');
    assert.deepEqual({ topic: h.ep(ep2).topic, opened_by: h.ep(ep2).opened_by }, { topic: 'Новая тема', opened_by: 'idle' });
    const closed = q<{ seq: number; status: string }>(s.home, "SELECT seq, status FROM events WHERE kind = 'episode_closed' AND episode_id = ?", ep1);
    assert.equal(closed.length, 1, 'episode_closed в очереди');
    assert.equal(closed[0]!.status, 'new');
    assert.ok(closed[0]!.seq > seq1 && closed[0]!.seq < seq2, '№ — между сообщениями');
    await waitRecorded(s, gw, m2);
    // Смена видна в той же закреплённой строке (правка на месте), новых строк о смене нет.
    await waitStatus(s, gw, (t) => t === `📍 #${ep2} · тема не названа\n⚪ · 📥 2`);
    assert.equal(statusLineOf(s.fake)!.message.message_id, pinned.message_id, 'строка та же');
    assert.equal(s.fake.pins.length, 1);
    assertNoEpisodeLines(s);
    assert.ok(!statusLineOf(s.fake)!.text.includes('закрыт'), 'новый эпизод открыт');
    assert.ok(!s.fake.sentTo(OWNER.id).some((m) => m.text?.startsWith('⚙ ↪')), 'смену кодом не объявляют');
  });

  it('A2.6: разрыв 32 минуты — тот же эпизод', async () => {
    const m3 = s.fake.builder.text(OWNER, 'третье');
    s.fake.push(m3);
    const ep = h.episodeOf(await h.admitted(m3));
    await gw.advance('32m');
    const m4 = s.fake.builder.text(OWNER, 'через 32 минуты');
    s.fake.push(m4);
    assert.equal(h.episodeOf(await h.admitted(m4)), ep);
    assert.equal(h.ep(ep).closed_at, null);
  });

  it('A2.7: «новая тема» — новый (owner_new_topic); другая тема Telegram — новый (telegram_topic); message_thread_id без is_topic_message — тот же', async () => {
    const b = s.fake.builder;
    const before = h.openEp()!;
    const cmd = b.text(OWNER, 'новая тема');
    s.fake.push(cmd);
    await h.admitted(cmd);
    assert.equal(h.ep(before.id).close_reason, 'owner_new_topic');
    const opened = h.openEp()!;
    assert.deepEqual({ opened_by: opened.opened_by, topic: opened.topic }, { opened_by: 'owner_new_topic', topic: 'Новая тема' });
    // Ответной строки нет: новый эпизод — в закреплённой строке; сообщение с командой удалено.
    await waitStatus(s, gw, (t) => t.startsWith(`📍 #${opened.id} · тема не названа\n`), 'нового эпизода в закреплённой строке');
    await pump(gw, () => s.fake.wasDeleted(OWNER.id, cmd.message!.message_id) || null, { what: 'удаления «новая тема»' });
    assertNoEpisodeLines(s);
    // Текст кнопки прежней нижней клавиатуры (до 0.3.1; у клиента она могла остаться) — тоже команда.
    const btn = b.text(OWNER, '🆕 Нов. тема');
    s.fake.push(btn);
    await h.admitted(btn);
    const opened2 = h.openEp()!;
    assert.equal(h.ep(opened.id).close_reason, 'owner_new_topic');
    assert.equal(opened2.opened_by, 'owner_new_topic');
    await pump(gw, () => s.fake.wasDeleted(OWNER.id, btn.message!.message_id) || null, { what: 'удаления кнопки' });
    const m5 = b.text(OWNER, 'про новое');
    s.fake.push(m5);
    assert.equal(h.episodeOf(await h.admitted(m5)), opened2.id);
    // Другая тема Telegram (is_topic_message = true): новый эпизод; квитанция — в ту же тему.
    const t1 = b.text(OWNER, 'в теме 500', { thread: { id: 500, isTopic: true } });
    s.fake.push(t1);
    const seqT1 = await h.admitted(t1);
    const epT = h.ep(h.episodeOf(seqT1));
    assert.deepEqual({ opened_by: epT.opened_by, thread_id: epT.thread_id }, { opened_by: 'telegram_topic', thread_id: 500 });
    assert.equal(h.ep(opened2.id).close_reason, 'telegram_topic');
    // Квитанция в теме — реакцией на само сообщение.
    await waitRecorded(s, gw, t1, 'квитанции в теме');
    void seqT1;
    const t2 = b.text(OWNER, 'ещё в теме 500', { thread: { id: 500, isTopic: true } });
    s.fake.push(t2);
    assert.equal(h.episodeOf(await h.admitted(t2)), epT.id, 'та же тема — тот же эпизод');
    // Назад в основной поток — снова смена; message_thread_id без is_topic_message — основной поток, тот же эпизод.
    const main = b.text(OWNER, 'в основном потоке');
    s.fake.push(main);
    const epMain = h.episodeOf(await h.admitted(main));
    assert.notEqual(epMain, epT.id);
    assert.equal(h.ep(epT.id).close_reason, 'telegram_topic');
    const t3 = b.text(OWNER, 'реплай с номером темы', { thread: { id: 600, isTopic: false } });
    s.fake.push(t3);
    assert.equal(h.episodeOf(await h.admitted(t3)), epMain, 'message_thread_id без is_topic_message — тот же эпизод');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'command'"), 2);
    assertNoEpisodeLines(s);
  });

  it('тишина по дате сообщения: сообщение с датой через 40 минут закрывает эпизод при приёме, до таймера', async () => {
    const cur = h.openEp()!;
    const last = q1<{ d: number }>(s.home, 'SELECT max(message_date) AS d FROM events WHERE episode_id = ?', cur.id)!.d;
    const late = s.fake.builder.text(OWNER, 'написано через 40 минут', { date: Math.floor((last + 40 * 60_000) / 1000) });
    s.fake.push(late);
    const ep = h.episodeOf(await h.admitted(late));
    assert.notEqual(ep, cur.id);
    assert.equal(h.ep(cur.id).close_reason, 'idle');
    assert.equal(h.ep(ep).opened_by, 'idle');
  });
});

describe('M2 · эпизоды от агента: тема, [верно] / [не то], итог', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  const h = helpers(() => s);
  let epA = 0;
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

  // Роль по умолчанию в объявлениях не показывается.
  const announce = (id: number, topic: string): string => `⚙ ↪ #${id} · ${topic}`;
  const returned = (id: number, topic: string): string => `⚙ ↩ #${id} · ${topic}`;
  /** Ответ агента на событие: по нему видно, что ни клавиатуры, ни подсказки нет (0.3.1). */
  const agentReply = async (seq: number, text: string) => {
    await ch.waitEvent(seq);
    const r = await ch.reply(seq, text, ch.currentTurn()!);
    assert.ok(r.type === 'ack' && r.result === 'queued', JSON.stringify(r));
    return waitSent(s, gw, (m) => m.text === text, 'ответа агента');
  };
  /** Нажатое объявление правится в одну строку без кнопок. */
  const waitEdited = (m: Parameters<typeof currentText>[0], text: string) =>
    pump(gw, () => (currentText(m) === text && currentButtons(m).length === 0) || null, { what: `правки «${text}»` });

  it('episode(name) — эпизод тот же; объявление с [верно] [не то]; тема — в закреплённой строке, подсказки нет; [верно] — объявление в одну строку (A3.8 на M2)', async () => {
    const m1 = s.fake.builder.text(OWNER, 'что на завтра?');
    s.fake.push(m1);
    const seq1 = await h.admitted(m1);
    epA = h.episodeOf(seq1);
    await ch.waitEvent(seq1);
    const r = await ch.episode('name', 'Задачи на завтра');
    assert.ok(r.type === 'ack', JSON.stringify(r));
    assert.deepEqual(r.result, { episode_id: epA, topic: 'Задачи на завтра', action: 'name', changed: true });
    assert.equal(h.ep(epA).topic, 'Задачи на завтра');
    assert.equal(h.ep(epA).closed_at, null);
    const line = await waitSent(s, gw, (m) => m.text === announce(epA, 'Задачи на завтра'), 'объявления');
    assert.deepEqual(buttonsOf(line).map((b) => b.text), ['верно', 'не то']);
    await waitStatus(s, gw, (t) => /^📍 #\d+ · Задачи на завтра\n[🟢🟡]/u.test(t) && t.startsWith(`📍 #${epA} `), 'темы в закреплённой строке');
    const m2 = s.fake.builder.text(OWNER, 'купить хлеб');
    s.fake.push(m2);
    const seq2 = await h.admitted(m2);
    await waitRecorded(s, gw, m2);
    const ev = await ch.waitEvent(seq2);
    assert.equal(ev.episode?.topic, 'Задачи на завтра');
    const rc = await agentReply(seq2, 'записал хлеб');
    noKeyboard(rc, 'подсказки нет: тема — в закреплённой строке (0.3.1)');
    assert.equal(await press(s, line, 'верно'), null);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'episode_confirmed' && l.episode === epA));
    await waitEdited(line, `${announce(epA, 'Задачи на завтра')} — верно`);
    // Нажатие — одна правка (текст без кнопок): снятие кнопок входит в неё, отдельного editMessageReplyMarkup нет.
    for (let i = 0; i < 3; i++) await gw.advance('1s');
    const editsOfLine = s.fake.calls.filter((c) => (c.method === 'editMessageText' || c.method === 'editMessageReplyMarkup') && Number(c.params.message_id) === line.message_id);
    assert.deepEqual(editsOfLine.map((c) => c.method), ['editMessageText']);
    assert.equal(await press(s, line, 'не то'), 'уже использовано', 'кнопки одного объявления гаснут вместе');
    // Та же тема ещё раз — без объявления.
    const same = await ch.episode('name', 'Задачи на завтра');
    assert.ok(same.type === 'ack' && (same.result as { changed: boolean }).changed === false);
  });

  it('A2.8: длинная тема — в закреплённой строке; у ответа агента ни клавиатуры, ни подсказки (0.3.1)', async () => {
    const long = 'Очень длинная тема про задачи на завтра, послезавтра и на всю следующую неделю, с подробностями';
    await ch.episode('name', long);
    const m = s.fake.builder.text(OWNER, 'ещё одно');
    s.fake.push(m);
    const seq = await h.admitted(m);
    const rc = await agentReply(seq, 'ещё одно записал');
    noKeyboard(rc, 'без клавиатуры');
    await pump(gw, () => statusLineOf(s.fake)?.text.includes('Очень длинная тема') || null, { what: 'темы в закреплённой строке' });
    await ch.episode('name', 'Задачи на завтра');
  });

  it('[не то] после name — прежняя тема; агенту episode_reopened в общей очереди, с №', async () => {
    const r = await ch.episode('name', 'Покупки');
    assert.ok(r.type === 'ack');
    const line = await waitSent(s, gw, (m) => m.text === announce(epA, 'Покупки'), 'объявления');
    assert.equal(await press(s, line, 'не то'), null);
    assert.equal(h.ep(epA).topic, 'Задачи на завтра');
    const re = await waitUntil(() => ch.events().find((e) => e.kind === 'episode_reopened' && e.episode?.id === epA), 5000, 'episode_reopened');
    assert.equal(re.episode?.topic, 'Задачи на завтра');
    assert.ok(re.seq > 0);
    // Объявление правится на месте: прежняя тема, без кнопок; новой строки нет.
    await waitEdited(line, returned(epA, 'Задачи на завтра'));
    assert.ok(!s.fake.sentTo(OWNER.id).some((m) => m.text?.startsWith('⚙ ↩')), 'строка о возврате отдельным сообщением');
  });

  it('A2.9: episode(new); [не то] через 5 минут — прежний эпизод открыт снова, объявленный закрыт owner_rejected; episode_reopened в очереди', async () => {
    const before = ch.events().length;
    const r = await ch.episode('new', 'Отпуск', 'владелец заговорил об отпуске');
    assert.ok(r.type === 'ack', JSON.stringify(r));
    const epB = (r.result as { episode_id: number }).episode_id;
    assert.notEqual(epB, epA);
    assert.equal(h.ep(epA).close_reason, 'agent_new');
    assert.deepEqual({ opened_by: h.ep(epB).opened_by, topic: h.ep(epB).topic }, { opened_by: 'agent_new', topic: 'Отпуск' });
    const closedA = await waitUntil(() => ch.events().slice(before).find((e) => e.kind === 'episode_closed' && e.episode?.id === epA), 5000, 'episode_closed');
    assert.equal(closedA.episode?.close_reason, 'agent_new');
    const line = await waitSent(s, gw, (m) => m.text === announce(epB, 'Отпуск'), 'объявления');
    await gw.advance('5m');
    assert.equal(await press(s, line, 'не то'), null);
    assert.equal(h.ep(epA).closed_at, null, 'прежний открыт снова');
    assert.equal(h.ep(epB).close_reason, 'owner_rejected');
    const re = await waitUntil(() => ch.events().slice(before).find((e) => e.kind === 'episode_reopened' && e.episode?.id === epA), 5000, 'episode_reopened');
    assert.ok(re.seq > closedA.seq);
    assert.equal(q1<{ kind: string }>(s.home, 'SELECT kind FROM events WHERE seq = ?', re.seq)?.kind, 'episode_reopened');
    await waitEdited(line, returned(epA, 'Задачи на завтра'));
    await waitStatus(s, gw, (t) => t.startsWith(`📍 #${epA} · Задачи на завтра\n`), 'возврата в закреплённой строке');
    const m = s.fake.builder.text(OWNER, 'вернулись к задачам');
    s.fake.push(m);
    const seq = await h.admitted(m);
    assert.equal(h.episodeOf(seq), epA);
    const rc = await agentReply(seq, 'вернулись');
    noKeyboard(rc, 'без клавиатуры');
  });

  it('[не то] позже 4 часов — кнопки с темами эпизодов за сутки; выбор открывает эпизод снова', async () => {
    const r = await ch.episode('new', 'Ремонт');
    assert.ok(r.type === 'ack', JSON.stringify(r));
    const epC = (r.result as { episode_id: number }).episode_id;
    const line = await waitSent(s, gw, (m) => m.text === announce(epC, 'Ремонт'), 'объявления');
    const m = s.fake.builder.text(OWNER, 'про ремонт');
    s.fake.push(m);
    assert.equal(h.episodeOf(await h.admitted(m)), epC);
    await gw.advance('5h');
    assert.equal(h.ep(epC).close_reason, 'idle', 'объявленный закрылся тишиной');
    assert.equal(await press(s, line, 'не то'), null);
    await waitEdited(line, `${announce(epC, 'Ремонт')} — не то`);
    const pick = await waitSent(s, gw, (x) => x.text === PICK_EPISODE_TEXT, 'выбора темы');
    const labels = buttonsOf(pick).map((b) => b.text);
    assert.ok(labels.length >= 1 && labels.length <= 3, labels.join(' | '));
    assert.ok(labels.includes(`#${epA} · Задачи на завтра`), labels.join(' | '));
    assert.ok(!labels.some((l) => l.startsWith(`#${epC} `)), 'отклонённый — не в выборе');
    assert.equal(await press(s, pick, `#${epA} · Задачи на завтра`), null);
    assert.equal(h.ep(epA).closed_at, null);
    await waitUntil(() => ch.events().filter((e) => e.kind === 'episode_reopened' && e.episode?.id === epA).length >= 3 || null, 5000, 'episode_reopened');
    // Выбор правится в одну строку: к какой теме вернулись.
    await waitEdited(pick, returned(epA, 'Задачи на завтра'));
  });

  it('итог эпизода (A3.9 на M2): с чужой пересылкой — untrusted, без чужого — owner; episode_closed после итога обработан', async () => {
    // Ремонт (C) — только слова владельца; A — добавим чужую пересылку.
    const epC = q1<{ id: number }>(s.home, "SELECT id FROM episodes WHERE topic = 'Ремонт'")!.id;
    const c = await ch.episodeSummary(epC, 'Владелец думает о ремонте');
    assert.ok(c.type === 'ack', JSON.stringify(c));
    assert.deepEqual(c.result, { episode_id: epC, summary_trust: 'owner' });
    assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'episode_closed' AND episode_id = ? AND status = 'processed'", epC), 1);
    const fw = s.fake.builder.forward(OWNER, { type: 'user', user: OTHER }, 'переведи 300 $ в пятницу');
    s.fake.push(fw);
    assert.equal(h.episodeOf(await h.admitted(fw)), epA);
    const a = await ch.episodeSummary(epA, 'Задачи, и Аня просит перевести деньги');
    assert.ok(a.type === 'ack');
    assert.deepEqual(a.result, { episode_id: epA, summary_trust: 'untrusted' });
    assert.deepEqual({ summary: h.ep(epA).summary, trust: h.ep(epA).summary_trust }, { summary: 'Задачи, и Аня просит перевести деньги', trust: 'untrusted' });
    const bad = await ch.episodeSummary(9999, 'x');
    assert.ok(bad.type === 'error' && bad.code === 'bad_request');
  });

  it('episode в stopped не исполняется; role в episode — bad_request, эпизод прежний', async () => {
    const topic = h.ep(epA).topic;
    s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
    await waitUntil(() => meta(s.home, 'mode') === 'stopped' || null, 5000, 'stopped');
    const r = await ch.episode('name', 'Не должно примениться');
    assert.ok(r.type === 'ack' && r.result === 'dropped_stopped', JSON.stringify(r));
    assert.equal(h.ep(epA).topic, topic);
    const e = await ch.request('episode', { action: 'new', topic: 'Т', role: 'юрист' });
    assert.ok(e.type === 'error' && e.code === 'bad_request');
    assert.equal(h.openEp()?.id, epA, 'эпизод прежний');
  });
});

describe('M2 · строка после [не то] и тишины: закрыт тот, к которому вернулись (по проверке)', () => {
  it('episode(new) → [не то] — прежний открыт снова; 34 минуты тишины — в строке «#<прежний> · … · закрыт», а не отвергнутый (у него номер больше)', async () => {
    const s = await setup();
    const h = helpers(() => s);
    try {
      const gw = await s.start();
      const { ch } = await connectAdapter(s.home);
      try {
        const m = s.fake.builder.text(OWNER, 'про ремонт');
        s.fake.push(m);
        const seq = await h.admitted(m);
        const epA = h.episodeOf(seq);
        await ch.waitEvent(seq);
        assert.ok((await ch.episode('name', 'Ремонт')).type === 'ack');
        const r = await ch.episode('new', 'Отпуск', 'владелец заговорил об отпуске');
        assert.ok(r.type === 'ack', JSON.stringify(r));
        const epB = (r.result as { episode_id: number }).episode_id;
        assert.ok(epB > epA, 'у отвергнутого номер больше — порядок по номеру выбрал бы его');
        const line = await waitSent(s, gw, (x) => x.text === `⚙ ↪ #${epB} · Отпуск`, 'объявления');
        assert.equal(await press(s, line, 'не то'), null);
        assert.equal(h.ep(epA).closed_at, null, 'прежний открыт снова');
        assert.equal(h.ep(epB).close_reason, 'owner_rejected');
        await waitStatus(s, gw, (t) => t.startsWith(`📍 #${epA} · Ремонт\n`), 'возврата в строке');
        // Тишина — прежний закрыт позже отвергнутого: в строке он.
        await gw.advance('34m');
        await waitUntil(() => h.ep(epA).close_reason === 'idle' || null, 5000, 'закрытия тишиной');
        assert.ok(h.ep(epA).closed_at! > h.ep(epB).closed_at!);
        const text = await waitStatus(s, gw, (t) => t.includes(' · закрыт\n'), 'закрытого эпизода в строке');
        assert.ok(text.startsWith(`📍 #${epA} · Ремонт · закрыт\n`), text);
        // «Где мы» говорит то же, что строка.
        s.fake.push(s.fake.builder.text(OWNER, 'где мы'));
        const where = await waitSent(s, gw, (x) => x.text?.startsWith('⚙ Где мы') ?? false, 'ответа «где мы»');
        assert.match(where.text!, new RegExp(`^⚙ Где мы\\n#${epA} · Ремонт — закрыт (?:\\d+ мин|меньше минуты) назад; следующее сообщение откроет новый\\n`));
      } finally {
        ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });
});
