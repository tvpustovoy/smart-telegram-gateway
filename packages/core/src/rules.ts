// Правила доступа (TECH-SPEC 5.9; Ш-17, Ш-18, Ш-21, Ш-22; AD-6, AD-9) — чистые функции, общие для шлюза и CLI:
// - изменение — список операций {op: add | remove | set, target: subject | chat, id, field?, value?}; поля субъекта —
//   who, transports; поля чата — space, role;
// - сужение — только remove субъекта или чата: применяется сразу; всё остальное, в том числе любая смена role и space,
//   — расширение: применяется только после кнопки владельца (в 0.1 у ролей нет полей доступа);
// - владельца правилом не убрать и не поменять: он задан в config.yaml (Ш-21) — ни remove и set его субъекта, ни чужой
//   субъект с его номером или с who: owner, ни remove лички, где идут его команды; такая просьба — отказ («forbidden»),
//   её видно владельцу строкой и в rules_log;
// - карточка изменения собирается из полей (номер, чат, роль, было → стало), без слов агента (Ш-22): значения агента —
//   в одну строку, не длиннее 64 знаков, без управляющих знаков и знаков направления письма;
// - разница двух копий правил — для ручной правки rules.yaml (её тоже пишет rules_log).
// Рабочая копия прав и отпечаток rules.yaml (meta.rules_state) — тоже здесь: их читает и CLI (stg rules show, doctor).

import crypto from 'node:crypto';
import fs from 'node:fs';
import { ConfigError, RulesSchema, TransportSchema, parseRules, parseRulesText, rulesForFile, type ChatRule, type Rules, type SubjectRule } from './config.js';
import type { RuleOp } from './protocol.js';
import { cutGraphemes } from './split.js';

/** Значение who владельца: оно одно, его ставит config.yaml. */
export const OWNER_WHO = 'owner';
/** Предел строковых значений агента (who, space, role) — карточка не превращается в его текст. */
export const RULE_TEXT_MAX = 64;
/** Записей о транспорте у субъекта в одной операции. */
export const RULE_TRANSPORTS_MAX = 5;

const SUBJECT_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Управляющие знаки и знаки направления письма (ими можно переставить текст карточки). */
const UNSAFE_TEXT_RE = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
/** То же — для замены всех вхождений. */
const UNSAFE_TEXT_G = new RegExp(UNSAFE_TEXT_RE.source, 'gu');
/** В строке владельцу вместо значения агента, которое не прошло проверку: его текст в строку шлюза не попадает. */
export const RULE_BAD_VALUE = '(неверное значение)';

export type ChangeKind = 'narrowing' | 'expansion';

/** 5.9: сужение — только remove субъекта или чата (все операции изменения); остальное — расширение. */
export function classifyChange(ops: readonly Pick<RuleOp, 'op'>[]): ChangeKind {
  return ops.length > 0 && ops.every((o) => o.op === 'remove') ? 'narrowing' : 'expansion';
}

export type ApplyFailure = { ok: false; kind: 'forbidden' | 'invalid'; text: string; index: number };
export type ApplyResult = { ok: true; rules: Rules } | ApplyFailure;

type OpFailure = { kind: 'forbidden' | 'invalid'; text: string };

/** Отказ «владельца правилом не убрать и не поменять» (Ш-21) — его текст видят и владелец, и агент. */
export const OWNER_FORBIDDEN = 'владельца правилом не убрать и не поменять: он задан в config.yaml';

const invalid = (text: string): OpFailure => ({ kind: 'invalid', text });
const forbidden = (text: string): OpFailure => ({ kind: 'forbidden', text });

export function cloneRules(r: Rules): Rules {
  return {
    subjects: r.subjects.map((s) => ({ ...s, transports: s.transports.map((t) => ({ ...t })) })),
    chats: r.chats.map((c) => ({ ...c })),
  };
}

/** id чата в операции: «private» — личка; число строкой — номер чата. */
export function chatKey(id: string): 'private' | number | null {
  if (id === 'private') return 'private';
  if (!/^-?\d{1,19}$/.test(id)) return null;
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : null;
}

/** Правило чата для сообщения в чате chatId (как справочник шлюза: личка — правилом private, иначе — по номеру). */
export function chatRuleFor(rules: Rules, chatId: number): ChatRule | null {
  if (chatId > 0) return rules.chats.find((c) => c.chat === 'private') ?? rules.chats.find((c) => c.chat === chatId) ?? null;
  return rules.chats.find((c) => c.chat === chatId) ?? null;
}

