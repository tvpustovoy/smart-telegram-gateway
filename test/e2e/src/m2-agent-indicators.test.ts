// Значки агента в закреплённой строке (J-4; TECH-SPEC 5.14; P-1, D-6): на связи агент или нет, контекст и сжатие,
// лимиты; «на связи» — кружком, без слов; у лимитов — свой значок.
// Файл agent-state.json пишет настоящий `stg agent-state` (как его запустит Claude Code), время — поддельные часы шлюза:
// - отказ модели (StopFailure) — 🔴 вместо ⚪ / 🟢 и одна строка `⚙ Агент не может ответить: …`; та же ошибка в течение
//   часа — без второй строки, другая — новая; «статус» — время и текст; снят — агент ответил (done) или строка
//   состояния с выросшей суммой;
// - обычное: `🟢 · 🧠 16% · 🕐 31% · 📅 64%`; проценты меняются не чаще раза в 60 с; сжатие (🌀) и ⚠ выше 80% — сразу;
//   после сжатия прежнее число не показывается; сжатие без PostCompact дольше 15 минут — снято;
// - сброс лимита прошёл — «—»; другая сессия (каталог не тот, что у аренды) и данные старше суток — 🧠 нет;
// - /help — расшифровка значков;
// - StopFailure — в настоящем виде Claude Code 2.1.306 (error — тип, last_assistant_message — текст): владелец видит текст;
// - `stg status` — строки «агент: …» и «отказ модели: …»; правило «раз в час» переживает перезапуск шлюза.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AGENT_STATE_FILE, localTime, readAgentStateFile, writeFileAtomicSync } from 'stg-core';
import type { FakeChannel } from 'stg-fake-channel';
import { connectAdapter, pump, q, readJournal, runCli, runCliInput, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, chatMessages, setup, statusLineOf, waitRecorded, type Setup } from './m1-common.js';

const TZ = 'America/Los_Angeles';
const H = 3600_000;
const NOTICE = '⚙ Агент не может ответить: ';

