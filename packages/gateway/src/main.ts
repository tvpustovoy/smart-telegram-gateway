// Процесс stg-gateway (TECH-SPEC 5, 5.2, 5.3). Порядок старта:
//  1. настройки (STG_HOME), часы, журнал;
//  2. один экземпляр: ping в gateway.sock (ответил — «уже запущен», код 3) и замок gateway.lock против гонки стартов;
//  3. сокет и pid-файл; база (PRAGMA, quick_check, миграции) — сбой: опрос не начинается, строка владельцу (одна на
//     одну и ту же поломку: launchd перезапускает службу), код 4;
//  4. маркер чистой остановки и история стартов; правила доступа: rules.yaml сверяется с рабочей копией в базе (ручная
//     правка владельцем — в rules_log и строкой ему), справочник — по копии (rules.ts); падения (crash_count, deferred);
//     отданное прежнему процессу — new;
//  5. токен → getWebhookInfo → отправитель, цикл приёма, сроки; распознаватель голосовых (5.8) — голосовые, оставшиеся
//     в transcribing после прошлого запуска, распознаются заново; реакции владельца в окне отмены (0.3.4, issue #46) —
//     таймер на остаток окна (окно прошло, пока шлюз стоял, — отдаются сразу).
// SIGTERM — чистая остановка: маркер, сокет и pid-файл убраны.
// Диск полон (disk.ts) — не падение и при старте: не записалась история стартов или маркер — шлюз всё равно
// поднимается и ждёт места (crash_count висящего обновления не растёт: записать его тоже нельзя); не записался
// pid-файл — не беда, главная проверка одного экземпляра — ping в сокет и замок.

import fs from 'node:fs';
import type net from 'node:net';
import path from 'node:path';
import v8 from 'node:v8';
import {
  ClockConfigError,
  ConfigError,
  DB_FAILURE_NOTICE,
  DbError,
  FakeClock,
  FaultSpecError,
  FileJournal,
  HomeError,
  META_KEYS,
  PRODUCT_VERSION,
  SecretError,
  COMMAND_WORDS,
  MENU_COMMANDS,
  TelegramApi,
  clockFromEnv,
  defaultRules,
  effectiveRules,
  ensureDir,
  getMeta,
  isDiskFullError,
  loadConfig,
  openForGateway,
  resolveHome,
  secretStoreFromEnv,
  setMeta,
  setTransactionHooks,
  startClockControlServer,
  stgPaths,
  sttVocabularyUse,
  sweepTempFiles,
  transaction,
  ttsVoice,
  validateFaultEnv,
  writeFileAtomicSync,
  type Clock,
  type Config,
  type Db,
  type Journal,
  type Rules,
  type StgPaths,
  type Timer,
} from 'stg-core';
import { AdapterService } from './adapter.js';
import { Admission } from './admission.js';
import { AgentStateWatcher } from './agent-state.js';
import type { Ctx } from './context.js';
import { Control } from './control.js';
import { Directory } from './directory.js';
import { DiskState } from './disk.js';
import { Episodes } from './episodes.js';
import { acquireInstanceLock, checkInstance, readPidFile, removeOwnFiles, writePidFile } from './instance.js';
import { MediaService } from './media.js';
import { ParcelService } from './parcels.js';
import { Hold } from './hold.js';
import { Reception } from './reception.js';
import { deferStaleInProgress, recoverCrashes, type StartInfo } from './recovery.js';
import { Retention } from './retention.js';
import { RulesService, syncDirectoryTables } from './rules.js';
import { Sender, upgradeTo031OnStart } from './sender.js';
import { GatewaySocketServer } from './socket-server.js';
import { MemoryGuard, rssLimitMb } from './memguard.js';
import { TestHooks } from './testhooks.js';
import { Ticker } from './ticker.js';
import { Transcriber, voiceFromConfig } from './voice.js';

export const EXIT = { ok: 0, failure: 1, config: 2, alreadyRunning: 3, database: 4 } as const;

