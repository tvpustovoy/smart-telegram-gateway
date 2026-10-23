// Адаптер Codex (#55): держит аренду у шлюза тем же GatewayClient, что и канал Claude Code, и дочерний
// `codex app-server`; один тред Codex на разговор.
//
// - Подъём: app-server → initialize (experimentalApi) → account/read → тред (thread/resume по id из state.json или
//   thread/start) → аренда у шлюза. Проверочное событие адаптер закрывает сам (done с кодом): доставку в Codex
//   подтверждает ответ на turn/start, ход модели на пробу не тратится.
// - События → ход: onEvent кладёт событие в очередь и возвращает false (клиент сам delivered не шлёт). Все ждущие
//   события уходят одним вводом turn/start: строки режима и адаптера, затем заголовок и текст каждого события (формат
//   канала, format.ts), через пустую строку. Ход идёт — Codex добавляет ввод в него и отвечает тем же turn.id. После
//   ответа на turn/start — delivered по каждому №: 👀 значит «модель получила».
// - Codex получает только события, которые шлюз отдал нынешней аренде: событие помнит аренду, с которой пришло. После
//   новой аренды (переподключение, аренда снята и взята снова) ждущее в очереди шлюз отдаёт снова — повтор находит его в
//   очереди, не дублирует, а перевешивает на эту аренду и будит очередь. Отдать раньше нельзя: delivered и reply по
//   событию, не отданному этой аренде, шлюз отклоняет, а следом пришёл бы его повтор — второй раз то же событие.
// - Строка адаптера («[адаптер · …]») — только от адаптера: «[адаптер» в тексте события пишется как «［адаптер», как «[№»
//   и «[шлюз» у канала.
// - Инструменты: item/tool/call → callTool канала с ходом шлюза того хода Codex (CallContext.turn). Вызов из хода,
//   прерванного «стопом», — отказ без шлюза.
// - Стоп → turn/interrupt; прерванное заново не отдаётся (решает повтор шлюза). Пауза и «продолжить» — строкой режима в
//   идущий ход или первой строкой следующего. Пауза событий не держит: ответы на слова владельца в паузе уходят, а
//   сообщения агента по своей инициативе придерживает шлюз.
// - Ход закончился, а на событие из него нет ни reply, ни done, ни send_file, ни итога — одно напоминание тем же тредом.
// - «Печатает…» на весь ход: пока ход Codex идёт (ответ на turn/start … turn/completed), шлюзу — working {on: true, seqs}
//   с № событий хода: шлюз держит «печатает…» в их чатах и после промежуточного reply, в закреплённой строке — 🟡, а 👀
//   на сообщениях хода — до конца хода (#52).
//   Набор сменился (ход начат, ввод добавлен) или новая аренда — сразу; дальше — на признаки жизни Codex (уведомления
//   треда, вызовы инструментов), не чаще workingRepeatMs (30 с): Codex замолчал — шлюз снимет «печатает…» сам через
//   WORKING_HOLD_MS (15 мин). Ход кончился или прерван «стопом» — working {on: false}. Шлюз без working — больше не шлём.
// - Ход упал: слетел вход, лимит тарифа, предел запросов — строка владельцу (одна на беду) и повтор через 5 минут;
//   прочее — повтор через 1, 5, 15 минут. app-server упал — перезапуск с паузой 1…30 с и thread/resume; события
//   незаконченного хода — снова, с пометкой «повтор после сбоя Codex». Не поднялся за минуту — аренда снимается.
// - Папка агента — чужой репозиторий: адаптер туда ничего не пишет. Своё состояние — в $STG_HOME/codex/.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GatewayClient, OUTCOME, callTool, formatEvent, formatMode, instructionsFor, instructionsVersionOf, type GatewayEnv } from 'stg-channel';
import { PRODUCT_VERSION, seqList, type EventMessage, type Mode } from 'stg-core';
import { AppServer, RpcError } from './app-server.js';
import { versionFromUserAgent, type CodexCommand } from './codex-bin.js';
import { oneLine, type Feed } from './feed.js';
import {
  APPROVAL_REQUESTS,
  CHECKED_CODEX_VERSION,
  type AccountReadResponse,
  type InitializeResponse,
  type ItemNotification,
  type ThreadItem,
  type ThreadResponse,
  type ThreadSettings,
  type TokenUsageNotification,
  type ToolCallParams,
  type ToolCallResponse,
  type Turn,
  type TurnCompletedNotification,
  type TurnStartResponse,
} from './protocol.js';
import { loadState, saveState, type AdapterState } from './state.js';
import type { CodexTiming } from './timing.js';
import { answeredBy, describeCall, dynamicTools, refusal, toToolResponse } from './tools-bridge.js';

export const ADAPTER_NAME = 'stg-codex';

export interface RunnerOptions {
  /** Папка агента: cwd треда и команд. Адаптер в неё не пишет. */
  agentDir: string;
  gateway: GatewayEnv;
  /** Папка посылок шлюза (writable root песочницы). */
  parcelsDir: string;
  /** session_hint.cwd аренды: от него шлюз ищет посылки, если в config.yaml нет parcels.dir. */
  hintCwd: string;
  stateFile: string;
  codex: CodexCommand;
  codexEnv: NodeJS.ProcessEnv;
  timing: CodexTiming;
  /** Имя бота — в имени треда. */
  botName: string;
  log: (line: string) => void;
  feed: Feed;
  instanceId?: string;
}

/** Пометка события, отданного снова. */
type Note = 'crash' | 'restart' | null;

