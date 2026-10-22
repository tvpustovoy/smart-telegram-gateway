// Сведение 0.3 и 0.3.1 (с 0.3.2 — и миграция v9, с 0.3.3 — v10, с 0.3.4 — v11, с 0.3.5 — v12, с 0.3.6 — v13): первый
// старт на базе шлюза 0.2 (схема v7). База v7 получается из базы этой версии откатом миграций v13, v12, v11, v10, v9 и
// v8 (DROP TABLE conversations и deliveries; ALTER TABLE deletions DROP COLUMN fallback_text; таблица events
// пересобирается в вид v7 — без видов reaction и instructions, reaction_json, hold_until, instructions_json,
// material_json и media_ref; ALTER TABLE outbox DROP
// COLUMN quote, from_name; schema_version = 7) и правкой под
// то, что оставляет работавшая 0.2: клавиатура была (meta.keyboard_placeholder), ✍ 0.2 не ставила,
// голосовое распознано ею — квитанция «№ N (#M) голосовое 0:05 записал: «…»» с [расшифровка] ушла, текст ждёт агента
// (агент не на связи), неушедшая строка «⚙ Команды — кнопками внизу; справка — /help» в очереди.
// Первый старт сведённой версии:
// - миграции v7 → v13 (events.media_ref; с 0.3.2 — outbox.from_name; с 0.3.3 — deliveries; с 0.3.4 — пересборка events
//   с видом reaction и outbox.quote; с 0.3.5 — пересборка events с видом instructions и deletions с причиной topic,
//   conversations; с 0.3.6 — пересборка events с material_json), в db_open — migrated_from 7, applied
//   [8, 9, 10, 11, 12, 13];
// - клавиатура снимается один раз строкой «⚙ Кнопки убраны — команды в меню ☰» с remove_keyboard; строка 0.2 о кнопках —
//   dropped;
// - ✍ записанному 0.2 с 0.3.2 не ставится (R-1 «б»): до 👀 на сообщениях ничего; нового
//   ответа с расшифровкой на распознанное 0.2 голосовое нет (оно уже распознано);
// - [расшифровка] на квитанции 0.2 — по 0.3.1: та же расшифровка ответом на голосовое, только текст;
// - агент подключился — 👀, ответил — 👌; фото после обновления — ничего до 👀, media(seq) пишет media_ref (столбец v8
//   есть);
// - второй старт ничего из этого не повторяет.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { KEYBOARD_REMOVED_TEXT, MIGRATIONS, SCHEMA_VERSION, type Update } from 'stg-core';
import { connectAdapter, count, meta, pump, q1, sleep, waitUntil } from './harness.js';
import { OWNER, isPen, reactionsOf, statusLineOf, waitRecorded } from './m1-common.js';
import { pushVoice, replyTo, sttRepliesOf, sttText, voiceSetup, waitSttReply } from './m4-common.js';
import { imageBytes, jpegBytes, mediaOf } from './m7-common.js';

const LEGACY_NOTE = '⚙ Команды — кнопками внизу; справка — /help';
const FULL = 'завтра первым делом позвонить юристу и потом в банк';

/**
 * Таблица events в виде v7 (0.2): CREATE TABLE из v1 и столбцы v6 и v7 — из самих миграций; пересборка с выключенными
 * внешними ключами, как у v11, только в обратную сторону.
 */