/** Сколько стартов помнить (окно «3 старта за 60 с»). */
const START_HISTORY_LIMIT = 10;
/** Как часто перечитывать связку ключей, пока токена нет. */
const TOKEN_RETRY_MS = 60_000;
/** Предел на корректную остановку. */
const SHUTDOWN_DEADLINE_MS = 10_000;

function say(line: string): void {
  process.stderr.write(`stg-gateway: ${line}\n`);
}

/** Маркер чистой остановки и история стартов (meta). */
export function recordStart(db: Db, now: number): StartInfo {
  return transaction(db, () => {
    const cleanPrevious = getMeta(db, META_KEYS.cleanShutdown) === '1';
    let history: number[] = [];
    try {
      const parsed: unknown = JSON.parse(getMeta(db, META_KEYS.startHistory) ?? '[]');
      if (Array.isArray(parsed)) history = parsed.filter((x): x is number => typeof x === 'number');
    } catch {
      history = [];
    }
    history = [...history, now].slice(-START_HISTORY_LIMIT);
    setMeta(db, META_KEYS.startHistory, JSON.stringify(history));
    setMeta(db, META_KEYS.cleanShutdown, '0');
    return { cleanPrevious, startHistory: history };
  });
}

/** Справочник участников (AD-9) в базе — по действующим правилам (rules.ts; отдельно — для тестов и старых вызовов). */
export function syncSubjects(db: Db, rules: Rules): void {
  transaction(db, () => syncDirectoryTables(db, rules));
}

class Gateway {
  private db: Db | null = null;
  private socket: GatewaySocketServer | null = null;
  private clockServer: net.Server | null = null;
  private lock: { release(): void } | null = null;
  private ctx: Ctx | null = null;
  private sender: Sender | null = null;
  private adapter: AdapterService | null = null;
  private reception: Reception | null = null;
  private ticker: Ticker | null = null;
  private transcriber: Transcriber | null = null;
  private media: MediaService | null = null;
  private agentState: AgentStateWatcher | null = null;
  private hold: Hold | null = null;
  private tokenTimer: Timer | null = null;
  private stopping = false;

  constructor(
    private readonly paths: StgPaths,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly journal: Journal,
    private readonly env: NodeJS.ProcessEnv,
    private readonly onFatal: (err: unknown) => void,
  ) {}