type Checked<T> = { ok: true; value: T } | { ok: false; text: string };

function textValue(v: unknown, what: string): Checked<string> {
  if (typeof v !== 'string') return { ok: false, text: `${what} — строка` };
  if (UNSAFE_TEXT_RE.test(v)) return { ok: false, text: `${what} — в одну строку, без управляющих знаков` };
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s) return { ok: false, text: `${what} — пустое` };
  if (s.length > RULE_TEXT_MAX) return { ok: false, text: `${what} — не длиннее ${RULE_TEXT_MAX} знаков` };
  return { ok: true, value: s };
}

type Transport = SubjectRule['transports'][number];

function transportsValue(v: unknown): Checked<Transport[]> {
  const shape = 'transports — список [{network: "telegram", address: "<числовой номер>"}]';
  if (!Array.isArray(v)) return { ok: false, text: shape };
  if (v.length > RULE_TRANSPORTS_MAX) return { ok: false, text: `transports — не больше ${RULE_TRANSPORTS_MAX}` };
  const out: Transport[] = [];
  for (const t of v) {
    const r = TransportSchema.safeParse(t);
    if (!r.success || r.data.address.length > 20) return { ok: false, text: shape };
    if (out.some((x) => x.network === r.data.network && x.address === r.data.address)) return { ok: false, text: `запись ${r.data.network} ${r.data.address} — дважды` };
    out.push(r.data);
  }
  return { ok: true, value: out };
}

function isOwnerSubject(s: SubjectRule): boolean {
  return s.who === OWNER_WHO;
}

/** Записи о транспорте нового или изменённого субъекта: номер владельца — только у него; номер — у одного субъекта. */
function transportConflict(rules: Rules, transports: readonly Transport[], subjectId: string, ownerAddress: string | null): OpFailure | null {
  for (const t of transports) {
    if (t.network === 'telegram' && ownerAddress !== null && t.address === ownerAddress) return forbidden('номер владельца — только у владельца (config.yaml)');
    const other = rules.subjects.find((s) => s.id !== subjectId && s.transports.some((x) => x.network === t.network && x.address === t.address));
    if (other) {
      if (isOwnerSubject(other)) return forbidden('номер владельца — только у владельца (config.yaml)');
      return invalid(`запись ${t.network} ${t.address} уже у субъекта «${other.id}»`);
    }
  }
  return null;
}

