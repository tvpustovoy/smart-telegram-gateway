// M2 · закреплённая строка состояния (J-4; TECH-SPEC 5.7): вверху чата, бот правит её на месте, без новых сообщений:
// - появляется с первым сообщением владельца: отправлена без звука, закреплена без звука, служебное «бот закрепил» удалено;
// - правится на месте не чаще раза в 3 с: пачка сообщений — меньше правок, чем сообщений; между правками ≥ 3 с;
// - «message is not modified» — не ошибка: строка не пересоздаётся;
// - владелец удалил строку — новая и закреплена снова; открепил (сообщение есть) — правится на месте;
// - режим (пауза, стоп) и агент (⚪ → 🟡 → 🟢) — в той же строке; «пауза» ответной строки не даёт.
// По проверке на реальном боте: номер эпизода — «#N», роль по умолчанию («личный ассистент») не показывается, пока
// роль одна; открытого эпизода нет — последний с пометкой «закрыт» (m2-episodes),
// эпизодов не было — «Тем ещё не было».
// 0.3.1 (P-18: кнопки убраны, команды — в меню): нижней клавиатуры и строки
// «⚙ Команды — кнопками внизу» нет — следом за строкой ничего не приходит; новая установка (бот владельцу ещё не писал) —
// снимать нечего, строки снятия нет; база прежней версии (бот уже писал, клавиатура у владельца есть) — при первом
// старте одна строка «⚙ Кнопки убраны — команды в меню ☰» с remove_keyboard, не удаляется; следующий старт — ни одной,
// в том числе когда она при первом старте ещё не ушла (502) и ждала в очереди; «бот уже писал» — и без отметки прежней
// клавиатуры, по одним сообщениям бота владельцу (messages_out).
// Исправления по проверке:
// - владелец написал между отправкой строки и закреплением (его сообщение — «закреплённое + 1», приём медленный):
//   удаляется служебное «бот закрепил» (следующий номер), сообщение владельца — нет;
// - строка не закрепилась (3 попытки) — её не видно: «пауза», «продолжить», «новая тема» отвечают временной строкой,
//   она удаляется через 5 минут.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { KEYBOARD_REMOVED_TEXT } from 'stg-core';
import { makeOggOpus } from 'stg-fake-elevenlabs';
import { errors, reply } from 'stg-fake-telegram';
import { connectAdapter, pump, q, q1, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, chatMessages, hasReplyKeyboard, setup, statusLineOf, waitRecorded, type Setup } from './m1-common.js';

/** Отметка «клавиатура снята» (meta.keyboard_removed): какая строка её сняла; null — отметки нет. */
function keyboardRemovedMeta(s: Setup): { at: number; outbox_id: number | null } | null {
  const raw = q1<{ value: string }>(s.home, "SELECT value FROM meta WHERE key = 'keyboard_removed'")?.value;
  return raw ? (JSON.parse(raw) as { at: number; outbox_id: number | null }) : null;
}

/** Сообщения бота владельцу, снимающие клавиатуру. */
const removals = (s: Setup) => s.fake.sentTo(OWNER.id).filter((x) => x.text === KEYBOARD_REMOVED_TEXT);

