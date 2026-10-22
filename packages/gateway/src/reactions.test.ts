// Порядок реакций 👀 → 👌 в таблице reactions (TECH-SPEC 5.5; 0.3.2 — без ✍ при записи, развилка
// R-1 б): одна строка на сообщение Telegram; реакция того же события сменяется только более поздней по
// порядку — запоздалый 👀 не затирает 👌; правка (событие новее) — реакция к прежнему тексту снимается ⟨предл.⟩, затем
// 👀 и 👌 правки, и старое событие её уже не трогает; команды и закрытая тема реакций не получают. Гонки в пути —
// интеграционно, test/e2e m1-reactions-order. Полоса на поддельном клиенте: правка, пока 👀 в пути, — снятие следом;
// снимать нечего — без запроса; ✍ прежней версии, ждавший отправки, — не ставится (reaction_retired), стоящий ✍ сменяет 👀.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { openForGateway, sql } from 'stg-core';
import type { Ctx } from './context.js';
import { ReactionLane, requestCleared, requestProcessed, requestSeen } from './reactions.js';

const dirs: string[] = [];
after(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stg-reactions-'));
  dirs.push(dir);
  const { db } = openForGateway(path.join(dir, 'gateway.db'));
  let now = 1_000;
  const ctx = { db, clock: { now: () => now } } as unknown as Ctx;
  let update = 100;
  /** Событие из сообщения message_id чата 1. */
  const event = (kind: string, messageId: number): number => {
    const r = sql(db, "INSERT INTO events(kind, status, chat_id, message_id, update_id, created_at) VALUES (?, 'new', 1, ?, ?, ?)").run(kind, messageId, ++update, now);
    return Number(r.lastInsertRowid);
  };
  const row = (messageId: number) =>
    (sql(db, 'SELECT event_seq, want, status FROM reactions WHERE chat_id = 1 AND message_id = ?').get(messageId) as { event_seq: number; want: string; status: string } | undefined) ?? null;
  const tick = (): void => {
    now += 10;
  };
  return { db, ctx, event, row, tick };
}

