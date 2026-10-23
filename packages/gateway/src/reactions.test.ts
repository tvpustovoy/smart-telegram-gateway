// Порядок реакций 👀 → 👌 в таблице reactions (TECH-SPEC 5.5; 0.3.2 — без ✍ при записи, развилка
// R-1 б): одна строка на сообщение Telegram; реакция того же события сменяется только более поздней по
// порядку — запоздалый 👀 не затирает 👌; правка (событие новее) — реакция к прежнему тексту снимается ⟨предл.⟩, затем
// 👀 и 👌 правки, и старое событие её уже не трогает; команды и закрытая тема реакций не получают. Гонки в пути —
// интеграционно, test/e2e m1-reactions-order. Полоса на поддельном клиенте: правка, пока 👀 в пути, — снятие следом;
// снимать нечего — без запроса; ✍ прежней версии, ждавший отправки, — не ставится (reaction_retired), стоящий ✍ сменяет 👀.
// Квитанция своё сделала (0.3.6, #52; A12.9): ответ ушёл — снять (только у обработанного события; правка, которую агент ещё
// не видел, строку держит); ответ не ушёл — 👌 вместо 👀 (снятая не возвращается, ответ уже был — нет); следующее сообщение
// владельца — снять его 👌 в этом чате за неделю (👀, чужие сообщения, другой чат, старше недели — не трогаются); ошибка
// Telegram на снятии — повтор. Находка проверки (A12.11): 👌 на сообщениях, ответ на которые ушёл (так ставили версии до
// 0.3.6 и ui.clear_receipts: false), следующее сообщение не снимает — снимается только «закрыто без ответа»; в полосе
// снятия идут после 👀 и 👌.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { TelegramApiError, openForGateway, sql } from 'stg-core';
import type { Ctx } from './context.js';
import { REACTIONS_KEEP_MS, ReactionLane, clearReceipts, requestAnswerLost, requestAnswered, requestCleared, requestClosedCleared, requestProcessed, requestSeen } from './reactions.js';

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
  /** Событие из сообщения message_id чата (по умолчанию 1) от участника subject (по умолчанию владелец). */
  const event = (kind: string, messageId: number, o: { chat?: number; subject?: string } = {}): number => {
    const r = sql(db, "INSERT INTO events(kind, status, chat_id, message_id, update_id, subject_id, created_at) VALUES (?, 'new', ?, ?, ?, ?, ?)").run(
      kind,
      o.chat ?? 1,
      messageId,
      ++update,
      o.subject ?? 'owner',
      now,
    );
    return Number(r.lastInsertRowid);
  };
  const row = (messageId: number, chat = 1) =>
    (sql(db, 'SELECT event_seq, want, status FROM reactions WHERE chat_id = ? AND message_id = ?').get(chat, messageId) as { event_seq: number; want: string; status: string } | undefined) ??
    null;
  const tick = (ms = 10): void => {
    now += ms;
  };
  /** Событие обработано (reply или done). */
  const processed = (seq: number): void => {
    sql(db, "UPDATE events SET status = 'processed', processed_at = ? WHERE seq = ?").run(now, seq);
  };
  /** Реакция встала (отметка полосы). */
  const shown = (messageId: number, chat = 1): void => {
    sql(db, "UPDATE reactions SET shown = want, status = 'done' WHERE chat_id = ? AND message_id = ?").run(chat, messageId);
  };
  /** Ответ агента на событие в outbox (status — его итог). */
  const answer = (seq: number, status: string): void => {
    sql(db, "INSERT INTO outbox(event_seq, chat_id, kind, text, origin, status, created_at) VALUES (?, 1, 'agent', 'ответ', 'agent', ?, ?)").run(seq, status, now);
  };
  return { db, ctx, event, row, tick, processed, shown, answer };
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

