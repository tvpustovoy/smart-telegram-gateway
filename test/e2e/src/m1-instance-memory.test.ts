// A1.17 (Ш-24) — второй запуск шлюза на той же папке; затем kill -9 первого и новый старт: второй вышел, первый
// опрашивает, строки про 409 нет; старые сокет и pid-файл старту не мешают. Плюс гонка двух одновременных стартов.
// N-2 — память ≤ 200 МБ: RSS после 10 тыс. событий и 100 голосовых — пик по замерам под нагрузкой (после каждой
// пачки), а не один замер в конце.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { after, describe, it } from 'node:test';
import { POLL_CONFLICT_NOTICE } from 'stg-core';
import { makeOggOpus } from 'stg-fake-elevenlabs';
import { assertNoLoss, count, readJournal, sleep, waitUntil } from './harness.js';
import { OWNER, botTexts, setup, type Setup } from './m1-common.js';
import { voiceSetup, type VoiceSetup } from './m4-common.js';

describe('A1.17 · один экземпляр', () => {
  let s: Setup;
  after(() => s?.close());

  it('второй выходит «уже запущен», первый опрашивает, 409 нет; после kill -9 старт проходит', async () => {
    s = await setup();
    const first = await s.start();
    await first.waitForJournal((l) => l.ev === 'reception_started');
    const second = s.spawn();
    const ex = await second.waitForExit();
    assert.equal(ex.code, 3);
    assert.match(second.stderr, new RegExp(`уже запущен \\(pid ${first.pid}\\)`));
    const [u] = s.fake.push(s.fake.builder.text(OWNER, 'первый работает'));
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', u!.update_id) === 1, 5000, 'приёма первым');
    assert.equal(s.fake.calls.filter((c) => c.status === 409).length, 0, '409 нет: второй не опрашивал');
    await first.kill9();
    assert.ok(fs.existsSync(s.home.paths.socket) && fs.existsSync(s.home.paths.pid), 'после kill -9 остались сокет и pid-файл');
    const third = await s.start();
    const [u2] = s.fake.push(s.fake.builder.text(OWNER, 'третий работает'));
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', u2!.update_id) === 1, 5000, 'приёма третьим');
    await third.stop();
    assert.ok(!botTexts(s.fake).includes(POLL_CONFLICT_NOTICE));
    assertNoLoss(s.fake, s.home);
  });

  it('гонка: два старта одновременно — работает ровно один, второй выходит с кодом 3', async () => {
    const r = await setup();
    try {
      const a = r.spawn();
      const b = r.spawn();
      // Проигравший выходит сам (после нескольких попыток взять замок); оба читают один журнал — ждём выхода.
      const loser = await Promise.race([a.exited.then(() => a), b.exited.then(() => b)]);
      const winner = loser === a ? b : a;
      assert.equal((await loser.waitForExit()).code, 3, loser.stderr);
      assert.match(loser.stderr, /уже запущен/);
      await winner.waitForJournal((l) => l.ev === 'ready', 15_000);
      await sleep(300);
      const alive = [a, b].filter((g) => g.alive);
      assert.equal(alive.length, 1, `живых ${alive.length}; stderr: ${a.stderr} | ${b.stderr}`);
      await alive[0]!.stop();
      assert.equal(r.fake.calls.filter((c) => c.status === 409).length, 0);
      assert.ok(readJournal(r.home).some((l) => l.ev === 'start_refused'));
    } finally {
      await r.close();
    }
  });
});

describe('N-2 · память', () => {
  let s: VoiceSetup;
  after(() => s?.close());

  it('RSS ≤ 200 МБ после 10 тыс. событий и 100 голосовых', async (t) => {
    // Без fsync (STG_TEST_SYNC=off — только под тестом): мерим память, а не диск. Голосовые распознаются (M4) —
    // поддельным ElevenLabs.
    s = await voiceSetup({ env: { STG_TEST_SYNC: 'off' } });
    const gw = await s.start();
    for (let i = 0; i < 100; i++) s.fake.addFile(makeOggOpus(5), { fileId: `nv${i}`, path: `voice/nv${i}.oga` });
    const TOTAL = 10_000;
    const rssMb = (): number => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(gw.pid)], { encoding: 'utf8' }).trim()) / 1024;
    const samples: number[] = [];
    for (let i = 0; i < TOTAL; i += 500) {
      const batch = [];
      for (let k = i; k < Math.min(TOTAL, i + 500); k++) {
        batch.push(k % 100 === 0 ? s.fake.builder.voice(OWNER, { duration: 5, fileId: `nv${k / 100}` }) : s.fake.builder.text(OWNER, `мысль ${k}: ${'текст '.repeat(10)}`));
      }
      s.fake.push(...batch);
      // Замер посреди приёма пачки и после неё.
      await sleep(50);
      samples.push(rssMb());
      await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id IS NOT NULL') >= Math.min(TOTAL, i + 500), 60_000, 'приёма');
      samples.push(rssMb());
    }
    assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'voice'"), 100);
    await waitUntil(() => count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'voice' AND transcript IS NOT NULL") === 100 || null, 60_000, 'расшифровок');
    samples.push(rssMb());
    const peak = Math.max(...samples);
    const last = samples[samples.length - 1]!;
    t.diagnostic(`RSS: пик ${peak.toFixed(1)} МБ, в конце ${last.toFixed(1)} МБ после ${TOTAL} событий (замеров ${samples.length})`);
    assert.ok(peak <= 200, `пик RSS ${peak.toFixed(1)} МБ`);
    await gw.stop();
    assertNoLoss(s.fake, s.home);
  });
});
