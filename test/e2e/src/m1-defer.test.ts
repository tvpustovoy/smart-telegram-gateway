// Падения (Ш-15): A1.10 — обновление, на котором шлюз падает каждый раз (STG_FAULT=in_handler:<id>): после 3 падений —
// deferred с raw_json, строка владельцу; следующие приняты. A1.11 — 3 старта за 60 с при незавершённом обновлении:
// оно сразу deferred с raw_json, строка владельцу; следующие приняты.

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { deferredNotice } from 'stg-core';
import { assertNoLoss, count, meta, pump, q1, readJournal, shiftClockFile, waitUntil } from './harness.js';
import { OWNER, botTexts, setup, type Setup } from './m1-common.js';

async function scenario(s: Setup, gapMs: number): Promise<{ bad: number; good: number; runs: number }> {
  const bad = s.fake.push(s.fake.builder.text(OWNER, 'на этом шлюз падает'))[0]!.update_id;
  const good = s.fake.push(s.fake.builder.text(OWNER, 'следующее'))[0]!.update_id;
  const env = { STG_FAULT: `in_handler:${bad}` };
  let runs = 0;
  for (;;) {
    const g = s.spawn(env);
    runs++;
    const done = await Promise.race([
      g.exited.then(() => 'exit' as const),
      waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', good) === 1, 20_000, 'приёма следующего').then(() => 'admitted' as const),
    ]);
    if (done === 'admitted') {
      await pump(g, () => botTexts(s.fake).some((t) => /отложил: на нём шлюз падает/.test(t)), { what: 'строки владельцу' });
      await g.stop();
      break;
    }
    const ex = await g.waitForExit();
    assert.equal(ex.code, 137, g.stderr);
    if (runs > 6) throw new Error('не отложил за 6 запусков');
    shiftClockFile(s.home, gapMs);
  }
  return { bad, good, runs };
}

describe('A1.10 · три падения на одном обновлении', () => {
  let s: Setup;
  after(() => s?.close());

  it('после 3 падений — deferred с raw_json и строка владельцу; следующее принято', async () => {
    s = await setup();
    const { bad, good, runs } = await scenario(s, 61_000);
    assert.equal(runs, 4, 'три падения, на четвёртом старте — отложено');
    const row = q1<{ status: string; crash_count: number; raw_json: string | null }>(s.home, 'SELECT status, crash_count, raw_json FROM updates WHERE update_id = ?', bad);
    assert.equal(row?.status, 'deferred');
    assert.equal(row?.crash_count, 3);
    assert.ok(row?.raw_json?.includes('на этом шлюз падает'), 'содержимое сохранено');
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', bad), 0);
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', good), 1);
    assert.equal(Number(meta(s.home, 'offset')), good + 1);
    // T0 = 16:00 UTC = 09:00 по поясу владельца.
    assert.equal(botTexts(s.fake).filter((t) => t === deferredNotice('09:00')).length, 1);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'deferred' && l.reason === 'crash_limit'));
    assertNoLoss(s.fake, s.home);
  });
});

describe('A1.11 · три старта за 60 с', () => {
  let s: Setup;
  after(() => s?.close());

  it('незавершённое обновление сразу deferred с raw_json и строкой владельцу; следующее принято', async () => {
    s = await setup();
    const { bad, good, runs } = await scenario(s, 1_000);
    assert.equal(runs, 3, 'третий старт за 60 с — сразу отложено');
    const row = q1<{ status: string; crash_count: number; raw_json: string | null }>(s.home, 'SELECT status, crash_count, raw_json FROM updates WHERE update_id = ?', bad);
    assert.equal(row?.status, 'deferred');
    assert.equal(row?.crash_count, 2);
    assert.ok(row?.raw_json);
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', good), 1);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'deferred' && l.reason === 'start_loop'));
    assert.equal(botTexts(s.fake).filter((t) => /отложил: на нём шлюз падает/.test(t)).length, 1);
    assertNoLoss(s.fake, s.home);
  });
});
