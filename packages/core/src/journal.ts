// Журнал шлюза: logs/YYYY-MM-DD.jsonl, строка — JSON-объект (TECH-SPEC 5.13). Дата файла — по поясу владельца.
// Секреты (токен, ключи) вычищаются из каждой строки до записи: адреса с токеном в журнал не попадают (Ш-24).

import fs from 'node:fs';
import path from 'node:path';
import type { Clock } from './clock.js';
import { ensureDir } from './fsutil.js';
import { redactSecrets } from './secrets.js';
import { localDate } from './time.js';

export type JournalFields = Record<string, unknown>;

export interface Journal {
  write(ev: string, fields?: JournalFields): void;
  /** Добавить секрет, который нельзя писать. */
  addSecret(secret: string | null | undefined): void;
}

export class FileJournal implements Journal {
  private readonly secrets: string[] = [];
  /** Сколько строк не записалось (диск полон). */
  dropped = 0;

  constructor(
    private readonly dir: string,
    private readonly clock: Clock,
    private readonly timezone: string,
    private readonly mirror: ((line: string) => void) | null = null,
  ) {
    ensureDir(dir);
  }

  addSecret(secret: string | null | undefined): void {
    if (secret && !this.secrets.includes(secret)) this.secrets.push(secret);
  }

  write(ev: string, fields: JournalFields = {}): void {
    const now = this.clock.now();
    const record = { at: new Date(now).toISOString(), ev, ...fields };
    let line = JSON.stringify(record, (_k, v: unknown) => (v instanceof Error ? { message: v.message } : v));
    line = redactSecrets(line, this.secrets);
    const file = path.join(this.dir, `${localDate(now, this.timezone)}.jsonl`);
    // Синхронная дозапись: порядок строк сохраняется и при падении сразу после записи. Диск полон — строка
    // теряется, но шлюз не падает (5.2): приём важнее журнала.
    try {
      fs.appendFileSync(file, line + '\n', { mode: 0o600 });
    } catch {
      this.dropped++;
    }
    this.mirror?.(line);
  }
}

/** Журнал в никуда — для проверок, где файл не нужен. */
export class NullJournal implements Journal {
  write(): void {}
  addSecret(): void {}
}
