// M4 · голос наружу (Ш-8; TECH-SPEC 5.5, 5.8) на поддельных Telegram, провайдере голоса и переходнике: A4.4 ответ агента
// voice: true — sendVoice с duration по Ogg (±1 с от образца), образец — ogg/opus (ffprobe, если есть), подпись — чистым
// текстом (0.3.2, P-26: без 💬), с from — «↪ Имя: »;
// длинный ответ — голосовое без подписи и следом текст; синтез идёт рядом с отправителем: квитанции его не ждут, а
// следующий ответ агента не обгоняет голосовое; A4.8 синтез ответил ошибкой (и не Ogg) — «⚙ голос не получился» и
// текст; голос не задан в config.yaml — то же (у ElevenLabs: у OpenAI голос по умолчанию есть). Сценарии общие для
// провайдеров: их запускают m4-tts-openai.test.ts и m4-tts-elevenlabs.test.ts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { VOICE_FAILED_TEXT, inspectOggOpus, type Update } from 'stg-core';
import type { FakeChannel } from 'stg-fake-channel';
import { makeOggOpus } from 'stg-fake-elevenlabs';
import { reply, type SentMessage } from 'stg-fake-telegram';
import { connectAdapter, hasCommand, makeTempDir, pump, q1, readJournal, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, waitRecorded } from './m1-common.js';
import { DIALECT, voiceSetup, type VoiceDialect, type VoiceSetup } from './m4-common.js';

