// Сбои сети и сервера (5.3, 5.5): 5xx и обрыв опроса — повтор с паузой 1…30 с, ничего не потеряно; 5xx и обрыв
// отправки — повтор по next_try_at; 404 отправки (токен, адрес) — повтор через 60 с, а не «бросить» (обрыв, 502 и 400 на
// реакции 👀 — m1-reactions-order). Отправка проверяется на ответе /help — строке шлюза через очередь отправки (запасной
// текстовой квитанции и строки с нижней клавиатурой, на которых это проверялось раньше, больше нет с 0.3.1);
// последнее обновление старше 7 дней — getUpdates без offset (и после старта, и без
// перезапуска); после недели тишины Telegram начал номера заново — первое новое от незнакомого и отложенное не сдвигают
// offset «только вперёд», следующее сообщение владельца принято (A1.3). Одна испорченная строка outbox не держит
// очередь. CLI на чтение: stg status, stg deferred list, stg log tail.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { errors, reply } from 'stg-fake-telegram';
import { DEFERRED_LINE_RE, assertNoLoss, count, meta, pump, q1, readJournal, runCli, shiftClockFile, sleep, waitUntil } from './harness.js';
import { OWNER, STRANGER, botTexts, setup, type Setup } from './m1-common.js';

/** Ответ /help — строка шлюза через очередь отправки. */
const HELP_HEAD = '⚙ Как устроен чат';
const helpLine = (p: Record<string, unknown>): boolean => String(p.text).startsWith(HELP_HEAD);
const isHelp = (t: string): boolean => t.startsWith(HELP_HEAD);

describe('5xx и обрыв', () => {
  let s: Setup;
  after(() => s?.close());

  it('опрос: 502, 503 и обрыв — паузы 1, 2, 4 с; затем приём; отправка: 502 и обрыв — повтор по next_try_at', async () => {
    s = await setup();
    s.fake.scenario({ method: 'getUpdates', nth: 1, reply: errors.serverError(502) });
    s.fake.scenario({ method: 'getUpdates', nth: 2, reply: errors.serverError(503) });
    s.fake.scenario({ method: 'getUpdates', nth: 3, reply: reply.drop() });
    s.fake.scenario({ method: 'sendMessage', when: helpLine, times: 1, reply: errors.serverError(502) });
    s.fake.scenario({ method: 'sendMessage', when: helpLine, times: 1, reply: reply.drop() });
    const [u] = s.fake.push(s.fake.builder.text(OWNER, 'сквозь сбои'), s.fake.builder.command(OWNER, '/help'));
    const gw = await s.start();
    for (const [n, wait] of [
      [1, 1000],
      [2, 2000],
      [3, 4000],
    ] as const) {
      const l = await waitUntil(() => readJournal(s.home).filter((y) => y.ev === 'poll_error')[n - 1], 5000, `${n}-го сбоя опроса`);
      assert.equal(l.retry_ms, wait, `пауза после ${n}-го сбоя`);
      const calls = s.fake.callsOf('getUpdates').length;
      await gw.advance(`${wait - 100}ms`);
      await sleep(100);
      assert.equal(s.fake.callsOf('getUpdates').length, calls, 'раньше паузы не опрашивает');
      await gw.advance('100ms');
      await s.fake.waitForCall((c) => c.method === 'getUpdates' && c.nth === calls + 1, 5000);
    }
    assert.equal(readJournal(s.home).filter((l) => l.ev === 'poll_error' && l.network === true).length, 1, 'обрыв — ошибка сети');
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', u!.update_id) === 1, 5000, 'приёма');
    await pump(gw, () => botTexts(s.fake).some(isHelp) || null, { what: 'ответа /help после 502 и обрыва' });
    assert.equal(readJournal(s.home).filter((l) => l.ev === 'send_deferred').length, 2);
    assert.equal(botTexts(s.fake).filter(isHelp).length, 1);
    await gw.stop();
    assertNoLoss(s.fake, s.home);
  });
});

