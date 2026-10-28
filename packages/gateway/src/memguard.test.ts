import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Journal } from 'stg-core';
import { MemoryGuard, MEMGUARD_LOG_EVERY_MS, rssLimitMb, type MemorySample } from './memguard.js';

const MB = 1024 * 1024;
function mem(rssMb: number): MemorySample {
  return { rss: rssMb * MB, heapUsed: 40 * MB, heapTotal: 60 * MB, external: (rssMb - 80) * MB, arrayBuffers: 1 * MB };
}

describe('предел памяти (memguard)', () => {
  it('пишет memory при старте, раз в час и при росте на 25 %; выше предела — memory_limit и остановка один раз', () => {
    const log: Array<[string, Record<string, unknown>]> = [];
    const journal = { write: (ev: string, f: Record<string, unknown> = {}) => void log.push([ev, f]) } as unknown as Journal;
    let rss = 100;
    let t = 0;
    let stops = 0;
    const g = new MemoryGuard(journal, { limitMb: 1024, sample: () => mem(rss), now: () => t }, () => stops++);
    assert.equal(g.check(), false);
    assert.deepEqual(log.map((x) => x[0]), ['memory']);
    t += 60_000; rss = 110; g.check();
    assert.equal(log.length, 1, 'малый рост в пределах часа — без записи');
    t += 60_000; rss = 130; g.check();
    assert.equal(log.length, 2, 'рост на 25 % — запись');
    t += MEMGUARD_LOG_EVERY_MS; g.check();
    assert.equal(log.length, 3, 'раз в час — запись');
    rss = 2000; assert.equal(g.check(), true);
    assert.equal(log.at(-1)?.[0], 'memory_limit');
    assert.equal(log.at(-1)?.[1].rss_mb, 2000);
    assert.equal(log.at(-1)?.[1].limit_mb, 1024);
    assert.equal(stops, 1);
    g.check();
    assert.equal(stops, 1, 'остановка — один раз');
  });

  it('предел из STG_RSS_LIMIT_MB; неверное или слишком малое — 1024', () => {
    assert.equal(rssLimitMb({}), 1024);
    assert.equal(rssLimitMb({ STG_RSS_LIMIT_MB: '512' }), 512);
    assert.equal(rssLimitMb({ STG_RSS_LIMIT_MB: 'abc' }), 1024);
    assert.equal(rssLimitMb({ STG_RSS_LIMIT_MB: '10' }), 1024);
  });
});
