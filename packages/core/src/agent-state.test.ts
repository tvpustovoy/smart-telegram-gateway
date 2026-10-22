// Состояние агента (TECH-SPEC 5.14; P-1, D-6): разбор строки состояния и перехватчиков Claude Code, слияние, очистка
// текста ошибки, что показывать в закреплённой строке и в «статус», запись файла под замком.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  AGENT_STATE_FILE,
  AGENT_STATE_LOCK,
  COMPACT_STALE_MS,
  CONTEXT_MAX_AGE_MS,
  FAILURE_MAX_AGE_MS,
  agentIndicatorParts,
  agentStatusLines,
  agentUrgentSignature,
  agentView,
  applyHook,
  applyStatusline,
  emptyAgentState,
  failureSignature,
  parseAgentState,
  parseResetsAt,
  readAgentStateFile,
  sanitizeErrorText,
  statuslineShortLine,
  updateAgentStateFile,
  weekdayShort,
  type AgentStateFile,
  type AgentViewInput,
} from './agent-state.js';
import { agentFailureNotice, helpText, statusLineText } from './strings.js';
import { localTime } from './time.js';

const TZ = 'America/Los_Angeles';
/** 2026-10-18 09:00 по Лос-Анджелесу (воскресенье). */
const NOW = Date.parse('2026-10-18T16:00:00.000Z');
const H = 3600_000;

function input(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 's1',
    cwd: '/agents/assistant',
    workspace: { current_dir: '/agents/assistant', project_dir: '/agents/assistant' },
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    context_window: { used_percentage: 16.4 },
    cost: { total_cost_usd: 0.5 },
    rate_limits: {
      five_hour: { used_percentage: 31.2, resets_at: Math.round((NOW + 3 * H) / 1000) },
      seven_day: { used_percentage: 64, resets_at: Math.round((NOW + 4 * 24 * H) / 1000) },
    },
    ...over,
  };
}

const live: AgentViewInput = { now: NOW, online: true, leaseCwd: '/agents/assistant', lastAgentActivityAt: 0 };

/** Текст отказа доступа, как его шлёт Claude Code 2.1.306 в last_assistant_message (h6o в его коде). */
const ORG_DISABLED = 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';

/** StopFailure в настоящем виде (Claude Code 2.1.306): error — тип, last_assistant_message — текст, error_details — не всегда. */
function stopFailure(error: string, lastMessage?: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: 's1', transcript_path: '/t.jsonl', cwd: '/agents/assistant', hook_event_name: 'StopFailure', error, ...(lastMessage !== undefined ? { last_assistant_message: lastMessage } : {}), ...over };
}

const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stg-as-'));
  dirs.push(d);
  return d;
}