describe('M2 · закреплённая строка состояния', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let pinnedId = 0;
  const waitStatus = (pred: (text: string) => boolean, what = 'закреплённой строки'): Promise<string> =>
    pump(gw, () => {
      const st = statusLineOf(s.fake);
      return st && pred(st.text) ? st.text : null;
    }, { what });
  const edits = (): Array<Record<string, unknown>> => readJournal(s.home).filter((l) => l.ev === 'status_line' && l.action === 'edit');

  before(async () => {
    s = await setup();
    gw = await s.start();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('первое сообщение владельца — строка без звука, закреплена без звука, «бот закрепил» удалено; клавиатуры нет (0.3.1); до него строки нет', async () => {
    await gw.advance('5s');
    assert.equal(statusLineOf(s.fake), null, 'шлюз не пишет первым');
    assert.equal(s.fake.sentTo(OWNER.id).length, 0);
    const m = s.fake.builder.text(OWNER, 'первая мысль');
    s.fake.push(m);
    await waitRecorded(s, gw, m);
    const text = await waitStatus((t) => t.startsWith('📍 #'));
    assert.match(text, /^📍 #\d+ · тема не названа\n⚪ · 📥 1$/);
    const st = statusLineOf(s.fake)!;
    pinnedId = st.message.message_id;
    assert.equal(st.message.disable_notification, true, 'строка — без звука');
    assert.equal(st.message.reply_markup, null, 'на самой строке клавиатуры нет — её правят');
    assert.deepEqual(s.fake.pins.map((p) => p.disable_notification), [true], 'закреплена без звука');
    await pump(gw, () => s.fake.wasDeleted(OWNER.id, s.fake.pinNotices[0]!.message_id) || null, { what: 'удаления «бот закрепил»' });
    // Клавиатуры нет (0.3.1, P-18): ни строки «⚙ Команды — кнопками внизу», ни нижней клавиатуры; новая установка — и
    // строки снятия нет: снимать нечего (отметка — без строки).
    for (let i = 0; i < 5; i++) await gw.advance('1s');
    assert.deepEqual(s.fake.sentTo(OWNER.id).map((x) => x.message_id), [pinnedId], 'в чате — только закреплённая строка');
    assert.ok(!s.fake.sentTo(OWNER.id).some(hasReplyKeyboard));
    assert.equal(removals(s).length, 0, 'строки снятия клавиатуры нет — бот владельцу ещё не писал');
    assert.deepEqual(keyboardRemovedMeta(s)?.outbox_id, null, 'отметка снятия — без строки');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'start' && JSON.stringify(l.keyboard_removed) === JSON.stringify({ outbox_id: null, notes_dropped: 0 })));
    // В чате — ни квитанции, ни строки о новом эпизоде: только закреплённая строка.
    assert.deepEqual(chatMessages(s.fake).map((x) => x.text), []);
    const meta = q1<{ value: string }>(s.home, "SELECT value FROM meta WHERE key = 'status_line'");
    assert.equal((JSON.parse(meta!.value) as { message_id: number }).message_id, pinnedId, 'id строки — в meta');
  });

  it('пачка из 6 сообщений — правок меньше, между правками ≥ 3 с; итог — «📥 7»', async () => {
    const before = edits().length;
    for (let i = 0; i < 6; i++) {
      s.fake.push(s.fake.builder.text(OWNER, `мысль ${i}`));
      await gw.advance('300ms');
    }
    await pump(gw, () => statusLineOf(s.fake)?.text.endsWith('📥 7') || null, { step: '500ms', what: '«📥 7»' });
    const list = edits().slice(before);
    assert.ok(list.length >= 1 && list.length < 6, `правок ${list.length}`);
    const times = list.map((l) => Date.parse(String(l.at)));
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= 3000, `между правками ${times[i]! - times[i - 1]!} мс`);
    assert.equal(statusLineOf(s.fake)!.message.message_id, pinnedId, 'та же строка');
    assert.equal(s.fake.pins.length, 1);
  });

  it('«message is not modified» — не ошибка: строка не пересоздаётся', async () => {
    s.fake.scenario({ method: 'editMessageText', when: (p) => Number(p.message_id) === pinnedId, times: 1, reply: errors.notModified() });
    s.fake.push(s.fake.builder.text(OWNER, 'ещё одна'));
    await pump(gw, () => s.fake.calls.some((c) => c.method === 'editMessageText' && Number(c.params.message_id) === pinnedId && c.status === 400) || null, { what: 'ответа «not modified»' });
    for (let i = 0; i < 4; i++) await gw.advance('1s');
    // Правка «не дошла» только в подделке; следующая правка вернёт строку к правде.
    s.fake.push(s.fake.builder.text(OWNER, 'и ещё'));
    await waitStatus((t) => t.endsWith('📥 9'), '«📥 9»');
    assert.equal(s.fake.pins.length, 1, 'новой строки нет');
    assert.ok(!readJournal(s.home).some((l) => l.ev === 'status_line_lost'));
  });

  it('пауза и стоп — в той же строке; агент: ⚪ → 🟡 (отдано, ответа нет) → 🟢 (обработано)', async () => {
    s.fake.push(s.fake.builder.text(OWNER, 'пауза'));
    await waitStatus((t) => /\n⏸ пауза · ⚪/.test(t), 'паузы');
    assert.ok(!chatMessages(s.fake).some((m) => (m.text ?? '').startsWith('⚙ ⏸')), 'строка закреплена — ответа на «пауза» нет');
    s.fake.push(s.fake.builder.text(OWNER, 'продолжить'));
    await waitStatus((t) => /\n⚪ · 📥 \d+$/.test(t), 'снятия паузы');
    const { ch } = await connectAdapter(s.home);
    try {
      // Все ждущие отданы агенту; одно — delivered, ответа нет: «думает».
      const waiting = q<{ seq: number }>(s.home, "SELECT seq FROM events WHERE status IN ('new', 'delivered') AND kind = 'text' ORDER BY seq").map((r) => r.seq);
      assert.ok(waiting.length >= 7, `ждут ${waiting.length}`);
      await waitUntil(() => waiting.every((seq) => ch.events().some((e) => e.seq === seq)) || null, 10_000, 'отдачи ждущих');
      await ch.delivered(waiting[0]!);
      await waitStatus((t) => t.endsWith(`\n🟡 · 📥 ${waiting.length}`), '🟡');
      for (const seq of waiting.slice(1)) await ch.delivered(seq);
      await ch.done(waiting);
      // Всё обработано — 🟢 без «📥».
      await waitStatus((t) => t.endsWith('\n🟢'), '🟢');
    } finally {
      ch.close();
    }
    s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
    await waitStatus((t) => /\n⛔ стоп · /.test(t), 'стопа');
    // «Стоп» — важное: строка с [продолжить] остаётся в чате.
    assert.ok(chatMessages(s.fake).some((m) => m.text === '⚙ Остановлен, сообщения сохраняю'));
  });

  it('владелец открепил строку — она правится на месте и сама не закрепляется; удалил — новая строка, закреплена снова', async () => {
    // Открепил: сообщение есть — правится на месте.
    s.fake.pinned.delete(OWNER.id);
    const pinsBefore = s.fake.pins.length;
    s.fake.push(s.fake.builder.text(OWNER, 'после открепления'));
    await pump(gw, () => {
      const m = s.fake.sentTo(OWNER.id).find((x) => x.message_id === pinnedId)!;
      const t = m.edits.at(-1)?.text ?? m.text ?? '';
      return /📥 \d+$/.test(t) && t.includes('⛔ стоп') && readJournal(s.home).filter((l) => l.ev === 'status_line' && l.action === 'edit').length > 0 ? m : null;
    }, { what: 'правки откреплённой строки' });
    assert.equal(s.fake.pins.length, pinsBefore, 'само не закрепляет');
    // Удалил: править нечего — новая строка, закреплена без звука, «бот закрепил» удалено.
    s.fake.deleteByUser(OWNER.id, pinnedId);
    s.fake.push(s.fake.builder.text(OWNER, 'после удаления'));
    const st = await pump(gw, () => {
      const x = statusLineOf(s.fake);
      return x && x.message.message_id !== pinnedId ? x : null;
    }, { what: 'новой строки' });
    assert.match(st.text, /^📍 #\d+ · тема не названа\n⛔ стоп · ⚪ · 📥 \d+$/);
    assert.equal(st.message.disable_notification, true);
    assert.equal(s.fake.pins.length, pinsBefore + 1);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'status_line_lost' && l.tg_message_id === pinnedId));
    const notice = s.fake.pinNotices.at(-1)!;
    await pump(gw, () => s.fake.wasDeleted(OWNER.id, notice.message_id) || null, { what: 'удаления второго «бот закрепил»' });
    // Новая строка — без клавиатуры и без строки следом (0.3.1).
    assert.ok(!s.fake.sentTo(OWNER.id).some(hasReplyKeyboard));
    assert.equal(removals(s).length, 0);
  });
});

