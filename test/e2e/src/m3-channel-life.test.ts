// M3 · жизнь канала под поддельным Claude Code (сроки канала ужаты: STG_TEST_CHANNEL_TIME_SCALE = 0.1; сроки шлюза —
// поддельные часы):
// A3.14 перезапуск шлюза посреди сессии — канал (тот же процесс, та же сессия) переподключился без пробы (0.3.2, R-4 а),
// отданное без processed не пришло снова сразу — только по сроку повтора К-5, с redelivery ·
// A3.7 / A3.13 Claude Code закрылся — канал вышел, аренда снята, отданное остаётся за процессом (0.3.2), новая сессия —
// проба, и отданное приходит ей снова; канал завис — аренда свободна ≤ 60 с · A3.4 / A3.15 вторая сессия — busy, «очередь держит другая сессия (с ЧЧ:ММ)»; первая закрылась — вторая
// получила аренду ≤ 30 с · A3.5 через инструмент — done на событие другой аренды: отказ словами, статус прежний ·
// A3.16 на подделке — сессия «без флага» (на probe никто не отвечает): unverified, ничего не delivered, stg status
// говорит «сессия открыта без канала»; затем сессия «с флагом» — всё по порядку · шлюза нет — «шлюз недоступен».

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BUSY_RETRY_MS, CHANNEL_UNVERIFIED_HINT, localTime, type Update } from 'stg-core';
import { FakeClaude } from './fake-claude.js';
import { count, meta, pump, q1, readJournal, runCli, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, setup, type Setup } from './m1-common.js';

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

