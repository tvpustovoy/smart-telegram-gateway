// M4 · распознавание под сбоями (Ш-7; TECH-SPEC 5.8): A4.6 провайдер завис — ответом на голосовое «Не смог распознать —
// звук сохранён…» не позже 3 минут (срок попытки 60 с, два повтора), запись следующего текста не задержана, сам текст агенту —
// не позже 90 с (голосовое
// держит следующие не дольше); предохранитель — 3 голосовых и текст при зависшем провайдере: 2-е и 3-е голосовое — одна
// попытка 20 с, текст агенту не ждёт их; A4.7 kill -9 посреди распознавания (точка
// in_stt) — после старта расшифровка ровно одна (и ответ с ней — один); 429 — пауза по Retry-After и повтор; звук не
// скачался — «Не смог распознать: звук не скачался»; ключа голоса нет — «Не смог распознать», провайдеру ни одного
// вызова, «статус» говорит, что сделать.
// Сценарии общие для провайдеров: их запускают m4-stt-faults-openai.test.ts и m4-stt-faults-elevenlabs.test.ts.

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { Update } from 'stg-core';
import { connectAdapter, pump, q, q1, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, waitRecorded } from './m1-common.js';
import { pushVoice, replyTo, sttHead, sttRepliesOf, sttText, voiceSetup, waitSttReply, type VoiceDialect, type VoiceSetup } from './m4-common.js';

const FAILED = 'Не смог распознать — звук сохранён. Срочное — текстом';

const seqOf = (s: VoiceSetup, u: Update): number | undefined => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
const admitted = (s: VoiceSetup, u: Update): Promise<number> => waitUntil(() => seqOf(s, u), 5000, `приёма ${u.update_id}`);
const statusOf = (s: VoiceSetup, seq: number): string | undefined => q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status;

