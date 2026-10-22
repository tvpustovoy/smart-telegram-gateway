// Ключ голоса (TECH-SPEC 5.8): берётся по имени из config.yaml, помнится и маскируется в журнале; после отказа вида
// auth (401, 403) — перечитывается из хранилища при следующем запросе. Одно имя у распознавания и синтеза — один ключ.
// Под тестом хранилище — переменные STG_TEST_VOICE_KEY_<ИМЯ> (STG_TEST=1); связка ключей не трогается.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from 'stg-core';
import type { Ctx } from './context.js';
import { VoiceKey, voiceFromConfig } from './voice.js';

/** Ctx ровно настолько, насколько его видит ключ голоса: env, config, journal. */
function stubCtx(env: NodeJS.ProcessEnv, voice: { stt?: Record<string, unknown>; tts?: Record<string, unknown> } = {}) {
  const secrets: string[] = [];
  const events: Array<{ ev: string; data: unknown }> = [];
  const config = parseConfig({ bot: 'b_bot', timezone: 'UTC', ...voice }, { test: true });
  const ctx = {
    env,
    config,
    journal: {
      write: (ev: string, data: unknown) => events.push({ ev, data }),
      addSecret: (s: string) => secrets.push(s),
    },
  } as unknown as Ctx;
  return { ctx, secrets, events };
}

describe('ключ голоса: помнится, после auth — перечитывается', () => {
  it('get() помнит ключ; invalidate() — следующий get() читает хранилище заново и берёт новый ключ', async () => {
    const env: NodeJS.ProcessEnv = { STG_TEST: '1', STG_TEST_VOICE_KEY_OPENAI: 'sk-old-key-0001' };
    const { ctx, secrets } = stubCtx(env);
    const key = new VoiceKey(ctx, 'openai');
    assert.equal(key.known, null, 'ещё не смотрели');
    assert.equal(await key.get(), 'sk-old-key-0001');
    assert.equal(key.known, true);
    // Владелец положил новый ключ (security … -U): без invalidate() шлюз держит прежний — связку не дёргает на каждый запрос.
    env.STG_TEST_VOICE_KEY_OPENAI = 'sk-new-key-0002';
    assert.equal(await key.get(), 'sk-old-key-0001');
    // Провайдер не принял ключ (401, 403) — перечитать.
    key.invalidate();
    assert.equal(await key.get(), 'sk-new-key-0002');
    assert.deepEqual(secrets, ['sk-old-key-0001', 'sk-new-key-0002'], 'оба ключа — в маске журнала');
    // Ключ убрали совсем — после invalidate() его нет, и это видно (known: false → «нет ключа» в «статус»).
    delete env.STG_TEST_VOICE_KEY_OPENAI;
    key.invalidate();
    assert.equal(await key.get(), null);
    assert.equal(key.known, false);
  });

  it('одно имя у распознавания и синтеза — один ключ: invalidate() после отказа синтеза сбрасывает и распознавание', async () => {
    const env: NodeJS.ProcessEnv = { STG_TEST: '1', STG_TEST_VOICE_KEY_OPENAI: 'sk-shared-0001' };
    const { ctx } = stubCtx(env);
    const v = voiceFromConfig(ctx);
    assert.equal(v.sttKey, v.ttsKey, 'один объект ключа');
    assert.equal(await v.sttKey.get(), 'sk-shared-0001');
    env.STG_TEST_VOICE_KEY_OPENAI = 'sk-shared-0002';
    v.ttsKey.invalidate();
    assert.equal(await v.sttKey.get(), 'sk-shared-0002', 'распознавание берёт перечитанный ключ');
  });

  it('разные имена — разные ключи: invalidate() одного не трогает другой', async () => {
    const env: NodeJS.ProcessEnv = { STG_TEST: '1', STG_TEST_VOICE_KEY_OPENROUTER: 'sk-or-0001', STG_TEST_VOICE_KEY_ELEVENLABS: 'xi-0001' };
    const { ctx } = stubCtx(env, { stt: { key: 'openrouter' }, tts: { provider: 'elevenlabs' } });
    const v = voiceFromConfig(ctx);
    assert.notEqual(v.sttKey, v.ttsKey);
    assert.deepEqual([await v.sttKey.get(), await v.ttsKey.get()], ['sk-or-0001', 'xi-0001']);
    env.STG_TEST_VOICE_KEY_OPENROUTER = 'sk-or-0002';
    env.STG_TEST_VOICE_KEY_ELEVENLABS = 'xi-0002';
    v.sttKey.invalidate();
    assert.deepEqual([await v.sttKey.get(), await v.ttsKey.get()], ['sk-or-0002', 'xi-0001']);
  });
});
