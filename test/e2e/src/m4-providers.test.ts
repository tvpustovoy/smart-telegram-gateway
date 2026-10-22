// M4 · провайдеры голоса за сменной обёрткой (TECH-SPEC 5.8; модели можно ставить и заменять без правки
// кода): смешанный случай — распознавание OpenAI-совместимым провайдером (ключ под своим именем, как у
// OpenRouter), синтез — ElevenLabs; смена провайдера в config.yaml без правки кода; 401 — отказ без повтора, ключ в
// журнал не попал, хотя провайдер вернул его в тексте ошибки (П-2). Что ключ после 401 перечитывается из хранилища (а не
// берётся прежний), проверяет модульный тест packages/gateway/src/voice.test.ts: здесь ключ под тестом один и тот же.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { Update } from 'stg-core';
import type { FakeVoiceServer } from 'stg-fake-elevenlabs';
import { connectAdapter, filesContaining, outputsContaining, pump, q1, readJournal, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER } from './m1-common.js';
import { VOICE_KEYS, pushVoice, startFakeVoice, sttRepliesOf, voiceKeyEnv, voiceSetup, type VoiceSetup } from './m4-common.js';

const seqOf = (s: VoiceSetup, u: Update): Promise<number> =>
  waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, `приёма ${u.update_id}`);
const transcriptOf = (s: VoiceSetup, seq: number): string | null =>
  q1<{ transcript: string | null }>(s.home, 'SELECT transcript FROM events WHERE seq = ?', seq)?.transcript ?? null;

/** Голосовое владельца (последнее — в lastVoice) → расшифровка записана (или отказ). */
let lastVoice: Update | null = null;
async function voiceIn(s: VoiceSetup, gw: GatewayProcess, seconds: number): Promise<number> {
  lastVoice = pushVoice(s, seconds);
  const seq = await seqOf(s, lastVoice);
  await pump(gw, () => q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status !== 'transcribing' || null, { what: 'распознавания' });
  return seq;
}

describe('M4 · смешанный случай: распознавание openai (ключ openrouter), синтез elevenlabs', () => {
  let s: VoiceSetup;
  let gw: GatewayProcess;
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s?.close();
  });

  it('голосовое — в OpenAI-совместимый с Bearer своего ключа; ответ голосом — в ElevenLabs с xi-api-key; «статус» называет обоих', async () => {
    s = await voiceSetup({ dialect: 'openai', ttsDialect: 'elevenlabs', sttKey: 'openrouter', fake: { transcript: 'смешанный случай работает', ttsSeconds: 2.2 } });
    assert.notEqual(s.voice, s.synth);
    gw = await s.start();
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const seq = await voiceIn(s, gw, 4);
      assert.equal(transcriptOf(s, seq), 'смешанный случай работает');
      assert.equal(s.voice.stt.length, 1);
      assert.equal(s.synth.stt.length, 0, 'ElevenLabs распознавания не получал');
      assert.ok(s.voice.calls.every((c) => c.authorized) && s.synth.calls.every((c) => c.authorized));
      await ch.waitEvent(seq);
      await ch.reply(seq, 'Ответ голосом из ElevenLabs', turn, true);
      const v = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.method === 'sendVoice'), { what: 'голосового' });
      assert.equal(v.voice?.duration, 2);
      assert.equal(s.synth.tts.length, 1);
      assert.equal(s.voice.tts.length, 0, 'OpenAI синтеза не получал');
      assert.deepEqual([s.synth.tts[0]?.voice, s.synth.tts[0]?.format], ['voice_test', 'opus_48000_64']);
      s.fake.push(s.fake.builder.text(OWNER, 'статус'));
      const st = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => (m.text ?? '').startsWith('⚙ Статус')), { what: '«статус»' });
      const host = new URL(s.voice.baseUrl).host;
      assert.ok(st.text!.includes(`\nРаспознавание: OpenAI-совместимый (${host}) gpt-4o-mini-transcribe, язык ru, словарь 3 · за сутки распознано 1, не распознано 0\n`), st.text!);
      assert.ok(st.text!.includes('\nСинтез: ElevenLabs eleven_multilingual_v2, голос voice_test\n'), st.text!);
      const cfg = readJournal(s.home).find((l) => l.ev === 'stt_config');
      assert.deepEqual([cfg?.provider, cfg?.key, cfg?.model], ['openai', 'openrouter', 'gpt-4o-mini-transcribe']);
      const keys = readJournal(s.home)
        .filter((l) => l.ev === 'stt_key' || l.ev === 'tts_key')
        .map((l) => `${l.ev} ${String(l.name)} ${String(l.present)}`)
        .sort();
      assert.deepEqual(keys, ['stt_key openrouter true', 'tts_key elevenlabs true'], 'два ключа — каждый под своим именем');
    } finally {
      ch.close();
    }
  });
});

