// OpenAI-совместимый API за общим интерфейсом голоса (voice-provider.ts; TECH-SPEC 5.8): второй провайдер рядом с
// ElevenLabs. Тот же клиент рассчитан на любой OpenAI-совместимый
// адрес, в том числе OpenRouter (https://openrouter.ai/api/v1, модель с префиксом openai/…, свой ключ — всё в
// config.yaml). По анонсу OpenRouter пути /audio/transcriptions и /audio/speech у него есть, но
// синтез отдаёт только mp3 или pcm — голосовому Telegram нужен Ogg/Opus, поэтому через OpenRouter — только распознавание.
//
// Договор — по документации OpenAI (не проверено на ключе):
// - распознавание: POST {base_url}/audio/transcriptions, multipart/form-data: file (голосовое Telegram — Ogg/Opus как
//   audio/ogg с именем *.ogg: по расширению провайдер узнаёт формат), model, language (ISO-639-1: ru), prompt (словарь
//   строкой через запятую), response_format=json → JSON {text, …};
// - синтез: POST {base_url}/audio/speech, JSON {model, input, voice, response_format: "opus", instructions?} → байты
//   звука (ждём Ogg/Opus; проверяется своим кодом — не Ogg значит отказ not_ogg);
// - ключ — заголовок Authorization: Bearer <ключ>;
// - ошибки — JSON {error: {message, type, param, code}} (у OpenRouter code бывает числом); 429 и 5xx — временные, кроме
//   429 insufficient_quota (деньги кончились — повтор не поможет).

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

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENAI_STT_PATH = '/audio/transcriptions';
export const OPENAI_TTS_PATH = '/audio/speech';

/** Предел input у /audio/speech — 4096 знаков. */
export const OPENAI_TTS_MAX_CHARS = 4096;
/**
 * Словарь в prompt — не длиннее (целыми терминами): подсказка распознавателю, а не текст; длинную модель режет или
 * не берёт ⟨предл.; на ключе не проверено⟩.
 */
export const OPENAI_PROMPT_MAX_CHARS = 1000;

/** Коды, при которых повтор не поможет, хотя статус временный. */
const NOT_RETRYABLE_CODES = new Set(['insufficient_quota', 'billing_hard_limit_reached']);

/** Код и текст отказа — целиком: тело уже без ключа, обрезает providerFetch (после маски). */
function describeError(body: unknown, status: number): { code: string; message: string } {
  const e = (body as { error?: unknown } | null)?.error;
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; type?: unknown; code?: unknown };
    const code = typeof o.code === 'string' && o.code ? o.code : typeof o.type === 'string' && o.type ? o.type : `http_${status}`;
    return { code, message: typeof o.message === 'string' ? o.message : JSON.stringify(e) };
  }
  if (typeof e === 'string') return { code: `http_${status}`, message: e };
  return { code: `http_${status}`, message: `HTTP ${status}` };
}

function retryable(status: number, code: string): boolean | undefined {
  return status === 429 && NOT_RETRYABLE_CODES.has(code) ? false : undefined;
}

/** Словарь — строкой для prompt: термины через запятую, целыми, не длиннее OPENAI_PROMPT_MAX_CHARS. */
export function vocabularyPrompt(vocabulary: readonly string[]): string {
  return vocabularyPromptTerms(vocabulary).join(', ');
}

/** Термины словаря, которые уходят в prompt (по порядку, пока строка не длиннее OPENAI_PROMPT_MAX_CHARS). */
export function vocabularyPromptTerms(vocabulary: readonly string[]): string[] {
  const out: string[] = [];
  let length = 0;
  for (const t of vocabulary) {
    const next = length + (out.length ? 2 : 0) + t.length;
    if (next > OPENAI_PROMPT_MAX_CHARS) break;
    out.push(t);
    length = next;
  }
  return out;
}

export class OpenAiSpeechToText implements SpeechToText {
  readonly info: VoiceProviderInfo;

  constructor(opts: { baseUrl: string; model: string }) {
    this.info = { provider: 'openai', baseUrl: opts.baseUrl, model: opts.model };
  }

  async transcribe(audio: Uint8Array, mime: string, opts: TranscribeOptions, call: VoiceCall): Promise<Transcript> {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime }), opts.filename ?? 'voice.ogg');
    form.append('model', this.info.model);
    form.append('language', opts.language);
    const prompt = vocabularyPrompt(opts.vocabulary);
    if (prompt) form.append('prompt', prompt);
    form.append('response_format', 'json');
    const res = await providerFetch({
      what: 'stt',
      provider: 'openai',
      url: `${trimUrl(this.info.baseUrl)}${OPENAI_STT_PATH}`,
      init: { method: 'POST', body: form },
      auth: { authorization: `Bearer ${call.key}` },
      key: call.key,
      signal: call.signal,
      describe: describeError,
      retryable,
    });
    const { text, body } = await readTranscript(res, { provider: 'openai', key: call.key, signal: call.signal });
    // usage.output_tokens — у gpt-4o-transcribe и новее; у whisper-1 токенов в usage, видимо, нет ⟨по памяти; сверить⟩.
    const usage = body.usage as { output_tokens?: unknown } | undefined;
    return {
      text,
      language: typeof body.language === 'string' ? body.language : null,
      outputTokens: typeof usage?.output_tokens === 'number' && Number.isFinite(usage.output_tokens) ? usage.output_tokens : null,
    };
  }
}

export class OpenAiTextToSpeech implements TextToSpeech {
  readonly info: VoiceProviderInfo;
  readonly maxChars = OPENAI_TTS_MAX_CHARS;
  /** Как говорить (только у gpt-4o-mini-tts и новее); null — не посылать. */
  readonly instructions: string | null;

  constructor(opts: { baseUrl: string; model: string; instructions?: string | null }) {
    this.info = { provider: 'openai', baseUrl: opts.baseUrl, model: opts.model };
    this.instructions = opts.instructions ?? null;
  }

  async synthesize(text: string, opts: { voice: string }, call: VoiceCall): Promise<Speech> {
    if (text.length > this.maxChars) throw tooLong('openai', text.length, this.maxChars);
    const body: Record<string, string> = { model: this.info.model, input: text, voice: opts.voice, response_format: 'opus' };
    if (this.instructions) body.instructions = this.instructions;
    const res = await providerFetch({
      what: 'tts',
      provider: 'openai',
      url: `${trimUrl(this.info.baseUrl)}${OPENAI_TTS_PATH}`,
      init: { method: 'POST', headers: { 'content-type': 'application/json', accept: 'audio/ogg, audio/opus, audio/*' }, body: JSON.stringify(body) },
      auth: { authorization: `Bearer ${call.key}` },
      key: call.key,
      signal: call.signal,
      describe: describeError,
      retryable,
    });
    return readSpeech(res, { provider: 'openai', key: call.key, signal: call.signal });
  }
}
