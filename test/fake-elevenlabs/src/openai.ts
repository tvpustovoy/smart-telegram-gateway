// Поддельный OpenAI-совместимый провайдер голоса (ACCEPTANCE §1) — тот же вид записей и режимов, что у ElevenLabs
// (voice.ts). Договор — по документации OpenAI (не сверено на настоящем ключе):
// - ключ — заголовок Authorization: Bearer <ключ>; иначе 401 {error: {code: 'invalid_api_key', …}} (в тексте ошибки —
//   присланный ключ целиком: шлюз обязан его вырезать; настоящий OpenAI показывает его частью);
// - адрес — {base_url}/audio/…, base_url — http://127.0.0.1:<порт>/v1;
// - POST /v1/audio/transcriptions — multipart/form-data: file (имя с расширением формата: .ogg, .oga, .mp3, …) и model
//   обязательны (нет — 400 invalid_request_error с param), language, prompt, response_format (json → {text, usage};
//   text — строкой);
// - POST /v1/audio/speech — JSON {model, input, voice, response_format, instructions?}: нет model, input или voice —
//   400; response_format opus — Ogg/Opus, иначе (mp3 по умолчанию) — «mp3»;
// - 429 — {error: {code: 'rate_limit_exceeded'}} с Retry-After; деньги кончились — 429 insufficient_quota; 5xx —
//   {error: {type: 'server_error', code: null}}.

import type http from 'node:http';
import { makeOggOpus } from './ogg.js';
import { FakeVoiceServer, NOT_OGG, type FakeMode, type FakeVoiceOptions, type FakeYamlOptions, type SttRecord, type TtsRecord } from './voice.js';

/** Расширения файла, которые OpenAI принимает в распознавание. */
const AUDIO_EXTENSIONS = ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'oga', 'wav', 'webm'];

function openAiError(message: string, type: string, code: string | null, param: string | null = null): { error: Record<string, unknown> } {
  return { error: { message, type, param, code } };
}

export class FakeOpenAiAudio extends FakeVoiceServer {
  readonly dialect = 'openai' as const;
  readonly codes = { server: 'server_error', rate: 'rate_limit_exceeded', auth: 'invalid_api_key' };

