// Правила доступа и справочник участников (TECH-SPEC 5.9, 5.2; Ш-17, Ш-18, Ш-21, Ш-22; AD-6, AD-9).
//
// Рабочая копия прав — в базе: meta.rules_state (правила целиком, owner из config.yaml уже в них) и её проекция в
// subjects и transports. По ней, и только по ней, шлюз проверяет каждое сообщение: ctx.directory собирается из неё и
// меняется только здесь — после COMMIT транзакции, которая её записала (refresh). rules.yaml — файл этой копии: пишет его
// только шлюз, целиком, через временный файл и переименование.
//
// Кто меняет:
// - агент — инструментом rule через протокол шлюза: сужение (только remove субъекта или чата) применяется сразу; любое
//   другое изменение — карточка владельцу из полей с [разрешить] [нет] (одна группа кнопок на изменение, срок 24 ч) и
//   rules_log pending; текстовое «да» ничего не разрешает. Владельца не убрать и не поменять (Ш-21): отказ, rules_log
//   rejected и строка владельцу. В «стоп» rule не исполняется (dropped_stopped): от агента после «стоп» ничего не уходит;
// - владелец — кнопкой под карточкой; нажатие засчитывается по правилам кнопок (control.ts, buttons.ts): от владельца в
//   личке, токен не использован и не истёк. [разрешить] применяет изменение заново к нынешней копии (с карточки она могла
//   поменяться): не применяется — rejected и строка с причиной;
// - владелец — правкой rules.yaml: читается при перезапуске (AD-6, AD-9), записывается в rules_log (actor owner_file) и
//   строкой владельцу. Испорченный файл — действуют прежние правила, строка владельцу (одна на одну поломку).
// Каждое изменение — строка владельцу и запись rules_log (applied · pending · rejected · expired).
//
// Файл и копия расходятся только на время записи. Порядок: транзакция (копия, rules_log, строка, pending = да) →
// запись файла → транзакция (file = отпечаток записанного, pending = нет). Отпечаток — по смыслу правил, а не по тексту.
// При старте: файл тот, что шлюз знает (file), — правок нет; а копия новее (pending) — файл переписывается. Файл иной —
// это правка владельцем. Пока шлюз работает, правку файла он не читает и поверх неё не пишет: rule получает отказ
// «правлен вручную — прочитается при перезапуске», [разрешить] — тоже (изменение не применено).
// Смена роли чата закрывает его открытые эпизоды (role_change): эпизод — тема × внешняя роль (5.7).

import crypto from 'node:crypto';
import {
  sql,
  BUTTON_REFUSALS,
  META_KEYS,
  RULE_BUTTON_LABELS,
  RULE_REJECTED_TEXT,
  applyChange,
  chatRuleFor,
  classifyChange,
  defaultRules,
  describeChange,
  diffRules,
  effectiveRules,
  encodeRulesState,
  getMeta,
  localDayMonth,
  localTime,
  makeRulesState,
  parseRulesState,
  readRulesFile,
  ruleCardText,
  ruleForbiddenText,
  ruleNotAppliedText,
  rulesChangedText,
  rulesFileBrokenText,
  rulesFingerprint,
  setMeta,
  transaction,
  writeRules,
  type Db,
  type Mode,
  type RuleOp,
  type Rules,
  type RulesLogActor,
  type RulesLogStatus,
  type RulesState,
} from 'stg-core';
import { BUTTON_TTL_MS, createButton, newGroup, useGroup, type ButtonPayload } from './buttons.js';
import { enqueueEdit, enqueueServiceLine, type Ctx, type InlineMarkup } from './context.js';
import type { AgentResult, Effects } from './control.js';
import { Directory } from './directory.js';
import type { EpisodeRow, Episodes } from './episodes.js';

/** Что записано в rules_log.change_json. */
interface LoggedChange {
  ops: RuleOp[];
  kind: 'narrowing' | 'expansion';
  /** Строки из полей на момент просьбы (карточка, stg rules show). */
  lines: string[];
  source?: 'rules.yaml';
  problem?: string;
}

interface LogRow {
  id: number;
  status: RulesLogStatus;
  change_json: string;
  outbox_id: number | null;
}