describe('M3 · канал: перезапуск шлюза (A3.14), закрытый и зависший Claude Code (A3.7, A3.13)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  const h = helpers(() => s);
  const open: FakeClaude[] = [];
  before(async () => {
    s = await setup();
    gw = await s.start();
  });
  after(async () => {
    for (const f of open) await f.close().catch(() => undefined);
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('A3.14: перезапуск шлюза посреди сессии — канал переподключился без пробы (та же сессия); отданное не пришло снова сразу, а по сроку повтора — с redelivery', async () => {
    const fc = await FakeClaude.start(s.home);
    open.push(fc);
    await fc.waitVerified();
    const sq = await h.send('посчитай расходы за неделю');
    const first = await fc.waitEvent(sq);
    assert.equal(first.meta.redelivery, 'false');
    await waitUntil(() => h.status(sq) === 'delivered', 5000, 'delivered');
    await gw.stop();
    gw = await s.start();
    // Канал сам переподключается (пауза 1…30 с, здесь ужата) тем же процессом с прежней арендой — та же сессия: пробы
    // нет (хода модели нет), отданное остаётся за ним и сразу снова не приходит (0.3.2, R-4 а).
    const start = await gw.waitForJournal((l) => l.ev === 'start' && Number(l.pid) === gw.pid);
    assert.equal(start.kept_for_session, 1);
    const ver = await gw.waitForJournal((l) => l.ev === 'lease_verified' && l.reason === 'same_instance', 10_000);
    assert.equal(ver.after_ms, 0);
    for (let i = 0; i < 3; i++) await gw.advance('1s');
    await sleep(100);
    assert.equal(fc.probes().length, 1, 'второй пробы нет');
    assert.equal(fc.events().filter((n) => n.meta.seq === String(sq)).length, 1, 'сразу не повторено');
    // Ответа нет 10 минут — повтор К-5, как всегда.
    await gw.advance('11m');
    const again = await fc.waitNotice((n) => n.meta.seq === String(sq) && n.meta.redelivery === 'true', 10_000, 'повтора по сроку');
    assert.match(again.content, /повтор: проверь, не сделано ли уже/);
    assert.equal(fc.events().filter((n) => n.meta.seq === String(sq)).length, 2);
    assert.deepEqual(await fc.call('reply', { seq: sq, text: 'За неделю — 12 400 ₽' }), { text: 'отправлено', isError: false });
    assert.equal(h.status(sq), 'processed');
  });

  it('A3.7 и A3.13: Claude Code закрылся посреди хода — канал вышел, аренда снята, отданное без processed остаётся за процессом; новая сессия — проба, и отданное приходит ей снова', async () => {
    const fc = open[0]!;
    const sq = await h.send('напомни завтра про врача');
    await fc.waitEvent(sq);
    await waitUntil(() => h.status(sq) === 'delivered', 5000, 'delivered');
    const exited = new Promise<void>((r) => fc.transport.onclose = () => r());
    const pid = fc.pid!;
    await fc.close();
    await exited;
    assert.throws(() => process.kill(pid, 0), 'процесс канала завершился');
    const rel = await gw.waitForJournal((l) => l.ev === 'lease_released' && l.reason === 'closed');
    assert.equal(rel.kept_for_session, 1, 'отданное остаётся за процессом (0.3.2): вдруг тот же процесс переподключится');
    assert.equal(h.status(sq), 'delivered');
    // Новый Claude Code — новый процесс канала (другой instance_id): проба; отданное прежнему — снова new и отдано ему.
    const fc2 = await FakeClaude.start(s.home);
    open.push(fc2);
    await fc2.waitVerified();
    assert.equal(gw.journal().filter((l) => l.ev === 'lease_granted').pop()!.probe_reason, 'new_instance');
    const n = await fc2.waitEvent(sq);
    assert.equal(n.meta.redelivery, 'true');
    assert.equal((await fc2.call('done', { seqs: [sq] })).isError, false);
  });

  it('A3.13: канал завис (SIGSTOP) — шлюз снял аренду ≤ 60 с без pong; новая сессия её получает', async () => {
    const fc = open[1]!;
    const sq = await h.send('ещё одно');
    await fc.waitEvent(sq);
    await waitUntil(() => h.status(sq) === 'delivered', 5000, 'delivered');
    process.kill(fc.pid!, 'SIGSTOP');
    try {
      const t0 = await gw.advance('0s');
      // Шаги по 15 с поддельного времени и по полсекунды настоящего (срок pong — не раньше 1 с настоящего времени,
      // adapter.ts): pong от замершего канала не придёт.
      let lost = null as null | { at: string };
      for (let i = 0; i < 8 && !lost; i++) {
        await gw.advance('15s');
        await sleep(500);
        lost = (gw.journal().find((l) => l.ev === 'lease_lost' && l.reason === 'no_pong') as { at: string } | undefined) ?? null;
      }
      assert.ok(lost, 'аренда не снята');
      assert.ok(Date.parse(lost.at) - t0 <= 60_000, `снята через ${(Date.parse(lost.at) - t0) / 1000} с`);
      // Отданное остаётся за замершим процессом (0.3.2): оживёт и переподключится — та же сессия; придёт другой — ему снова.
      assert.equal(h.status(sq), 'delivered');
      const fc3 = await FakeClaude.start(s.home);
      open.push(fc3);
      await fc3.waitVerified();
      const n = await fc3.waitEvent(sq);
      assert.equal(n.meta.redelivery, 'true');
      assert.equal((await fc3.call('done', { seqs: [sq] })).isError, false);
    } finally {
      process.kill(fc.pid!, 'SIGCONT');
    }
    // Ожившая сессия переподключается, но аренду не отбирает: у неё busy.
    await waitUntil(() => fc.stderr.includes('состояние: busy') || null, 10_000, 'busy у ожившей сессии');
    const last = readJournal(s.home).filter((l) => l.ev === 'lease_verified').pop()!;
    assert.equal(last.lease, readJournal(s.home).filter((l) => l.ev === 'lease_granted').pop()!.lease, 'аренда — у новой сессии');
  });
});

describe('M3 · busy: вторая сессия (A3.4, A3.15), done чужого события через инструмент (A3.5)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  const h = helpers(() => s);
  let a: FakeClaude;
  let b: FakeClaude;
  before(async () => {
    s = await setup();
    gw = await s.start();
  });
  after(async () => {
    await a?.close().catch(() => undefined);
    await b?.close().catch(() => undefined);
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('A3.4: вторая сессия при занятой аренде — busy; инструмент: «очередь держит другая сессия (с ЧЧ:ММ)»; ей ничего не отдаётся', async () => {
    a = await FakeClaude.start(s.home);
    await a.waitVerified();
    const since = Date.parse(gw.journal().filter((l) => l.ev === 'lease_granted').pop()!.at);
    b = await FakeClaude.start(s.home);
    await waitUntil(() => b.stderr.includes('состояние: busy') || null, 5000, 'busy у второй');
    const sq = await h.send('для первой сессии');
    await a.waitEvent(sq);
    const r = await b.call('reply', { seq: sq, text: 'я вторая' });
    assert.equal(r.isError, true);
    const tz = 'America/Los_Angeles';
    assert.equal(r.text, `очередь держит другая сессия (с ${localTime(since, tz)})`);
    assert.equal(b.notices.length, 0, 'второй ничего не отдано — даже пробы');
    assert.equal((await a.call('reply', { seq: sq, text: 'ответила первая' })).text, 'отправлено');
  });

  it('A3.15 и A3.5: первая закрылась — вторая получила аренду ≤ 30 с; done на событие другой аренды — отказ словами, статус прежний', async () => {
    const sq = q1<{ seq: number }>(s.home, "SELECT seq FROM events WHERE text = 'для первой сессии'")!.seq;
    const t0 = Date.now();
    await a.close();
    await b.waitVerified(10_000);
    const waited = Date.now() - t0;
    // Повтор hello — через 30 с, здесь ужато в 10 раз: ≤ 3 с с запасом на запуск.
    assert.ok(waited <= BUSY_RETRY_MS * 0.1 + 2000, `вторая получила аренду через ${waited} мс`);
    const r = await b.call('done', { seqs: [sq] });
    assert.deepEqual(r, { text: `не отмечено: № ${sq} отдан не этой сессии`, isError: true });
    assert.deepEqual({ ...q1<{ status: string; processed_silent: number }>(s.home, 'SELECT status, processed_silent FROM events WHERE seq = ?', sq) }, { status: 'processed', processed_silent: 0 });
  });
});

describe('M3 · сессия без флага канала (A3.16 на подделке), шлюза нет', () => {
  let s: Setup;
  let gw: GatewayProcess | null = null;
  const h = helpers(() => s);
  const open: FakeClaude[] = [];
  before(async () => {
    s = await setup();
  });
  after(async () => {
    for (const f of open) await f.close().catch(() => undefined);
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('шлюза нет: инструменты — «шлюз недоступен — повтори позже»; шлюз поднялся — канал подключился сам', async () => {
    const fc = await FakeClaude.start(s.home);
    open.push(fc);
    await sleep(300);
    assert.deepEqual(await fc.call('where'), { text: 'шлюз недоступен — повтори позже', isError: true });
    assert.deepEqual((await fc.call('reply', { text: 'привет' })).text, 'шлюз недоступен — повтори позже');
    gw = await s.start();
    await fc.waitVerified(15_000);
    const w = await fc.call('where');
    assert.ok(w.text.startsWith('⚙ Где мы'), w.text);
    await fc.close();
    open.length = 0;
    await gw.waitForJournal((l) => l.ev === 'lease_released');
  });

  it('A3.16: сессия «без флага» — проба без ответа: unverified, ни одно событие не delivered; stg status — «сессия открыта без канала»; сессия «с флагом» — всё по порядку', async () => {
    const g = gw!;
    const waiting = [await h.send('раз'), await h.send('два'), await h.send('три')];
    const flagless = await FakeClaude.start(s.home, { autoProbe: false });
    open.push(flagless);
    await waitUntil(() => flagless.probes().length === 1 || null, 5000, 'пробы');
    // Пока проба без ответа, событий нет.
    await g.advance('60s');
    await sleep(1100);
    assert.equal(flagless.events().length, 0);
    await g.advance('61s');
    await sleep(1100);
    await g.advance('15s');
    await g.waitForJournal((l) => l.ev === 'lease_unverified');
    await waitUntil(() => flagless.stderr.includes('состояние: unverified') || null, 5000, 'unverified у канала');
    assert.equal(count(s.home, `SELECT count(*) AS n FROM events WHERE seq IN (${waiting.join(',')}) AND status <> 'new'`), 0, 'ни одно не delivered');
    assert.ok(meta(s.home, 'channel_unverified'));
    const st = await runCli(['status'], s.env);
    assert.ok(st.stdout.includes(CHANNEL_UNVERIFIED_HINT), st.stdout);
    // Модель всё же вызвала инструмент: отказ словами и новая попытка (придёт новая проба).
    const r = await flagless.call('reply', { text: 'я тут' });
    assert.equal(r.isError, true);
    assert.match(r.text, /сессия открыта без канала/);
    await waitUntil(() => flagless.probes().length === 2 || null, 5000, 'новой пробы');
    // Сессия «с флагом» вытесняет предварительную аренду и получает всё по порядку.
    const good = await FakeClaude.start(s.home);
    open.push(good);
    await good.waitVerified();
    for (const sq of waiting) await good.waitEvent(sq);
    assert.deepEqual(good.events().map((n) => Number(n.meta.seq)), waiting);
    assert.equal(meta(s.home, 'channel_unverified'), null, 'отметка снята');
    assert.ok(g.journal().some((l) => l.ev === 'lease_released' && l.reason === 'displaced'));
    const st2 = await runCli(['status'], s.env);
    assert.ok(!st2.stdout.includes(CHANNEL_UNVERIFIED_HINT), st2.stdout);
    assert.ok(st2.stdout.includes('переходник: на связи'), st2.stdout);
    await good.call('done', { seqs: waiting });
    await pump(g, () => true);
  });
});
