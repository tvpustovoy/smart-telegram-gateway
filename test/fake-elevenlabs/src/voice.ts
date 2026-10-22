// Общее для поддельных провайдеров голоса (ACCEPTANCE §1): сервер на 127.0.0.1, режимы ответа, сценарий «на N-й вызов»,
// задержка, запись каждого вызова с разобранными полями. Диалекты — ElevenLabs (index.ts) и OpenAI-совместимый
// (openai.ts): у каждого свои пути, заголовок ключа, поля запроса и вид ошибок; записи — общего вида, чтобы одни и те же
// сценарии M4 шли на обоих.

import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * ok — как обычно; error — 500; hang — не отвечать; rate_limited — 429 с Retry-After: 1; bad_key — 401;
 * empty — распознавание вернуло пустой текст; not_ogg — синтез вернул не Ogg (mp3); quota — 429 «деньги кончились»
 * (у OpenAI insufficient_quota; у ElevenLabs — как rate_limited).
 */
export type FakeMode = 'ok' | 'error' | 'hang' | 'rate_limited' | 'bad_key' | 'empty' | 'not_ogg' | 'quota';

export type VoiceDialect = 'openai' | 'elevenlabs';

export interface SttRecord {
  at: number;
  /** Модель: model_id у ElevenLabs, model у OpenAI. */
  model: string | null;
  /** Язык: language_code у ElevenLabs, language у OpenAI. */
  language: string | null;
  /** Словарь: поля keyterms у ElevenLabs; prompt у OpenAI — по запятым. */
  vocabulary: string[];
  file: { bytes: number; filename: string | null; type: string | null } | null;
  /** Все поля формы, кроме файла. */
  fields: Record<string, string[]>;
  mode: FakeMode;
}

export interface TtsRecord {
  at: number;
  model: string | null;
  /** Голос: voice_id в адресе у ElevenLabs, voice у OpenAI. */
  voice: string | null;
  /** Формат: output_format у ElevenLabs, response_format у OpenAI. */
  format: string | null;
  text: string | null;
  /** Поля запроса как пришли (JSON и параметры адреса). */
  fields: Record<string, unknown>;
  mode: FakeMode;
}

export interface FakeVoiceOptions {
  apiKey: string;
  /** Расшифровка: строка или по запросу (размеру файла, имени). */
  transcript?: string | ((req: SttRecord) => string);
  sttMode?: FakeMode;
  ttsMode?: FakeMode;
  /** Длительность образца синтеза, секунды. */
  ttsSeconds?: number;
  /** Задержка ответа, мс. */
  latencyMs?: number;
}

export interface VoiceCall {
  at: number;
  path: string;
  method: string;
  query: Record<string, string>;
  bytes: number;
  /** Ключ пришёл как положено диалекту. */
  authorized: boolean;
}

/** Строки config.yaml для подделки. */
export interface FakeYamlOptions {
  /** Голос синтеза; null — не задавать (у ElevenLabs — «голос не задан», у OpenAI — голос по умолчанию). */
  voiceId?: string | null;
  vocabulary?: string[];
  /** Имя ключа в config.yaml (stt.key, tts.key); не задано — по умолчанию провайдера. */
  key?: string;
  /** Модель; не задана — по умолчанию провайдера. */
  sttModel?: string;
  ttsModel?: string;
}

/** «mp3» — не Ogg: заголовок ID3 и пара кадров. */
export const NOT_OGG = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(512, 0xff)]);

export abstract class FakeVoiceServer {
  abstract readonly dialect: VoiceDialect;
  /** Коды отказов этого диалекта — как их запишет шлюз (stt_failed.reason, stt_attempt_failed.code). */
  abstract readonly codes: { server: string; rate: string; auth: string };
  readonly calls: VoiceCall[] = [];
  readonly stt: SttRecord[] = [];
  readonly tts: TtsRecord[] = [];
  transcript: string | ((req: SttRecord) => string);
  sttMode: FakeMode;
  ttsMode: FakeMode;
  ttsSeconds: number;
  latencyMs: number;
  /** Режимы на очередные вызовы распознавания (первый — на следующий вызов); кончились — sttMode. */
  sttScript: FakeMode[] = [];
  ttsScript: FakeMode[] = [];
  /**
   * 401 с присланным ключом в тексте ошибки после N знаков («x»×N, затем «key=<ключ>»): маска ключа обязана идти до
   * обрезки текста, иначе начало ключа пройдёт мимо неё. null — текст 401 как обычно у диалекта.
   */
  authEcho: number | null = null;
  protected server: http.Server | null = null;
  protected port = 0;
  private sockets = new Set<Socket>();
  protected hanging = new Set<http.ServerResponse>();

