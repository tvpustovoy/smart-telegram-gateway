// Поддельные провайдеры голоса (ACCEPTANCE §1) — два диалекта за общим видом записей (voice.ts): ElevenLabs (здесь) и
// OpenAI-совместимый (openai.ts). Распознавание — заданная расшифровка, ошибка, зависание, 429, неверный ключ; синтез —
// Ogg/Opus-образец заданной длительности или «не Ogg».
//
// Диалект ElevenLabs — договор как у настоящего API (документация ElevenLabs; не сверено на настоящем ключе):
// - ключ — заголовок xi-api-key; чужой — 401 {detail: {status: 'invalid_api_key', …}};
// - POST /v1/speech-to-text — multipart/form-data: model_id и file обязательны (нет — 422 со списком в detail),
//   language_code, tag_audio_events, keyterms (повторяющееся поле) → {language_code, language_probability, text, words};
// - POST /v1/text-to-speech/{voice_id}?output_format=… — JSON {text, model_id}: нет text — 422; output_format opus_* —
//   Ogg/Opus, иное — «mp3» (не Ogg: так проверяется своя проверка контейнера);
// - 429 — с заголовком Retry-After; 5xx — {detail: {status, message}}.
// Сценарий — список режимов «на N-й вызов» (sttScript, ttsScript), дальше — общий режим. Каждый вызов записан с
// разобранными полями.

import type http from 'node:http';
import { makeOggOpus } from './ogg.js';
import { FakeVoiceServer, NOT_OGG, type FakeMode, type FakeVoiceOptions, type FakeYamlOptions, type SttRecord, type TtsRecord } from './voice.js';

export * from './ogg.js';
export * from './openai.js';
export * from './voice.js';

/** Прежнее имя параметров подделки. */
export type FakeElevenLabsOptions = FakeVoiceOptions;

export class FakeElevenLabs extends FakeVoiceServer {
  readonly dialect = 'elevenlabs' as const;
  readonly codes = { server: 'internal_error', rate: 'too_many_concurrent_requests', auth: 'invalid_api_key' };

  static async start(opts: FakeVoiceOptions): Promise<FakeElevenLabs> {
    const f = new FakeElevenLabs(opts);
    await f.listen();
    return f;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  sttYaml(o: FakeYamlOptions = {}): string {
    const terms = o.vocabulary ?? ['Acme', 'Борис', 'Kubernetes'];
    return (
      `stt: { provider: elevenlabs, base_url: "${this.baseUrl}", language: ru, vocabulary: [${terms.map((t) => JSON.stringify(t)).join(', ')}]` +
      `${o.key ? `, key: ${o.key}` : ''}${o.sttModel ? `, model: ${o.sttModel}` : ''} }\n`
    );
  }

  ttsYaml(o: FakeYamlOptions = {}): string {
    const voice = o.voiceId === undefined ? 'voice_test' : o.voiceId;
    return (
      `tts: { provider: elevenlabs, base_url: "${this.baseUrl}"${voice !== null ? `, voice_id: "${voice}"` : ''}` +
      `${o.key ? `, key: ${o.key}` : ''}${o.ttsModel ? `, model: ${o.ttsModel}` : ''} }\n`
    );
  }

  protected authorized(req: http.IncomingMessage): boolean {
    return req.headers['xi-api-key'] === this.opts.apiKey;
  }

  protected presentedKey(req: http.IncomingMessage): string {
    const v = req.headers['xi-api-key'];
    return Array.isArray(v) ? v.join(',') : (v ?? '');
  }

  /** 401: как у настоящего ElevenLabs — без ключа; с authEcho — с присланным ключом после N знаков. */
  private unauthorized(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.json(res, 401, { detail: { status: 'invalid_api_key', message: this.echoedKeyMessage(req) ?? 'Invalid API key' } });
  }

  /** Ответ по режиму-ошибке; true — ответили (или повисли). */
  private fail(req: http.IncomingMessage, res: http.ServerResponse, mode: FakeMode): boolean {
    switch (mode) {
      case 'hang':
        this.hanging.add(res);
        return true;
      case 'rate_limited':
      case 'quota':
        this.json(res, 429, { detail: { status: 'too_many_concurrent_requests', message: 'Too many concurrent requests' } }, { 'retry-after': '1' });
        return true;
      case 'error':
        this.json(res, 500, { detail: { status: 'internal_error', message: 'Internal server error' } });
        return true;
      case 'bad_key':
        this.unauthorized(req, res);
        return true;
      default:
        return false;
    }
  }

  private missing(res: http.ServerResponse, fields: string[]): void {
    this.json(res, 422, { detail: fields.map((f) => ({ loc: ['body', f], msg: 'Field required', type: 'missing' })) });
  }

  protected async route(req: http.IncomingMessage, url: URL, body: Buffer, res: http.ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      this.unauthorized(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/speech-to-text') {
      await this.speechToText(req, body, res);
      return;
    }
    const tts = /^\/v1\/text-to-speech\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'POST' && tts) {
      this.textToSpeech(decodeURIComponent(tts[1] ?? ''), url, req, body, res);
      return;
    }
    this.json(res, 404, { detail: 'Not Found' });
  }

  private async speechToText(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse): Promise<void> {
    const mode = this.nextStt();
    const { fields, file } = await this.parseForm(req, body);
    const rec: SttRecord = {
      at: Date.now(),
      model: fields.model_id?.[0] ?? null,
      language: fields.language_code?.[0] ?? null,
      vocabulary: fields.keyterms ?? [],
      file,
      fields,
      mode,
    };
    this.stt.push(rec);
    const missing = [...(rec.model ? [] : ['model_id']), ...(file ? [] : ['file'])];
    if (missing.length) {
      this.missing(res, missing);
      return;
    }
    if (this.fail(req, res, mode)) return;
    const text = this.transcriptFor(rec, mode);
    this.json(res, 200, {
      language_code: rec.language === 'ru' ? 'rus' : (rec.language ?? 'rus'),
      language_probability: 0.99,
      text,
      words: text
        .split(/\s+/)
        .filter(Boolean)
        .map((w, i) => ({ text: w, start: i * 0.4, end: i * 0.4 + 0.3, type: 'word', logprob: 0 })),
    });
  }

  private textToSpeech(voiceId: string, url: URL, req: http.IncomingMessage, body: Buffer, res: http.ServerResponse): void {
    const mode = this.nextTts();
    const json = this.parseJson(req, body);
    const rec: TtsRecord = {
      at: Date.now(),
      model: typeof json.model_id === 'string' ? json.model_id : null,
      voice: voiceId,
      format: url.searchParams.get('output_format'),
      text: typeof json.text === 'string' ? json.text : null,
      fields: { ...json, ...Object.fromEntries(url.searchParams) },
      mode,
    };
    this.tts.push(rec);
    if (!rec.text) {
      this.missing(res, ['text']);
      return;
    }
    if (this.fail(req, res, mode)) return;
    const opus = mode !== 'not_ogg' && (rec.format ?? '').startsWith('opus_');
    const audio = opus ? makeOggOpus(this.ttsSeconds) : NOT_OGG;
    res.writeHead(200, { 'content-type': opus ? 'audio/ogg' : 'audio/mpeg', 'content-length': audio.length });
    res.end(audio);
  }
}
