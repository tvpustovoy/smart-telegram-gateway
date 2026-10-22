// Голос за сменной обёрткой (TECH-SPEC 5.8): провайдеров и модели можно ставить и заменять.
//
// Два интерфейса — распознавание (SpeechToText) и синтез (TextToSpeech) — и общий вид отказа провайдера
// (VoiceProviderError). Всё, что выше провайдера (voice.ts шлюза: порядок, сроки, повторы, предохранитель, ответ с
// расшифровкой на голосовое, чистка), от провайдера не зависит: оно видит только эти интерфейсы и вид отказа.
//
// Реализации: openai.ts — OpenAI-совместимый API (OpenAI напрямую; OpenRouter тем же клиентом — только распознавание),
// elevenlabs.ts — ElevenLabs. Какая работает — config.yaml (stt.provider, tts.provider), независимо для распознавания и синтеза.
//
// Ключ провайдер не хранит: его даёт шлюз на каждый вызов (ключ перечитывается из связки после 401, 403). В адрес,
// текст отказа и журнал ключ не попадает: тело ответа с ошибкой маскируется до разбора, а обрезается — уже после маски
// (обрезка до маски оставила бы начало ключа, которое маска целиком не узнаёт).

import { inspectOggOpus, magicOf, type OggOpusInfo } from './ogg.js';
import { redactSecrets } from './secrets.js';

/** Провайдеры голоса (config.yaml: stt.provider, tts.provider). */
export const VOICE_PROVIDERS = ['openai', 'elevenlabs'] as const;
export type VoiceProviderName = (typeof VOICE_PROVIDERS)[number];

export type VoiceWhat = 'stt' | 'tts';

/**
 * Вид отказа: auth — ключ не принят (401, 403); rate — предел запросов (429); server — сбой у провайдера (5xx);
 * network — сеть, срок, обрыв; bad_input — провайдер не принял запрос (4xx, слишком длинный текст);
 * bad_output — ответ не годится (не JSON, нет текста, пустая расшифровка, звук не Ogg/Opus).
 */
export type VoiceErrorKind = 'auth' | 'rate' | 'server' | 'network' | 'bad_input' | 'bad_output';

/** Отказ провайдера голоса — один вид для всех провайдеров. */
export class VoiceProviderError extends Error {
  constructor(
    readonly what: VoiceWhat,
    readonly provider: VoiceProviderName,
    /** HTTP-статус; null — до ответа (сеть, срок) или своя проверка. */
    readonly status: number | null,
    readonly kind: VoiceErrorKind,
    /** Код словом — для журнала и «последний отказ»: код провайдера, timeout, network, not_ogg, empty, too_long… */
    readonly code: string,
    message: string,
    /** Повтор имеет смысл (rate, server, network — обычно да). */
    readonly retryable: boolean,
    /** Retry-After, мс. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** Ключ и отмена — на каждый вызов. */
export interface VoiceCall {
  key: string;
  signal: AbortSignal;
}

export interface TranscribeOptions {
  /** Язык явно (Ш-7): «ru». */
  language: string;
  /** Словарь терминов: имена и слова, которые распознаватель должен слышать. */
  vocabulary: readonly string[];
  /** Имя файла для провайдера (по расширению он узнаёт формат): голосовое Telegram — *.ogg. */
  filename?: string;
}

export interface Transcript {
  /** Расшифровка — пробелы сжаты; пустой не бывает (пустая — отказ empty). */
  text: string;
  /** Язык, если провайдер его назвал. */
  language: string | null;
  /**
   * Сколько токенов в расшифровке насчитал провайдер (у OpenAI — usage.output_tokens), если назвал; null — не назвал.
   * В журнале рядом с длительностью звука: у модели есть предел ответа, и обрезанная расшифровка без этого не видна.
   */
  outputTokens: number | null;
}

export interface Speech {
  /** Ogg/Opus — проверен своим кодом. */
  audio: Buffer;
  info: OggOpusInfo;
}

/** Что видно владельцу о провайдере («статус», stg doctor). */
export interface VoiceProviderInfo {
  provider: VoiceProviderName;
  baseUrl: string;
  model: string;
}

/** Распознавание: звук → текст или отказ VoiceProviderError (признак retryable — повторять ли). */
export interface SpeechToText {
  readonly info: VoiceProviderInfo;
  transcribe(audio: Uint8Array, mime: string, opts: TranscribeOptions, call: VoiceCall): Promise<Transcript>;
}

/** Синтез: текст → Ogg/Opus с длительностью или отказ VoiceProviderError. */
export interface TextToSpeech {
  readonly info: VoiceProviderInfo;
  /** Сколько знаков провайдер берёт за раз; длиннее — отказ too_long (ответ уходит текстом). */
  readonly maxChars: number;
  synthesize(text: string, opts: { voice: string }, call: VoiceCall): Promise<Speech>;
}

// ——— общее для реализаций ———

/** Сюда не попадаем: проверка полноты switch по провайдеру (третий провайдер — ошибка компиляции, а не молчание). */
export function unknownProvider(p: never): never {
  throw new Error(`неизвестный провайдер голоса: ${String(p)}`);
}

/** Текст отказа провайдера в VoiceProviderError — не длиннее (обрезка — после маски ключа). */
export const PROVIDER_ERROR_MAX_CHARS = 300;
/** Код отказа словом — не длиннее. */
const PROVIDER_CODE_MAX_CHARS = 64;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Маска ключа во всех строках разобранного тела ответа (ключ мог прийти в JSON экранированным \uXXXX). */
function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[redactSecrets(k, secrets)] = redactDeep(v, secrets);
    return out;
  }
  return value;
}

