// Обвязка интеграционных тестов (ACCEPTANCE §1, уровень И): шлюз — дочерним процессом против подделок;
// под тестом всегда STG_TEST=1, поддельные часы и секреты из переменных STG_TEST_*; связка ключей, launchd и
// настоящий Telegram не трогаются.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import { GATEWAY_NODE_FLAGS, clockCommand, readFakeClockFile, stgPaths, writeFakeClockFile, type StgPaths } from 'stg-core';
import { FakeChannel, type FakeChannelOptions } from 'stg-fake-channel';
import type { FakeTelegram } from 'stg-fake-telegram';

const require = createRequire(import.meta.url);

function entryOf(pkg: string): string {
  const dir = path.dirname(require.resolve(`${pkg}/package.json`));
  return path.join(dir, 'dist', 'index.js');
}

export const GATEWAY_ENTRY = entryOf('stg-gateway');
export const CLI_ENTRY = entryOf('stg-cli');
export const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];
/** Шлюз — с теми же флагами, что и служба (предел кучи, N-2). */
export const GATEWAY_FLAGS = [...GATEWAY_NODE_FLAGS];

export const T0_ISO = '2026-10-18T16:00:00.000Z';
export const T0 = Date.parse(T0_ISO);
export const TEST_TOKEN = '7000000001:AAtest-TOKEN_never-written';

const live = new Set<ChildProcess>();
function killAll(): void {
  for (const p of live) {
    try {
      p.kill('SIGKILL');
    } catch {
      // уже нет
    }
  }
}
process.on('exit', killAll);
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    killAll();
    process.exit(130);
  });
}
// Упавший тест не должен оставить живой шлюз: иначе файл тестов не завершится.
after(killAll);

/** Каталоги этого файла тестов: удаляются после него (STG_TEST_KEEP=1 — оставить для разбора упавшего). */
const tempDirs: string[] = [];
after(() => {
  if (process.env.STG_TEST_KEEP === '1') return;
  for (const d of tempDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // процесс шлюза ещё пишет — останется до следующей чистки ОС
    }
  }
});

/** Каталог теста: путь короткий — сокет Unix на macOS не длиннее 104 байт. */
export function makeTempDir(prefix = 'stg-'): string {
  let base = os.tmpdir();
  if (base.length > 60) base = '/tmp';
  const dir = fs.mkdtempSync(path.join(base, prefix));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

/**
 * Вывод процессов каталога (stdout и stderr шлюза — в службе это logs/launchd.log; вывод stg) — для П-2: секрет не
 * должен попасть и туда.
 */
const outputsByHome = new Map<string, Array<{ what: string; text: () => string }>>();

function noteOutput(homeDir: string | undefined, what: string, text: () => string): void {
  if (!homeDir) return;
  const list = outputsByHome.get(homeDir) ?? [];
  list.push({ what, text });
  outputsByHome.set(homeDir, list);
}

/** Где в выводе процессов каталога встречается строка: «stderr шлюза (pid N)», «stdout stg doctor». */
export function outputsContaining(home: TestHome, needle: string): string[] {
  return (outputsByHome.get(home.dir) ?? []).filter((o) => o.text().includes(needle)).map((o) => o.what);
}

export interface HomeOptions {
  apiBase: string;
  ownerId?: number | null;
  bot?: string;
  /** Дополнительные строки config.yaml. */
  extraConfig?: string;
  /** Содержимое rules.yaml; null — файла нет. */
  rules?: string | null;
  /**
   * Окно для материала без слов владельца (0.3.6, issue #51), ui.material_hold_seconds. По умолчанию в тестах — 0: тесты
   * до 0.3.6 шлют фото, файлы и пересылки без подписи и ждут их у агента сразу. null — строки нет, окно по умолчанию
   * шлюза (120 с; m11-material-hold). Своя секция ui: в extraConfig — строки тоже нет.
   */
  materialHoldSeconds?: number | null;
}

export interface TestHome {
  dir: string;
  paths: StgPaths;
  /** Каталог для подставного launchctl и плистов. */
  aux: string;
}

export function makeHome(opts: HomeOptions): TestHome {
  const root = makeTempDir();
  const dir = path.join(root, 'h');
  fs.mkdirSync(dir, { mode: 0o700 });
  const aux = path.join(root, 'aux');
  fs.mkdirSync(aux, { mode: 0o700 });
  const owner = opts.ownerId === undefined ? 111 : opts.ownerId;
  const config =
    `bot: ${opts.bot ?? 'test_assistant_bot'}\n` +
    `owner_id: ${owner === null ? '' : owner}\n` +
    'timezone: America/Los_Angeles\n' +
    `telegram: { api_base: "${opts.apiBase}" }\n` +
    (opts.extraConfig ?? '') +
    (opts.materialHoldSeconds === null || /^ui:/m.test(opts.extraConfig ?? '') ? '' : `ui: { material_hold_seconds: ${opts.materialHoldSeconds ?? 0} }\n`);
  fs.writeFileSync(path.join(dir, 'config.yaml'), config);
  if (opts.rules) fs.writeFileSync(path.join(dir, 'rules.yaml'), opts.rules);
  return { dir, paths: stgPaths(dir), aux };
}

/** Окружение теста: только нужное; настоящие STG_* родителя не протекают. */
export function testEnv(home: TestHome, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? os.homedir(),
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: 'ru_RU.UTF-8',
    STG_HOME: home.dir,
    STG_TEST: '1',
    STG_CLOCK: 'fake',
    STG_CLOCK_START: T0_ISO,
    STG_LAUNCH_AGENTS_DIR: path.join(home.aux, 'LaunchAgents'),
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export interface JournalLine {
  at: string;
  ev: string;
  [k: string]: unknown;
}

export function readJournal(home: TestHome): JournalLine[] {
  const dir = home.paths.logs;
  if (!fs.existsSync(dir)) return [];
  const out: JournalLine[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line) as JournalLine);
    }
  }
  return out;
}

