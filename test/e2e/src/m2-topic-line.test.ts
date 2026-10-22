// Строка темы после [верно] (0.3.5, issue #48; TECH-SPEC 5.7, ui.delete_confirmed_topic). Агент назвал тему — владелец
// видит `⚙ ↪ #N · тема` с [верно] [не то]; [верно] — строка удаляется (тема и так в закреплённой строке), по умолчанию.
// - ui.delete_confirmed_topic: false — как раньше: одна правка «… — верно» без кнопок, удаления нет;
// - Telegram не дал удалить (старше 48 часов и т. п.) — правка «… — верно» без кнопок; причина — в журнале;
// - строки уже нет (владелец удалил её сам) — удаление засчитано (already_gone), правки нет;
// - удаление не прошло за все попытки (сеть, 5xx) — то же;
// - повторное нажатие, пока удаление в пути, — «уже использовано», правок нет, удаление одно;
// - перезапуск шлюза между нажатием и удалением — строка удалена после перезапуска (удаление — в базе, с повтором).
// [не то] не меняется — m2-episodes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reply, type SentMessage } from 'stg-fake-telegram';
import type { FakeChannel } from 'stg-fake-channel';
import { connectAdapter, pump, q1, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, setup, type Setup } from './m1-common.js';
import { press, waitSent } from './m2-common.js';
import { currentButtons, currentText } from './m4-common.js';

/** Эпизод открыт сообщением владельца, агент назвал тему — строка `⚙ ↪ #N · тема` с кнопками. */
async function topicLine(s: Setup, gw: GatewayProcess, ch: FakeChannel, topic: string): Promise<{ line: SentMessage; ep: number }> {
  const u = s.fake.push(s.fake.builder.text(OWNER, `про ${topic}`))[0]!;
  const seq = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
  await ch.waitEvent(seq);
  const r = await ch.episode('name', topic);
  assert.ok(r.type === 'ack', JSON.stringify(r));
  const ep = (r.result as { episode_id: number }).episode_id;
  const line = await waitSent(s, gw, (m) => m.text === `⚙ ↪ #${ep} · ${topic}`, 'строки темы');
  return { line, ep };
}

/** Правки строки (editMessageText, editMessageReplyMarkup) — по порядку. */
function editsOf(s: Setup, line: SentMessage): string[] {
  return s.fake.calls.filter((c) => (c.method === 'editMessageText' || c.method === 'editMessageReplyMarkup') && Number(c.params.message_id) === line.message_id).map((c) => c.method);
}

function deletesOf(s: Setup, line: SentMessage): number {
  return s.fake.calls.filter((c) => c.method === 'deleteMessage' && Number(c.params.message_id) === line.message_id).length;
}

async function settle(gw: GatewayProcess, n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await gw.advance('1s');
  await sleep(30);
}