/**
 * Справочник участников в базе (AD-9) — проекция рабочей копии: субъекты дополняются (убранный остаётся строкой — на
 * него ссылаются его прежние события), записи о транспорте — ровно как в копии: по ним сверяется номер отправителя.
 * Внутри транзакции.
 */
export function syncDirectoryTables(db: Db, rules: Rules): void {
  const upsert = sql(db, 'INSERT INTO subjects(id, who, world_ref) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET who = excluded.who, world_ref = excluded.world_ref');
  sql(db, 'DELETE FROM transports').run();
  const addTransport = sql(db, 'INSERT INTO transports(subject_id, network, address) VALUES (?, ?, ?)');
  for (const s of rules.subjects) {
    upsert.run(s.id, s.who, s.world_ref ?? null);
    for (const t of s.transports) addTransport.run(s.id, t.network, t.address);
  }
}

/**
 * Отказ «владельца не убрать и не поменять» — строкой владельцу, но не потоком: то же изменение второй раз за час — без
 * строки и без записи rules_log (только журнал); разных отказов — не больше 10 строк в час, дальше — rules_log и журнал.
 */
const FORBIDDEN_WINDOW_MS = 3600_000;
const FORBIDDEN_LINES_PER_WINDOW = 10;

function inline(rows: Array<Array<{ text: string; token: string }>>): InlineMarkup {
  return { inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.token }))) };
}

export class RulesService {
  /** Хэш копии, по которой собран ctx.directory. */
  private inForce: string | null = null;
  /** Файл разошёлся с копией (правлен вручную) — в журнал один раз. */
  private divergedNoted = false;
  /** Последняя ошибка записи rules.yaml — в журнал один раз (тикер повторяет запись раз в минуту). */
  private lastWriteError: string | null = null;
  /** Отказы «владельца не поменять» за последний час: отпечаток изменения → когда; когда ушли строки владельцу. */
  private readonly forbiddenSeen = new Map<string, number>();
  private forbiddenTold: number[] = [];

  constructor(
    private readonly ctx: Ctx,
    private readonly episodes: Episodes,
  ) {}

  private get file(): string {
    return this.ctx.paths.rules;
  }

  private ownerAddress(): string | null {
    return this.ctx.config.owner_id !== null ? String(this.ctx.config.owner_id) : null;
  }

  /** Владелец из config.yaml — всегда в правилах (Ш-21); заметки — в журнал. */
  private effective(rules: Rules): Rules {
    const e = effectiveRules(this.ctx.config, rules);
    for (const note of e.notes) this.ctx.journal.write('rules_note', { note });
    return e.rules;
  }

  readState(): RulesState | null {
    return parseRulesState(getMeta(this.ctx.db, META_KEYS.rulesState));
  }

  /** Рабочая копия → база (meta и справочник). Внутри транзакции. */
  private writeState(st: RulesState): void {
    setMeta(this.ctx.db, META_KEYS.rulesState, encodeRulesState(st));
    syncDirectoryTables(this.ctx.db, st.rules);
  }

  private insertLog(l: { actor: RulesLogActor; change: LoggedChange; status: RulesLogStatus; note?: string | null }): number {
    const now = this.ctx.clock.now();
    const r = sql(this.ctx.db, 'INSERT INTO rules_log(at, actor, change_json, status, decided_at, note) VALUES (?, ?, ?, ?, ?, ?)').run(
      now,
      l.actor,
      JSON.stringify(l.change),
      l.status,
      l.status === 'pending' ? null : now,
      l.note ?? null,
    );
    return Number(r.lastInsertRowid);
  }

  private decide(id: number, status: RulesLogStatus, note: string): void {
    sql(this.ctx.db, "UPDATE rules_log SET status = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'pending'").run(status, this.ctx.clock.now(), note, id);
  }

  // ——— старт ———