describe('M2 · эпизодов ещё не было: «Тем ещё не было»; правка строки идёт', () => {
  it('первое сообщение — команда: строка «📍 Тем ещё не было», без клавиатуры; затем текст — строка правится на эпизод', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      s.fake.push(s.fake.builder.command(OWNER, '/help'));
      const st = await pump(gw, () => statusLineOf(s.fake), { what: 'строки' });
      assert.equal(st.text, '📍 Тем ещё не было\n⚪');
      const help = await pump(gw, () => s.fake.sentTo(OWNER.id).find((x) => (x.text ?? '').startsWith('⚙ Как устроен чат')), { what: 'ответа /help' });
      assert.equal(help.reply_markup, null, 'у ответа /help разметки нет — ни клавиатуры, ни подсказки');
      // Строку правят (editMessageText), правка проходит, новая строка не заводится.
      const m = s.fake.builder.text(OWNER, 'первая мысль');
      s.fake.push(m);
      await waitRecorded(s, gw, m);
      const text = await pump(gw, () => {
        const x = statusLineOf(s.fake);
        return x && x.text.startsWith('📍 #') ? x.text : null;
      }, { what: 'правки строки на эпизод' });
      assert.match(text, /^📍 #1 · тема не названа\n⚪ · 📥 1$/);
      assert.equal(statusLineOf(s.fake)!.message.message_id, st.message.message_id, 'та же строка — правкой');
      assert.ok(s.fake.calls.some((c) => c.method === 'editMessageText' && Number(c.params.message_id) === st.message.message_id && c.status === 200));
      assert.ok(!readJournal(s.home).some((l) => l.ev === 'status_line_lost'), 'строка не пересоздавалась');
      assert.equal(s.fake.pins.length, 1);
      assert.ok(!s.fake.sentTo(OWNER.id).some(hasReplyKeyboard), 'нижней клавиатуры нет');
      await gw.stop();
    } finally {
      await s.close();
    }
  });
});

