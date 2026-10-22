// Состояние агента глазами шлюза (TECH-SPEC 5.14; J-4; P-1, D-6). Файл $STG_HOME/agent-state.json
// пишет не шлюз, а сессия агента — подкомандами `stg agent-state statusline` и `stg agent-state hook` (строка
// состояния и перехватчики Claude Code); шлюз его только читает: fs.watch по каталогу бота и опрос раз в 5 с ⟨предл.⟩ —
// на случай пропущенного события (FSEvents их сливает, каталог могли пересоздать).
//
// Что из него следует (packages/core/src/agent-state.ts, agentView): контекст `🧠 16%` или сжатие `🌀`, лимиты `🕐 31% ·
// 64%`, отказ модели — кружок 🔴. Отказ снимается, когда агент снова ответил: `reply` или `done` после отказа (это
// знает шлюз — noteAgentActivity) или перерисовка строки состояния с выросшей суммой сессии (это пишет сама строка).
//
// Отказ модели (D-6) — ещё и строка владельцу `⚙ Агент не может ответить: <коротко>`: не чаще раза в час на одну и ту же
// ошибку (meta.agent_failure_notice); другая ошибка — сразу. Сравниваются тип и текст без чисел (номера запросов,
// время в тексте ошибки «той же» ошибкой её не делают другой) — failureSignature в stg-core. Запись StopFailure, которая
// не отказ (max_output_tokens — ответ длиннее предела), — без 🔴 и без строки владельцу.

import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_STATE_FILE,
  META_KEYS,
  agentFailureNotice,
  agentView,
  failureSignature,
  getMeta,
  isRefusal,
  parseAgentState,
  setMeta,
  sql,
  transaction,
  type AgentStateFile,
  type AgentView,
  type Timer,
} from 'stg-core';
import { enqueueServiceLine, type Ctx } from './context.js';

/** Опрос файла — на случай пропущенного события fs.watch ⟨предл.⟩. */
export const AGENT_STATE_POLL_MS = 5_000;
/** Та же ошибка модели — строка владельцу не чаще раза в час (задание P-1, D-6). */
export const FAILURE_NOTICE_REPEAT_MS = 3600_000;

export interface AgentStateLive {
  /** Агент на связи (проверенная аренда). */
  online(): boolean;
  /** Каталог сессии из аренды (session_hint.cwd канала). */
  leaseCwd(): string | null;
}

export interface AgentStateHooks {
  /** Состояние изменилось — сверить закреплённую строку (и отправить строку об отказе). */
  onChange(): void;
}

export class AgentStateWatcher {
  private state: AgentStateFile | null = null;
  private fileSig: string | null = null;
  private fsWatcher: fs.FSWatcher | null = null;
  private timer: Timer | null = null;
  /** Когда агент последний раз ответил или отметил done (часы шлюза). */
  private lastActivity = 0;
  private readError: string | null = null;
  private hidden: AgentView['contextHidden'] = null;
  private live: AgentStateLive = { online: () => false, leaseCwd: () => null };
  private readonly realpaths = new Map<string, string>();

  constructor(
    private readonly ctx: Ctx,
    private readonly hooks: AgentStateHooks,
  ) {}

  bindLive(live: AgentStateLive): void {
    this.live = live;
  }

  private get file(): string {
    return path.join(this.ctx.paths.home, AGENT_STATE_FILE);
  }

  start(): void {
    this.lastActivity = this.activityFromDb();
    this.safeReload();
    try {
      // Файл заменяется переименованием — следить за каталогом; прочие файлы каталога (база, журнал) — мимо.
      this.fsWatcher = fs.watch(this.ctx.paths.home, { persistent: false }, (_ev, name) => {
        if (name && name !== AGENT_STATE_FILE) return;
        this.safeReload();
      });
      this.fsWatcher.on('error', (err) => {
        this.ctx.journal.write('agent_state_watch_failed', { error: err.message });
        this.fsWatcher?.close();
        this.fsWatcher = null;
      });
    } catch (err) {
      this.ctx.journal.write('agent_state_watch_failed', { error: (err as Error).message });
    }
    this.timer ??= this.ctx.clock.setInterval(() => this.safeReload(), AGENT_STATE_POLL_MS);
  }

