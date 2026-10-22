// Каркас процесса шлюза (M0, TECH-SPEC 5 «Один экземпляр», 5.2, §7): один экземпляр, маркер чистой остановки,
// поддельные часы переживают перезапуск, сокет отвечает на ping и не падает на плохих кадрах, сбой базы и
// настроек — код ≠ 0 без опроса.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { MAX_FRAME_BYTES, readFakeClockFile } from 'stg-core';
import { FakeChannel } from 'stg-fake-channel';
import { FakeTelegram } from 'stg-fake-telegram';
import { GatewayProcess, T0, TEST_TOKEN, makeHome, openDbRo, readJournal, testEnv, type TestHome } from './harness.js';

function meta(home: TestHome, key: string): string | null {
  const db = openDbRo(home);
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

describe('M0 · процесс шлюза', () => {
  let fake: FakeTelegram;
  before(async () => {
    fake = await FakeTelegram.start({ token: TEST_TOKEN });
  });
  after(() => fake.stop());

  it('один экземпляр: второй выходит с «уже запущен (pid N)»; после kill -9 старые сокет и pid-файл не мешают', async () => {
    const home = makeHome({ apiBase: fake.apiBase, ownerId: 111 });
    const env = testEnv(home, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN });
    const first = await GatewayProcess.start(home, env);
    const second = GatewayProcess.spawn(home, env);
    const ex = await second.waitForExit();
    assert.notEqual(ex.code, 0);
    assert.match(second.stderr, new RegExp(`уже запущен \\(pid ${first.pid}\\)`));
    assert.ok(first.alive, 'первый работает');
    assert.ok(readJournal(home).some((l) => l.ev === 'start_refused'));
    assert.equal(fake.calls.filter((c) => c.method === 'sendMessage').length, 0, 'строк владельцу нет');

    await first.kill9();
    assert.ok(fs.existsSync(home.paths.socket), 'после kill -9 остался сокет');
    assert.ok(fs.existsSync(home.paths.pid), 'после kill -9 остался pid-файл');
    const third = await GatewayProcess.start(home, env);
    const start = await third.waitForJournal((l) => l.ev === 'start');
    assert.equal(start.clean_previous, false, 'после kill -9 остановка не чистая');
    assert.equal(Number(fs.readFileSync(home.paths.pid, 'utf8')), third.pid);
    await third.stop();
  });

  it('корректная остановка: код 0, маркер чистой остановки, сокет и pid-файл убраны; следующий старт это видит', async () => {
    const home = makeHome({ apiBase: fake.apiBase, ownerId: 111 });
    const env = testEnv(home);
    const g1 = await GatewayProcess.start(home, env);
    assert.equal(meta(home, 'clean_shutdown'), '0', 'во время работы маркер снят');
    assert.equal(fs.statSync(home.paths.db).mode & 0o777, 0o600, 'база — только владельцу');
    const ex = await g1.stop();
    assert.equal(ex.code, 0);
    assert.equal(meta(home, 'clean_shutdown'), '1');
    assert.equal(fs.existsSync(home.paths.socket), false);
    assert.equal(fs.existsSync(home.paths.pid), false);
    assert.ok(g1.journal().some((l) => l.ev === 'stop' && l.clean === true));

    const g2 = await GatewayProcess.start(home, env);
    const start = await g2.waitForJournal((l) => l.ev === 'start');
    assert.equal(start.clean_previous, true);
    assert.equal(start.starts_recent, 2);
    const history = JSON.parse(meta(home, 'start_history') ?? '[]') as number[];
    assert.equal(history.length, 2);
    await g2.stop();
  });

  it('поддельные часы: «advance 600s» сдвигает время; время переживает перезапуск', async () => {
    const home = makeHome({ apiBase: fake.apiBase, ownerId: 111 });
    const env = testEnv(home);
    const g1 = await GatewayProcess.start(home, env);
    assert.equal((await g1.waitForJournal((l) => l.ev === 'start')).at, new Date(T0).toISOString());
    assert.equal(await g1.advance('600s'), T0 + 600_000);
    assert.equal(await g1.advance('2h'), T0 + 600_000 + 7_200_000);
    await g1.stop();
    const after1 = T0 + 600_000 + 7_200_000;
    assert.equal(readFakeClockFile(home.paths.clockFile), after1);

    const g2 = await GatewayProcess.start(home, env);
    const start = await g2.waitForJournal((l) => l.ev === 'start');
    assert.equal(start.at, new Date(after1).toISOString(), 'после перезапуска — то же время, а не STG_CLOCK_START');
    await g2.stop();
  });

  it('сокет: ping → pong; плохие кадры — bad_request, сокет живёт; hello — welcome с арендой; where — where_result (M2)', async () => {
    const home = makeHome({ apiBase: fake.apiBase, ownerId: 111 });
    const g = await GatewayProcess.start(home, testEnv(home));
    const ch = await FakeChannel.connect(home.paths.socket);
    try {
      ch.send({ type: 'ping' });
      await ch.waitFor((r) => r.message?.type === 'pong');

      ch.sendRaw('не json\n');
      const e1 = await ch.waitFor((r) => r.message?.type === 'error' && r.message.code === 'bad_request');
      assert.equal(e1.message?.type === 'error' && e1.message.req_id, null);

      const e2 = await ch.request('episode', { action: 'new', topic: 'Т', role: 'юрист' });
      assert.ok(e2.type === 'error' && e2.code === 'bad_request' && /role/.test(e2.text));

      ch.sendRaw(Buffer.from(`{"type":"reply","text":"${'я'.repeat(MAX_FRAME_BYTES / 2 + 10)}"}\n`));
      await ch.waitFor((r) => r.message?.type === 'error' && /1 МБ/.test(r.message.text));

      const h = await ch.hello();
      assert.ok(h.type === 'welcome' && h.lease_id.length > 0 && h.mode === 'running', JSON.stringify(h));
      const w = await ch.where();
      assert.ok(w.type === 'where_result' && w.text.startsWith('⚙ Где мы') && w.data?.mode === 'running', JSON.stringify(w));

      const before = ch.received.filter((r) => r.message?.type === 'pong').length;
      ch.send({ type: 'ping' });
      await ch.waitFor(() => ch.received.filter((r) => r.message?.type === 'pong').length > before);
      assert.equal(ch.isClosed, false);
    } finally {
      ch.close();
      await g.stop();
    }
  });

  it('испорченная база: код ≠ 0, опрос не начат, сокет и pid-файл убраны', async () => {
    const home = makeHome({ apiBase: fake.apiBase, ownerId: null });
    fs.writeFileSync(home.paths.db, 'мусор вместо базы\n'.repeat(400));
    const polls = fake.callsOf('getUpdates').length;
    const g = GatewayProcess.spawn(home, testEnv(home, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN }));
    const ex = await g.waitForExit();
    assert.notEqual(ex.code, 0);
    assert.match(g.stderr, /база не открылась/);
    assert.ok(readJournal(home).some((l) => l.ev === 'db_failed' && l.kind === 'not_a_database'));
    assert.equal(fake.callsOf('getUpdates').length, polls);
    assert.equal(fs.existsSync(home.paths.socket), false);
    assert.equal(fs.existsSync(home.paths.pid), false);
  });

  it('ошибка в config.yaml или в STG_FAULT — код ≠ 0 и понятная строка, база не создаётся', async () => {
    const home = makeHome({ apiBase: fake.apiBase, ownerId: 111, extraConfig: 'episode_idle_minutes: -5\nlaunch_rockets: true\n' });
    const g = GatewayProcess.spawn(home, testEnv(home));
    assert.notEqual((await g.waitForExit()).code, 0);
    assert.match(g.stderr, /episode_idle_minutes/);
    assert.match(g.stderr, /launch_rockets/);
    assert.equal(fs.existsSync(home.paths.db), false);

    const home2 = makeHome({ apiBase: fake.apiBase, ownerId: 111 });
    const g2 = GatewayProcess.spawn(home2, testEnv(home2, { STG_FAULT: 'in_handlr' }));
    assert.notEqual((await g2.waitForExit()).code, 0);
    assert.match(g2.stderr, /неизвестная точка/);

    // Неизвестный провайдер голоса — ошибка config.yaml по-русски, с полем и вариантами (5.8).
    const home3 = makeHome({ apiBase: fake.apiBase, ownerId: 111, extraConfig: 'stt: { provider: whisper }\ntts: { provider: openai, voice_id: x }\n' });
    const g3 = GatewayProcess.spawn(home3, testEnv(home3));
    assert.notEqual((await g3.waitForExit()).code, 0);
    assert.match(g3.stderr, /stt\.provider — неизвестный провайдер «whisper»: openai или elevenlabs/);
    assert.match(g3.stderr, /tts\.voice_id — нет такого поля у openai: у openai голос — voice/);
    assert.equal(fs.existsSync(home3.paths.db), false);
  });

  it('владелец задан: при старте — getWebhookInfo, затем опрос с allowed_updates; deleteWebhook не вызывается', async () => {
    const home = makeHome({ apiBase: fake.apiBase, ownerId: 111 });
    const n = fake.calls.length;
    const g = await GatewayProcess.start(home, testEnv(home, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN }));
    await g.waitForJournal((l) => l.ev === 'reception_started');
    await fake.waitForCall((c) => c.n > n && c.method === 'getUpdates');
    await g.stop();
    const mine = fake.calls.filter((c) => c.n > n);
    assert.equal(mine[0]?.method, 'getWebhookInfo');
    assert.deepEqual(mine.find((c) => c.method === 'getUpdates')?.params.allowed_updates, ['message', 'edited_message', 'callback_query', 'message_reaction']);
    assert.equal(mine.filter((c) => c.method === 'deleteWebhook').length, 0);
  });
});