describe('реакции: порядок 👀 → 👌 и правка (0.3.2, без ✍)', () => {
  it('до отдачи — строки нет (агент не на связи — на сообщении ничего); 👀 после отдачи; 👌 сменяет 👀; запоздалый 👀 👌 не затирает', () => {
    const { db, ctx, event, row, tick } = fresh();
    try {
      const seq = event('text', 50);
      assert.equal(row(50), null, 'запись реакции не заводит');
      assert.equal(requestSeen(ctx, [seq]), 1);
      assert.deepEqual({ ...row(50) }, { event_seq: seq, want: '👀', status: 'pending' });
      sql(db, "UPDATE reactions SET status = 'done', shown = want").run();
      tick();
      assert.equal(requestProcessed(ctx, [seq]), 1);
      assert.deepEqual({ ...row(50) }, { event_seq: seq, want: '👌', status: 'pending' });
      // Повторная отдача (аренда снята и взята снова, повтор К-5) после ответа — 👀 не возвращается.
      assert.equal(requestSeen(ctx, [seq]), 0);
      assert.equal(row(50)?.want, '👌');
      // Тот же 👌 ещё раз (reply и done) — без изменений.
      assert.equal(requestProcessed(ctx, [seq]), 0);
    } finally {
      db.close();
    }
  });

  it('правка — реакция к прежнему тексту снимается, затем 👀 и 👌 правки; старое событие строку не трогает; реакции не было — строки нет', () => {
    const { db, ctx, event, row, tick } = fresh();
    try {
      const seq = event('text', 60);
      requestSeen(ctx, [seq]);
      requestProcessed(ctx, [seq]);
      assert.equal(row(60)?.want, '👌');
      tick();
      const edit = event('edit', 60);
      assert.equal(requestCleared(ctx, [edit]), 1, 'правка записана — снять');
      assert.deepEqual({ ...row(60) }, { event_seq: edit, want: '', status: 'pending' });
      // Ответ агента на старое событие (до правки) — реакцию держит правка.
      assert.equal(requestProcessed(ctx, [seq]), 0);
      assert.equal(row(60)?.want, '');
      tick();
      assert.equal(requestSeen(ctx, [edit]), 1, '👀 правки сменяет «снять»');
      assert.equal(requestProcessed(ctx, [edit]), 1);
      assert.deepEqual({ ...row(60) }, { event_seq: edit, want: '👌', status: 'pending' });
      // Вторая правка того же сообщения — снова снять.
      tick();
      const edit2 = event('edit', 60);
      assert.equal(requestCleared(ctx, [edit2]), 1);
      assert.equal(row(60)?.want, '');
      // Правка сообщения, на котором реакции не было (агент его не видел), — строки нет и не появляется.
      event('text', 61);
      const edit3 = event('edit', 61);
      assert.equal(requestCleared(ctx, [edit3]), 0);
      assert.equal(row(61), null);
      // Не правка — снимать нечего.
      const plain = event('text', 62);
      requestSeen(ctx, [plain]);
      assert.equal(requestCleared(ctx, [plain]), 0);
    } finally {
      db.close();
    }
  });

  it('команда и закрытая тема — без реакций; ✍ прежней версии сменяет 👀 того же события', () => {
    const { db, ctx, event, row } = fresh();
    try {
      const cmd = event('command', 70);
      assert.equal(requestSeen(ctx, [cmd]), 0);
      assert.equal(row(70), null);
      const closed = event('closed_topic', 71);
      assert.equal(requestSeen(ctx, [closed]), 0);
      assert.equal(requestProcessed(ctx, [closed]), 0);
      assert.equal(row(71), null);
      // Строка 0.3.1: ✍ стоит на сообщении, которое агент ещё не видел.
      const old = event('text', 72);
      sql(db, "INSERT INTO reactions(chat_id, message_id, event_seq, want, shown, status, created_at) VALUES (1, 72, ?, '✍', '✍', 'done', 0)").run(old);
      assert.equal(requestSeen(ctx, [old]), 1);
      assert.equal(row(72)?.want, '👀');
    } finally {
      db.close();
    }
  });
});