async function poll<T>(fn: () => T | null | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`не дождались: ${what} за ${timeoutMs} мс`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export class GatewayProcess {
  stdout = '';
  stderr = '';
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  private constructor(
    readonly home: TestHome,
    readonly child: ChildProcess,
    private readonly journalStart: number,
  ) {
    live.add(child);
    child.stdout?.on('data', (d: Buffer) => (this.stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (this.stderr += d.toString()));
    noteOutput(home.dir, `stdout шлюза (pid ${child.pid ?? '?'})`, () => this.stdout);
    noteOutput(home.dir, `stderr шлюза (pid ${child.pid ?? '?'})`, () => this.stderr);
    this.exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => {
        live.delete(child);
        this.exitInfo = { code, signal };
        resolve(this.exitInfo);
      });
    });
  }

  static spawn(home: TestHome, env: NodeJS.ProcessEnv): GatewayProcess {
    const before = readJournal(home).length;
    const child = spawn(process.execPath, [...GATEWAY_FLAGS, GATEWAY_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    return new GatewayProcess(home, child, before);
  }

  /** Запустить и дождаться «ready» в журнале. */
  static async start(home: TestHome, env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<GatewayProcess> {
    const g = GatewayProcess.spawn(home, env);
    await g.waitForJournal((l) => l.ev === 'ready', timeoutMs);
    return g;
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get alive(): boolean {
    return this.exitInfo === null;
  }

  /** Последние строки журнала этого запуска — для сообщений об ошибке. */
  tail(n = 6): string {
    return this.journal()
      .slice(-n)
      .map((l) => `${l.ev}${l.error ? `(${String(l.error)})` : ''}`)
      .join(' → ');
  }

  /** Строки журнала этого запуска. */
  journal(): JournalLine[] {
    return readJournal(this.home).slice(this.journalStart);
  }

  waitForJournal(pred: (l: JournalLine) => boolean, timeoutMs = 10_000): Promise<JournalLine> {
    return poll(
      () => {
        const hit = this.journal().find(pred);
        if (hit) return hit;
        if (!this.alive) throw new Error(`шлюз вышел (${JSON.stringify(this.exitInfo)}), stderr: ${this.stderr}`);
        return null;
      },
      timeoutMs,
      `строки журнала (последние: ${this.tail()})`,
    );
  }

  async waitForExit(timeoutMs = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`шлюз не вышел за ${timeoutMs} мс; stderr: ${this.stderr}; журнал: ${this.tail()}`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([this.exited, t]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Корректная остановка: SIGTERM и ожидание выхода. */
  async stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.alive) this.child.kill('SIGTERM');
    return this.waitForExit();
  }

  /** Убийство без остановки (kill -9 из обвязки). */
  async kill9(): Promise<void> {
    if (this.alive) this.child.kill('SIGKILL');
    await this.waitForExit();
  }

  /** Сдвинуть поддельные часы шлюза: «advance <N>s». */
  advance(spec: string): Promise<number> {
    return clockCommand(this.home.paths.clockSocket, `advance ${spec}`);
  }

  /** Скачок часов, как после сна: «jump <N>». */
  jump(spec: string): Promise<number> {
    return clockCommand(this.home.paths.clockSocket, `jump ${spec}`);
  }
}

/**
 * Время подделки Telegram (message.date) — по поддельным часам шлюза этого каталога; до старта — T0.
 * Подделку создают раньше каталога (нужен её адрес), поэтому каталог подставляется потом.
 */
export class FakeTime {
  file: string | null = null;
  readonly now = (): number => (this.file ? readFakeClockFile(this.file) : null) ?? T0;
  bind(home: TestHome): void {
    this.file = home.paths.clockFile;
  }
}

/** Пока шлюз не работает: сдвинуть время в файле поддельных часов (перезапуски «через ≥ 60 с»). */
export function shiftClockFile(home: TestHome, ms: number): number {
  const now = readFakeClockFile(home.paths.clockFile) ?? T0;
  writeFakeClockFile(home.paths.clockFile, now + ms);
  return now + ms;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ждать условия по настоящему времени. */
export async function waitUntil<T>(fn: () => T | null | undefined | false, timeoutMs = 10_000, what = 'условия'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`не дождались ${what} за ${timeoutMs} мс`);
    await sleep(20);
  }
}

/**
 * Двигать поддельные часы шагами, пока условие не выполнится: отправитель шлёт в чат не чаще раза в секунду, и каждый
 * его шаг ждёт часов. Между шагами — немного настоящего времени на сеть.
 */
export async function pump<T>(
  gw: GatewayProcess,
  fn: () => T | null | undefined | false,
  opts: { step?: string; timeoutMs?: number; settleMs?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  for (;;) {
    const v = fn();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`не дождались ${opts.what ?? 'условия'} (pump)`);
    if (!gw.alive) throw new Error(`шлюз вышел; stderr: ${gw.stderr}`);
    try {
      await gw.advance(opts.step ?? '1s');
    } catch (err) {
      // Сокет часов ещё не поднят (шлюз стартует) — подождать.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ECONNREFUSED' && code !== 'ENOENT' && code !== 'ECONNRESET') throw err;
    }
    await sleep(opts.settleMs ?? 15);
  }
}

/** Запрос к базе на чтение (база шлюза открыта в WAL — читать можно на ходу). */
export function q<T = Record<string, unknown>>(home: TestHome, sql: string, ...params: Array<string | number | null>): T[] {
  if (!fs.existsSync(home.paths.db)) return [];
  const db = openDbRo(home);
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch (err) {
    // База создана, но схемы ещё нет: шлюз стартует.
    if (/no such table/.test((err as Error).message)) return [];
    throw err;
  } finally {
    db.close();
  }
}

export function q1<T = Record<string, unknown>>(home: TestHome, sql: string, ...params: Array<string | number | null>): T | undefined {
  return q<T>(home, sql, ...params)[0];
}

export function count(home: TestHome, sql: string, ...params: Array<string | number | null>): number {
  const r = q1<{ n: number }>(home, sql, ...params);
  return r?.n ?? 0;
}

export function meta(home: TestHome, key: string): string | null {
  return q1<{ value: string | null }>(home, 'SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
}

/** Строка владельцу об отложенном (5.3, а также «за сутки не удалось записать»; реакция, 0.3.4, — «на ней», «её»). */
export const DEFERRED_LINE_RE = /отложил: (на нём шлюз падает|за сутки не удалось его записать|на ней шлюз падает|за сутки не удалось её записать)/;

/**
 * Сверка хранилища без подделки (П-1, часть «внутри базы»): у каждой admitted — ровно одно событие; у не-admitted
 * событий нет; у deferred есть raw_json; у ignored raw_json не записан; in_progress — только из allowInProgress.
 */
export function storeProblems(home: TestHome, opts: { allowInProgress?: number[] } = {}): string[] {
  const rows = q<{ update_id: number; status: string; raw_json: string | null }>(home, 'SELECT update_id, status, raw_json FROM updates');
  const events = q<{ update_id: number; n: number }>(home, 'SELECT update_id, count(*) AS n FROM events WHERE update_id IS NOT NULL GROUP BY update_id');
  const evBy = new Map(events.map((e) => [e.update_id, e.n]));
  const problems: string[] = [];
  for (const e of events) if (e.n !== 1) problems.push(`обновление ${e.update_id}: событий ${e.n}`);
  for (const r of rows) {
    if (r.status === 'admitted' && evBy.get(r.update_id) !== 1) problems.push(`admitted ${r.update_id}: событий ${evBy.get(r.update_id) ?? 0}`);
    if (r.status !== 'admitted' && evBy.has(r.update_id)) problems.push(`${r.status} ${r.update_id}: есть событие`);
    if (r.status === 'deferred' && !r.raw_json) problems.push(`deferred ${r.update_id}: нет raw_json`);
    if (r.status === 'ignored' && r.raw_json) problems.push(`ignored ${r.update_id}: записан raw_json`);
    if (r.status === 'in_progress' && !opts.allowInProgress?.includes(r.update_id)) problems.push(`обновление ${r.update_id} осталось in_progress`);
  }
  return problems;
}

/**
 * П-1 · ни одной потери: у каждого обновления, отданного подделкой, ровно одна строка updates (или — если строка уже
 * вычищена через 24 ч, Ш-2 — событие); у каждой admitted — ровно одно событие; у deferred есть raw_json и строка
 * владельцу. Вызывать, когда шлюз закончил работу. `ids` — сверять только эти номера (подделка общая для двух папок).
 */
export function assertNoLoss(fake: FakeTelegram, home: TestHome, opts: { allowInProgress?: number[]; ids?: Iterable<number> } = {}): void {
  const rows = q<{ update_id: number; status: string; raw_json: string | null }>(home, 'SELECT update_id, status, raw_json FROM updates');
  const byId = new Map(rows.map((r) => [r.update_id, r]));
  const withEvent = new Set(q<{ update_id: number }>(home, 'SELECT DISTINCT update_id FROM events WHERE update_id IS NOT NULL').map((r) => r.update_id));
  const problems: string[] = [];
  for (const id of opts.ids ?? fake.handedOut.keys()) {
    if (!byId.has(id) && !withEvent.has(id)) problems.push(`обновление ${id} отдано подделкой, а строки updates нет`);
  }
  problems.push(...storeProblems(home, opts));
  const deferred = rows.filter((r) => r.status === 'deferred').length;
  if (deferred) {
    const lines = fake.sent.filter((m) => DEFERRED_LINE_RE.test(m.text ?? '')).length;
    if (lines < deferred) problems.push(`отложенных ${deferred}, строк владельцу ${lines}`);
  }
  if (problems.length) throw new Error(`П-1: ${problems.slice(0, 10).join('; ')}`);
}

/**
 * П-2 · токен нигде не записан: ни целиком, ни секретная часть после «:», ни в виде из адреса (URL-кодированный —
 * «:» → «%3A»).
 */
export function assertNoToken(home: TestHome, token = TEST_TOKEN): void {
  const secret = token.slice(token.indexOf(':') + 1);
  const needles = [...new Set([token, secret, encodeURIComponent(token)])];
  const what = (n: string): string => (n === token ? 'токен' : n === secret ? 'часть после «:»' : 'URL-вид');
  // Файлы каталога и вывод процессов: stdout и stderr шлюза в службе уходят в logs/launchd.log (5.3, ACCEPTANCE П-2).
  const hits = needles.flatMap((n) => [...filesContaining(home.dir, n), ...outputsContaining(home, n)].map((f) => `${f} (${what(n)})`));
  if (hits.length) throw new Error(`П-2: токен найден в ${hits.join(', ')}`);
}

/**
 * Поддельный переходник с арендой. По умолчанию — проверенной: ответил done на probe (5.10) и получил ack; с
 * autoProbeDone: false — предварительной (только welcome).
 */
export async function connectAdapter(home: TestHome, opts: FakeChannelOptions = {}): Promise<{ ch: FakeChannel; leaseId: string; turn: number }> {
  const ch = await FakeChannel.connect(home.paths.socket, opts);
  const w = await ch.hello();
  if (w.type !== 'welcome') {
    ch.close();
    throw new Error(`hello: ${JSON.stringify(w)}`);
  }
  if (opts.autoProbeDone !== false) await ch.waitVerified();
  return { ch, leaseId: w.lease_id, turn: w.turn };
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...NODE_FLAGS, CLI_ENTRY, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    live.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    noteOutput(env.STG_HOME, `stdout stg ${args.join(' ')}`, () => stdout);
    noteOutput(env.STG_HOME, `stderr stg ${args.join(' ')}`, () => stderr);
    child.on('exit', (code) => {
      live.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * stg с данными на stdin (строка состояния и перехватчики Claude Code, 5.14): как runCli, но stdin — этот текст, и
 * команда — та же, что пишет шаблон папки агента (Node без флагов).
 */
export function runCliInput(args: string[], env: NodeJS.ProcessEnv, stdin: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    live.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    noteOutput(env.STG_HOME, `stdout stg ${args.join(' ')}`, () => stdout);
    noteOutput(env.STG_HOME, `stderr stg ${args.join(' ')}`, () => stderr);
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
    // close, а не exit: вывод дочитан до конца.
    child.on('close', (code) => {
      live.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Строки проверок doctor: «да · …» / «нет · … · что сделать: …». */
export interface DoctorLine {
  ok: boolean;
  name: string;
  detail: string;
  raw: string;
}

export function doctorLines(stdout: string): DoctorLine[] {
  return stdout
    .split('\n')
    .filter((l) => /^(да|нет)\s+·/.test(l))
    .map((raw) => {
      const parts = raw.split(' · ');
      return { ok: raw.startsWith('да'), name: (parts[1] ?? '').trim(), detail: parts.slice(2).join(' · '), raw };
    });
}

export function openDbRo(home: TestHome): DatabaseSync {
  // Ждать блокировку: шлюз при старте переводит базу в WAL и мигрирует её.
  return new DatabaseSync(home.paths.db, { readOnly: true, timeout: 5000 });
}

/** П-2: секрет не записан ни в один файл каталога (журналы, raw/, база, -wal, -shm). */
export function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p).includes(Buffer.from(needle))) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

/** Подставной launchctl: «служба загружена и работает». */
export function fakeLaunchctl(home: TestHome, state = 'running'): string {
  const f = path.join(home.aux, 'launchctl');
  fs.writeFileSync(f, `#!/bin/sh\necho "gui/501/x = {"\necho "\tstate = ${state}"\necho "\tpid = 4242"\necho "}"\n`, { mode: 0o755 });
  return f;
}

/**
 * Плист службы, как его кладёт установка: `stg service plist` (шаблон scripts/launchd/, флаги GATEWAY_NODE_FLAGS), Node —
 * этот же. Кладётся в подставной каталог LaunchAgents теста (STG_LAUNCH_AGENTS_DIR).
 */
export async function servicePlist(home: TestHome, label: string, node = process.execPath): Promise<string> {
  const r = await runCli(['service', 'plist', '--node', node], testEnv(home));
  if (r.code !== 0) throw new Error(`stg service plist: ${r.stdout}${r.stderr}`);
  const dir = path.join(home.aux, 'LaunchAgents');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${label}.plist`);
  fs.writeFileSync(f, r.stdout);
  return f;
}

/** Плист-пустышка (словарь без ключей) — «плист есть, но не тот». */
export function fakePlist(home: TestHome, label: string): string {
  const dir = path.join(home.aux, 'LaunchAgents');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${label}.plist`);
  fs.writeFileSync(f, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict/></plist>\n');
  return f;
}

export function hasCommand(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
}
