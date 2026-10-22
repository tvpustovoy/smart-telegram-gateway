import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  DbError,
  getMeta,
  inspectDatabase,
  isDiskFullError,
  setTransactionHooks,
  migrate,
  missingTables,
  openDatabase,
  openForGateway,
  quickCheck,
  schemaVersion,
  setMeta,
  transaction,
  type Db,
} from './db.js';
import {
  DELETION_REASONS,
  DELIVERY_STATUSES,
  EPISODE_CLOSE_REASONS,
  EPISODE_OPENED_BY,
  EVENT_KINDS,
  EDIT_STATUSES,
  EVENT_STATUSES,
  MESSAGE_OUT_KINDS,
  MIGRATIONS,
  OUTBOX_ORIGINS,
  OUTBOX_STATUSES,
  RULES_LOG_STATUSES,
  SCHEMA_TABLES,
  SCHEMA_VERSION,
  SUMMARY_TRUST,
  TRUST_LABELS,
  UPDATE_STATUSES,
} from './schema.js';

/** Временные каталоги этого файла тестов — удаляются после него. */
const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function tmpDb(): string {
  const dir = tmpDir('stg-db-');
  return path.join(dir, 'gateway.db');
}

function schemaDump(db: Db): string {
  return (
    db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{
      type: string;
      name: string;
      sql: string | null;
    }>
  )
    .map((r) => `${r.type} ${r.name}: ${r.sql ?? ''}`)
    .join('\n');
}

function tableSql(db: Db, table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
  return row.sql;
}