describe('значки агента: контекст и сжатие, лимиты, отказ модели', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel | null = null;
  const now = (): number => s.time.now();
  const waitStatus = async (pred: (text: string) => boolean, what: string, step = '1s'): Promise<string> => {
    try {
      return await pump(gw, () => {
        const st = statusLineOf(s.fake);
        return st && pred(st.text) ? st.text : null;
      }, { what, step });
    } catch (err) {
      // В ошибке — что в строке сейчас и последние правки.
      throw new Error(`${(err as Error).message}; строка: «${statusLineOf(s.fake)?.text ?? '—'}»; правки: ${JSON.stringify(edits().slice(-3).map((e) => e.text.split('\n')[1]))}`);
    }
  };
  const second = (): string => statusLineOf(s.fake)?.text.split('\n')[1] ?? '';
  const edits = (): Array<{ at: number; text: string }> =>
    readJournal(s.home)
      .filter((l) => l.ev === 'status_line' && (l.action === 'edit' || l.action === 'new'))
      .map((l) => ({ at: Date.parse(String(l.at)), text: String(l.text) }));
  /** Правка строки с этим текстом — в журнале (запись — после ответа Telegram: дождаться её). */
  const editWith = (part: string): Promise<{ at: number; text: string }> => waitUntil(() => edits().find((e) => e.text.includes(part)), 10_000, `записи правки «${part}»`);
  const notices = (): string[] => chatMessages(s.fake).map((m) => m.text ?? '').filter((t) => t.startsWith(NOTICE));
  const cli = async (sub: 'statusline' | 'hook', json: unknown): Promise<void> => {
    const r = await runCliInput(['agent-state', sub], s.env, JSON.stringify(json));
    assert.equal(r.code, 0, r.stderr);
  };
  const statusline = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    session_id: 's1',
    // Каталог сессии — тот же, что у аренды поддельного переходника (session_hint.cwd = каталог теста).
    cwd: process.cwd(),
    workspace: { current_dir: process.cwd(), project_dir: process.cwd() },
    model: { display_name: 'Opus' },
    context_window: { used_percentage: 16.4 },
    cost: { total_cost_usd: 1.0 },
    rate_limits: {
      five_hour: { used_percentage: 31.2, resets_at: Math.round((now() + 3 * H) / 1000) },
      seven_day: { used_percentage: 64, resets_at: Math.round((now() + 4 * 24 * H) / 1000) },
    },
    ...over,
  });
  /** StopFailure, как его шлёт Claude Code 2.1.306: error — тип, last_assistant_message — текст ошибки на экране агента. */
  const failure = (type: string, message: string): Record<string, unknown> => ({
    session_id: 's1',
    transcript_path: '/t.jsonl',
    cwd: process.cwd(),
    hook_event_name: 'StopFailure',
    error: type,
    last_assistant_message: message,
  });

  before(async () => {
    s = await setup();
    gw = await s.start();
    const m = s.fake.builder.text(OWNER, 'первая мысль');
    s.fake.push(m);
    await waitRecorded(s, gw, m);
    await waitStatus((t) => t.endsWith('\n⚪ · 📥 1'), 'строки без значков агента');
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('D-6: отказ модели, пока агент не на связи, — 🔴 вместо ⚪ и одна строка владельцу без секретов; та же ошибка — без второй строки; другая — новая; «статус» — время и текст', async () => {
    const org = 'API Error: Your organization has disabled Claude subscription access for Claude Code (request 111). Bearer sk-ant-oat01-SECRETSECRETSECRET';
    await cli('hook', failure('oauth_org_not_allowed', org));
    await waitStatus((t) => t.endsWith('\n🔴 · 📥 1'), '🔴');
    await pump(gw, () => notices().length === 1 || null, { what: 'строки об отказе' });
    // Что сказала модель (last_assistant_message без «API Error: »), а не код типа oauth_org_not_allowed.
    assert.equal(notices()[0], `${NOTICE}Your organization has disabled Claude subscription access for Claude Code (request 111). Bearer …`);
    assert.ok(!s.fake.sentTo(OWNER.id).some((m) => (m.text ?? '').includes('SECRET')), 'ключа в чате нет');
    // Та же ошибка (другой номер запроса — та же) через минуту — без второй строки.
    for (let i = 0; i < 60; i++) await gw.advance('1s');
    await cli('hook', failure('oauth_org_not_allowed', org.replace('request 111', 'request 98765')));
    await pump(gw, () => readJournal(s.home).some((l) => l.ev === 'agent_failure_notice_skipped') || null, { what: 'agent_failure_notice_skipped' });
    for (let i = 0; i < 5; i++) await gw.advance('1s');
    assert.equal(notices().length, 1, 'та же ошибка — одна строка в час');
    // Другая ошибка — сразу новая строка.
    await cli('hook', failure('rate_limit', 'Rate limit exceeded'));
    await pump(gw, () => notices().length === 2 || null, { what: 'второй строки' });
    assert.equal(notices()[1], `${NOTICE}Rate limit exceeded`);
    // «статус» — время и текст последнего отказа.
    s.fake.push(s.fake.builder.text(OWNER, 'статус'));
    const st = await pump(gw, () => chatMessages(s.fake).find((m) => (m.text ?? '').startsWith('⚙ Статус')), { what: '«статус»' });
    assert.match(st.text ?? '', new RegExp(`\\nОтказ модели: ${localTime(readAgentStateFile(s.home.dir)!.failure!.at, TZ)} \\(rate_limit\\) — «Rate limit exceeded»; действует\\n`));
  });

  it('агент ответил (done) — отказ снят: 🟢; строка состояния — `🟢 · 🧠 16% · 🕐 31% · 📅 64%`', async () => {
    ({ ch } = await connectAdapter(s.home));
    const waiting = q<{ seq: number }>(s.home, "SELECT seq FROM events WHERE status IN ('new', 'delivered') AND kind = 'text' ORDER BY seq").map((r) => r.seq);
    await pump(gw, () => waiting.every((seq) => ch!.events().some((e) => e.seq === seq)) || null, { what: 'отдачи ждущих' });
    await ch.done(waiting);
    await waitStatus((t) => t.endsWith('\n🟢'), '🟢');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'agent_failure_cleared' && l.by === 'agent_reply'));
    await cli('statusline', statusline());
    await waitStatus((t) => t.endsWith('\n🟢 · 🧠 16% · 🕐 31% · 📅 64%'), 'значков агента');
  });

  it('частота: смена процентов — не чаще раза в 60 с; начало сжатия и ⚠ выше 80% — сразу; после сжатия прежнее число не показывается', async () => {
    const first = await editWith('🧠 16%');
    await cli('statusline', statusline({ context_window: { used_percentage: 17 } }));
    await waitStatus((t) => t.includes('🧠 17%'), '🧠 17%');
    const e17 = await editWith('🧠 17%');
    assert.ok(e17.at - first.at >= 60_000, `проценты сменились через ${e17.at - first.at} мс`);
    // Сжатие — сразу (не ждёт минуты).
    await cli('hook', { session_id: 's1', hook_event_name: 'PreCompact', trigger: 'auto' });
    await waitStatus((t) => t.endsWith('\n🟢 · 🌀 · 🕐 31% · 📅 64%'), '🌀');
    const eC = await editWith('🌀');
    assert.ok(eC.at - e17.at < 60_000 && eC.at - e17.at >= 3_000, `🌀 через ${eC.at - e17.at} мс после прошлой правки`);
    // Сжатие кончилось: прежнее число (до сжатия) не показывается, пока строка не перерисовалась.
    await cli('hook', { session_id: 's1', hook_event_name: 'PostCompact', trigger: 'auto' });
    await waitStatus((t) => t.endsWith('\n🟢 · 🕐 31% · 📅 64%'), 'конца сжатия');
    await cli('statusline', statusline({ context_window: { used_percentage: 9 } }));
    await waitStatus((t) => t.endsWith('\n🟢 · 🧠 9% · 🕐 31% · 📅 64%'), '🧠 9%');
    // 5 часов выше 80% — ⚠ и время сброса, сразу.
    const last = await editWith('🧠 9% · 🕐 31%');
    const resets = now() + 2 * H;
    await cli('statusline', statusline({ context_window: { used_percentage: 9 }, rate_limits: { five_hour: { used_percentage: 85.4, resets_at: Math.round(resets / 1000) } } }));
    const hot = await waitStatus((t) => t.includes('⚠'), '⚠');
    assert.ok(hot.endsWith(`\n🟢 · 🧠 9% · 🕐 ⚠85% до ${localTime(Math.round(resets / 1000) * 1000, TZ)} · 📅 64%`), hot);
    const eHot = await editWith('⚠85%');
    assert.ok(eHot.at - last.at < 60_000, `⚠ через ${eHot.at - last.at} мс`);
  });

  it('сжатие без PostCompact дольше 15 минут — 🌀 снят; сброс прошёл — «—»; другая сессия и данные старше суток — 🧠 нет', async () => {
    await cli('hook', { session_id: 's1', hook_event_name: 'PreCompact', trigger: 'auto' });
    await waitStatus((t) => t.includes('🌀'), '🌀');
    const since = now();
    await waitStatus((t) => !t.includes('🌀'), 'снятия 🌀', '30s');
    assert.ok(now() - since >= 15 * 60_000, `снят через ${now() - since} мс`);
    // Claude Code прислал окно с прошедшим сбросом — «—», не неверное число.
    await cli('statusline', statusline({ rate_limits: { five_hour: { used_percentage: 99, resets_at: Math.round((now() - 60_000) / 1000) }, seven_day: { used_percentage: 64, resets_at: Math.round((now() + 3 * 24 * H) / 1000) } } }));
    await waitStatus((t) => t.endsWith('\n🟢 · 🧠 16% · 🕐 — · 📅 64%'), '«—» вместо прошедшего');
    // Строка состояния другой сессии (каталог не тот, что у аренды) — 🧠 нет, лимиты (общие на подписку) — есть.
    await cli('statusline', statusline({ cwd: '/elsewhere/agent', workspace: { current_dir: '/elsewhere/agent', project_dir: '/elsewhere/agent' } }));
    await waitStatus((t) => t.endsWith('\n🟢 · 🕐 31% · 📅 64%'), 'без 🧠 чужой сессии', '5s');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'agent_context_hidden' && l.why === 'other_session'));
    // Данные старше суток — 🧠 нет.
    await cli('statusline', statusline());
    await waitStatus((t) => t.includes('🧠 16%'), '🧠 снова', '5s');
    const file = path.join(s.home.dir, AGENT_STATE_FILE);
    const st = readAgentStateFile(s.home.dir)!;
    writeFileAtomicSync(file, JSON.stringify({ ...st, statusline: { ...st.statusline!, at: now() - 25 * H } }) + '\n');
    await waitStatus((t) => !t.includes('🧠'), 'без 🧠 старых данных', '5s');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'agent_context_hidden' && l.why === 'stale'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('отказ снимается и строкой состояния с выросшей суммой (модель снова ответила); та же ошибка в течение часа — без новой строки; /help — расшифровка значков', async () => {
    await cli('statusline', statusline({ cost: { total_cost_usd: 2.0 } }));
    await waitStatus((t) => t.includes('🧠 16%'), '🧠');
    await cli('hook', failure('rate_limit', 'Rate limit exceeded'));
    await waitStatus((t) => /\n🔴 · /.test(t), '🔴');
    await pump(gw, () => readJournal(s.home).filter((l) => l.ev === 'agent_failure_notice_skipped').length >= 2 || null, { what: 'повтор той же ошибки' });
    assert.equal(notices().length, 2, 'та же ошибка в течение часа — без новой строки');
    // Перерисовка с той же суммой (после ошибки) — отказ действует; с большей — снят.
    await cli('statusline', statusline({ cost: { total_cost_usd: 2.0 } }));
    for (let i = 0; i < 5; i++) await gw.advance('1s');
    assert.match(second(), /^🔴/);
    await cli('statusline', statusline({ cost: { total_cost_usd: 2.5 } }));
    await waitStatus((t) => /\n🟢 · /.test(t), '🟢 после ответа модели');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'agent_failure_cleared' && l.by === 'statusline'));
    s.fake.push(s.fake.builder.text(OWNER, '/help'));
    const help = await pump(gw, () => chatMessages(s.fake).find((m) => (m.text ?? '').startsWith('⚙ Как устроен чат')), { what: '/help' });
    for (const w of ['🧠', '🌀', '🕐', '📅', '⚠', '🔴']) assert.ok((help.text ?? '').includes(w), `/help без ${w}`);
    // stg status — те же строки, что «статус»: агент (контекст, лимиты, строка состояния) и последний отказ.
    const st = await runCli(['status'], s.env);
    const f = readAgentStateFile(s.home.dir)!.failure!;
    const agentLine = st.stdout.split('\n').find((l) => l.startsWith('агент: '));
    assert.match(agentLine ?? '', /^агент: контекст 16%, Opus · лимиты: 5 ч 31% \(сброс \d\d:\d\d\), неделя 64% \(сброс .. \d\d:\d\d\) · строка состояния от \d\d:\d\d$/, st.stdout);
    assert.ok(st.stdout.includes(`\nотказ модели: ${localTime(f.at, TZ)} (rate_limit) — «Rate limit exceeded»; снят в ${localTime(f.cleared_at!, TZ)} — модель снова ответила\n`), st.stdout);
  });

  it('перезапуск шлюза: та же ошибка в течение часа — без новой строки (учёт в базе); 🔴 — сразу', async () => {
    ch?.close();
    ch = null;
    await gw.stop();
    gw = await s.start();
    const skipped = (): number => readJournal(s.home).filter((l) => l.ev === 'agent_failure_notice_skipped').length;
    const before = skipped();
    await cli('hook', failure('rate_limit', 'Rate limit exceeded'));
    await waitStatus((t) => /\n🔴/.test(t), '🔴 после перезапуска');
    await pump(gw, () => skipped() > before || null, { what: 'agent_failure_notice_skipped после перезапуска' });
    for (let i = 0; i < 5; i++) await gw.advance('1s');
    assert.equal(notices().length, 2, 'та же ошибка — одна строка в час и после перезапуска');
  });
});