describe('квитанция своё сделала (0.3.6, #52; A12.9): ответ снимает реакцию, done — 👌 до следующего сообщения владельца', () => {
  it('ответ ушёл — снять: только у обработанного события; правка, которую агент ещё не видел, строку держит; реакции не было — строки нет', () => {
    const { db, ctx, event, row, tick, processed, shown } = fresh();
    try {
      const seq = event('text', 200);
      requestSeen(ctx, [seq]);
      shown(200);
      // Событие ещё не обработано (ответ на событие, отданное не этой аренде) — реакцию не трогать: оно придёт агенту.
      assert.equal(requestAnswered(ctx, [seq]), 0);
      assert.equal(row(200)?.want, '👀');
      processed(seq);
      tick();
      assert.equal(requestAnswered(ctx, [seq]), 1, 'ответ ушёл — снять');
      assert.deepEqual({ ...row(200) }, { event_seq: seq, want: '', status: 'pending' });
      assert.equal(requestAnswered(ctx, [seq]), 0, 'уже снята — без изменений');
      // Запоздалого 👀 на обработанное событие не бывает (delivered его не трогает), а 👌 после done — только у необработанного.
      // Правка записана, пока ответ на прежний текст был в пути: строку держит правка — ответ на старое её не снимает.
      const seq2 = event('text', 201);
      requestSeen(ctx, [seq2]);
      processed(seq2);
      tick();
      const edit = event('edit', 201);
      assert.equal(requestCleared(ctx, [edit]), 1);
      tick();
      requestSeen(ctx, [edit]);
      assert.equal(requestAnswered(ctx, [seq2]), 0, 'строку держит правка');
      assert.deepEqual({ ...row(201) }, { event_seq: edit, want: '👀', status: 'pending' });
      // Ответ на правку — снимает её 👀.
      processed(edit);
      assert.equal(requestAnswered(ctx, [edit]), 1);
      assert.equal(row(201)?.want, '');
      // Реакции не было (ответ раньше, чем событие отдано) — строки нет и не появляется; не сообщение — тоже.
      const quick = event('text', 202);
      processed(quick);
      assert.equal(requestAnswered(ctx, [quick]), 0);
      assert.equal(row(202), null);
      // Ответ ушёл после done (👌) — снять и 👌: знак ответа — сам ответ.
      const closed = event('text', 203);
      requestSeen(ctx, [closed]);
      processed(closed);
      requestProcessed(ctx, [closed]);
      shown(203);
      assert.equal(requestAnswered(ctx, [closed]), 1);
      assert.equal(row(203)?.want, '');
    } finally {
      db.close();
    }
  });

  it('ответ не ушёл («стоп», Telegram не принял) — 👌 вместо 👀; реакции не было — 👌; ответ уже был или 👌 снят — не возвращается', () => {
    const { db, ctx, event, row, tick, processed, shown, answer } = fresh();
    try {
      const seq = event('text', 210);
      requestSeen(ctx, [seq]);
      shown(210);
      // Не обработано — не трогать.
      assert.equal(requestAnswerLost(ctx, [seq]), 0);
      processed(seq);
      answer(seq, 'dropped');
      tick();
      assert.equal(requestAnswerLost(ctx, [seq]), 1);
      assert.deepEqual({ ...row(210) }, { event_seq: seq, want: '👌', status: 'pending' });
      // Реакции не было — 👌, как у done.
      const none = event('text', 211);
      processed(none);
      assert.equal(requestAnswerLost(ctx, [none]), 1);
      assert.equal(row(211)?.want, '👌');
      // Ответ на это событие уже ушёл (снят) — второй брошенный ответ 👌 не ставит.
      const twice = event('text', 212);
      requestSeen(ctx, [twice]);
      processed(twice);
      answer(twice, 'sent');
      requestAnswered(ctx, [twice]);
      answer(twice, 'dropped');
      assert.equal(requestAnswerLost(ctx, [twice]), 0);
      assert.equal(row(212)?.want, '');
      // done → 👌 → следующее сообщение владельца сняло его → брошенный ответ по своей инициативе к № не возвращает 👌.
      const gone = event('text', 213);
      requestSeen(ctx, [gone]);
      processed(gone);
      requestProcessed(ctx, [gone]);
      shown(213);
      tick();
      // Снимаются все 👌 владельца в чате: и от брошенных ответов выше (№ 210, 211), и от done (№ 213).
      assert.equal(requestClosedCleared(ctx, 1, 'owner'), 3);
      assert.equal(requestAnswerLost(ctx, [gone]), 0);
      assert.equal(row(213)?.want, '');
    } finally {
      db.close();
    }
  });

  it('следующее сообщение владельца — снять его 👌 в этом чате за неделю; 👀, чужие сообщения, другой чат и старше недели — не трогаются', () => {
    const { db, ctx, event, row, tick, processed, shown } = fresh();
    try {
      const mk = (messageId: number, o: { chat?: number; subject?: string; done?: boolean } = {}): number => {
        const seq = event('text', messageId, o);
        requestSeen(ctx, [seq]);
        if (o.done !== false) {
          processed(seq);
          requestProcessed(ctx, [seq]);
        }
        shown(messageId, o.chat ?? 1);
        return seq;
      };
      const old = mk(220);
      tick(REACTIONS_KEEP_MS + 1000);
      const a = mk(221);
      const b = mk(222);
      mk(223, { done: false });
      mk(224, { subject: 'anya' });
      mk(225, { chat: 2 });
      tick();
      assert.equal(requestClosedCleared(ctx, 1, 'owner'), 2, 'оба 👌 владельца в этом чате за неделю');
      assert.deepEqual([row(221)?.want, row(222)?.want], ['', '']);
      assert.deepEqual([row(221)?.event_seq, row(222)?.event_seq], [a, b], 'строка — того же события');
      assert.equal(row(220)?.want, '👌', 'старше недели — не трогается');
      assert.equal(row(220)?.event_seq, old);
      assert.equal(row(223)?.want, '👀', '👀 — агент ещё не ответил');
      assert.equal(row(224)?.want, '👌', 'сообщение другого участника');
      assert.equal(row(225, 2)?.want, '👌', 'другой чат');
      assert.equal(requestClosedCleared(ctx, 1, 'owner'), 0, 'снимать больше нечего');
    } finally {
      db.close();
    }
  });

  it('👌 на сообщении, ответ на которое ушёл (версии до 0.3.6, ui.clear_receipts: false), следующее сообщение не снимает: только «закрыто без ответа» (A12.11)', () => {
    const { db, ctx, event, row, tick, processed, shown, answer } = fresh();
    try {
      // Неделя под прежней версией: на каждый вопрос ответ ушёл, на сообщении — 👌 (reply ставил 👌 сразу).
      const legacy: number[] = [];
      for (let i = 0; i < 150; i++) {
        const m = 300 + i;
        const seq = event('text', m);
        requestSeen(ctx, [seq]);
        processed(seq);
        requestProcessed(ctx, [seq]);
        answer(seq, 'sent');
        shown(m);
        legacy.push(m);
        tick();
      }
      // «Закрыто без ответа»: done; ответ брошен целиком (ни одна строка ответа не sent).
      const closed = event('text', 460);
      requestSeen(ctx, [closed]);
      processed(closed);
      requestProcessed(ctx, [closed]);
      shown(460);
      const lost = event('text', 461);
      requestSeen(ctx, [lost]);
      processed(lost);
      answer(lost, 'dropped');
      assert.equal(requestAnswerLost(ctx, [lost]), 1);
      shown(461);
      tick();
      assert.equal(requestClosedCleared(ctx, 1, 'owner'), 2, 'только 👌 «закрыто без ответа», без пачки на 150 снятий');
      assert.deepEqual([row(460)?.want, row(461)?.want], ['', '']);
      assert.ok(legacy.every((m) => row(m)?.want === '👌' && row(m)?.status === 'done'), '👌 прежней версии на отвеченных — как были');
      assert.equal(requestClosedCleared(ctx, 1, 'owner'), 0, 'снимать больше нечего');
    } finally {
      db.close();
    }
  });

  it('ui.clear_receipts — по умолчанию да; false — нет; без настроек — да', () => {
    assert.equal(clearReceipts({ config: { ui: { clear_receipts: true } } } as unknown as Ctx), true);
    assert.equal(clearReceipts({ config: { ui: { clear_receipts: false } } } as unknown as Ctx), false);
    assert.equal(clearReceipts({} as unknown as Ctx), true);
  });
});