  static async start(opts: FakeVoiceOptions): Promise<FakeOpenAiAudio> {
    const f = new FakeOpenAiAudio(opts);
    await f.listen();
    return f;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  sttYaml(o: FakeYamlOptions = {}): string {
    const terms = o.vocabulary ?? ['Acme', 'Борис', 'Kubernetes'];
    return (
      `stt: { provider: openai, base_url: "${this.baseUrl}", language: ru, vocabulary: [${terms.map((t) => JSON.stringify(t)).join(', ')}]` +
      `${o.key ? `, key: ${o.key}` : ''}${o.sttModel ? `, model: ${o.sttModel}` : ''} }\n`
    );
  }

  ttsYaml(o: FakeYamlOptions = {}): string {
    const voice = o.voiceId === undefined ? 'voice_test' : o.voiceId;
    return (
      `tts: { provider: openai, base_url: "${this.baseUrl}"${voice !== null ? `, voice: "${voice}"` : ''}` +
      `${o.key ? `, key: ${o.key}` : ''}${o.ttsModel ? `, model: ${o.ttsModel}` : ''} }\n`
    );
  }

  protected authorized(req: http.IncomingMessage): boolean {
    return req.headers.authorization === `Bearer ${this.opts.apiKey}`;
  }

  protected presentedKey(req: http.IncomingMessage): string {
    return (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  }

  private unauthorized(req: http.IncomingMessage, res: http.ServerResponse): void {
    const got = this.presentedKey(req);
    const message =
      this.echoedKeyMessage(req) ?? `Incorrect API key provided: ${got || '(none)'}. You can find your API key at https://platform.openai.com/account/api-keys.`;
    this.json(res, 401, openAiError(message, 'invalid_request_error', 'invalid_api_key'));
  }

  /** Ответ по режиму-ошибке; true — ответили (или повисли). */
  private fail(req: http.IncomingMessage, res: http.ServerResponse, mode: FakeMode): boolean {
    switch (mode) {
      case 'hang':
        this.hanging.add(res);
        return true;
      case 'rate_limited':
        this.json(res, 429, openAiError('Rate limit reached for requests', 'requests', 'rate_limit_exceeded'), { 'retry-after': '1' });
        return true;
      case 'quota':
        this.json(res, 429, openAiError('You exceeded your current quota, please check your plan and billing details.', 'insufficient_quota', 'insufficient_quota'));
        return true;
      case 'error':
        this.json(res, 500, openAiError('The server had an error while processing your request. Sorry about that!', 'server_error', null));
        return true;
      case 'bad_key':
        this.unauthorized(req, res);
        return true;
      default:
        return false;
    }
  }

  protected async route(req: http.IncomingMessage, url: URL, body: Buffer, res: http.ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      this.unauthorized(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
      await this.transcriptions(req, body, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
      this.speech(req, body, res);
      return;
    }
    this.json(res, 404, openAiError(`Invalid URL (${req.method} ${url.pathname})`, 'invalid_request_error', null));
  }

  private async transcriptions(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse): Promise<void> {
    const mode = this.nextStt();
    const { fields, file } = await this.parseForm(req, body);
    const prompt = fields.prompt?.[0] ?? '';
    const rec: SttRecord = {
      at: Date.now(),
      model: fields.model?.[0] ?? null,
      language: fields.language?.[0] ?? null,
      vocabulary: prompt
        ? prompt
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      file,
      fields,
      mode,
    };
    this.stt.push(rec);
    if (!file) {
      this.json(res, 400, openAiError("you must provide a 'file' parameter", 'invalid_request_error', null, 'file'));
      return;
    }
    if (!rec.model) {
      this.json(res, 400, openAiError("you must provide a model parameter", 'invalid_request_error', null, 'model'));
      return;
    }
    const ext = (file.filename ?? '').split('.').pop()?.toLowerCase() ?? '';
    if (!AUDIO_EXTENSIONS.includes(ext)) {
      this.json(res, 400, openAiError(`Invalid file format. Supported formats: ${JSON.stringify(AUDIO_EXTENSIONS)}`, 'invalid_request_error', null, 'file'));
      return;
    }
    if (this.fail(req, res, mode)) return;
    const text = this.transcriptFor(rec, mode);
    if (fields.response_format?.[0] === 'text') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(text);
      return;
    }
    this.json(res, 200, { text, usage: { type: 'tokens', input_tokens: 10, output_tokens: text.length, total_tokens: 10 + text.length } });
  }

  private speech(req: http.IncomingMessage, body: Buffer, res: http.ServerResponse): void {
    const mode = this.nextTts();
    const json = this.parseJson(req, body);
    const str = (k: string): string | null => (typeof json[k] === 'string' ? (json[k] as string) : null);
    const rec: TtsRecord = {
      at: Date.now(),
      model: str('model'),
      voice: str('voice'),
      format: str('response_format'),
      text: str('input'),
      fields: json,
      mode,
    };
    this.tts.push(rec);
    for (const k of ['model', 'input', 'voice'] as const) {
      if (!str(k)) {
        this.json(res, 400, openAiError(`Missing required parameter: '${k}'.`, 'invalid_request_error', 'missing_required_parameter', k));
        return;
      }
    }
    if (this.fail(req, res, mode)) return;
    const opus = mode !== 'not_ogg' && rec.format === 'opus';
    const audio = opus ? makeOggOpus(this.ttsSeconds) : NOT_OGG;
    res.writeHead(200, { 'content-type': opus ? 'audio/opus' : 'audio/mpeg', 'content-length': audio.length });
    res.end(audio);
  }
}
