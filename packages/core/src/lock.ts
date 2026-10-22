// Замок одного экземпляра на каталог бота (TECH-SPEC 5, «Один экземпляр»): исключительная блокировка SQLite на файле
// gateway.lock. Его берут шлюз (против гонки двух одновременных стартов: ping → удаление сокета → listen) и
// stg restore (пока подменяется база, шлюз не стартует). Блокировку держит ядро ОС; она снимается сама, когда процесс
// умирает (и при kill -9), поэтому старый файл не мешает.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const LOCK_ATTEMPTS = 4;
const LOCK_BUSY_MS = 200;

export interface InstanceLock {
  release(): void;
}

/** Взять замок; null — его держит другой процесс. */
export function acquireInstanceLock(lockPath: string): InstanceLock | null {
  // Два старта в одну секунду могут взять SHARED оба и оба не получить EXCLUSIVE: тогда оба отпускают и пробуют снова
  // через случайную паузу — один выигрывает. Держит замок живой процесс — после попыток null.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(lockPath, { timeout: LOCK_BUSY_MS });
      db.exec('BEGIN EXCLUSIVE');
    } catch {
      try {
        db?.close();
      } catch {
        // не открылась
      }
      Atomics.wait(pause, 0, 0, 20 + Math.floor(Math.random() * 80));
      continue;
    }
    try {
      fs.chmodSync(lockPath, 0o600);
    } catch {
      // права не главное
    }
    const held = db;
    return {
      release: () => {
        try {
          held.exec('ROLLBACK');
        } catch {
          // уже снят
        }
        held.close();
      },
    };
  }
  return null;
}
