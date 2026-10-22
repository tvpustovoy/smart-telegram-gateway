import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  ClockConfigError,
  FakeClock,
  RealClock,
  DeadlineError,
  clockCommand,
  clockDeadline,
  clockFromEnv,
  parseDuration,
  readFakeClockFile,
  startClockControlServer,
} from './clock.js';

/** Временные каталоги этого файла тестов — удаляются после него. */
const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function makeTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function tmpDir(): string {
  return makeTmp('stg-clock-');
}

const T0 = Date.parse('2026-10-18T09:00:00Z');

describe('часы: поддельные', () => {
  it('время стоит, пока его не сдвинут', async () => {
    const c = new FakeClock(T0);
    assert.equal(c.now(), T0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(c.now(), T0);
    await c.advance(600_000);
    assert.equal(c.now(), T0 + 600_000);
  });

  it('таймеры срабатывают по порядку сроков, время на каждом — его срок', async () => {
    const c = new FakeClock(T0);
    const seen: Array<[string, number]> = [];
    c.setTimeout(() => seen.push(['b', c.now()]), 2000);
    c.setTimeout(() => seen.push(['a', c.now()]), 1000);
    c.setTimeout(() => seen.push(['c', c.now()]), 5000);
    await c.advance(3000);
    assert.deepEqual(seen, [
      ['a', T0 + 1000],
      ['b', T0 + 2000],
    ]);
    assert.equal(c.now(), T0 + 3000);
    await c.advance(2000);
    assert.deepEqual(seen.at(-1), ['c', T0 + 5000]);
  });

  it('setInterval срабатывает столько раз, сколько уложилось в сдвиг; cancel останавливает', async () => {
    const c = new FakeClock(T0);
    let n = 0;
    const t = c.setInterval(() => n++, 60_000);
    await c.advance(10 * 60_000);
    assert.equal(n, 10);
    t.cancel();
    await c.advance(10 * 60_000);
    assert.equal(n, 10);
  });

  it('sleep ждёт сдвига; таймер, поставленный после пробуждения, срабатывает в том же сдвиге', async () => {
    const c = new FakeClock(T0);
    const marks: number[] = [];
    void (async () => {
      await c.sleep(1000);
      marks.push(c.now());
      await c.sleep(1000);
      marks.push(c.now());
    })();
    await c.advance(5000);
    assert.deepEqual(marks, [T0 + 1000, T0 + 2000]);
  });

  it('sleep отменяется сигналом', async () => {
    const c = new FakeClock(T0);
    const ac = new AbortController();
    const p = c.sleep(10_000, ac.signal);
    ac.abort(new Error('стоп'));
    await assert.rejects(p, /стоп/);
    assert.equal(c.pendingTimers(), 0);
  });

  it('время переживает перезапуск через файл', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'clock.json');
    const a = new FakeClock(T0, file);
    await a.advance(3_600_000);
    assert.equal(readFakeClockFile(file), T0 + 3_600_000);
    const b = new FakeClock(0, file);
    assert.equal(b.now(), T0 + 3_600_000);
  });

  it('сдвиги встают в очередь, а не идут параллельно', async () => {
    const c = new FakeClock(T0);
    const [x, y] = await Promise.all([c.advance(1000), c.advance(1000)]);
    assert.equal(x, T0 + 1000);
    assert.equal(y, T0 + 2000);
  });
});

