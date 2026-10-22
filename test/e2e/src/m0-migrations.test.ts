// A0.4 — миграции: пустая база → текущая версия; повторный запуск шлюза — схема та же, данные не тронуты.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { MIGRATIONS, SCHEMA_TABLES, SCHEMA_VERSION } from 'stg-core';
import { FakeTelegram } from 'stg-fake-telegram';
import { GatewayProcess, TEST_TOKEN, makeHome, openDbRo, testEnv, type TestHome } from './harness.js';

/** Служебные ключи meta, которые шлюз ведёт на каждом старте. */
const BOOKKEEPING = new Set(['clean_shutdown', 'start_history']);

function schemaDump(db: DatabaseSync): string {
  return (db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{ type: string; name: string; sql: string | null }>)
    .map((r) => `${r.type} ${r.name}: ${r.sql ?? ''}`)
    .join('\n');
}

function dataDump(db: DatabaseSync): string {
  return SCHEMA_TABLES.map((t) => {
    let rows = db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all() as Array<Record<string, unknown>>;
    if (t === 'meta') rows = rows.filter((r) => !BOOKKEEPING.has(String(r.key)));
    return `${t}: ${JSON.stringify(rows)}`;
  }).join('\n');
}

describe('A0.4 · миграции', () => {
  let fake: FakeTelegram;
  let home: TestHome;

  before(async () => {
    fake = await FakeTelegram.start({ token: TEST_TOKEN });
    home = makeHome({ apiBase: fake.apiBase, ownerId: 111 });
  });
  after(() => fake.stop());

  it('пустая база → текущая версия со всеми таблицами; повторный запуск — схема та же, данные не тронуты', async () => {
    const g1 = await GatewayProcess.start(home, testEnv(home));
    const open1 = await g1.waitForJournal((l) => l.ev === 'db_open');
    assert.deepEqual(open1.applied, MIGRATIONS.map((m) => m.version));
    assert.equal(open1.migrated_from, 0);
    assert.equal(open1.schema, SCHEMA_VERSION);
    const ex1 = await g1.stop();
    assert.equal(ex1.code, 0, `выход ${JSON.stringify(ex1)}; stderr: ${g1.stderr}`);

    // Данные во всех таблицах — пока шлюз остановлен.
    const db = new DatabaseSync(home.paths.db);
    db.exec(`
      BEGIN;
      INSERT INTO updates(update_id, received_at, status) VALUES (900, 1, 'admitted');
      INSERT INTO updates(update_id, received_at, status, raw_json) VALUES (901, 2, 'deferred', '{"update_id":901}');
      INSERT INTO episodes(chat_id, subject_id, topic, role, space, opened_by, opened_at, last_activity_at)
        VALUES (111, 'owner', 'Задачи на завтра', 'личный ассистент', 'личное', 'first_event', 1, 2);
      INSERT INTO events(update_id, message_id, chat_id, subject_id, trust, kind, text, episode_id, status, created_at)
        VALUES (900, 5, 111, 'owner', 'owner', 'text', 'завтра первым делом…', 1, 'new', 1);
      INSERT INTO outbox(event_seq, chat_id, kind, text, origin, status, created_at) VALUES (1, 111, 'receipt', '№ 1 (эп. 1) записал', 'gateway', 'sent', 1);
      INSERT INTO receipts(event_seq, tg_message_id) VALUES (1, 6);
      INSERT INTO messages_out(chat_id, tg_message_id, kind, outbox_id, event_seq) VALUES (111, 6, 'receipt', 1, 1);
      INSERT INTO buttons(token, kind, created_at, expires_at) VALUES ('t1', 'resume', 1, 2);
      INSERT INTO rules_log(at, actor, change_json, status, button_token) VALUES (1, 'agent', '[]', 'pending', 't1');
      INSERT INTO latency(event_seq, t_update, t_eyes, t_admit, t_receipt) VALUES (1, 1, 2, 3, 4);
      INSERT INTO meta(key, value) VALUES ('offset', '902');
      COMMIT;
    `);
    const schemaBefore = schemaDump(db);
    const dataBefore = dataDump(db);
    db.close();

    const g2 = await GatewayProcess.start(home, testEnv(home));
    const open2 = await g2.waitForJournal((l) => l.ev === 'db_open');
    assert.deepEqual(open2.applied, []);
    assert.equal(open2.migrated_from, SCHEMA_VERSION);
    const ex2 = await g2.stop();
    assert.equal(ex2.code, 0, `выход ${JSON.stringify(ex2)}; stderr: ${g2.stderr}`);

    const ro = openDbRo(home);
    try {
      assert.equal(schemaDump(ro), schemaBefore);
      assert.equal(dataDump(ro), dataBefore);
      assert.equal((ro.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, String(SCHEMA_VERSION));
    } finally {
      ro.close();
    }
  });
});