  /**
   * Сверка rules.yaml с рабочей копией при старте; ctx.directory — по копии. Диск полон — копия в памяти, запишется
   * при следующем старте. Возвращает действующие правила.
   */
  start(): Rules {
    const { ctx } = this;
    const file = readRulesFile(this.file);
    const st = this.readState();
    let next: RulesState;
    let log: LoggedChange | null = null;
    let line: string | null = null;
    let before: Rules | null = null;
    if (!st) {
      // Первый старт (или база до M5, или копия испорчена): копии ещё нет — она берётся из файла; нет файла — правила по
      // умолчанию. Файл шире правил по умолчанию — разница пишется в rules_log (owner_file) и строкой владельцу, как правка
      // файла: без копии не различить, кто его правил, и молча такое не принимается.
      if (file.kind === 'ok') {
        const r = this.effective(file.rules);
        next = makeRulesState(r, file.fp, rulesFingerprint(r) !== file.fp);
        const defaults = this.effective(defaultRules(ctx.config.owner_id));
        const ops = diffRules(defaults, r);
        if (ops.length) {
          const lines = describeChange(defaults, ops, 'file');
          log = { ops, kind: classifyChange(ops), lines, source: 'rules.yaml' };
          line = rulesChangedText('owner_file', lines);
        }
        ctx.journal.write('rules_adopted', { subjects: r.subjects.length, chats: r.chats.length, beyond_default: ops.length });
      } else if (file.kind === 'missing') {
        const r = this.effective(defaultRules(ctx.config.owner_id));
        next = makeRulesState(r, 'missing', true);
        ctx.journal.write('rules_created', { subjects: r.subjects.length, chats: r.chats.length });
      } else {
        // Испорченный файл, копии нет: только владелец — самое узкое; файл не трогается — его правит владелец.
        const r = this.effective(defaultRules(ctx.config.owner_id));
        next = makeRulesState(r, file.fp, false);
        line = rulesFileBrokenText(file.problems[0] ?? 'ошибка');
        ctx.journal.write('rules_file_broken', { problems: file.problems, fallback: 'default' });
      }
    } else {
      // config.yaml могли поправить (owner_id) — владелец из него, как всегда.
      const working = this.effective(st.rules);
      if (file.fp === st.file || file.fp === rulesFingerprint(st.rules)) {
        // Файл — тот, что шлюз знает (или уже с копией): правок нет. Копия новее файла — переписать.
        next = makeRulesState(working, file.fp, file.kind !== 'broken' && file.fp !== rulesFingerprint(working));
      } else if (file.kind === 'missing') {
        next = makeRulesState(working, 'missing', true);
        ctx.journal.write('rules_file_missing', { action: 'restored_from_working_copy' });
      } else if (file.kind === 'broken') {
        next = makeRulesState(working, file.fp, false);
        line = rulesFileBrokenText(file.problems[0] ?? 'ошибка');
        ctx.journal.write('rules_file_broken', { problems: file.problems, fallback: 'working_copy' });
      } else {
        // Правка владельцем (AD-6, AD-9): читается при перезапуске — и записывается в rules_log.
        const r = this.effective(file.rules);
        const ops = diffRules(working, r);
        next = makeRulesState(r, file.fp, rulesFingerprint(r) !== file.fp);
        if (ops.length) {
          const lines = describeChange(working, ops, 'file');
          log = { ops, kind: classifyChange(ops), lines, source: 'rules.yaml' };
          line = rulesChangedText('owner_file', lines);
          before = working;
        }
        ctx.journal.write('rules_manual_edit', { ops: ops.length, lines: log?.lines ?? [] });
      }
    }
    try {
      transaction(ctx.db, () => {
        if (log) this.insertLog({ actor: 'owner_file', change: log, status: 'applied', note: 'правка rules.yaml' });
        if (line) enqueueServiceLine(ctx, line);
        if (before) this.closeRoleEpisodes(next.rules);
        this.writeState(next);
      });
    } catch (err) {
      if (!ctx.disk.check(err, 'rules_start')) throw err;
    }
    this.useRules(next);
    this.syncFile();
    return next.rules;
  }

  private useRules(st: RulesState): void {
    if (this.inForce === st.hash) return;
    this.ctx.directory = new Directory(this.ctx.config, st.rules);
    this.inForce = st.hash;
    this.ctx.journal.write('rules_in_force', { hash: st.hash, subjects: st.rules.subjects.map((s) => s.id), chats: st.rules.chats.map((c) => String(c.chat)) });
  }

  /** После COMMIT: справочник — по рабочей копии в базе; файл — дописать. */
  refresh(): void {
    let st: RulesState | null;
    try {
      st = this.readState();
    } catch (err) {
      this.ctx.journal.write('rules_refresh_failed', { error: (err as Error).message });
      return;
    }
    if (!st) return;
    this.useRules(st);
    this.syncFile();
  }