describe('M2 · клавиатура прежних версий снимается один раз — при первом старте 0.3.1 (P-18)', () => {
  /**
   * База прежней версии: бот владельцу уже писал, отметки снятия нет. placeholder — была и отметка прежней клавиатуры
   * (keyboard_placeholder); без неё о клавиатуре говорят только сообщения бота в чате владельца (messages_out).
   */
  async function previousVersionHome(placeholder = true): Promise<{ s: Setup; pinned: number }> {
    const s = await setup();
    const g0 = await s.start();
    const m = s.fake.builder.text(OWNER, 'до обновления');
    s.fake.push(m);
    await waitRecorded(s, g0, m);
    const st = await pump(g0, () => statusLineOf(s.fake), { what: 'строки' });
    await g0.stop();
    const db = new DatabaseSync(s.home.paths.db);
    db.prepare("DELETE FROM meta WHERE key = 'keyboard_removed'").run();
    if (placeholder) db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('keyboard_placeholder', '')").run();
    else db.prepare("DELETE FROM meta WHERE key = 'keyboard_placeholder'").run();
    db.close();
    return { s, pinned: st.message.message_id };
  }

  it('первый старт — одна строка «⚙ Кнопки убраны — команды в меню ☰» с remove_keyboard, не удаляется; следующий старт — ни одной', async () => {
    const { s, pinned } = await previousVersionHome();
    try {
      const g1 = await s.start();
      const start = await g1.waitForJournal((l) => l.ev === 'start' && Number(l.pid) === g1.pid);
      const outboxId = (start.keyboard_removed as { outbox_id?: number | null } | undefined)?.outbox_id;
      assert.equal(typeof outboxId, 'number', 'при старте — строка снятия в очереди');
      const line = await pump(g1, () => removals(s)[0], { what: 'строки снятия клавиатуры' });
      assert.deepEqual(line.reply_markup, { remove_keyboard: true });
      assert.equal(keyboardRemovedMeta(s)?.outbox_id, outboxId);
      for (let i = 0; i < 10; i++) await g1.advance('1m');
      await sleep(50);
      assert.equal(removals(s).length, 1, 'одна');
      assert.equal(s.fake.wasDeleted(OWNER.id, line.message_id), false, 'не удаляется ⟨предл.⟩');
      assert.equal(statusLineOf(s.fake)?.message.message_id, pinned, 'строка состояния та же — новой нет');
      assert.equal(s.fake.pins.length, 1);
      // Строка снятия — служебная: реплай владельца на неё — к служебной строке.
      assert.equal(q1<{ kind: string }>(s.home, 'SELECT kind FROM messages_out WHERE tg_message_id = ?', line.message_id)?.kind, 'service');
      await g1.stop();
      const g2 = await s.start();
      const start2 = await g2.waitForJournal((l) => l.ev === 'start' && Number(l.pid) === g2.pid);
      assert.equal(start2.keyboard_removed, undefined, 'отметка есть — снимать больше нечего');
      s.fake.push(s.fake.builder.text(OWNER, 'после второго старта'));
      for (let i = 0; i < 8; i++) await g2.advance('1s');
      await sleep(50);
      assert.equal(removals(s).length, 1, 'второго снятия нет');
      assert.ok(!s.fake.sentTo(OWNER.id).some(hasReplyKeyboard), 'нижней клавиатуры нет ни у одного сообщения');
      await g2.stop();
    } finally {
      await s.close();
    }
  });

  it('отметки прежней клавиатуры нет, но бот владельцу писал (messages_out) — строка снятия уходит, одна', async () => {
    const { s } = await previousVersionHome(false);
    try {
      assert.equal(q1(s.home, "SELECT 1 FROM meta WHERE key = 'keyboard_placeholder'"), undefined, 'отметки прежней клавиатуры нет');
      assert.ok(q1(s.home, 'SELECT 1 FROM messages_out WHERE chat_id = ?', OWNER.id), 'сообщения бота владельцу есть');
      const g1 = await s.start();
      const start = await g1.waitForJournal((l) => l.ev === 'start' && Number(l.pid) === g1.pid);
      assert.equal(typeof (start.keyboard_removed as { outbox_id?: number | null } | undefined)?.outbox_id, 'number');
      const line = await pump(g1, () => removals(s)[0], { what: 'строки снятия клавиатуры' });
      assert.deepEqual(line.reply_markup, { remove_keyboard: true });
      for (let i = 0; i < 5; i++) await g1.advance('1s');
      await sleep(50);
      assert.equal(removals(s).length, 1);
      await g1.stop();
    } finally {
      await s.close();
    }
  });

  it('строка снятия при первом старте не ушла (502) и ждёт в очереди; шлюз перезапущен — она уходит одна, вторая не ставится', async () => {
    const { s } = await previousVersionHome();
    try {
      s.fake.scenario({ method: 'sendMessage', when: (p) => p.text === KEYBOARD_REMOVED_TEXT, times: 1, reply: errors.serverError(502) });
      const g1 = await s.start();
      await pump(g1, () => readJournal(s.home).some((l) => l.ev === 'send_deferred') || null, { step: '200ms', what: 'отложенной отправки' });
      assert.equal(removals(s).length, 0);
      await g1.stop();
      assert.equal(q1<{ n: number }>(s.home, "SELECT count(*) AS n FROM outbox WHERE text = ? AND status = 'pending'", KEYBOARD_REMOVED_TEXT)?.n, 1);
      const g2 = await s.start();
      const start2 = await g2.waitForJournal((l) => l.ev === 'start' && Number(l.pid) === g2.pid);
      assert.equal(start2.keyboard_removed, undefined, 'второй старт строку не ставит');
      await pump(g2, () => removals(s)[0], { what: 'строки снятия после перезапуска' });
      for (let i = 0; i < 8; i++) await g2.advance('1s');
      await sleep(50);
      assert.equal(removals(s).length, 1, 'одна');
      assert.equal(q1<{ n: number }>(s.home, 'SELECT count(*) AS n FROM outbox WHERE text = ?', KEYBOARD_REMOVED_TEXT)?.n, 1, 'в очереди была одна');
      await g2.stop();
    } finally {
      await s.close();
    }
  });
});

