// Состояние агента: контекст и сжатие, лимиты 5 ч · неделя, отказ модели (J-4; P-1, D-6; TECH-SPEC 5.14). Владельцу
// видно: на связи ли агент, сколько занято контекста и идёт ли сжатие, состояние лимитов. «На связи» — кружком,
// без слов; у лимитов — свой значок.
//
// Шлюз сам о контексте и лимитах агента не знает: их знает сессия Claude Code. Она отдаёт их двумя путями, оба —
// подкомандами `stg agent-state` (packages/cli/src/agent-state.ts) в один файл $STG_HOME/agent-state.json:
// - строка состояния Claude Code (statusLine): при каждой перерисовке на stdin — JSON сессии (session_id, cwd,
//   context_window.used_percentage, rate_limits.five_hour / seven_day с resets_at, cost.total_cost_usd);
// - перехватчики (hooks): PreCompact / PostCompact — сжатие началось и кончилось; StopFailure — ход кончился ошибкой API.
//   Поля StopFailure сверены по самому Claude Code 2.1.306: `error` — тип (oauth_org_not_allowed,
//   rate_limit, …), `last_assistant_message` — текст ошибки, как его видно на экране агента (например,
//   «You've hit your limit · resets 3pm»), `error_details` — сырое сообщение
//   API, есть не всегда. Полей error_type и error_message, как было записано по документации, нет.
// Шлюз файл только читает (packages/gateway/src/agent-state.ts) и показывает во второй строке закреплённой строки:
// `🟢 · 🧠 16% · 🕐 31% · 📅 64%`.
//
// Здесь — общее для писателя и читателя: формат файла, слияние, очистка текста ошибки, что показывать и как. Модуль
// лёгкий (только node:fs, node:path и соседние модули без пакетов): его грузит строка состояния агента при каждой
// перерисовке — быстро, без базы и сети.

import fs from 'node:fs';
import path from 'node:path';
import { parseClockStart, readFakeClockFile } from './clock.js';
import { writeFileAtomicSync } from './fsutil.js';
import { cutGraphemes } from './split.js';
import { localDate, localDayMonth, localTime } from './time.js';

/** Файл состояния агента в каталоге бота. */
export const AGENT_STATE_FILE = 'agent-state.json';
/** Замок записи: строка состояния и перехватчик могут писать одновременно (читают, сливают, пишут). */
export const AGENT_STATE_LOCK = 'agent-state.lock';
export const AGENT_STATE_VERSION = 1;

/** Сжатие без PostCompact дольше этого — флаг снимается (сессию закрыли посреди сжатия) ⟨предл.⟩. */
export const COMPACT_STALE_MS = 15 * 60_000;
/** Контекст по строке состояния старше этого не показывается ⟨предл.⟩: строка перерисовывается только при работе. */
export const CONTEXT_MAX_AGE_MS = 24 * 3600_000;
/** Отказ модели старше этого без новых — не 🔴 ⟨предл.⟩: о том, что агент не может ответить, — свежие отказы. */
export const FAILURE_MAX_AGE_MS = 24 * 3600_000;
/** Лимит без времени сброса — показывается не дольше часа после записи ⟨предл.⟩. */
export const LIMIT_NO_RESET_MAX_AGE_MS = 3600_000;
/** Выше этого — ⚠ и время сброса (J-4). */
export const LIMIT_WARN_PCT = 80;
/** Сброс ближе этого — время ЧЧ:ММ, дальше — день недели ⟨предл.⟩. */
export const RESET_TIME_WITHIN_MS = 12 * 3600_000;
/** Предел текста ошибки в файле. */
export const FAILURE_TEXT_MAX = 200;
/**
 * Типы StopFailure, которые не отказ модели ⟨предл.⟩: max_output_tokens — ответ длиннее предела (или окно контекста
 * кончилось и дальше будет сжатие), модель при этом отвечает. Записываются и видны в «статус», но не 🔴 и без строки
 * владельцу; заменяют прежний отказ — модель снова ответила.
 */