  /**
   * rules.yaml по рабочей копии, если он отстал (pending). Поверх правки владельцем не пишет: она прочитается при
   * перезапуске. Диск полон — повтор тикером.
   */
  syncFile(): void {
    const { ctx } = this;
    let st: RulesState | null;
    try {
      st = this.readState();
    } catch {
      return;
    }
    if (!st?.pending) return;
    const want = rulesFingerprint(st.rules);
    const cur = readRulesFile(this.file);
    if (cur.fp !== st.file && cur.fp !== want) {
      if (!this.divergedNoted) ctx.journal.write('rules_file_diverged', { note: 'rules.yaml правлен вручную — прочитаю при перезапуске' });
      this.divergedNoted = true;
      return;
    }
    if (cur.fp !== want) {
      try {
        writeRules(this.file, st.rules);
      } catch (err) {
        const msg = (err as Error).message;
        if (!ctx.disk.check(err, 'rules_file') && msg !== this.lastWriteError) ctx.journal.write('rules_write_failed', { error: msg });
        this.lastWriteError = msg;
        return;
      }
      this.lastWriteError = null;
      ctx.journal.write('rules_written', { hash: st.hash });
    }
    try {
      transaction(ctx.db, () => {
        const now = this.readState();
        if (now && now.hash === st.hash) setMeta(ctx.db, META_KEYS.rulesState, encodeRulesState({ ...now, file: want, pending: false }));
      });
    } catch (err) {
      if (!ctx.disk.check(err, 'rules_file')) throw err;
    }
  }

  /**
   * rules.yaml можно переписать: он тот, что шлюз знает (прежний или уже с копией). Тогда — его нынешний отпечаток: он и
   * станет «файлом, каким шлюз его знает» у новой копии. Иначе — почему нельзя.
   */
  private fileGuard(st: RulesState): { ok: true; fp: string } | { ok: false; text: string } {
    if (st.file.startsWith('broken:')) {
      return { ok: false, text: 'rules.yaml не читается — его правит владелец; правила меняются после того, как он исправит файл и перезапустит шлюз' };
    }
    const cur = readRulesFile(this.file);
    if (cur.fp !== st.file && cur.fp !== rulesFingerprint(st.rules)) {
      return { ok: false, text: 'rules.yaml правлен вручную после старта шлюза — правка прочитается при перезапуске, до него правила не меняю' };
    }
    return { ok: true, fp: cur.fp };
  }

  // ——— агент ———

