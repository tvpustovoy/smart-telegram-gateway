// Первый старт на базе прежней версии (0.2 — без ✍; исправления по проверке 0.3.1; P-11, P-18, P-19; 0.3.2 — R-1 «б»:
// ✍ не ставится). Прежняя версия: ✍ не ставила, под строкой «⚙ Команды
// — кнопками внизу; справка — /help» была нижняя клавиатура, на голосовое сразу уходила квитанция «№ N голосовое …
// распознаю…». Обновление пришлось на момент, когда агент не на связи: текст ждёт отдачи (new), голосовое ещё
// распознаётся (transcribing), квитанция «распознаю…» и строка о кнопках ещё в очереди. Первый старт (одна транзакция с
// отметкой meta.keyboard_removed):
// - ✍ записанному прежней версией с 0.3.2 не ставится: на сообщениях ничего до 👀 (агент не на связи — ⚪ и 📥 N);
// - неушедшая строка о кнопках — dropped (без клавиатуры она противоречила бы строке «Кнопки убраны») ⟨предл.⟩;
// - одна строка «⚙ Кнопки убраны — команды в меню ☰» с remove_keyboard;
// - квитанция «распознаю…» уходит как есть ⟨предл.⟩, и рядом — новый ответ с расшифровкой (реплаем на голосовое);
// - в start — keyboard_removed {outbox_id, notes_dropped}; второй старт ничего этого не повторяет.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { KEYBOARD_REMOVED_TEXT, type Update } from 'stg-core';
import { reply } from 'stg-fake-telegram';
import { pump, q1, sleep, waitUntil } from './harness.js';
import { OWNER, isPen, reactionsOf, statusLineOf, waitRecorded } from './m1-common.js';
import { pushVoice, sttText, voiceSetup, waitSttReply } from './m4-common.js';

const LEGACY_NOTE = '⚙ Команды — кнопками внизу; справка — /help';
const FULL = 'распознано уже новой версией';