function objectValue(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function applySubject(rules: Rules, o: RuleOp, ownerAddress: string | null): OpFailure | null {
  const idx = rules.subjects.findIndex((s) => s.id === o.id);
  const cur = idx >= 0 ? rules.subjects[idx]! : null;
  switch (o.op) {
    case 'remove':
      if (!cur) return invalid(`субъекта «${o.id}» нет`);
      if (isOwnerSubject(cur)) return forbidden(OWNER_FORBIDDEN);
      rules.subjects.splice(idx, 1);
      return null;
    case 'add': {
      if (cur) return isOwnerSubject(cur) ? forbidden(OWNER_FORBIDDEN) : invalid(`субъект «${o.id}» уже есть`);
      if (!SUBJECT_ID_RE.test(o.id)) return invalid('id субъекта — латиница, цифры, «_», «.», «-», до 64 знаков');
      const v = objectValue(o.value);
      if (!v) return invalid('add: value — объект с полями who, transports');
      const who = textValue(v.who, 'who');
      if (!who.ok) return invalid(who.text);
      if (who.value === OWNER_WHO) return forbidden('владелец один — он задан в config.yaml');
      const tr: Checked<Transport[]> = v.transports === undefined ? { ok: true, value: [] } : transportsValue(v.transports);
      if (!tr.ok) return invalid(tr.text);
      const conflict = transportConflict(rules, tr.value, o.id, ownerAddress);
      if (conflict) return conflict;
      rules.subjects.push({ id: o.id, who: who.value, transports: tr.value });
      return null;
    }
    case 'set': {
      if (!cur) return invalid(`субъекта «${o.id}» нет`);
      if (isOwnerSubject(cur)) return forbidden(OWNER_FORBIDDEN);
      if (o.field === 'who') {
        const who = textValue(o.value, 'who');
        if (!who.ok) return invalid(who.text);
        if (who.value === OWNER_WHO) return forbidden('владелец один — он задан в config.yaml');
        cur.who = who.value;
        return null;
      }
      if (o.field === 'transports') {
        const tr = transportsValue(o.value);
        if (!tr.ok) return invalid(tr.text);
        const conflict = transportConflict(rules, tr.value, cur.id, ownerAddress);
        if (conflict) return conflict;
        cur.transports = tr.value;
        return null;
      }
      return invalid('set: field субъекта — who или transports');
    }
  }
}

function applyChat(rules: Rules, o: RuleOp): OpFailure | null {
  const key = chatKey(o.id);
  if (key === null) return invalid('id чата — «private» (личка) или номер чата');
  const idx = rules.chats.findIndex((c) => c.chat === key);
  const cur = idx >= 0 ? rules.chats[idx]! : null;
  const label = chatLabel(key);
  switch (o.op) {
    case 'remove':
      if (!cur) return invalid(`чата ${label} нет в правилах`);
      // Без лички владельца не слышно: его команды («стоп») идут только в ней (Ш-21, 5.6).
      if (key === 'private') return forbidden('личку правилом не убрать: в ней команды владельца');
      rules.chats.splice(idx, 1);
      return null;
    case 'add': {
      if (cur) return invalid(`чат ${label} уже есть`);
      const v = objectValue(o.value);
      if (!v) return invalid('add: value — объект с полями space, role');
      const space = textValue(v.space, 'space');
      if (!space.ok) return invalid(space.text);
      const role = textValue(v.role, 'role');
      if (!role.ok) return invalid(role.text);
      rules.chats.push({ chat: key, space: space.value, role: role.value });
      return null;
    }
    case 'set': {
      if (!cur) return invalid(`чата ${label} нет в правилах`);
      if (o.field !== 'space' && o.field !== 'role') return invalid('set: field чата — space или role');
      const v = textValue(o.value, o.field);
      if (!v.ok) return invalid(v.text);
      cur[o.field] = v.value;
      return null;
    }
  }
}

/**
 * Применить изменение к копии правил — по операциям, по порядку; первая непроходящая — отказ с её номером. Исходные
 * правила не меняются. ownerAddress — номер владельца из config.yaml (null — первая настройка).
 */
export function applyChange(base: Rules, ops: readonly RuleOp[], opts: { ownerAddress: string | null }): ApplyResult {
  const rules = cloneRules(base);
  for (const [index, o] of ops.entries()) {
    const fail = o.target === 'subject' ? applySubject(rules, o, opts.ownerAddress) : applyChat(rules, o);
    if (fail) return { ok: false, ...fail, index };
  }
  const v = RulesSchema.safeParse(rules);
  if (!v.success) {
    const iss = v.error.issues[0];
    return { ok: false, kind: 'invalid', text: iss ? iss.message : 'правила не сходятся', index: ops.length - 1 };
  }
  return { ok: true, rules: v.data };
}

function sameTransports(a: readonly Transport[], b: readonly Transport[]): boolean {
  return JSON.stringify(a.map((t) => [t.network, t.address])) === JSON.stringify(b.map((t) => [t.network, t.address]));
}

/**
 * Разница двух копий правил операциями (ручная правка rules.yaml → rules_log и строка владельцу). Ссылку на модель
 * мира (world_ref) операция агента менять не может, а правка файла может — она записывается как set поля world_ref.
 */
export function diffRules(before: Rules, after: Rules): RuleOp[] {
  const ops: RuleOp[] = [];
  const bS = new Map(before.subjects.map((s) => [s.id, s]));
  const aS = new Map(after.subjects.map((s) => [s.id, s]));
  for (const s of before.subjects) if (!aS.has(s.id)) ops.push({ op: 'remove', target: 'subject', id: s.id });
  for (const s of after.subjects) {
    const b = bS.get(s.id);
    if (!b) {
      ops.push({ op: 'add', target: 'subject', id: s.id, value: { who: s.who, transports: s.transports, ...(s.world_ref ? { world_ref: s.world_ref } : {}) } });
      continue;
    }
    if (b.who !== s.who) ops.push({ op: 'set', target: 'subject', id: s.id, field: 'who', value: s.who });
    if (!sameTransports(b.transports, s.transports)) ops.push({ op: 'set', target: 'subject', id: s.id, field: 'transports', value: s.transports });
    if ((b.world_ref ?? null) !== (s.world_ref ?? null)) ops.push({ op: 'set', target: 'subject', id: s.id, field: 'world_ref', value: s.world_ref ?? null });
  }
  const bC = new Map(before.chats.map((c) => [String(c.chat), c]));
  const aC = new Map(after.chats.map((c) => [String(c.chat), c]));
  for (const c of before.chats) if (!aC.has(String(c.chat))) ops.push({ op: 'remove', target: 'chat', id: String(c.chat) });
  for (const c of after.chats) {
    const b = bC.get(String(c.chat));
    if (!b) {
      ops.push({ op: 'add', target: 'chat', id: String(c.chat), value: { space: c.space, role: c.role, ...(c.parcels === true ? { parcels: true } : {}) } });
      continue;
    }
    if (b.space !== c.space) ops.push({ op: 'set', target: 'chat', id: String(c.chat), field: 'space', value: c.space });
    if (b.role !== c.role) ops.push({ op: 'set', target: 'chat', id: String(c.chat), field: 'role', value: c.role });
    // Посылки (0.3.3): поле правит только владелец в rules.yaml — правка файла пишется как set поля parcels.
    if ((b.parcels === true) !== (c.parcels === true)) ops.push({ op: 'set', target: 'chat', id: String(c.chat), field: 'parcels', value: c.parcels === true });
  }
  return ops;
}

// ——— Карточка и строки из полей (Ш-22) ———

/**
 * Поле parcels чата в строке владельцу (0.3.3) ⟨предл.: текст⟩. У правила «личка» (private) поле открывает файлы в лички
 * всех участников из правил, а не только владельцу (его личка открыта всегда) — так и сказано (находка проверки 0.3.3:
 * «чат «личка» · файлы от агента» читалось как «моя личка»).
 */
export function parcelsLabel(key: 'private' | number | string): string {
  return key === 'private' ? 'файлы от агента в лички всех участников' : 'файлы от агента';
}

/** «личка» или номер чата. */
export function chatLabel(key: 'private' | number | string): string {
  return key === 'private' ? '«личка»' : String(key);
}

function q(v: unknown): string {
  if (v === null || v === undefined) return 'нет';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const flat = s.replace(UNSAFE_TEXT_G, ' ').replace(/\s+/g, ' ').trim();
  const c = cutGraphemes(flat, RULE_TEXT_MAX);
  return `«${c.text}${c.cut ? '…' : ''}»`;
}

/** Номера уже проверенных записей (из рабочей копии или прошедших transportsValue). */
function transportsLabel(v: readonly Transport[] | undefined): string {
  if (!v || !v.length) return 'номеров нет';
  return v.map((t) => `${t.network} ${cutGraphemes(t.address.replace(UNSAFE_TEXT_G, ''), 20).text}`).join(', ');
}

/**
 * Откуда значения операции: agent — инструмент rule (в строку владельцу — только значения, прошедшие проверку, иначе
 * «(неверное значение)»: отказ «владельца не поменять» решается раньше проверки значений, а текст агента не должен
 * попасть в строку шлюза — Ш-22, Ш-23); file — правка rules.yaml владельцем (его файл уже разобран схемой).
 */
export type ChangeSource = 'agent' | 'file';

function shownText(v: unknown, src: ChangeSource): string {
  if (v === null || v === undefined) return 'нет';
  if (src === 'file') return q(v);
  const c = textValue(v, 'значение');
  return c.ok ? q(c.value) : RULE_BAD_VALUE;
}

function shownTransports(v: unknown, src: ChangeSource): string {
  if (v === undefined) return 'номеров нет';
  const c = transportsValue(v);
  if (c.ok) return transportsLabel(c.value);
  return src === 'file' && Array.isArray(v) ? transportsLabel(v as Transport[]) : RULE_BAD_VALUE;
}

function shownSubjectId(id: string, src: ChangeSource): string {
  return src === 'file' || SUBJECT_ID_RE.test(id) ? q(id) : RULE_BAD_VALUE;
}

function subjectTail(s: SubjectRule): string {
  return ` · кто: ${q(s.who)} · ${transportsLabel(s.transports)}`;
}

function describeOp(state: Rules, o: RuleOp, src: ChangeSource): string {
  if (o.target === 'subject') {
    const cur = state.subjects.find((s) => s.id === o.id) ?? null;
    const name = shownSubjectId(o.id, src);
    if (o.op === 'remove') return `− субъект ${name}${cur ? subjectTail(cur) : ''}`;
    if (o.op === 'add') {
      const v = objectValue(o.value) ?? {};
      return `+ субъект ${name} · кто: ${shownText(v.who, src)} · ${shownTransports(v.transports, src)}`;
    }
    if (o.field === 'who') return `субъект ${name} · кто: ${q(cur?.who)} → ${shownText(o.value, src)}`;
    if (o.field === 'transports') return `субъект ${name} · номера: ${transportsLabel(cur?.transports)} → ${shownTransports(o.value, src)}`;
    if (o.field === 'world_ref') return `субъект ${name} · ссылка в модели мира: ${q(cur?.world_ref)} → ${src === 'file' ? q(o.value) : RULE_BAD_VALUE}`;
    return `субъект ${name} · ${RULE_BAD_VALUE}`;
  }
  const key = chatKey(o.id);
  const label = key !== null ? chatLabel(key) : RULE_BAD_VALUE;
  const cur = key !== null ? (state.chats.find((c) => c.chat === key) ?? null) : null;
  if (o.op === 'remove') return `− чат ${label}${cur ? ` · пространство ${q(cur.space)} · роль ${q(cur.role)}` : ''}`;
  if (o.op === 'add') {
    const v = objectValue(o.value) ?? {};
    // parcels — только из файла владельца: операция агента его не ставит (applyChat берёт space и role).
    return `+ чат ${label} · пространство ${shownText(v.space, src)} · роль ${shownText(v.role, src)}${src === 'file' && v.parcels === true && key !== null ? ` · ${parcelsLabel(key)}: да` : ''}`;
  }
  if (o.field === 'role') return `чат ${label} · роль: ${q(cur?.role)} → ${shownText(o.value, src)}`;
  if (o.field === 'space') return `чат ${label} · пространство: ${q(cur?.space)} → ${shownText(o.value, src)}`;
  if (o.field === 'parcels' && src === 'file' && key !== null) return `чат ${label} · ${parcelsLabel(key)}: ${cur?.parcels === true ? 'да' : 'нет'} → ${o.value === true ? 'да' : 'нет'}`;
  return `чат ${label} · ${RULE_BAD_VALUE}`;
}

/** То же действие над копией без проверок — чтобы строка следующей операции видела «было» после предыдущей. */
function simulate(state: Rules, o: RuleOp): void {
  if (o.target === 'subject') {
    const idx = state.subjects.findIndex((s) => s.id === o.id);
    const v = objectValue(o.value);
    // Только проверенные значения: «было» следующей операции тоже идёт в строку владельцу.
    const who = (x: unknown): string => {
      const c = textValue(x, 'who');
      return c.ok ? c.value : RULE_BAD_VALUE;
    };
    const tr = (x: unknown): Transport[] => {
      const c = transportsValue(x);
      return c.ok ? c.value : [];
    };
    if (o.op === 'remove' && idx >= 0) state.subjects.splice(idx, 1);
    else if (o.op === 'add' && idx < 0 && v) {
      state.subjects.push({ id: o.id, who: who(v.who), transports: v.transports === undefined ? [] : tr(v.transports) });
    } else if (o.op === 'set' && idx >= 0) {
      const s = state.subjects[idx]!;
      if (o.field === 'who') s.who = who(o.value);
      if (o.field === 'transports') s.transports = tr(o.value);
      if (o.field === 'world_ref') s.world_ref = typeof o.value === 'string' ? o.value : null;
    }
    return;
  }
  const key = chatKey(o.id);
  if (key === null) return;
  const idx = state.chats.findIndex((c) => c.chat === key);
  const v = objectValue(o.value);
  const text = (x: unknown): string => {
    const c = textValue(x, 'значение');
    return c.ok ? c.value : RULE_BAD_VALUE;
  };
  if (o.op === 'remove' && idx >= 0) state.chats.splice(idx, 1);
  else if (o.op === 'add' && idx < 0 && v) state.chats.push({ chat: key, space: text(v.space), role: text(v.role) });
  else if (o.op === 'set' && idx >= 0 && (o.field === 'space' || o.field === 'role')) state.chats[idx]![o.field] = text(o.value);
  else if (o.op === 'set' && idx >= 0 && o.field === 'parcels') state.chats[idx]!.parcels = o.value === true;
}

/**
 * Строки изменения из полей — по одной на операцию, «было» — на момент операции (Ш-22: без слов агента). Значения
 * агента — только прошедшие проверку (src agent, по умолчанию).
 */
export function describeChange(before: Rules, ops: readonly RuleOp[], src: ChangeSource = 'agent'): string[] {
  const state = cloneRules(before);
  const lines: string[] = [];
  for (const o of ops) {
    lines.push(describeOp(state, o, src));
    simulate(state, o);
  }
  return lines;
}

// ——— Рабочая копия и отпечаток rules.yaml ———

/** Правила в одном виде: порядок полей постоянный, пустой world_ref — null. */
export function canonicalRules(r: Rules): string {
  return JSON.stringify({
    subjects: r.subjects.map((s) => ({
      id: s.id,
      who: s.who,
      transports: s.transports.map((t) => ({ network: t.network, address: t.address })),
      world_ref: s.world_ref ?? null,
    })),
    // parcels — только когда есть (0.3.3): отпечаток правил без него тот же, что у прежних версий.
    chats: r.chats.map((c) => ({ chat: c.chat, space: c.space, role: c.role, ...(c.parcels === true ? { parcels: true } : {}) })),
  });
}

export function rulesHash(r: Rules): string {
  return crypto.createHash('sha256').update(canonicalRules(r)).digest('hex').slice(0, 32);
}

/** Отпечаток файла с этими правилами (по смыслу, а не по тексту: комментарии и порядок ключей не в счёт). */
export function rulesFingerprint(r: Rules): string {
  return `rules:${rulesHash(r)}`;
}

export type RulesFile =
  | { kind: 'missing'; fp: 'missing' }
  | { kind: 'broken'; fp: string; problems: string[] }
  | { kind: 'ok'; fp: string; rules: Rules };

/** Прочитать rules.yaml: правила и отпечаток; испорченный — отпечаток по тексту (одна строка владельцу на одну поломку). */
export function readRulesFile(file: string): RulesFile {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing', fp: 'missing' };
    return { kind: 'broken', fp: `broken:unreadable:${code ?? '?'}`, problems: [`не читается: ${code ?? String(err)}`] };
  }
  try {
    const rules = parseRulesText(text);
    return { kind: 'ok', fp: rulesFingerprint(rules), rules };
  } catch (err) {
    const problems = err instanceof ConfigError ? err.problems : [String((err as Error).message)];
    return { kind: 'broken', fp: `broken:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)}`, problems };
  }
}