export const NOT_REFUSAL_TYPES: ReadonlySet<string> = new Set(['max_output_tokens']);
/** Сколько сессий помнит отметка суммы отказа (строки состояния разных сессий могут чередоваться). */
const FAILURE_MARKS_MAX = 8;

export interface LimitWindow {
  /** Израсходовано, % (как прислал Claude Code, не округлено). */
  pct: number;
  /** Когда окно сбрасывается, мс эпохи; null — не прислано. */
  resets_at: number | null;
  /** Когда записано (часы писателя). */
  at: number;
}

export interface StatuslineRecord {
  /** Когда перерисовалась строка состояния (часы писателя). */
  at: number;
  session_id: string | null;
  cwd: string | null;
  project_dir: string | null;
  model: string | null;
  /** context_window.used_percentage; null — нет (начало сессии, сразу после сжатия). */
  context_pct: number | null;
  /** cost.total_cost_usd — растёт только с ответами модели: по нему видно, что модель снова отвечает. */
  cost_usd: number | null;
}

export interface CompactRecord {
  since: number;
  session_id: string | null;
  trigger: string | null;
}

export interface CompactedRecord {
  at: number;
  session_id: string | null;
  trigger: string | null;
}

export interface FailureMark {
  session_id: string | null;
  cost_usd: number;
}

export interface FailureRecord {
  at: number;
  session_id: string | null;
  /** Тип — поле `error` StopFailure (rate_limit, authentication_failed, oauth_org_not_allowed, …). */
  type: string | null;
  /**
   * Коротко, что сказала модель — `last_assistant_message` (без «API Error: »): одна строка, без секретов, ≤ 200 знаков.
   */
  text: string;
  /** Сырое сообщение API (`error_details`), если оно есть и в тексте его нет: для «статус». Так же очищено. */
  details: string | null;
  /**
   * Сколько стоила каждая сессия к отказу (по одной отметке на сессию): перерисовка строки с большей суммой той же
   * сессии — модель снова ответила, отказ снят; с меньшей — новый процесс (`--resume`: сумма считается с нуля), отметка
   * ставится заново. Сессии без отметки — отсчёт с её первой перерисовки.
   */
  marks: FailureMark[];
  /** Снят: модель снова ответила (строка состояния). null — действует. */
  cleared_at: number | null;
}

export interface AgentStateFile {
  v: typeof AGENT_STATE_VERSION;
  updated_at: number;
  statusline: StatuslineRecord | null;
  /** Лимиты — общие на подписку: окно, которого нет в новой перерисовке, остаётся до своего сброса. */
  limits: { five_hour: LimitWindow | null; seven_day: LimitWindow | null };
  /** Идёт сжатие (PreCompact без PostCompact). */
  compact: CompactRecord | null;
  /** Последнее законченное сжатие. */
  compacted: CompactedRecord | null;
  /** Последний отказ модели (StopFailure). */
  failure: FailureRecord | null;
}

export function emptyAgentState(now = 0): AgentStateFile {
  return { v: AGENT_STATE_VERSION, updated_at: now, statusline: null, limits: { five_hour: null, seven_day: null }, compact: null, compacted: null, failure: null };
}

// ——— разбор: любое поле может отсутствовать или быть не того вида ———

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function str(v: unknown, max = 512): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Время сброса: число секунд эпохи (как шлёт Claude Code) или миллисекунд (больше 10¹²), строка с числом или ISO.
 * Не разобралось — null.
 */