function eventsBackToV7(db: DatabaseSync): void {
  const v1 = /CREATE TABLE events \([\s\S]*?\) STRICT;/.exec(MIGRATIONS.find((m) => m.version === 1)!.sql)![0].replace('CREATE TABLE events (', 'CREATE TABLE events_v7 (');
  const added = MIGRATIONS.filter((m) => m.version === 6 || m.version === 7)
    .flatMap((m) => m.sql.split('\n').filter((l) => l.startsWith('ALTER TABLE events ADD COLUMN')))
    .map((l) => l.replace('ALTER TABLE events ', 'ALTER TABLE events_v7 '));
  const cols = (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map((c) => c.name).filter((c) => c !== 'media_ref' && c !== 'reaction_json' && c !== 'hold_until' && c !== 'instructions_json' && c !== 'material_json');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`BEGIN;
    ${v1}
    ${added.join('\n')}
    INSERT INTO events_v7(${cols.join(', ')}) SELECT ${cols.join(', ')} FROM events;
    DROP TABLE events;
    ALTER TABLE events_v7 RENAME TO events;
    CREATE INDEX events_status ON events(status, seq);
    CREATE INDEX events_message ON events(chat_id, message_id);
    CREATE INDEX events_update ON events(update_id);
    CREATE INDEX events_episode ON events(episode_id);
    COMMIT;`);
  db.exec('PRAGMA foreign_keys = ON');
}