  /**
   * Перечитать из события или таймера: значки агента — не повод ронять шлюз; ошибка — в журнал (диск полон — общее
   * состояние, disk.ts).
   */
  private safeReload(): void {
    try {
      this.reload();
    } catch (err) {
      if (!this.ctx.disk.check(err, 'agent_state')) this.ctx.journal.write('agent_state_failed', { error: (err as Error).message });
    }
  }

  stop(): void {
    this.fsWatcher?.close();
    this.fsWatcher = null;
    this.timer?.cancel();
    this.timer = null;
  }

  /** Что сейчас в файле (для «статус»). */
  snapshot(): AgentStateFile | null {
    return this.state;
  }

  /**
   * Какая сессия Claude Code сейчас в каталоге cwd (0.3.2, R-4 а): session_id и время последней строки состояния, если
   * её каталог — cwd: текущий (workspace.current_dir) или каталог проекта (project_dir) — так же, как у 🧠 (agentView):
   * агент мог перейти командой cd в подпапку, а сессия та же. Сравнение — по realpath. Файл перечитывается сразу
   * (переходник подключился до первого опроса — после старта шлюза — или раньше события fs.watch). null — не знаем:
   * строки нет, она без session_id, другой каталог.
   */
  sessionFor(cwd: string | null): { id: string; at: number } | null {
    this.safeReload();
    const sl = this.state?.statusline;
    if (!cwd || !sl?.session_id) return null;
    const lease = this.real(cwd);
    const same = [sl.cwd, sl.project_dir].some((d) => d !== null && this.real(d) === lease);
    return same ? { id: sl.session_id, at: sl.at } : null;
  }

  /** Что показать сейчас. Причину, по которой 🧠 не показан (другая сессия, старые, после сжатия), — в журнал при смене. */
  view(now = this.ctx.clock.now()): AgentView {
    const v = agentView(this.state, {
      now,
      online: this.live.online(),
      leaseCwd: this.live.leaseCwd(),
      lastAgentActivityAt: this.lastActivity,
      sameDir: (a, b) => this.real(a) === this.real(b),
    });
    if (v.contextHidden !== this.hidden) {
      if (v.contextHidden === 'other_session' || v.contextHidden === 'stale') {
        this.ctx.journal.write('agent_context_hidden', { why: v.contextHidden, lease_cwd: this.live.leaseCwd(), statusline_cwd: this.state?.statusline?.cwd ?? null });
      }
      this.hidden = v.contextHidden;
    }
    return v;
  }

  /**
   * Агент ответил (`reply`) или отметил `done` — модель работает: отказ, бывший раньше, больше не действует.
   */
  noteAgentActivity(): void {
    const now = this.ctx.clock.now();
    const f = this.state?.failure;
    const wasFailed = f && isRefusal(f) && f.cleared_at === null && f.at > this.lastActivity;
    this.lastActivity = Math.max(this.lastActivity, now);
    if (wasFailed) {
      this.ctx.journal.write('agent_failure_cleared', { by: 'agent_reply', failure_at: f.at });
      this.hooks.onChange();
    }
  }

