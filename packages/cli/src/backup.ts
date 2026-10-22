// stg backup / stg restore (TECH-SPEC 5.2 «Копия и восстановление», Оч-5).
// - backup: VACUUM INTO из базы, открытой только на чтение, в новый файл backup/gateway-ГГГГММДД-ЧЧММСС.db плюс копия
//   raw/ рядом (gateway-ГГГГММДД-ЧЧММСС.raw/). Идёт и во время приёма: в WAL чтение видит целый снимок. Сначала база,
//   потом raw/ — копия файлов не меньше того, на что ссылается снимок.
// - restore <файл>: только при остановленной службе ⟨предл. принято⟩. Проверка integrity_check и схемы; прежняя база
//   (с -wal и -shm) откладывается в backup/, копия кладётся через временный файл; raw/ из копии дописывается. Всё это —
//   под замком одного экземпляра (gateway.lock): под KeepAlive launchd может поднять шлюз в окно между «прежняя база
//   отложена» и переименованием копии, и тогда два писателя делили бы одну папку. Пока замок у restore, шлюз выходит с
//   кодом 3; замок занят — restore отказывает.
// Сообщения, принятые после копии, Telegram уже не вернёт — это граница потерь при восстановлении.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SCHEMA_TABLES,
  SCHEMA_VERSION,
  acquireInstanceLock,
  ensureDir,
  fsyncDir,
  inspectDatabase,
  loadConfig,
  localDate,
  localTime,
  openDatabase,
  parseClockStart,
  readFakeClockFile,
  resolveHome,
  stgPaths,
  type StgPaths,
} from 'stg-core';
import { pingSocket } from './socket.js';

export interface CmdResult {
  code: number;
  out: string[];
  /** Строки в stderr (когда stdout — сам файл, например stg agent-state settings). */
  err?: string[];
}

/** Время для имён файлов: под тестом — поддельные часы шлюза (файл), иначе настоящее. */
export function cliNow(env: NodeJS.ProcessEnv, paths: StgPaths): number {
  if (env.STG_TEST === '1' && env.STG_CLOCK === 'fake') {
    return readFakeClockFile(env.STG_CLOCK_FILE || paths.clockFile) ?? parseClockStart(env.STG_CLOCK_START);
  }
  return Date.now();
}

function stamp(ms: number, tz: string): string {
  return `${localDate(ms, tz).replace(/-/g, '')}-${localTime(ms, tz).replace(':', '')}${String(new Date(ms).getUTCSeconds()).padStart(2, '0')}`;
}

export function tableCounts(file: string): Record<string, number> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out: Record<string, number> = {};
    for (const t of SCHEMA_TABLES) out[t] = (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    return out;
  } finally {
    db.close();
  }
}

export function integrityCheck(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    const msgs = rows.map((r) => String(Object.values(r)[0]));
    return msgs.length === 1 && msgs[0] === 'ok' ? [] : msgs;
  } finally {
    db.close();
  }
}

function copyTree(from: string, to: string, overwrite: boolean): number {
  let n = 0;
  if (!fs.existsSync(from)) return 0;
  ensureDir(to);
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) n += copyTree(a, b, overwrite);
    else if (e.isFile()) {
      if (!overwrite && fs.existsSync(b)) continue;
      fs.copyFileSync(a, b);
      fs.chmodSync(b, 0o600);
      n++;
    }
  }
  return n;
}

export async function runBackup(env: NodeJS.ProcessEnv, home?: string): Promise<CmdResult> {
  const paths = stgPaths(resolveHome(env, home));
  const config = loadConfig(paths.config, { test: env.STG_TEST === '1' });
  if (!fs.existsSync(paths.db)) return { code: 1, out: [`нет базы ${paths.db}: копировать нечего`] };
  ensureDir(paths.backup);
  const base = `gateway-${stamp(cliNow(env, paths), config.timezone)}`;
  let name = base;
  for (let i = 2; fs.existsSync(path.join(paths.backup, `${name}.db`)); i++) name = `${base}-${i}`;
  const target = path.join(paths.backup, `${name}.db`);
  const db = openDatabase(paths.db, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
  fs.chmodSync(target, 0o600);
  const problems = integrityCheck(target);
  if (problems.length) return { code: 1, out: [`копия ${target} не прошла integrity_check: ${problems[0]}`] };
  const rawCopied = copyTree(paths.raw, path.join(paths.backup, `${name}.raw`), true);
  fsyncDir(paths.backup);
  const counts = tableCounts(target);
  return {
    code: 0,
    out: [
      `копия базы: ${target}`,
      `integrity_check: ok; событий ${counts.events}, обновлений ${counts.updates}, исходящих ${counts.outbox}`,
      `raw/: файлов ${rawCopied}${rawCopied ? ` → ${path.join(paths.backup, `${name}.raw`)}` : ''}`,
    ],
  };
}

export async function runRestore(env: NodeJS.ProcessEnv, file: string, home?: string): Promise<CmdResult> {
  const paths = stgPaths(resolveHome(env, home));
  if (fs.existsSync(paths.socket) && (await pingSocket(paths.socket))) {
    return { code: 1, out: ['шлюз запущен: сначала останови службу, потом stg restore'] };
  }
  const src = path.resolve(file);
  if (!fs.existsSync(src)) return { code: 1, out: [`нет файла ${src}`] };
  const ins = inspectDatabase(src);
  if (!ins.opened || ins.version === null) return { code: 1, out: [`${src}: не база шлюза (${ins.error?.message ?? '?'})`] };
  if (ins.version > SCHEMA_VERSION) return { code: 1, out: [`${src}: схема v${ins.version} новее кода (v${SCHEMA_VERSION})`] };
  const problems = integrityCheck(src);
  if (problems.length) return { code: 1, out: [`${src}: integrity_check — ${problems[0]}`] };

  ensureDir(paths.home);
  const lock = acquireInstanceLock(paths.lock);
  if (!lock) return { code: 1, out: ['каталог занят: шлюз стартует или работает (замок gateway.lock) — останови службу и повтори'] };
  try {
    return restoreLocked(paths, src);
  } finally {
    lock.release();
  }
}

function restoreLocked(paths: StgPaths, src: string): CmdResult {
  const out: string[] = [];
  ensureDir(paths.backup);
  if (fs.existsSync(paths.db)) {
    const aside = path.join(paths.backup, `gateway-before-restore-${Date.now()}`);
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(paths.db + suffix)) fs.renameSync(paths.db + suffix, `${aside}.db${suffix}`);
    }
    out.push(`прежняя база отложена: ${aside}.db`);
  }
  // Старый журнал WAL не должен лечь на восстановленную базу.
  for (const suffix of ['-wal', '-shm']) fs.rmSync(paths.db + suffix, { force: true });
  const tmp = `${paths.db}.restore-tmp`;
  fs.copyFileSync(src, tmp);
  const fd = fs.openSync(tmp, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, paths.db);
  fsyncDir(paths.home);
  const rawDir = src.replace(/\.db$/, '.raw');
  const rawCopied = copyTree(rawDir, paths.raw, false);
  const counts = tableCounts(paths.db);
  out.push(`восстановлено из ${src}: событий ${counts.events}, обновлений ${counts.updates}; raw/: файлов ${rawCopied}`);
  out.push('сообщения, принятые после копии, Telegram уже не вернёт — это граница потерь');
  return { code: 0, out };
}
