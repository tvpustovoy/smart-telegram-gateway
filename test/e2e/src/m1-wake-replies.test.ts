// A1.19 (Ш-12, Ш-14) — скачок поддельных часов на 2 часа: запись wake; ровно одно закрытие эпизода, одна строка «не на
// связи», повторы не удвоены; сначала забирается накопленное, потом проверяются сроки — и тогда, когда первый опрос
// после сна упал (сеть ещё не поднялась): сроки ждут удачного опроса. «Повторы не удвоены» для повторной отдачи
// событий агенту (A3.6) — m3-redelivery.test.ts: скачок на 2 ч при отданном событии.
// A1.21 (Ш-27) — реплай владельца на ответ агента (с цитатой и без), на квитанцию (голосового: квитанция
// сообщением — только у голосового и аудиофайла), на служебную строку, на закреплённую строку состояния, на своё
// сообщение, на сообщение до шлюза: reply_to по
// таблице 5.4; у ответа агента — excerpt; у квитанции — без текста; до шлюза — unknown; метка owner.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { offlineNotice, type Message } from 'stg-core';
import { reply } from 'stg-fake-telegram';
import { T0, assertNoLoss, connectAdapter, count, pump, q, q1, readJournal, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, botTexts, setup, statusLineOf, waitRecorded, type Setup } from './m1-common.js';

describe('A1.19 · сон ноутбука: скачок часов на 2 часа', () => {
  let s: Setup;
  let gw: GatewayProcess;
  before(async () => {
    s = await setup();
    gw = await s.start();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('wake; накопленное — сначала; одно закрытие эпизода, одна строка «не на связи»; повторы не удвоены', async () => {
    const [m1] = s.fake.push(s.fake.builder.text(OWNER, 'до сна'));
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', m1!.update_id) === 1, 5000, 'приёма');
    await waitRecorded(s, gw, m1!);
    // Ноутбук «спит»: соединение опроса мертво, а владелец за это время написал ещё одно.
    await waitUntil(() => s.fake.stallCurrentPolls() === 1 || null, 5000, 'висящего опроса');
    const pollsBefore = s.fake.callsOf('getUpdates').length;
    const during = s.fake.builder.text(OWNER, 'написал, пока ноутбук спал', { date: Math.floor((T0 + 100 * 60_000) / 1000) });
    s.fake.push(during);
    await gw.jump('2h');
    const wake = await gw.waitForJournal((l) => l.ev === 'wake');
    assert.ok((wake.slept_ms as number) >= 2 * 3600_000 - 60_000);
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', during.update_id) === 1, 5000, 'приёма накопленного');
    await gw.waitForJournal((l) => l.ev === 'offline_notice');
    // Сначала забрал накопленное (опрос с timeout 0), потом сроки.
    const j = readJournal(s.home);
    const iWake = j.findIndex((l) => l.ev === 'wake');
    const iIn = j.findIndex((l) => l.ev === 'in' && l.update_id === during.update_id);
    const iNotice = j.findIndex((l) => l.ev === 'offline_notice');
    assert.ok(iWake < iIn && iIn < iNotice, 'порядок: wake → приём накопленного → проверка сроков');
    assert.ok(s.fake.callsOf('getUpdates').some((c) => c.nth > pollsBefore && c.params.timeout === 0));
    // Ещё немного времени — тиков много, а строка и закрытие — по одному.
    await pump(gw, () => botTexts(s.fake).includes(offlineNotice(2)), { what: 'строки «не на связи»' });
    for (let i = 0; i < 5; i++) await gw.advance('1m');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM episodes WHERE close_reason = 'idle'"), 1, 'ровно одно закрытие');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'episode_closed'"), 1);
    assert.equal(botTexts(s.fake).filter((t) => t.startsWith('⚙ Агент сейчас не на связи')).length, 1, 'одна строка «не на связи»');
    assert.equal(readJournal(s.home).filter((l) => l.ev === 'wake').length, 1);
    // Сообщение, написанное во сне, — в новом эпизоде; прежний закрыт тишиной по дате сообщения.
    const eps = q<{ id: number; opened_by: string; closed_at: number | null }>(s.home, 'SELECT id, opened_by, closed_at FROM episodes ORDER BY id');
    assert.equal(eps.length, 2);
    assert.equal(eps[1]!.opened_by, 'idle');
    assert.equal(eps[1]!.closed_at, null);
    await gw.stop();
    assertNoLoss(s.fake, s.home);
  });
});