  async start(): Promise<number> {
    const { paths, journal } = this;
    const check = await checkInstance(paths.socket, paths.pid);
    if (check.state === 'running') {
      say(`уже запущен (pid ${check.pid ?? '?'})`);
      journal.write('start_refused', { reason: 'already_running', pid: check.pid });
      return EXIT.alreadyRunning;
    }
    this.lock = acquireInstanceLock(paths.lock);
    if (!this.lock) {
      // Второй старт в ту же секунду: первый уже держит замок, но сокет ещё не поднял.
      const pid = readPidFile(paths.pid);
      say(`уже запущен (pid ${pid ?? '?'})`);
      journal.write('start_refused', { reason: 'locked', pid });
      return EXIT.alreadyRunning;
    }
    if (check.staleAlive) journal.write('stale_pid_alive', { pid: check.stalePid });
    // Под замком другого писателя нет: временные файлы процесса, убитого посреди записи, — мусор.
    const swept = sweepTempFiles(paths.raw, { recursive: true }) + sweepTempFiles(paths.home);
    if (swept) journal.write('temp_files_swept', { count: swept });
    this.socket = new GatewaySocketServer(paths.socket, journal);
    await this.socket.listen();
    try {
      writePidFile(paths.pid);
    } catch (err) {
      if (!isDiskFullError(err)) throw err;
      journal.write('pid_file_failed', { error: (err as Error).message });
    }

    if (this.clock instanceof FakeClock) {
      this.clockServer = await startClockControlServer(this.clock, this.env.STG_CLOCK_SOCKET || paths.clockSocket);
    }

    try {
      const { db, migration } = openForGateway(paths.db, { unsafeNoSync: this.env.STG_TEST === '1' && this.env.STG_TEST_SYNC === 'off' });
      this.db = db;
      journal.write('db_open', { schema: migration.to, migrated_from: migration.from, applied: migration.applied });
    } catch (err) {
      const e = err as DbError;
      journal.write('db_failed', { kind: e.kind ?? 'unknown', error: e.message, details: e.details ?? [] });
      say(`база не открылась (${e.kind ?? 'ошибка'}): ${e.message}. Опрос не начат. Подробности — stg doctor`);
      await this.notifyDbFailure(e);
      await this.cleanup(false);
      return EXIT.database;
    }
    fs.rmSync(paths.dbFailureMark, { force: true });

    const test = this.env.STG_TEST === '1';
    const hooks = new TestHooks(paths.home, test);
    if (test) setTransactionHooks(this.db, { begin: (db) => hooks.onTransaction(db) });

    const ctx: Ctx = {
      db: this.db,
      clock: this.clock,
      journal,
      config: this.config,
      paths,
      env: this.env,
      // Пока рабочая копия правил не сверена с rules.yaml — только владелец (самое узкое); сверка — ниже, до приёма.
      directory: new Directory(this.config, effectiveRules(this.config, defaultRules(this.config.owner_id)).rules),
      api: null,
      test,
      disk: null as unknown as DiskState,
    };
    ctx.disk = new DiskState(ctx);
    this.ctx = ctx;

    // Старт под полным диском: что не записалось — пропускается, шлюз ждёт места.
    const diskSafe = <T>(where: string, fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch (err) {
        if (!ctx.disk.check(err, where)) throw err;
        return fallback;
      }
    };
    const info = diskSafe('start_history', () => recordStart(ctx.db, this.clock.now()), { cleanPrevious: true, startHistory: [] });

    const episodes = new Episodes(ctx);
    // Правила доступа (5.9, AD-9): rules.yaml сверяется с рабочей копией в базе; справочник — по копии.
    const rules = new RulesService(ctx, episodes);
    rules.start();
    // Голос (5.8): провайдеры распознавания и синтеза — из config.yaml, каждый со своим ключом.
    const voice = voiceFromConfig(ctx);
    const sender = new Sender(ctx, {}, { tts: voice.tts, key: voice.ttsKey });
    this.sender = sender;
    ctx.disk.onRecovered(() => sender.kick());
    const control = new Control(ctx, episodes);
    control.bindRules(rules);
    // Состояние агента (5.14): контекст, сжатие, лимиты, отказ модели — из agent-state.json, который пишет сессия агента.
    // Сменилась строка состояния — и сессия в каталоге аренды могла смениться (/clear, 0.3.2): переходник сверит.
    let adapterRef: AdapterService | null = null;
    const agentState = new AgentStateWatcher(ctx, {
      onChange: () => {
        sender.kick();
        adapterRef?.checkSession();
      },
    });
    this.agentState = agentState;
    const adapter = new AdapterService(ctx, episodes, control, {
      onReplyQueued: () => sender.kick(),
      onAgentActivity: () => agentState.noteAgentActivity(),
      // Та же ли сессия Claude Code в каталоге аренды (0.3.2, R-4 а) — по строке состояния (5.14).
      sessionOf: (cwd) => agentState.sessionFor(cwd),
    });
    adapterRef = adapter;
    this.adapter = adapter;
    // Картинки для агента (0.3): media(seq) — скачать по первому запросу, показать картинкой; файл в raw/ пишется тем же
    // путём, что звук (под тестом — «диск полон», testhooks.ts).
    const media = new MediaService(ctx, hooks);
    this.media = media;
    adapter.setMedia(media);
    // Посылки (0.3.3, 5.16): send_file — копия в raw/parcels и доставка в очередь отправителя.
    adapter.setParcels(new ParcelService(ctx, hooks));
    agentState.bindLive({ online: () => adapter.hasLease, leaseCwd: () => adapter.leaseInfo()?.cwd ?? null });
    // Закреплённая строка (5.7): на связи ли агент — знает только аренда; идёт ли ход (working, #55) — «печатает…»;
    // значки агента — agent-state.json.
    sender.statusLine.bindLive({ online: () => adapter.hasLease, working: () => adapter.typing.isWorking, agent: (now) => agentState.view(now) });
    // Событие идущего хода агента (working, #55): ответ на него 👀 не снимает — снимет конец хода (#52, adapter.ts).
    sender.bindReceiptHold((seq) => adapter.typing.holds(seq));
    // Пока ход идёт, а посылка агента грузится в его чат, — «отправляет фото…» / «отправляет файл…» вместо «печатает…».
    adapter.typing.bindUploads((chatId, threadId) => sender.uploadAction(chatId, threadId));
    // Расшифровка или отказ записаны: ответ владельцу (расшифровка или причина) — отправителю, событие (и ждавшие за
    // ним) — переходнику.
    // Распознанный материал без слов владельца в окне снова удерживается (0.3.6, material.ts) — таймер окна сверяется.
    let holdRef: Hold | null = null;
    const transcriber = new Transcriber(ctx, voice.stt, voice.sttKey, {
      onSettled: () => {
        sender.kick();
        holdRef?.schedule();
        adapter.pump();
      },
    });
    this.transcriber = transcriber;
    ctx.disk.onRecovered(() => transcriber.kick());
    control.bindLive({
      lease: () => adapter.leaseInfo(),
      poll: () => this.reception?.pollState() ?? null,
      stt: () => transcriber.view(),
      tts: () => ({ keyKnown: voice.ttsKey.known }),
      agent: () => ({ state: agentState.snapshot(), view: agentState.view() }),
    });
    this.socket.setHandlers({
      onMessage: (msg, conn) => (this.db ? adapter.handle(msg, conn) : false),
      onClose: (conn) => {
        if (this.db) adapter.onClose(conn);
      },
      onPong: (conn) => adapter.onPong(conn),
      onHandlerError: (err, where) => ctx.disk.check(err, where),
    });
    // Отданное — снова new, кроме отданного последней проверенной аренде переходника, который назвал себя (0.3.2: тот же
    // процесс переподключится и продолжит без пробы и повтора).
    const reset = diskSafe('reset_delivered', () => adapter.resetDelivered(), { returned: 0, kept: 0 });
    // Первый старт 0.3.1, один раз (upgradeTo031OnStart): клавиатура прежних версий снимается (с 0.3.2 — без ✍).
    const keyboard = diskSafe('keyboard_removed', () => transaction(ctx.db, () => upgradeTo031OnStart(ctx)), null);
    const recovery = diskSafe('recovery', () => recoverCrashes(ctx, info), { crashed: [], deferred: [] });
    const stale = diskSafe('stale_in_progress', () => deferStaleInProgress(ctx, this.clock.now()), []);
    // 👀, который держал ход агента прежнего процесса (#55 × #52): ход был в памяти, его конца этот процесс не увидит —
    // снять, если ответ ушёл. После восстановления диска — то же (снятие могло не записаться).
    const receiptsReleased = adapter.releaseStaleReceipts();
    ctx.disk.onRecovered(() => adapter.releaseStaleReceipts());
    journal.write('start', {
      pid: process.pid,
      version: PRODUCT_VERSION,
      node: process.version,
      heap_limit_mb: Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024),
      clock: this.clock.kind,
      clean_previous: info.cleanPrevious,
      starts_recent: info.startHistory.length,
      mode: this.config.owner_id === null ? 'first_setup' : 'owner_set',
      returned_to_new: reset.returned,
      ...(reset.kept ? { kept_for_session: reset.kept } : {}),
      ...(keyboard ? { keyboard_removed: { outbox_id: keyboard.outboxId, notes_dropped: keyboard.notesDropped } } : {}),
      crashed: recovery.crashed,
      deferred: [...recovery.deferred, ...stale],
      ...(receiptsReleased ? { receipts_released: receiptsReleased } : {}),
      ...(ctx.disk.isFull ? { disk_full: true } : {}),
    });

