// Запись файла целиком (writeFileAtomicSync): короткая запись без ошибки (по POSIX при нехватке места пишется сколько
// влезло) не даёт обрезанного файла; ошибка посреди записи — временный файл убран, целевой не создан; уборка брошенных
// временных файлов.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { sweepTempFiles, writeFileAtomicSync, type WriteIo } from './fsutil.js';

/** Временные каталоги этого файла тестов — удаляются после него. */
const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function makeTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function tmpDir(): string {
  return makeTmp('stg-fsutil-');
}

const data = Buffer.from('x'.repeat(100_000));

describe('writeFileAtomicSync', () => {
  it('короткие записи без ошибки — пишет до последнего байта', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'a.oga');
    let calls = 0;
    const io: WriteIo = {
      writeSync: (fd, buf, off, len) => {
        calls++;
        return fs.writeSync(fd, buf, off, Math.min(len, 4096));
      },
    };
    writeFileAtomicSync(file, data, 0o600, io);
    assert.equal(fs.readFileSync(file).length, data.length);
    assert.ok(calls >= 25, `вызовов write ${calls}`);
    assert.deepEqual(fs.readdirSync(dir), ['a.oga']);
  });

  it('короткая запись, затем ENOSPC — исключение; временного файла нет, целевой не создан', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'b.oga');
    let calls = 0;
    const io: WriteIo = {
      writeSync: (fd, buf, off, len) => {
        calls++;
        if (calls === 1) return fs.writeSync(fd, buf, off, Math.min(len, 4096));
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      },
    };
    assert.throws(() => writeFileAtomicSync(file, data, 0o600, io), (e: NodeJS.ErrnoException) => e.code === 'ENOSPC');
    assert.deepEqual(fs.readdirSync(dir), [], 'ни обрезка, ни временного файла');
  });

  it('write вернул 0 — ошибка, а не вечный цикл и не обрезанный файл', () => {
    const dir = tmpDir();
    const io: WriteIo = { writeSync: () => 0 };
    assert.throws(() => writeFileAtomicSync(path.join(dir, 'c'), data, 0o600, io), /записано 0 байт/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('прежний файл не тронут, если новая запись не удалась', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'rules.yaml');
    writeFileAtomicSync(file, 'старое');
    const io: WriteIo = { writeSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } };
    assert.throws(() => writeFileAtomicSync(file, 'новое', 0o600, io));
    assert.equal(fs.readFileSync(file, 'utf8'), 'старое');
    assert.deepEqual(fs.readdirSync(dir), ['rules.yaml']);
  });
});

describe('sweepTempFiles', () => {
  it('убирает брошенные временные файлы (в том числе во вложенных каталогах), остальное не трогает', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, '2026-10-18'));
    fs.writeFileSync(path.join(dir, '2026-10-18', '.100.oga.4242.1760000000000.tmp'), 'обрезок');
    fs.writeFileSync(path.join(dir, '2026-10-18', '100.oga'), 'звук');
    fs.writeFileSync(path.join(dir, '.rules.yaml.1.2.tmp'), 'x');
    fs.writeFileSync(path.join(dir, 'notes.tmp'), 'не наш');
    assert.equal(sweepTempFiles(dir), 1, 'без recursive — только верхний каталог');
    assert.equal(sweepTempFiles(dir, { recursive: true }), 1);
    assert.deepEqual(fs.readdirSync(path.join(dir, '2026-10-18')), ['100.oga']);
    assert.ok(fs.existsSync(path.join(dir, 'notes.tmp')));
    assert.equal(sweepTempFiles(path.join(dir, 'нет такого')), 0);
  });
});