describe('M4 · первый старт на базе прежней версии: ✍ не ставится (0.3.2), строка о кнопках снята, «распознаю…» уходит как есть', () => {
  it('тексту в new и голосовому в transcribing — ничего (0.3.2: без ✍); строка о кнопках — dropped; строка снятия клавиатуры одна; квитанция прежней версии и новый ответ с расшифровкой', async () => {
    const s = await voiceSetup({ fake: { transcript: FULL } });
    try {
      const msgOf = (u: Update): number => u.message!.message_id;
      const seqOf = (u: Update): number => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)!.seq;
      // --- Прежняя версия (её поведение — подделкой и правкой базы) ---
      const g0 = await s.start();
      const first = s.fake.builder.text(OWNER, 'до обновления');
      s.fake.push(first);
      await waitRecorded(s, g0, first);
      await pump(g0, () => statusLineOf(s.fake), { what: 'строки состояния (бот владельцу уже писал)' });
      // Прежняя версия ✍ не ставила: на этих двух сообщениях запрос ✍ отклоняется, строки реакций потом убираются.
      const text = s.fake.builder.text(OWNER, 'ждёт агента');
      s.voice.latencyMs = 3000;
      const pens = new Set<number>();
      s.fake.scenario({ method: 'setMessageReaction', when: (p) => isPen(p) && pens.has(Number(p.message_id)), times: 10, reply: reply.error(400, 'Bad Request: REACTION_INVALID') });
      pens.add(msgOf(text));
      s.fake.push(text);
      await waitRecorded(s, g0, text);
      const voiceU = pushVoice(s, 5);
      pens.add(msgOf(voiceU));
      await waitRecorded(s, g0, voiceU);
      await waitUntil(() => s.voice.calls.length > 0 || null, 5000, 'запроса распознавания (он висит)');
      await g0.advance('1s');
      await g0.stop();
      s.fake.clearScenario();
      s.voice.latencyMs = 0;
      const textSeq = seqOf(text);
      const voiceSeq = seqOf(voiceU);
      assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', voiceSeq)?.status, 'transcribing', 'голосовое ещё распознавалось');
      assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', textSeq)?.status, 'new', 'текст ждёт агента');
      const receiptText = `№ ${voiceSeq} голосовое 0:05 распознаю…`;
      const db = new DatabaseSync(s.home.paths.db);
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        db.prepare('DELETE FROM reactions WHERE event_seq IN (?, ?)').run(textSeq, voiceSeq);
        db.prepare('UPDATE latency SET t_receipt = NULL WHERE event_seq IN (?, ?)').run(textSeq, voiceSeq);
        db.prepare("DELETE FROM meta WHERE key = 'keyboard_removed'").run();
        db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('keyboard_placeholder', '')").run();
        const ins = db.prepare("INSERT INTO outbox(event_seq, chat_id, kind, text, origin, status, created_at) VALUES (?, ?, ?, ?, 'gateway', 'pending', 0)");
        ins.run(voiceSeq, OWNER.id, 'receipt', receiptText);
        ins.run(null, OWNER.id, 'service', LEGACY_NOTE);
      } finally {
        db.close();
      }
      const reactionsBefore = { text: reactionsOf(s.fake, text), voice: reactionsOf(s.fake, voiceU) };
      assert.deepEqual(reactionsBefore, { text: [], voice: [] }, 'прежняя версия ✍ не ставила');

      // --- Первый старт 0.3.1 ---
      const g1 = await s.start();
      const start = await g1.waitForJournal((l) => l.ev === 'start' && Number(l.pid) === g1.pid);
      const kr = start.keyboard_removed as { outbox_id: number | null; notes_dropped: number; recorded_backlog?: number };
      assert.equal(typeof kr.outbox_id, 'number', 'строка снятия клавиатуры в очереди');
      assert.deepEqual({ notes: kr.notes_dropped, backlog: kr.recorded_backlog }, { notes: 1, backlog: undefined });
      const [r] = await waitSttReply(s, g1, voiceU, 1, 'ответа с расшифровкой');
      assert.equal(sttText(r!), FULL);
      await pump(g1, () => s.fake.sentTo(OWNER.id).some((m) => m.text === receiptText) || null, { what: 'квитанции прежней версии' });
      await pump(g1, () => s.fake.sentTo(OWNER.id).some((m) => m.text === KEYBOARD_REMOVED_TEXT) || null, { what: 'строки снятия' });
      for (let i = 0; i < 5; i++) await g1.advance('1s');
      await sleep(50);
      assert.deepEqual(reactionsOf(s.fake, text), [], 'текст: ✍ нет (0.3.2); агента нет — на сообщении ничего');
      assert.deepEqual(reactionsOf(s.fake, voiceU), [], 'голосовое: ✍ нет');
      assert.equal(s.fake.sentTo(OWNER.id).filter((m) => m.text === LEGACY_NOTE).length, 0, 'строка о кнопках не ушла');
      assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM outbox WHERE text = ?', LEGACY_NOTE)?.status, 'dropped');
      assert.equal(s.fake.sentTo(OWNER.id).filter((m) => m.text === receiptText).length, 1, 'квитанция прежней версии ушла как есть, одна');
      assert.equal(s.fake.sentTo(OWNER.id).filter((m) => m.text === KEYBOARD_REMOVED_TEXT).length, 1);
      assert.equal(q1<{ n: number }>(s.home, 'SELECT count(*) AS n FROM reactions WHERE event_seq IN (?, ?)', textSeq, voiceSeq)?.n, 0, 'строк реакций нет');
      await g1.stop();

      // --- Второй старт: ничего из этого не повторяется ---
      const g2 = await s.start();
      const start2 = await g2.waitForJournal((l) => l.ev === 'start' && Number(l.pid) === g2.pid);
      assert.equal(start2.keyboard_removed, undefined);
      for (let i = 0; i < 5; i++) await g2.advance('1s');
      await sleep(50);
      assert.deepEqual([reactionsOf(s.fake, text), reactionsOf(s.fake, voiceU)], [[], []], 'и на втором старте ✍ нет');
      assert.equal(s.fake.sentTo(OWNER.id).filter((m) => m.text === KEYBOARD_REMOVED_TEXT).length, 1);
      await g2.stop();
    } finally {
      await s.close();
    }
  });
});