export function sttFaultsSuite(dialect: VoiceDialect): void {
  describe(`A4.6 · провайдер завис · ${dialect}`, () => {
    let s: VoiceSetup;
    let gw: GatewayProcess;
    after(async () => {
      if (gw?.alive) await gw.stop();
      await s?.close();
    });

    it('через ≤ 3 мин ответом «Не смог распознать» (попытка и два повтора по 60 с); запись следующего текста не задержана', async () => {
      s = await voiceSetup({ dialect, fake: { sttMode: 'hang' } });
      gw = await s.start();
      const { ch } = await connectAdapter(s.home);
      try {
        const v = pushVoice(s, 6);
        const sv = await admitted(s, v);
        await waitUntil(() => s.voice.stt.length === 1 || null, 5000, 'первой попытки');
        const t = s.fake.push(s.fake.builder.text(OWNER, 'срочное текстом'))[0]!;
        const st = await admitted(s, t);
        // Текст записан (COMMIT) — пока голосовое висит у провайдера.
        await waitRecorded(s, gw, [v, t], 'записи текста');
        assert.equal(statusOf(s, sv), 'transcribing', 'текст записан, пока голосовое висит у провайдера');
        assert.equal(sttRepliesOf(s, v).length, 0, 'пока распознаётся — ответа на голосовое нет');
        assert.equal(s.voice.stt.length, 1);
        await gw.advance('60s');
        await waitUntil(() => s.voice.stt.length === 2 || null, 5000, 'попытки 2');
        await sleep(150);
        assert.ok(!ch.events().some((e) => e.seq === st), 'до 90 с голосовое держит следующий текст (5.8)');
        // Дольше 90 с голосовое следующие не держит: текст уходит агенту, пока провайдер ещё висит.
        await gw.advance('30s');
        await gw.advance('15s');
        await ch.waitEvent(st);
        assert.equal(statusOf(s, sv), 'transcribing');
        assert.ok(!ch.events().some((e) => e.seq === sv), 'голосовое — только когда распознано или отказ');
        assert.ok(readJournal(s.home).some((l) => l.ev === 'voice_hold_released' && l.seq === sv));
        await gw.advance('15s');
        await waitUntil(() => s.voice.stt.length === 3 || null, 5000, 'попытки 3');
        const [r] = await pump(gw, () => (sttRepliesOf(s, v).length ? sttRepliesOf(s, v) : null), { what: 'ответа «не смог»', step: '5s' });
        assert.equal(r!.text, FAILED);
        assert.deepEqual(r!.reply_parameters, replyTo(v));
        const j = readJournal(s.home);
        const inAt = Date.parse(j.find((l) => l.ev === 'in' && l.seq === sv)!.at);
        const fail = j.find((l) => l.ev === 'stt_failed' && l.seq === sv)!;
        assert.deepEqual({ reason: fail.reason, attempts: fail.attempts }, { reason: 'timeout', attempts: 3 });
        const took = Date.parse(fail.at) - inAt;
        assert.ok(took <= 3 * 60_000 + 5_000, `от записи до отказа ${took} мс`);
        assert.equal(s.voice.stt.length, 3);
        // Голосовое отдано после отказа, с пометкой «не распознано» (transcript = null); текст — раньше него.
        await ch.waitEvent(sv);
        assert.deepEqual(ch.events().map((e) => e.seq), [st, sv]);
        assert.equal(ch.events()[1]?.transcript, null);
      } finally {
        ch.close();
      }
    });
  });

  describe(`предохранитель распознавания · провайдер завис, 3 голосовых и текст · ${dialect}`, () => {
    let s: VoiceSetup;
    let gw: GatewayProcess;
    after(async () => {
      if (gw?.alive) await gw.stop();
      await s?.close();
    });

    it('текст агенту — не позже ~90 с; первое голосовое — 3 попытки, 2-е и 3-е — по одной 20 с; все отданы, отказ — каждому', async () => {
      s = await voiceSetup({ dialect, fake: { sttMode: 'hang' } });
      gw = await s.start();
      const { ch } = await connectAdapter(s.home);
      try {
        const voices: number[] = [];
        const vus: Update[] = [];
        for (const sec of [5, 6, 7]) {
          const vu = pushVoice(s, sec);
          vus.push(vu);
          voices.push(await admitted(s, vu));
        }
        const st = await admitted(s, s.fake.push(s.fake.builder.text(OWNER, 'срочно'))[0]!);
        const t0 = q1<{ created_at: number }>(s.home, 'SELECT created_at FROM events WHERE seq = ?', voices[0]!)!.created_at;
        await waitUntil(() => s.voice.stt.length === 1 || null, 5000, 'первой попытки');
        // Шаги по 10 с с паузой: сроки запросов к провайдеру — не раньше 200 мс настоящего времени.
        let now = t0;
        const stepUntil = async (cond: () => boolean, what: string, limitMs: number): Promise<number> => {
          while (!cond()) {
            if (now - t0 > limitMs) throw new Error(`не дождались: ${what} за ${limitMs / 1000} с часов шлюза`);
            now = await gw.advance('10s');
            await sleep(250);
          }
          return now - t0;
        };
        const textAt = await stepUntil(() => ch.events().some((e) => e.seq === st), 'текста у агента', 200_000);
        assert.ok(textAt <= 90_000 + 15_000 + 10_000, `текст агенту через ${textAt / 1000} с`);
        assert.ok(voices.every((v) => statusOf(s, v) === 'transcribing'), 'голосовые ещё распознаются');
        const doneAt = await stepUntil(() => voices.every((v) => ch.events().some((e) => e.seq === v)), 'трёх голосовых у агента', 600_000);
        // Без предохранителя — 3 × 3 мин; с ним — 3 мин + 2 × 20 с.
        assert.ok(doneAt <= 180_000 + 2 * 20_000 + 40_000, `голосовые отданы через ${doneAt / 1000} с`);
        assert.equal(s.voice.stt.length, 5, 'попыток: 3 + 1 + 1');
        const j = readJournal(s.home);
        assert.ok(j.some((l) => l.ev === 'stt_degraded' && l.seq === voices[0]));
        assert.deepEqual(
          voices.map((v) => j.find((l) => l.ev === 'stt_failed' && l.seq === v)?.attempts),
          [3, 1, 1],
        );
        assert.deepEqual(ch.events().map((e) => e.seq), [st, ...voices], 'текст — первым, голосовые — по порядку');
        // Ответы уходят отправителем после записи отказа — ждать их, а не читать сразу.
        await pump(gw, () => vus.every((vu) => sttRepliesOf(s, vu).length === 1) || null, { what: 'ответов «не смог»' });
        for (const vu of vus) assert.equal(sttRepliesOf(s, vu)[0]!.text, FAILED);
      } finally {
        ch.close();
      }
    });
  });

  describe(`A4.7 · kill -9 посреди распознавания · ${dialect}`, () => {
    let s: VoiceSetup;
    after(() => s?.close());

    it('точка in_stt: ответ провайдера получен, не записан — после старта распознано заново, расшифровка ровно одна', async () => {
      s = await voiceSetup({ dialect, fake: { transcript: 'купи хлеба и молока' } });
      const u = pushVoice(s, 3);
      const g1 = s.spawn({ STG_FAULT: `in_stt:${u.update_id}` });
      for (let i = 0; i < 200 && g1.alive; i++) {
        await g1.advance('1s').catch(() => undefined);
        await new Promise((r) => setTimeout(r, 15));
      }
      const ex = await g1.waitForExit();
      assert.equal(ex.code, 137, g1.stderr);
      assert.match(g1.stderr, new RegExp(`точка сбоя in_stt:${u.update_id}`));
      const seq = seqOf(s, u)!;
      assert.equal(s.voice.stt.length, 1);
      assert.deepEqual({ ...q1<{ status: string; transcript: string | null }>(s.home, 'SELECT status, transcript FROM events WHERE seq = ?', seq) }, { status: 'transcribing', transcript: null });
      const g2 = await s.start();
      const [r] = await waitSttReply(s, g2, u, 1, 'расшифровки после перезапуска');
      assert.equal(sttText(r!), 'купи хлеба и молока');
      assert.equal(s.voice.stt.length, 2, 'распознано заново');
      assert.equal(q1<{ transcript: string }>(s.home, 'SELECT transcript FROM events WHERE seq = ?', seq)?.transcript, 'купи хлеба и молока');
      assert.equal(q(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id).length, 1, 'событие одно');
      assert.equal(readJournal(s.home).filter((l) => l.ev === 'transcribed' && l.seq === seq).length, 1, 'расшифровка записана один раз');
      assert.equal(q(s.home, "SELECT id FROM outbox WHERE event_seq = ? AND kind = 'receipt'", seq).length, 1, 'ответ с расшифровкой — один');
      for (let i = 0; i < 3; i++) await g2.advance('1s');
      assert.equal(sttRepliesOf(s, u).length, 1, 'в чате — один');
      await g2.stop();
    });
  });

  describe(`распознавание: 429, звук не скачался, нет ключа · ${dialect}`, () => {
    let s: VoiceSetup;
    let gw: GatewayProcess;
    after(async () => {
      if (gw?.alive) await gw.stop();
      await s?.close();
    });

    it('429 — пауза по Retry-After и повтор: распознано со второй попытки', async () => {
      s = await voiceSetup({ dialect, fake: { transcript: 'со второго раза' } });
      gw = await s.start();
      s.voice.sttScript = ['rate_limited'];
      const u = pushVoice(s, 2);
      const seq = await admitted(s, u);
      await pump(gw, () => q1<{ transcript: string | null }>(s.home, 'SELECT transcript FROM events WHERE seq = ?', seq)?.transcript || null, { what: 'расшифровки' });
      assert.equal(s.voice.stt.length, 2);
      const fails = readJournal(s.home).filter((l) => l.ev === 'stt_attempt_failed' && l.seq === seq);
      assert.deepEqual(fails.map((l) => [l.status, l.kind, l.code]), [[429, 'rate', s.voice.codes.rate]]);
    });

    it('звук не скачался из Telegram — провайдеру не уходит, ответом «Не смог распознать: звук не скачался»', async () => {
      const calls = s.voice.stt.length;
      const u = pushVoice(s, 4, { noFile: true });
      const seq = await admitted(s, u);
      const [r] = await waitSttReply(s, gw, u);
      assert.equal(r!.text, 'Не смог распознать: звук не скачался. Срочное — текстом');
      assert.equal(s.voice.stt.length, calls);
      assert.equal(statusOf(s, seq), 'new');
    });

    it('ключа голоса нет — ответом «Не смог распознать — звук сохранён», вызовов нет; «статус»: нет ключа — stg doctor', async () => {
      await gw.stop();
      await s.close();
      s = await voiceSetup({ dialect, withKey: false });
      gw = await s.start();
      const u = pushVoice(s, 3);
      await admitted(s, u);
      const [r] = await waitSttReply(s, gw, u);
      assert.equal(r!.text, FAILED);
      assert.equal(s.voice.stt.length, 0);
      s.fake.push(s.fake.builder.text(OWNER, 'статус'));
      const st = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => (m.text ?? '').startsWith('⚙ Статус')), { what: '«статус»' });
      const head = sttHead(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(st.text!, new RegExp(`\\nРаспознавание: ${head}, язык ru, словарь 3 · нет ключа ${dialect} — stg doctor · за сутки распознано 0, не распознано 1 · последний отказ в \\d\\d:\\d\\d: no_key\\n`));
      assert.match(st.text!, new RegExp(`\\nСинтез: [^\\n]* · нет ключа ${dialect} — stg doctor(\\n|$)`));
    });
  });
}