describe('A1.19 · после сна первый опрос упал', () => {
  let s: Setup;
  let gw: GatewayProcess;
  before(async () => {
    s = await setup();
    gw = await s.start();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('сроки ждут удачного опроса: написанное во сне через 20 минут — в том же эпизоде, «не на связи» — про оба', async () => {
    const [m1] = s.fake.push(s.fake.builder.text(OWNER, 'до сна'));
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', m1!.update_id) === 1, 5000, 'приёма');
    await waitRecorded(s, gw, m1!);
    await waitUntil(() => s.fake.stallCurrentPolls() === 1 || null, 5000, 'висящего опроса');
    // Владелец написал через 20 минут после «до сна» (меньше 33): эпизод тот же — если сроки не проверены раньше времени.
    const during = s.fake.builder.text(OWNER, 'написал во сне', { date: Math.floor((T0 + 20 * 60_000) / 1000) });
    s.fake.push(during);
    // Первые два опроса после пробуждения падают: обрыв и 502.
    const n = s.fake.callsOf('getUpdates').length;
    s.fake.scenario({ method: 'getUpdates', nth: n + 1, reply: reply.drop() });
    s.fake.scenario({ method: 'getUpdates', nth: n + 2, reply: reply.error(502, 'Bad Gateway') });
    await gw.jump('2h');
    await gw.waitForJournal((l) => l.ev === 'wake');
    await gw.waitForJournal((l) => l.ev === 'poll_error');
    // Сроки не проверены, пока накопленное не забрано.
    assert.equal(count(s.home, "SELECT count(*) AS n FROM episodes WHERE close_reason = 'idle'"), 0, 'эпизод не закрыт до приёма накопленного');
    await pump(gw, () => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', during.update_id) === 1, { what: 'приёма накопленного' });
    await gw.waitForJournal((l) => l.ev === 'offline_notice');
    const j = readJournal(s.home);
    const iIn = j.findIndex((l) => l.ev === 'in' && l.update_id === during.update_id);
    const iClose = j.findIndex((l) => l.ev === 'episode_close');
    const iNotice = j.findIndex((l) => l.ev === 'offline_notice');
    assert.ok(iIn >= 0 && iIn < iClose && iIn < iNotice, 'порядок: приём накопленного → сроки');
    assert.ok(j.filter((l) => l.ev === 'poll_error').length >= 2);
    assert.ok(s.fake.callsOf('getUpdates').filter((c) => c.nth > n && c.params.timeout === 0).length >= 2, 'после сбоев — снова опрос с timeout 0');
    const evs = q<{ update_id: number; episode_id: number }>(s.home, "SELECT update_id, episode_id FROM events WHERE kind = 'text' ORDER BY seq");
    assert.equal(evs[0]!.episode_id, evs[1]!.episode_id, 'написанное во сне — в том же эпизоде');
    await pump(gw, () => botTexts(s.fake).includes(offlineNotice(2)), { what: 'строки «не на связи» про оба' });
    await gw.stop();
  });
});

describe('A1.21 · реплаи владельца', () => {
  let s: Setup;
  let gw: GatewayProcess;
  before(async () => {
    s = await setup();
    gw = await s.start();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('reply_to по таблице 5.4: агент (excerpt), квитанция и служебная строка (без текста), своё, до шлюза (unknown)', async () => {
    const [m1] = s.fake.push(s.fake.builder.text(OWNER, 'первое сообщение'));
    const [vu] = s.fake.push(s.fake.builder.voice(OWNER, { duration: 3, fileId: 'reply-voice' }));
    // Ответ шлюза на голосовое (расшифровка или причина, 0.3.1) — сообщение события № 2: реплай на него — «квитанция».
    const receipt = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => (m.reply_parameters as { message_id?: number } | null)?.message_id === vu!.message!.message_id), {
      what: 'ответа на голосовое',
    });
    await waitUntil(() => q1(s.home, 'SELECT 1 FROM messages_out WHERE tg_message_id = ?', receipt.message_id), 5000, 'messages_out');
    const pinned = await pump(gw, () => statusLineOf(s.fake), { what: 'закреплённой строки' });
    // Агента нет 11 минут — служебная строка «не на связи».
    const service = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text?.startsWith('⚙ Агент сейчас не на связи')), {
      step: '1m',
      what: 'строки «не на связи»',
    });
    await waitUntil(() => q1(s.home, 'SELECT 1 FROM messages_out WHERE tg_message_id = ?', service.message_id), 5000, 'messages_out');
    const { ch, turn } = await connectAdapter(s.home);
    const agentText = 'Записал в заметки на завтра: позвонить юристу, оплатить счёт и **не забыть** про подарок. ' + 'Ещё подробности. '.repeat(20);
    try {
      await ch.waitEvent(1);
      await ch.delivered(1);
      await ch.reply(1, agentText, turn);
      await pump(gw, () => count(s.home, "SELECT count(*) AS n FROM outbox WHERE kind = 'agent' AND status = 'sent'") === 1, { what: 'ответа агента' });
    } finally {
      ch.close();
    }
    const agentMsg = s.fake.sentTo(OWNER.id).find((m) => m.text?.startsWith('Записал в заметки'))!;
    const pre: Message = { ...receipt.message, message_id: 5 };
    const b = s.fake.builder;
    const ownMsg = { ...m1!.message! } as Message;
    const cases = [
      { name: 'ответ агента без цитаты', u: b.replyTo(OWNER, 'а что со счётом?', agentMsg.message), kind: 'agent', seq: 1, excerpt: true },
      { name: 'ответ агента с цитатой', u: b.replyTo(OWNER, 'вот это', agentMsg.message, { quote: 'позвонить юристу' }), kind: 'agent', seq: 1, excerpt: true },
      { name: 'квитанция', u: b.replyTo(OWNER, 'и ещё к этому', receipt.message), kind: 'receipt', seq: 2, excerpt: false },
      { name: 'служебная строка', u: b.replyTo(OWNER, 'знаю', service.message), kind: 'service', seq: null, excerpt: false },
      { name: 'закреплённая строка', u: b.replyTo(OWNER, 'понял', pinned.message.message), kind: 'service', seq: null, excerpt: false },
      { name: 'своё сообщение', u: b.replyTo(OWNER, 'дополню', ownMsg), kind: 'owner', seq: 1, excerpt: false },
      { name: 'сообщение до шлюза', u: b.replyTo(OWNER, 'старое', pre), kind: 'unknown', seq: null, excerpt: false },
    ];
    for (const c of cases) s.fake.push(c.u);
    const last = cases[cases.length - 1]!.u.update_id;
    await waitUntil(() => q1(s.home, "SELECT 1 FROM updates WHERE update_id = ? AND status = 'admitted'", last), 5000, 'приёма реплаев');
    for (const c of cases) {
      const ev = q1<{ trust: string; mixed: number; reply_to: string }>(s.home, 'SELECT trust, mixed, reply_to FROM events WHERE update_id = ?', c.u.update_id)!;
      const rt = JSON.parse(ev.reply_to) as { kind: string; event_seq: number | null; excerpt?: string; episode_topic?: string | null };
      assert.equal(ev.trust, 'owner', c.name);
      assert.equal(ev.mixed, 0, c.name);
      assert.equal(rt.kind, c.kind, c.name);
      assert.equal(rt.event_seq, c.seq, c.name);
      if (c.excerpt) {
        assert.ok(rt.excerpt && agentText.startsWith(rt.excerpt.slice(0, 50)), `${c.name}: excerpt «${rt.excerpt}»`);
        assert.ok(rt.excerpt.length <= 200);
        assert.equal(rt.episode_topic, 'Новая тема');
      } else {
        assert.equal(rt.excerpt, undefined, `${c.name}: текст не вкладывается`);
      }
    }
    // Переходник видит reply_to в событии.
    const { ch: ch2 } = await connectAdapter(s.home);
    try {
      const ev = await waitUntil(() => ch2.events().find((e) => e.reply_to?.kind === 'agent'), 5000, 'события с reply_to');
      assert.equal(ev.reply_to?.event_seq, 1);
      assert.ok(ev.reply_to?.excerpt);
    } finally {
      ch2.close();
    }
    await gw.stop();
    assertNoLoss(s.fake, s.home);
  });
});