describe('M2 · «бот закрепил»: владелец написал между отправкой строки и закреплением', () => {
  it('удаляется служебное (следующий номер), а не сообщение владельца, которое ещё принималось', async () => {
    const s = await setup();
    try {
      s.fake.addFile(makeOggOpus(3), { fileId: 'pinv1', path: 'voice/pinv1.oga' });
      // Скачивание голосового при приёме — 3 с настоящего времени: приём этого сообщения медленный.
      s.fake.scenario({ method: 'getFile', times: 1, reply: reply.delay(3000) });
      const gw = await s.start();
      s.fake.push(s.fake.builder.text(OWNER, 'первая мысль'));
      const st = await waitUntil(() => s.fake.sentTo(OWNER.id).find((m) => (m.text ?? '').startsWith('📍')) || null, 10_000, 'строки состояния');
      assert.equal(s.fake.pins.length, 0, 'закрепления ещё нет: шаг чата ждёт часов');
      const v = s.fake.builder.voice(OWNER, { duration: 3, fileId: 'pinv1' });
      assert.equal(v.message!.message_id, st.message_id + 1, 'голосовое владельца — «закреплённое + 1»');
      s.fake.push(v);
      await waitUntil(() => q1(s.home, "SELECT 1 FROM updates WHERE update_id = ? AND status = 'in_progress'", v.update_id) || null, 5000, 'приёма голосового');
      const notice = await pump(gw, () => s.fake.pinNotices[0], { what: 'закрепления' });
      assert.equal(notice.message_id, st.message_id + 2, 'служебное — после сообщения владельца');
      await pump(gw, () => s.fake.wasDeleted(OWNER.id, notice.message_id) || null, { what: 'удаления «бот закрепил»', timeoutMs: 30_000 });
      assert.equal(s.fake.wasDeleted(OWNER.id, v.message!.message_id), false, 'голосовое владельца не удалено');
      assert.ok(q1(s.home, 'SELECT 1 FROM events WHERE update_id = ?', v.update_id), 'голосовое записано');
      // Отметка в журнале — после ответа Telegram: дождаться её.
      await waitUntil(
        () => readJournal(s.home).some((l) => l.ev === 'deleted' && l.reason === 'pin_notice' && JSON.stringify(l.tg_message_ids) === JSON.stringify([notice.message_id])) || null,
        10_000,
        'записи deleted',
      );
      const j = readJournal(s.home);
      assert.ok(j.some((l) => l.ev === 'pin_notice_shifted' && l.guessed === st.message_id + 1 && l.tg_message_id === notice.message_id), 'pin_notice_shifted');
      await gw.stop();
    } finally {
      await s.close();
    }
  });
});

