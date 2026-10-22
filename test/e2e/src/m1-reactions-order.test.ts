// Квитанции реакциями (J-1; TECH-SPEC 5.5) — 0.3.2, развилка R-1 «б» (решение после проверки на реальном боте):
// 👀 — агент увидел (delivered), 👌 — агент ответил или done; ✍ шлюз не ставит. Здесь:
// - агент не на связи — на сообщениях ничего (видно по ⚪ и 📥 N); текстовой квитанции нет; агент пришёл — 👀 на каждом
//   по порядку, затем 👌 после reply и done; «записал» (L-2) — по записи (t_admit), t_eyes — когда встал 👀;
// - повторная отдача того же события (аренда снята и взята снова) — второго 👀 нет;
// - 50 пересланных после простоя: ничего, затем одной пачкой агенту — 👀 на каждом; предел реакций 4 в секунду в
//   подделке, шаг в чат не меньше 250 мс; 429 — общая пауза чата, текстовых квитанций нет; повтор той же реакции
//   подряд — только при неудачной попытке в журнале («как минимум один раз»);
// - реакция не встала (400) — только журнал (reaction_failed final), на сообщении ничего, текстовой квитанции нет;
// - 👀 в пути, агент ответил, 👀 отказал — 👌 встаёт (порядок в базе — модульно, packages/gateway reactions.test);
// - правка: реакция к прежнему тексту снимается ⟨предл.⟩, затем 👀 и 👌; вторая правка, пока агента нет, — снимать
//   нечего: запроса нет (reaction_kept);
// - первый старт 0.3.2 на базе 0.3.1: стоящий ✍ не трогается и сменяется 👀 своим ходом; ✍, ждавший отправки, не
//   ставится (reaction_retired); на обработанном ✍ так и остаётся ⟨предл.⟩;
// - убийство в точке in_send на 👀 (Telegram ответил, отметки нет) — после старта 👀 ставится ещё раз, затем 👌.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { errors, reply } from 'stg-fake-telegram';
import { count, pump, q1, readJournal, shiftClockFile, sleep, waitUntil } from './harness.js';
import { OTHER, OWNER, botTexts, chatMessages, isEyes, isPen, reactionOf, reactionsOf, receiptCounts, seeingAgent, setup, waitRecorded } from './m1-common.js';

const NO_TEXT_RECEIPT = (t: string): boolean => /^№ \d/.test(t);