  /** rule(change) от переходника (5.9, 5.10). Своя транзакция; после неё — refresh (adapter.ts). */
  requestChange(ops: RuleOp[], mode: Mode): AgentResult {
    const { ctx } = this;
    if (ctx.config.owner_id === null) return { ok: false, code: 'unavailable', text: 'владелец не задан (первая настройка)' };
    if (mode === 'stopped') {
      ctx.journal.write('rule_dropped', { reason: 'stopped', ops });
      return { ok: true, result: 'dropped_stopped', effects: {} };
    }
    const st = this.readState();
    if (!st) return { ok: false, code: 'unavailable', text: 'рабочей копии правил нет (диск полон) — повтори позже' };
    const guard = this.fileGuard(st);
    if (!guard.ok) {
      ctx.journal.write('rule_refused', { reason: 'rules_file', ops });
      return { ok: false, code: 'unavailable', text: guard.text };
    }
    const kind = classifyChange(ops);
    const lines = describeChange(st.rules, ops);
    const res = applyChange(st.rules, ops, { ownerAddress: this.ownerAddress() });
    if (!res.ok && res.kind === 'invalid') {
      ctx.journal.write('rule_invalid', { ops, problem: res.text, op: res.index + 1 });
      return { ok: false, code: 'bad_request', text: `операция ${res.index + 1}: ${res.text}` };
    }
    if (!res.ok) {
      // Ш-21: владельца правилом не убрать и не поменять — отказ; владелец видит, что агент об этом просил (не потоком).
      const tell = this.forbiddenTell(ops);
      if (tell !== 'repeat') {
        transaction(ctx.db, () => {
          this.insertLog({ actor: 'agent', change: { ops, kind, lines, problem: res.text }, status: 'rejected', note: `отказ шлюза: ${res.text}` });
          if (tell === 'line') enqueueServiceLine(ctx, ruleForbiddenText(res.text, lines));
        });
      }
      ctx.journal.write('rule_forbidden', { ops, problem: res.text, lines, told: tell });
      return { ok: false, code: 'bad_request', text: `отказано: ${res.text}` };
    }
    const next = this.effective(res.rules);
    if (rulesFingerprint(next) === rulesFingerprint(st.rules)) {
      return { ok: false, code: 'bad_request', text: 'изменение ничего не меняет в правилах' };
    }
    if (kind === 'narrowing') {
      const id = transaction(ctx.db, () => {
        const logId = this.insertLog({ actor: 'agent', change: { ops, kind, lines }, status: 'applied', note: 'сужение — сразу' });
        enqueueServiceLine(ctx, rulesChangedText('agent', lines));
        this.writeState(makeRulesState(next, guard.fp, true));
        return logId;
      });
      ctx.journal.write('rule_applied', { id, by: 'agent', kind, lines });
      return { ok: true, result: 'applied', effects: { rules: true } };
    }
    // Расширение (Ш-22): карточка из полей — одна группа кнопок на изменение, срок 24 ч.
    const id = transaction(ctx.db, () => {
      const logId = this.insertLog({ actor: 'agent', change: { ops, kind, lines }, status: 'pending' });
      const group = newGroup();
      const ok = createButton(ctx, 'rule_ok', { group, log_id: logId });
      const no = createButton(ctx, 'rule_no', { group, log_id: logId });
      const until = ctx.clock.now() + BUTTON_TTL_MS;
      const tz = ctx.config.timezone;
      const card = ruleCardText(lines, `${localDayMonth(until, tz)} ${localTime(until, tz)}`);
      const outboxId = enqueueServiceLine(ctx, card, {
        replyMarkup: inline([[{ text: RULE_BUTTON_LABELS.approve, token: ok }, { text: RULE_BUTTON_LABELS.reject, token: no }]]),
      });
      sql(ctx.db, 'UPDATE rules_log SET button_token = ?, outbox_id = ? WHERE id = ?').run(ok, outboxId, logId);
      return logId;
    });
    ctx.journal.write('rule_pending', { id, kind, lines });
    return { ok: true, result: 'pending_owner', effects: {} };
  }

  /** Отказ «владельца не поменять»: строка владельцу, только запись (строк за час уже много) или повтор того же за час. */
  private forbiddenTell(ops: RuleOp[]): 'line' | 'log' | 'repeat' {
    const now = this.ctx.clock.now();
    for (const [k, at] of this.forbiddenSeen) if (now - at >= FORBIDDEN_WINDOW_MS) this.forbiddenSeen.delete(k);
    this.forbiddenTold = this.forbiddenTold.filter((t) => now - t < FORBIDDEN_WINDOW_MS);
    const key = crypto.createHash('sha256').update(JSON.stringify(ops)).digest('hex');
    if (this.forbiddenSeen.has(key)) return 'repeat';
    this.forbiddenSeen.set(key, now);
    if (this.forbiddenTold.length >= FORBIDDEN_LINES_PER_WINDOW) return 'log';
    this.forbiddenTold.push(now);
    return 'line';
  }

  // ——— кнопки владельца (внутри главной транзакции приёма) ———

  private log(id: number): LogRow | null {
    return (sql(this.ctx.db, 'SELECT id, status, change_json, outbox_id FROM rules_log WHERE id = ?').get(id) as LogRow | undefined) ?? null;
  }