describe('состояние агента: разбор и слияние (5.14)', () => {
  it('время сброса: секунды эпохи, миллисекунды, строка с числом, ISO; мусор — null', () => {
    assert.equal(parseResetsAt(1738425600), 1738425600_000);
    assert.equal(parseResetsAt(1738425600_000), 1738425600_000);
    assert.equal(parseResetsAt('1738425600'), 1738425600_000);
    assert.equal(parseResetsAt('2026-10-18T19:00:00Z'), Date.parse('2026-10-18T19:00:00Z'));
    for (const bad of [null, undefined, 'когда-нибудь', {}, -5, 0]) assert.equal(parseResetsAt(bad), null);
  });

  it('строка состояния → сессия, каталог, модель, контекст, сумма, лимиты с resets_at', () => {
    const s = applyStatusline(emptyAgentState(), input(), NOW);
    assert.deepEqual(s.statusline, { at: NOW, session_id: 's1', cwd: '/agents/assistant', project_dir: '/agents/assistant', model: 'Opus', context_pct: 16.4, cost_usd: 0.5 });
    assert.deepEqual(s.limits.five_hour, { pct: 31.2, resets_at: NOW + 3 * H, at: NOW });
    assert.equal(s.limits.seven_day?.pct, 64);
  });

  it('любое поле может отсутствовать: пустой объект — запись без чисел; окна нет — прежнее остаётся; не объект — исключение', () => {
    const a = applyStatusline(emptyAgentState(), input(), NOW);
    const b = applyStatusline(a, { session_id: 's1', context_window: { used_percentage: null } }, NOW + 1000);
    assert.equal(b.statusline?.context_pct, null);
    assert.equal(b.statusline?.cost_usd, null);
    assert.deepEqual(b.limits, a.limits, 'окна, которых нет в перерисовке, — прежние');
    const c = applyStatusline(b, { rate_limits: { five_hour: { used_percentage: 40 } } }, NOW + 2000);
    assert.deepEqual(c.limits.five_hour, { pct: 40, resets_at: null, at: NOW + 2000 });
    assert.throws(() => applyStatusline(a, 'текст', NOW), /не объект/);
    assert.throws(() => applyStatusline(a, [1, 2], NOW), /не объект/);
  });

  it('перехватчики: PreCompact — сжатие идёт; PostCompact — кончилось; чужое событие — то же состояние', () => {
    const a = applyStatusline(emptyAgentState(), input(), NOW);
    const pre = applyHook(a, { hook_event_name: 'PreCompact', session_id: 's1', trigger: 'auto' }, NOW + 1000);
    assert.equal(pre.event, 'PreCompact');
    assert.deepEqual(pre.state.compact, { since: NOW + 1000, session_id: 's1', trigger: 'auto' });
    assert.equal(pre.state.statusline, a.statusline, 'строка состояния не тронута');
    const post = applyHook(pre.state, { hook_event_name: 'PostCompact', session_id: 's1', trigger: 'auto' }, NOW + 5000);
    assert.equal(post.state.compact, null);
    assert.deepEqual(post.state.compacted, { at: NOW + 5000, session_id: 's1', trigger: 'auto' });
    const other = applyHook(post.state, { hook_event_name: 'Stop', session_id: 's1' }, NOW + 6000);
    assert.equal(other.event, null);
    assert.equal(other.state, post.state);
    assert.throws(() => applyHook(a, null, NOW), /не объект/);
  });

  it('StopFailure в настоящем виде (Claude Code 2.1.306): тип — error, текст — last_assistant_message, а не код типа; сумма сессии к отказу', () => {
    const a = applyStatusline(emptyAgentState(), input(), NOW);
    const f = applyHook(a, stopFailure('oauth_org_not_allowed', ORG_DISABLED), NOW + 1000).state.failure!;
    assert.equal(f.type, 'oauth_org_not_allowed');
    assert.equal(f.text, ORG_DISABLED, 'что сказала модель, а не «oauth_org_not_allowed»');
    assert.equal(f.details, null);
    assert.deepEqual(f.marks, [{ session_id: 's1', cost_usd: 0.5 }]);
    assert.equal(f.cleared_at, null);
    // «API Error: » срезан; error_details (сырое сообщение API) — отдельно, без секретов и номера запроса.
    const raw = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"},"request_id":"req_011CUabcdefghijklmnopqrstuvwxyz0123"}';
    const r = applyHook(a, stopFailure('rate_limit', 'API Error: Request rejected (429) · this may be a temporary capacity issue.', { error_details: raw }), NOW + 2000).state.failure!;
    assert.equal(r.type, 'rate_limit');
    assert.equal(r.text, 'Request rejected (429) · this may be a temporary capacity issue.');
    assert.ok(r.details?.startsWith('429 {"type":"error","error":{"type":"rate_limit_error"') && !r.details.includes('abcdefghijklmnop'), r.details ?? '');
    // Нет last_assistant_message — error_details; нет ничего — тип, последним.
    assert.equal(applyHook(a, stopFailure('invalid_request', undefined, { error_details: 'prompt is too long: 210000 tokens > 200000 maximum' }), NOW).state.failure?.text, 'prompt is too long: 210000 tokens > 200000 maximum');
    assert.equal(applyHook(a, stopFailure('server_error'), NOW).state.failure?.text, 'server_error');
    // Секреты в тексте — «…».
    const k = applyHook(a, stopFailure('authentication_failed', 'API Error: 401 bad key sk-ant-api03-AAAAAAAAAAAAAAAAAAAA'), NOW).state.failure!;
    assert.equal(k.text, '401 bad key …');
  });

  it('«та же ошибка» — тип и текст без чисел: номер запроса — та же; два разных сообщения rate_limit — разные', () => {
    const e = emptyAgentState();
    const sig = (msg: string, type = 'rate_limit'): string => failureSignature(applyHook(e, stopFailure(type, msg), NOW).state.failure!);
    assert.equal(sig('API Error: Request rejected (429) · request 111'), sig('API Error: Request rejected (429) · request 98765'));
    assert.notEqual(sig('API Error: Request rejected (429) · this may be a temporary capacity issue.'), sig("You've hit your limit · resets 3pm (America/Los_Angeles)"));
    assert.notEqual(sig(ORG_DISABLED, 'oauth_org_not_allowed'), sig(ORG_DISABLED, 'authentication_failed'));
  });

  it('снятие отказа по сумме: та же сумма — нет, выросла — снят; новая сессия — отсчёт заново; после --resume сумма упала — отметка заново; две сессии вперемешку — у каждой своя', () => {
    const a = applyStatusline(emptyAgentState(), input({ cost: { total_cost_usd: 5 } }), NOW);
    const st: AgentStateFile = applyHook(a, stopFailure('oauth_org_not_allowed', ORG_DISABLED), NOW + 1000).state;
    // Та же сумма (перерисовка после ошибки) — не снят; больше — снят.
    assert.equal(applyStatusline(st, input({ cost: { total_cost_usd: 5 } }), NOW + 2000).failure?.cleared_at, null);
    assert.equal(applyStatusline(st, input({ cost: { total_cost_usd: 5.01 } }), NOW + 3000).failure?.cleared_at, NOW + 3000);
    // Новая сессия: первая перерисовка — отсчёт, следующая с большей суммой — снят.
    const n1 = applyStatusline(st, input({ session_id: 's2', cost: { total_cost_usd: 0.01 } }), NOW + 4000);
    assert.deepEqual(n1.failure?.marks, [{ session_id: 's1', cost_usd: 5 }, { session_id: 's2', cost_usd: 0.01 }]);
    assert.equal(n1.failure?.cleared_at, null);
    assert.equal(applyStatusline(n1, input({ session_id: 's2', cost: { total_cost_usd: 0.02 } }), NOW + 5000).failure?.cleared_at, NOW + 5000);
    // --resume: session_id тот же, сумма — на процесс, с нуля. Меньше отметки — отметка заново; выросла — снят.
    const r1 = applyStatusline(st, input({ cost: { total_cost_usd: 0 } }), NOW + 6000);
    assert.equal(r1.failure?.cleared_at, null);
    assert.deepEqual(r1.failure?.marks, [{ session_id: 's1', cost_usd: 0 }]);
    assert.equal(applyStatusline(r1, input({ cost: { total_cost_usd: 0.3 } }), NOW + 7000).failure?.cleared_at, NOW + 7000, 'модель ответила после --resume');
    // Строки двух сессий вперемешку: отметки не сбивают друг друга — снят, как только выросла сумма одной из них.
    let m = st;
    for (const [sid, cost, t] of [['s2', 1, 1], ['s1', 5, 2], ['s2', 1, 3], ['s1', 5, 4]] as const) {
      m = applyStatusline(m, input({ session_id: sid, cost: { total_cost_usd: cost } }), NOW + 10_000 + t);
      assert.equal(m.failure?.cleared_at, null, `${sid} ${cost}`);
    }
    assert.equal(applyStatusline(m, input({ session_id: 's1', cost: { total_cost_usd: 5.2 } }), NOW + 20_000).failure?.cleared_at, NOW + 20_000);
    // Файл прежнего вида (одна отметка `mark`) понимается.
    const old = parseAgentState(JSON.stringify({ failure: { at: NOW, text: 'x', mark: { session_id: 's1', cost_usd: 2 } } }));
    assert.deepEqual(old.failure?.marks, [{ session_id: 's1', cost_usd: 2 }]);
  });

  it('StopFailure других видов (по документации и с запасом): error_type и error_message, error.message, последним — тип; ничего — «без текста»', () => {
    const e = emptyAgentState();
    const legacy = applyHook(e, { hook_event_name: 'StopFailure', error_type: 'rate_limit', error_message: 'Rate limit exceeded' }, NOW).state.failure!;
    assert.equal(legacy.type, 'rate_limit');
    assert.equal(legacy.text, 'Rate limit exceeded');
    assert.equal(applyHook(e, { hook_event_name: 'StopFailure', error: { message: 'Overloaded' } }, NOW).state.failure?.text, 'Overloaded');
    assert.equal(applyHook(e, { hook_event_name: 'StopFailure', error: 'rate_limit' }, NOW).state.failure?.type, 'rate_limit');
    const none = applyHook(e, { hook_event_name: 'StopFailure', error_message: 42 }, NOW).state.failure!;
    assert.equal(none.text, 'без текста');
    assert.deepEqual(none.marks, [], 'строки состояния не было — сумма запомнится с первой перерисовки');
  });

  it('max_output_tokens — не отказ модели: без 🔴, в «статус» — «не отказ»; прежний отказ заменён', () => {
    const a = applyStatusline(emptyAgentState(), input(), NOW);
    const refused = applyHook(a, stopFailure('rate_limit', 'Rate limit exceeded'), NOW + 1000).state;
    assert.ok(agentView(refused, { ...live, now: NOW + 1500 }).failure);
    const long = applyHook(refused, stopFailure('max_output_tokens', "API Error: Claude's response exceeded the 32000 output token maximum."), NOW + 2000).state;
    const v = agentView(long, { ...live, now: NOW + 3000 });
    assert.equal(v.failure, null);
    assert.equal(agentUrgentSignature(v), '');
    assert.match(agentStatusLines(long, v, TZ, NOW + 3000)[1]!, /^Отказ модели: 09:00 \(max_output_tokens\) — «Claude's response exceeded the 32000 output token maximum\.»; не отказ — ответ длиннее предела, модель отвечает$/);
  });

  it('текст ошибки: одна строка, токен бота, ключи, Bearer, api_key=…, длинные строки — «…»; не длиннее 200; без ⚙ и 💬', () => {
    const raw =
      '💬 ⚙ Ошибка\n\tbot 7000000001:AAtest-TOKEN_never-written_xx Bearer eyJhbGciOi.abc api_key=s3cr3t sk-proj-ABCDEFGH12345 ' +
      'req_011CUabcdefghijklmnopqrstuvwxyz0123456789 ‮перевёрнуто';
    const t = sanitizeErrorText(raw);
    for (const secret of ['AAtest-TOKEN', 'eyJhbGciOi', 's3cr3t', 'ABCDEFGH12345', 'abcdefghijklmnop', '‮', '\n', '💬', '⚙']) assert.ok(!t.includes(secret), `${secret} в «${t}»`);
    assert.match(t, /^Ошибка bot … Bearer … api_key=… … … перевёрнуто$/);
    const long = sanitizeErrorText('слово '.repeat(100));
    assert.ok(long.length <= 201 && long.endsWith('…'), long);
  });

  it('файл: под замком, слиянием, атомарно, 0600; испорченный — заново; брошенный замок снимается', () => {
    const home = tmp();
    updateAgentStateFile(home, (p) => applyStatusline(p, input(), NOW), NOW);
    updateAgentStateFile(home, (p) => applyHook(p, { hook_event_name: 'PreCompact', session_id: 's1' }, NOW + 1).state, NOW + 1);
    const s = readAgentStateFile(home)!;
    assert.equal(s.statusline?.context_pct, 16.4);
    assert.equal(s.compact?.since, NOW + 1);
    assert.equal(fs.statSync(path.join(home, AGENT_STATE_FILE)).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(path.join(home, AGENT_STATE_LOCK)), 'замок снят');
    // Чужое событие — файл не переписывается.
    const before = fs.statSync(path.join(home, AGENT_STATE_FILE)).ino;
    updateAgentStateFile(home, (p) => applyHook(p, { hook_event_name: 'Notification' }, NOW + 2).state, NOW + 2);
    assert.equal(fs.statSync(path.join(home, AGENT_STATE_FILE)).ino, before);
    // Испорченный файл: читатель — исключение, писатель — заново.
    fs.writeFileSync(path.join(home, AGENT_STATE_FILE), '{не json');
    assert.throws(() => readAgentStateFile(home));
    updateAgentStateFile(home, (p) => applyStatusline(p, input(), NOW + 3), NOW + 3);
    assert.equal(readAgentStateFile(home)?.compact, null);
    // Брошенный замок (процесс убит посреди записи): старше 2 с — снимается.
    fs.writeFileSync(path.join(home, AGENT_STATE_LOCK), '');
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(path.join(home, AGENT_STATE_LOCK), old, old);
    updateAgentStateFile(home, (p) => applyStatusline(p, input({ context_window: { used_percentage: 20 } }), NOW + 4), NOW + 4);
    assert.equal(readAgentStateFile(home)?.statusline?.context_pct, 20);
    assert.equal(readAgentStateFile(tmp()), null, 'нет файла — null');
    // Разбор чужого вида: непонятные части — null, не исключение.
    const odd = parseAgentState(JSON.stringify({ statusline: { at: 'вчера' }, limits: { five_hour: { pct: 'много' } }, failure: { at: NOW } }));
    assert.equal(odd.statusline, null);
    assert.equal(odd.limits.five_hour, null);
    assert.equal(odd.failure?.text, 'без текста');
  });
});

describe('состояние агента: что показывать (J-4: `🟢 · 🧠 16% · 🕐 31% · 📅 64%`)', () => {
  const base = applyStatusline(emptyAgentState(), input(), NOW);

  it('обычное: 🧠 16% · 🕐 31% · 📅 64%; целые проценты', () => {
    const v = agentView(base, live);
    assert.equal(v.context, 16);
    assert.deepEqual(agentIndicatorParts(v, TZ, NOW), ['🧠 16%', '🕐 31% · 📅 64%']);
    assert.equal(agentUrgentSignature(v), '');
  });

  it('нет файла, нет данных — значков нет; агент не на связи — 🧠 нет, лимиты есть', () => {
    assert.deepEqual(agentIndicatorParts(agentView(null, live), TZ, NOW), []);
    assert.deepEqual(agentIndicatorParts(agentView(emptyAgentState(), live), TZ, NOW), []);
    const off = agentView(base, { ...live, online: false });
    assert.equal(off.contextHidden, 'offline');
    assert.deepEqual(agentIndicatorParts(off, TZ, NOW), ['🕐 31% · 📅 64%']);
  });

  it('другая сессия (каталог не тот, что у аренды) и старые (старше суток) — 🧠 нет', () => {
    const other = agentView(base, { ...live, leaseCwd: '/elsewhere' });
    assert.equal(other.contextHidden, 'other_session');
    assert.equal(other.context, null);
    assert.equal(agentView(base, { ...live, leaseCwd: null }).context, 16, 'каталог аренды неизвестен — не сравнивается');
    const stale = agentView(base, { ...live, now: NOW + CONTEXT_MAX_AGE_MS + 1 });
    assert.equal(stale.contextHidden, 'stale');
  });

  it('сжатие: 🌀 вместо 🧠; старше 15 минут без PostCompact — снято; после сжатия число прежней перерисовки — не показывается', () => {
    const pre = applyHook(base, { hook_event_name: 'PreCompact', session_id: 's1' }, NOW + 1000).state;
    const v = agentView(pre, { ...live, now: NOW + 2000 });
    assert.equal(v.compacting, true);
    assert.deepEqual(agentIndicatorParts(v, TZ, NOW + 2000), ['🌀', '🕐 31% · 📅 64%']);
    assert.equal(agentUrgentSignature(v), 'C');
    assert.equal(agentView(pre, { ...live, now: NOW + 1000 + COMPACT_STALE_MS + 1 }).compacting, false);
    const post = applyHook(pre, { hook_event_name: 'PostCompact', session_id: 's1' }, NOW + 3000).state;
    const after = agentView(post, { ...live, now: NOW + 4000 });
    assert.equal(after.compacting, false);
    assert.equal(after.contextHidden, 'after_compact');
    assert.deepEqual(agentIndicatorParts(after, TZ, NOW + 4000), ['🕐 31% · 📅 64%']);
    const fresh = applyStatusline(post, input({ context_window: { used_percentage: 9 } }), NOW + 5000);
    assert.equal(agentView(fresh, { ...live, now: NOW + 6000 }).context, 9);
    // Сжатие другой сессии — не наше.
    const otherPre = applyHook(base, { hook_event_name: 'PreCompact', session_id: 's9' }, NOW + 1000).state;
    assert.equal(agentView(otherPre, { ...live, now: NOW + 2000 }).compacting, false);
  });

  it('сжатие внутри субагента (agent_id) — не 🌀; StopFailure той же сессии снимает 🌀 (сжатие оборвалось — PostCompact не придёт)', () => {
    const sub = applyHook(base, { hook_event_name: 'PreCompact', session_id: 's1', agent_id: 'a1b2', agent_type: 'general-purpose', trigger: 'auto' }, NOW + 1000);
    assert.equal(sub.event, null);
    assert.equal(sub.state, base, 'состояние то же');
    assert.equal(applyHook(base, { hook_event_name: 'PostCompact', session_id: 's1', agent_id: 'a1b2' }, NOW + 1000).state, base);
    // agent_type без agent_id — главный поток, запущенный с --agent: сжатие его.
    const main = applyHook(base, { hook_event_name: 'PreCompact', session_id: 's1', agent_type: 'assistant', trigger: 'auto' }, NOW + 1000).state;
    assert.equal(agentView(main, { ...live, now: NOW + 2000 }).compacting, true);
    const broke = applyHook(main, stopFailure('invalid_request', 'Prompt is too long'), NOW + 3000).state;
    assert.equal(broke.compact, null);
    assert.equal(agentView(broke, { ...live, now: NOW + 4000 }).compacting, false);
    // StopFailure другой сессии сжатие этой не снимает.
    assert.ok(applyHook(main, stopFailure('rate_limit', 'x', { session_id: 's9' }), NOW + 3000).state.compact);
  });

  it('лимит выше 80% — ⚠ и время сброса (ближе 12 ч — ЧЧ:ММ, дальше — день недели); сброс прошёл — «—»; нет обоих — без 🕐', () => {
    const hot = applyStatusline(emptyAgentState(), input({
      rate_limits: {
        five_hour: { used_percentage: 85.4, resets_at: Math.round((NOW + 2 * H) / 1000) },
        seven_day: { used_percentage: 91, resets_at: Math.round((NOW + 3 * 24 * H) / 1000) },
      },
    }), NOW);
    const v = agentView(hot, live);
    assert.equal(agentUrgentSignature(v), '57');
    assert.equal(localTime(NOW + 2 * H, TZ), '11:00');
    assert.equal(weekdayShort(NOW + 3 * 24 * H, TZ), 'ср');
    assert.deepEqual(agentIndicatorParts(v, TZ, NOW), ['🧠 16%', '🕐 ⚠85% до 11:00 · 📅 ⚠91% до ср']);
    // 80% ровно — ещё без ⚠.
    const edge = applyStatusline(emptyAgentState(), input({ rate_limits: { five_hour: { used_percentage: 80.2, resets_at: Math.round((NOW + H) / 1000) } } }), NOW);
    assert.deepEqual(agentIndicatorParts(agentView(edge, live), TZ, NOW), ['🧠 16%', '🕐 80% · 📅 —']);
    // Сброс 5-часового прошёл — «—» (лимит общий на подписку: после сброса число неизвестно).
    const later = NOW + 3 * H + 1;
    assert.deepEqual(agentIndicatorParts(agentView(base, { ...live, now: later }), TZ, later), ['🧠 16%', '🕐 — · 📅 64%']);
    const gone = NOW + 5 * 24 * H;
    assert.deepEqual(agentIndicatorParts(agentView(base, { ...live, now: gone }), TZ, gone).filter((p) => p.startsWith('🕐')), []);
  });

  it('отказ модели: действует — пока агент не ответил после него, не снят строкой и не старше суток', () => {
    const f = applyHook(base, stopFailure('rate_limit', 'API Error: Rate limit exceeded'), NOW + 1000).state;
    assert.ok(agentView(f, { ...live, now: NOW + 2000 }).failure);
    assert.equal(agentUrgentSignature(agentView(f, { ...live, now: NOW + 2000 })), 'F');
    assert.equal(agentView(f, { ...live, now: NOW + 2000, lastAgentActivityAt: NOW + 1500 }).failure, null, 'агент ответил после отказа');
    assert.ok(agentView(f, { ...live, now: NOW + 2000, lastAgentActivityAt: NOW + 500 }).failure, 'ответ до отказа не снимает');
    assert.equal(agentView(f, { ...live, now: NOW + 1000 + FAILURE_MAX_AGE_MS + 1 }).failure, null);
    const cleared = applyStatusline(f, input({ cost: { total_cost_usd: 0.7 } }), NOW + 3000);
    assert.equal(agentView(cleared, { ...live, now: NOW + 4000 }).failure, null);
  });

  it('«статус»: контекст, лимиты со сбросом, строка состояния; отказ — время, тип, текст (и подробности), действует или снят', () => {
    const f = applyHook(base, stopFailure('oauth_org_not_allowed', ORG_DISABLED), NOW + 60_000).state;
    const now = NOW + 120_000;
    const lines = agentStatusLines(f, agentView(f, { ...live, now }), TZ, now);
    assert.equal(lines[0], 'Агент: контекст 16%, Opus · лимиты: 5 ч 31% (сброс 12:00), неделя 64% (сброс чт 09:00) · строка состояния от 09:00');
    assert.equal(lines[1], `Отказ модели: 09:01 (oauth_org_not_allowed) — «${ORG_DISABLED}»; действует`);
    const d = applyHook(base, stopFailure('invalid_request', 'Prompt is too long', { error_details: 'prompt is too long: 210000 tokens > 200000 maximum' }), NOW + 60_000).state;
    assert.equal(agentStatusLines(d, agentView(d, { ...live, now }), TZ, now)[1], 'Отказ модели: 09:01 (invalid_request) — «Prompt is too long» (подробности: prompt is too long: 210000 tokens > 200000 maximum); действует');
    const done = agentStatusLines(f, agentView(f, { ...live, now, lastAgentActivityAt: now }), TZ, now);
    assert.match(done[1]!, /; снят — агент ответил$/);
    assert.deepEqual(agentStatusLines(null, agentView(null, live), TZ, NOW), ['Агент: данных нет — строка состояния и перехватчики Claude Code не подключены (stg agent-state, README папки агента)']);
  });

  it('своя короткая строка агента (без --then): `Opus · 🧠 16% · 🕐 31% · 📅 64%`; без данных — не пустая', () => {
    assert.equal(statuslineShortLine(input()), 'Opus · 🧠 16% · 🕐 31% · 📅 64%');
    assert.equal(statuslineShortLine({ model: { display_name: 'Sonnet' } }), 'Sonnet');
    assert.equal(statuslineShortLine(null), 'stg · нет данных строки состояния');
  });
});

describe('строки владельцу: значки агента, /help, отказ модели', () => {
  it('закреплённая строка: кружок, 📥, затем 🧠 и 🕐 (🕐 — последним); 🔴 — отказ модели', () => {
    const ep = { id: 2, topic: 'Новая тема' };
    assert.equal(
      statusLineText({ episode: ep, role: '', agent: 'free', waiting: 0, mode: 'running', indicators: ['🧠 16%', '🕐 31% · 📅 64%'] }),
      '📍 #2 · тема не названа\n🟢 · 🧠 16% · 🕐 31% · 📅 64%',
    );
    assert.equal(
      statusLineText({ episode: ep, role: '', agent: 'failed', waiting: 3, mode: 'paused', indicators: ['🌀'] }),
      '📍 #2 · тема не названа\n⏸ пауза · 🔴 · 📥 3 · 🌀',
    );
  });

  it('/help — расшифровка 🧠, 🌀, 🕐 (5 часов · 📅 неделя), ⚠, 🔴', () => {
    const h = helpText({ whereTtlMinutes: 5, audioMaxMinutes: 15 });
    for (const w of ['🧠', '🌀', '🕐', '📅', 'на 5 часов', 'на неделю', '⚠ — выше 80%', '🔴 модель не отвечает']) assert.ok(h.includes(w), `/help без «${w}»`);
    // Реакции — 0.3.2 (R-1 б: ✍ не ставится): 👀 агент увидел → 👌 агент ответил.
    assert.ok(h.includes('👀 агент увидел · 👌 агент ответил'), h);
    assert.ok(!h.includes('✍'), h);
    assert.ok(!h.includes('галочк'), h);
  });

  it('отказ модели: `⚙ Агент не может ответить: …` — в одну строку, не длиннее 160 знаков текста', () => {
    assert.equal(agentFailureNotice('Rate limit exceeded'), '⚙ Агент не может ответить: Rate limit exceeded');
    const long = agentFailureNotice('очень '.repeat(60));
    assert.ok(long.startsWith('⚙ Агент не может ответить: очень') && long.endsWith('…') && !long.includes('\n'), long);
    assert.equal(agentFailureNotice('  '), '⚙ Агент не может ответить: ошибка без текста');
  });
});
