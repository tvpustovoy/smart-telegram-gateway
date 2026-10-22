// M3 · повтор отданного и прочее протокола на поддельном переходнике (TECH-SPEC 5.10, 5.5а, 5.3; К-5, Оч-2, Ш-12, Ш-27):
// A3.6 повтор по сроку и строка владельцу · A3.6а вызов where() откладывает повтор · A3.6б откладываний — не больше 3
// подряд: затем повтор, даже если вызовы были (J-8) · хвост M1: скачок часов на 2 ч —
// повтор один, не удвоен · хвост M1: событие ушло кадром, а delivered не пришёл — отдаётся снова явно · A3.11 эпизод
// закрылся по тишине без переходника — episode_closed при подключении, итог записан · A3.20 реплай агента ·
// stg deferred retry — через сокет шлюза (хвост M1).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { silentAgentNotice, type Update } from 'stg-core';
import { FakeChannel } from 'stg-fake-channel';
import { DEFERRED_LINE_RE, assertNoLoss, connectAdapter, count, meta, pump, q1, readJournal, runCli, shiftClockFile, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, botTexts, receiptCounts, recorded, setup, type Setup } from './m1-common.js';

function helpers(s: () => Setup) {
  const seqOf = (u: Update): number | undefined => q1<{ seq: number }>(s().home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
  return {
    seqOf,
    send: async (text: string): Promise<number> => {
      const u = s().fake.builder.text(OWNER, text);
      s().fake.push(u);
      return waitUntil(() => seqOf(u), 5000, `приёма «${text}»`);
    },
    status: (seq: number): string | undefined => q1<{ status: string }>(s().home, 'SELECT status FROM events WHERE seq = ?', seq)?.status,
  };
}

/** Срок повтора (redeliver_after_minutes = 10) и один такт аренды сверху. */
async function term(gw: GatewayProcess): Promise<void> {
  await gw.advance('10m');
  await gw.advance('15s');
  await sleep(150);
}

describe('M3 · повтор отданного (К-5)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  const h = helpers(() => s);
  const frames = (seq: number) => ch.events().filter((e) => e.seq === seq);
  const silentLines = (seq: number): number => botTexts(s.fake).filter((t) => t === silentAgentNotice([seq])).length;
  before(async () => {
    s = await setup();
    gw = await s.start();
    ch = (await connectAdapter(s.home)).ch;
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('A3.6: отдано, ни ответа, ни done 10 минут, вызовов не было — один повтор с redelivery; ещё через 10 минут — строка владельцу', async () => {
    const sq = await h.send('позвони в банк');
    await ch.waitEvent(sq);
    await ch.delivered(sq);
    // Срок и снизу: до 10 минут повтора нет.
    await gw.advance('9m');
    await gw.advance('15s');
    await sleep(150);
    assert.equal(frames(sq).length, 1, 'повтор раньше 10 минут');
    await gw.advance('1m');
    await gw.advance('15s');
    await waitUntil(() => frames(sq).length === 2 || null, 5000, 'повтора');
    assert.deepEqual(frames(sq).map((e) => e.redelivery), [false, true]);
    assert.equal(silentLines(sq), 0, 'строки ещё нет');
    // И строке владельцу — не раньше срока после повтора.
    await gw.advance('9m');
    await sleep(150);
    assert.equal(silentLines(sq), 0, 'строка раньше срока');
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM outbox WHERE text = ?', silentAgentNotice([sq])), 0);
    await gw.advance('1m');
    await gw.advance('15s');
    await pump(gw, () => silentLines(sq) === 1 || null, { what: 'строки владельцу' });
    assert.equal(silentAgentNotice([sq]), `⚙ Агент на связи, но не ответил на № ${sq} — отдал его ещё раз, ответа нет. Сообщение сохранено`);
    for (let i = 0; i < 3; i++) await term(gw);
    assert.equal(frames(sq).length, 2, 'повтор — один');
    assert.equal(silentLines(sq), 1, 'строка — одна');
    assert.equal(h.status(sq), 'delivered');
    await ch.done([sq]);
  });

  it('A3.6а: то же, но был вызов where() — повтор отложен; строка владельцу — после второго срока', async () => {
    const sq = await h.send('собери список покупок');
    await ch.waitEvent(sq);
    await ch.delivered(sq);
    await ch.where();
    await term(gw);
    await sleep(100);
    assert.equal(frames(sq).length, 1, 'повтор отложен');
    assert.ok(gw.journal().some((l) => l.ev === 'redelivery_postponed' && l.seq === sq));
    await term(gw);
    await waitUntil(() => frames(sq).length === 2 || null, 5000, 'повтора после второго срока');
    assert.equal(silentLines(sq), 0);
    await term(gw);
    await pump(gw, () => silentLines(sq) === 1 || null, { what: 'строки владельцу' });
    await ch.done([sq]);
  });

  it('A3.6б (J-8): вызовы в каждом окне — повтор откладывается не больше 3 раз подряд, затем отдаётся снова с redelivery; после повтора так же — затем строка владельцу', async () => {
    const sq = await h.send('пропущенное моделью');
    await ch.waitEvent(sq);
    await ch.delivered(sq);
    const postponed = (): number => gw.journal().filter((l) => l.ev === 'redelivery_postponed' && l.seq === sq).length;
    // Сессия работает (вызывает инструменты), а событие модель пропустила: три срока — откладывания, повтора нет.
    for (let i = 1; i <= 3; i++) {
      await ch.where();
      await term(gw);
      await waitUntil(() => postponed() === i || null, 5000, `откладывания ${i}`);
      assert.equal(frames(sq).length, 1, `после ${i} откладываний повтора ещё нет`);
    }
    // Четвёртый срок — предел: повтор, хотя вызов был.
    await ch.where();
    await term(gw);
    await waitUntil(() => frames(sq).length === 2 || null, 5000, 'повтора после трёх откладываний');
    assert.deepEqual(frames(sq).map((e) => e.redelivery), [false, true]);
    assert.equal(postponed(), 3, 'четвёртого откладывания нет');
    const rd = gw.journal().find((l) => l.ev === 'redelivered' && l.seq === sq);
    assert.deepEqual([rd?.postponed, rd?.despite_calls], [3, true]);
    // После повтора — счёт заново: ещё три откладывания, затем строка владельцу.
    for (let i = 4; i <= 6; i++) {
      await ch.where();
      await term(gw);
      await waitUntil(() => postponed() === i || null, 5000, `откладывания ${i}`);
      assert.equal(silentLines(sq), 0, 'строки ещё нет');
    }
    await ch.where();
    await term(gw);
    await pump(gw, () => silentLines(sq) === 1 || null, { what: 'строки владельцу' });
    const silent = gw.journal().find((l) => l.ev === 'agent_silent' && l.seq === sq);
    assert.deepEqual([silent?.postponed, silent?.despite_calls], [3, true]);
    for (let i = 0; i < 2; i++) await term(gw);
    assert.equal(frames(sq).length, 2, 'повтор — один');
    assert.equal(silentLines(sq), 1, 'строка — одна');
    await ch.done([sq]);
  });

  it('A3.3 на подделке: reply(seq) без done — через 10 и 20 минут повтора нет; задержки t_admit ≤ t_delivered ≤ t_eyes, t_reply_sent', async () => {
    const { turn } = { turn: ch.currentTurn() ?? 0 };
    const sq = await h.send('ответь сразу');
    await ch.waitEvent(sq);
    await ch.delivered(sq);
    // delivered — агент увидел: 👀 на сообщении (0.3.2), t_eyes — когда он встал.
    await pump(gw, () => q1(s.home, "SELECT 1 FROM reactions r JOIN latency l ON l.event_seq = r.event_seq WHERE r.event_seq = ? AND r.shown = '👀' AND l.t_eyes IS NOT NULL", sq) || null, { what: '👀' });
    const r = await ch.reply(sq, 'Готово', turn);
    assert.ok(r.type === 'ack' && r.result === 'queued');
    await term(gw);
    await term(gw);
    assert.equal(frames(sq).length, 1);
    assert.equal(h.status(sq), 'processed');
    // Ш-16, §6: журнал задержек ведёт и отдачу, и ответ.
    const lat = q1<{ t_admit: number | null; t_eyes: number | null; t_delivered: number | null; t_reply_sent: number | null }>(
      s.home,
      'SELECT t_admit, t_eyes, t_delivered, t_reply_sent FROM latency WHERE event_seq = ?',
      sq,
    )!;
    assert.ok(lat.t_admit !== null && lat.t_eyes !== null && lat.t_delivered !== null && lat.t_reply_sent !== null, JSON.stringify(lat));
    assert.ok(lat.t_admit <= lat.t_delivered && lat.t_delivered <= lat.t_eyes && lat.t_delivered <= lat.t_reply_sent, JSON.stringify(lat));
  });

  it('ключ повтора (idem): тот же reply после обрыва — второй строки нет, исход тот же; ответ ушёл один раз', async () => {
    const sq = await h.send('ответь один раз');
    await ch.waitEvent(sq);
    const turn = ch.currentTurn()!;
    const once = { seq: sq, text: 'Один раз', voice: false, turn, idem: 'k-once-1' };
    const a = await ch.request('reply', once);
    assert.ok(a.type === 'ack' && a.result === 'queued', JSON.stringify(a));
    const b = await ch.request('reply', once);
    assert.ok(b.type === 'ack' && b.result === 'queued', JSON.stringify(b));
    assert.equal(count(s.home, "SELECT count(*) AS n FROM outbox WHERE text = 'Один раз'"), 1);
    await pump(gw, () => botTexts(s.fake).includes('Один раз') || null, { what: 'ответа' });
    for (let i = 0; i < 3; i++) await gw.advance('2s');
    assert.equal(botTexts(s.fake).filter((t) => t === 'Один раз').length, 1);
    assert.ok(gw.journal().some((l) => l.ev === 'reply_repeated' && l.seq === sq));
    // Без ключа (и с другим) — обычный повторный ответ: уходит (5.10 «повторный reply допустим»).
    const c = await ch.request('reply', { ...once, idem: 'k-once-2' });
    assert.ok(c.type === 'ack' && c.result === 'queued');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM outbox WHERE text = 'Один раз'"), 2);
    const bad = await ch.request('reply', { ...once, idem: 'с пробелом и кириллицей' });
    assert.ok(bad.type === 'error' && bad.code === 'bad_request', JSON.stringify(bad));
  });

  it('хвост M1 (A1.19 → A3.6): скачок часов на 2 часа при отданном событии — повтор ровно один, строка — через срок, одна', async () => {
    const sq = await h.send('перед сном');
    await ch.waitEvent(sq);
    await ch.delivered(sq);
    await gw.jump('2h');
    await gw.waitForJournal((l) => l.ev === 'wake');
    await waitUntil(() => frames(sq).length === 2 || null, 5000, 'повтора после сна');
    await sleep(300);
    assert.equal(frames(sq).length, 2, 'повтор не удвоен');
    assert.equal(readJournal(s.home).filter((l) => l.ev === 'redelivered' && l.seq === sq).length, 1);
    assert.equal(silentLines(sq), 0, 'строки сразу после сна нет');
    await term(gw);
    await pump(gw, () => silentLines(sq) === 1 || null, { what: 'строки владельцу' });
    await term(gw);
    assert.equal(frames(sq).length, 2);
    assert.equal(silentLines(sq), 1);
    await ch.done([sq]);
  });

  it('хвост M1: событие ушло кадром, а delivered не пришёл — через срок отдаётся снова явно (курсор аренды его не возьмёт)', async () => {
    const sq = await h.send('канал не толкнул');
    await ch.waitEvent(sq);
    assert.equal(h.status(sq), 'new');
    await term(gw);
    await waitUntil(() => frames(sq).length === 2 || null, 5000, 'повтора');
    assert.equal(frames(sq)[1]!.redelivery, true);
    await ch.delivered(sq);
    assert.equal(h.status(sq), 'delivered');
    await ch.done([sq]);
  });
});

describe('M3 · A3.11 итог без переходника, A3.20 реплай агента', () => {
  let s: Setup;
  let gw: GatewayProcess;
  const h = helpers(() => s);
  before(async () => {
    s = await setup();
    gw = await s.start();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('A3.11: эпизод закрылся по тишине, пока переходника нет — при подключении episode_closed отдан; итог записан', async () => {
    const sq = await h.send('про отпуск');
    const ep = q1<{ episode_id: number }>(s.home, 'SELECT episode_id FROM events WHERE seq = ?', sq)!.episode_id;
    await gw.advance('34m');
    await gw.advance('1m');
    await waitUntil(() => q1(s.home, "SELECT 1 FROM episodes WHERE id = ? AND close_reason = 'idle'", ep), 5000, 'закрытия по тишине');
    const closedSeq = q1<{ seq: number }>(s.home, "SELECT seq FROM events WHERE kind = 'episode_closed' AND episode_id = ?", ep)!.seq;
    const { ch } = await connectAdapter(s.home);
    try {
      const ev = await ch.waitEvent(closedSeq);
      assert.equal(ev.kind, 'episode_closed');
      assert.deepEqual({ id: ev.episode?.id, close_reason: ev.episode?.close_reason }, { id: ep, close_reason: 'idle' });
      assert.deepEqual(ch.events().map((e) => e.seq), [sq, closedSeq], 'по порядку №');
      await ch.done([sq]);
      const r = await ch.episodeSummary(ep, 'Обсудили отпуск');
      assert.equal(r.type, 'ack');
      assert.deepEqual({ ...q1<object>(s.home, 'SELECT summary, summary_trust FROM episodes WHERE id = ?', ep) }, { summary: 'Обсудили отпуск', summary_trust: 'owner' });
      assert.equal(h.status(closedSeq), 'processed');
    } finally {
      ch.close();
    }
  });

  it('A3.20: на последнее сообщение — без reply_parameters; на раннее — реплаем; у длинного реплаем только первая часть', async () => {
    const a = await h.send('первое');
    const b = await h.send('второе');
    const { ch, turn } = await connectAdapter(s.home);
    try {
      await ch.waitEvent(b);
      const msgId = (seq: number): number => q1<{ message_id: number }>(s.home, 'SELECT message_id FROM events WHERE seq = ?', seq)!.message_id;
      await ch.reply(b, 'на второе', turn);
      const last = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text === 'на второе'), { what: 'ответа на последнее' });
      assert.equal(last.reply_parameters, null, 'на последнее — без реплая');
      await ch.reply(a, 'на первое', turn);
      const early = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text === 'на первое'), { what: 'ответа на раннее' });
      assert.deepEqual(early.reply_parameters, { message_id: msgId(a), allow_sending_without_reply: true });
      await ch.reply(a, 'длинно. '.repeat(1200), turn);
      await pump(gw, () => count(s.home, "SELECT count(*) AS n FROM outbox WHERE kind = 'agent' AND status = 'sent'") === 3 || null, { what: 'длинного ответа' });
      const parts = s.fake.sentTo(OWNER.id).filter((m) => m.text?.startsWith('(') && m.text.includes('длинно.'));
      assert.ok(parts.length >= 2, `частей ${parts.length}`);
      assert.deepEqual(parts[0]!.reply_parameters, { message_id: msgId(a), allow_sending_without_reply: true });
      assert.ok(parts.slice(1).every((p) => p.reply_parameters === null), 'остальные части — не реплаем');
    } finally {
      ch.close();
    }
  });
});

