// Опрос (Ш-24, Ш-1): A1.9 — 409 шесть раз подряд (и дальше: восемь — чтобы проверить не одну паузу 60 с, а две):
// цикл не завершается, паузы 10…50 с, после пятой — одна строка владельцу, дальше опрос раз в 60 с без строк;
// вебхук — строка про вебхук, deleteWebhook не вызван.
// A1.18 — подделка держит getUpdates без ответа: переподключение ≤ 40 с, ничего не потеряно.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { POLL_CONFLICT_NOTICE, WEBHOOK_NOTICE } from 'stg-core';
import { errors, reply } from 'stg-fake-telegram';
import { assertNoLoss, count, pump, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, botTexts, setup, waitRecorded, type Setup } from './m1-common.js';

describe('A1.9 · 409: второй опрос и вебхук', () => {
  let s: Setup;
  let gw: GatewayProcess;
  before(async () => {
    s = await setup();
    s.fake.scenario({ method: 'getUpdates', from: 1, times: 8, reply: errors.conflictPolling() });
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('паузы 10, 20, 30, 40, 50 с; после пятой — одна строка; шестая, седьмая, восьмая — 60 с, без строк; цикл жив', async () => {
    gw = await s.start();
    const expected = [10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 60_000, 60_000];
    for (let n = 1; n <= 8; n++) {
      const line = await gw.waitForJournal((l) => l.ev === 'poll_conflict' && l.n === n);
      assert.equal(line.wait_ms, expected[n - 1], `пауза после ${n}-го 409`);
      const calls = s.fake.callsOf('getUpdates').length;
      await gw.advance(`${expected[n - 1]! - 1000}ms`);
      await sleep(150);
      assert.equal(s.fake.callsOf('getUpdates').length, calls, `после ${n}-го 409 раньше срока не опрашивает`);
      await gw.advance('1s');
      await s.fake.waitForCall((c) => c.method === 'getUpdates' && c.nth === calls + 1, 5000);
      if (n === 5) {
        await waitUntil(() => botTexts(s.fake).includes(POLL_CONFLICT_NOTICE), 5000, 'строки про второй опрос');
      }
    }
    assert.equal(botTexts(s.fake).filter((t) => t === POLL_CONFLICT_NOTICE).length, 1, 'строка одна');
    assert.equal(readJournal(s.home).filter((l) => l.ev === 'poll_conflict_notice').length, 1);
    // Девятый опрос — обычный: сообщение принимается.
    s.fake.push(s.fake.builder.text(OWNER, 'после конфликта'));
    await waitUntil(() => count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'text'") === 1, 5000, 'приёма');
    assert.ok(gw.alive);
    assert.equal(s.fake.callsOf('deleteWebhook').length, 0);
    await gw.stop();
    assertNoLoss(s.fake, s.home);
  });

  it('вебхук: строка про вебхук (одна, и после перезапуска — без повтора); deleteWebhook не вызван; строки «кто-то ещё» нет', async () => {
    const w = await setup();
    try {
      w.fake.setWebhook('https://hooks.example.com/secret-path');
      const g = await w.start();
      await waitUntil(() => botTexts(w.fake).includes(WEBHOOK_NOTICE), 5000, 'строки про вебхук').catch((e: Error) => {
        throw new Error(`${e.message}; журнал: ${g.tail(10)}; вызовы: ${w.fake.calls.map((c) => `${c.method}:${c.outcome}:${c.status}`).join(', ')}`);
      });
      for (let n = 1; n <= 6; n++) {
        const line = await g.waitForJournal((l) => l.ev === 'poll_conflict' && l.n === n);
        assert.equal(line.webhook, true);
        await g.advance(`${line.wait_ms as number}ms`);
      }
      await g.waitForJournal((l) => l.ev === 'poll_conflict' && l.n === 7);
      await g.stop();
      const g2 = await w.start();
      await g2.waitForJournal((l) => l.ev === 'poll_conflict' && l.n === 1);
      await g2.stop();
      assert.equal(botTexts(w.fake).filter((t) => t === WEBHOOK_NOTICE).length, 1);
      assert.ok(!botTexts(w.fake).includes(POLL_CONFLICT_NOTICE));
      assert.equal(w.fake.callsOf('deleteWebhook').length, 0);
      assert.ok(!JSON.stringify(readJournal(w.home)).includes('secret-path'), 'путь вебхука в журнал не пишется');
      assert.ok(!fs.readFileSync(w.home.paths.db).includes('secret-path'), 'и в базу тоже');
    } finally {
      await w.close();
    }
  });
});

describe('A1.18 · getUpdates висит без ответа', () => {
  let s: Setup;
  let gw: GatewayProcess;
  before(async () => {
    s = await setup();
    s.fake.onCall('getUpdates', 1, reply.hang());
    gw = await s.start();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('переподключение ≤ 40 с (поддельные часы), сообщение, лежавшее в Telegram, принято', async () => {
    await s.fake.waitForCall((c) => c.method === 'getUpdates' && c.nth === 1);
    const [u] = s.fake.push(s.fake.builder.text(OWNER, 'пока опрос висел'));
    await gw.advance('39s');
    await sleep(200);
    assert.equal(s.fake.callsOf('getUpdates').length, 1, 'до 40 с соединение не рвётся');
    await gw.advance('1s');
    await s.fake.waitForCall((c) => c.method === 'getUpdates' && c.nth === 2, 5000);
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', u!.update_id) === 1, 5000, 'приёма');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'poll_timeout'));
    await waitRecorded(s, gw, u!);
    await gw.stop();
    assertNoLoss(s.fake, s.home);
  });
});