  /** [разрешить] или [нет] под карточкой — нажатие уже проверено (владелец в личке, токен годен). */
  press(kind: 'rule_ok' | 'rule_no', p: ButtonPayload, now: number): Effects {
    const { ctx } = this;
    useGroup(ctx, p.group, now);
    const log = this.log(Number(p.log_id));
    if (!log) return { answer: BUTTON_REFUSALS.expired };
    if (log.status !== 'pending') return { answer: log.status === 'expired' ? BUTTON_REFUSALS.expired : BUTTON_REFUSALS.used };
    if (kind === 'rule_no') {
      this.decide(log.id, 'rejected', 'кнопка владельца [нет]');
      enqueueServiceLine(ctx, RULE_REJECTED_TEXT);
      ctx.journal.write('rule_rejected', { id: log.id, by: 'owner_button' });
      return { answer: null };
    }
    let change: LoggedChange;
    try {
      change = JSON.parse(log.change_json) as LoggedChange;
    } catch {
      return this.notApplied(log.id, 'запись изменения испорчена');
    }
    const st = this.readState();
    if (!st) return this.notApplied(log.id, 'рабочей копии правил нет');
    const guard = this.fileGuard(st);
    if (!guard.ok) return this.notApplied(log.id, guard.text);
    const res = applyChange(st.rules, change.ops, { ownerAddress: this.ownerAddress() });
    if (!res.ok) return this.notApplied(log.id, `правила с тех пор поменялись — ${res.text}`);
    const next = this.effective(res.rules);
    if (rulesFingerprint(next) === rulesFingerprint(st.rules)) return this.notApplied(log.id, 'правила уже такие');
    const lines = describeChange(st.rules, change.ops);
    this.decide(log.id, 'applied', 'кнопка владельца [разрешить]');
    enqueueServiceLine(ctx, rulesChangedText('owner_button', lines));
    const closed = this.closeRoleEpisodes(next);
    this.writeState(makeRulesState(next, guard.fp, true));
    ctx.journal.write('rule_applied', { id: log.id, by: 'owner_button', lines });
    return { answer: null, rules: true, ...(closed ? { pump: true } : {}) };
  }

  private notApplied(id: number, reason: string): Effects {
    this.decide(id, 'rejected', `не применено: ${reason}`);
    enqueueServiceLine(this.ctx, ruleNotAppliedText(reason));
    this.ctx.journal.write('rule_not_applied', { id, reason });
    return { answer: null };
  }

  /**
   * Срок кнопки вышел, а нажатия не было: rules_log expired, кнопки под карточкой снимаются. Внутри транзакции.
   * Возвращает № записей.
   */
  expireDue(now: number): number[] {
    const rows = sql(this.ctx.db,
      `SELECT r.id AS id, r.outbox_id AS outbox_id FROM rules_log r JOIN buttons b ON b.token = r.button_token
       WHERE r.status = 'pending' AND b.expires_at <= ?`,
    ).all(now) as Array<{ id: number; outbox_id: number | null }>;
    const owner = this.ctx.config.owner_id;
    for (const r of rows) {
      this.decide(r.id, 'expired', 'срок кнопки истёк');
      if (r.outbox_id !== null && owner !== null) enqueueEdit(this.ctx, { chatId: owner, outboxId: r.outbox_id, text: null, replyMarkup: null });
    }
    if (rows.length) this.ctx.journal.write('rule_expired', { ids: rows.map((r) => r.id) });
    return rows.map((r) => r.id);
  }

  /** Тикер раз в минуту: истёкшие карточки, отставший rules.yaml. */
  tick(now: number): boolean {
    const due = (sql(this.ctx.db,
      `SELECT count(*) AS n FROM rules_log r JOIN buttons b ON b.token = r.button_token WHERE r.status = 'pending' AND b.expires_at <= ?`,
    ).get(now) as { n: number }).n;
    const expired = due ? transaction(this.ctx.db, () => this.expireDue(now)) : [];
    this.syncFile();
    return expired.length > 0;
  }

  /**
   * Смена роли чата закрывает его открытые эпизоды (role_change, 5.7): эпизод — тема × внешняя роль. Внутри
   * транзакции. Возвращает число событий episode_closed.
   */
  private closeRoleEpisodes(after: Rules): number {
    const open = sql(this.ctx.db, 'SELECT * FROM episodes WHERE closed_at IS NULL').all() as unknown as EpisodeRow[];
    let n = 0;
    for (const ep of open) {
      const rule = chatRuleFor(after, ep.chat_id);
      if (!rule || rule.role === ep.role) continue;
      const seq = this.episodes.close(ep, 'role_change');
      this.ctx.journal.write('episode_role_change', { episode: ep.id, from: ep.role, to: rule.role, seq });
      if (seq !== null) n++;
    }
    return n;
  }
}

