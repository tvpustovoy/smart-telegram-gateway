// База шлюза (SQLite через node:sqlite, TECH-SPEC 5.2). Один писатель — шлюз; CLI открывает только на чтение.
// При открытии: WAL, synchronous=FULL, fullfsync, checkpoint_fullfsync — на macOS без fullfsync коммит может
// остаться в кэше диска, а Telegram уже получил «получил».

import fs from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { META_KEYS, MIGRATIONS, SCHEMA_TABLES, SCHEMA_VERSION } from './schema.js';

export type Db = DatabaseSync;

const statements = new WeakMap<Db, Map<string, StatementSync>>();
/** Предел кэша на соединение: запросов с переменным текстом в шлюзе нет, это страховка. */
const STATEMENT_CACHE_LIMIT = 500;

/**
 * Подготовленный запрос из кэша соединения. Каждый db.prepare держит память SQLite вне кучи V8, и сборщик мусора о ней
 * не знает: при подготовке на каждый вызов память шлюза растёт с числом событий (N-2). Повторное использование
 * безопасно — node:sqlite сбрасывает запрос после run/get/all.
 */
export function sql(db: Db, text: string): StatementSync {
  let m = statements.get(db);
  if (!m) {
    m = new Map();
    statements.set(db, m);
  }
  let st = m.get(text);
  if (!st) {
    if (m.size >= STATEMENT_CACHE_LIMIT) m.clear();
    st = db.prepare(text);
    m.set(text, st);
  }
  return st;
}

export type DbErrorKind =
  | 'missing' // файла нет
  | 'cannot_open' // не открывается (права, путь)
  | 'not_a_database' // файл — не SQLite
  | 'corrupt' // повреждена (malformed, quick_check)
  | 'foreign' // база не шлюза: таблицы есть, meta нет
  | 'newer_schema' // схема новее кода
  | 'older_schema' // схема старее кода (только при чтении: шлюз обновит)
  | 'migration_failed';

export class DbError extends Error {
  constructor(
    readonly kind: DbErrorKind,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

export interface OpenOptions {
  readOnly?: boolean;
  /** Сколько ждать чужую блокировку, мс. */
  busyTimeoutMs?: number;
  /**
   * Только для замера памяти под тестом (N-2, STG_TEST_SYNC=off): без fsync. Настоящий шлюз так не открывает базу:
   * main.ts пропускает это только при STG_TEST=1.
   */
  unsafeNoSync?: boolean;
}

/** Диск полон: ENOSPC у файлов, SQLITE_FULL (13) у базы (5.2: не падение обновления). */
export function isDiskFullError(err: unknown): boolean {
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.code === 'ENOSPC' || e.code === 'EDQUOT') return true;
  if (typeof e.errcode === 'number' && (e.errcode & 0xff) === 13) return true;
  return typeof e.message === 'string' && /database or disk is full|SQLITE_FULL|ENOSPC/i.test(e.message);
}

function sqliteErrorKind(err: unknown): DbErrorKind {
  const e = err as { errcode?: number; message?: string };
  const primary = typeof e.errcode === 'number' ? e.errcode & 0xff : null;
  if (primary === 26 || /not a database/i.test(e.message ?? '')) return 'not_a_database';
  if (primary === 11 || /malformed/i.test(e.message ?? '')) return 'corrupt';
  return 'cannot_open';
}

function wrap(err: unknown, what: string): DbError {
  if (err instanceof DbError) return err;
  const kind = sqliteErrorKind(err);
  const msg = (err as Error).message ?? String(err);
  return new DbError(kind, `${what}: ${msg}`);
}

/** Открыть базу с PRAGMA из 5.2. На чтение — без смены режима журнала и без создания файла. */
export function openDatabase(file: string, opts: OpenOptions = {}): Db {
  const readOnly = opts.readOnly ?? false;
  if (readOnly && !fs.existsSync(file)) throw new DbError('missing', `нет файла базы ${file}`);
  let db: Db;
  try {
    db = new DatabaseSync(file, {
      readOnly,
      enableForeignKeyConstraints: true,
      timeout: opts.busyTimeoutMs ?? 5000,
    });
  } catch (err) {
    throw wrap(err, 'база не открылась');
  }
  try {
    if (!readOnly) {
      const row = db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined;
      if (row?.journal_mode !== 'wal') {
        throw new DbError('cannot_open', `база не перешла в режим WAL (${row?.journal_mode ?? '?'})`);
      }
    }
    db.exec(
      opts.unsafeNoSync
        ? 'PRAGMA synchronous = OFF; PRAGMA fullfsync = OFF; PRAGMA checkpoint_fullfsync = OFF; PRAGMA foreign_keys = ON;'
        : 'PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON; PRAGMA foreign_keys = ON;',
    );
    // Первое чтение страниц: испорченный файл проявится здесь.
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
  } catch (err) {
    try {
      db.close();
    } catch {
      // уже закрыта
    }
    throw wrap(err, 'база не открылась');
  }
  return db;
}

/** PRAGMA quick_check: пустой список — всё в порядке. */
export function quickCheck(db: Db): string[] {
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    const msgs = rows.map((r) => String(Object.values(r)[0]));
    return msgs.length === 1 && msgs[0] === 'ok' ? [] : msgs;
  } catch (err) {
    return [(err as Error).message];
  }
}

function tableNames(db: Db): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

/** Версия схемы: 0 — пустая база; DbError foreign — таблицы есть, а meta нет. */
export function schemaVersion(db: Db): number {
  const tables = tableNames(db);
  if (!tables.includes('meta')) {
    if (tables.length === 0) return 0;
    throw new DbError('foreign', `в базе чужие таблицы (${tables.slice(0, 5).join(', ')}) и нет meta`);
  }
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEYS.schemaVersion) as { value: string } | undefined;
  if (!row) throw new DbError('foreign', 'в meta нет версии схемы');
  const v = Number(row.value);
  if (!Number.isInteger(v) || v < 1) throw new DbError('foreign', `версия схемы «${row.value}» не число`);
  return v;
}