export function parseResetsAt(v: unknown): number | null {
  const n = num(v);
  if (n !== null) {
    if (n <= 0) return null;
    return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
  }
  if (typeof v === 'string') {
    const t = Date.parse(v.trim());
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function limitWindow(v: unknown): LimitWindow | null {
  const o = obj(v);
  const pct = o ? num(o.pct) : null;
  const at = o ? num(o.at) : null;
  if (!o || pct === null || at === null) return null;
  return { pct, resets_at: num(o.resets_at), at };
}

/** Файл (или что от него осталось) → состояние; непонятные части — null. */
export function normalizeAgentState(v: unknown): AgentStateFile {
  const o = obj(v) ?? {};
  const s = emptyAgentState(num(o.updated_at) ?? 0);
  const sl = obj(o.statusline);
  const slAt = sl ? num(sl.at) : null;
  if (sl && slAt !== null) {
    s.statusline = {
      at: slAt,
      session_id: str(sl.session_id),
      cwd: str(sl.cwd, 4096),
      project_dir: str(sl.project_dir, 4096),
      model: str(sl.model, 128),
      context_pct: num(sl.context_pct),
      cost_usd: num(sl.cost_usd),
    };
  }
  const lim = obj(o.limits);
  if (lim) s.limits = { five_hour: limitWindow(lim.five_hour), seven_day: limitWindow(lim.seven_day) };
  const c = obj(o.compact);
  const cSince = c ? num(c.since) : null;
  if (c && cSince !== null) s.compact = { since: cSince, session_id: str(c.session_id), trigger: str(c.trigger, 32) };
  const cd = obj(o.compacted);
  const cdAt = cd ? num(cd.at) : null;
  if (cd && cdAt !== null) s.compacted = { at: cdAt, session_id: str(cd.session_id), trigger: str(cd.trigger, 32) };
  const f = obj(o.failure);
  const fAt = f ? num(f.at) : null;
  if (f && fAt !== null) {
    // Отметки: список; прежний вид файла (одна отметка `mark`) тоже понимается.
    const rawMarks: unknown[] = Array.isArray(f.marks) ? f.marks : f.mark ? [f.mark] : [];
    const marks: FailureMark[] = [];
    for (const r of rawMarks.slice(0, FAILURE_MARKS_MAX)) {
      const m = obj(r);
      const mCost = m ? num(m.cost_usd) : null;
      if (m && mCost !== null) marks.push({ session_id: str(m.session_id), cost_usd: mCost });
    }
    s.failure = {
      at: fAt,
      session_id: str(f.session_id),
      type: str(f.type, 64),
      text: str(f.text, FAILURE_TEXT_MAX + 8) ?? 'без текста',
      details: str(f.details, FAILURE_TEXT_MAX + 8),
      marks,
      cleared_at: num(f.cleared_at),
    };
  }
  return s;
}

/** Текст файла → состояние; не JSON — исключение (читатель пишет его в журнал). */
export function parseAgentState(raw: string): AgentStateFile {
  return normalizeAgentState(JSON.parse(raw) as unknown);
}

// ——— слияние: строка состояния и перехватчики ———

/** Строка состояния Claude Code (JSON со stdin) → новое состояние. Не объект — исключение. */
export function applyStatusline(prev: AgentStateFile, input: unknown, now: number): AgentStateFile {
  const o = obj(input);
  if (!o) throw new Error('строка состояния: на входе не объект JSON');
  const ws = obj(o.workspace);
  const model = obj(o.model);
  const cw = obj(o.context_window);
  const cost = obj(o.cost);
  const rec: StatuslineRecord = {
    at: now,
    session_id: str(o.session_id),
    cwd: str(ws?.current_dir, 4096) ?? str(o.cwd, 4096),
    project_dir: str(ws?.project_dir, 4096),
    model: str(model?.display_name, 128) ?? str(model?.id, 128),
    context_pct: cw ? num(cw.used_percentage) : null,
    cost_usd: cost ? num(cost.total_cost_usd) : null,
  };
  const rl = obj(o.rate_limits);
  const windowOf = (key: 'five_hour' | 'seven_day'): LimitWindow | null => {
    const w = obj(rl?.[key]);
    const pct = w ? num(w.used_percentage) : null;
    if (w && pct !== null) return { pct, resets_at: parseResetsAt(w.resets_at), at: now };
    // Окна нет в этой перерисовке (до первого ответа модели в сессии; после сброса Claude Code его убирает) — прежнее
    // остаётся: шлюз не покажет его после resets_at.
    return prev.limits[key];
  };
  const next: AgentStateFile = {
    ...prev,
    v: AGENT_STATE_VERSION,
    updated_at: now,
    statusline: rec,
    limits: { five_hour: windowOf('five_hour'), seven_day: windowOf('seven_day') },
  };
  // Отказ модели снимается, когда модель снова ответила: сумма сессии выросла (ответ с токенами). Сумма — на процесс
  // Claude Code: после `--resume` session_id тот же, а сумма с нуля — отметка ставится заново. Отметка у каждой сессии
  // своя: строки двух сессий могут чередоваться. Сессия без отметки — отсчёт с её первой перерисовки.
  const f = prev.failure;
  if (f && f.cleared_at === null && rec.cost_usd !== null) {
    const i = f.marks.findIndex((m) => m.session_id === rec.session_id);
    const mark = i >= 0 ? f.marks[i]! : null;
    if (mark && rec.cost_usd > mark.cost_usd + 1e-9) next.failure = { ...f, cleared_at: now };
    else if (!mark || rec.cost_usd < mark.cost_usd - 1e-9) {
      const rest = f.marks.filter((_, j) => j !== i);
      next.failure = { ...f, marks: [...rest.slice(-(FAILURE_MARKS_MAX - 1)), { session_id: rec.session_id, cost_usd: rec.cost_usd }] };
    }
  }
  return next;
}

export type AgentHookEvent = 'PreCompact' | 'PostCompact' | 'StopFailure';

/**
 * Перехватчик Claude Code (JSON со stdin) → новое состояние; event — что это было (null — событие не наше, состояние
 * то же). Не объект — исключение.
 */
export function applyHook(prev: AgentStateFile, input: unknown, now: number): { state: AgentStateFile; event: AgentHookEvent | null } {
  const o = obj(input);
  if (!o) throw new Error('перехватчик: на входе не объект JSON');
  const name = str(o.hook_event_name, 64);
  const sid = str(o.session_id);
  const trigger = str(o.trigger, 32);
  if (name === 'PreCompact' || name === 'PostCompact') {
    // Сжатие внутри субагента — не сжатие сессии агента ⟨предл.⟩: PostCompact и StopFailure Claude Code для субагентов
    // не шлёт, и 🌀 висел бы до срока. Признак субагента — agent_id (2.1.306 его в PreCompact пока не кладёт: тогда
    // остаётся срок 15 минут и снятие по StopFailure).
    if (str(o.agent_id) !== null) return { state: prev, event: null };
    if (name === 'PreCompact') return { state: { ...prev, updated_at: now, compact: { since: now, session_id: sid, trigger } }, event: name };
    return { state: { ...prev, updated_at: now, compact: null, compacted: { at: now, session_id: sid, trigger } }, event: name };
  }
  if (name === 'StopFailure') {
    const sl = prev.statusline;
    // Сумма сессии к отказу — если строка состояния этой же сессии уже была.
    const marks = sl && sl.cost_usd !== null && sameSession(sid, sl.session_id) ? [{ session_id: sl.session_id, cost_usd: sl.cost_usd }] : [];
    const errObj = obj(o.error);
    const type = (typeof o.error === 'string' && /^[a-z_]{2,40}$/.test(o.error) ? o.error : null) ?? str(o.error_type, 64) ?? str(errObj?.type, 64);
    const text = failureText(o);
    const failure: FailureRecord = { at: now, session_id: sid, type, text, details: failureDetails(o, text), marks, cleared_at: null };
    // Ход кончился ошибкой — сжатие этой сессии, если шло, оборвалось (prompt_too_long, autocompact_thrashing): PostCompact
    // не придёт ⟨предл.⟩.
    const compact = prev.compact && sameSession(prev.compact.session_id, sid) ? null : prev.compact;
    return { state: { ...prev, updated_at: now, failure, compact }, event: name };
  }
  return { state: prev, event: null };
}

/** «API Error: » в начале текста ошибки Claude Code — строке владельцу не нужно: она и так «не может ответить». */
const API_ERROR_PREFIX = /^\s*API Error:\s*/i;

/**
 * Текст отказа из StopFailure: сначала то, что видно на экране агента (`last_assistant_message`), затем сырое сообщение
 * API (`error_details`), затем поля других видов (`error_message`, `message`, `error.message` — с запасом), тип —
 * последним.
 */
export function failureText(o: Obj): string {
  const errObj = obj(o.error);
  const details = obj(o.error_details);
  const candidates: unknown[] = [
    typeof o.last_assistant_message === 'string' ? o.last_assistant_message.replace(API_ERROR_PREFIX, '') : null,
    typeof o.error_details === 'string' ? o.error_details : details?.message,
    o.error_message,
    o.message,
    errObj?.message,
    typeof o.error === 'string' ? o.error : null,
    o.error_type,
  ];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const t = sanitizeErrorText(c);
    if (t) return t;
  }
  return 'без текста';
}

/** `error_details` — отдельно, если он есть и текст отказа не из него (для «статус»). */
function failureDetails(o: Obj, text: string): string | null {
  const raw = typeof o.error_details === 'string' ? o.error_details : obj(o.error_details)?.message;
  if (typeof raw !== 'string') return null;
  const d = sanitizeErrorText(raw);
  return d && d !== text && !text.includes(d) ? d : null;
}

/** «Та же ошибка» для правила «раз в час»: тип и текст без чисел и регистра (номер запроса ошибку другой не делает). */
export function failureSignature(f: FailureRecord): string {
  return `${f.type ?? ''}|${f.text.replace(/\d+/g, '#').toLowerCase()}`;
}

/** Отказ модели — или запись StopFailure, которая не отказ (NOT_REFUSAL_TYPES). */
export function isRefusal(f: FailureRecord): boolean {
  return f.type === null || !NOT_REFUSAL_TYPES.has(f.type);
}

/** Управляющие знаки и знаки направления письма (ими можно переставить текст строки шлюза). */
const UNSAFE_G = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;

/**
 * Текст ошибки — в одну строку, без секретов, не длиннее max: токен бота, ключи вида sk-…, «Bearer …», «api_key=…»,
 * длинные строки из букв и цифр (ключи, номера запросов) → «…»; пометки строк шлюза и агента (⚙, 💬) убраны.
 */
export function sanitizeErrorText(raw: string, max = FAILURE_TEXT_MAX): string {
  let t = raw.replace(UNSAFE_G, ' ');
  t = t
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}/g, '…')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/gi, '…')
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 …')
    .replace(/\b(api[_-]?key|x-api-key|token|authorization|password|secret)(\s*[:=]\s*)["']?[^\s,;"']+["']?/gi, '$1$2…')
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, '…')
    .replace(/[⚙💬]️?/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const c = cutGraphemes(t, max);
  return c.cut ? `${c.text.trimEnd()}…` : c.text;
}