    // Словарь распознавания проверен при чтении config.yaml (термин < 50 знаков, ≤ 5 слов, ≤ 1000 терминов). Сколько его
    // уходит провайдеру и медленнее ли запрос — знает провайдер (5.8): у openai prompt ограничен по длине, у elevenlabs
    // больше 100 терминов — запрос не быстрее 20 с.
    const { stt, tts } = this.config;
    const vocab = sttVocabularyUse(stt);
    journal.write('stt_config', {
      provider: stt.provider,
      base_url: stt.base_url,
      model: stt.model,
      key: stt.key,
      language: stt.language,
      vocabulary: vocab.terms,
      vocabulary_sent: vocab.sent,
      ...(vocab.slow ? { slow: true } : {}),
    });
    journal.write('tts_config', { provider: tts.provider, base_url: tts.base_url, model: tts.model, key: tts.key, voice: ttsVoice(tts) });
    // Окна удержания (hold.ts): окно отмены реакции владельца (0.3.4, issue #46) и окно для материала без слов владельца
    // (0.3.6, issue #51) — удерживаемые события отпускает свой таймер; после перезапуска — остаток окна (прошло — сразу).
    // Отпущено — переходнику.
    const hold = new Hold(ctx, () => adapter.pump());
    this.hold = hold;
    holdRef = hold;
    ctx.disk.onRecovered(() => hold.schedule());
    const admission = new Admission(ctx, episodes, sender, adapter, hooks, control, transcriber, hold);
    // stg deferred retry (5.3) — через сокет: в базу пишет только шлюз.
    adapter.setRetryDeferred((id) => admission.retryDeferred(id));
    // Пробная запись файла при полном диске — тем же путём, что звук (временный файл → fsync → переименование).
    const probeFile = path.join(paths.raw, '.disk-probe');
    const fileProbe = (): void => {
      ensureDir(paths.raw);
      writeFileAtomicSync(probeFile, `${this.clock.now()}\n`, 0o600, hooks.fileIo());
      fs.rmSync(probeFile, { force: true });
    };
    this.ticker = new Ticker(ctx, episodes, adapter, sender, null, fileProbe, new Retention(ctx), transcriber, rules);
    await this.startReception(admission);
    this.ticker.start();
    adapter.start();
    diskSafe('hold', () => hold.schedule(), undefined);
    diskSafe('agent_state', () => agentState.start(), undefined);
    transcriber.kick();
    // Есть ли ключи голоса — сразу, для «статус» (ключ кладёт владелец; нет — голосовые «распознать не смог», ответы
    // голосом уходят текстом). Ключ в журнал не пишется — только есть ли он.
    void voice.sttKey.get().then((k) => journal.write('stt_key', { name: voice.sttKey.name, present: k !== null }));
    if (voice.ttsKey !== voice.sttKey) void voice.ttsKey.get().then((k) => journal.write('tts_key', { name: voice.ttsKey.name, present: k !== null }));
    journal.write('ready', { first_setup: this.config.owner_id === null });
    return EXIT.ok;
  }

  private async startReception(admission: Admission): Promise<void> {
    const ctx = this.ctx!;
    const store = secretStoreFromEnv(this.env, this.config.bot);
    const tryToken = async (): Promise<void> => {
      if (this.stopping) return;
      let token: string | null = null;
      try {
        token = await store.get('telegram');
      } catch (err) {
        this.journal.write('secret_error', { error: err instanceof SecretError ? err.message : String(err) });
      }
      if (!token) {
        this.journal.write('no_token', { where: store.describe('telegram') });
        this.tokenTimer = this.clock.setTimeout(() => void tryToken(), TOKEN_RETRY_MS);
        return;
      }
      this.journal.addSecret(token);
      ctx.api = new TelegramApi(this.config.telegram.api_base, token);
      const reception = new Reception(ctx, admission, this.sender!);
      this.reception = reception;
      // Номер служебного «бот закрепил» — когда приём догнал закрепление (sender.ts).
      this.sender?.bindReception(reception);
      this.ticker?.setReception(reception);
      if (this.config.owner_id === null) {
        this.journal.write('first_setup', { note: 'owner_id пуст: событий нет, ответа нет; последний написавший — в stg doctor' });
      } else {
        await reception.checkWebhook();
        this.setCommandsMenu(ctx.api, this.config.owner_id);
      }
      this.sender?.kick();
      reception.start(this.onFatal);
      this.journal.write('reception_started', { first_setup: this.config.owner_id === null });
    };
    await tryToken();
  }

  /**
   * Меню команд (5.6): setMyCommands — только в личке владельца (незнакомым меню не нужно: им молчание), подписи с эмодзи
   * (J-4): /where 📍 Где мы, /new 🆕 Новая тема, /pause ⏸ Пауза, /stop ⛔ Стоп, /status 📊 Статус, /help ❓
   * Помощь. Не вышло — запись в журнал; команды словом работают и без меню (нижней клавиатуры с 0.3.1 нет).
   */
  private setCommandsMenu(api: TelegramApi, ownerId: number): void {
    const commands = MENU_COMMANDS.map((c) => ({ command: COMMAND_WORDS[c].slash.slice(1), description: COMMAND_WORDS[c].menu }));
    void api.call('setMyCommands', { commands, scope: { type: 'chat', chat_id: ownerId } }, { timeoutMs: 15_000 }).then(
      () => this.journal.write('commands_menu', { count: commands.length }),
      (err: unknown) => this.journal.write('commands_menu_failed', { error: api.redact((err as Error).message) }),
    );
  }

  /** Строка владельцу о сбое базы — одна на одну и ту же поломку: под KeepAlive служба перезапускается каждые 10 с. */
  private async notifyDbFailure(e: DbError): Promise<void> {
    const owner = this.config.owner_id;
    if (owner === null) return;
    let signature = `${e.kind ?? 'unknown'}`;
    try {
      const st = fs.statSync(this.paths.db);
      signature += `:${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch {
      signature += ':missing';
    }
    try {
      const prev = JSON.parse(fs.readFileSync(this.paths.dbFailureMark, 'utf8')) as { signature?: string };
      if (prev.signature === signature) {
        this.journal.write('db_failure_notice_skipped', { reason: 'already_told' });
        return;
      }
    } catch {
      // отметки нет — сказать
    }
    let token: string | null = null;
    try {
      token = await secretStoreFromEnv(this.env, this.config.bot).get('telegram');
    } catch {
      token = null;
    }
    if (!token) return;
    this.journal.addSecret(token);
    const api = new TelegramApi(this.config.telegram.api_base, token);
    try {
      await api.call('sendMessage', { chat_id: owner, text: DB_FAILURE_NOTICE }, { timeoutMs: 15_000 });
      writeFileAtomicSync(this.paths.dbFailureMark, JSON.stringify({ signature, at: this.clock.now() }) + '\n');
      this.journal.write('out', { kind: 'service', label: 'gateway', chat_id: owner, text: DB_FAILURE_NOTICE, direct: true });
    } catch (err) {
      this.journal.write('send_failed', { what: 'db_failure_notice', error: api.redact((err as Error).message) });
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.tokenTimer?.cancel();
    this.ticker?.stop();
    this.hold?.stop();
    this.agentState?.stop();
    await this.reception?.stop();
    await this.transcriber?.stop();
    // Скачивания картинок прерываются; ответы на них («шлюз останавливается») уходят до закрытия сокета.
    await this.media?.stop();
    await this.sender?.stop();
    this.adapter?.close();
    await this.cleanup(true, reason);
  }

  private async cleanup(clean: boolean, reason?: string): Promise<void> {
    const db = this.db;
    this.db = null;
    await this.socket?.close();
    this.socket = null;
    if (this.clockServer) {
      const s = this.clockServer;
      this.clockServer = null;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    if (db) {
      try {
        if (clean) transaction(db, () => setMeta(db, META_KEYS.cleanShutdown, '1'));
      } catch (err) {
        // Диск полон: маркер не записать. Следующий старт сочтёт это падением — один раз (crash_count + 1 висящему
        // обновлению), до отложенного нужно три.
        if (!isDiskFullError(err)) throw err;
        this.journal.write('clean_mark_failed', { error: (err as Error).message });
      } finally {
        db.close();
      }
    }
    removeOwnFiles(this.paths.socket, this.paths.pid);
    this.lock?.release();
    this.lock = null;
    if (clean) this.journal.write('stop', { reason: reason ?? 'stop', clean: true });
  }
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let paths: StgPaths;
  let config: Config;
  let clock: Clock;
  try {
    validateFaultEnv();
    paths = stgPaths(resolveHome(env));
    if (!fs.existsSync(paths.home)) throw new HomeError(`нет каталога ${paths.home}`);
    config = loadConfig(paths.config, { test: env.STG_TEST === '1' });
    clock = clockFromEnv(env, paths);
  } catch (err) {
    if (err instanceof ConfigError) {
      say(`настройки не прочитаны — ${err.file}:`);
      for (const p of err.problems) say(`  ${p}`);
    } else if (err instanceof HomeError || err instanceof ClockConfigError || err instanceof FaultSpecError) {
      say(err.message);
    } else {
      say(`не стартовал: ${(err as Error).message}`);
    }
    return EXIT.config;
  }

  ensureDir(paths.logs);
  const journal = new FileJournal(paths.logs, clock, config.timezone);
  const crash = (err: unknown): never => {
    // Падение: маркер чистой остановки не ставится — следующий старт это увидит (5.3).
    try {
      const e = err instanceof Error ? err : new Error(String(err));
      journal.write('crash', { error: e.message, stack: e.stack?.split('\n').slice(0, 6) });
    } finally {
      process.exit(EXIT.failure);
    }
  };
  const gateway = new Gateway(paths, config, clock, journal, env, crash);
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);

  // Сигналы — с самого начала: без слушателя SIGTERM убивает процесс сразу (поведение ОС по умолчанию), а launchd
  // может прислать его и во время старта. Пришёл раньше, чем шлюз поднялся, — остановка сразу после старта.
  let pending: NodeJS.Signals | null = null;
  let handle: ((sig: NodeJS.Signals) => void) | null = null;
  const onAnySignal = (sig: NodeJS.Signals): void => {
    if (handle) handle(sig);
    else pending ??= sig;
  };
  process.on('SIGTERM', onAnySignal);
  process.on('SIGINT', onAnySignal);

  const code = await gateway.start();
  if (code !== EXIT.ok) return code;

  // Предел памяти (memguard.ts): rss выше предела — остановка с кодом ошибки, launchd поднимет шлюз заново.
  let memoryTripped = false;
  const guard = new MemoryGuard(journal, { limitMb: rssLimitMb(env) }, () => {
    memoryTripped = true;
    say(`память процесса выше предела ${rssLimitMb(env)} МБ — останавливаюсь, служба поднимет заново`);
    onAnySignal('SIGTERM');
  });
  guard.start();

  return new Promise<number>((resolve) => {
    if (env.STG_TEST === '1') {
      // Под тестом: обвязка умерла, не убив шлюз (тест снят по таймауту) — не оставаться сиротой. У службы родитель —
      // launchd, там этой проверки нет.
      const parent = process.ppid;
      const watch = setInterval(() => {
        if (process.ppid !== parent) {
          clearInterval(watch);
          onAnySignal('SIGTERM');
        }
      }, 1000);
      watch.unref();
    }
    let stopping = false;
    handle = (sig: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => {
        say('остановка затянулась — выхожу');
        resolve(EXIT.failure);
      }, SHUTDOWN_DEADLINE_MS);
      deadline.unref();
      guard.stop();
      void gateway.stop(sig).then(() => {
        clearTimeout(deadline);
        resolve(memoryTripped ? EXIT.failure : EXIT.ok);
      });
    };
    if (pending) handle(pending);
  });
}