describe('M3 · stg deferred retry — через сокет шлюза (хвост M1)', () => {
  let s: Setup;
  let gw: GatewayProcess | null = null;
  let bad = 0;
  before(async () => {
    s = await setup();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  /** Три падения на обновлении — отложено (как A1.10). */
  async function deferOn(updateId: number): Promise<void> {
    for (let run = 1; ; run++) {
      const g = s.spawn({ STG_FAULT: `in_handler:${updateId}` });
      const r = await Promise.race([
        g.exited.then(() => 'exit' as const),
        waitUntil(() => q1(s.home, "SELECT 1 FROM updates WHERE update_id = ? AND status = 'deferred'", updateId), 20_000, 'отложенного').then(() => 'deferred' as const),
      ]);
      if (r === 'deferred') {
        await g.stop();
        return;
      }
      if (run >= 5) throw new Error('не отложил за 5 запусков');
      shiftClockFile(s.home, 61_000);
    }
  }

  it('отложенное повторяется по stg deferred retry: принято событием, квитанция ушла, offset не тронут; повторно — отказ', async () => {
    bad = s.fake.push(s.fake.builder.text(OWNER, 'на этом шлюз падал'))[0]!.update_id;
    await deferOn(bad);
    const off = await runCli(['deferred', 'retry', String(bad)], s.env);
    assert.equal(off.code, 1);
    assert.match(off.stdout, /шлюз не отвечает/);
    gw = await s.start();
    const next = s.fake.push(s.fake.builder.text(OWNER, 'после отложенного'))[0]!;
    await waitUntil(() => q1(s.home, "SELECT 1 FROM updates WHERE update_id = ? AND status = 'admitted'", next.update_id), 5000, 'приёма следующего');
    const offset = meta(s.home, 'offset');
    const r = await runCli(['deferred', 'retry', String(bad)], s.env);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const seq = q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', bad)!.seq;
    assert.equal(r.stdout.trim(), `обновление ${bad} принято: № ${seq}`);
    assert.equal(q1<{ status: string; raw_json: string | null }>(s.home, 'SELECT status, raw_json FROM updates WHERE update_id = ?', bad)!.status, 'admitted');
    assert.equal(meta(s.home, 'offset'), offset, 'offset не тронут');
    // «Записал» — COMMIT (галочки Telegram); текстовой квитанции нет.
    await pump(gw, () => recorded(s, s.fake.history.get(bad)!) || null, { what: 'записи' });
    assert.equal(receiptCounts(s.fake).get(seq), undefined, 'текстовой квитанции нет');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'deferred_retried' && l.update_id === bad));
    const again = await runCli(['deferred', 'retry', String(bad)], s.env);
    assert.equal(again.code, 1);
    assert.match(again.stdout, /не отложено/);
    const none = await runCli(['deferred', 'retry', '99999999'], s.env);
    assert.equal(none.code, 1);
    assert.match(none.stdout, /нет/);
    const word = await runCli(['deferred', 'retry', 'abc'], s.env);
    assert.equal(word.code, 2);
    // Переходник (не CLI) повтор не просит.
    const { ch } = await connectAdapter(s.home);
    try {
      const x = await ch.request('deferred_retry', { update_id: bad });
      assert.ok(x.type === 'error' && x.code === 'bad_request', JSON.stringify(x));
    } finally {
      ch.close();
    }
  });

  it('повтор отложенного, на котором шлюз падает снова, — шлюз упал; после старта — снова отложено со строкой владельцу', async () => {
    await gw!.stop();
    const id = s.fake.push(s.fake.builder.text(OWNER, 'и на этом падает'))[0]!.update_id;
    await deferOn(id);
    const linesBefore = botTexts(s.fake).filter((t) => DEFERRED_LINE_RE.test(t)).length;
    gw = await s.start({ STG_FAULT: `in_handler:${id}` });
    const later = s.fake.push(s.fake.builder.text(OWNER, 'новое до повтора'))[0]!;
    await waitUntil(() => q1(s.home, "SELECT 1 FROM updates WHERE update_id = ? AND status = 'admitted'", later.update_id), 5000, 'приёма нового');
    const offset = meta(s.home, 'offset');
    const r = await runCli(['deferred', 'retry', String(id)], s.env);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /закрыл соединение/);
    await gw.waitForExit();
    shiftClockFile(s.home, 61_000);
    gw = await s.start();
    await waitUntil(() => q1(s.home, "SELECT 1 FROM updates WHERE update_id = ? AND status = 'deferred'", id), 5000, 'отложенного снова');
    assert.equal(meta(s.home, 'offset'), offset, 'offset не ушёл назад к номеру повторённого');
    assert.equal(meta(s.home, 'deferred_retrying'), null);
    await pump(gw, () => botTexts(s.fake).filter((t) => DEFERRED_LINE_RE.test(t)).length > linesBefore || null, { what: 'строки об отложенном' });
    await gw.stop();
    assertNoLoss(s.fake, s.home);
  });
});