describe('отправка: 404, испорченная строка', () => {
  it('404 на sendMessage (токен, адрес) — повтор через 60 с, строка не брошена', async () => {
    const r = await setup();
    try {
      const receiptCall = helpLine;
      r.fake.scenario({ method: 'sendMessage', when: receiptCall, times: 1, reply: errors.notFound() });
      const gw = await r.start();
      r.fake.push(r.fake.builder.command(OWNER, '/help'));
      // Перед ней в чат уходит закреплённая строка (шаг 1 с в чат) — часы двигаются мелко, отсчёт — от 404.
      const def = await pump(gw, () => readJournal(r.home).find((l) => l.ev === 'send_deferred'), { step: '100ms', what: 'отложенной отправки' });
      assert.match(String(def.reason), /404/);
      const gap = Number(def.next_try_at) - Date.parse(def.at);
      assert.ok(gap > 59_000 && gap <= 60_000, `повтор через 60 с, а не через ${gap} мс`);
      const now = await gw.advance('1ms');
      await gw.advance(`${Number(def.next_try_at) - 1_000 - now}ms`);
      await sleep(200);
      assert.equal(r.fake.callsOf('sendMessage').filter((c) => receiptCall(c.params)).length, 1, 'раньше 60 с — не повторяет');
      await pump(gw, () => botTexts(r.fake).some(isHelp) || null, { what: 'строки после 404' });
      assert.equal(count(r.home, "SELECT count(*) AS n FROM outbox WHERE status = 'dropped'"), 0);
      await gw.stop();
    } finally {
      await r.close();
    }
  });

  it('испорченная строка outbox не держит очередь: брошена с записью в журнал, следующие уходят', async () => {
    const r = await setup();
    try {
      const g0 = await r.start();
      const [u] = r.fake.push(r.fake.builder.text(OWNER, 'до поломки'));
      await pump(g0, () => r.fake.pins.some((p) => p.chat_id === OWNER.id) || null, { what: 'закреплённой строки' });
      await g0.stop();
      // Строка, на которой отправитель бросает исключение до отправки (tg_message_ids не JSON).
      const db = new DatabaseSync(r.home.paths.db);
      db.prepare(
        "INSERT INTO outbox(event_seq, chat_id, thread_id, kind, text, voice, turn, origin, status, attempts, tg_message_ids, created_at) VALUES (NULL, ?, NULL, 'service', '⚙ испорчено', 0, NULL, 'gateway', 'pending', 0, 'не json', 0)",
      ).run(OWNER.id);
      db.close();
      const gw = await r.start();
      const [v] = r.fake.push(r.fake.builder.command(OWNER, '/help'));
      await waitUntil(() => count(r.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', v!.update_id) === 1, 5000, 'приёма');
      await pump(gw, () => botTexts(r.fake).some((t) => t.startsWith('⚙ Как устроен чат')), { what: 'ответа /help за испорченной строкой' });
      assert.equal(count(r.home, "SELECT count(*) AS n FROM outbox WHERE status = 'dropped' AND text = '⚙ испорчено'"), 1);
      assert.ok(readJournal(r.home).some((l) => l.ev === 'sender_error'));
      assert.ok(!botTexts(r.fake).includes('⚙ испорчено'));
      void u;
      await gw.stop();
    } finally {
      await r.close();
    }
  });
});

describe('неделя тишины', () => {
  let s: Setup;
  after(() => s?.close());

  it('последнее обновление старше 7 дней — первый getUpdates без offset, дальше — с offset', async () => {
    s = await setup();
    const g1 = await s.start();
    const [u] = s.fake.push(s.fake.builder.text(OWNER, 'давно'));
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', u!.update_id) === 1, 5000, 'приёма');
    await g1.stop();
    const db = new DatabaseSync(s.home.paths.db);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'last_update_at'").run(String(Number(meta(s.home, 'last_update_at')) - 8 * 86_400_000));
    db.close();
    const n = s.fake.callsOf('getUpdates').length;
    const g2 = await s.start();
    await g2.waitForJournal((l) => l.ev === 'poll_without_offset');
    const first = await s.fake.waitForCall((c) => c.method === 'getUpdates' && c.nth === n + 1);
    assert.equal(first.params.offset, undefined, 'первый — без offset');
    s.fake.push(s.fake.builder.text(OWNER, 'после недели'));
    const second = await s.fake.waitForCall((c) => c.method === 'getUpdates' && c.nth === n + 2);
    assert.equal(typeof second.params.offset, 'number', 'дальше — с offset');
    await g2.stop();
    assertNoLoss(s.fake, s.home);
  });
});

describe('неделя тишины без перезапуска', () => {
  let s: Setup;
  after(() => s?.close());

  it('шлюз работал всю неделю — опрос после неё тоже без offset', async () => {
    s = await setup();
    const gw = await s.start();
    const [u] = s.fake.push(s.fake.builder.text(OWNER, 'перед тишиной'));
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', u!.update_id) === 1, 5000, 'приёма');
    await s.fake.waitForOffset(u!.update_id + 1);
    const n = s.fake.callsOf('getUpdates').length;
    await gw.jump('8d');
    await gw.waitForJournal((l) => l.ev === 'poll_without_offset');
    const c = await s.fake.waitForCall((x) => x.method === 'getUpdates' && x.nth > n && x.params.offset === undefined);
    assert.equal(c.params.offset, undefined);
    // Пришло новое — дальше снова с offset.
    const [v] = s.fake.push(s.fake.builder.text(OWNER, 'после тишины'));
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', v!.update_id) === 1, 5000, 'приёма');
    await s.fake.waitForOffset(v!.update_id + 1);
    await gw.stop();
  });
});

describe('A1.3 · после недели тишины Telegram начал номера заново', () => {
  let s: Setup;
  after(() => s?.close());

  it('новое первое — отложенное, затем незнакомый; offset ровно их номер + 1; следующее владельца принято', async () => {
    s = await setup();
    const g1 = await s.start();
    const [old] = s.fake.push(s.fake.builder.text(OWNER, 'неделю назад'));
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', old!.update_id) === 1, 5000, 'приёма');
    // Telegram узнал «получил» (следующий опрос с offset): иначе подделка выдаст старое ещё раз вперемешку с новыми
    // номерами — у настоящего Telegram так не бывает (неподтверждённое он держит 24 часа, а тишина — неделя).
    await s.fake.waitForOffset(old!.update_id + 1);
    await g1.stop();
    assert.equal(Number(meta(s.home, 'offset')), old!.update_id + 1);
    // Неделя тишины; новые номера — с 20.
    shiftClockFile(s.home, 8 * 86_400_000);
    const bad = { ...s.fake.builder.text(OWNER, 'на этом шлюз падает'), update_id: 20 };
    s.fake.push(bad);
    // Падает трижды — отложено; offset = 21, а не «максимум из виденных» (100001).
    let runs = 0;
    for (;;) {
      const g = s.spawn({ STG_FAULT: 'in_handler:20' });
      runs++;
      const done = await Promise.race([
        g.exited.then(() => 'exit' as const),
        waitUntil(() => q1(s.home, "SELECT 1 FROM updates WHERE update_id = 20 AND status = 'deferred'"), 20_000, 'отложенного').then(() => 'deferred' as const),
      ]);
      if (done === 'deferred') {
        assert.equal(meta(s.home, 'offset'), '21', 'offset после отложенного — ровно его номер + 1');
        // Новый незнакомый — 21: offset 22; затем владелец — 22: принят.
        s.fake.push({ ...s.fake.builder.text(STRANGER, 'спам с новым номером'), update_id: 21 });
        await waitUntil(() => q1(s.home, "SELECT 1 FROM updates WHERE update_id = 21 AND status = 'ignored'"), 5000, 'незнакомого');
        const dump = (e: Error): never => {
          throw new Error(
            `${e.message}; offset ${meta(s.home, 'offset')}; журнал: ${g.journal().slice(-15).map((l) => `${l.ev}:${String(l.update_id ?? l.error ?? '')}`).join(' ')}; опросы: ${s.fake
              .callsOf('getUpdates')
              .slice(-5)
              .map((c) => `${String(c.params.offset)}/${String(c.params.timeout)}/${c.outcome}/${JSON.stringify(c.updateIds ?? [])}`)
              .join(' ')}; очередь: ${s.fake.pending().map((u) => u.update_id).join(',')}`,
          );
        };
        await waitUntil(() => meta(s.home, 'offset') === '22' || null, 5000, 'offset 22').catch(dump);
        s.fake.push({ ...s.fake.builder.text(OWNER, 'после тишины'), update_id: 22 });
        await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = 22') === 1, 5000, 'приёма сообщения владельца').catch(dump);
        await pump(g, () => botTexts(s.fake).some((t) => DEFERRED_LINE_RE.test(t)), { what: 'строки об отложенном' });
        await g.stop();
        break;
      }
      assert.equal((await g.waitForExit()).code, 137, g.stderr);
      if (runs > 5) throw new Error('не отложил за 5 запусков');
      shiftClockFile(s.home, 61_000);
    }
    assert.equal(runs, 4);
    assert.equal(meta(s.home, 'offset'), '23');
  });
});

describe('Ш-2 · номера принятого — 24 часа', () => {
  let s: Setup;
  after(() => s?.close());

  it('admitted и ignored старше 24 ч вычищаются; deferred и события остаются', async () => {
    s = await setup();
    const gw = await s.start();
    const [a] = s.fake.push(s.fake.builder.text(OWNER, 'вчерашнее'));
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', a!.update_id) === 1, 5000, 'приёма');
    // Скачками (как сон): при advance на сутки срок опроса в 40 с срабатывал бы ~2000 раз — и столько же соединений.
    await gw.jump('23h');
    await gw.waitForJournal((l) => l.ev === 'wake');
    await sleep(200);
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM updates'), 1, 'до 24 ч — помнит');
    await gw.jump('2h');
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM updates') === 0, 5000, 'чистки');
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', a!.update_id), 1, 'событие остаётся');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'updates_purged'));
    await gw.stop();
  });
});

describe('CLI на чтение: status, deferred list, log tail', () => {
  let s: Setup;
  after(() => s?.close());

  it('показывают опрос, события, отложенное и журнал; базу не меняют', async () => {
    s = await setup();
    const bad = s.fake.push(s.fake.builder.text(OWNER, 'роняет шлюз'))[0]!.update_id;
    // Два падения, третий старт за 60 с — отложено (A1.11), шлюз работает дальше.
    for (let i = 0; i < 2; i++) {
      const g0 = s.spawn({ STG_FAULT: `in_handler:${bad}` });
      assert.equal((await g0.waitForExit()).code, 137);
    }
    const g = await s.start({ STG_FAULT: `in_handler:${bad}` });
    await waitUntil(() => count(s.home, "SELECT count(*) AS n FROM updates WHERE status = 'deferred'") === 1, 5000, 'отложенного');
    const st = await runCli(['status'], s.env);
    assert.equal(st.code, 0, st.stdout + st.stderr);
    assert.match(st.stdout, /шлюз: работает/);
    assert.match(st.stdout, /отложено: 1/);
    assert.match(st.stdout, /задержки за сутки: записал p50 .* · p90 .*; 👀 после отдачи агенту p50/);
    const dl = await runCli(['deferred', 'list'], s.env);
    assert.equal(dl.code, 0);
    assert.match(dl.stdout, new RegExp(`^${bad} · \\d{4}-\\d{2}-\\d{2} 09:00 · падений \\d · роняет шлюз`, 'm'));
    const lt = await runCli(['log', 'tail', '5'], s.env);
    assert.equal(lt.code, 0);
    assert.equal(lt.stdout.trim().split('\n').length, 5);
    for (const l of lt.stdout.trim().split('\n')) JSON.parse(l);
    // Сам повтор (через сокет шлюза) — m3-redelivery; здесь шлюз всё ещё падает на этом обновлении.
    const retry = await runCli(['deferred', 'retry', 'не-номер'], s.env);
    assert.equal(retry.code, 2, 'не номер — отказ без обращения к шлюзу');
    await pump(g, () => botTexts(s.fake).some((t) => DEFERRED_LINE_RE.test(t)), { what: 'строки об отложенном' });
    await g.stop();
    const after1 = await runCli(['status'], s.env);
    assert.match(after1.stdout, /шлюз: не отвечает/);
  });
});