  protected constructor(protected readonly opts: FakeVoiceOptions) {
    this.transcript = opts.transcript ?? 'проверка связи';
    this.sttMode = opts.sttMode ?? 'ok';
    this.ttsMode = opts.ttsMode ?? 'ok';
    this.ttsSeconds = opts.ttsSeconds ?? 3;
    this.latencyMs = opts.latencyMs ?? 0;
  }

  /** Адрес для config.yaml (stt.base_url, tts.base_url). */
  abstract get baseUrl(): string;

  /** Строка config.yaml: распознавание — в эту подделку. */
  abstract sttYaml(o?: FakeYamlOptions): string;

  /** Строка config.yaml: синтез — в эту подделку. */
  abstract ttsYaml(o?: FakeYamlOptions): string;

  /** Строки config.yaml: распознавание и синтез — в эту подделку. */
  configYaml(o: FakeYamlOptions = {}): string {
    return this.sttYaml(o) + this.ttsYaml(o);
  }

  /** Ключ в запросе — как положено диалекту. */
  protected abstract authorized(req: http.IncomingMessage): boolean;

  protected abstract route(req: http.IncomingMessage, url: URL, body: Buffer, res: http.ServerResponse): Promise<void>;

  protected async listen(): Promise<void> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => res.destroy());
    });
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const r of this.hanging) r.destroy();
    this.hanging.clear();
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  protected json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length, ...headers });
    res.end(data);
  }

  /** Текст 401 с ключом после authEcho знаков; null — authEcho не задан. */
  protected echoedKeyMessage(req: http.IncomingMessage): string | null {
    if (this.authEcho === null) return null;
    return `${'x'.repeat(this.authEcho)} key=${this.presentedKey(req)}`;
  }

  /** Ключ, присланный в запросе (как его передаёт диалект). */
  protected abstract presentedKey(req: http.IncomingMessage): string;

  protected nextStt(): FakeMode {
    return this.sttScript.shift() ?? this.sttMode;
  }

  protected nextTts(): FakeMode {
    return this.ttsScript.shift() ?? this.ttsMode;
  }

  protected transcriptFor(rec: SttRecord, mode: FakeMode): string {
    if (mode === 'empty') return '';
    return typeof this.transcript === 'function' ? this.transcript(rec) : this.transcript;
  }

  /** Форма multipart: поля строками и файл. */
  protected async parseForm(req: http.IncomingMessage, body: Buffer): Promise<{ fields: Record<string, string[]>; file: SttRecord['file'] }> {
    const ct = req.headers['content-type'] ?? '';
    const fields: Record<string, string[]> = {};
    let file: SttRecord['file'] = null;
    if (!/^multipart\/form-data/i.test(ct)) return { fields, file };
    let form: FormData;
    try {
      form = await new Response(body, { headers: { 'content-type': ct } }).formData();
    } catch {
      return { fields, file };
    }
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') (fields[k] ??= []).push(v);
      else if (k === 'file') file = { bytes: v.size, filename: v.name ?? null, type: v.type || null };
    }
    return { fields, file };
  }

  protected parseJson(req: http.IncomingMessage, body: Buffer): Record<string, unknown> {
    if (!/application\/json/i.test(req.headers['content-type'] ?? '')) return {};
    try {
      const v = JSON.parse(body.toString('utf8')) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const authorized = this.authorized(req);
    this.calls.push({ at: Date.now(), path: url.pathname, method: req.method ?? '', query: Object.fromEntries(url.searchParams), bytes: body.length, authorized });
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    await this.route(req, url, body, res);
  }
}
