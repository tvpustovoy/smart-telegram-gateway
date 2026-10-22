// Тестовые подмены, которые нельзя сделать точкой сбоя с выходом 137 (ACCEPTANCE A1.16): «диск полон». Работают только
// при STG_TEST=1: файл <STG_HOME>/test-disk-full со словами
// - `files`  — ENOSPC посреди записи файла содержимого: временный файл создан, половина записана, следующая запись —
//              ENOSPC, как у настоящего полного диска;
// - `db`     — SQLITE_FULL в каждой транзакции шлюза (приём, сокет, тикер, отправитель, старт, остановка);
// - `commit` — SQLITE_FULL только в главной транзакции приёма (строка in_progress и файлы уже записаны).
// SQLITE_FULL — настоящий, от SQLite на соединении шлюза: на время одной записи max_page_count опускается до размера
// базы, и вставка большого значения не помещается (транзакция откатывается так же, как при полном диске).
// Тест убирает файл — «место освободилось».

import fs from 'node:fs';
import path from 'node:path';
import type { Db, WriteIo } from 'stg-core';

const FILL_BYTES = 4 * 1024 * 1024;

export class TestHooks {
  private readonly file: string | null;

  constructor(home: string, test: boolean) {
    this.file = test ? path.join(home, 'test-disk-full') : null;
  }

  private has(word: string): boolean {
    if (!this.file) return false;
    try {
      if (!fs.statSync(this.file, { throwIfNoEntry: false })) return false;
      return new RegExp(`\\b${word}\\b`).test(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return false;
    }
  }

  /** Чем писать файл содержимого: под флагом `files` — ENOSPC посреди записи. */
  fileIo(): WriteIo | undefined {
    if (!this.has('files')) return undefined;
    let calls = 0;
    return {
      writeSync: (fd, buffer, offset, length) => {
        calls++;
        if (calls === 1 && length > 1) return fs.writeSync(fd, buffer, offset, Math.ceil(length / 2));
        throw Object.assign(new Error('ENOSPC: no space left on device, write (тест)'), { code: 'ENOSPC', errno: -28, syscall: 'write' });
      },
    };
  }

  /** Начало любой транзакции шлюза (setTransactionHooks): флаг `db`. */
  onTransaction(db: Db): void {
    if (this.has('db')) realSqliteFull(db);
  }

  /** Главная транзакция приёма: флаг `commit` (и `db` — он уже сработал в начале транзакции). */
  onCommit(db: Db): void {
    if (this.has('commit')) realSqliteFull(db);
  }
}

/** Настоящий SQLITE_FULL на этом соединении — внутри текущей транзакции. */
function realSqliteFull(db: Db): never {
  const row = db.prepare('PRAGMA max_page_count').get() as Record<string, number> | undefined;
  const prev = Number(row ? Object.values(row)[0] : 4294967294) || 4294967294;
  try {
    db.exec('PRAGMA max_page_count = 1');
    db.prepare("INSERT INTO meta(key, value) VALUES ('test_disk_full', ?)").run('x'.repeat(FILL_BYTES));
  } finally {
    db.exec(`PRAGMA max_page_count = ${prev}`);
  }
  // Вставка поместилась (в базе много свободных страниц) — та же ошибка, что дал бы SQLite.
  throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13, errstr: 'database or disk is full' });
}