/** Рабочая копия прав в базе (meta.rules_state, AD-9). */
export interface RulesState {
  v: 1;
  /** Действующие правила целиком (владелец из config.yaml уже в них). */
  rules: Rules;
  /** rulesHash(rules). */
  hash: string;
  /** Отпечаток rules.yaml, каким шлюз его знает: записал сам или прочитал при старте. */
  file: string;
  /** Рабочая копия новее файла: rules.yaml нужно переписать (запись не дошла — диск полон, падение). */
  pending: boolean;
}

export function makeRulesState(rules: Rules, file: string, pending: boolean): RulesState {
  return { v: 1, rules, hash: rulesHash(rules), file, pending };
}

export function encodeRulesState(st: RulesState): string {
  return JSON.stringify({ v: 1, rules: rulesForFile(st.rules), hash: st.hash, file: st.file, pending: st.pending });
}

/** Разобрать meta.rules_state; испорченное — null (шлюз возьмёт правила из файла, как при первом старте). */
export function parseRulesState(raw: string | null): RulesState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { v?: unknown; rules?: unknown; file?: unknown; pending?: unknown };
    if (o.v !== 1 || typeof o.file !== 'string') return null;
    const rules = parseRules(o.rules, 'rules_state');
    return { v: 1, rules, hash: rulesHash(rules), file: o.file, pending: o.pending === true };
  } catch {
    return null;
  }
}

/** Как rules.yaml соотносится с рабочей копией — для stg rules show и doctor. */
export type RulesFileStatus = 'same' | 'pending_write' | 'edited' | 'broken' | 'missing';

export function rulesFileStatus(st: RulesState, file: RulesFile): RulesFileStatus {
  if (file.fp === rulesFingerprint(st.rules)) return 'same';
  if (file.kind === 'broken') return 'broken';
  if (st.pending && file.fp === st.file) return 'pending_write';
  if (file.kind === 'missing') return 'missing';
  return 'edited';
}