export function trimUrl(base: string): string {
  return base.replace(/\/+$/, '');
}

/** Вид отказа по HTTP-статусу. */
export function kindOfStatus(status: number): VoiceErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status === 408) return 'network';
  if (status >= 500) return 'server';
  return 'bad_input';
}

export function retryableKind(kind: VoiceErrorKind): boolean {
  return kind === 'rate' || kind === 'server' || kind === 'network';
}

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

/** Сеть или срок: до ответа провайдера. */
export function networkError(what: VoiceWhat, provider: VoiceProviderName, err: unknown, signal: AbortSignal, key: string): VoiceProviderError {
  if (signal.aborted) {
    const reason = signal.reason as { message?: string } | undefined;
    return new VoiceProviderError(what, provider, null, 'network', 'timeout', `нет ответа: ${reason?.message ?? 'срок вышел'}`, true);
  }
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const detail = `${e?.cause?.code ?? e?.name ?? 'ошибка сети'}${e?.cause?.message ? `: ${e.cause.message}` : ''}`;
  return new VoiceProviderError(what, provider, null, 'network', 'network', redactSecrets(detail, [key]), true);
}

export interface ProviderRequest {
  what: VoiceWhat;
  provider: VoiceProviderName;
  url: string;
  init: RequestInit;
  /** Заголовки с ключом (xi-api-key, Authorization). */
  auth: Record<string, string>;
  key: string;
  signal: AbortSignal;
  /**
   * Код и текст отказа из тела ответа провайдера — целиком, без обрезки: тело уже без ключа, а обрезает providerFetch
   * после ещё одной маски.
   */
  describe(body: unknown, status: number): { code: string; message: string };
  /** Поправка «повторять ли» по коду (например, insufficient_quota у 429 — не повторять). */
  retryable?(status: number, code: string): boolean | undefined;
}

/** Запрос к провайдеру: ответ 2xx — как есть; иначе VoiceProviderError с кодом, видом и признаком повтора. */
export async function providerFetch(r: ProviderRequest): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(r.url, { ...r.init, headers: { ...(r.init.headers as Record<string, string> | undefined), ...r.auth }, signal: r.signal });
  } catch (err) {
    throw networkError(r.what, r.provider, err, r.signal, r.key);
  }
  if (res.ok) return res;
  // Сначала маска, потом разбор и обрезка: ключ в тексте ошибки (OpenAI-совместимый провайдер может вернуть присланный
  // ключ) не должен пройти даже началом — ни в текст отказа, ни в журнал.
  let body: unknown = null;
  try {
    body = redactDeep(JSON.parse(redactSecrets(await res.text(), [r.key])) as unknown, [r.key]);
  } catch {
    body = null;
  }
  const d = r.describe(body, res.status);
  const code = clip(redactSecrets(d.code, [r.key]), PROVIDER_CODE_MAX_CHARS);
  const message = clip(redactSecrets(`${res.status} ${code}: ${d.message}`, [r.key]), PROVIDER_ERROR_MAX_CHARS);
  const kind = kindOfStatus(res.status);
  const retryable = r.retryable?.(res.status, code) ?? retryableKind(kind);
  throw new VoiceProviderError(r.what, r.provider, res.status, kind, code, message, retryable, retryAfterMs(res));
}