describe('часы: сроки и окружение', () => {
  it('parseDuration понимает ms, s, m, h, d', () => {
    assert.equal(parseDuration('600s'), 600_000);
    assert.equal(parseDuration('1500ms'), 1500);
    assert.equal(parseDuration('33m'), 33 * 60_000);
    assert.equal(parseDuration('2h'), 7_200_000);
    assert.equal(parseDuration('1d'), 86_400_000);
    assert.throws(() => parseDuration('10'), /не понял срок/);
  });

  it('STG_CLOCK=fake без STG_TEST=1 — отказ', () => {
    const dir = tmpDir();
    const paths = { clockFile: path.join(dir, 'c.json'), clockSocket: path.join(dir, 'c.sock') };
    assert.throws(() => clockFromEnv({ STG_CLOCK: 'fake' }, paths), ClockConfigError);
    assert.equal(clockFromEnv({}, paths).kind, 'real');
    const c = clockFromEnv({ STG_CLOCK: 'fake', STG_TEST: '1', STG_CLOCK_START: '2026-10-18T09:00:00Z' }, paths);
    assert.equal(c.kind, 'fake');
    assert.equal(c.now(), T0);
  });

  it('тестовый сокет: «advance 600s» и «now»', async () => {
    const dir = tmpDir();
    const c = new FakeClock(T0);
    const sock = path.join(dir, 'c.sock');
    const server = await startClockControlServer(c, sock);
    try {
      let fired = 0;
      c.setTimeout(() => fired++, 300_000);
      assert.equal(await clockCommand(sock, 'advance 600s'), T0 + 600_000);
      assert.equal(fired, 1);
      assert.equal(await clockCommand(sock, 'now'), T0 + 600_000);
      await assert.rejects(clockCommand(sock, 'jump'), /неизвестная команда/);
    } finally {
      server.close();
    }
  });
});

describe('часы: настоящие', () => {
  it('now близко к Date.now, sleep и таймеры работают', async () => {
    const c = new RealClock();
    assert.ok(Math.abs(c.now() - Date.now()) < 50);
    const t0 = Date.now();
    await c.sleep(20);
    assert.ok(Date.now() - t0 >= 15);
    let fired = false;
    const t = c.setTimeout(() => (fired = true), 5);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(fired);
    t.cancel();
  });
});

describe('поддельные часы: скачок (как после сна)', () => {
  it('jump: время сразу +N, просроченный повторяющийся таймер срабатывает один раз', async () => {
    const c = new FakeClock(1_000_000);
    const seen: number[] = [];
    c.setInterval(() => seen.push(c.now()), 15_000);
    let fired = 0;
    c.setTimeout(() => fired++, 60_000);
    await c.jump(7_200_000);
    assert.deepEqual(seen, [1_000_000 + 7_200_000]);
    assert.equal(fired, 1);
    assert.equal(c.now(), 1_000_000 + 7_200_000);
    await c.advance(15_000);
    assert.deepEqual(seen, [1_000_000 + 7_200_000, 1_000_000 + 7_200_000 + 15_000]);
  });
});

describe('срок внешнего запроса по часам (clockDeadline)', () => {
  it('поддельные часы: срок вышел по часам, но не раньше запаса настоящего времени', async () => {
    const c = new FakeClock(T0);
    const d = clockDeadline(c, 60_000, { graceRealMs: 80 });
    const t0 = performance.now();
    await c.advance(60_000);
    assert.equal(d.signal.aborted, false, 'запас настоящего времени ещё не прошёл');
    // Таймер запаса не держит процесс (unref): здесь процесс держит ожидание.
    const keep = setTimeout(() => undefined, 5000);
    await new Promise((r) => d.signal.addEventListener('abort', r, { once: true }));
    clearTimeout(keep);
    assert.ok(performance.now() - t0 >= 70);
    assert.ok(d.expired());
    assert.ok(d.signal.reason instanceof DeadlineError);
  });

  it('до срока не срабатывает; внешняя отмена — сразу и не считается сроком; cancel снимает таймер', async () => {
    const c = new FakeClock(T0);
    const parent = new AbortController();
    const d = clockDeadline(c, 60_000, { graceRealMs: 0, signal: parent.signal });
    await c.advance(59_000);
    assert.equal(d.signal.aborted, false);
    parent.abort(new Error('остановка'));
    assert.equal(d.signal.aborted, true);
    assert.equal(d.expired(), false);
    const e = clockDeadline(c, 1000, { graceRealMs: 0 });
    e.cancel();
    await c.advance(5000);
    assert.equal(e.signal.aborted, false);
  });
});
