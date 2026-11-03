import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { FakeClock, type Journal } from 'stg-core';
import { LINK_RESTART_MAX_MS, LINK_STABLE_MS, LinkRunner, type LinkSpawn } from './link-runner.js';

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];

  kill(sig = 'SIGTERM'): boolean {
    this.signals.push(sig);
    queueMicrotask(() => this.exit(null, sig));
    return true;
  }

  exit(code: number | null, signal: string | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function setup(opts: { port?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stg-link-runner-'));
  const entry = path.join(dir, 'index.js');
  const port = path.join(dir, 'port.mjs');
  fs.writeFileSync(entry, '');
  if (opts.port !== false) fs.writeFileSync(port, '');
  const log: Array<[string, Record<string, unknown>]> = [];
  const journal = { write: (ev: string, f: Record<string, unknown> = {}) => void log.push([ev, f]) } as unknown as Journal;
  const clock = new FakeClock(Date.UTC(2026, 10, 2, 20, 0));
  const children: FakeChild[] = [];
  const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn: LinkSpawn = (cmd, args, o) => {
    calls.push({ cmd, args, env: o.env });
    const c = new FakeChild();
    children.push(c);
    return c as unknown as ChildProcess;
  };
  const runner = new LinkRunner({ port, identity: 'PG.Gateway', home: '/bot', clock, journal, entry, spawn });
  const events = (): string[] => log.map((x) => x[0]);
  const last = (ev: string): Record<string, unknown> | undefined => log.filter((x) => x[0] === ev).at(-1)?.[1];
  return { dir, entry, port, log, clock, children, calls, runner, events, last };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('связь с агентами — дочерним процессом шлюза (link-runner)', () => {
  it('запускает stg-link с портом, именем, STG_HOME и pid шлюза; stderr — в журнал без метки времени', async () => {
    const t = setup();
    t.runner.start();
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0]!.cmd, process.execPath);
    assert.deepEqual(t.calls[0]!.args.slice(1), [t.entry, '--port', t.port, '--identity', 'PG.Gateway']);
    assert.equal(t.calls[0]!.env.STG_HOME, '/bot');
    assert.equal(t.calls[0]!.env.STG_LINK_PARENT, String(process.pid));
    assert.deepEqual(t.last('link_started'), { pid: 4242 });
    t.children[0]!.stderr.write('2026-11-03T00:32:47.414Z stg-link: связь со шлюзом установлена\n');
    await tick();
    assert.deepEqual(t.last('link_log'), { line: 'связь со шлюзом установлена' });
    t.runner.start();
    assert.equal(t.calls.length, 1, 'живая связь — второй не запускается');
  });

  it('вышла — поднимается снова: пауза 1 с, дальше вдвое до минуты; проработала минуту — снова 1 с', async () => {
    const t = setup();
    t.runner.start();
    t.children[0]!.exit(1, null);
    assert.equal(t.last('link_exited')?.restart_in_ms, 1000);
    await t.clock.advance(999);
    assert.equal(t.calls.length, 1, 'до конца паузы не поднимается');
    await t.clock.advance(1);
    assert.equal(t.calls.length, 2);
    t.children[1]!.exit(1, null);
    assert.equal(t.last('link_exited')?.restart_in_ms, 2000);
    for (let i = 0; i < 8; i++) {
      await t.clock.advance(LINK_RESTART_MAX_MS);
      t.children.at(-1)!.exit(1, null);
    }
    assert.equal(t.last('link_exited')?.restart_in_ms, LINK_RESTART_MAX_MS, 'не больше минуты');
    await t.clock.advance(LINK_RESTART_MAX_MS);
    await t.clock.advance(LINK_STABLE_MS);
    t.children.at(-1)!.exit(0, null);
    assert.equal(t.last('link_exited')?.ran_ms, LINK_STABLE_MS);
    assert.equal(t.last('link_exited')?.restart_in_ms, 1000, 'проработала минуту — пауза снова с начала');
  });

  it('остановка шлюза — SIGTERM связи, link_stopped, больше не поднимается', async () => {
    const t = setup();
    t.runner.start();
    await t.runner.stop();
    assert.deepEqual(t.children[0]!.signals, ['SIGTERM']);
    assert.deepEqual(t.last('link_stopped'), { code: null, signal: 'SIGTERM' });
    await t.clock.advance(LINK_RESTART_MAX_MS * 2);
    assert.equal(t.calls.length, 1);
    assert.ok(!t.events().includes('link_exited'));
  });

  it('нет модуля порта — link_failed и попытка снова через паузу; файл появился — запускается', async () => {
    const t = setup({ port: false });
    t.runner.start();
    assert.equal(t.calls.length, 0);
    assert.match(String(t.last('link_failed')?.error), /нет модуля порта/);
    assert.equal(t.last('link_failed')?.restart_in_ms, 1000);
    fs.writeFileSync(t.port, '');
    await t.clock.advance(1000);
    assert.equal(t.calls.length, 1);
    assert.ok(t.events().includes('link_started'));
  });

  it('процесс не запустился (нет pid) — link_exited с причиной и попытка снова', async () => {
    const t = setup();
    t.runner.start();
    const c = t.children[0]!;
    c.pid = undefined;
    c.emit('error', new Error('spawn EACCES'));
    assert.equal(t.last('link_exited')?.error, 'spawn EACCES');
    c.exit(-13, null);
    assert.equal(t.events().filter((e) => e === 'link_exited').length, 1, 'один выход — одна запись');
    await t.clock.advance(1000);
    assert.equal(t.calls.length, 2);
  });
});