/** Список значений из CHECK (col IN (...)) в тексте CREATE TABLE. */
function checkValues(sql: string, column: string): string[] {
  const re = new RegExp(`\\b${column}\\b[^\\n]*?CHECK \\(${column} IN \\(([^)]*)\\)\\)`);
  const m = re.exec(sql);
  assert.ok(m && m[1] !== undefined, `нет CHECK для ${column}`);
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

function insertSample(db: Db): void {
  transaction(db, () => {
    db.prepare("INSERT INTO subjects(id, who, world_ref) VALUES ('owner', 'owner', 'wm:anna')").run();
    db.prepare("INSERT INTO transports(subject_id, network, address) VALUES ('owner', 'telegram', '123456789')").run();
    db.prepare("INSERT INTO updates(update_id, received_at, status) VALUES (1, 1000, 'admitted')").run();
    db.prepare(
      "INSERT INTO episodes(chat_id, subject_id, topic, role, space, opened_by, opened_at, last_activity_at) VALUES (123456789, 'owner', 'Новая тема', 'личный ассистент', 'личное', 'first_event', 1000, 1000)",
    ).run();
    db.prepare(
      "INSERT INTO events(update_id, message_id, chat_id, subject_id, trust, kind, text, episode_id, status, created_at) VALUES (1, 10, 123456789, 'owner', 'owner', 'text', 'завтра первым делом', 1, 'new', 1000)",
    ).run();
    db.prepare(
      "INSERT INTO outbox(event_seq, chat_id, kind, text, origin, status, created_at) VALUES (1, 123456789, 'receipt', '№ 1 (эп. 1) записал', 'gateway', 'sent', 1000)",
    ).run();
    db.prepare('INSERT INTO receipts(event_seq, tg_message_id) VALUES (1, 11)').run();
    db.prepare("INSERT INTO messages_out(chat_id, tg_message_id, kind, outbox_id, event_seq) VALUES (123456789, 11, 'receipt', 1, 1)").run();
    db.prepare("INSERT INTO buttons(token, kind, created_at, expires_at) VALUES ('tok', 'resume', 1000, 2000)").run();
    db.prepare("INSERT INTO rules_log(at, actor, change_json, status, button_token) VALUES (1000, 'agent', '[]', 'pending', 'tok')").run();
    db.prepare('INSERT INTO latency(event_seq, t_update, t_eyes) VALUES (1, 1000, 1100)').run();
    setMeta(db, 'offset', '2');
  });
}

function dataDump(db: Db): string {
  return SCHEMA_TABLES.map((t) => `${t}: ${JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all())}`).join('\n');
}

describe('база: открытие', () => {
  it('PRAGMA из 5.2: WAL, synchronous=FULL, fullfsync, checkpoint_fullfsync, внешние ключи', () => {
    const db = openDatabase(tmpDb());
    try {
      assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
      assert.equal((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous, 2);
      assert.equal((db.prepare('PRAGMA fullfsync').get() as { fullfsync: number }).fullfsync, 1);
      assert.equal((db.prepare('PRAGMA checkpoint_fullfsync').get() as { checkpoint_fullfsync: number }).checkpoint_fullfsync, 1);
      assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    } finally {
      db.close();
    }
  });

  it('файл не SQLite — DbError not_a_database; обрезанный — corrupt', () => {
    const f = tmpDb();
    fs.writeFileSync(f, 'это не база '.repeat(200));
    assert.throws(() => openForGateway(f), (e: unknown) => e instanceof DbError && e.kind === 'not_a_database');

    const g = tmpDb();
    const { db } = openForGateway(g);
    const ins = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    transaction(db, () => {
      for (let i = 0; i < 3000; i++) ins.run(`k${i}`, 'x'.repeat(300));
    });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    fs.truncateSync(g, Math.floor(fs.statSync(g).size / 2));
    assert.throws(() => openForGateway(g), (e: unknown) => e instanceof DbError && e.kind === 'corrupt');
    const ins2 = inspectDatabase(g);
    assert.equal(ins2.ok, false);
  });

  it('на чтение: нет файла — missing, файл не создаётся', () => {
    const f = tmpDb();
    assert.throws(() => openDatabase(f, { readOnly: true }), (e: unknown) => e instanceof DbError && e.kind === 'missing');
    assert.equal(fs.existsSync(f), false);
    assert.equal(inspectDatabase(f).error?.kind, 'missing');
  });
});

describe('база: миграции (A0.4 на уровне модуля)', () => {
  it('пустая база → текущая версия со всеми таблицами 5.2', () => {
    const db = openDatabase(tmpDb());
    try {
      assert.equal(schemaVersion(db), 0);
      const r = migrate(db);
      assert.deepEqual(r, { from: 0, to: SCHEMA_VERSION, applied: MIGRATIONS.map((m) => m.version) });
      assert.equal(schemaVersion(db), SCHEMA_VERSION);
      assert.deepEqual(missingTables(db), []);
      assert.deepEqual(quickCheck(db), []);
    } finally {
      db.close();
    }
  });

  it('повторный запуск: схема та же, данные не тронуты', () => {
    const f = tmpDb();
    const first = openForGateway(f);
    insertSample(first.db);
    const schemaBefore = schemaDump(first.db);
    const dataBefore = dataDump(first.db);
    first.db.close();

    const second = openForGateway(f);
    try {
      assert.deepEqual(second.migration.applied, []);
      assert.equal(second.migration.from, SCHEMA_VERSION);
      assert.equal(schemaDump(second.db), schemaBefore);
      assert.equal(dataDump(second.db), dataBefore);
    } finally {
      second.db.close();
    }
  });

  it('схема новее кода — отказ, база не тронута', () => {
    const f = tmpDb();
    const { db } = openForGateway(f);
    setMeta(db, 'schema_version', String(SCHEMA_VERSION + 1));
    db.close();
    assert.throws(() => openForGateway(f), (e: unknown) => e instanceof DbError && e.kind === 'newer_schema');
    const ro = openDatabase(f, { readOnly: true });
    assert.equal(getMeta(ro, 'schema_version'), String(SCHEMA_VERSION + 1));
    ro.close();
    assert.equal(inspectDatabase(f).error?.kind, 'newer_schema');
  });

  it('чужая база (таблицы есть, meta нет) — отказ', () => {
    const f = tmpDb();
    const db = openDatabase(f);
    db.exec('CREATE TABLE something (a INTEGER)');
    db.close();
    assert.throws(() => openForGateway(f), (e: unknown) => e instanceof DbError && e.kind === 'foreign');
  });
});

describe('база: v11 (0.3.4) — пересборка events с видом reaction (после v10 0.3.3 — посылки)', () => {
  /** База на версии v (миграции по порядку, как у шлюза той версии). */
  function dbAt(v: number): { f: string; db: Db } {
    const f = tmpDb();
    const db = openDatabase(f);
    for (const m of MIGRATIONS.filter((x) => x.version <= v)) {
      db.exec(m.sql);
      setMeta(db, 'schema_version', String(m.version));
    }
    return { f, db };
  }

  it('v9 → v10 → v11: строки событий и ссылки на них целы, номер события не переиспользуется, индексы и внешние ключи на месте', () => {
    const { db } = dbAt(9);
    insertSample(db);
    transaction(db, () => {
      // Правка со ссылкой на исходное, звук файлом с длительностью и картинкой — все поля прежних версий.
      db.prepare(
        "INSERT INTO events(update_id, message_id, chat_id, subject_id, trust, kind, text, edit_of, episode_id, status, created_at, stt_note, audio_seconds, media_ref) VALUES (2, 10, 123456789, 'owner', 'owner', 'edit', 'правка', 1, 1, 'processed', 1001, 'too_long', 912.5, 'raw/x.media.jpg')",
      ).run();
      db.prepare("INSERT INTO reactions(chat_id, message_id, event_seq, want, shown, status, created_at) VALUES (123456789, 10, 2, '👌', '👌', 'done', 1001)").run();
      db.prepare("INSERT INTO edits(chat_id, outbox_id, event_seq, text, status, created_at) VALUES (123456789, 1, 1, 'x', 'sent', 1001)").run();
      // Последнее событие удалено: счётчик AUTOINCREMENT выше наибольшего номера — после пересборки он не должен упасть.
      db.prepare("INSERT INTO events(update_id, chat_id, kind, status, created_at) VALUES (3, 123456789, 'text', 'new', 1002)").run();
      db.prepare('DELETE FROM events WHERE seq = 3').run();
    });
    const before = db.prepare('SELECT * FROM events ORDER BY seq').all();
    const others = ['outbox', 'receipts', 'messages_out', 'latency', 'edits', 'reactions'].map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
    const r = migrate(db);
    try {
      assert.deepEqual(r.applied, [10, 11, 12, 13], 'миграции по порядку: v10 (0.3.3, посылки) → v11 (0.3.4) → v12 (0.3.5) → v13 (0.3.6)');
      assert.equal(schemaVersion(db), SCHEMA_VERSION);
      const after = db.prepare('SELECT * FROM events ORDER BY seq').all() as Array<Record<string, unknown>>;
      assert.equal(
        JSON.stringify(
          after.map(({ reaction_json, hold_until, instructions_json, material_json, ...rest }) => {
            assert.equal(reaction_json, null);
            assert.equal(hold_until, null, 'окна отмены у прежних событий нет');
            assert.equal(instructions_json, null, 'правил канала у прежних событий нет (v12)');
            assert.equal(material_json, null, 'окна материала у прежних событий нет (v13)');
            return rest;
          }),
        ),
        JSON.stringify(before),
        'строки событий — те же',
      );
      assert.deepEqual(['outbox', 'receipts', 'messages_out', 'latency', 'edits', 'reactions'].map((t) => JSON.stringify((db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all() as Array<Record<string, unknown>>).map((x) => {
        const { quote: _q, ...rest } = x;
        return rest;
      }))), others);
      // Номер 3 был выдан и удалён: следующий — 4.
      const next = db.prepare("INSERT INTO events(chat_id, kind, status, created_at) VALUES (1, 'text', 'new', 1)").run();
      assert.equal(Number(next.lastInsertRowid), 4);
      const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' ORDER BY name").all() as Array<{ name: string }>).map((x) => x.name);
      assert.deepEqual(idx, ['events_episode', 'events_message', 'events_status', 'events_update']);
      assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1, 'внешние ключи снова включены');
      assert.throws(() => db.prepare("INSERT INTO outbox(event_seq, chat_id, kind, text, origin, status, created_at) VALUES (999, 1, 'agent', 'x', 'agent', 'pending', 1)").run(), /FOREIGN KEY/);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(quickCheck(db), []);
      // Новый вид — только с reaction_json, и reaction_json — только у него.
      db.prepare("INSERT INTO events(chat_id, kind, status, created_at, reaction_json) VALUES (1, 'reaction', 'new', 1, '{}')").run();
      assert.throws(() => db.prepare("INSERT INTO events(chat_id, kind, status, created_at) VALUES (1, 'reaction', 'new', 1)").run(), /CHECK/);
      assert.throws(() => db.prepare("INSERT INTO events(chat_id, kind, status, created_at, reaction_json) VALUES (1, 'text', 'new', 1, '{}')").run(), /CHECK/);
      // Окно отмены реакции (0.3.4, issue #46; дописано в v11 до развёртывания): held — только у реакции и только со
      // сроком hold_until; cancelled — только у реакции.
      db.prepare("INSERT INTO events(chat_id, kind, status, created_at, reaction_json, hold_until) VALUES (1, 'reaction', 'held', 1, '{}', 3001)").run();
      db.prepare("INSERT INTO events(chat_id, kind, status, created_at, reaction_json) VALUES (1, 'reaction', 'cancelled', 1, '{}')").run();
      assert.throws(() => db.prepare("INSERT INTO events(chat_id, kind, status, created_at, reaction_json) VALUES (1, 'reaction', 'held', 1, '{}')").run(), /CHECK/, 'held без срока');
      assert.throws(() => db.prepare("INSERT INTO events(chat_id, kind, status, created_at, hold_until) VALUES (1, 'text', 'held', 1, 3001)").run(), /CHECK/, 'held — не у реакции');
      assert.throws(() => db.prepare("INSERT INTO events(chat_id, kind, status, created_at) VALUES (1, 'text', 'cancelled', 1)").run(), /CHECK/, 'cancelled — не у реакции');
      assert.equal((db.prepare('SELECT quote FROM outbox WHERE id = 1').get() as { quote: number }).quote, 0, 'строки outbox прежних версий — не цитатой');
    } finally {
      db.close();
    }
  });

  it('пустая база на v9 → v11: счётчика ещё нет — первый номер 1', () => {
    const { db } = dbAt(9);
    try {
      migrate(db);
      const r = db.prepare("INSERT INTO events(chat_id, kind, status, created_at) VALUES (1, 'text', 'new', 1)").run();
      assert.equal(Number(r.lastInsertRowid), 1);
    } finally {
      db.close();
    }
  });

  it('A9.17 · v10 (база 0.3.3) → v11: строки deliveries целы, связь deliveries → events и outbox цела, номер события не повторяется', () => {
    const { db } = dbAt(10);
    insertSample(db);
    transaction(db, () => {
      // Ответ агента файлом на событие 1 (send_file с seq) и посылка по своей инициативе (без события) — как их пишет 0.3.3.
      db.prepare("INSERT INTO outbox(event_seq, chat_id, kind, text, origin, status, created_at) VALUES (1, 123456789, 'agent', 'отчёт', 'agent', 'sent', 1001)").run();
      db.prepare("INSERT INTO outbox(event_seq, chat_id, kind, text, origin, status, created_at) VALUES (NULL, 123456789, 'agent', NULL, 'agent', 'pending', 1002)").run();
      db.prepare("INSERT INTO messages_out(chat_id, tg_message_id, kind, outbox_id, event_seq) VALUES (123456789, 12, 'agent', 2, 1)").run();
      const d = db.prepare(
        'INSERT INTO deliveries(parcel, file, bytes, sha256, copy_ref, target, chat_id, event_seq, outbox_id, status, tg_message_id, updated, idem, note, timeouts, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      d.run('отчёт', 'report.html', 1234, 'a'.repeat(64), 'raw/parcels/' + 'a'.repeat(64), 'telegram', 123456789, 1, 2, 'sent', 12, 0, 'k1', null, 0, 1001, 1001);
      d.run('отчёт', 'report.html', 1300, 'b'.repeat(64), 'raw/parcels/' + 'b'.repeat(64), 'telegram', 123456789, null, 3, 'pending', null, 1, null, null, 1, 1002, null);
      d.run('архив', 'a/b.md', 10, 'c'.repeat(64), null, 'telegram', 123456789, 1, null, 'failed', null, 0, null, 'копии посылки нет', 3, 1003, null);
      // Событие 2 выдано и удалено: счётчик выше наибольшего номера.
      db.prepare("INSERT INTO events(update_id, chat_id, kind, status, created_at) VALUES (2, 123456789, 'text', 'new', 1004)").run();
      db.prepare('DELETE FROM events WHERE seq = 2').run();
    });
    const deliveries = (): unknown[] => db.prepare('SELECT * FROM deliveries ORDER BY id').all();
    const links = (): unknown[] =>
      db.prepare(
        `SELECT d.id, e.seq AS ev, e.text AS ev_text, o.id AS ob, o.origin, o.event_seq AS ob_ev, m.tg_message_id AS shown
         FROM deliveries d LEFT JOIN events e ON e.seq = d.event_seq LEFT JOIN outbox o ON o.id = d.outbox_id
         LEFT JOIN messages_out m ON m.outbox_id = d.outbox_id ORDER BY d.id`,
      ).all();
    const dBefore = JSON.stringify(deliveries());
    const lBefore = JSON.stringify(links());
    const idxOf = (t: string): string[] =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name").all(t) as Array<{ name: string }>).map((x) => x.name);
    const dIdx = idxOf('deliveries');
    const r = migrate(db);
    try {
      assert.deepEqual(r.applied, [11, 12, 13]);
      assert.equal(schemaVersion(db), SCHEMA_VERSION);
      assert.equal(JSON.stringify(deliveries()), dBefore, 'строки deliveries — те же');
      assert.equal(JSON.stringify(links()), lBefore, 'deliveries → events, outbox, messages_out — те же связи');
      assert.deepEqual(idxOf('deliveries'), dIdx, 'индексы deliveries на месте');
      // Ссылка deliveries → events указывает на новую таблицу events (переименование, а не events_v11) и проверяется.
      const fk = (db.prepare('PRAGMA foreign_key_list(deliveries)').all() as Array<{ table: string; from: string }>).map((x) => `${x.from}→${x.table}`).sort();
      assert.deepEqual(fk, ['event_seq→events', 'outbox_id→outbox']);
      assert.doesNotMatch(tableSql(db, 'deliveries'), /events_v1[123]/);
      assert.throws(() => db.prepare('DELETE FROM events WHERE seq = 1').run(), /FOREIGN KEY/, 'событие с доставкой не удалить');
      assert.throws(
        () => db.prepare("INSERT INTO deliveries(parcel, file, bytes, sha256, target, event_seq, status, created_at) VALUES ('p', 'f', 1, 'x', 'telegram', 999, 'pending', 1)").run(),
        /FOREIGN KEY/,
      );
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(quickCheck(db), []);
      // Номер 2 был выдан и удалён: следующий — 3, а не 2.
      const next = db.prepare("INSERT INTO events(chat_id, kind, status, created_at) VALUES (1, 'text', 'new', 1)").run();
      assert.equal(Number(next.lastInsertRowid), 3);
      // Реакция на документ посылки — новое событие с reaction_json (вид reaction есть).
      db.prepare("INSERT INTO events(chat_id, kind, status, created_at, reaction_json) VALUES (123456789, 'reaction', 'new', 2, '{}')").run();
    } finally {
      db.close();
    }
  });

  it('нарушенный внешний ключ после пересборки — миграция откатывается целиком, база на v10, ключи снова включены', () => {
    const { db } = dbAt(10);
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare("INSERT INTO outbox(event_seq, chat_id, kind, text, origin, status, created_at) VALUES (777, 1, 'agent', 'x', 'agent', 'sent', 1)").run();
      db.exec('PRAGMA foreign_keys = ON');
      assert.throws(() => migrate(db), (e: unknown) => e instanceof DbError && e.kind === 'migration_failed' && /внешние ключи/.test(e.message));
      assert.equal(schemaVersion(db), 10);
      assert.match(tableSql(db, 'events'), /^CREATE TABLE events \(/, 'прежняя таблица на месте');
      assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    } finally {
      db.close();
    }
  });

  it('foreign_key_check в конце v11 проверяет и deliveries (0.3.3): доставка на несуществующее событие — откат, база на v10', () => {
    const { db } = dbAt(10);
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare("INSERT INTO deliveries(parcel, file, bytes, sha256, target, event_seq, status, created_at) VALUES ('p', 'f', 1, 'x', 'telegram', 888, 'pending', 1)").run();
      db.exec('PRAGMA foreign_keys = ON');
      assert.throws(() => migrate(db), (e: unknown) => e instanceof DbError && e.kind === 'migration_failed' && /deliveries/.test(e.message));
      assert.equal(schemaVersion(db), 10);
      assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    } finally {
      db.close();
    }
  });
});

describe('база: v12 (0.3.5) — правила канала разговору (#47) и удаление строки темы (#48)', () => {
  function dbAt(v: number): Db {
    const db = openDatabase(tmpDb());
    for (const m of MIGRATIONS.filter((x) => x.version <= v)) {
      db.exec(m.sql);
      setMeta(db, 'schema_version', String(m.version));
    }
    return db;
  }

  it('v11 → v12: события (и реакции с окном отмены) и удаления целы, номера не переиспользуются; новые CHECK; conversations', () => {
    const db = dbAt(11);
    insertSample(db);
    transaction(db, () => {
      db.prepare("INSERT INTO events(chat_id, kind, status, created_at, reaction_json, hold_until) VALUES (123456789, 'reaction', 'held', 1001, '{\"emoji\":[\"👍\"]}', 4001)").run();
      db.prepare("INSERT INTO events(chat_id, kind, status, created_at) VALUES (123456789, 'probe', 'handled', 1002)").run();
      // Последнее событие и последнее удаление выданы и стёрты: счётчики выше наибольших номеров.
      db.prepare("INSERT INTO events(chat_id, kind, status, created_at) VALUES (123456789, 'text', 'new', 1003)").run();
      db.prepare('DELETE FROM events WHERE seq = 4').run();
      const del = db.prepare('INSERT INTO deletions(chat_id, tg_message_id, outbox_id, reason, due_at, status, attempts, next_try_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      del.run(123456789, 10, null, 'command', 1000, 'sent', 1, null, 1000);
      del.run(123456789, null, 1, 'where', 2000, 'pending', 2, 2500, 1000);
      del.run(123456789, 12, null, 'pin_notice', 3000, 'dropped', 1, null, 1000);
      del.run(123456789, 13, null, 'command', 3000, 'pending', 0, null, 1000);
      db.prepare('DELETE FROM deletions WHERE id = 4').run();
    });
    const events = (): Array<Record<string, unknown>> => db.prepare('SELECT * FROM events ORDER BY seq').all() as Array<Record<string, unknown>>;
    const deletions = (): Array<Record<string, unknown>> => db.prepare('SELECT * FROM deletions ORDER BY id').all() as Array<Record<string, unknown>>;
    const eBefore = JSON.stringify(events());
    const dBefore = JSON.stringify(deletions());
    const r = migrate(db);
    try {
      assert.deepEqual(r.applied, [12, 13], 'v12, затем v13 (0.3.6)');
      assert.equal(schemaVersion(db), SCHEMA_VERSION);
      assert.equal(
        JSON.stringify(
          events().map(({ instructions_json, material_json, ...rest }) => {
            assert.equal(instructions_json, null);
            assert.equal(material_json, null);
            return rest;
          }),
        ),
        eBefore,
        'строки событий — те же (реакция с окном отмены — тоже)',
      );
      assert.equal(
        JSON.stringify(
          deletions().map(({ fallback_text, ...rest }) => {
            assert.equal(fallback_text, null);
            return rest;
          }),
        ),
        dBefore,
        'строки удалений — те же',
      );
      assert.equal(Number(db.prepare("INSERT INTO events(chat_id, kind, status, created_at) VALUES (1, 'text', 'new', 1)").run().lastInsertRowid), 5, 'номер события не переиспользуется');
      assert.equal(
        Number(db.prepare("INSERT INTO deletions(chat_id, tg_message_id, reason, due_at, status, created_at, fallback_text) VALUES (1, 77, 'topic', 1, 'pending', 1, '⚙ ↪ #1 · Тема — верно')").run().lastInsertRowid),
        5,
        'номер удаления не переиспользуется; причина topic с fallback_text',
      );
      const idx = (t: string): string[] =>
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name").all(t) as Array<{ name: string }>).map((x) => x.name);
      assert.deepEqual(idx('events'), ['events_episode', 'events_message', 'events_status', 'events_update']);
      assert.deepEqual(idx('deletions'), ['deletions_status']);
      assert.doesNotMatch(tableSql(db, 'events'), /events_v1[23]/);
      assert.doesNotMatch(tableSql(db, 'deletions'), /deletions_v12/);
      // Правила канала — только с instructions_json, и instructions_json — только у них.
      db.prepare("INSERT INTO events(kind, status, created_at, instructions_json) VALUES ('instructions', 'new', 1, '{\"version\":\"abc\",\"key\":\"session:s1\"}')").run();
      assert.throws(() => db.prepare("INSERT INTO events(kind, status, created_at) VALUES ('instructions', 'new', 1)").run(), /CHECK/);
      assert.throws(() => db.prepare("INSERT INTO events(kind, status, created_at, instructions_json) VALUES ('text', 'new', 1, '{}')").run(), /CHECK/);
      assert.throws(() => db.prepare("INSERT INTO events(kind, status, created_at, instructions_json) VALUES ('instructions', 'held', 1, '{}')").run(), /CHECK/, 'held — только у реакции');
      assert.throws(() => db.prepare("INSERT INTO deletions(chat_id, tg_message_id, reason, due_at, status, created_at) VALUES (1, 1, 'other', 1, 'pending', 1)").run(), /CHECK/);
      db.prepare("INSERT INTO conversations(key, instructions, seq, at) VALUES ('session:s1', 'abc', 6, 1)").run();
      assert.throws(() => db.prepare("INSERT INTO conversations(key, instructions, seq, at) VALUES ('session:s1', 'def', 7, 2)").run(), /UNIQUE|PRIMARY/);
      assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1, 'внешние ключи снова включены');
      assert.throws(() => db.prepare("INSERT INTO deletions(chat_id, outbox_id, reason, due_at, status, created_at) VALUES (1, 999, 'where', 1, 'pending', 1)").run(), /FOREIGN KEY/);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(quickCheck(db), []);
    } finally {
      db.close();
    }
  });

  it('удаление на несуществующую строку outbox — v12 откатывается целиком, база на v11', () => {
    const db = dbAt(11);
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare("INSERT INTO deletions(chat_id, outbox_id, reason, due_at, status, created_at) VALUES (1, 555, 'where', 1, 'pending', 1)").run();
      db.exec('PRAGMA foreign_keys = ON');
      assert.throws(() => migrate(db), (e: unknown) => e instanceof DbError && e.kind === 'migration_failed' && /deletions/.test(e.message));
      assert.equal(schemaVersion(db), 11);
      assert.doesNotMatch(tableSql(db, 'deletions'), /fallback_text/, 'прежняя таблица на месте');
      assert.ok(!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'conversations'").get(), 'conversations нет');
    } finally {
      db.close();
    }
  });
});

describe('база: v13 (0.3.6) — окно для материала без слов владельца (#51)', () => {
  function dbAt(v: number): Db {
    const db = openDatabase(tmpDb());
    for (const m of MIGRATIONS.filter((x) => x.version <= v)) {
      db.exec(m.sql);
      setMeta(db, 'schema_version', String(m.version));
    }
    return db;
  }

  it('A11.13 · v12 → v13: события (реакция в окне отмены, правила канала, проба) целы, material_json пуст, номер не переиспользуется; CHECK: held — у реакции и у материала, cancelled — только у реакции, material_json — только у сообщений', () => {
    const db = dbAt(12);
    insertSample(db);
    transaction(db, () => {
      db.prepare("INSERT INTO events(chat_id, kind, status, created_at, reaction_json, hold_until) VALUES (123456789, 'reaction', 'held', 1001, '{\"emoji\":[\"👍\"]}', 4001)").run();
      db.prepare("INSERT INTO events(kind, status, created_at, instructions_json) VALUES ('instructions', 'delivered', 1002, '{\"version\":\"abc\",\"key\":\"session:s1\"}')").run();
      db.prepare("INSERT INTO events(chat_id, kind, status, created_at) VALUES (123456789, 'probe', 'handled', 1003)").run();
      // Последнее событие выдано и стёрто: счётчик выше наибольшего номера.
      db.prepare("INSERT INTO events(chat_id, kind, status, created_at) VALUES (123456789, 'photo', 'new', 1004)").run();
      db.prepare('DELETE FROM events WHERE seq = 5').run();
    });
    const events = (): Array<Record<string, unknown>> => db.prepare('SELECT * FROM events ORDER BY seq').all() as Array<Record<string, unknown>>;
    const before = JSON.stringify(events());
    const r = migrate(db);
    try {
      assert.deepEqual(r.applied, [13]);
      assert.equal(schemaVersion(db), 13);
      assert.equal(
        JSON.stringify(
          events().map(({ material_json, ...rest }) => {
            assert.equal(material_json, null);
            return rest;
          }),
        ),
        before,
        'строки событий — те же',
      );
      const ins = (sqlText: string): number => Number(db.prepare(sqlText).run().lastInsertRowid);
      assert.equal(ins("INSERT INTO events(chat_id, kind, status, created_at) VALUES (1, 'text', 'new', 1)"), 6, 'номер события не переиспользуется');
      const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND sql IS NOT NULL ORDER BY name").all() as Array<{ name: string }>).map((x) => x.name);
      assert.deepEqual(idx, ['events_episode', 'events_message', 'events_status', 'events_update']);
      assert.doesNotMatch(tableSql(db, 'events'), /events_v13/);
      // Материал в окне: held с material_json и сроком; пересланное голосовое — transcribing с material_json.
      const waiting = '{"state":"waiting","window_ms":120000}';
      for (const kind of ['text', 'voice', 'photo', 'document']) {
        db.prepare("INSERT INTO events(chat_id, kind, status, created_at, hold_until, material_json) VALUES (1, ?, 'held', 1, 120001, ?)").run(kind, waiting);
      }
      db.prepare("INSERT INTO events(chat_id, kind, status, created_at, hold_until, material_json) VALUES (1, 'voice', 'transcribing', 1, 120001, ?)").run(waiting);
      db.prepare("INSERT INTO events(chat_id, kind, status, created_at, material_json) VALUES (1, 'photo', 'new', 1, '{\"state\":\"before\",\"window_ms\":120000,\"words_seq\":6}')").run();
      assert.throws(() => db.prepare("INSERT INTO events(chat_id, kind, status, created_at, material_json) VALUES (1, 'photo', 'held', 1, ?)").run(waiting), /CHECK/, 'held без срока');
      assert.throws(() => db.prepare("INSERT INTO events(chat_id, kind, status, created_at, hold_until) VALUES (1, 'photo', 'held', 1, 3001)").run(), /CHECK/, 'held — не у реакции и не у материала');
      assert.throws(() => db.prepare("INSERT INTO events(chat_id, kind, status, created_at, hold_until, material_json) VALUES (1, 'edit', 'held', 1, 3001, ?)").run(waiting), /CHECK/, 'material_json — не у правки');
      assert.throws(() => db.prepare("INSERT INTO events(chat_id, kind, status, created_at, material_json) VALUES (1, 'photo', 'cancelled', 1, ?)").run(waiting), /CHECK/, 'cancelled — только у реакции');
      assert.throws(() => db.prepare("INSERT INTO events(kind, status, created_at, instructions_json, material_json) VALUES ('instructions', 'new', 1, '{}', ?)").run(waiting), /CHECK/);
      db.prepare("INSERT INTO events(chat_id, kind, status, created_at, reaction_json) VALUES (1, 'reaction', 'cancelled', 1, '{}')").run();
      assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1, 'внешние ключи снова включены');
      assert.throws(() => db.prepare("INSERT INTO outbox(event_seq, chat_id, kind, text, origin, status, created_at) VALUES (999, 1, 'agent', 'x', 'agent', 'pending', 1)").run(), /FOREIGN KEY/);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(quickCheck(db), []);
    } finally {
      db.close();
    }
  });

  it('нарушенный внешний ключ — v13 откатывается целиком, база на v12', () => {
    const db = dbAt(12);
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare("INSERT INTO outbox(event_seq, chat_id, kind, text, origin, status, created_at) VALUES (777, 1, 'agent', 'x', 'agent', 'sent', 1)").run();
      db.exec('PRAGMA foreign_keys = ON');
      assert.throws(() => migrate(db), (e: unknown) => e instanceof DbError && e.kind === 'migration_failed' && /внешние ключи/.test(e.message));
      assert.equal(schemaVersion(db), 12);
      assert.doesNotMatch(tableSql(db, 'events'), /material_json/, 'прежняя таблица на месте');
      assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    } finally {
      db.close();
    }
  });
});

