// Минимальный клиент Telegram Bot API на встроенном fetch (TECH-SPEC §6: HTTP — встроенный fetch). Адреса содержат
// токен — они не попадают ни в текст ошибок, ни в журнал (Ш-24): всё, что уходит наружу, вычищается от токена.

import type { User, WebhookInfo } from '@grammyjs/types';
import { redactSecrets } from './secrets.js';

// Типы Bot API — из @grammyjs/types (только типы, TECH-SPEC §6); остальные пакеты берут их отсюда.
export type { CallbackQuery, Chat, Message, MessageOrigin, Update, User, WebhookInfo } from '@grammyjs/types';

/** Ошибка разбора разметки: та же часть уходит без разметки (5.5). */
export function isParseEntitiesError(err: unknown): boolean {
  return err instanceof TelegramApiError && err.errorCode === 400 && /can't parse entities/i.test(err.description);
}

/** «message is not modified» — правка уже применена. */
export function isNotModifiedError(err: unknown): boolean {
  return err instanceof TelegramApiError && err.errorCode === 400 && /message is not modified/i.test(err.description);
}

/** Ошибка, которую вернул Telegram: `{ok: false, error_code, description, parameters.retry_after}`. */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number,
    readonly description: string,
    readonly retryAfter: number | null,
  ) {
    super(`${method}: ${errorCode} ${description}`);
  }
}

/** Сеть: обрыв, отказ соединения, таймаут, не-JSON ответ. */
export class TelegramNetworkError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly timedOut: boolean,
  ) {
    super(`${method}: ${message}`);
  }
}

/** Файл в multipart-запросе: байты или Blob (с диска — fs.openAsBlob). */
export interface MultipartFile {
  data: Uint8Array | Blob;
  filename: string;
  contentType: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Предел на весь запрос, мс (AbortSignal.timeout). */
  timeoutMs?: number;
}

/** Сигнал отмены запроса: свой, таймаут или оба. Один сигнал — без AbortSignal.any (лишний объект на каждый запрос). */
function combineSignals(opts: CallOptions): AbortSignal | undefined {
  const timeout = opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  if (opts.signal && timeout) return AbortSignal.any([opts.signal, timeout]);
  return opts.signal ?? timeout;
}

export class TelegramApi {
  constructor(
    private readonly apiBase: string,
    private readonly token: string,
  ) {}

  private methodUrl(method: string): string {
    return `${this.apiBase.replace(/\/+$/, '')}/bot${this.token}/${method}`;
  }

  /** Адрес скачивания файла — содержит токен, в журнал не писать. */
  fileUrl(filePath: string): string {
    return `${this.apiBase.replace(/\/+$/, '')}/file/bot${this.token}/${filePath}`;
  }

  /** Убрать токен из текста. */
  redact(text: string): string {
    return redactSecrets(text, [this.token]);
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    const signal = combineSignals(opts);
    let res: Response;
    try {
      res = await fetch(this.methodUrl(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw this.networkError(method, err);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      if (signal?.aborted) throw this.networkError(method, err);
      throw new TelegramNetworkError(method, `ответ не JSON (HTTP ${res.status})`, false);
    }
    const b = body as { ok?: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    if (b && b.ok === true) return b.result as T;
    throw new TelegramApiError(
      method,
      typeof b?.error_code === 'number' ? b.error_code : res.status,
      this.redact(typeof b?.description === 'string' ? b.description : `HTTP ${res.status}`),
      typeof b?.parameters?.retry_after === 'number' ? b.parameters.retry_after : null,
    );
  }

  /**
   * Вызов с файлом (sendVoice, 5.5; sendDocument — посылки, 5.16): multipart/form-data. Поля-объекты (reply_parameters,
   * reply_markup) — строкой JSON, как велит Bot API. Файл — байтами или Blob (fs.openAsBlob: посылка до 50 МБ читается с
   * диска по ходу отправки, а не целиком в память).
   */
  async callMultipart<T>(
    method: string,
    params: Record<string, unknown>,
    files: Record<string, MultipartFile>,
    opts: CallOptions = {},
  ): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    for (const [k, f] of Object.entries(files)) form.append(k, f.data instanceof Blob ? f.data : new Blob([f.data], { type: f.contentType }), f.filename);
    const signal = combineSignals(opts);
    let res: Response;
    try {
      res = await fetch(this.methodUrl(method), { method: 'POST', body: form, ...(signal ? { signal } : {}) });
    } catch (err) {
      throw this.networkError(method, err);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      if (signal?.aborted) throw this.networkError(method, err);
      throw new TelegramNetworkError(method, `ответ не JSON (HTTP ${res.status})`, false);
    }
    const b = body as { ok?: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    if (b && b.ok === true) return b.result as T;
    throw new TelegramApiError(
      method,
      typeof b?.error_code === 'number' ? b.error_code : res.status,
      this.redact(typeof b?.description === 'string' ? b.description : `HTTP ${res.status}`),
      typeof b?.parameters?.retry_after === 'number' ? b.parameters.retry_after : null,
    );
  }

  private networkError(method: string, err: unknown): TelegramNetworkError {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const timedOut = e?.name === 'TimeoutError';
    const aborted = e?.name === 'AbortError';
    const detail = timedOut
      ? 'нет ответа (таймаут)'
      : aborted
        ? 'запрос отменён'
        : `${e?.cause?.code ?? e?.name ?? 'ошибка сети'}${e?.cause?.message ? `: ${e.cause.message}` : ''}`;
    return new TelegramNetworkError(method, this.redact(detail), timedOut);
  }

  /** Скачать файл Telegram (адрес содержит токен — в журнал не писать). */
  async download(filePath: string, opts: CallOptions = {}): Promise<Buffer> {
    const signal = combineSignals(opts);
    let res: Response;
    try {
      res = await fetch(this.fileUrl(filePath), signal ? { signal } : {});
    } catch (err) {
      throw this.networkError('download', err);
    }
    if (!res.ok) throw new TelegramApiError('download', res.status, `HTTP ${res.status}`, null);
    try {
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw this.networkError('download', err);
    }
  }

  getMe(opts?: CallOptions): Promise<User> {
    return this.call<User>('getMe', {}, opts);
  }

  getWebhookInfo(opts?: CallOptions): Promise<WebhookInfo> {
    return this.call<WebhookInfo>('getWebhookInfo', {}, opts);
  }
}
