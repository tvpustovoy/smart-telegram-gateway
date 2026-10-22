// A0.3 (Ш-3) — owner_id пуст, пишет кто угодно: событий и ответа нет; stg doctor показывает номер последнего
// написавшего. Заодно П-2 (токен нигде не записан) и «в журнал только счётчик».

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { FakeTelegram, user } from 'stg-fake-telegram';
import {
  GatewayProcess,
  TEST_TOKEN,
  doctorLines,
  filesContaining,
  makeHome,
  openDbRo,
  readJournal,
  runCli,
  testEnv,
  type TestHome,
} from './harness.js';

const REPLY_METHODS = ['sendMessage', 'editMessageText', 'editMessageReplyMarkup', 'setMessageReaction', 'sendChatAction', 'sendVoice', 'answerCallbackQuery', 'setMyCommands', 'pinChatMessage', 'deleteMessage'];

describe('A0.3 · первая настройка: owner_id пуст', () => {
  let fake: FakeTelegram;
  let home: TestHome;
  let gw: GatewayProcess;
  const petya = user(555_001, 'Петя', { lastName: 'Иванов', username: 'petya' });
  const vasya = user(555_002, 'Вася');
  let lastUpdateId = 0;

  before(async () => {
    fake = await FakeTelegram.start({ token: TEST_TOKEN });
    home = makeHome({ apiBase: fake.apiBase, ownerId: null });
    // До старта в подделке уже лежат два обновления от незнакомых.
    const first = fake.builder.text(petya, 'привет от Пети, секретный текст');
    const pushed = fake.push(first, fake.builder.callback(petya, 'кнопка'));
    lastUpdateId = pushed[pushed.length - 1]?.update_id ?? 0;
    gw = await GatewayProcess.start(home, testEnv(home, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN }));
    await fake.waitForOffset(lastUpdateId + 1);
    // Ещё одно — уже при работающем шлюзе: правка от другого незнакомого.
    const [vu] = fake.push(fake.builder.edited(fake.builder.text(vasya, 'было'), 'стало — текст Васи'));
    lastUpdateId = vu?.update_id ?? lastUpdateId;
    await fake.waitForOffset(lastUpdateId + 1);
  });

  after(async () => {
    if (gw?.alive) await gw.kill9();
    await fake.stop();
  });

  it('опрос — с allowed_updates из 5.3 и timeout 30', () => {
    const c = fake.callsOf('getUpdates')[0];
    assert.deepEqual(c?.params.allowed_updates, ['message', 'edited_message', 'callback_query', 'message_reaction']);
    assert.equal(c?.params.timeout, 30);
  });

  it('ответа нет: ни 👀, ни квитанции, ни ответа на нажатие', () => {
    for (const m of REPLY_METHODS) assert.equal(fake.callsOf(m).length, 0, `вызван ${m}`);
  });

  it('событий нет; обновления — ignored без raw_json; offset = последний + 1', () => {
    const db = openDbRo(home);
    try {
      assert.equal((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n, 0);
      const rows = db.prepare('SELECT update_id, status, raw_json FROM updates ORDER BY update_id').all() as Array<{
        update_id: number;
        status: string;
        raw_json: string | null;
      }>;
      assert.equal(rows.length, 3);
      for (const r of rows) {
        assert.equal(r.status, 'ignored');
        assert.equal(r.raw_json, null);
      }
      const offset = db.prepare("SELECT value FROM meta WHERE key = 'offset'").get() as { value: string };
      assert.equal(Number(offset.value), lastUpdateId + 1);
      const unknown = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'last_unknown_from'").get() as { value: string }).value) as {
        id: number;
        name: string;
      };
      assert.equal(unknown.id, vasya.id);
      assert.equal(unknown.name, 'Вася');
    } finally {
      db.close();
    }
  });

  it('в журнал — только счётчик: текстов и имён незнакомых нет', () => {
    const text = JSON.stringify(readJournal(home));
    assert.ok(!text.includes('привет от Пети'));
    assert.ok(!text.includes('текст Васи'));
    assert.ok(!text.includes('Петя'));
    const ignored = readJournal(home).filter((l) => l.ev === 'update_ignored');
    assert.equal(ignored.length, 3);
    assert.equal(ignored.at(-1)?.count, 3);
  });

  it('повтор от Telegram не даёт второй строки', async () => {
    fake.redeliver(lastUpdateId);
    await gw.waitForJournal((l) => l.ev === 'update_ignored' && l.repeat === true);
    const db = openDbRo(home);
    try {
      assert.equal((db.prepare('SELECT count(*) AS n FROM updates').get() as { n: number }).n, 3);
    } finally {
      db.close();
    }
  });

  it('stg doctor показывает номер последнего написавшего; код ≠ 0; getUpdates doctor не вызывает', async () => {
    const stop = await gw.stop();
    assert.equal(stop.code, 0);
    const polls = fake.callsOf('getUpdates').length;
    const r = await runCli(['doctor'], testEnv(home, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN }));
    const owner = doctorLines(r.stdout).find((l) => l.name === 'владелец');
    assert.ok(owner, r.stdout);
    assert.equal(owner.ok, false);
    assert.match(owner.raw, new RegExp(`${vasya.id}`));
    assert.match(owner.raw, /owner_id: 555002/);
    assert.notEqual(r.code, 0);
    assert.equal(fake.callsOf('getUpdates').length, polls);
  });

  it('П-2: токен не записан ни в один файл каталога', () => {
    assert.deepEqual(filesContaining(home.dir, TEST_TOKEN), []);
  });
});