interface Queued {
  ev: EventMessage;
  note: Note;
  /** Аренда, которой шлюз отдал событие (null — не было аренды). Codex получает только отданное нынешней. */
  lease: string | null;
}

interface Handed {
  ev: EventMessage;
  turnId: string;
  lease: string | null;
}

interface ActiveTurn {
  id: string;
  /** Ход шлюза на старте хода Codex: reply и send_file идут с ним. */
  gatewayTurn: number;
  /** № событий, отданных в этот ход (и напоминаний о них). */
  seqs: Set<number>;
  startedAt: number;
}

/** Беды хода, о которых владельцу — строка (одна на беду, до первого удачного хода). */
const OWNER_PROBLEMS: Record<string, string> = {
  unauthorized: '⚠ Codex: слетел вход в ChatGPT — агент не отвечает. Войди снова: codex login в терминале на Mac. Сообщения не потеряются.',
  usageLimitExceeded: '⚠ Codex: кончился лимит тарифа ChatGPT — агент ответит, когда лимит восстановится; пробую раз в 5 минут. Сообщения не потеряются.',
  rateLimitExceeded: '⚠ Codex: предел запросов к модели — пробую снова через 5 минут. Сообщения не потеряются.',
};

const MAX_REMEMBERED_TURNS = 100;

/** Ответ thread/resume, когда треда нет (app-server/src/request_processors/thread_processor.rs@163). */
const THREAD_GONE_RE = /no rollout found|thread not found/i;