describe('база: перечни 5.2 — CHECK совпадает с константами', () => {
  const db = openForGateway(tmpDb()).db;
  const cases: Array<[string, string, readonly string[]]> = [
    ['events', 'kind', EVENT_KINDS],
    ['events', 'status', EVENT_STATUSES],
    ['events', 'trust', TRUST_LABELS],
    ['updates', 'status', UPDATE_STATUSES],
    ['outbox', 'status', OUTBOX_STATUSES],
    ['outbox', 'origin', OUTBOX_ORIGINS],
    ['outbox', 'kind', MESSAGE_OUT_KINDS],
    ['messages_out', 'kind', MESSAGE_OUT_KINDS],
    ['episodes', 'opened_by', EPISODE_OPENED_BY],
    ['episodes', 'close_reason', EPISODE_CLOSE_REASONS],
    ['episodes', 'summary_trust', SUMMARY_TRUST],
    ['rules_log', 'status', RULES_LOG_STATUSES],
    ['edits', 'status', EDIT_STATUSES],
    ['deliveries', 'status', DELIVERY_STATUSES],
    ['deletions', 'reason', DELETION_REASONS],
  ];
  for (const [table, column, values] of cases) {
    it(`${table}.${column}`, () => {
      assert.deepEqual(checkValues(tableSql(db, table), column), [...values]);
    });
  }

  it('значение вне перечня отвергается', () => {
    assert.throws(
      () => db.prepare("INSERT INTO updates(update_id, received_at, status) VALUES (5, 1, 'lost')").run(),
      /CHECK constraint failed/,
    );
  });

  it('у ignored и admitted raw_json не пишется (Ш-3)', () => {
    assert.throws(
      () => db.prepare("INSERT INTO updates(update_id, received_at, status, raw_json) VALUES (6, 1, 'ignored', '{}')").run(),
      /CHECK constraint failed/,
    );
    db.prepare("INSERT INTO updates(update_id, received_at, status, raw_json) VALUES (7, 1, 'deferred', '{}')").run();
  });

  it('открытый эпизод на пару «чат × субъект» — один', () => {
    const ins = db.prepare(
      "INSERT INTO episodes(chat_id, subject_id, topic, role, opened_by, opened_at, last_activity_at) VALUES (1, 'owner', 't', 'r', 'first_event', 1, 1)",
    );
    ins.run();
    assert.throws(() => ins.run(), /UNIQUE constraint failed/);
  });

  it('кнопка: токен не длиннее 64 байт', () => {
    assert.throws(
      () => db.prepare('INSERT INTO buttons(token, kind, created_at, expires_at) VALUES (?, ?, 1, 2)').run('x'.repeat(65), 'resume'),
      /CHECK constraint failed/,
    );
  });
});

