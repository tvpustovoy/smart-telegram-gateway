// M16 · перерыв (5.3 «Сон ноутбука»): настоящий шлюз, поддельный Telegram и канал. Сон застал сообщение у агента —
// после пробуждения оно отдаётся снова сразу, хотя до сна были вызовы; когда закрыто — сводка с номерами, номер
// присылает ответ на само сообщение. Опоздавшее сообщение (Telegram держал его) — тоже перерыв. Сон без ждущих — без
// сводки. Не закрыто за 30 минут — сводка с тем, что ждёт. Отказ модели сразу после сна или снятый за 30 с — без строки.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { type Update } from 'stg-core';
import { FakeChannel } from 'stg-fake-channel';
import type { SentMessage } from 'stg-fake-telegram';
import { connectAdapter, pump, q1, readJournal, runCliInput, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, chatMessages, setup, type Setup } from './m1-common.js';
import { buttonsOf, press } from './m2-common.js';

const NOTICE = '⚙ Агент не может ответить: ';
const SHOW_RE = /^⚙ Сообщение \d\d:\d\d: /;

describe('M16 · перерыв: сводка после сна', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  let turn: number;
  const seqOf = (u: Update): Promise<number> =>
    waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
  const push = (text: string, date?: number): Update => s.fake.push(s.fake.builder.text(OWNER, text, date === undefined ? {} : { date }))[0]!;
  const frames = (seq: number) => ch.events().filter((e) => e.seq === seq);
  const reports = (): SentMessage[] => chatMessages(s.fake).filter((m) => (m.text ?? '').startsWith('⚙ Перерыв'));
  const shows = (): SentMessage[] => chatMessages(s.fake).filter((m) => SHOW_RE.test(m.text ?? ''));
  const replyTo = (m: SentMessage): number | undefined => (m.reply_parameters as { message_id?: number } | null)?.message_id;
  const wake = async (spec: string): Promise<void> => {
    const n = readJournal(s.home).filter((l) => l.ev === 'wake').length;
    await gw.jump(spec);
    await waitUntil(() => readJournal(s.home).filter((l) => l.ev === 'wake').length > n || null, 10_000, 'пробуждения');
  };
  const cli = async (sub: 'statusline' | 'hook', json: unknown): Promise<void> => {
    const r = await runCliInput(['agent-state', sub], s.env, JSON.stringify(json));
    assert.equal(r.code, 0, r.stderr);
  };
  const failure = (type: string, message: string): Record<string, unknown> => ({
    session_id: 's1',
    transcript_path: '/t.jsonl',
    cwd: process.cwd(),
    hook_event_name: 'StopFailure',
    error: type,
    last_assistant_message: message,
  });
  const statusline = (cost: number): Record<string, unknown> => ({
    session_id: 's1',
    cwd: process.cwd(),
    workspace: { current_dir: process.cwd(), project_dir: process.cwd() },
    model: { display_name: 'Opus' },
    context_window: { used_percentage: 16.4 },
    cost: { total_cost_usd: cost },
  });
  const notices = (): string[] => chatMessages(s.fake).map((m) => m.text ?? '').filter((t) => t.startsWith(NOTICE));
  const skipped = (reason: string): number => readJournal(s.home).filter((l) => l.ev === 'agent_failure_notice_skipped' && l.reason === reason).length;

  before(async () => {
    s = await setup();
    gw = await s.start();
    ({ ch, turn } = await connectAdapter(s.home));
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('сон застал сообщение у агента: повтор сразу после пробуждения, хотя до сна были вызовы; ответ — сводка; номер показывает само сообщение, и не один раз', async () => {
    const u = push('позвони маме');
    const sq = await seqOf(u);
    await ch.waitEvent(sq);
    await ch.delivered(sq);
    await ch.where();
    await wake('20m');
    await waitUntil(() => frames(sq).length === 2 || null, 5000, 'повтора после сна');
    assert.deepEqual(frames(sq).map((e) => e.redelivery), [false, true]);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'redelivered' && l.seq === sq && l.after_sleep === true));
    assert.ok(!readJournal(s.home).some((l) => l.ev === 'redelivery_postponed' && l.seq === sq), 'вызов до сна — не занятость');
    assert.equal(reports().length, 0, 'сообщение ждёт — сводки нет');
    const r = await ch.reply(sq, 'Позвонил', turn);
    assert.ok(r.type === 'ack' && r.result === 'queued');
    const report = await pump(gw, () => reports()[0], { what: 'сводки', step: '15s' });
    assert.match(
      report.text ?? '',
      /^⚙ Перерыв \d\d:\d\d–\d\d:\d\d: компьютер спал\. Твоих сообщений за это время: 1, все сохранены:\n1\. \d\d:\d\d «позвони маме» — ответ \d\d:\d\d\nНажми номер — покажу само сообщение\.$/,
    );
    assert.deepEqual(buttonsOf(report).map((b) => b.text), ['1']);
    assert.equal(await press(s, report, '1'), null);
    const first = await pump(gw, () => shows()[0], { what: 'показа сообщения' });
    assert.match(first.text ?? '', /^⚙ Сообщение \d\d:\d\d: ответ \d\d:\d\d$/);
    assert.equal(replyTo(first), u.message!.message_id, 'ответ — на само сообщение');
    // Кнопка многоразовая: под сводкой осталась, второе нажатие — ещё один показ.
    assert.equal(await press(s, report, '1'), null);
    await pump(gw, () => shows().length === 2 || null, { what: 'второго показа' });
    for (let i = 0; i < 3; i++) await gw.advance('1m');
    assert.equal(reports().length, 1, 'сводка — одна');
  });

  it('опоздавшее сообщение (написано на 10 минут раньше приёма) — перерыв «сообщения ждали шлюз»; закрыто без ответа — 👌', async () => {
    const u = push('написал, пока шлюз спал', Math.floor((s.time.now() - 10 * 60_000) / 1000));
    const sq = await seqOf(u);
    await ch.waitEvent(sq);
    await ch.delivered(sq);
    await ch.done([sq]);
    const report = await pump(gw, () => reports().find((m) => (m.text ?? '').includes('написал, пока')), { what: 'сводки', step: '15s' });
    assert.match(report.text ?? '', /: сообщения ждали шлюз\. Твоих сообщений за это время: 1, все сохранены:\n1\. \d\d:\d\d «написал, пока шлюз спал» — закрыто 👌\n/);
  });

  it('сон без ждущих сообщений — сводки нет', async () => {
    const before = reports().length;
    await wake('20m');
    for (let i = 0; i < 3; i++) await gw.advance('1m');
    assert.equal(reports().length, before);
  });

  it('не закрыто за 30 минут после пробуждения — сводка с тем, что ждёт', async () => {
    const sq = await seqOf(push('сложная задача'));
    await ch.waitEvent(sq);
    await ch.delivered(sq);
    await wake('20m');
    await waitUntil(() => frames(sq).length === 2 || null, 5000, 'повтора после сна');
    const report = await pump(gw, () => reports().find((m) => (m.text ?? '').includes('сложная задача')), { what: 'сводки через 30 минут', step: '1m', timeoutMs: 60_000 });
    assert.match(report.text ?? '', /\n1\. \d\d:\d\d «сложная задача» — у агента, ответа ещё нет\n/);
    await ch.done([sq]);
  });

  it('отказ модели сразу после сна — без строки владельцу; снятый за 30 секунд — тоже; держится дольше — строка', async () => {
    await cli('statusline', statusline(1.0));
    await wake('20m');
    await cli('hook', failure('server_error', 'Your computer went to sleep mid-response. The response above may be incomplete.'));
    await pump(gw, () => skipped('sleep') === 1 || null, { what: 'отказа от сна', step: '5s' });
    for (let i = 0; i < 3; i++) await gw.advance('2m');
    await cli('hook', failure('rate_limit', 'Rate limit exceeded'));
    await gw.advance('5s');
    await cli('statusline', statusline(2.0));
    await pump(gw, () => skipped('cleared') === 1 || null, { what: 'снятого отказа', step: '5s' });
    assert.deepEqual(notices(), [], 'строк об отказе нет');
    await cli('hook', failure('overloaded_error', 'Overloaded'));
    await pump(gw, () => notices().length === 1 || null, { what: 'строки об отказе', step: '5s' });
    assert.equal(notices()[0], `${NOTICE}Overloaded`);
  });
});