describe('полоса реакций: снятие квитанции (0.3.6, #52)', () => {
  it('ответ ушёл — пустой список; ошибка Telegram на снятии (502) — повтор, затем снято; 👀 в пути, ответ ушёл — 👀 встаёт, следом снятие', async () => {
    const { db, event, row, processed } = fresh();
    const { ctx, lane, calls, journal, until, tick } = laneOn(db);
    try {
      const seq = event('text', 230);
      requestSeen(ctx, [seq]);
      lane.kick();
      await until('запроса 👀', () => calls.length === 1);
      // Пока 👀 в пути, агент ответил и ответ ушёл — снять.
      processed(seq);
      assert.equal(requestAnswered(ctx, [seq]), 1);
      calls[0]!.answer();
      await until('запроса «снять»', () => calls.length === 2);
      assert.equal(calls[1]!.emoji, '');
      calls[1]!.answer();
      await until('снятие отмечено', () => row(230)?.status === 'done');
      assert.deepEqual({ ...row(230) }, { event_seq: seq, want: '', status: 'done' });
      assert.ok(journal.some((l) => l.ev === 'reaction' && l.seq === seq && l.cleared === true));
      // Снятие с ошибкой Telegram (502) — повтор (как у любой реакции).
      const seq2 = event('text', 231);
      sql(db, "INSERT INTO reactions(chat_id, message_id, event_seq, want, shown, status, created_at) VALUES (1, 231, ?, '👌', '👌', 'done', 0)").run(seq2);
      processed(seq2);
      assert.equal(requestClosedCleared(ctx, 1, 'owner'), 1);
      type Call = (method: string, params: unknown) => Promise<void>;
      const api = ctx.api as unknown as { call: Call };
      const ok = api.call;
      let first = true;
      api.call = (method, params) => {
        if (first) {
          first = false;
          return Promise.reject(new TelegramApiError(method, 502, 'Bad Gateway', null));
        }
        return ok(method, params);
      };
      lane.kick();
      await until('отказа 502', () => journal.some((l) => l.ev === 'reaction_failed' && l.seq === seq2 && l.final === false));
      assert.equal(row(231)?.status, 'pending', 'ждёт повтора');
      tick();
      sql(db, 'UPDATE reactions SET next_try_at = 0 WHERE message_id = 231').run();
      lane.kick();
      await until('повтора «снять»', () => calls.length === 3);
      assert.equal(calls[2]!.emoji, '');
      calls[2]!.answer();
      await until('снятие отмечено', () => row(231)?.status === 'done' && row(231)?.want === '');
    } finally {
      await lane.stop();
      db.close();
    }
  });

  it('снятия — после 👀 и 👌: пять снятий, поставленных раньше, не задерживают 👀 нового сообщения и 👌 done (A12.11)', async () => {
    const { db, event, row, processed } = fresh();
    const { ctx, lane, calls, until, tick } = laneOn(db);
    try {
      const closed = [240, 241, 242, 243, 244];
      for (const m of closed) {
        const seq = event('text', m);
        processed(seq);
        sql(db, "INSERT INTO reactions(chat_id, message_id, event_seq, want, shown, status, created_at) VALUES (1, ?, ?, '👌', '👌', 'done', 0)").run(m, seq);
      }
      // На другом сообщении 👀: агент его видел и ещё не закрыл.
      const other = event('text', 246);
      sql(db, "INSERT INTO reactions(chat_id, message_id, event_seq, want, shown, status, created_at) VALUES (1, 246, ?, '👀', '👀', 'done', 0)").run(other);
      // Владелец написал дальше — пять 👌 снять (👀 не трогается); затем агент увидел новое — 👀, и закрыл то — 👌.
      tick();
      const next = event('text', 245);
      assert.equal(requestClosedCleared(ctx, 1, 'owner'), 5);
      tick();
      requestSeen(ctx, [next]);
      tick();
      processed(other);
      assert.equal(requestProcessed(ctx, [other]), 1);
      lane.kick();
      await until('первого запроса', () => calls.length === 1);
      assert.deepEqual({ emoji: calls[0]!.emoji, message_id: calls[0]!.message_id }, { emoji: '👀', message_id: 245 }, '👀 — первым, хотя снятия поставлены раньше');
      calls[0]!.answer();
      await until('второго запроса', () => calls.length === 2);
      assert.deepEqual({ emoji: calls[1]!.emoji, message_id: calls[1]!.message_id }, { emoji: '👌', message_id: 246 }, '👌 done — тоже раньше снятий');
      calls[1]!.answer();
      for (let i = 2; i <= 6; i++) {
        await until(`снятия ${i - 1}`, () => calls.length === i + 1);
        assert.equal(calls[i]!.emoji, '', `запрос ${i + 1} — снятие`);
        calls[i]!.answer();
      }
      assert.deepEqual(calls.slice(2).map((c) => c.message_id), closed, 'снятия — по порядку постановки');
      await until('все сняты', () => closed.every((m) => row(m)?.status === 'done' && row(m)?.want === ''));
    } finally {
      await lane.stop();
      db.close();
    }
  });
});