// ——— файл: чтение и запись под замком ———

export function agentStatePath(home: string): string {
  return path.join(home, AGENT_STATE_FILE);
}

/** Прочитать файл состояния; нет файла — null; не JSON — исключение. */
export function readAgentStateFile(home: string): AgentStateFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(agentStatePath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return parseAgentState(raw);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Замок дольше этого — брошен (процесс убит посреди записи: Claude Code снимает строку состояния новой перерисовкой). */
const LOCK_STALE_MS = 2_000;
const LOCK_TRIES = 50;
const LOCK_STEP_MS = 10;

/**
 * Прочитать, слить, записать — под замком (O_EXCL), атомарно (временный файл → переименование), права 0600. Замок не
 * взялся за ~0,5 с — запись без него (лучше, чем потерять перерисовку). Испорченный файл — заново с пустого.
 */
export function updateAgentStateFile(home: string, fn: (prev: AgentStateFile) => AgentStateFile, now: number): AgentStateFile {
  const lock = path.join(home, AGENT_STATE_LOCK);
  let fd: number | null = null;
  for (let i = 0; i < LOCK_TRIES && fd === null; i++) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') break;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      sleepSync(LOCK_STEP_MS);
    }
  }
  try {
    let prev: AgentStateFile;
    try {
      prev = readAgentStateFile(home) ?? emptyAgentState(now);
    } catch {
      prev = emptyAgentState(now);
    }
    const next = fn(prev);
    if (next !== prev) writeFileAtomicSync(agentStatePath(home), JSON.stringify(next) + '\n', 0o600);
    return next;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // уже закрыт
      }
      fs.rmSync(lock, { force: true });
    }
  }
}