/** Ответ распознавания — JSON с полем text; пустая расшифровка — отказ empty: «распознать не смог» честнее пустой строки. */
export async function readTranscript(res: Response, r: { provider: VoiceProviderName; key: string; signal: AbortSignal }): Promise<{ text: string; body: Record<string, unknown> }> {
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (r.signal.aborted) throw networkError('stt', r.provider, err, r.signal, r.key);
    throw new VoiceProviderError('stt', r.provider, res.status, 'bad_output', 'bad_response', 'ответ не JSON', true);
  }
  const text = typeof body?.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : null;
  if (text === null) throw new VoiceProviderError('stt', r.provider, res.status, 'bad_output', 'bad_response', 'в ответе нет text', false);
  if (!text) throw new VoiceProviderError('stt', r.provider, res.status, 'bad_output', 'empty', 'расшифровка пустая', false);
  return { text, body };
}

/**
 * Звук синтеза: контейнер проверяется своим кодом — Ogg/Opus с OpusHead и целыми страницами; иначе отказ not_ogg (с
 * началом файла для журнала): sendVoice принимает только Ogg/Opus.
 */
export async function readSpeech(res: Response, r: { provider: VoiceProviderName; key: string; signal: AbortSignal }): Promise<Speech> {
  let audio: Buffer;
  try {
    audio = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw networkError('tts', r.provider, err, r.signal, r.key);
  }
  const check = inspectOggOpus(audio);
  if (!check.ok) {
    throw new VoiceProviderError(
      'tts',
      r.provider,
      res.status,
      'bad_output',
      'not_ogg',
      `${check.reason}; content-type ${res.headers.get('content-type') ?? '?'}, начало ${magicOf(audio)}`,
      false,
    );
  }
  return { audio, info: check.info };
}

export function tooLong(provider: VoiceProviderName, length: number, max: number): VoiceProviderError {
  return new VoiceProviderError('tts', provider, null, 'bad_input', 'too_long', `текст ${length} знаков — синтез берёт до ${max}`, false);
}

/** Под тестом (STG_TEST=1) — только подделка на этой машине: настоящий API тесты не вызывают. */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  } catch {
    return false;
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Провайдер словами — для «статус» и stg doctor: OpenAI, OpenRouter, OpenAI-совместимый (адрес), ElevenLabs. */
export function voiceProviderLabel(info: { provider: VoiceProviderName; baseUrl: string }): string {
  switch (info.provider) {
    case 'elevenlabs':
      return 'ElevenLabs';
    case 'openai': {
      const host = hostOf(info.baseUrl);
      if (host === 'api.openai.com') return 'OpenAI';
      if (host === 'openrouter.ai') return 'OpenRouter';
      return `OpenAI-совместимый (${host})`;
    }
    default:
      return unknownProvider(info.provider);
  }
}

/**
 * Оговорка к провайдеру для stg doctor. OpenRouter — тем же клиентом openai: по анонсу OpenRouter
 * (openrouter.ai/blog/announcements/announcing-audio-apis) пути /api/v1/audio/transcriptions
 * (multipart в духе OpenAI) и /api/v1/audio/speech есть. Но синтез там отдаёт только mp3 или pcm, а голосовому Telegram
 * нужен Ogg/Opus: ответ голосом через OpenRouter в 0.1 не выйдет (уйдёт текстом с «⚙ голос не получился»).
 * `blocking` — вариант заведомо не работает (stg doctor пишет «нет»).
 */
export function voiceProviderNote(info: {
  provider: VoiceProviderName;
  baseUrl: string;
  what: 'stt' | 'tts';
}): { text: string; blocking: boolean } | null {
  switch (info.provider) {
    case 'elevenlabs':
      return null;
    case 'openai':
      if (hostOf(info.baseUrl) !== 'openrouter.ai') return null;
      return info.what === 'tts'
        ? {
            text: 'у OpenRouter синтез отдаёт только mp3 или pcm, а голосовому Telegram нужен Ogg/Opus — ответ голосом уйдёт текстом',
            blocking: true,
          }
        : { text: 'путь /audio/transcriptions у OpenRouter есть; голосовое Ogg и имя модели не проверены на настоящем ключе', blocking: false };
    default:
      return unknownProvider(info.provider);
  }
}
