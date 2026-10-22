// M1 · основной путь: владелец пишет → событие → offset; на сообщении ничего, пока агент не увидел (0.3.2: ✍ нет);
// переходник берёт аренду, получает событие — 👀 «агент увидел», отвечает — 👌 (A1.20); ответ
// агента — чистым текстом, без 💬 (P-26), с 💬 — только начатый со знака шлюза (П-4); незнакомый —
// молчание (A1.4); до старта лежат 5
// обновлений (A1.2); повтор и номер ниже offset (A1.3); команда и нажатие владельца — события handled мимо агента,
// сообщение с командой удалено (положительная проверка к A1.5/A1.13: там проверено, что чужое и правка командой не
// становятся); П-1…П-4.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AGENT_MARK, STOPPED_TEXT } from 'stg-core';
import { assertNoLoss, assertNoToken, connectAdapter, count, meta, pump, q, q1, readJournal, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, STRANGER, chatMessages, reactionsOf, setup, waitRecorded, type Setup } from './m1-common.js';

describe('M1 · приём: основной путь', () => {
  let s: Setup;
  let gw: GatewayProcess;
  const preIds: number[] = [];
  const handledSeqs: number[] = [];

  before(async () => {
    s = await setup();
    // A1.2: до старта шлюза в подделке лежат 5 обновлений.
    for (let i = 1; i <= 5; i++) preIds.push(s.fake.push(s.fake.builder.text(OWNER, `до старта ${i}`))[0]!.update_id);
    gw = await s.start();
  });

  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('A1.2: все 5 приняты, ни одно не сброшено; offset = последний + 1; агента нет — 👀 нет', async () => {
    await s.fake.waitForOffset(preIds[4]! + 1);
    const rows = q<{ update_id: number; status: string }>(s.home, 'SELECT update_id, status FROM updates ORDER BY update_id');
    assert.deepEqual(rows.map((r) => r.update_id), preIds);
    assert.ok(rows.every((r) => r.status === 'admitted'));
    assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'text'"), 5);
    assert.equal(Number(meta(s.home, 'offset')), preIds[4]! + 1);
    for (const id of preIds) assert.deepEqual(reactionsOf(s.fake, s.fake.history.get(id)!), [], `${id}: агента нет — реакций нет`);
  });

  it('«записал» — запись (COMMIT), агента для этого не нужно; ✍ и текстовых квитанций нет; t_admit (L-2) у каждого, реакций нет (0.3.2)', async () => {
    const us = preIds.map((id) => s.fake.history.get(id)!);
    await waitRecorded(s, gw, us);
    for (let i = 0; i < 12; i++) await gw.advance('1s');
    for (const u of us) assert.deepEqual(reactionsOf(s.fake, u), [], `${u.update_id}`);
    assert.equal(s.fake.callsOf('setMessageReaction').length, 0, '✍ нет');
    assert.ok(!chatMessages(s.fake).some((m) => /^№ \d/.test(m.text ?? '')), 'текстовая квитанция');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM outbox WHERE kind = 'receipt'"), 0);
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM reactions'), 0, 'строк реакций нет');
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM latency WHERE t_admit >= t_update AND t_receipt IS NULL AND t_eyes IS NULL'), 5);
  });

  it('A1.4: незнакомый — событие не создано, ответа нет, счётчик +1, raw_json не записан', async () => {
    const calls = s.fake.calls.length;
    const [u] = s.fake.push(s.fake.builder.text(STRANGER, 'секрет незнакомца'));
    await s.fake.waitForOffset(u!.update_id + 1);
    const row = q1<{ status: string; raw_json: string | null }>(s.home, 'SELECT status, raw_json FROM updates WHERE update_id = ?', u!.update_id);
    assert.deepEqual({ ...row }, { status: 'ignored', raw_json: null });
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', u!.update_id), 0);
    assert.equal(meta(s.home, 'ignored_count'), '1');
    const after1 = s.fake.calls.slice(calls).filter((c) => c.method !== 'getUpdates');
    assert.deepEqual(after1.map((c) => c.method), [], 'ни реакции, ни ответа');
    assert.ok(!JSON.stringify(readJournal(s.home)).includes('секрет незнакомца'));
  });

  it('A1.3: повтор принятого — второго события нет; новый номер ниже offset — принят', async () => {
    const id = preIds[2]!;
    s.fake.redeliver(id);
    await gw.waitForJournal((l) => l.ev === 'update_repeat' && l.update_id === id);
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', id), 1);
    const low = { ...s.fake.builder.text(OWNER, 'после недели тишины'), update_id: 42 };
    s.fake.pushForced(low);
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = 42') === 1, 10_000, 'приёма номера ниже offset');
    assert.equal(meta(s.home, 'offset'), '43', 'offset — последний полученный + 1, а не максимум');
    // Ещё ниже — от незнакомого: offset тоже ровно его номер + 1 (5.2), а не «только вперёд».
    const lowStranger = { ...s.fake.builder.text(STRANGER, 'спам'), update_id: 30 };
    s.fake.pushForced(lowStranger);
    await waitUntil(() => q1(s.home, "SELECT 1 FROM updates WHERE update_id = 30 AND status = 'ignored'"), 10_000, 'незнакомого с меньшим номером');
    await waitUntil(() => meta(s.home, 'offset') === '31' || null, 5000, 'offset = 31');
  });

  it('команда «стоп» и нажатие владельца — события handled: без квитанции, агенту не уходят, нажатию — answerCallbackQuery', async () => {
    const [stop] = s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
    const cmd = await waitUntil(
      () => q1<{ seq: number; kind: string; status: string; trust: string }>(s.home, 'SELECT seq, kind, status, trust FROM events WHERE update_id = ?', stop!.update_id),
      5000,
      'команды',
    );
    assert.deepEqual({ kind: cmd.kind, status: cmd.status, trust: cmd.trust }, { kind: 'command', status: 'handled', trust: 'owner' });
    for (const text of ['/stop', 'Стоп ']) {
      const [u] = s.fake.push(s.fake.builder.text(OWNER, text));
      const e = await waitUntil(() => q1<{ kind: string }>(s.home, 'SELECT kind FROM events WHERE update_id = ?', u!.update_id), 5000, text);
      assert.equal(e.kind, 'command', text);
    }
    // Сообщение владельца с командой удалено после исполнения (J-4: нажатие не засоряет чат).
    await pump(gw, () => s.fake.wasDeleted(OWNER.id, stop!.message!.message_id) || null, { what: 'удаления команды' });
    assert.deepEqual(reactionsOf(s.fake, stop!), [], 'на команде реакций нет');
    // Нажатие владельца на кнопку, которой шлюз не выдавал, — нажатие записано, отказ «истёк срок», ответ ровно один.
    const receipt = await pump(gw, () => s.fake.sentTo(OWNER.id)[0], { what: 'сообщения бота' });
    const [press] = s.fake.push(s.fake.builder.callback(OWNER, 'confirm:x', receipt.message));
    const cb = await waitUntil(
      () => q1<{ seq: number; kind: string; status: string; text: string }>(s.home, 'SELECT seq, kind, status, text FROM events WHERE update_id = ?', press!.update_id),
      5000,
      'нажатия',
    );
    assert.deepEqual({ kind: cb.kind, status: cb.status, text: cb.text }, { kind: 'callback', status: 'handled', text: 'confirm:x' });
    const ans = await waitUntil(() => s.fake.callbackAnswers.find((a) => a.callback_query_id === press!.callback_query!.id), 5000, 'answerCallbackQuery');
    assert.equal(ans.text, 'истёк срок');
    assert.equal(s.fake.callsOf('answerCallbackQuery').filter((c) => c.params.callback_query_id === press!.callback_query!.id).length, 1, 'ровно один ответ на нажатие');
    // M2: «стоп» исполнен — снять его можно только кнопкой [продолжить] под строкой «Остановлен».
    const stopLine = await pump(gw, () => s.fake.sentTo(OWNER.id).filter((m) => m.text === STOPPED_TEXT).at(-1), { what: 'строки «Остановлен»' });
    const token = (stopLine.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data;
    const [resume] = s.fake.push(s.fake.builder.callback(OWNER, token, stopLine.message));
    await waitUntil(() => meta(s.home, 'mode') === 'running' || null, 5000, 'снятия стопа');
    await waitUntil(() => s.fake.callbackAnswers.find((a) => a.callback_query_id === resume!.callback_query!.id), 5000, 'ответа на [продолжить]');
    // Нажатие незнакомого — ignored, без ответа.
    const [alien] = s.fake.push(s.fake.builder.callback(STRANGER, 'confirm:y', receipt.message));
    await waitUntil(() => q1(s.home, "SELECT 1 FROM updates WHERE update_id = ? AND status = 'ignored'", alien!.update_id), 5000, 'чужого нажатия');
    assert.equal(s.fake.callsOf('answerCallbackQuery').filter((c) => c.params.callback_query_id === alien!.callback_query!.id).length, 0);
    // Квитанций на команды и нажатия нет (ответные строки шлюза — служебные).
    const handled = q<{ seq: number }>(s.home, "SELECT seq FROM events WHERE status = 'handled'").map((r) => r.seq);
    assert.equal(handled.length, 5);
    assert.equal(count(s.home, `SELECT count(*) AS n FROM outbox WHERE kind = 'receipt' AND event_seq IN (${handled.join(',')})`), 0, 'квитанций на команды и нажатия нет');
    assert.equal(count(s.home, `SELECT count(*) AS n FROM reactions WHERE event_seq IN (${handled.join(',')})`), 0, 'реакций на команды и нажатия нет');
    handledSeqs.push(...handled);
  });

  it('A1.20: каркас сокета — hello → event → delivered → reply(seq) → ответ в Telegram, событие processed', async () => {
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const first = await ch.waitEvent(1);
      assert.equal(first.trust, 'owner');
      assert.equal(first.text, 'до старта 1');
      assert.equal(first.episode?.topic, 'Новая тема');
      assert.equal(first.episode?.role, 'личный ассистент');
      assert.equal(first.episode?.new, true);
      // Все ожидающие — по порядку; команды и нажатия переходнику не уходят.
      const waiting = count(s.home, "SELECT count(*) AS n FROM events WHERE status = 'new' AND kind IN ('text', 'voice', 'photo', 'document', 'edit')");
      await waitUntil(() => ch.events().length >= waiting, 5000, 'событий');
      const seqs = ch.events().map((e) => e.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
      assert.ok(handledSeqs.length > 0 && handledSeqs.every((sq) => !seqs.includes(sq)), 'команда или нажатие ушли переходнику');
      assert.ok(ch.events().every((e) => e.kind !== 'command' && e.kind !== 'callback'));
      const d = await ch.delivered(1);
      assert.equal(d.type, 'ack');
      assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = 1')?.status, 'delivered');
      // delivered — агент увидел: 👀 на сообщении владельца (0.3.2).
      const firstUpdate = s.fake.history.get(preIds[0]!)!;
      await pump(gw, () => reactionsOf(s.fake, firstUpdate).at(-1) === '👀' || null, { what: '👀 после delivered' });
      const r = await ch.reply(1, '**Записал** в заметки', turn);
      assert.ok(r.type === 'ack' && r.result === 'queued', JSON.stringify(r));
      // Ответ агента — чистым текстом (0.3.2, P-26: ответу самого агента значок не нужен).
      const sent = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text?.includes('Записал')), { what: 'ответа агента' });
      assert.equal(sent.text, '<b>Записал</b> в заметки');
      assert.equal(sent.parse_mode, 'HTML');
      assert.deepEqual(sent.link_preview_options, { is_disabled: true });
      // На давнее сообщение (после него были другие) — реплаем (5.5а).
      assert.deepEqual(sent.reply_parameters, { message_id: q1<{ message_id: number }>(s.home, 'SELECT message_id FROM events WHERE seq = 1')!.message_id, allow_sending_without_reply: true });
      assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = 1')?.status, 'processed');
      // Ответ = обработано: на сообщении владельца 👌 — агент ответил.
      await pump(gw, () => reactionsOf(s.fake, firstUpdate).at(-1) === '👌' || null, { what: '👌 после ответа' });
      assert.deepEqual(reactionsOf(s.fake, firstUpdate), ['👀', '👌']);
      // Отметка об отправке пишется после ответа Telegram.
      await waitUntil(() => q1(s.home, 'SELECT 1 FROM messages_out WHERE tg_message_id = ?', sent.message_id), 5000, 'messages_out');
      assert.equal(q1<{ kind: string }>(s.home, 'SELECT kind FROM messages_out WHERE tg_message_id = ?', sent.message_id)?.kind, 'agent');
      // done — материал без ответа.
      const dn = await ch.done([2, 3]);
      assert.equal(dn.type, 'ack');
      assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE seq IN (2, 3) AND status = 'processed' AND processed_silent = 1"), 2);
      // done — тоже «обработано»: 👌 (delivered на № 2 переходник не прислал — 👀 не было, сразу 👌).
      const done2 = s.fake.history.get(preIds[1]!)!;
      await pump(gw, () => reactionsOf(s.fake, done2).at(-1) === '👌' || null, { what: '👌 после done' });
      assert.deepEqual(reactionsOf(s.fake, done2), ['👌']);
      // Неизвестный №.
      const bad = await ch.reply(9999, 'x', turn);
      assert.ok(bad.type === 'error' && bad.code === 'unknown_seq');
      // Вторая сессия при занятой аренде — busy.
      const second = await connectAdapter(s.home).catch((e: Error) => e);
      assert.ok(second instanceof Error && /busy/.test(second.message), String(second));
    } finally {
      ch.close();
    }
    // Аренда снята — отданное без «обработано» снова new.
    await waitUntil(() => count(s.home, "SELECT count(*) AS n FROM events WHERE status = 'delivered'") === 0, 5000, 'возврата в new');
  });

  it('П-4 (0.3.2, P-26): ответ агента — чистым текстом; начатый со знака шлюза ⚙ 📍 № ↪ 💬 (и за невидимыми знаками) — с 💬; 👀 — без; строки шлюза с 💬 не начинаются', async () => {
    // По проверке 0.3.2: невидимое в начале — и классами Юникода (CGJ, теги, заполнители хангыля, пустой Брайль).
    const hidden = ['\u034F⚙ за CGJ', '\u{E0020}⚙ за тегом', '\u3164⚙ за заполнителем', '\u2800⚙ за Брайлем'];
    const marked = ['⚙ Остановлен', '📍 #3 · тема', '№ 5 записал', '↪ Помощник: всё сделано', '💬 уже с меткой', '\u200B⚙ за невидимым', '**⚙ жирным**', ...hidden, '**\u3164**⚙ жирный заполнитель'];
    const plain = ['👀 смотрю', 'просто ответ', '(1/2) не метка'];
    const { ch, turn } = await connectAdapter(s.home);
    try {
      for (const p of [...marked, ...plain]) {
        const r = await ch.reply(null, p, turn);
        assert.ok(r.type === 'ack' && r.result === 'queued');
      }
      await pump(gw, () => count(s.home, "SELECT count(*) AS n FROM outbox WHERE status = 'pending'") === 0, { what: 'отправки' });
    } finally {
      ch.close();
    }
    const kinds = q<{ kind: string; tg_message_id: number }>(s.home, 'SELECT kind, tg_message_id FROM messages_out');
    const byId = new Map(kinds.map((k) => [k.tg_message_id, k.kind]));
    for (const m of s.fake.sentTo(OWNER.id)) {
      if (byId.get(m.message_id) !== 'agent') assert.ok(!m.text!.startsWith(AGENT_MARK), `строка шлюза начинается с 💬: ${m.text}`);
    }
    const agent = s.fake.sentTo(OWNER.id).filter((m) => byId.get(m.message_id) === 'agent').map((m) => m.text);
    for (const p of ['⚙ Остановлен', '📍 #3 · тема', '№ 5 записал', '↪ Помощник: всё сделано', '💬 уже с меткой', '\u200B⚙ за невидимым', '<b>⚙ жирным</b>', ...hidden, '<b>\u3164</b>⚙ жирный заполнитель']) {
      assert.ok(agent.includes(`💬 ${p}`), `нет «💬 ${p}»: ${JSON.stringify(agent)}`);
    }
    for (const p of plain) assert.ok(agent.includes(p), `ответ «${p}» — без пометки: ${JSON.stringify(agent)}`);
  });

  it('П-1, П-2, П-3: ничего не потеряно; токен нигде не записан; незнакомое агенту не ушло', async () => {
    await gw.stop();
    assertNoLoss(s.fake, s.home);
    assertNoToken(s.home);
    // П-3: в журнале отдачи нет события от незнакомого — у незнакомого вовсе нет события.
    assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE subject_id IS NULL AND kind IN ('text','voice','photo','document','edit')"), 0);
  });
});