// ——— что показывать ———

export interface LimitView {
  /** Целый процент. */
  pct: number;
  resets_at: number | null;
}

export interface AgentView {
  /** Действующий отказ модели — кружок 🔴 вместо 🟢 / 🟡 / ⚪. */
  failure: FailureRecord | null;
  /** Контекст, целый %; null — не показывать 🧠. */
  context: number | null;
  /** Идёт сжатие — 🌀 вместо 🧠. */
  compacting: boolean;
  five: LimitView | null;
  week: LimitView | null;
  /** Почему 🧠 не показан (для журнала): нет данных, агент не на связи, другая сессия, старые, после сжатия. */
  contextHidden: 'none' | 'offline' | 'other_session' | 'stale' | 'after_compact' | null;
}

export interface AgentViewInput {
  now: number;
  /** Агент на связи (проверенная аренда). */
  online: boolean;
  /** Каталог сессии из аренды (session_hint.cwd канала); null — неизвестен. */
  leaseCwd: string | null;
  /** Когда агент последний раз ответил или отметил done (часы шлюза); отказ раньше этого — снят. */
  lastAgentActivityAt: number;
  /** Сравнение каталогов (шлюз — по realpath). */
  sameDir?: (a: string, b: string) => boolean;
}

function sameSession(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

/** Целый процент для строки: округление, не меньше 0. */
export function wholePct(v: number): number {
  return Math.max(0, Math.round(v));
}

function limitView(w: LimitWindow | null, now: number): LimitView | null {
  if (!w) return null;
  if (w.resets_at !== null) {
    // Сброс прошёл — число неизвестно: лимит общий на подписку, после сброса его могли расходовать другие сессии
    // владельца. Не 0 %, а «—» ⟨предл.⟩.
    if (w.resets_at <= now) return null;
  } else if (now - w.at > LIMIT_NO_RESET_MAX_AGE_MS) return null;
  return { pct: wholePct(w.pct), resets_at: w.resets_at };
}

/**
 * Что показать: отказ, контекст или сжатие, лимиты. Данных нет, они от другой сессии или старые — значка нет (а не
 * неверное число).
 */
export function agentView(s: AgentStateFile | null, i: AgentViewInput): AgentView {
  const v: AgentView = { failure: null, context: null, compacting: false, five: null, week: null, contextHidden: null };
  if (!s) {
    v.contextHidden = 'none';
    return v;
  }
  const { now } = i;
  const sl = s.statusline;
  const f = s.failure;
  if (f && isRefusal(f) && f.cleared_at === null && f.at > i.lastAgentActivityAt && now - f.at <= FAILURE_MAX_AGE_MS) v.failure = f;
  const c = s.compact;
  if (c && now - c.since <= COMPACT_STALE_MS && (!sl || sameSession(c.session_id, sl.session_id))) v.compacting = true;
  if (!sl || sl.context_pct === null) v.contextHidden = 'none';
  else if (!i.online) v.contextHidden = 'offline';
  else if (now - sl.at > CONTEXT_MAX_AGE_MS) v.contextHidden = 'stale';
  else if (i.leaseCwd && (sl.cwd || sl.project_dir) && ![sl.cwd, sl.project_dir].some((d) => d !== null && (i.sameDir ?? defaultSameDir)(d, i.leaseCwd!))) {
    v.contextHidden = 'other_session';
  } else if (s.compacted && sameSession(s.compacted.session_id, sl.session_id) && sl.at < s.compacted.at) {
    // Число до сжатия — уже неверное: до следующей перерисовки 🧠 нет.
    v.contextHidden = 'after_compact';
  } else v.context = wholePct(sl.context_pct);
  v.five = limitView(s.limits.five_hour, now);
  v.week = limitView(s.limits.seven_day, now);
  return v;
}

function defaultSameDir(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

const WEEKDAYS: Readonly<Record<string, string>> = { Mon: 'пн', Tue: 'вт', Wed: 'ср', Thu: 'чт', Fri: 'пт', Sat: 'сб', Sun: 'вс' };
const weekdayFormatters = new Map<string, Intl.DateTimeFormat>();

/** День недели коротко в поясе tz: «пт». */
export function weekdayShort(ms: number, tz: string): string {
  let f = weekdayFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    weekdayFormatters.set(tz, f);
  }
  return WEEKDAYS[f.format(ms)] ?? f.format(ms);
}

/** Когда сброс: ближе 12 часов — «14:00» (так понятно и через полночь), дальше — «пт» ⟨предл.⟩. */
export function resetWhen(at: number, tz: string, now: number): string {
  return at - now <= RESET_TIME_WITHIN_MS ? localTime(at, tz) : weekdayShort(at, tz);
}

function limitText(w: LimitView | null, tz: string, now: number): string {
  if (!w) return '—';
  if (w.pct > LIMIT_WARN_PCT) return `⚠${w.pct}%${w.resets_at !== null ? ` до ${resetWhen(w.resets_at, tz, now)}` : ''}`;
  return `${w.pct}%`;
}

/**
 * Значки агента для закреплённой строки, только значки: `🧠 16%` (или `🌀` — идёт сжатие) и `🕐 31% · 📅 64%` (5 часов ·
 * неделя; выше 80% — `⚠85% до 14:00`; окна нет — «—»; нет обоих — без 🕐).
 */
export function agentIndicatorParts(v: AgentView, tz: string, now: number): string[] {
  const parts: string[] = [];
  if (v.compacting) parts.push('🌀');
  else if (v.context !== null) parts.push(`🧠 ${v.context}%`);
  if (v.five || v.week) parts.push(`🕐 ${limitText(v.five, tz, now)} · 📅 ${limitText(v.week, tz, now)}`);
  return parts;
}

/**
 * Переходы, которые важны сразу (не ждут минуты между правками значков): начало и конец сжатия, переход лимита через
 * 80 %, отказ модели и его снятие.
 */
export function agentUrgentSignature(v: AgentView): string {
  return [v.failure ? 'F' : '', v.compacting ? 'C' : '', v.five && v.five.pct > LIMIT_WARN_PCT ? '5' : '', v.week && v.week.pct > LIMIT_WARN_PCT ? '7' : ''].join('');
}

/** Короткая строка внизу экрана агента, если прежней строки состояния нет: `Opus · 🧠 16% · 🕐 31% · 📅 64%`. */
export function statuslineShortLine(input: unknown): string {
  const o = obj(input);
  if (!o) return 'stg · нет данных строки состояния';
  const model = obj(o.model);
  const name = str(model?.display_name, 64) ?? str(model?.id, 64) ?? 'Claude';
  const cw = obj(o.context_window);
  const ctx = cw ? num(cw.used_percentage) : null;
  const rl = obj(o.rate_limits);
  const pct = (k: string): string => {
    const p = num(obj(rl?.[k])?.used_percentage);
    return p === null ? '—' : `${wholePct(p)}%`;
  };
  const parts = [name];
  if (ctx !== null) parts.push(`🧠 ${wholePct(ctx)}%`);
  if (rl && (obj(rl.five_hour) || obj(rl.seven_day))) parts.push(`🕐 ${pct('five_hour')} · 📅 ${pct('seven_day')}`);
  return parts.join(' · ');
}

// ——— «статус» ———

/**
 * Строки для «статус» и `stg status`: что знает шлюз о контексте, сжатии и лимитах агента, последний отказ модели — когда
 * и что сказала. Время — в поясе владельца: сегодня — ЧЧ:ММ, иначе ДД.ММ ЧЧ:ММ.
 */
export function agentStatusLines(s: AgentStateFile | null, v: AgentView, tz: string, now: number): string[] {
  if (!s || (!s.statusline && !s.failure && !s.compact && !s.limits.five_hour && !s.limits.seven_day)) {
    return ['Агент: данных нет — строка состояния и перехватчики Claude Code не подключены (stg agent-state, README папки агента)'];
  }
  const when = (ms: number): string => (localDate(ms, tz) === localDate(now, tz) ? localTime(ms, tz) : `${localDayMonth(ms, tz)} ${localTime(ms, tz)}`);
  const parts: string[] = [];
  const sl = s.statusline;
  if (v.compacting && s.compact) parts.push(`идёт сжатие с ${when(s.compact.since)}`);
  if (sl) {
    const ctx = v.context !== null ? `контекст ${v.context}%` : sl.context_pct !== null ? `контекст ${wholePct(sl.context_pct)}% (${hiddenWhy(v.contextHidden)})` : 'контекст неизвестен';
    parts.push(`${ctx}${sl.model ? `, ${sl.model}` : ''}`);
  }
  const lim = (name: string, w: LimitWindow | null, lv: LimitView | null): string => {
    if (!w) return `${name} —`;
    if (!lv) return `${name} — (сброс прошёл)`;
    if (lv.resets_at === null) return `${name} ${lv.pct}%`;
    const r = lv.resets_at - now <= RESET_TIME_WITHIN_MS ? localTime(lv.resets_at, tz) : `${weekdayShort(lv.resets_at, tz)} ${localTime(lv.resets_at, tz)}`;
    return `${name} ${lv.pct}% (сброс ${r})`;
  };
  if (s.limits.five_hour || s.limits.seven_day) parts.push(`лимиты: ${lim('5 ч', s.limits.five_hour, v.five)}, ${lim('неделя', s.limits.seven_day, v.week)}`);
  if (sl) parts.push(`строка состояния от ${when(sl.at)}`);
  const lines = parts.length ? [`Агент: ${parts.join(' · ')}`] : [];
  const f = s.failure;
  if (f) {
    const state = !isRefusal(f)
      ? 'не отказ — ответ длиннее предела, модель отвечает'
      : v.failure
        ? 'действует'
        : f.cleared_at !== null
          ? `снят в ${when(f.cleared_at)} — модель снова ответила`
          : f.at <= now - FAILURE_MAX_AGE_MS
            ? 'старше суток'
            : 'снят — агент ответил';
    lines.push(`Отказ модели: ${when(f.at)}${f.type ? ` (${f.type})` : ''} — «${f.text}»${f.details ? ` (подробности: ${f.details})` : ''}; ${state}`);
  }
  return lines;
}

function hiddenWhy(h: AgentView['contextHidden']): string {
  switch (h) {
    case 'offline':
      return 'агент не на связи — не показываю';
    case 'stale':
      return 'старше суток — не показываю';
    case 'other_session':
      return 'другая сессия — не показываю';
    case 'after_compact':
      return 'до сжатия — не показываю';
    default:
      return 'не показываю';
  }
}

// ——— часы писателя ———

/**
 * Время записи: настоящее; под тестом с поддельными часами (STG_TEST=1, STG_CLOCK=fake) — время часов шлюза из файла
 * каталога (только чтение), чтобы сроки файла и шлюза шли по одним часам.
 */
export function agentStateNow(env: NodeJS.ProcessEnv, home: string): number {
  if (env.STG_TEST === '1' && env.STG_CLOCK === 'fake') {
    try {
      return readFakeClockFile(env.STG_CLOCK_FILE || path.join(home, 'test-clock.json')) ?? parseClockStart(env.STG_CLOCK_START);
    } catch {
      return Date.now();
    }
  }
  return Date.now();
}