describe('M2 · строка не закрепилась — «пауза», «продолжить», «новая тема» отвечают временной строкой', () => {
  it('3 попытки закрепить не вышли (pin_failed); ответы на команды — и через 5 минут удаляются', async () => {
    const s = await setup();
    try {
      s.fake.scenario({ method: 'pinChatMessage', reply: reply.error(400, 'Bad Request: not enough rights to manage pinned messages in the chat') });
      const gw = await s.start();
      const m = s.fake.builder.text(OWNER, 'первая мысль');
      s.fake.push(m);
      await waitRecorded(s, gw, m);
      await pump(gw, () => readJournal(s.home).some((l) => l.ev === 'status_pin_failed' && l.attempt === 3) || null, { what: 'трёх попыток закрепить' });
      // Отметка в meta — сразу после записи в журнал: дождаться её.
      await waitUntil(() => {
        const raw = q1<{ value: string }>(s.home, "SELECT value FROM meta WHERE key = 'status_line'")?.value;
        return raw && (JSON.parse(raw) as { pin_failed?: boolean }).pin_failed === true ? true : null;
      }, 10_000, 'pin_failed в meta');
      const line = (text: string) => pump(gw, () => chatMessages(s.fake).find((x) => x.text === text), { what: `«${text}»` });
      s.fake.push(s.fake.builder.text(OWNER, 'пауза'));
      const paused = await line('⚙ ⏸ Пауза: агент отвечает на твои сообщения, сам не пишет');
      assert.equal(paused.reply_markup, null, 'временная строка — без разметки (её удаляют)');
      s.fake.push(s.fake.builder.text(OWNER, 'продолжить'));
      const resumed = await line('⚙ Пауза снята');
      s.fake.push(s.fake.builder.text(OWNER, 'новая тема'));
      const ep = await line('⚙ 🆕 #2 · тема не названа');
      for (const x of [paused, resumed, ep]) assert.equal(s.fake.wasDeleted(OWNER.id, x.message_id), false);
      await pump(gw, () => [paused, resumed, ep].every((x) => s.fake.wasDeleted(OWNER.id, x.message_id)) || null, { step: '30s', what: 'удаления временных строк' });
      await gw.stop();
    } finally {
      await s.close();
    }
  });
});
