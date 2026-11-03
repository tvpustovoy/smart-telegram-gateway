// M17: связь с агентами — дочерним процессом шлюза (раздел link в config.yaml, link-runner.ts). Настоящий stg-link с
// подставным модулем порта: шлюз запускает связь, она подключается (peer_link_up); связь убита — шлюз поднимает её снова
// через паузу; шлюз остановлен — связь выходит вместе с ним; шлюз убит без остановки — связь выходит сама.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, readJournal, waitUntil, type GatewayProcess, type JournalLine } from './harness.js';
import { setup, type Setup } from './m1-common.js';

const PORT_MODULE = `export async function openPort() {
  return {
    async unread() { return []; },
    async consume() {},
    async send() { return { sent: false, reason: 'тест' }; },
    async sendFile() { return { sent: false, reason: 'тест' }; },
    async fetchFile() { throw new Error('тест'); },
    async *wakes(signal) { await new Promise((r) => signal.addEventListener('abort', r, { once: true })); },
    async close() {},
  };
}
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('M17 связь с агентами — дочерним процессом шлюза', () => {
  let s: Setup;
  let gw: GatewayProcess;
  const events = (ev: string): JournalLine[] => readJournal(s.home).filter((l) => l.ev === ev);

  before(async () => {
    const dir = makeTempDir('stg-port-');
    const port = path.join(dir, 'port.mjs');
    fs.writeFileSync(port, PORT_MODULE);
    s = await setup({ home: { extraConfig: `link: { port: "${port}", identity: Шлюз }\n` } });
    gw = await s.start();
  });

  after(async () => {
    await s.close();
  });

  it('шлюз запускает связь; убитая — поднимается снова; остановка шлюза — выходит; шлюз убит — выходит сама', async () => {
    const pid1 = Number((await waitUntil(() => events('link_started')[0], 10_000, 'link_started')).pid);
    await waitUntil(() => events('peer_link_up').length >= 1, 10_000, 'peer_link_up');

    process.kill(pid1, 'SIGKILL');
    const exited = await waitUntil(() => events('link_exited')[0], 10_000, 'link_exited');
    assert.equal(exited.signal, 'SIGKILL');
    assert.equal(exited.restart_in_ms, 1000);
    await gw.advance('1s');
    const pid2 = Number((await waitUntil(() => events('link_started')[1], 10_000, 'второй link_started')).pid);
    assert.notEqual(pid2, pid1);
    await waitUntil(() => events('peer_link_up').length >= 2, 10_000, 'снова peer_link_up');

    await gw.stop();
    assert.equal(events('link_stopped').length, 1);
    assert.equal(alive(pid2), false, 'связь вышла вместе со шлюзом');

    gw = await s.start();
    const pid3 = Number((await waitUntil(() => events('link_started')[2], 10_000, 'третий link_started')).pid);
    await waitUntil(() => events('peer_link_up').length >= 3, 10_000, 'peer_link_up после перезапуска');
    await gw.kill9();
    await waitUntil(() => !alive(pid3), 15_000, 'связь без шлюза вышла сама');
  });
});