describe('M1 · реакции 👀 → 👌 (0.3.2, без ✍): агент не на связи — ничего; пачка; отказ — только журнал; правка; первый старт', () => {
  it('агент не на связи — на каждом ничего, текстовой квитанции нет; пришёл — 👀 на каждом, затем 👌 после reply и done', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const ups = [s.fake.builder.text(OWNER, 'первое'), s.fake.builder.text(OWNER, 'второе'), s.fake.builder.forward(OWNER, { type: 'user', user: OTHER }, 'чужое')];
      s.fake.push(...ups);
      await waitRecorded(s, gw, ups);
      for (let i = 0; i < 12; i++) await gw.advance('1s');
      await sleep(50);
      for (const u of ups) assert.deepEqual(reactionsOf(s.fake, u), [], 'агент не на связи — на сообщении ничего (✍ нет)');
      assert.equal(s.fake.callsOf('setMessageReaction').length, 0);
      assert.ok(!botTexts(s.fake).some(NO_TEXT_RECEIPT), 'текстовой квитанции нет');
      // L-2: «записал» — по записи (t_admit); реакции ещё нет.
      assert.equal(count(s.home, 'SELECT count(*) AS n FROM latency WHERE t_admit >= t_update AND t_receipt IS NULL AND t_eyes IS NULL'), 3);
      const seqs = ups.map((u) => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)!.seq);
      // Агент пришёл: события отданы, delivered — 👀 на каждом, по порядку.
      const ag = await seeingAgent(s);
      try {
        await pump(gw, () => ups.every((u) => reactionOf(s.fake, u) === '👀') || null, { what: '👀 на всех трёх' });
        const order = s.fake.reactions.filter((r) => r.chat_id === OWNER.id && JSON.stringify(r.reaction).includes('👀')).map((r) => r.message_id);
        assert.deepEqual(order, ups.map((u) => u.message!.message_id), '👀 — по порядку');
        // Отметка в базе — после ответа Telegram: дождаться её.
        await waitUntil(
          () => count(s.home, `SELECT count(*) AS n FROM latency WHERE event_seq IN (${seqs.join(',')}) AND t_eyes >= t_delivered AND t_delivered >= t_admit`) === 3 || null,
          5000,
          't_eyes — после отдачи',
        );
        // reply на первое и done на второе и третье — 👌.
        assert.equal((await ag.ch.reply(seqs[0]!, 'принял', ag.turn)).type, 'ack');
        assert.equal((await ag.ch.request('done', { seqs: [seqs[1], seqs[2]] })).type, 'ack');
        await pump(gw, () => ups.every((u) => reactionOf(s.fake, u) === '👌') || null, { what: '👌 на всех трёх' });
        for (const u of ups) assert.deepEqual(reactionsOf(s.fake, u), ['👀', '👌'], `${u.update_id}`);
        assert.ok(!readJournal(s.home).some((l) => l.ev === 'receipt_fallback'), 'receipt_fallback');
      } finally {
        ag.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('повторная отдача (аренда снята и взята снова) — второго 👀 нет; агент ответил — 👌', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const u = s.fake.builder.text(OWNER, 'мысль');
      s.fake.push(u);
      await waitRecorded(s, gw, u);
      const seq = q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)!.seq;
      const a1 = await seeingAgent(s);
      await pump(gw, () => reactionOf(s.fake, u) === '👀' || null, { what: '👀' });
      a1.close();
      await gw.waitForJournal((l) => l.ev === 'lease_released');
      const a2 = await seeingAgent(s);
      try {
        await a2.ch.waitEvent(seq);
        await waitUntil(() => q1(s.home, "SELECT 1 FROM events WHERE seq = ? AND status = 'delivered'", seq), 5000, 'повторной отдачи');
        for (let i = 0; i < 3; i++) await gw.advance('1s');
        await sleep(50);
        assert.deepEqual(reactionsOf(s.fake, u), ['👀'], 'второго 👀 нет');
        assert.equal((await a2.ch.reply(seq, 'готово', a2.turn)).type, 'ack');
        await pump(gw, () => reactionOf(s.fake, u) === '👌' || null, { what: '👌' });
        assert.deepEqual(reactionsOf(s.fake, u), ['👀', '👌']);
      } finally {
        a2.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('50 пересланных после простоя: пока агента нет — ничего, затем одной пачкой агенту — 👀 на каждом; предел реакций 4/с в подделке, шаг ≥ 250 мс, текстовых квитанций нет', async () => {
    const s = await setup({ fake: { reactionRateLimit: { perSecond: 4, retryAfter: 1 } } });
    try {
      const gw = await s.start();
      const ups = Array.from({ length: 50 }, (_, i) => s.fake.builder.forward(OWNER, { type: 'user', user: OTHER }, `чужое ${i + 1}`));
      s.fake.push(...ups);
      // Одним запросом, а не 50 открытиями базы на каждом шаге: подделка Telegram живёт в этом же процессе.
      const ids = ups.map((u) => u.update_id).join(',');
      await pump(gw, () => count(s.home, `SELECT count(*) AS n FROM updates u JOIN events e ON e.update_id = u.update_id WHERE u.update_id IN (${ids}) AND u.status = 'admitted'`) === 50 || null, {
        what: 'записи всех 50',
      });
      // Агента нет — ни ✍, ни 👀 (0.3.2).
      for (let i = 0; i < 6; i++) await gw.advance('1s');
      assert.equal(s.fake.callsOf('setMessageReaction').length, 0, 'пока агента нет — реакций нет');
      const ag = await seeingAgent(s);
      try {
        await pump(gw, () => ups.every((u) => reactionOf(s.fake, u) === '👀') || null, { step: '500ms', timeoutMs: 60_000, what: '👀 на всех 50' });
      } finally {
        ag.close();
      }
      for (let i = 0; i < 12; i++) await gw.advance('1s');
      await sleep(50);
      assert.equal(receiptCounts(s.fake).size, 0, 'текстовых квитанций нет');
      assert.ok(!chatMessages(s.fake).some((x) => NO_TEXT_RECEIPT(x.text ?? '')));
      // Повтор той же реакции подряд допустим только как «как минимум один раз»: запрос истёк у шлюза (предел — по
      // настоящему времени), а Telegram её уже поставил, — тогда в журнале у этого события есть неудачная попытка той же
      // реакции, а «reaction» по нему всё равно одна (проверка ниже). Без такой попытки повтор — ошибка.
      const journal = readJournal(s.home);
      for (const u of ups) {
        const history = reactionsOf(s.fake, u);
        const collapsed = history.filter((e, i) => i === 0 || e !== history[i - 1]);
        assert.deepEqual(collapsed, ['👀'], `${u.update_id}`);
        if (history.length > collapsed.length) {
          const seq = q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)!.seq;
          for (const e of new Set(history.filter((x, i) => i > 0 && x === history[i - 1]))) {
            assert.ok(
              journal.some((l) => l.ev === 'reaction_failed' && l.seq === seq && l.emoji === e && l.rate_limited !== true),
              `${u.update_id}: ${e} дважды без неудачной попытки в журнале — ${JSON.stringify(history)}`,
            );
          }
        }
      }
      // Шаг — по часам шлюза: реакция встаёт (ответ Telegram), следующая в чат уходит не раньше чем через 250 мс.
      const lines = journal.filter((l) => l.ev === 'reaction');
      assert.deepEqual([lines.filter((l) => l.emoji === '✍').length, lines.filter((l) => l.emoji === '👀').length], [0, 50]);
      const marks = lines.map((l) => Date.parse(String(l.at)));
      for (let i = 1; i < marks.length; i++) assert.ok(marks[i]! - marks[i - 1]! >= 250, `шаг реакций ${marks[i]! - marks[i - 1]!} мс`);
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('429 retry_after=2 на 👀 — пауза чата общая, 👀 после неё; 400 — без повтора, только журнал; обрыв и 502 — повтор', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const b = s.fake.builder;
      const [r429, r400, rDrop, r502] = [b.text(OWNER, '429'), b.text(OWNER, '400'), b.text(OWNER, 'обрыв'), b.text(OWNER, '502')];
      const on = (u: typeof r429) => (p: Record<string, unknown>) => isEyes(p) && Number(p.message_id) === u!.message!.message_id;
      s.fake.scenario({ method: 'setMessageReaction', when: on(r429), times: 1, reply: errors.tooManyRequests(2) });
      s.fake.scenario({ method: 'setMessageReaction', when: on(r400), times: 1, reply: reply.error(400, 'Bad Request: message to react not found') });
      s.fake.scenario({ method: 'setMessageReaction', when: on(rDrop), times: 1, reply: reply.drop() });
      s.fake.scenario({ method: 'setMessageReaction', when: on(r502), times: 1, reply: errors.serverError(502) });
      const ups = [r429!, r400!, rDrop!, r502!];
      s.fake.push(...ups);
      await waitRecorded(s, gw, ups);
      const ag = await seeingAgent(s);
      try {
        await pump(gw, () => [r429, rDrop, r502].every((u) => reactionOf(s.fake, u!) === '👀') || null, { what: '👀 после 429, обрыва и 502' });
      } finally {
        ag.close();
      }
      const j = readJournal(s.home);
      const seqOf = (u: (typeof ups)[number]): number => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)!.seq;
      const f429 = j.find((l) => l.ev === 'reaction_failed' && l.seq === seqOf(r429!) && l.rate_limited === true);
      assert.ok(f429, 'reaction_failed rate_limited');
      // 429 — общая пауза чата: следующая реакция в чат — не раньше чем через 2 с (по часам шлюза).
      const after429 = j.filter((l) => l.ev === 'reaction' && Date.parse(String(l.at)) >= Date.parse(String(f429.at)));
      assert.ok(after429.length && Date.parse(String(after429[0]!.at)) - Date.parse(String(f429.at)) >= 2000, 'пауза 429');
      assert.ok(j.some((l) => l.ev === 'reaction_failed' && l.seq === seqOf(r400!) && l.final === true), '400 — отказ, final');
      assert.equal(s.fake.callsOf('setMessageReaction').filter((c) => on(r400)(c.params)).length, 1, 'на 400 повтора нет');
      assert.equal(reactionOf(s.fake, r400!), null, '👀 не встал — на сообщении ничего');
      assert.ok(j.some((l) => l.ev === 'reaction_failed' && l.seq === seqOf(rDrop!) && l.final === false), 'обрыв — повтор');
      assert.ok(j.some((l) => l.ev === 'reaction_failed' && l.seq === seqOf(r502!) && l.final === false), '502 — повтор');
      // Реакция не встала — только журнал: текстовой квитанции нет.
      for (let i = 0; i < 12; i++) await gw.advance('1s');
      await sleep(50);
      assert.ok(!botTexts(s.fake).some(NO_TEXT_RECEIPT), 'текстовой квитанции нет');
      assert.ok(!j.some((l) => l.ev === 'receipt_fallback'));
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('👀 в пути, агент уже ответил, а 👀 отказ (400) — 👌 всё равно встаёт: отказ прежней реакции не гасит новую', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const u = s.fake.builder.text(OWNER, 'быстрый ответ');
      // 👀 на этом сообщении отвечает 400, но не сразу: агент успевает ответить, пока запрос 👀 в пути.
      s.fake.scenario({
        method: 'setMessageReaction',
        when: (p) => isEyes(p) && Number(p.message_id) === u.message!.message_id,
        times: 1,
        reply: reply.delay(700, reply.error(400, 'Bad Request: REACTION_INVALID')),
      });
      s.fake.push(u);
      await waitRecorded(s, gw, u);
      const seq = q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)!.seq;
      const ag = await seeingAgent(s);
      try {
        await pump(gw, () => s.fake.callsOf('setMessageReaction').some((c) => isEyes(c.params)) || null, { step: '100ms', what: 'запроса 👀' });
        assert.equal((await ag.ch.reply(seq, 'готово', ag.turn)).type, 'ack');
        await pump(gw, () => reactionOf(s.fake, u) === '👌' || null, { what: '👌 после отказа 👀' });
        const j = readJournal(s.home);
        assert.ok(j.some((l) => l.ev === 'reaction_failed' && l.seq === seq && l.emoji === '👀' && l.final === true), 'отказ 👀 — в журнале');
        assert.deepEqual(reactionsOf(s.fake, u), ['👌']);
        // Отметка в базе — после ответа Telegram: дождаться её.
        await waitUntil(() => q1<{ status: string }>(s.home, 'SELECT status FROM reactions WHERE event_seq = ?', seq)?.status === 'done' || null, 5000, '👌 отмечена');
      } finally {
        ag.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('правка: реакция к прежнему тексту снимается, затем 👀 при отдаче и 👌 после ответа; вторая правка, пока агента нет, — снимать нечего: запроса нет', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const u = s.fake.builder.text(OWNER, 'до правки');
      s.fake.push(u);
      await waitRecorded(s, gw, u);
      let ag: Awaited<ReturnType<typeof seeingAgent>> | null = await seeingAgent(s);
      try {
        const seq = q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)!.seq;
        await pump(gw, () => reactionOf(s.fake, u) === '👀' || null, { what: '👀' });
        assert.equal((await ag.ch.reply(seq, 'принял', ag.turn)).type, 'ack');
        await pump(gw, () => reactionOf(s.fake, u) === '👌' || null, { what: '👌' });
        // Агент на время уходит: правка записана — 👌 к прежнему тексту снимается ⟨предл.⟩, на сообщении ничего.
        ag.close();
        ag = null;
        await gw.waitForJournal((l) => l.ev === 'lease_released');
        const e = s.fake.builder.edited(u, 'после правки');
        s.fake.push(e);
        await pump(gw, () => (reactionsOf(s.fake, u).length === 3 && reactionOf(s.fake, u) === null) || null, { what: 'снятия реакции после правки' });
        for (let i = 0; i < 3; i++) await gw.advance('1s');
        assert.deepEqual(reactionsOf(s.fake, u), ['👀', '👌', '']);
        // Вторая правка, пока агента нет: снимать нечего — запроса к Telegram нет (reaction_kept), строка done.
        const e2 = s.fake.builder.edited(u, 'после второй правки');
        s.fake.push(e2);
        await waitRecorded(s, gw, e2);
        const edit = q1<{ seq: number }>(s.home, "SELECT seq FROM events WHERE update_id = ? AND kind = 'edit'", e2.update_id)!.seq;
        await pump(gw, () => readJournal(s.home).some((l) => l.ev === 'reaction_kept' && l.seq === edit) || null, { what: 'reaction_kept второй правки' });
        for (let i = 0; i < 3; i++) await gw.advance('1s');
        assert.deepEqual(reactionsOf(s.fake, u), ['👀', '👌', ''], 'второго запроса нет');
        assert.deepEqual({ ...q1<{ event_seq: number; want: string; status: string }>(s.home, 'SELECT event_seq, want, status FROM reactions WHERE event_seq = ?', edit) }, { event_seq: edit, want: '', status: 'done' });
        const ag2 = await seeingAgent(s);
        try {
          await pump(gw, () => reactionOf(s.fake, u) === '👀' || null, { what: '👀 на правке' });
          assert.equal((await ag2.ch.reply(edit, 'учёл правку', ag2.turn)).type, 'ack');
          await pump(gw, () => reactionOf(s.fake, u) === '👌' || null, { what: '👌 на правке' });
          assert.deepEqual(reactionsOf(s.fake, u), ['👀', '👌', '', '👀', '👌']);
          assert.ok(!s.fake.callsOf('setMessageReaction').some((c) => isPen(c.params)), '✍ нет');
        } finally {
          ag2.close();
        }
      } finally {
        ag?.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('первый старт 0.3.2 на базе 0.3.1: стоящий ✍ не трогается и сменяется 👀; ждавший отправки ✍ не ставится (reaction_retired); на обработанном ✍ остаётся', async () => {
    const s = await setup();
    try {
      const g0 = await s.start();
      const [standing, waiting, processed] = [s.fake.builder.text(OWNER, '✍ стоит'), s.fake.builder.text(OWNER, '✍ ждал'), s.fake.builder.text(OWNER, '✍ на отвеченном')];
      s.fake.push(standing, waiting, processed);
      await waitRecorded(s, g0, [standing, waiting, processed]);
      await g0.stop();
      const seqOf = (u: typeof standing): number => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)!.seq;
      const [sSt, sWa, sPr] = [seqOf(standing), seqOf(waiting), seqOf(processed)];
      // Так база выглядит после 0.3.1: ✍ стоит на двух сообщениях, на третьем ✍ ещё не ушёл (шлюз
      // остановили); третье агент уже обработал.
      const db = new DatabaseSync(s.home.paths.db);
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        const ins = db.prepare("INSERT INTO reactions(chat_id, message_id, event_seq, want, shown, status, created_at) VALUES (?, ?, ?, '✍', ?, ?, 0)");
        ins.run(OWNER.id, standing.message!.message_id, sSt, '✍', 'done');
        ins.run(OWNER.id, waiting.message!.message_id, sWa, null, 'pending');
        ins.run(OWNER.id, processed.message!.message_id, sPr, '✍', 'done');
        db.prepare("UPDATE events SET status = 'processed', processed_at = 0 WHERE seq = ?").run(sPr);
      } finally {
        db.close();
      }
      const gw = await s.start();
      await pump(gw, () => readJournal(s.home).some((l) => l.ev === 'reaction_retired' && l.seq === sWa) || null, { what: 'reaction_retired ✍, ждавшего отправки' });
      for (let i = 0; i < 3; i++) await gw.advance('1s');
      assert.equal(s.fake.callsOf('setMessageReaction').length, 0, 'при старте ни ✍, ни снятия — стоящие ✍ не трогаются');
      assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM reactions WHERE event_seq = ?', sWa)?.status, 'done');
      // Агент пришёл: 👀 сменяет ✍ на ждущих; обработанное агенту не уходит — ✍ на нём так и остаётся ⟨предл.⟩.
      const ag = await seeingAgent(s);
      try {
        await pump(gw, () => (reactionOf(s.fake, standing) === '👀' && reactionOf(s.fake, waiting) === '👀') || null, { what: '👀 на двух' });
        for (let i = 0; i < 3; i++) await gw.advance('1s');
        assert.deepEqual([reactionsOf(s.fake, standing), reactionsOf(s.fake, waiting), reactionsOf(s.fake, processed)], [['👀'], ['👀'], []]);
        assert.equal(q1<{ want: string }>(s.home, 'SELECT want FROM reactions WHERE event_seq = ?', sPr)?.want, '✍');
      } finally {
        ag.close();
      }
      assert.ok(!s.fake.callsOf('setMessageReaction').some((c) => isPen(c.params)), '✍ не ставится');
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('убийство в in_send на 👀 (Telegram ответил, отметки нет) — после старта 👀 ставится ещё раз; ответ — 👌; отметки done', async () => {
    const s = await setup();
    try {
      const u = s.fake.builder.text(OWNER, 'под убийством');
      const g0 = await s.start({ STG_FAULT: `in_send:${u.update_id}` });
      const a0 = await seeingAgent(s);
      s.fake.push(u);
      // Записано, агент увидел, 👀 ушёл, Telegram ответил — и шлюз убит до отметки в базе.
      const deadline = Date.now() + 20_000;
      while (g0.alive) {
        if (Date.now() > deadline) throw new Error(`не вышел в точке in_send; stderr: ${g0.stderr}`);
        await g0.advance('200ms').catch(() => undefined);
        await sleep(15);
      }
      a0.close();
      const ex = await g0.waitForExit();
      assert.equal(ex.code, 137, g0.stderr);
      assert.match(g0.stderr, new RegExp(`точка сбоя in_send:${u.update_id}`));
      const seq = q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)!.seq;
      assert.deepEqual(reactionsOf(s.fake, u), ['👀'], '👀 встал до убийства');
      const before = { ...q1<{ want: string; shown: string | null; status: string }>(s.home, 'SELECT want, shown, status FROM reactions WHERE event_seq = ?', seq) };
      assert.deepEqual(before, { want: '👀', shown: null, status: 'pending' }, 'отметки нет');
      shiftClockFile(s.home, 61_000);
      const gw = await s.start();
      // После старта 👀 ставится ещё раз (безвредно) и отмечается — не теряется.
      await pump(gw, () => reactionsOf(s.fake, u).length >= 2 || null, { what: 'второго 👀' });
      assert.deepEqual(reactionsOf(s.fake, u), ['👀', '👀']);
      await waitUntil(() => q1<{ status: string }>(s.home, 'SELECT status FROM reactions WHERE event_seq = ?', seq)?.status === 'done' || null, 5000, '👀 отмечен');
      const a2 = await seeingAgent(s);
      try {
        await a2.ch.waitEvent(seq);
        assert.equal((await a2.ch.reply(seq, 'принял', a2.turn)).type, 'ack');
        await pump(gw, () => reactionOf(s.fake, u) === '👌' || null, { what: '👌' });
        assert.deepEqual(reactionsOf(s.fake, u), ['👀', '👀', '👌']);
        await waitUntil(() => q1(s.home, "SELECT 1 FROM reactions WHERE event_seq = ? AND want = '👌' AND status = 'done'", seq) || null, 5000, '👌 отмечена');
      } finally {
        a2.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });
});
