// ElevenLabs за общим интерфейсом голоса (voice-provider.ts; TECH-SPEC 5.8; Ш-7, Ш-8) на встроенном fetch:
// распознавание (Speech-to-Text, Scribe) и синтез (Text-to-Speech). Адрес — из config.yaml (stt.base_url, tts.base_url):
// в работе — https://api.elevenlabs.io, в тестах — поддельный ElevenLabs на 127.0.0.1. Ключ — заголовок xi-api-key.
//
// Договор — по документации ElevenLabs (не проверено на ключе):
// - POST /v1/speech-to-text, multipart/form-data: model_id, file, language_code, tag_audio_events, keyterms (каждый
//   термин — отдельным полем) → JSON {language_code, language_probability, text, words};
// - POST /v1/text-to-speech/{voice_id}?output_format=opus_48000_64, JSON {text, model_id} → байты звука;
// - ошибки — JSON {detail: {status, message}} (или {detail: [...]} у 422); 429 и 5xx — временные.

import {
  providerFetch,
  readSpeech,
  readTranscript,
  tooLong,
  trimUrl,
  type Speech,
  type SpeechToText,
  type TextToSpeech,
  type TranscribeOptions,
  type Transcript,
  type VoiceCall,
  type VoiceProviderInfo,
} from './voice-provider.js';

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
export const ELEVENLABS_STT_PATH = '/v1/speech-to-text';
export const ELEVENLABS_TTS_PATH = '/v1/text-to-speech/';

/** Сколько знаков отдаём синтезу за раз (предел запроса у eleven_multilingual_v2 — 10 000). */
export const ELEVENLABS_TTS_MAX_CHARS = 10_000;

/**
 * Текст ошибки ElevenLabs: detail.status + detail.message, или первая запись списка у 422 — целиком: тело уже без
 * ключа, обрезает providerFetch (после маски).
 */
function describeError(body: unknown, status: number): { code: string; message: string } {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const o = d as { status?: unknown; message?: unknown };
    return {
      code: typeof o.status === 'string' ? o.status : `http_${status}`,
      message: typeof o.message === 'string' ? o.message : JSON.stringify(d),
    };
  }
  if (Array.isArray(d)) {
    const first = d[0] as { loc?: unknown[]; msg?: unknown } | undefined;
    const where = Array.isArray(first?.loc) ? first.loc.join('.') : '';
    return { code: 'validation_error', message: `${where}: ${typeof first?.msg === 'string' ? first.msg : JSON.stringify(first)}` };
  }
  if (typeof d === 'string') return { code: `http_${status}`, message: d };
  return { code: `http_${status}`, message: `HTTP ${status}` };
}

export class ElevenLabsSpeechToText implements SpeechToText {
  readonly info: VoiceProviderInfo;

  constructor(opts: { baseUrl: string; model: string }) {
    this.info = { provider: 'elevenlabs', baseUrl: opts.baseUrl, model: opts.model };
  }

  async transcribe(audio: Uint8Array, mime: string, opts: TranscribeOptions, call: VoiceCall): Promise<Transcript> {
    const form = new FormData();
    form.append('model_id', this.info.model);
    form.append('language_code', opts.language);
    // Звуковые пометки («(смех)») в заметках владельца не нужны.
    form.append('tag_audio_events', 'false');
    for (const t of opts.vocabulary) form.append('keyterms', t);
    form.append('file', new Blob([audio], { type: mime }), opts.filename ?? 'voice.ogg');
    const res = await providerFetch({
      what: 'stt',
      provider: 'elevenlabs',
      url: `${trimUrl(this.info.baseUrl)}${ELEVENLABS_STT_PATH}`,
      init: { method: 'POST', body: form },
      auth: { 'xi-api-key': call.key },
      key: call.key,
      signal: call.signal,
      describe: describeError,
    });
    const { text, body } = await readTranscript(res, { provider: 'elevenlabs', key: call.key, signal: call.signal });
    return { text, language: typeof body.language_code === 'string' ? body.language_code : null, outputTokens: null };
  }
}

export class ElevenLabsTextToSpeech implements TextToSpeech {
  readonly info: VoiceProviderInfo;
  readonly maxChars = ELEVENLABS_TTS_MAX_CHARS;
  /** opus_48000_64 (5.8). */
  readonly outputFormat: string;

  constructor(opts: { baseUrl: string; model: string; outputFormat: string }) {
    this.info = { provider: 'elevenlabs', baseUrl: opts.baseUrl, model: opts.model };
    this.outputFormat = opts.outputFormat;
  }

  async synthesize(text: string, opts: { voice: string }, call: VoiceCall): Promise<Speech> {
    if (text.length > this.maxChars) throw tooLong('elevenlabs', text.length, this.maxChars);
    const url = `${trimUrl(this.info.baseUrl)}${ELEVENLABS_TTS_PATH}${encodeURIComponent(opts.voice)}?output_format=${encodeURIComponent(this.outputFormat)}`;
    const res = await providerFetch({
      what: 'tts',
      provider: 'elevenlabs',
      url,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'audio/ogg, audio/*' },
        body: JSON.stringify({ text, model_id: this.info.model }),
      },
      auth: { 'xi-api-key': call.key },
      key: call.key,
      signal: call.signal,
      describe: describeError,
    });
    return readSpeech(res, { provider: 'elevenlabs', key: call.key, signal: call.signal });
  }
}