export function ttsSuite(dialect: VoiceDialect): void {
  describe(`M4 · ответ голосом · ${dialect}`, () => {
    let s: VoiceSetup;
    let gw: GatewayProcess;
    let ch: FakeChannel;
    let turn: number;
    const seqOf = (u: Update): number | undefined => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
    /** Сообщение владельца → событие отдано переходнику и толкнуто в сессию. */
    async function ownerSays(text: string): Promise<number> {
      const u = s.fake.push(s.fake.builder.text(OWNER, text))[0]!;
      const seq = await waitUntil(() => seqOf(u), 5000, 'приёма');
      await ch.waitEvent(seq);
      await ch.delivered(seq);
      return seq;
    }
    const sent = (): SentMessage[] => s.fake.sentTo(OWNER.id);
    /**
     * Сообщения бота после n-го — без текстовых квитанций (запасной путь) и закреплённой строки состояния (её правят на
     * месте; J-4).
     */
    const botAfter = (n: number): SentMessage[] => sent().slice(n).filter((m) => !/^(№|📍)/.test(m.text ?? ''));

    before(async () => {
      s = await voiceSetup({ dialect, fake: { ttsSeconds: 4.2 } });
      gw = await s.start();
      ({ ch, turn } = await connectAdapter(s.home));
    });
    after(async () => {
      ch?.close();
      if (gw?.alive) await gw.stop();
      await s.close();
    });

    it('A4.4: voice: true — sendVoice с duration по Ogg (±1 с), образец ogg/opus, текст в подписи без 💬 (P-26)', async () => {
      const seq = await ownerSays('скажи голосом, что завтра');
      const a = await ch.reply(seq, 'Завтра **в 9** — звонок юристу', turn, true);
      assert.ok(a.type === 'ack' && a.result === 'queued', JSON.stringify(a));
      const v = await pump(gw, () => sent().find((m) => m.method === 'sendVoice'), { what: 'голосового' });
      assert.ok(v.voice && Math.abs((v.voice.duration ?? -10) - 4.2) <= 1, `duration ${v.voice?.duration}`);
      assert.equal(v.voice?.duration, 4, 'целые секунды по Ogg');
      assert.equal(v.caption, 'Завтра <b>в 9</b> — звонок юристу');
      assert.equal(v.parse_mode, 'HTML');
      const tts = s.synth.tts.at(-1)!;
      assert.deepEqual(
        { voice: tts.voice, format: tts.format, model: tts.model, text: tts.text },
        { voice: 'voice_test', format: DIALECT[dialect].ttsFormat, model: DIALECT[dialect].ttsModel, text: 'Завтра в 9 — звонок юристу' },
      );
      assert.ok(s.synth.calls.every((c) => c.authorized), 'ключ — как положено провайдеру');
      const data = s.fake.fileData((v.message as { voice: { file_id: string } }).voice.file_id)!;
      assert.deepEqual(data, makeOggOpus(4.2), 'ушёл образец синтеза как есть');
      const info = inspectOggOpus(data);
      assert.ok(info.ok && Math.abs(info.info.seconds - 4.2) < 0.01);
      if (hasCommand('ffprobe')) {
        const file = path.join(makeTempDir('stg-a44-'), 'v.ogg');
        fs.writeFileSync(file, data);
        const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_name', '-of', 'json', file], { encoding: 'utf8' });
        const p = JSON.parse(r.stdout) as { format: { format_name: string; duration: string }; streams: Array<{ codec_name: string }> };
        assert.deepEqual([p.format.format_name, p.streams[0]?.codec_name], ['ogg', 'opus']);
        assert.ok(Math.abs(Number(p.format.duration) - 4.2) < 0.05);
      }
      await waitUntil(() => q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status === 'processed' || null, 5000, 'processed');
      await waitUntil(() => q1<{ kind: string }>(s.home, 'SELECT kind FROM messages_out WHERE tg_message_id = ?', v.message_id)?.kind === 'agent' || null, 5000, 'messages_out');
    });

    it('P-26: голосом с from — подпись «↪ Имя: …», синтезу — только текст ответа; со знака шлюза без from — подпись с 💬', async () => {
      const seq = await ownerSays('спроси голосом у Исследователя');
      const n = sent().length;
      assert.ok((await ch.reply(seq, 'Нашла **две** статьи', turn, true, 'Исследователь')).type === 'ack');
      const v = await pump(gw, () => sent().slice(n).find((m) => m.method === 'sendVoice'), { what: 'голосового' });
      assert.equal(v.caption, '↪ Исследователь: Нашла <b>две</b> статьи');
      assert.equal(s.synth.tts.at(-1)?.text, 'Нашла две статьи', 'имя не озвучивается');
      const seq2 = await ownerSays('голосом про шестерёнку');
      const n2 = sent().length;
      assert.ok((await ch.reply(seq2, '⚙ — это значок шлюза', turn, true)).type === 'ack');
      const v2 = await pump(gw, () => sent().slice(n2).find((m) => m.method === 'sendVoice'), { what: 'второго голосового' });
      assert.equal(v2.caption, '💬 ⚙ — это значок шлюза');
    });

    it('5.5: ответ длиннее подписи — голосовое без подписи, следом текст (без 💬)', async () => {
      const seq = await ownerSays('подробно голосом');
      const long = Array.from({ length: 250 }, (_, i) => `пункт${i}`).join(' ');
      const n = sent().length;
      await ch.reply(seq, long, turn, true);
      const both = await pump(gw, () => (botAfter(n).length >= 2 ? botAfter(n) : null), { what: 'голосового и текста' });
      assert.equal(both[0]!.method, 'sendVoice');
      assert.equal(both[0]!.caption, null);
      assert.equal(both[1]!.method, 'sendMessage');
      assert.equal(both[1]!.text, long);
      assert.equal(s.synth.tts.at(-1)?.text, long);
    });

    it('синтез рядом с отправителем: запись не ждёт голосового, следующий ответ агента его не обгоняет', async () => {
      const seq = await ownerSays('ответь голосом, потом текстом');
      s.synth.latencyMs = 2000;
      try {
        const n = sent().length;
        const ready = readJournal(s.home).filter((l) => l.ev === 'tts_ready').length;
        const synthCalls = s.synth.calls.length;
        await ch.reply(seq, 'Голосом', turn, true);
        await ch.reply(seq, 'И текстом следом', turn, false);
        const u = s.fake.push(s.fake.builder.text(OWNER, 'пока ты думаешь'))[0]!;
        const sq = await waitUntil(() => seqOf(u), 5000, 'приёма');
        // Запись (COMMIT) не ждёт ни синтеза, ни очереди сообщений.
        await waitRecorded(s, gw, u);
        void sq;
        assert.ok(!sent().slice(n).some((m) => m.method === 'sendVoice'), 'записано раньше, чем ушло голосовое');
        // Синтез запускает отправитель, когда доходит до ответа: часы — мелкими шагами, пока запрос не ушёл провайдеру.
        await pump(gw, () => s.synth.calls.length > synthCalls || null, { step: '200ms', what: 'запроса синтеза' });
        assert.ok(!sent().slice(n).some((m) => m.text === 'И текстом следом'), 'текст не обогнал голосовое');
        // Синтез ждём по настоящему времени: часы шлюза не двигаем, чтобы не истёк срок попытки синтеза (60 с по часам).
        await waitUntil(() => readJournal(s.home).filter((l) => l.ev === 'tts_ready').length > ready || null, 10_000, 'синтеза');
        assert.ok(!sent().slice(n).some((m) => m.text === 'И текстом следом'), 'текст ждёт голосового');
        const out = await pump(gw, () => {
          const list = sent().slice(n).filter((m) => m.method === 'sendVoice' || m.text === 'И текстом следом');
          return list.length === 2 ? list : null;
        }, { what: 'обоих ответов' });
        assert.deepEqual(out.map((m) => m.method), ['sendVoice', 'sendMessage']);
      } finally {
        s.synth.latencyMs = 0;
      }
    });

    it('A4.8: синтез ответил ошибкой — «⚙ голос не получился» и текст; не Ogg — то же', async () => {
      for (const mode of ['error', 'not_ogg'] as const) {
        s.synth.ttsMode = mode;
        const calls = s.synth.tts.length;
        try {
          const seq = await ownerSays(`голосом (${mode})`);
          const n = sent().length;
          await ch.reply(seq, `Ответ текстом (${mode})`, turn, true);
          const two = await pump(gw, () => (botAfter(n).length >= 2 ? botAfter(n) : null), { what: 'пометки и текста' });
          assert.deepEqual(two.map((m) => m.text), [VOICE_FAILED_TEXT, `Ответ текстом (${mode})`]);
          assert.ok(!two.some((m) => m.method === 'sendVoice'));
          assert.equal(s.synth.tts.length - calls, mode === 'error' ? 2 : 1, 'ошибка сервера — ещё попытка; не Ogg — нет');
          assert.equal(q1<{ voice_failed: number }>(s.home, 'SELECT voice_failed FROM outbox WHERE event_seq = ? AND origin = ?', seq, 'agent')?.voice_failed, 1);
          await waitUntil(() => q1<{ kind: string }>(s.home, 'SELECT kind FROM messages_out WHERE tg_message_id = ?', two[0]!.message_id)?.kind === 'service' || null, 5000, 'messages_out');
          const j = readJournal(s.home).filter((l) => l.ev === 'tts_failed').at(-1);
          assert.equal(j?.reason, mode === 'error' ? s.synth.codes.server : 'not_ogg');
        } finally {
          s.synth.ttsMode = 'ok';
        }
      }
    });
  });

  describe(`M4 · Telegram не принял голосовое · ${dialect}`, () => {
    let s: VoiceSetup;
    after(() => s?.close());

    it('sendVoice → 400 (голосовые от ботов запрещены) — ответ не брошен: «⚙ голос не получился» и текст', async () => {
      s = await voiceSetup({ dialect });
      const gw = await s.start();
      const { ch, turn } = await connectAdapter(s.home);
      try {
        s.fake.onCall('sendVoice', 1, reply.error(400, 'Bad Request: VOICE_MESSAGES_FORBIDDEN'));
        const u = s.fake.push(s.fake.builder.text(OWNER, 'голосом'))[0]!;
        const seq = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
        await ch.waitEvent(seq);
        await ch.reply(seq, 'всё равно дошло', turn, true);
        await pump(gw, () => s.fake.sentTo(OWNER.id).some((m) => m.text === 'всё равно дошло') || null, { what: 'текста' });
        assert.ok(s.fake.sentTo(OWNER.id).some((m) => m.text === VOICE_FAILED_TEXT));
        assert.equal(s.fake.sentTo(OWNER.id).filter((m) => m.method === 'sendVoice').length, 0);
        assert.ok(readJournal(s.home).some((l) => l.ev === 'voice_rejected'));
        // Строка отмечается отправленной после ответа Telegram — чуть позже, чем текст виден в подделке.
        await waitUntil(() => q1<{ status: string }>(s.home, "SELECT status FROM outbox WHERE event_seq = ? AND origin = 'agent'", seq)?.status === 'sent' || null, 5000, 'sent');
      } finally {
        ch.close();
        await gw.stop();
      }
    });
  });

  describe(`M4 · голос не задан · ${dialect}`, () => {
    let s: VoiceSetup;
    after(() => s?.close());

    // У OpenAI голос по умолчанию есть всегда (tts.voice: alloy) — не задан он может быть только у ElevenLabs.
    it(dialect === 'elevenlabs' ? 'tts.voice_id пуст — синтезу не уходит, «⚙ голос не получился» и текст' : 'tts.voice не задан — голос по умолчанию alloy', async () => {
      s = await voiceSetup({ dialect, voiceId: null });
      if (dialect === 'openai') {
        const gw = await s.start();
        const { ch, turn } = await connectAdapter(s.home);
        try {
          const u = s.fake.push(s.fake.builder.text(OWNER, 'голосом'))[0]!;
          const seq = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
          await ch.waitEvent(seq);
          await ch.reply(seq, 'голосом по умолчанию', turn, true);
          await pump(gw, () => s.fake.sentTo(OWNER.id).some((m) => m.method === 'sendVoice') || null, { what: 'голосового' });
          assert.equal(s.synth.tts.at(-1)?.voice, 'alloy');
        } finally {
          ch.close();
          await gw.stop();
        }
        return;
      }
      const gw = await s.start();
      const { ch, turn } = await connectAdapter(s.home);
      try {
        const u = s.fake.push(s.fake.builder.text(OWNER, 'голосом'))[0]!;
        const seq = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
        await ch.waitEvent(seq);
        await ch.reply(seq, 'без голоса', turn, true);
        await pump(gw, () => s.fake.sentTo(OWNER.id).some((m) => m.text === 'без голоса') || null, { what: 'текста' });
        assert.ok(s.fake.sentTo(OWNER.id).some((m) => m.text === VOICE_FAILED_TEXT));
        assert.equal(s.synth.tts.length, 0);
        assert.equal(readJournal(s.home).find((l) => l.ev === 'tts_failed')?.reason, 'no_voice');
      } finally {
        ch.close();
        await gw.stop();
      }
    });
  });
}