describe('M7 · первый старт сведённой версии (0.3 … 0.3.6) на базе 0.2 (схема v7)', () => {
  it('v7 → v13; клавиатура снята один раз; ✍ записанному 0.2 нет (0.3.2); [расшифровка] 0.2 — ответом по 0.3.1 (с 0.3.4 — цитатой); 👀 и 👌 у агента; фото — media', async () => {
    assert.equal(SCHEMA_VERSION, 13, 'итоговая схема — v13 (0.3.2: outbox.from_name; 0.3.3: deliveries; 0.3.4: events с видом reaction, outbox.quote; 0.3.5: events с видом instructions, deletions.fallback_text, conversations; 0.3.6: events.material_json)');
    const s = await voiceSetup({ fake: { transcript: FULL } });
    try {
      const seqOf = (u: Update): number => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)!.seq;
      // --- 0.2 (её поведение — подделкой и правкой базы) ---
      const g0 = await s.start();
      // 0.2 ✍ не ставила (и 0.3.2 не ставит): запросов ✍ нет; строки реакций потом всё равно убираются.
      const text = s.fake.builder.text(OWNER, 'ждёт агента');
      s.fake.push(text);
      await waitRecorded(s, g0, text);
      await pump(g0, () => statusLineOf(s.fake), { what: 'строки состояния (бот владельцу уже писал)' });
      // Голосовое: 0.2 распознала его сама — здесь распознавание висит, расшифровку пишем правкой базы.
      s.voice.latencyMs = 60_000;
      const voiceU = pushVoice(s, 5);
      await waitRecorded(s, g0, voiceU);
      await waitUntil(() => s.voice.calls.length > 0 || null, 5000, 'запроса распознавания (он висит)');
      await g0.stop();
      assert.ok(!s.fake.callsOf('setMessageReaction').some((c) => isPen(c.params)), '✍ не ставился');
      s.voice.latencyMs = 0;
      const textSeq = seqOf(text);
      const voiceSeq = seqOf(voiceU);
      const receipt = `№ ${voiceSeq} (#1) голосовое 0:05 записал: «завтра первым делом позвонить юристу и потом в…»`;
      const db = new DatabaseSync(s.home.paths.db);
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        // Откат v13 → v7: в v7 нет таблиц conversations (v12) и deliveries (v10), столбца deletions.fallback_text (v12),
        // видов reaction и instructions, столбцов events.material_json (v13), events.instructions_json, events.reaction_json,
        // events.hold_until, events.media_ref, outbox.quote и outbox.from_name.
        db.exec('DROP TABLE conversations; DROP TABLE deliveries; ALTER TABLE deletions DROP COLUMN fallback_text;');
        eventsBackToV7(db);
        db.exec("ALTER TABLE outbox DROP COLUMN quote; ALTER TABLE outbox DROP COLUMN from_name; UPDATE meta SET value = '7' WHERE key = 'schema_version';");
        db.prepare("DELETE FROM meta WHERE key = 'keyboard_removed'").run();
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('keyboard_placeholder', '')").run();
        db.prepare('DELETE FROM reactions').run();
        db.prepare('UPDATE latency SET t_receipt = NULL').run();
        // Голосовое распознала 0.2: расшифровка, статус new; квитанция с [расшифровка] ушла.
        db.prepare("UPDATE events SET status = 'new', transcript = ? WHERE seq = ?").run(FULL, voiceSeq);
        const ins = db.prepare("INSERT INTO outbox(event_seq, chat_id, kind, text, origin, status, created_at, bare) VALUES (?, ?, ?, ?, 'gateway', ?, 0, ?)");
        const r = ins.run(voiceSeq, OWNER.id, 'receipt', receipt, 'sent', 1);
        db.prepare('INSERT INTO receipts(event_seq, tg_message_id) VALUES (?, ?)').run(voiceSeq, 900_001);
        db.prepare("INSERT INTO messages_out(chat_id, tg_message_id, kind, outbox_id, event_seq) VALUES (?, 900001, 'receipt', ?, ?)").run(OWNER.id, Number(r.lastInsertRowid), voiceSeq);
        db.prepare("INSERT INTO buttons(token, kind, payload_json, created_at, expires_at) VALUES ('v02-transcript', 'transcript', ?, 0, ?)").run(
          JSON.stringify({ group: 'g-v02', event_seq: voiceSeq }),
          Number.MAX_SAFE_INTEGER,
        );
        ins.run(null, OWNER.id, 'service', LEGACY_NOTE, 'pending', 0);
        const cols = (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map((c) => c.name);
        assert.ok(!cols.includes('media_ref'), 'база v7 — без media_ref');
      } finally {
        db.close();
      }
      const backlog = count(s.home, "SELECT count(*) AS n FROM events WHERE status IN ('new', 'transcribing') AND message_id IS NOT NULL AND kind IN ('text', 'voice', 'photo', 'document', 'edit', 'closed_topic')");
      assert.equal(backlog, 2, 'текст и голосовое ждут агента');
      assert.deepEqual([reactionsOf(s.fake, text), reactionsOf(s.fake, voiceU)], [[], []], '0.2 ✍ не ставила');

      // --- Первый старт сведённой версии ---
      const g1 = await s.start();
      const open = await g1.waitForJournal((l) => l.ev === 'db_open' && l.migrated_from === 7);
      assert.deepEqual({ applied: open.applied, schema: open.schema }, { applied: [8, 9, 10, 11, 12, 13], schema: 13 });
      const start = await g1.waitForJournal((l) => l.ev === 'start' && Number(l.pid) === g1.pid);
      const kr = start.keyboard_removed as { outbox_id: number | null; notes_dropped: number; recorded_backlog?: number };
      assert.equal(typeof kr.outbox_id, 'number', 'строка снятия клавиатуры в очереди');
      assert.deepEqual({ notes: kr.notes_dropped, backlog: kr.recorded_backlog }, { notes: 1, backlog: undefined });
      assert.equal(meta(s.home, 'schema_version'), '13');
      const removal = await pump(g1, () => s.fake.sentTo(OWNER.id).find((m) => m.text === KEYBOARD_REMOVED_TEXT), { what: 'строки снятия клавиатуры' });
      assert.deepEqual(removal.reply_markup, { remove_keyboard: true });
      for (let i = 0; i < 5; i++) await g1.advance('1s');
      await sleep(50);
      assert.deepEqual([reactionsOf(s.fake, text), reactionsOf(s.fake, voiceU)], [[], []], '✍ записанному 0.2 нет (0.3.2)');
      assert.equal(s.fake.sentTo(OWNER.id).filter((m) => m.text === LEGACY_NOTE).length, 0, 'строка 0.2 о кнопках не ушла');
      assert.equal(sttRepliesOf(s, voiceU).length, 0, 'распознанное 0.2 голосовое нового ответа не получает');
      assert.ok(!s.fake.sentTo(OWNER.id).some((m) => !!(m.reply_markup as { keyboard?: unknown } | null)?.keyboard), 'нижней клавиатуры нет ни у одного сообщения');

      // [расшифровка] на квитанции 0.2 — по 0.3.1: та же расшифровка ответом на голосовое, только текст.
      const line = statusLineOf(s.fake)!;
      const old = { ...line.message.message, text: receipt };
      const [cb] = s.fake.push(s.fake.builder.callback(OWNER, 'v02-transcript', old));
      const answered = await waitUntil(() => s.fake.callbackAnswers.find((x) => x.callback_query_id === cb!.callback_query!.id), 10_000, 'ответа на нажатие');
      assert.equal(answered.text, null, 'нажатие засчитано');
      const [byButton] = await waitSttReply(s, g1, voiceU, 1, 'расшифровки по кнопке 0.2');
      assert.deepEqual({ text: sttText(byButton!), reply: byButton!.reply_parameters, markup: byButton!.reply_markup }, { text: FULL, reply: replyTo(voiceU), markup: null });

      // Агент подключился: 👀 — увидел, 👌 — ответил.
      const { ch, turn } = await connectAdapter(s.home);
      try {
        const n = await ch.waitEvent(voiceSeq, 15_000);
        assert.equal(n.transcript, FULL);
        await ch.waitEvent(textSeq, 15_000);
        await ch.delivered(textSeq);
        await ch.delivered(voiceSeq);
        await pump(g1, () => (reactionsOf(s.fake, text).at(-1) === '👀' && reactionsOf(s.fake, voiceU).at(-1) === '👀') || null, { what: '👀' });
        assert.ok((await ch.reply(voiceSeq, 'Позвоню юристу', turn)).type === 'ack');
        await ch.done([textSeq]);
        await pump(g1, () => (reactionsOf(s.fake, text).at(-1) === '👌' && reactionsOf(s.fake, voiceU).at(-1) === '👌') || null, { what: '👌' });
        assert.deepEqual([reactionsOf(s.fake, text), reactionsOf(s.fake, voiceU)], [['👀', '👌'], ['👀', '👌']]);

        // Фото после обновления: до 👀 ничего; media(seq) скачивает картинку и пишет media_ref — столбец v8 есть.
        const jpeg = jpegBytes(1280, 960, 9000, 5);
        s.fake.addFile(jpeg, { fileId: 'v7photo', path: 'photos/v7.jpg' });
        const photo = s.fake.builder.photo(OWNER, 'скриншот после обновления', { sizes: [{ fileId: 'v7photo', width: 1280, height: 960, fileSize: jpeg.length }] });
        s.fake.push(photo);
        await waitRecorded(s, g1, photo);
        const photoSeq = seqOf(photo);
        await ch.waitEvent(photoSeq, 15_000);
        const m = await mediaOf(ch, photoSeq);
        assert.ok(m.ok, JSON.stringify(m));
        assert.deepEqual(imageBytes(m.r), jpeg);
        assert.match(q1<{ media_ref: string | null }>(s.home, 'SELECT media_ref FROM events WHERE seq = ?', photoSeq)?.media_ref ?? '', /\.media\.jpg$/);
        await ch.done([photoSeq]);
      } finally {
        ch.close();
      }
      await g1.stop();

      // --- Второй старт: ни миграции, ни строки снятия, ни ✍ ---
      const g2 = await s.start();
      const open2 = await g2.waitForJournal((l) => l.ev === 'db_open' && l.migrated_from === 13);
      assert.deepEqual(open2.applied, []);
      const start2 = await g2.waitForJournal((l) => l.ev === 'start' && Number(l.pid) === g2.pid);
      assert.equal(start2.keyboard_removed, undefined);
      for (let i = 0; i < 5; i++) await g2.advance('1s');
      await sleep(50);
      assert.equal(s.fake.sentTo(OWNER.id).filter((m) => m.text === KEYBOARD_REMOVED_TEXT).length, 1, 'строка снятия — одна');
      assert.ok(!s.fake.callsOf('setMessageReaction').some((c) => isPen(c.params)), '✍ нет и на втором старте');
      await g2.stop();
    } finally {
      await s.close();
    }
  });
});