describe('M4 · смена провайдера в config.yaml без правки кода', () => {
  let s: VoiceSetup;
  let openai: FakeVoiceServer | null = null;
  after(async () => {
    await s?.close();
    await openai?.stop();
  });

  it('elevenlabs → openai: после перезапуска голосовые идут в OpenAI; прежняя подделка больше вызовов не получает', async () => {
    s = await voiceSetup({ dialect: 'elevenlabs', fake: { transcript: 'через elevenlabs' } });
    const g1 = await s.start();
    const a = await voiceIn(s, g1, 3);
    assert.equal(transcriptOf(s, a), 'через elevenlabs');
    await g1.stop();

    openai = await startFakeVoice('openai', { transcript: 'через openai' });
    const file = path.join(s.home.dir, 'config.yaml');
    const text = fs
      .readFileSync(file, 'utf8')
      .replace(/^stt: .*$/m, openai.sttYaml().trimEnd())
      .replace(/^tts: .*$/m, openai.ttsYaml().trimEnd());
    fs.writeFileSync(file, text);
    const g2 = await s.start({ [voiceKeyEnv('openai')]: VOICE_KEYS.openai });
    try {
      const before = s.voice.stt.length;
      const b = await voiceIn(s, g2, 3);
      assert.equal(transcriptOf(s, b), 'через openai');
      assert.equal(openai.stt.length, 1);
      assert.equal(s.voice.stt.length, before, 'ElevenLabs больше не вызывается');
      assert.equal(readJournal(s.home).filter((l) => l.ev === 'stt_config').at(-1)?.provider, 'openai');
    } finally {
      await g2.stop();
    }
    const hits = [...filesContaining(s.home.dir, VOICE_KEYS.openai), ...outputsContaining(s.home, VOICE_KEYS.openai)];
    assert.deepEqual(hits, [], 'П-2: ключ OpenAI нигде не записан');
  });
});

describe('M4 · провайдер не принял ключ (401)', () => {
  let s: VoiceSetup;
  let gw: GatewayProcess;
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s?.close();
  });

  it('отказ без повтора (вид auth) — ответом «Не смог распознать»; ключ из текста ошибки провайдера в журнал не попал; следующее голосовое распознано', async () => {
    s = await voiceSetup({ dialect: 'openai', fake: { transcript: 'со свежим ключом' } });
    gw = await s.start();
    s.voice.sttScript = ['bad_key'];
    const a = await voiceIn(s, gw, 2);
    const ua = lastVoice!;
    assert.equal(transcriptOf(s, a), null);
    // Ответ уходит отправителем после записи отказа — ждать его, а не читать сразу (иначе гонка).
    const said = await pump(gw, () => sttRepliesOf(s, ua)[0]?.text ?? null, { what: 'ответа «Не смог распознать»' });
    assert.equal(said, 'Не смог распознать — звук сохранён. Срочное — текстом');
    assert.equal(s.voice.stt.length, 1, 'на 401 повтора нет');
    const fail = readJournal(s.home).find((l) => l.ev === 'stt_attempt_failed' && l.seq === a);
    assert.deepEqual([fail?.status, fail?.kind, fail?.code], [401, 'auth', 'invalid_api_key']);
    assert.match(String(fail?.error), /Incorrect API key provided: <секрет>/, 'ключ из текста ошибки вырезан');
    assert.equal(readJournal(s.home).find((l) => l.ev === 'stt_failed' && l.seq === a)?.reason, 'invalid_api_key');
    const b = await voiceIn(s, gw, 2);
    assert.equal(transcriptOf(s, b), 'со свежим ключом');
    // Ключ (в том числе из ответа провайдера) — ни в файлах каталога, ни в выводе шлюза: проверка при закрытии.
  });
});
