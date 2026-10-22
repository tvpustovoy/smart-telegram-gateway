// Файловые мелочи: запись целиком через временный файл и переименование, каталоги с правами 0700, уборка брошенных
// временных файлов.

import fs from 'node:fs';
import path from 'node:path';

/** Чем пишется файл: подменяется в модульных тестах (короткая запись, ENOSPC посреди записи). */
export interface WriteIo {
  writeSync(fd: number, buffer: Uint8Array, offset: number, length: number): number;
}

const realIo: WriteIo = {
  writeSync: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, length),
};

/** Имя временного файла рядом с целевым: `.<имя>.<pid>.<время>.tmp` — по нему же уборка (sweepTempFiles). */
const TEMP_RE = /^\..+\.\d+\.\d+\.tmp$/;

/**
 * Записать файл целиком: временный файл → запись до последнего байта → fsync → переименование → fsync каталога.
 * Один вызов write может записать меньше без ошибки (по POSIX при нехватке места пишется сколько влезло), поэтому
 * пишем в цикле и сверяем длину. При любой ошибке временный файл удаляется: обрезок не остаётся и не занимает место.
 */
export function writeFileAtomicSync(file: string, data: string | Uint8Array, mode = 0o600, io: WriteIo = realIo): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const fd = fs.openSync(tmp, 'w', mode);
  let ok = false;
  try {
    try {
      let off = 0;
      while (off < buf.length) {
        const n = io.writeSync(fd, buf, off, buf.length - off);
        if (!Number.isInteger(n) || n <= 0) {
          throw Object.assign(new Error(`write: записано ${String(n)} байт из ${buf.length - off}`), { code: 'EIO' });
        }
        off += n;
      }
      const size = fs.fstatSync(fd).size;
      if (size !== buf.length) throw Object.assign(new Error(`write: в файле ${size} байт из ${buf.length}`), { code: 'EIO' });
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    ok = true;
  } finally {
    if (!ok) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // убрать не вышло — уберёт sweepTempFiles при следующем старте
      }
    }
  }
  fsyncDir(dir);
}

export function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // На некоторых файловых системах fsync каталога не поддерживается — не ошибка.
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Создать каталог (и родителей) с правами 0700, если его нет. */
export function ensureDir(dir: string, mode = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
}

/**
 * Убрать временные файлы writeFileAtomicSync, брошенные процессом, который убили посреди записи (kill -9). Вызывать
 * только под замком одного экземпляра: другого писателя в каталоге нет. Возвращает число удалённых.
 */
export function sweepTempFiles(dir: string, opts: { recursive?: boolean } = {}): number {
  let n = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (opts.recursive) n += sweepTempFiles(p, opts);
    } else if (e.isFile() && TEMP_RE.test(e.name)) {
      try {
        fs.rmSync(p, { force: true });
        n++;
      } catch {
        // не удалился — не страшно
      }
    }
  }
  return n;
}
