// Оговорки к провайдерам голоса для stg doctor (TECH-SPEC 5.8): OpenRouter — распознавание тем же клиентом openai
// (не проверено на настоящем ключе), синтез — заведомо не Ogg/Opus (по анонсу OpenRouter только mp3 или pcm).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { voiceProviderNote } from './voice-provider.js';

describe('оговорки к провайдерам голоса', () => {
  it('OpenAI напрямую и ElevenLabs — без оговорки', () => {
    assert.equal(voiceProviderNote({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', what: 'stt' }), null);
    assert.equal(voiceProviderNote({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', what: 'tts' }), null);
    assert.equal(voiceProviderNote({ provider: 'elevenlabs', baseUrl: 'https://api.elevenlabs.io', what: 'tts' }), null);
  });

  it('OpenRouter: распознавание — сверить, синтез — «нет»', () => {
    const stt = voiceProviderNote({ provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', what: 'stt' });
    assert.ok(stt && !stt.blocking && /не проверены на настоящем ключе/.test(stt.text));
    const tts = voiceProviderNote({ provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', what: 'tts' });
    assert.ok(tts && tts.blocking && /mp3 или pcm/.test(tts.text));
  });
});