describe('M2 · строка темы после [верно] (0.3.5, #48)', () => {
  it('ui.delete_confirmed_topic: false — как раньше: одна правка «— верно» без кнопок, удаления нет', async () => {
    const s = await setup({ home: { extraConfig: 'ui: { delete_confirmed_topic: false }\n' } });
    try {
      const gw = await s.start();
      const { ch } = await connectAdapter(s.home);
      try {
        const { line, ep } = await topicLine(s, gw, ch, 'Отпуск');
        assert.equal(await press(s, line, 'верно'), null);
        await pump(gw, () => (currentText(line) === `⚙ ↪ #${ep} · Отпуск — верно` && currentButtons(line).length === 0) || null, { what: 'правки «— верно»' });
        await settle(gw);
        assert.deepEqual(editsOf(s, line), ['editMessageText'], 'одна правка: текст без кнопок');
        assert.equal(deletesOf(s, line), 0, 'не удаляется');
        assert.ok(!s.fake.wasDeleted(OWNER.id, line.message_id));
        const j = readJournal(s.home).find((l) => l.ev === 'episode_confirmed' && l.episode === ep)!;
        assert.equal(j.line, undefined, 'в журнале — без удаления');
      } finally {
        ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('Telegram не дал удалить — правка «— верно» без кнопок; причина в журнале', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const { ch } = await connectAdapter(s.home);
      try {
        const { line, ep } = await topicLine(s, gw, ch, 'Отчёт');
        s.fake.scenario({ method: 'deleteMessage', when: (p) => Number(p.message_id) === line.message_id, reply: reply.error(400, "Bad Request: message can't be deleted for everyone") });
        assert.equal(await press(s, line, 'верно'), null);
        await pump(gw, () => (currentText(line) === `⚙ ↪ #${ep} · Отчёт — верно` && currentButtons(line).length === 0) || null, { what: 'правки «— верно» после отказа' });
        assert.equal(deletesOf(s, line), 1, 'одна попытка: 400 не повторяется');
        assert.deepEqual(editsOf(s, line), ['editMessageText']);
        const d = q1<{ reason: string; status: string; fallback_text: string }>(s.home, 'SELECT reason, status, fallback_text FROM deletions WHERE tg_message_id = ?', line.message_id)!;
        assert.deepEqual({ ...d }, { reason: 'topic', status: 'dropped', fallback_text: `⚙ ↪ #${ep} · Отчёт — верно` });
        const j = readJournal(s.home);
        const dropped = j.find((l) => l.ev === 'delete_dropped' && l.reason === 'topic')!;
        assert.match(String(dropped.why), /can't be deleted/);
        assert.equal(j.find((l) => l.ev === 'topic_line_kept')?.edit, 'text');
      } finally {
        ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('строки уже нет (владелец удалил её сам) — удаление засчитано, правки нет', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const { ch } = await connectAdapter(s.home);
      try {
        const { line } = await topicLine(s, gw, ch, 'Почта');
        s.fake.scenario({ method: 'deleteMessage', when: (p) => Number(p.message_id) === line.message_id, reply: reply.error(400, 'Bad Request: message to delete not found') });
        assert.equal(await press(s, line, 'верно'), null);
        await pump(gw, () => q1<{ status: string }>(s.home, "SELECT status FROM deletions WHERE reason = 'topic'")?.status === 'sent' || null, { what: 'удаления, засчитанного без правки' });
        await settle(gw);
        assert.equal(deletesOf(s, line), 1, 'одна попытка');
        assert.deepEqual(editsOf(s, line), [], 'несуществующую строку не правят');
        const j = readJournal(s.home);
        assert.deepEqual(j.find((l) => l.ev === 'deleted' && l.reason === 'topic')?.already_gone, [line.message_id]);
        assert.ok(!j.some((l) => l.ev === 'topic_line_kept' || l.ev === 'delete_dropped'), 'не «оставлена»');
      } finally {
        ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('удаление не прошло за все попытки (5xx) — та же правка «— верно» без кнопок', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const { ch } = await connectAdapter(s.home);
      try {
        const { line, ep } = await topicLine(s, gw, ch, 'Банк');
        s.fake.scenario({ method: 'deleteMessage', when: (p) => Number(p.message_id) === line.message_id, reply: reply.error(502, 'Bad Gateway') });
        assert.equal(await press(s, line, 'верно'), null);
        await pump(gw, () => (currentText(line) === `⚙ ↪ #${ep} · Банк — верно` && currentButtons(line).length === 0) || null, { what: 'правки после всех попыток', step: '10s', timeoutMs: 20_000 });
        assert.equal(deletesOf(s, line), 5, 'пять попыток');
        assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM deletions WHERE tg_message_id = ?', line.message_id)?.status, 'dropped');
      } finally {
        ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('повторное нажатие, пока удаление в пути, — «уже использовано», правок нет, удаление одно', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const { ch } = await connectAdapter(s.home);
      try {
        const { line } = await topicLine(s, gw, ch, 'Звонки');
        // Telegram отвечает на удаление медленно: второе нажатие приходит, пока оно в пути.
        s.fake.scenario({ method: 'deleteMessage', when: (p) => Number(p.message_id) === line.message_id, times: 1, reply: reply.delay(1500) });
        assert.equal(await press(s, line, 'верно'), null);
        await pump(gw, () => deletesOf(s, line) === 1 || null, { what: 'удаления в пути' });
        assert.equal(await press(s, line, 'верно'), 'уже использовано');
        assert.equal(await press(s, line, 'не то'), 'уже использовано');
        await pump(gw, () => s.fake.wasDeleted(OWNER.id, line.message_id) || null, { what: 'удаления строки', timeoutMs: 15_000 });
        await settle(gw);
        assert.deepEqual(editsOf(s, line), [], 'удаляемую строку не правят');
        assert.equal(deletesOf(s, line), 1);
      } finally {
        ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('перезапуск шлюза между нажатием и удалением — строка удалена после перезапуска', async () => {
    const s = await setup();
    try {
      const g1 = await s.start();
      const a = await connectAdapter(s.home);
      const { line } = await topicLine(s, g1, a.ch, 'Ремонт');
      // Первая попытка — 5xx: удаление ждёт повтора (в базе), шлюз останавливается.
      s.fake.scenario({ method: 'deleteMessage', when: (p) => Number(p.message_id) === line.message_id, times: 1, reply: reply.error(500, 'Internal Server Error') });
      assert.equal(await press(s, line, 'верно'), null);
      await pump(g1, () => readJournal(s.home).some((l) => l.ev === 'delete_deferred') || null, { what: 'отложенного удаления' });
      a.ch.close();
      await g1.stop();
      assert.equal(q1<{ status: string }>(s.home, "SELECT status FROM deletions WHERE reason = 'topic'")?.status, 'pending');
      const g2 = await s.start();
      await pump(g2, () => s.fake.wasDeleted(OWNER.id, line.message_id) || null, { what: 'удаления после перезапуска', step: '2s' });
      // Отметка в базе — после ответа Telegram.
      await waitUntil(() => q1<{ status: string }>(s.home, "SELECT status FROM deletions WHERE reason = 'topic'")?.status === 'sent' || null, 5000, 'отметки sent');
      assert.deepEqual(editsOf(s, line), [], 'без правок');
      await g2.stop();
    } finally {
      await s.close();
    }
  });
});