/** Полоса реакций на поддельном клиенте Telegram: запросы копятся в calls, ответ каждого отдаёт тест (answer). */
function laneOn(db: ReturnType<typeof openForGateway>['db']) {
  let now = 5_000;
  const calls: Array<{ emoji: string; message_id: number; answer: () => void }> = [];
  const journal: Array<Record<string, unknown>> = [];
  const ctx = {
    db,
    clock: {
      now: () => now,
      sleep: async () => undefined,
      setTimeout: () => ({ cancel: () => undefined }),
    },
    api: {
      call: (_method: string, params: { message_id: number; reaction: Array<{ emoji: string }> }) =>
        new Promise<void>((resolve) => {
          // Пустой список — «снять реакцию» (правка, 0.3.2): emoji ''.
          calls.push({ emoji: params.reaction[0]?.emoji ?? '', message_id: params.message_id, answer: resolve });
        }),
      redact: (x: string) => x,
    },
    disk: { isFull: false, check: () => false },
    journal: { write: (ev: string, o: Record<string, unknown>) => journal.push({ ev, ...o }) },
  } as unknown as Ctx;
  const lane = new ReactionLane(ctx, { flood: new Map(), signal: new AbortController().signal });
  /** Дождаться условия (полоса асинхронна; часы не идут — шаги без ожидания). */
  const until = async (what: string, pred: () => boolean): Promise<void> => {
    for (let i = 0; i < 500; i++) {
      if (pred()) return;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error(`не дождался: ${what}`);
  };
  return { ctx, lane, calls, journal, until, tick: () => (now += 100) };
}

describe('полоса реакций: правка в пути, снимать нечего, ✍ прежней версии (0.3.2)', () => {
  it('👀 в пути, записана правка — 👀 встаёт, следом снимается (пустой список); 👀 правки — снова 👀', async () => {
    const { db, event, row } = fresh();
    const { ctx, lane, calls, until, tick } = laneOn(db);
    try {
      const seq = event('text', 80);
      sql(db, 'INSERT INTO latency(event_seq, t_update, t_admit) VALUES (?, 4900, 4950)').run(seq);
      requestSeen(ctx, [seq]);
      lane.kick();
      await until('запроса 👀', () => calls.length === 1);
      // Пока 👀 в пути, записана правка того же сообщения — строка переходит к ней: снять.
      tick();
      const edit = event('edit', 80);
      sql(db, 'INSERT INTO latency(event_seq, t_update, t_admit) VALUES (?, 5050, 5060)').run(edit);
      assert.equal(requestCleared(ctx, [edit]), 1);
      tick();
      calls[0]!.answer();
      await until('запроса «снять»', () => calls.length === 2);
      assert.equal(calls[1]!.emoji, '', 'снятие — пустой список');
      calls[1]!.answer();
      await until('отметки done', () => row(80)?.status === 'done');
      assert.deepEqual({ ...row(80) }, { event_seq: edit, want: '', status: 'done' });
      const t = (q: number) => sql(db, 'SELECT t_receipt, t_eyes FROM latency WHERE event_seq = ?').get(q) as { t_receipt: number | null; t_eyes: number | null };
      assert.deepEqual({ ...t(seq) }, { t_receipt: 5_200, t_eyes: 5_200 }, '👀 события встал');
      assert.deepEqual({ ...t(edit) }, { t_receipt: null, t_eyes: null }, 'снятие — не реакция: времени нет');
      requestSeen(ctx, [edit]);
      lane.kick();
      await until('👀 правки', () => calls.length === 3);
      assert.equal(calls[2]!.emoji, '👀');
      calls[2]!.answer();
      await until('👀 правки встал', () => row(80)?.status === 'done');
    } finally {
      await lane.stop();
      db.close();
    }
  });

  it('снимать нечего (👀 не встал — 400), правка: запроса нет, строка done, в журнале reaction_kept', async () => {
    const { db, event, row } = fresh();
    const { ctx, lane, calls, journal, until, tick } = laneOn(db);
    try {
      const seq = event('text', 90);
      requestSeen(ctx, [seq]);
      sql(db, "UPDATE reactions SET status = 'failed' WHERE message_id = 90").run();
      tick();
      const edit = event('edit', 90);
      requestCleared(ctx, [edit]);
      assert.equal(row(90)?.status, 'pending');
      lane.kick();
      await until('отметки done', () => row(90)?.status === 'done');
      assert.equal(calls.length, 0, 'запроса нет');
      assert.ok(journal.some((l) => l.ev === 'reaction_kept' && l.seq === edit && l.emoji === ''));
    } finally {
      await lane.stop();
      db.close();
    }
  });

  it('✍ прежней версии ждал отправки (шлюз остановили до запроса) — не ставится: done, reaction_retired; затем 👀 уходит', async () => {
    const { db, event, row } = fresh();
    const { ctx, lane, calls, journal, until } = laneOn(db);
    try {
      const seq = event('text', 100);
      sql(db, "INSERT INTO reactions(chat_id, message_id, event_seq, want, shown, status, created_at) VALUES (1, 100, ?, '✍', NULL, 'pending', 0)").run(seq);
      lane.kick();
      await until('отметки done', () => row(100)?.status === 'done');
      assert.equal(calls.length, 0, '✍ не ставится');
      assert.ok(journal.some((l) => l.ev === 'reaction_retired' && l.seq === seq && l.emoji === '✍'));
      requestSeen(ctx, [seq]);
      lane.kick();
      await until('запроса 👀', () => calls.length === 1);
      assert.equal(calls[0]!.emoji, '👀');
      calls[0]!.answer();
      await until('👀 встал', () => row(100)?.status === 'done' && row(100)?.want === '👀');
    } finally {
      await lane.stop();
      db.close();
    }
  });
});
