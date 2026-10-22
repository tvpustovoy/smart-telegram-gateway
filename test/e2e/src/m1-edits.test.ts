// A1.13 (Ш-10) — правка принятого; правка текста на «стоп»; правка из закрытой темы; правка от незнакомого:
// событие edit с edit_of; реакции — как у сообщения (0.3.2: ✍ нет): правка записана — реакция
// к прежнему тексту снимается ⟨предл.⟩, отдана агенту — 👀, обработана — 👌; текстовой квитанции правки нет; «стоп» не
// исполнен; закрытая — мимо агента, реакций нет; незнакомое — ignored.
// П-3 — агенту не уходит ничего от незнакомых и из закрытой темы (журнал поддельного переходника). Переходник подключён
// с самого начала: проверяется живая отдача (шаг 7 «уведомить переходник»), а не только то, что лежит в очереди.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FakeChannel } from 'stg-fake-channel';
import { assertNoLoss, connectAdapter, count, pump, q, q1, readJournal, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, STRANGER, botTexts, reactionOf, reactionsOf, setup, waitRecorded, type Setup } from './m1-common.js';

describe('A1.13 · правки', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  let turn = 0;
  before(async () => {
    s = await setup({ home: { extraConfig: 'closed_topics: [77]\nclosed_marker: "тайна"\n' } });
    gw = await s.start();
    ({ ch, turn } = await connectAdapter(s.home));
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  const admittedEvent = (updateId: number): { seq: number; kind: string; edit_of: number | null; status: string; text: string | null } | undefined =>
    q1(s.home, 'SELECT seq, kind, edit_of, status, text FROM events WHERE update_id = ?', updateId);

  it('правка принятого — событие edit с edit_of; правка записана — реакция снята, отдана агенту — 👀, обработана — 👌; ✍ и текстовой квитанции нет', async () => {
    const orig = s.fake.builder.text(OWNER, 'купить молоко');
    s.fake.push(orig);
    const o = await waitUntil(() => admittedEvent(orig.update_id), 5000, 'приёма');
    await waitRecorded(s, gw, orig);
    await ch.waitEvent(o.seq);
    await ch.delivered(o.seq);
    await pump(gw, () => reactionOf(s.fake, orig) === '👀' || null, { what: '👀 — агент увидел' });
    await ch.done([o.seq]);
    await pump(gw, () => reactionOf(s.fake, orig) === '👌' || null, { what: '👌 — обработано' });
    const ed = s.fake.builder.edited(orig, 'купить кефир');
    s.fake.push(ed);
    const ev = await waitUntil(() => admittedEvent(ed.update_id), 5000, 'правки');
    assert.equal(ev.kind, 'edit');
    assert.equal(ev.edit_of, o.seq);
    assert.equal(ev.text, 'купить кефир');
    // Правка записана, агенту ещё не дошла — 👌 к прежнему тексту снят (0.3.2 ⟨предл.⟩); ✍ и текстовой квитанции нет.
    await ch.waitEvent(ev.seq);
    await pump(gw, () => (reactionsOf(s.fake, orig).length === 3 && reactionOf(s.fake, orig) === null) || null, { what: 'снятия реакции на правке' });
    for (let i = 0; i < 3; i++) await gw.advance('1s');
    assert.deepEqual(reactionsOf(s.fake, orig), ['👀', '👌', '']);
    await ch.delivered(ev.seq);
    await pump(gw, () => reactionOf(s.fake, orig) === '👀' || null, { what: '👀 на правке' });
    assert.equal((await ch.reply(ev.seq, 'понял: кефир', turn)).type, 'ack');
    await pump(gw, () => reactionOf(s.fake, orig) === '👌' || null, { what: '👌 на правке' });
    assert.deepEqual(reactionsOf(s.fake, orig), ['👀', '👌', '', '👀', '👌']);
    assert.ok(!botTexts(s.fake).some((t) => t.includes('правка к')), 'текстовой квитанции правки нет');
  });

  it('правка текста на «стоп» — правка, а не команда', async () => {
    const orig = s.fake.builder.text(OWNER, 'привет');
    s.fake.push(orig);
    await waitUntil(() => admittedEvent(orig.update_id), 5000, 'приёма');
    const ed = s.fake.builder.edited(orig, 'стоп');
    s.fake.push(ed);
    const ev = await waitUntil(() => admittedEvent(ed.update_id), 5000, 'правки');
    assert.equal(ev.kind, 'edit');
    assert.equal(ev.status, 'new', 'уходит агенту как правка');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'command'"), 0);
  });

  it('правка сообщения, которого нет в базе, — «правка, исходного нет»', async () => {
    const ghost = s.fake.builder.text(OWNER, 'до шлюза');
    const ed = s.fake.builder.edited(ghost, 'исправлено');
    s.fake.push(ed);
    const ev = await waitUntil(() => admittedEvent(ed.update_id), 5000, 'правки');
    assert.equal(ev.edit_of, null);
    await waitRecorded(s, gw, ed);
    // До отдачи агенту — ничего (0.3.2: ✍ нет; снимать нечего — строки нет); отдана — 👀 на исправленном сообщении.
    assert.equal(q1<{ want: string }>(s.home, 'SELECT want FROM reactions WHERE event_seq = ?', ev.seq), undefined);
    await ch.waitEvent(ev.seq);
    await ch.delivered(ev.seq);
    await pump(gw, () => reactionOf(s.fake, ed) === '👀' || null, { what: '👀 на правке без исходного' });
    assert.equal(q1<{ want: string }>(s.home, 'SELECT want FROM reactions WHERE event_seq = ?', ev.seq)?.want, '👀');
  });

  it('закрытая тема и слово-метка: событие closed_topic, правка — тоже; в базе и журнале текста нет, он в raw/closed/', async () => {
    const inTopic = s.fake.builder.text(OWNER, 'тайное в теме', { thread: { id: 77, isTopic: true } });
    s.fake.push(inTopic);
    const ev = await waitUntil(() => admittedEvent(inTopic.update_id), 5000, 'приёма');
    assert.equal(ev.kind, 'closed_topic');
    assert.equal(ev.status, 'closed_topic');
    assert.equal(ev.text, null);
    const ed = s.fake.builder.edited(inTopic, 'тайное исправлено');
    s.fake.push(ed);
    const evEd = await waitUntil(() => admittedEvent(ed.update_id), 5000, 'правки');
    assert.equal(evEd.kind, 'closed_topic');
    const marked = s.fake.builder.text(OWNER, 'Тайна: личное');
    s.fake.push(marked);
    const evM = await waitUntil(() => admittedEvent(marked.update_id), 5000, 'приёма');
    assert.equal(evM.kind, 'closed_topic');
    const raw = q1<{ raw_ref: string }>(s.home, 'SELECT raw_ref FROM events WHERE seq = ?', evM.seq)!.raw_ref;
    assert.match(raw, /^raw\/closed\/\d{4}-\d{2}-\d{2}\/\d+\.txt$/);
    assert.equal(fs.readFileSync(path.join(s.home.dir, raw), 'utf8'), 'Тайна: личное');
    const journal = JSON.stringify(readJournal(s.home));
    assert.ok(!journal.includes('тайное') && !journal.includes('личное'), 'в журнале нет текста закрытой темы');
    // Агенту закрытая тема не уходит — реакций нет (0.3.2: ✍ нет), текстовой квитанции нет. Правка того же сообщения —
    // тоже ничего.
    await waitRecorded(s, gw, [inTopic, ed, marked], 'записи закрытой темы');
    for (let i = 0; i < 3; i++) await gw.advance('1s');
    for (const u of [inTopic, ed, marked]) assert.deepEqual(reactionsOf(s.fake, u), [], 'на закрытой теме реакций нет');
    assert.ok(!botTexts(s.fake).some((t) => t.includes('тайное') || t.includes('личное')), 'в чате нет текста закрытой темы');
  });

  it('правка от незнакомого — ignored', async () => {
    const orig = s.fake.builder.text(STRANGER, 'чужой текст');
    const ed = s.fake.builder.edited(orig, 'чужая правка');
    s.fake.push(orig, ed);
    await s.fake.waitForOffset(ed.update_id + 1);
    for (const u of [orig, ed]) {
      assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM updates WHERE update_id = ?', u.update_id)?.status, 'ignored');
    }
  });

  it('П-3: переходнику (подключённому всё время) не ушло ничего от незнакомых и из закрытой темы; правки — с edit_of', async () => {
    const total = count(s.home, "SELECT count(*) AS n FROM events WHERE kind IN ('text', 'edit')");
    await waitUntil(() => ch.events().length >= total, 5000, 'событий');
    const evs = ch.events();
    assert.equal(evs.length, total, 'отдано ровно то, что агенту положено');
    assert.ok(evs.every((e) => e.kind !== 'closed_topic'), 'закрытая тема ушла агенту');
    assert.ok(evs.every((e) => e.subject?.who === 'owner'), 'событие не от владельца');
    assert.ok(!JSON.stringify(evs).includes('тайное') && !JSON.stringify(evs).includes('чужой') && !JSON.stringify(evs).includes('личное'));
    const closedSeqs = q<{ seq: number }>(s.home, "SELECT seq FROM events WHERE kind = 'closed_topic'").map((r) => r.seq);
    assert.equal(closedSeqs.length, 3);
    assert.ok(evs.every((e) => !closedSeqs.includes(e.seq)));
    const edits = evs.filter((e) => e.kind === 'edit');
    assert.ok(edits.length >= 3);
    assert.ok(edits.some((e) => e.edit_of !== null));
    ch.close();
    await gw.stop();
    assertNoLoss(s.fake, s.home);
  });
});