/** CodexErrorInfo → имя: «usageLimitExceeded» или первый ключ объекта. */
export function errorKind(info: unknown): string | null {
  if (typeof info === 'string') return info;
  if (info && typeof info === 'object') return Object.keys(info)[0] ?? null;
  return null;
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1).replace('.', ',')} с` : ms < 120_000 ? `${Math.round(ms / 1000)} с` : `${Math.round(ms / 60_000)} мин`;
}

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** «[адаптер» (и через пробелы и знаки нулевой ширины) — начало строки адаптера. */
const ADAPTER_LIKE_RE = /\[([\s\u200B-\u200D\u2060\uFEFF]*)(адаптер)/giu;

/**
 * Событие текстом для Codex: формат канала (format.ts), а похожее на строку адаптера — с «［» (полноширинная скобка). События
 * идут в одном вводе со строками адаптера через пустую строку: без этого чужой текст изобразил бы «[адаптер · …]» со
 * служебным указанием. В заголовке события «[адаптер» не бывает: значения в нём — без скобок.
 */
export function eventText(ev: EventMessage): string {
  return formatEvent(ev).content.replace(ADAPTER_LIKE_RE, '［$1$2');
}

export class Runner {
  private client: GatewayClient | null = null;
  private codex: AppServer | null = null;
  private ready = false;
  private threadId: string | null = null;
  private state: AdapterState;
  private readonly queue: Queued[] = [];
  private readonly handed = new Map<number, Handed>();
  private readonly reminded = new Set<number>();
  private remindSeqs: number[] = [];
  /** Строки режима и адаптера — первыми в следующем вводе. */
  private lines: string[] = [];
  /** Ходы Codex, начатые и ещё не законченные (обычно один); active — последний из них. */
  private readonly openTurns = new Map<string, ActiveTurn>();
  private active: ActiveTurn | null = null;
  private readonly turnGateway = new Map<string, number>();
  private readonly interrupted = new Set<string>();
  private readonly completedEarly = new Map<string, TurnCompletedNotification>();
  private mode: Mode = 'running';
  /** Аренда, о которой адаптер уже знает (onMode): по ней видно, что аренда новая. */
  private leaseSeen: string | null = null;
  private pumping = false;
  private pumpAgain = false;
  private pumpScheduled = false;
  private retryAt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private readonly told = new Set<string>();
  private restartDelay: number;
  private restartTimer: NodeJS.Timeout | null = null;
  private accountTimer: NodeJS.Timeout | null = null;
  private downSince: number | null = null;
  private stopping = false;
  private readonly restartPending: Set<number>;
  private readonly instanceId: string;
  private lastUsage: TokenUsageNotification['tokenUsage'] | null = null;
  /** Последний working {on: true} шлюзу: № событий хода через запятую и когда (Date.now); null — хода нет (или off ушёл). */
  private workingSent: { sig: string; at: number } | null = null;
  /** Шлюз не знает working (старая версия): до новой аренды не шлём. */
  private workingUnsupported = false;
  private codexVersion: string | null = null;
  /** Папка посылок — настоящий путь (песочница Codex сверяет пути без ссылок: /var → /private/var). */
  private parcelsDir: string;

  constructor(private readonly opts: RunnerOptions) {
    this.restartDelay = opts.timing.restartMinMs;
    this.parcelsDir = opts.parcelsDir;
    this.instanceId = opts.instanceId ?? crypto.randomBytes(18).toString('base64url');
    const loaded = loadState(opts.stateFile);
    this.state = loaded.state;
    if (loaded.warning) {
      opts.log(loaded.warning);
      opts.feed.line('warn', loaded.warning);
    }
    this.restartPending = new Set(this.state.pending);
  }

  /** Тред Codex разговора (null — ещё не открыт). */
  get thread(): string | null {
    return this.threadId;
  }

  async start(): Promise<void> {
    fs.mkdirSync(this.opts.parcelsDir, { recursive: true, mode: 0o700 });
    this.parcelsDir = fs.realpathSync(this.opts.parcelsDir);
    this.opts.feed.line('sys', `папка агента: ${this.opts.agentDir}`);
    this.opts.feed.line('sys', `папка посылок: ${this.parcelsDir}`);
    this.opts.feed.line('sys', `Codex: ${this.opts.codex.display}`);
    await this.bootCodex();
  }

  /** Завершение: аренда снимается, app-server закрывается (stdin), состояние записано. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of [this.retryTimer, this.restartTimer, this.accountTimer]) if (t) clearTimeout(t);
    await this.client?.stop();
    await this.codex?.close();
    this.saveState();
  }

  // ——— Codex: подъём, тред, перезапуск ———

  private developerInstructions(): string {
    const role = fs.existsSync(path.join(this.opts.agentDir, 'AGENTS.md'))
      ? ' Твоя роль и правила работы — в AGENTS.md этой папки (Codex читает его сам); эти правила — только про связь с владельцем через Telegram.'
      : '';
    return (
      `${instructionsFor('codex')}\n\n` +
      `Где что:\n` +
      `- твоя папка (рабочий каталог команд): ${this.opts.agentDir}.${role}\n` +
      `- папка посылок: ${this.parcelsDir} — файлы для владельца клади в ${path.join(this.parcelsDir, '<посылка>', '<файл>')}, в send_file(path) пиши «<посылка>/<файл>».`
    );
  }

  private threadSettings(): ThreadSettings {
    return {
      cwd: this.opts.agentDir,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      developerInstructions: this.developerInstructions(),
      // Писать — в папку агента (cwd) и в папку посылок; сеть у команд закрыта, что бы ни стояло в config.toml.
      config: {
        'sandbox_workspace_write.writable_roots': [this.parcelsDir],
        'sandbox_workspace_write.network_access': false,
      },
    };
  }

  private async bootCodex(): Promise<void> {
    if (this.stopping) return;
    let srv: AppServer;
    try {
      srv = AppServer.spawn({
        command: this.opts.codex.command,
        args: this.opts.codex.args,
        cwd: this.opts.agentDir,
        env: this.opts.codexEnv,
        log: this.opts.log,
        requestTimeoutMs: this.opts.timing.requestTimeoutMs,
        onNotification: (m, p) => this.onNotification(m, p),
        onRequest: (m, p) => this.onServerRequest(m, p),
        onExit: (info) => {
          if (this.codex !== srv) return;
          if (info.expected || this.stopping) return;
          this.codexDown(`codex app-server вышел (код ${info.code ?? '—'}${info.signal ? `, ${info.signal}` : ''})`);
        },
      });
    } catch (err) {
      this.codexDown(`codex app-server не запустился: ${(err as Error).message}`);
      return;
    }
    this.codex = srv;
    try {
      const init = await srv.request<InitializeResponse>('initialize', {
        clientInfo: { name: ADAPTER_NAME, title: 'smart-telegram-gateway', version: PRODUCT_VERSION },
        capabilities: { experimentalApi: true },
      });
      srv.notify('initialized');
      this.codexVersion = versionFromUserAgent(init.userAgent);
      this.opts.log(`Codex ${this.codexVersion ?? '?'} (pid ${srv.pid ?? '?'})`);
      if (this.codexVersion && !this.codexVersion.startsWith(`${CHECKED_CODEX_VERSION}.`)) {
        const w = `Codex ${this.codexVersion}: адаптер проверен на ${CHECKED_CODEX_VERSION}.x — на этой версии не проверено`;
        this.opts.log(w);
        this.opts.feed.line('warn', w);
      }
      const acc = await srv.request<AccountReadResponse>('account/read', {});
      if (!acc.account) {
        this.noAccount(srv);
        return;
      }
      await this.openThread(srv);
      this.codexUp();
    } catch (err) {
      if (this.codex !== srv || this.stopping) return;
      this.opts.log(`подъём Codex: ${(err as Error).message}${srv.stderrTail() ? `; stderr: ${oneLine(srv.stderrTail(), 400)}` : ''}`);
      await srv.close(1000);
      this.codexDown(`Codex не поднялся: ${(err as Error).message}`);
    }
  }

  private noAccount(srv: AppServer): void {
    const why = 'нет входа в ChatGPT у Codex — войди: codex login (в терминале); проверяю раз в минуту';
    this.state.problem = 'no_login';
    this.saveState();
    this.opts.log(why);
    this.opts.feed.line('warn', why);
    this.accountTimer = setTimeout(() => {
      this.accountTimer = null;
      if (this.codex !== srv || this.stopping) return;
      srv
        .request<AccountReadResponse>('account/read', {})
        .then(async (acc) => {
          if (!acc.account) return this.noAccount(srv);
          await this.openThread(srv);
          this.codexUp();
        })
        .catch((err: unknown) => this.opts.log(`account/read: ${(err as Error).message}`));
    }, this.opts.timing.accountRetryMs);
  }

  private async openThread(srv: AppServer): Promise<void> {
    const settings = this.threadSettings();
    const version = instructionsVersionOf(settings.developerInstructions);
    const s = this.state;
    if (s.threadId && s.agentDir === this.opts.agentDir) {
      try {
        const r = await srv.request<ThreadResponse>('thread/resume', { threadId: s.threadId, ...settings, excludeTurns: true });
        this.threadId = r.thread.id;
        const changed = s.instructionsVersion !== null && s.instructionsVersion !== version;
        this.opts.feed.line('sys', `тред ${shortId(this.threadId)} продолжен${changed ? ' · правила канала обновлены' : ''}${r.model ? ` · модель ${r.model}` : ''}`);
        this.opts.log(`thread/resume ${this.threadId}: песочница ${JSON.stringify(r.sandbox ?? null)}`);
        this.showSources(r);
        this.state = { ...s, instructionsVersion: version, codexVersion: this.codexVersion };
        this.saveState();
        return;
      } catch (err) {
        // Новый тред — только если прежнего нет. Иначе (тред открыт в другом Codex — «already has an active writer»,
        // сбой, срок) — перезапуск с паузой и снова resume: разговор не теряется молча.
        if (this.codex !== srv || !THREAD_GONE_RE.test((err as Error).message)) throw err;
        const w = `тред ${shortId(s.threadId)} не найден (${(err as Error).message}) — завожу новый`;
        this.opts.log(w);
        this.opts.feed.line('warn', w);
      }
    }
    const r = await srv.request<ThreadResponse>('thread/start', { ...settings, dynamicTools: dynamicTools() });
    this.threadId = r.thread.id;
    this.state = { ...s, threadId: this.threadId, agentDir: this.opts.agentDir, instructionsVersion: version, codexVersion: this.codexVersion };
    this.saveState();
    this.opts.log(`thread/start ${this.threadId}: песочница ${JSON.stringify(r.sandbox ?? null)}`);
    try {
      await srv.request('thread/name/set', { threadId: this.threadId, name: `Telegram · ${this.opts.botName}` });
    } catch (err) {
      this.opts.log(`thread/name/set: ${(err as Error).message}`);
    }
    this.opts.feed.line('sys', `новый тред ${shortId(this.threadId)}${r.model ? ` · модель ${r.model}` : ''}`);
    this.showSources(r);
  }

  /** Какие AGENTS.md Codex подхватил: роль агента — из его папки; общий — из настроек пользователя. */
  private showSources(r: ThreadResponse): void {
    const sources = r.instructionSources ?? [];
    this.opts.log(`инструкции Codex: ${sources.length ? sources.join(', ') : 'нет'}`);
    this.opts.feed.line('sys', sources.length ? `инструкции Codex: ${sources.join(' · ')}` : 'инструкций AGENTS.md Codex не нашёл');
  }

  private codexUp(): void {
    this.ready = true;
    this.downSince = null;
    this.restartDelay = this.opts.timing.restartMinMs;
    if (this.state.problem !== null) {
      this.state.problem = null;
      this.saveState();
    }
    this.opts.feed.line('sys', 'Codex на связи');
    if (!this.client) this.createClient();
    this.schedulePump();
  }

  /** app-server упал или не поднялся: события незаконченного хода — в очередь с пометкой; перезапуск с паузой. */
  private codexDown(why: string): void {
    if (this.stopping) return;
    this.ready = false;
    this.codex = null;
    for (const t of this.openTurns.values()) this.requeue(t, 'crash');
    this.openTurns.clear();
    this.active = null;
    this.syncWorking();
    this.downSince ??= Date.now();
    const wait = this.restartDelay;
    this.restartDelay = Math.min(this.opts.timing.restartMaxMs, this.restartDelay * 2);
    this.opts.log(`${why}; перезапуск через ${wait} мс`);
    this.opts.feed.line('warn', `${why} — перезапуск через ${seconds(wait)}`);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restartCodex();
    }, wait);
  }

  private async restartCodex(): Promise<void> {
    if (this.stopping) return;
    if (this.client && this.downSince !== null && Date.now() - this.downSince >= this.opts.timing.giveUpMs) {
      // Не поднялся за минуту: владелец должен видеть «не на связи», а не ложное «на связи». Поднимется — новая аренда.
      const c = this.client;
      this.client = null;
      this.opts.feed.line('warn', 'Codex не поднимается — аренда у шлюза снята (владелец видит «не на связи»)');
      await c.stop();
    }
    await this.bootCodex();
  }

  /** Неотвеченные события хода — снова в очередь (с пометкой), по порядку №. */
  private requeue(t: ActiveTurn, note: Note): void {
    for (const s of t.seqs) {
      const h = this.handed.get(s);
      if (!h || h.turnId !== t.id) continue;
      this.handed.delete(s);
      this.reminded.delete(s);
      if (!this.queue.some((q) => q.ev.seq === s)) this.queue.push({ ev: h.ev, note, lease: h.lease });
    }
    this.queue.sort((a, b) => a.ev.seq - b.ev.seq);
    this.saveState();
  }

  // ——— шлюз ———

  private createClient(): void {
    const log = (line: string): void => {
      this.opts.log(line);
      if (line.startsWith('состояние:')) this.opts.feed.line('sys', `шлюз — ${line.slice('состояние:'.length).trim()}`);
    };
    this.client = new GatewayClient({
      socketPath: this.opts.gateway.socketPath,
      adapter: ADAPTER_NAME,
      timing: this.opts.gateway.timing,
      hint: { cwd: this.opts.hintCwd, pid: process.pid },
      // Ключ процесса: тот же процесс — та же сессия (переподключение к шлюзу без пробы). instructions_version не шлём:
      // правила канала уходят в developer instructions треда, событий «правила канала» шлюзу слать не нужно.
      instanceId: this.instanceId,
      log,
      onEvent: (ev) => this.onEvent(ev),
      onMode: (state, turn, previous) => this.onMode(state, turn, previous),
    });
    this.client.start();
  }

  /** Нынешняя аренда клиента (null — аренды нет). */
  private leaseNow(): string | null {
    const st = this.client?.state;
    return st?.kind === 'leased' ? st.leaseId : null;
  }

  private onEvent(ev: EventMessage): Promise<boolean> {
    if (ev.kind === 'probe') {
      void this.closeProbe(ev);
      return Promise.resolve(false);
    }
    if (ev.kind === 'instructions') {
      // Не придёт: версию правил шлюзу не называем. Пришло — закрыть, модели не показывать.
      void this.client?.request('done', { seqs: [ev.seq] }).catch(() => undefined);
      return Promise.resolve(false);
    }
    this.opts.feed.line('in', oneLine(eventText(ev), 400));
    const lease = this.leaseNow();
    const queued = this.queue.find((q) => q.ev.seq === ev.seq);
    if (queued) {
      // Повтор шлюза — по сроку или новой аренде (ей шлюз отдаёт заново всё, что ждало у прежней): второго такого же в
      // очереди не нужно, но теперь событие отдано этой аренде — Codex может его получить.
      const moved = queued.lease !== lease;
      queued.lease = lease;
      this.opts.log(`№ ${ev.seq} уже ждёт в очереди — повтор шлюза не дублирую${moved ? '; отдан новой аренде' : ''}`);
      this.schedulePump();
      return Promise.resolve(false);
    }
    let note: Note = null;
    if (this.restartPending.delete(ev.seq)) note = 'restart';
    this.queue.push({ ev, note, lease });
    this.queue.sort((a, b) => a.ev.seq - b.ev.seq);
    this.schedulePump();
    return Promise.resolve(false);
  }

  private async closeProbe(ev: EventMessage): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const r = await client.request('done', { seqs: [ev.seq], ...(ev.code !== undefined ? { code: ev.code } : {}) });
      if (r.type === 'ack') {
        this.opts.feed.line('sys', `проверка канала № ${ev.seq} — закрыта адаптером (ход модели не нужен)`);
        // Аренда проверена: working до проверки шлюз отклонил (unverified) — ход идёт, «печатает…» — сейчас.
        this.syncWorking();
      } else this.opts.feed.line('warn', `проверка канала № ${ev.seq}: ${r.type === 'error' ? `${r.code} — ${r.text}` : r.type}`);
    } catch (err) {
      this.opts.log(`done на пробу № ${ev.seq}: ${(err as Error).message}`);
    }
  }

  private onMode(state: Mode, _turn: number, previous: Mode | null): void {
    // Новый клиент (аренда была снята и взята снова) прежнего режима не знает — сравнить с тем, что знал адаптер.
    const prev = previous ?? this.mode;
    this.mode = state;
    const lease = this.leaseNow();
    if (lease !== null && lease !== this.leaseSeen) {
      this.leaseSeen = lease;
      // Снятая аренда унесла «печатает…» хода: новой — сразу заново; старый шлюз мог обновиться.
      this.workingSent = null;
      this.workingUnsupported = false;
      const waiting = this.queue.filter((q) => q.lease !== lease).map((q) => q.ev.seq);
      if (waiting.length) this.opts.log(`новая аренда: ${seqList(waiting)} в очереди — Codex получит, когда шлюз отдаст их этой аренде`);
    }
    if (state !== prev) {
      const n = formatMode(state, prev);
      if (n) this.lines.push(n.content);
      if (state === 'stopped') {
        this.opts.feed.line('sys', '⛔ владелец сказал «стоп»');
        this.interruptActive();
        this.syncWorking();
        return;
      }
      this.opts.feed.line('sys', state === 'paused' ? '⏸ пауза' : prev === 'stopped' ? '▶ стоп снят' : '▶ пауза снята');
    }
    // welcome новой аренды приходит сюда же, обычно без смены режима: что ждало связи со шлюзом (напоминания, отданное этой
    // аренде), — дальше; ход идёт — «печатает…» новой аренде.
    this.syncWorking();
    this.schedulePump();
  }

  /** «Стоп»: прервать идущие ходы; их поздние вызовы — отказ; напоминаний о прежнем нет (дальше решает повтор шлюза). */
  private interruptActive(): void {
    this.remindSeqs = [];
    const srv = this.codex;
    const threadId = this.threadId;
    if (!srv || !threadId) return;
    for (const t of this.openTurns.values()) {
      if (this.interrupted.has(t.id)) continue;
      this.interrupted.add(t.id);
      while (this.interrupted.size > MAX_REMEMBERED_TURNS) this.interrupted.delete(this.interrupted.values().next().value!);
      srv.request('turn/interrupt', { threadId, turnId: t.id }).then(
        () => this.opts.feed.line('sys', `ход ${shortId(t.id)} прерван`),
        (err: unknown) => this.opts.log(`turn/interrupt: ${(err as Error).message}`),
      );
    }
  }

  // ——— очередь → ход ———

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  private armRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.schedulePump();
    }, Math.max(0, this.retryAt - Date.now()));
  }

  private inputText(lines: string[], remind: number[], batch: Queued[]): string {
    const parts = [...lines];
    if (remind.length) parts.push(`[адаптер · напоминание] Ход закончился, а на ${seqList(remind)} нет ни reply, ни done — ответь владельцу или отметь done.`);
    const crash = batch.filter((b) => b.note === 'crash').map((b) => b.ev.seq);
    if (crash.length) parts.push(`[адаптер · повтор после сбоя Codex: ${seqList(crash)} — проверь, не сделано ли уже]`);
    const restart = batch.filter((b) => b.note === 'restart').map((b) => b.ev.seq);
    if (restart.length) parts.push(`[адаптер · повтор после перезапуска адаптера: ${seqList(restart)} — проверь, не сделано ли уже]`);
    for (const b of batch) parts.push(eventText(b.ev));
    return parts.join('\n\n');
  }

  /** Из очереди — отданное шлюзом этой аренде, по порядку №; прочее ждёт, пока шлюз отдаст его снова. */
  private takeQueued(lease: string): Queued[] {
    const out: Queued[] = [];
    for (let i = 0; i < this.queue.length; ) {
      if (this.queue[i]!.lease === lease) out.push(...this.queue.splice(i, 1));
      else i++;
    }
    return out;
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      for (;;) {
        const srv = this.codex;
        const client = this.client;
        const threadId = this.threadId;
        const st = client?.state;
        if (!this.ready || !srv || !threadId || !client || st?.kind !== 'leased' || this.stopping) return;
        if (this.mode === 'stopped') return;
        const lease = st.leaseId;
        const steerLines = this.active !== null && this.lines.length > 0;
        if (!this.queue.some((q) => q.lease === lease) && this.remindSeqs.length === 0 && !steerLines) return;
        if (!this.active && Date.now() < this.retryAt) {
          this.armRetry();
          return;
        }
        const batch = this.takeQueued(lease);
        const remind = this.remindSeqs.splice(0);
        const lines = this.lines.splice(0);
        const text = this.inputText(lines, remind, batch);
        const gatewayTurn = client.turn;
        const clientId = batch.length ? `stg-${batch.map((b) => b.ev.seq).join('-')}` : remind.length ? `stg-remind-${remind.join('-')}` : `stg-mode-${Date.now()}`;
        let resp: TurnStartResponse;
        try {
          resp = await srv.request<TurnStartResponse>('turn/start', { threadId, input: [{ type: 'text', text }], clientUserMessageId: clientId });
        } catch (err) {
          this.queue.unshift(...batch);
          this.queue.sort((a, b) => a.ev.seq - b.ev.seq);
          this.remindSeqs.unshift(...remind);
          this.lines.unshift(...lines);
          if (this.codex !== srv) return;
          this.retryAt = Date.now() + this.opts.timing.turnRetryMs;
          this.opts.log(`turn/start: ${(err as Error).message}`);
          this.opts.feed.line('warn', `Codex не принял ввод (${(err as Error).message}) — повтор через ${seconds(this.opts.timing.turnRetryMs)}`);
          this.armRetry();
          return;
        }
        const turnId = resp.turn.id;
        const steered = this.active !== null && this.active.id === turnId;
        if (!steered) {
          // Прежний ход (если был) кончился, а turn/completed ещё в пути: он остаётся в openTurns до своего конца.
          this.active = this.openTurns.get(turnId) ?? { id: turnId, gatewayTurn, seqs: new Set(), startedAt: Date.now() };
          this.openTurns.set(turnId, this.active);
          this.turnGateway.set(turnId, gatewayTurn);
          while (this.turnGateway.size > MAX_REMEMBERED_TURNS) this.turnGateway.delete(this.turnGateway.keys().next().value!);
        }
        const t = this.active!;
        for (const b of batch) {
          t.seqs.add(b.ev.seq);
          this.handed.set(b.ev.seq, { ev: b.ev, turnId, lease: b.lease });
        }
        for (const s of remind) {
          t.seqs.add(s);
          const h = this.handed.get(s);
          if (h) h.turnId = turnId;
        }
        const what = [batch.length ? seqList(batch.map((b) => b.ev.seq)) : '', remind.length ? `напоминание о ${seqList(remind)}` : '', lines.length ? 'строка режима' : '']
          .filter(Boolean)
          .join(' · ');
        this.opts.feed.line('turn', steered ? `ввод добавлен в идущий ход: ${what}` : `ход ${shortId(turnId)} начат: ${what}`);
        for (const b of batch) this.markDelivered(b.ev.seq);
        this.saveState();
        // «Стоп» пришёл, пока ждали ответа на turn/start: ход только что начат — прервать.
        if ((this.mode as Mode) === 'stopped') this.interruptActive();
        const early = this.completedEarly.get(turnId);
        // Ход идёт — «печатает…» на весь ход (после delivered: шлюз берёт № уже отданных агенту).
        if (early) this.onTurnCompleted(early);
        else this.syncWorking();
      }
    } finally {
      this.pumping = false;
      if (this.pumpAgain) {
        this.pumpAgain = false;
        this.schedulePump();
      }
    }
  }

  /** № событий идущих ходов (не прерванных «стопом»): в их чатах шлюз держит «печатает…». */
  private workingSeqs(): number[] | null {
    const live = [...this.openTurns.values()].filter((t) => !this.interrupted.has(t.id));
    if (!live.length) return null;
    return [...new Set(live.flatMap((t) => [...t.seqs]))].sort((a, b) => a - b);
  }

  /**
   * «Агент работает» шлюзу (#55): ход идёт — working {on: true, seqs}, набор сменился — сразу, тот же — не чаще
   * workingRepeatMs (вызывается на признаки жизни Codex); хода нет — working {on: false}, один раз.
   */
  private syncWorking(): void {
    const client = this.client;
    if (!client || client.state.kind !== 'leased' || this.workingUnsupported) return;
    const seqs = this.ready && this.mode !== 'stopped' ? this.workingSeqs() : null;
    if (seqs === null) {
      if (this.workingSent === null) return;
      this.workingSent = null;
      this.sendWorking(client, false, []);
      return;
    }
    const sig = seqs.join(',');
    const now = Date.now();
    const prev = this.workingSent;
    if (prev && prev.sig === sig && now - prev.at < this.opts.timing.workingRepeatMs) return;
    this.workingSent = { sig, at: now };
    this.sendWorking(client, true, seqs);
  }

  private sendWorking(client: GatewayClient, on: boolean, seqs: number[]): void {
    client.request('working', on ? { on, seqs } : { on }).then(
      (r) => {
        if (r.type !== 'error') return;
        if (r.code === 'bad_request' && /неизвестный type/.test(r.text)) {
          if (!this.workingUnsupported) this.opts.log('шлюз не знает working (старая версия): «печатает…» гаснет после промежуточного ответа, как раньше');
          this.workingUnsupported = true;
          this.workingSent = null;
          return;
        }
        // Аренда ещё не проверена (проба в пути): после проверки — снова (closeProbe), не дожидаясь признаков жизни Codex.
        if (r.code === 'unverified') this.workingSent = null;
        this.opts.log(`working: ${r.code} — ${r.text}`);
      },
      (err: unknown) => this.opts.log(`working: ${(err as Error).message}`),
    );
  }

  private markDelivered(seq: number): void {
    const client = this.client;
    if (!client) return;
    client.request('delivered', { seq }).then(
      (r) => {
        if (r.type === 'error') this.opts.log(`delivered № ${seq}: ${r.code} — ${r.text}`);
      },
      (err: unknown) => this.opts.log(`delivered № ${seq}: ${(err as Error).message}`),
    );
  }

  // ——— уведомления app-server ———

  private onNotification(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    if (typeof p.threadId === 'string' && this.threadId !== null && p.threadId !== this.threadId) return;
    // Признак жизни Codex в ходе — «печатает…» продлить (не чаще workingRepeatMs); конец хода — ниже.
    if (method !== 'turn/completed' && p.threadId === this.threadId) this.syncWorking();
    switch (method) {
      case 'turn/completed':
        this.onTurnCompleted(p as unknown as TurnCompletedNotification);
        return;
      case 'item/started':
        this.onItem((p as unknown as ItemNotification).item, false);
        return;
      case 'item/completed':
        this.onItem((p as unknown as ItemNotification).item, true);
        return;
      case 'thread/tokenUsage/updated':
        this.lastUsage = (p as unknown as TokenUsageNotification).tokenUsage ?? null;
        return;
      case 'error':
        this.opts.log(`Codex error: ${oneLine(JSON.stringify(p), 500)}`);
        return;
      case 'warning':
      case 'deprecationNotice':
      case 'configWarning':
        this.opts.log(`Codex ${method}: ${oneLine(String(p.message ?? p.summary ?? JSON.stringify(p)), 300)}`);
        return;
      default:
        return;
    }
  }

  private onItem(item: ThreadItem | undefined, completed: boolean): void {
    if (!item) return;
    const it = item as ThreadItem & Record<string, unknown>;
    switch (item.type) {
      case 'commandExecution':
        if (!completed) this.opts.feed.line('cmd', oneLine(String(it.command ?? ''), 200));
        else {
          const code = it.exitCode;
          const dur = typeof it.durationMs === 'number' ? ` · ${seconds(it.durationMs)}` : '';
          this.opts.feed.line('cmd', `↳ ${code === 0 ? 'готово' : code === null || code === undefined ? String(it.status ?? 'прервано') : `код ${String(code)}`}${dur}`);
        }
        return;
      case 'fileChange':
        if (!completed) return;
        for (const c of (it.changes as Array<{ path?: string; kind?: unknown }> | undefined) ?? []) {
          const kind = typeof c.kind === 'string' ? c.kind : ((c.kind as { type?: string } | undefined)?.type ?? 'правка');
          this.opts.feed.line('file', `${kind} ${c.path ?? '?'}${it.status && it.status !== 'completed' ? ` (${String(it.status)})` : ''}`);
        }
        return;
      case 'reasoning': {
        if (!completed) return;
        const summary = ((it.summary as string[] | undefined) ?? []).join(' ').trim();
        if (summary) this.opts.feed.line('think', oneLine(summary, 300));
        return;
      }
      case 'agentMessage': {
        if (!completed) return;
        const text = String(it.text ?? '').trim();
        if (text) {
          this.opts.feed.line('text', `(владелец не видит) ${oneLine(text, 300)}`);
          this.opts.log(`текст хода (владельцу не уходит): ${oneLine(text, 500)}`);
        }
        return;
      }
      case 'webSearch':
        if (completed) this.opts.feed.line('tool', `поиск: ${oneLine(String(it.query ?? ''), 200)}`);
        return;
      case 'mcpToolCall':
        if (completed) this.opts.feed.line('tool', `MCP ${String(it.server ?? '?')}.${String(it.tool ?? '?')} — ${String(it.status ?? '')}`);
        return;
      case 'contextCompaction':
        if (completed) this.opts.feed.line('sys', 'Codex сжал разговор');
        return;
      default:
        return;
    }
  }

  private usageLine(): string {
    const last = this.lastUsage?.last;
    if (!last) return '';
    const k = (n: number | undefined): string => (n === undefined ? '?' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    return ` · токены: ${k(last.inputTokens)} на входе (${k(last.cachedInputTokens)} из кэша), ${k(last.outputTokens)} на выходе`;
  }

  private onTurnCompleted(p: TurnCompletedNotification): void {
    const turn: Turn | undefined = p.turn;
    if (!turn) return;
    const t = this.openTurns.get(turn.id);
    if (!t) {
      // Ответ на turn/start ещё не пришёл (ход кончился мгновенно) — разберём, когда придёт.
      if (!this.turnGateway.has(turn.id)) this.completedEarly.set(turn.id, p);
      return;
    }
    this.completedEarly.delete(turn.id);
    this.openTurns.delete(turn.id);
    if (this.active?.id === turn.id) this.active = null;
    this.syncWorking();
    const dur = typeof turn.durationMs === 'number' ? turn.durationMs : Date.now() - t.startedAt;
    if (turn.status === 'completed') {
      this.opts.feed.line('turn', `ход ${shortId(t.id)} закончен за ${seconds(dur)}${this.usageLine()}`);
      this.failures = 0;
      this.told.clear();
      const unanswered = [...t.seqs].filter((s) => this.handed.get(s)?.turnId === t.id && !this.reminded.has(s));
      if (unanswered.length) {
        for (const s of unanswered) this.reminded.add(s);
        this.remindSeqs.push(...unanswered);
        this.opts.feed.line('sys', `на ${seqList(unanswered)} нет ни reply, ни done — напоминаю агенту (один раз)`);
      }
    } else if (turn.status === 'interrupted') {
      this.opts.feed.line('turn', `ход ${shortId(t.id)} прерван${this.usageLine()}`);
    } else {
      this.onTurnFailed(t, turn);
    }
    this.schedulePump();
  }

  private onTurnFailed(t: ActiveTurn, turn: Turn): void {
    const kind = errorKind(turn.error?.codexErrorInfo);
    const msg = turn.error?.message ?? turn.status;
    this.requeue(t, 'crash');
    let delay: number;
    const ownerLine = kind ? OWNER_PROBLEMS[kind] : undefined;
    if (ownerLine) {
      delay = this.opts.timing.limitRetryMs;
      this.tellOwner(kind!, ownerLine);
    } else {
      this.failures++;
      const r = this.opts.timing.failRetryMs;
      delay = r[Math.min(this.failures - 1, r.length - 1)]!;
      if (this.failures >= r.length) this.tellOwner('failed', `⚠ Codex: ход не удаётся (${oneLine(msg, 120)}) — пробую снова. Сообщения не потеряются.`);
    }
    this.retryAt = Date.now() + delay;
    this.armRetry();
    this.opts.log(`ход ${t.id} упал: ${kind ?? '—'} · ${msg}`);
    this.opts.feed.line('warn', `ход ${shortId(t.id)} не удался: ${kind ? `${kind} · ` : ''}${oneLine(msg, 160)} — повтор через ${seconds(delay)}`);
  }

  /** Строка владельцу без № — одна на беду, до первого удачного хода. */
  private tellOwner(kind: string, text: string): void {
    const client = this.client;
    if (!client || this.told.has(kind)) return;
    this.told.add(kind);
    void callTool({ client, timezone: this.opts.gateway.timezone, log: this.opts.log }, 'reply', { text }).then((out) => {
      const first = out.content[0];
      this.opts.feed.line(out.isError ? 'warn' : 'out', `адаптер → владельцу: «${oneLine(text, 120)}» → ${first?.type === 'text' ? first.text : ''}`);
    });
  }

  // ——— запросы app-server ———

  private async onServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'item/tool/call') {
      this.syncWorking();
      return this.onToolCall(params as ToolCallParams);
    }
    if (APPROVAL_REQUESTS.has(method)) {
      this.opts.feed.line('warn', `Codex просит разрешения (${method}) — отказано: владелец в Telegram`);
      return { decision: 'decline' };
    }
    this.opts.log(`запрос Codex ${method} — отказ`);
    throw new RpcError('владелец в Telegram, не у терминала — спроси его через reply', -32000);
  }

  private async onToolCall(p: ToolCallParams): Promise<ToolCallResponse> {
    const args = p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? (p.arguments as Record<string, unknown>) : {};
    let res: ToolCallResponse;
    if (this.interrupted.has(p.turnId)) {
      // Ход прерван «стопом»: поздний вызов не должен проскочить с новым ходом шлюза.
      res = refusal(OUTCOME.stopped);
    } else if (!this.client) {
      res = refusal(OUTCOME.gatewayDown);
    } else {
      const turn = this.turnGateway.get(p.turnId);
      const out = await callTool(
        { client: this.client, timezone: this.opts.gateway.timezone, log: this.opts.log, mediaTimeoutMs: this.opts.gateway.timing.mediaTimeoutMs, ...(turn !== undefined ? { turn } : {}) },
        p.tool,
        args,
      );
      res = toToolResponse(out);
    }
    const a = answeredBy(p.tool, args, res.success);
    for (const s of a.seqs) this.answer(s);
    if (a.episode !== null) {
      for (const [s, h] of this.handed) if (h.ev.kind === 'episode_closed' && h.ev.episode?.id === a.episode) this.answer(s);
    }
    if (a.seqs.length || a.episode !== null) this.saveState();
    const d = describeCall(p.tool, args, res);
    this.opts.feed.line(res.success ? d.kind : 'warn', d.text);
    return res;
  }

  private answer(seq: number): void {
    this.handed.delete(seq);
    this.reminded.delete(seq);
    this.restartPending.delete(seq);
  }

  private saveState(): void {
    const pending = [...new Set([...this.handed.keys(), ...this.queue.map((q) => q.ev.seq)])].sort((a, b) => a - b);
    this.state = { ...this.state, pending };
    try {
      saveState(this.opts.stateFile, this.state);
    } catch (err) {
      this.opts.log(`state.json не записан: ${(err as Error).message}`);
    }
  }
}