describe('диск полон: настоящая ошибка SQLite и наблюдатель транзакций', () => {
  it('настоящий SQLITE_FULL (max_page_count) распознаётся isDiskFullError; транзакция откатывается целиком', () => {
    const { db } = openForGateway(tmpDb());
    try {
      setMeta(db, 'before', '1');
      const prev = Number(Object.values(db.prepare('PRAGMA max_page_count').get() as Record<string, number>)[0]);
      let caught: unknown = null;
      try {
        transaction(db, () => {
          setMeta(db, 'inside', '1');
          db.exec('PRAGMA max_page_count = 1');
          db.prepare("INSERT INTO meta(key, value) VALUES ('fill', ?)").run('x'.repeat(4 * 1024 * 1024));
        });
      } catch (err) {
        caught = err;
      } finally {
        db.exec(`PRAGMA max_page_count = ${prev}`);
      }
      assert.ok(caught, 'ошибки не было');
      assert.ok(isDiskFullError(caught), `не распознана: ${JSON.stringify(caught)} ${(caught as Error).message}`);
      assert.equal((caught as { errcode?: number }).errcode, 13);
      assert.equal(getMeta(db, 'inside'), null, 'запись внутри транзакции откатилась');
      assert.equal(getMeta(db, 'before'), '1');
      // После отката база пишется как обычно.
      transaction(db, () => setMeta(db, 'after', '1'));
      assert.equal(getMeta(db, 'after'), '1');
    } finally {
      db.close();
    }
  });

  it('ENOSPC и EDQUOT — диск полон; прочие ошибки — нет', () => {
    assert.ok(isDiskFullError(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })));
    assert.ok(isDiskFullError(Object.assign(new Error('квота'), { code: 'EDQUOT' })));
    assert.ok(!isDiskFullError(Object.assign(new Error('EACCES'), { code: 'EACCES' })));
    assert.ok(!isDiskFullError(new Error('database is locked')));
    assert.ok(!isDiskFullError(null));
  });

  it('наблюдатель begin вызывается внутри каждой транзакции; его исключение откатывает её', () => {
    const { db } = openForGateway(tmpDb());
    try {
      let calls = 0;
      setTransactionHooks(db, { begin: () => void calls++ });
      transaction(db, () => setMeta(db, 'a', '1'));
      assert.equal(calls, 1);
      setTransactionHooks(db, {
        begin: () => {
          throw new Error('нет места (тест)');
        },
      });
      assert.throws(() => transaction(db, () => setMeta(db, 'b', '1')), /нет места/);
      assert.equal(getMeta(db, 'b'), null);
      setTransactionHooks(db, null);
      transaction(db, () => setMeta(db, 'c', '1'));
      assert.equal(getMeta(db, 'c'), '1');
    } finally {
      db.close();
    }
  });
});