/**
 * Наблюдатели транзакций соединения: `begin` — внутри транзакции до её тела (под тестом там подкладывается «диск
 * полон», A1.16); `committed` — после удачного COMMIT (шлюз так узнаёт, что место на диске снова есть).
 */
export interface TransactionHooks {
  begin?(db: Db): void;
  committed?(db: Db): void;
}

const txHooks = new WeakMap<Db, TransactionHooks>();

export function setTransactionHooks(db: Db, hooks: TransactionHooks | null): void {
  if (hooks) txHooks.set(db, hooks);
  else txHooks.delete(db);
}

/** Транзакция с блокировкой записи сразу (BEGIN IMMEDIATE); ошибка — откат. */
export function transaction<T>(db: Db, fn: () => T): T {
  const hooks = txHooks.get(db);
  db.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    hooks?.begin?.(db);
    result = fn();
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // откат не удался — транзакция уже закрыта
    }
    throw err;
  }
  hooks?.committed?.(db);
  return result;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: number[];
}

/** Довести схему до текущей версии. Повторный запуск на текущей версии ничего не меняет. */
export function migrate(db: Db): MigrateResult {
  let from: number;
  try {
    from = schemaVersion(db);
  } catch (err) {
    throw wrap(err, 'версия схемы не читается');
  }
  if (from > SCHEMA_VERSION) {
    throw new DbError('newer_schema', `схема базы v${from} новее, чем знает шлюз (v${SCHEMA_VERSION})`);
  }
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    // Пересборка таблицы, на которую ссылаются внешние ключи (v11 — events): ключи выключаются до транзакции (внутри
    // неё PRAGMA foreign_keys ничего не меняет), после SQL — проверка всех ключей; нарушение — откат всей миграции.
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(db, () => {
        db.exec(m.sql);
        if (m.foreignKeysOff) {
          const bad = db.prepare('PRAGMA foreign_key_check').all() as Array<{ table: string; rowid: number | null; parent: string }>;
          if (bad.length) {
            throw new Error(`внешние ключи после пересборки: ${bad.slice(0, 5).map((b) => `${b.table}#${b.rowid ?? '?'} → ${b.parent}`).join(', ')}`);
          }
        }
        db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
          META_KEYS.schemaVersion,
          String(m.version),
        );
      });
    } catch (err) {
      throw new DbError('migration_failed', `миграция v${m.version} («${m.name}») не прошла: ${(err as Error).message}`);
    } finally {
      if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
    applied.push(m.version);
  }
  return { from, to: SCHEMA_VERSION, applied };
}

/** Чего не хватает в схеме (имена таблиц). */
export function missingTables(db: Db): string[] {
  const have = new Set(tableNames(db));
  return SCHEMA_TABLES.filter((t) => !have.has(t));
}

export function getMeta(db: Db, key: string): string | null {
  const row = sql(db, 'SELECT value FROM meta WHERE key = ?').get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string | null): void {
  sql(db, 'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export interface OpenForGatewayResult {
  db: Db;
  migration: MigrateResult;
}

/** Открытие шлюзом: PRAGMA, quick_check, миграции. Любой сбой — DbError: опрос не начинается. */
export function openForGateway(file: string, opts: { unsafeNoSync?: boolean } = {}): OpenForGatewayResult {
  const db = openDatabase(file, opts.unsafeNoSync ? { unsafeNoSync: true } : {});
  try {
    // В базе — дословные сообщения владельца: файлы только для него (каталог и так 0700).
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        if ((fs.statSync(f).mode & 0o777) !== 0o600) fs.chmodSync(f, 0o600);
      } catch {
        // файла нет — нечего менять
      }
    }
    const problems = quickCheck(db);
    if (problems.length) throw new DbError('corrupt', 'quick_check нашёл повреждения', problems.slice(0, 10));
    const migration = migrate(db);
    const missing = missingTables(db);
    if (missing.length) throw new DbError('corrupt', `в схеме нет таблиц: ${missing.join(', ')}`);
    return { db, migration };
  } catch (err) {
    db.close();
    throw wrap(err, 'база не годится');
  }
}

export interface DbInspection {
  ok: boolean;
  /** Открылась ли база. */
  opened: boolean;
  version: number | null;
  quickCheck: string[] | null;
  error: DbError | null;
}

/** Проверка базы для stg doctor: только чтение, ничего не меняет. */
export function inspectDatabase(file: string): DbInspection {
  let db: Db;
  try {
    db = openDatabase(file, { readOnly: true });
  } catch (err) {
    return { ok: false, opened: false, version: null, quickCheck: null, error: wrap(err, 'база не открылась') };
  }
  try {
    let version: number | null = null;
    let error: DbError | null = null;
    try {
      version = schemaVersion(db);
    } catch (err) {
      error = wrap(err, 'версия схемы не читается');
    }
    const qc = quickCheck(db);
    if (!error && qc.length) error = new DbError('corrupt', 'quick_check нашёл повреждения', qc.slice(0, 10));
    if (!error && version !== null && version > SCHEMA_VERSION) {
      error = new DbError('newer_schema', `схема базы v${version} новее кода (v${SCHEMA_VERSION})`);
    }
    if (!error && version !== null && version < SCHEMA_VERSION) {
      error = new DbError('older_schema', `схема базы v${version} старее кода (v${SCHEMA_VERSION})`);
    }
    return { ok: error === null, opened: true, version, quickCheck: qc, error };
  } finally {
    db.close();
  }
}