  /** Перечитать файл, если он сменился. */
  reload(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.state !== null || this.fileSig !== null) {
          this.state = null;
          this.fileSig = null;
          this.hooks.onChange();
        }
        return;
      }
      this.readFailed(err as Error);
      return;
    }
    const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (sig === this.fileSig) return;
    let next: AgentStateFile;
    try {
      next = parseAgentState(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      this.fileSig = sig;
      this.readFailed(err as Error);
      return;
    }
    this.fileSig = sig;
    this.readError = null;
    const prev = this.state;
    this.state = next;
    this.journalChanges(prev, next);
    try {
      this.maybeNotifyFailure(next);
    } catch (err) {
      if (!this.ctx.disk.check(err, 'agent_failure_notice')) this.ctx.journal.write('agent_failure_notice_failed', { error: (err as Error).message });
    }
    this.hooks.onChange();
  }

  private readFailed(err: Error): void {
    if (this.readError === err.message) return;
    this.readError = err.message;
    this.ctx.journal.write('agent_state_unreadable', { error: err.message });
  }

  private journalChanges(prev: AgentStateFile | null, next: AgentStateFile): void {
    const j = this.ctx.journal;
    if (!prev) j.write('agent_state', { statusline_at: next.statusline?.at ?? null, session: next.statusline?.session_id ?? null });
    if (next.compact && next.compact.since !== prev?.compact?.since) j.write('agent_compact', { state: 'start', since: next.compact.since, trigger: next.compact.trigger });
    if (next.compacted && next.compacted.at !== prev?.compacted?.at) j.write('agent_compact', { state: 'end', at: next.compacted.at, trigger: next.compacted.trigger });
    const f = next.failure;
    if (f && f.at !== prev?.failure?.at) j.write('agent_failure', { at: f.at, type: f.type, text: f.text, ...(f.details ? { details: f.details } : {}), session: f.session_id });
    if (f && f.cleared_at !== null && prev?.failure?.cleared_at == null && f.at === prev?.failure?.at) {
      j.write('agent_failure_cleared', { by: 'statusline', failure_at: f.at, cleared_at: f.cleared_at });
    }
  }

  /** Строка владельцу об отказе модели: новый действующий отказ; та же ошибка — не чаще раза в час. */
  private maybeNotifyFailure(s: AgentStateFile): void {
    const f = s.failure;
    if (!f || f.cleared_at !== null) return;
    const now = this.ctx.clock.now();
    if (!this.view(now).failure) return;
    const db = this.ctx.db;
    let prev: { sig?: unknown; at?: unknown; failure_at?: unknown } = {};
    try {
      prev = JSON.parse(getMeta(db, META_KEYS.agentFailureNotice) ?? '{}') as typeof prev;
    } catch {
      prev = {};
    }
    // Об этом отказе (или более позднем) уже решено.
    if (typeof prev.failure_at === 'number' && f.at <= prev.failure_at) return;
    const sig = failureSignature(f);
    const repeat = prev.sig === sig && typeof prev.at === 'number' && now - prev.at < FAILURE_NOTICE_REPEAT_MS;
    const text = agentFailureNotice(f.text);
    transaction(db, () => {
      if (!repeat) enqueueServiceLine(this.ctx, text);
      setMeta(db, META_KEYS.agentFailureNotice, JSON.stringify({ sig, at: repeat ? prev.at : now, failure_at: f.at }));
    });
    this.ctx.journal.write(repeat ? 'agent_failure_notice_skipped' : 'agent_failure_notice', { failure_at: f.at, type: f.type, ...(repeat ? { told_at: prev.at } : { text }) });
  }

  /** Когда агент последний раз ответил или отметил done — по базе (при старте шлюза). */
  private activityFromDb(): number {
    try {
      const r = sql(this.ctx.db,
        `SELECT max(t) AS t FROM (
           SELECT max(processed_at) AS t FROM events WHERE status = 'processed'
           UNION ALL SELECT max(created_at) FROM outbox WHERE origin = 'agent')`,
      ).get() as { t: number | null };
      return r.t ?? 0;
    } catch {
      return 0;
    }
  }

  private real(p: string): string {
    let r = this.realpaths.get(p);
    if (r === undefined) {
      try {
        r = fs.realpathSync.native(p);
      } catch {
        r = path.resolve(p);
      }
      if (this.realpaths.size > 64) this.realpaths.clear();
      this.realpaths.set(p, r);
    }
    return r;
  }
}
