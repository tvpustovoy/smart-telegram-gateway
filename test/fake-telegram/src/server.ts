// Поддельный Telegram Bot API (договор — ACCEPTANCE §1). HTTP-сервер на 127.0.0.1 со случайным портом:
// api_base = http://127.0.0.1:<порт>. Методы — /bot<token>/<method>, файлы — /file/bot<token>/<path>.
// Длинный опрос держит запрос до обновления или до timeout; offset сбрасывает подтверждённое; allowed_updates
// фильтрует; сценарий «N-й вызов метода X → ответ Y»; журнал каждого вызова со временем.

import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Chat, Message, Update, User } from '@grammyjs/types';
import { imageInfo } from 'stg-core';
import { UpdateBuilder, privateChatOf, updateType } from './builders.js';
import { checkTelegramHtml } from './html.js';
import { isUploadedFile, parseBody, type Params } from './multipart.js';
import { errors, reply, type FakeReply } from './replies.js';

export interface FakeTelegramOptions {
  token: string;
  /** Что вернёт getMe. */
  bot?: { id?: number; username?: string; first_name?: string };
  /** Задержка каждого ответа, мс (A1.6: «подделка отвечает за 50 мс»). */
  latencyMs?: number;
  /** 429, если в чат больше perSecond сообщений и правок за секунду (A1.6а). */
  chatRateLimit?: { perSecond: number; retryAfter: number } | null;
  /** chatRateLimit считает и закрепление, открепление и удаление сообщений (тот же счёт, что у сообщений). */
  rateLimitServiceCalls?: boolean;
  /**
   * 429, если в чат больше perSecond реакций за секунду — отдельный счёт (у настоящего Telegram предел реакций не
   * опубликован; учение M2 покажет). Считаются все setMessageReaction, и 👀 тоже.
   */
  reactionRateLimit?: { perSecond: number; retryAfter: number } | null;
  /** Источник времени для message.date и предела частоты (мс); по умолчанию Date.now. */
  now?: () => number;
  /** Первый update_id. */
  firstUpdateId?: number;
}

export interface CallRecord {
  /** Сквозной номер вызова. */
  n: number;
  method: string;
  /** Номер вызова этого метода, с 1. */
  nth: number;
  params: Params;
  /** Время вызова (Date.now). */
  at: number;
  /** Чем ответили. */
  outcome: 'ok' | 'error' | 'hang' | 'drop' | 'aborted';
  status: number | null;
  /** Номера обновлений, которые отдал getUpdates. */
  updateIds?: number[];
}

export interface ScenarioRule {
  method: string;
  /** Ровно N-й вызов метода (с 1). */
  nth?: number;
  /** С N-го вызова и дальше. */
  from?: number;
  /** Сколько раз сработать (с `from`). */
  times?: number;
  when?: (params: Params) => boolean;
  reply: FakeReply;
}

export interface SentMessage {
  chat_id: number;
  message_id: number;
  method: 'sendMessage' | 'sendVoice' | 'sendDocument' | 'sendPhoto';
  text: string | null;
  caption: string | null;
  parse_mode: string | null;
  reply_markup: unknown;
  reply_parameters: unknown;
  link_preview_options: unknown;
  voice: { bytes: number; duration: number | null } | null;
  /** Документ (sendDocument, посылки 0.3.3): имя, тип, содержимое. */
  document?: { filename: string | null; contentType: string | null; data: Buffer } | null;
  /** Фото (sendPhoto, посылки #60): имя, тип, содержимое — как пришло от бота (Telegram его потом сжимает). */
  photo?: { filename: string | null; contentType: string | null; data: Buffer } | null;
  edits: Array<{ text: string; reply_markup: unknown; at: number }>;
  at: number;
  message: Message;
  /** disable_notification при отправке. */
  disable_notification: boolean;
  /** Удалено (deleteMessage бота или владелец удалил сам) — когда (Date.now). */
  deletedAt: number | null;
}

/** Служебное сообщение Telegram «бот закрепил …» (появляется в чате при pinChatMessage). */
export interface PinNotice {
  chat_id: number;
  message_id: number;
  pinned_message_id: number;
  at: number;
  deletedAt: number | null;
}

interface Waiter {
  res: http.ServerResponse;
  record: CallRecord;
  offset: number | undefined;
  limit: number;
  timer: NodeJS.Timeout;
}

interface StoredFile {
  file_id: string;
  file_unique_id: string;
  file_path: string;
  data: Buffer;
  tooBig?: boolean;
}

/** Реакции, которые Telegram принимает от бота (ReactionTypeEmoji, Bot API). */
const TELEGRAM_REACTIONS = new Set([
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱',
  '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭',
  '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉',
  '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂', '🤷', '🤷‍♀', '😡',
]);

const DEFAULT_ALLOWED = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query'];

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : v === undefined || v === null ? null : String(v);
}

/** Встроенные кнопки (inline_keyboard), а не нижняя клавиатура. */
function isInlineMarkup(m: unknown): boolean {
  return !!m && typeof m === 'object' && Array.isArray((m as { inline_keyboard?: unknown }).inline_keyboard);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export class FakeTelegram extends EventEmitter {
  readonly token: string;
  readonly botUser: User;
  readonly calls: CallRecord[] = [];
  readonly sent: SentMessage[] = [];
  readonly reactions: Array<{ chat_id: number; message_id: number; reaction: unknown; at: number }> = [];
  readonly chatActions: Array<{ chat_id: number; action: string; at: number }> = [];
  readonly callbackAnswers: Array<{ callback_query_id: string; text: string | null; at: number }> = [];
  readonly commands: unknown[] = [];
  /** Удалённые сообщения (deleteMessage): бота, владельца, служебные. */
  readonly deleted: Array<{ chat_id: number; message_id: number; at: number }> = [];
  /** Закрепления (pinChatMessage). */
  readonly pins: Array<{ chat_id: number; message_id: number; disable_notification: boolean; at: number }> = [];
  /** Закреплённое сейчас — по чату. */
  readonly pinned = new Map<number, number>();
  /** Служебные сообщения о закреплении. */
  readonly pinNotices: PinNotice[] = [];
  readonly builder: UpdateBuilder;
  /** Все обновления, когда-либо выданные (в том числе подтверждённые) — по номеру. */
  readonly history = new Map<number, Update>();
  /** Когда обновление впервые ушло в ответе getUpdates (Date.now) — для задержек A1.6 и сверки П-1. */
  readonly handedOut = new Map<number, number>();

  webhookUrl = '';
  allowedUpdates: string[] = DEFAULT_ALLOWED;
  /** Последний offset, с которым пришёл getUpdates. */
  lastOffset: number | undefined;

  private server: http.Server | null = null;
  private port = 0;
  private sockets = new Set<Socket>();
  private hanging = new Set<http.ServerResponse>();
  private queue: Update[] = [];
  /** Повторно выданные по сценарию: offset их не сбрасывает, пока не отданы ещё раз. */
  private forced = new Set<Update>();
  private waiters: Waiter[] = [];
  private rules: Array<ScenarioRule & { used: number }> = [];
  private methodCounts = new Map<string, number>();
  private callSeq = 0;
  private updateSeq: number;
  private messageSeq = new Map<number, number>();
  private fileSeq = 0;
  private callbackSeq = 0;
  private files = new Map<string, StoredFile>();
  private openCallbacks = new Set<string>();
  private sendTimes = new Map<number, number[]>();
  private reactionTimes = new Map<number, number[]>();
  private chats = new Map<number, Chat>();
  private readonly opts: FakeTelegramOptions;
  private readonly nowFn: () => number;

  constructor(opts: FakeTelegramOptions) {
    super();
    this.opts = opts;
    this.token = opts.token;
    this.nowFn = opts.now ?? Date.now;
    this.updateSeq = (opts.firstUpdateId ?? 100_000) - 1;
    this.botUser = {
      id: opts.bot?.id ?? 7_000_000_001,
      is_bot: true,
      first_name: opts.bot?.first_name ?? 'Тестовый ассистент',
      username: opts.bot?.username ?? 'test_assistant_bot',
    };
    this.builder = new UpdateBuilder({
      nextUpdateId: () => ++this.updateSeq,
      nextMessageId: (chatId) => this.nextMessageId(chatId),
      nowSeconds: () => Math.floor(this.nowFn() / 1000),
      newFileId: (kind) => `${kind}_${++this.fileSeq}`,
      newCallbackId: () => `cb${++this.callbackSeq}`,
    });
  }

  static async start(opts: FakeTelegramOptions): Promise<FakeTelegram> {
    const fake = new FakeTelegram(opts);
    await fake.listen();
    return fake;
  }

  get apiBase(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private listen(): Promise<void> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => res.destroy());
    });
    server.keepAliveTimeout = 60_000;
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
    for (const res of this.hanging) res.destroy();
    this.hanging.clear();
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ——— управление из теста ———

  /** Следующий message_id в чате — общий для входящих и сообщений бота. */
  nextMessageId(chatId: number): number {
    const n = (this.messageSeq.get(chatId) ?? 1000) + 1;
    this.messageSeq.set(chatId, n);
    return n;
  }

  /** Положить обновления в очередь; длинный опрос получит их сразу. */
  push(...updates: Update[]): Update[] {
    for (const u of updates) {
      const msg = u.message ?? u.edited_message;
      if (msg) this.chats.set(msg.chat.id, msg.chat);
      if (u.message_reaction) this.chats.set(u.message_reaction.chat.id, u.message_reaction.chat);
      if (u.callback_query) this.openCallbacks.add(u.callback_query.id);
      this.history.set(u.update_id, u);
      this.queue.push(u);
      if (u.update_id > this.updateSeq) this.updateSeq = u.update_id;
    }
    this.queue.sort((a, b) => a.update_id - b.update_id);
    this.flushWaiters();
    return updates;
  }

  /**
   * Положить обновление, которое выдаётся вне зависимости от offset: номер ниже сохранённого (после недели тишины
   * Telegram может начать нумерацию заново, A1.3).
   */
  pushForced(u: Update): Update {
    const msg = u.message ?? u.edited_message;
    if (msg) this.chats.set(msg.chat.id, msg.chat);
    this.history.set(u.update_id, u);
    this.forced.add(u);
    this.queue.unshift(u);
    this.flushWaiters();
    return u;
  }

  /** Выдать обновление ещё раз — даже подтверждённое (повторная выдача по сценарию). */
  redeliver(updateId: number): void {
    const u = this.history.get(updateId);
    if (!u) throw new Error(`redeliver: обновления ${updateId} не было`);
    this.queue = this.queue.filter((q) => q.update_id !== updateId);
    const copy = structuredClone(u);
    this.forced.add(copy);
    this.queue.unshift(copy);
    this.flushWaiters();
  }

  /**
   * Мёртвое соединение после сна: висящие сейчас длинные опросы больше не ответят (ни на новое обновление, ни по
   * timeout), пока клиент сам не оборвёт. Новые запросы обслуживаются как обычно.
   */
  stallCurrentPolls(): number {
    const n = this.waiters.length;
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.record.outcome = 'hang';
      this.hanging.add(w.res);
    }
    return n;
  }

  /** Неподтверждённые обновления. */
  pending(): Update[] {
    return [...this.queue];
  }

  /** Реакция бота на сообщение сейчас (последний setMessageReaction заменяет прежний); null — нет. */
  currentReaction(chatId: number, messageId: number): string | null {
    const last = [...this.reactions].reverse().find((r) => r.chat_id === chatId && r.message_id === messageId);
    const list = Array.isArray(last?.reaction) ? (last.reaction as Array<{ emoji?: string }>) : [];
    return list[0]?.emoji ?? null;
  }

  /** Реакции бота на сообщение по порядку: ['👀', '✍', '👌']. */
  reactionHistory(chatId: number, messageId: number): string[] {
    return this.reactions
      .filter((r) => r.chat_id === chatId && r.message_id === messageId)
      .map((r) => (Array.isArray(r.reaction) ? ((r.reaction as Array<{ emoji?: string }>)[0]?.emoji ?? '') : ''));
  }

  /** Владелец сам удалил сообщение бота (например, закреплённую строку). */
  deleteByUser(chatId: number, messageId: number): void {
    const m = this.sent.find((x) => x.chat_id === chatId && x.message_id === messageId);
    if (m) m.deletedAt = Date.now();
    if (this.pinned.get(chatId) === messageId) this.pinned.delete(chatId);
  }

  /** Было ли удалено сообщение (ботом через deleteMessage). */
  wasDeleted(chatId: number, messageId: number): boolean {
    return this.deleted.some((d) => d.chat_id === chatId && d.message_id === messageId);
  }

  /** Сценарий: правило «N-й вызов метода X → ответ Y». Правила проверяются по порядку добавления. */
  scenario(rule: ScenarioRule): this {
    this.rules.push({ ...rule, used: 0 });
    return this;
  }

  /** Короткая запись: N-й вызов метода → ответ. */
  onCall(method: string, nth: number, r: FakeReply): this {
    return this.scenario({ method, nth, reply: r });
  }

  clearScenario(): void {
    this.rules = [];
  }

  setWebhook(url: string): void {
    this.webhookUrl = url;
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      this.respondReply(w.res, w.record, errors.conflictWebhook());
    }
  }

  /**
   * Файл для getFile и скачивания. tooBig — getFile отвечает, как Bot API на файл больше 20 МБ («file is too big»):
   * настоящих 20 МБ в тесте не нужно.
   */
  addFile(data: Buffer, opts: { fileId?: string; path?: string; tooBig?: boolean } = {}): StoredFile {
    const file_id = opts.fileId ?? `file_${++this.fileSeq}`;
    const f: StoredFile = { file_id, file_unique_id: `u${file_id}`, file_path: opts.path ?? `voice/${file_id}.oga`, data, ...(opts.tooBig ? { tooBig: true } : {}) };
    this.files.set(file_id, f);
    return f;
  }

  /** Содержимое файла (в том числе голосового, которое прислал бот через sendVoice). */
  fileData(fileId: string): Buffer | null {
    return this.files.get(fileId)?.data ?? null;
  }

  callsOf(method: string): CallRecord[] {
    return this.calls.filter((c) => c.method === method);
  }

  sentTo(chatId: number): SentMessage[] {
    return this.sent.filter((s) => s.chat_id === chatId);
  }

  /** Дождаться вызова, подходящего под условие (уже бывший тоже считается). */
  waitForCall(pred: (c: CallRecord) => boolean, timeoutMs = 10_000): Promise<CallRecord> {
    const found = this.calls.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const onCall = (c: CallRecord): void => {
        if (!pred(c)) return;
        clearTimeout(timer);
        this.off('call', onCall);
        resolve(c);
      };
      const timer = setTimeout(() => {
        this.off('call', onCall);
        reject(new Error(`подделка Telegram: вызова не дождались за ${timeoutMs} мс`));
      }, timeoutMs);
      this.on('call', onCall);
    });
  }

  /** Дождаться getUpdates с offset не меньше заданного — Telegram узнал «получил». */
  waitForOffset(offset: number, timeoutMs = 10_000): Promise<CallRecord> {
    return this.waitForCall((c) => c.method === 'getUpdates' && (num(c.params.offset) ?? -Infinity) >= offset, timeoutMs);
  }

  // ——— HTTP ———

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);

    const fileMatch = /^\/file\/bot([^/]+)\/(.+)$/.exec(url.pathname);
    if (fileMatch) {
      this.serveFile(res, fileMatch[1] ?? '', decodeURIComponent(fileMatch[2] ?? ''));
      return;
    }
    const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
    const method = m?.[2] ?? '(неизвестно)';
    let params: Params = {};
    try {
      params = { ...Object.fromEntries(url.searchParams), ...parseBody(body, req.headers['content-type']) };
    } catch {
      params = {};
    }
    const nth = (this.methodCounts.get(method) ?? 0) + 1;
    this.methodCounts.set(method, nth);
    const record: CallRecord = {
      n: ++this.callSeq,
      method,
      nth,
      params: this.loggable(params),
      at: Date.now(),
      outcome: 'ok',
      status: null,
    };
    this.calls.push(record);
    res.on('close', () => {
      if (record.status === null && record.outcome === 'ok') record.outcome = 'aborted';
      this.waiters = this.waiters.filter((w) => {
        if (w.res !== res) return true;
        clearTimeout(w.timer);
        return false;
      });
    });
    this.emit('call', record);

    if (!m || m[1] !== this.token) {
      this.respondReply(res, record, m ? errors.unauthorized() : errors.notFound());
      return;
    }
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));

    let r = this.matchRule(method, nth, params);
    while (r && r.kind === 'delay') {
      await new Promise((resolve) => setTimeout(resolve, r && r.kind === 'delay' ? r.ms : 0));
      r = r.then;
    }
    if (r) {
      this.respondReply(res, record, r);
      return;
    }
    this.dispatch(method, params, res, record);
  }

  private loggable(params: Params): Params {
    const out: Params = {};
    for (const [k, v] of Object.entries(params)) out[k] = isUploadedFile(v) ? { file: v.filename, bytes: v.data.length } : v;
    return out;
  }

  private matchRule(method: string, nth: number, params: Params): FakeReply | undefined {
    for (const rule of this.rules) {
      if (rule.method !== method && rule.method !== '*') continue;
      if (rule.nth !== undefined && rule.nth !== nth) continue;
      if (rule.from !== undefined && nth < rule.from) continue;
      if (rule.times !== undefined && rule.used >= rule.times) continue;
      if (rule.when && !rule.when(params)) continue;
      rule.used++;
      return rule.reply;
    }
    return undefined;
  }

  private respondReply(res: http.ServerResponse, record: CallRecord, r: FakeReply): void {
    switch (r.kind) {
      case 'ok':
        this.send(res, record, 200, { ok: true, result: r.result });
        return;
      case 'error': {
        const body: Record<string, unknown> = { ok: false, error_code: r.code, description: r.description };
        if (r.retryAfter !== undefined) body.parameters = { retry_after: r.retryAfter };
        record.outcome = 'error';
        this.send(res, record, r.code, body);
        return;
      }
      case 'hang':
        record.outcome = 'hang';
        this.hanging.add(res);
        return;
      case 'drop':
        record.outcome = 'drop';
        res.socket?.destroy();
        return;
      case 'delay':
        this.respondReply(res, record, r.then ?? reply.ok(true));
        return;
    }
  }

  private send(res: http.ServerResponse, record: CallRecord, status: number, body: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    record.status = status;
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
    res.end(data);
  }

  private ok(res: http.ServerResponse, record: CallRecord, result: unknown): void {
    this.send(res, record, 200, { ok: true, result });
  }

  private fail(res: http.ServerResponse, record: CallRecord, r: FakeReply): void {
    this.respondReply(res, record, r);
  }

  private serveFile(res: http.ServerResponse, token: string, filePath: string): void {
    const f = [...this.files.values()].find((x) => x.file_path === filePath);
    if (token !== this.token || !f) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': f.data.length });
    res.end(f.data);
  }

  private dispatch(method: string, p: Params, res: http.ServerResponse, record: CallRecord): void {
    switch (method) {
      case 'getMe':
        return this.ok(res, record, {
          ...this.botUser,
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        });
      case 'getWebhookInfo':
        return this.ok(res, record, {
          url: this.webhookUrl,
          has_custom_certificate: false,
          pending_update_count: this.queue.length,
        });
      case 'deleteWebhook':
        this.webhookUrl = '';
        if (p.drop_pending_updates === true || p.drop_pending_updates === 'true') this.queue = [];
        return this.ok(res, record, true);
      case 'setWebhook':
        this.setWebhook(str(p.url) ?? '');
        return this.ok(res, record, true);
      case 'getUpdates':
        return this.getUpdates(p, res, record);
      case 'getFile': {
        const f = this.files.get(str(p.file_id) ?? '');
        if (!f) return this.fail(res, record, reply.error(400, 'Bad Request: invalid file_id'));
        if (f.tooBig) return this.fail(res, record, reply.error(400, 'Bad Request: file is too big'));
        return this.ok(res, record, { file_id: f.file_id, file_unique_id: f.file_unique_id, file_size: f.data.length, file_path: f.file_path });
      }
      case 'sendMessage':
        return this.sendMessage(p, res, record);
      case 'sendVoice':
        return this.sendVoice(p, res, record);
      case 'sendDocument':
        return this.sendDocument(p, res, record);
      case 'sendPhoto':
        return this.sendPhoto(p, res, record);
      case 'editMessageText':
        return this.editMessageText(p, res, record);
      case 'editMessageReplyMarkup':
        return this.editMessageReplyMarkup(p, res, record);
      case 'setMessageReaction': {
        const chat_id = num(p.chat_id);
        const message_id = num(p.message_id);
        if (chat_id === undefined || message_id === undefined) {
          return this.fail(res, record, reply.error(400, 'Bad Request: message not found'));
        }
        // Как настоящий API: только реакции из списка Telegram (ReactionTypeEmoji), не больше одной у бота; новая
        // заменяет прежнюю.
        const list = Array.isArray(p.reaction) ? (p.reaction as Array<{ type?: string; emoji?: string }>) : [];
        if (list.length > 1 || list.some((r) => r.type !== 'emoji' || !TELEGRAM_REACTIONS.has(r.emoji ?? ''))) {
          return this.fail(res, record, reply.error(400, 'Bad Request: REACTION_INVALID'));
        }
        const retry = this.rateLimited(chat_id, 'reactions');
        if (retry !== null) return this.fail(res, record, errors.tooManyRequests(retry));
        this.reactions.push({ chat_id, message_id, reaction: p.reaction ?? [], at: Date.now() });
        return this.ok(res, record, true);
      }
      case 'sendChatAction': {
        const chat_id = num(p.chat_id);
        if (chat_id === undefined) return this.fail(res, record, reply.error(400, 'Bad Request: chat not found'));
        this.chatActions.push({ chat_id, action: str(p.action) ?? '', at: Date.now() });
        return this.ok(res, record, true);
      }
      case 'answerCallbackQuery': {
        const id = str(p.callback_query_id) ?? '';
        if (!this.openCallbacks.has(id)) {
          return this.fail(res, record, reply.error(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid'));
        }
        this.openCallbacks.delete(id);
        this.callbackAnswers.push({ callback_query_id: id, text: str(p.text), at: Date.now() });
        return this.ok(res, record, true);
      }
      case 'setMyCommands':
        this.commands.push({ commands: p.commands, scope: p.scope ?? null, language_code: p.language_code ?? null });
        return this.ok(res, record, true);
      case 'deleteMessage':
        return this.deleteMessage(p, res, record);
      case 'pinChatMessage':
        return this.pinChatMessage(p, res, record);
      case 'unpinChatMessage': {
        const chat_id = num(p.chat_id);
        if (chat_id === undefined) return this.fail(res, record, reply.error(400, 'Bad Request: chat not found'));
        const retry = this.serviceRateLimited(chat_id);
        if (retry !== null) return this.fail(res, record, errors.tooManyRequests(retry));
        this.pinned.delete(chat_id);
        return this.ok(res, record, true);
      }
      default:
        return this.fail(res, record, errors.notFound());
    }
  }

  /** Входящее сообщение (из выданных обновлений) — для удаления ботом в личке. */
  private incoming(chatId: number, messageId: number): Message | null {
    for (const u of this.history.values()) {
      const m = u.message ?? u.edited_message;
      if (m && m.chat.id === chatId && m.message_id === messageId) return m;
    }
    return null;
  }

  /**
   * deleteMessage: сообщение бота, служебное о закреплении или входящее (бот в личке может удалить и сообщение
   * собеседника). Нет такого или уже удалено — 400, как у настоящего API.
   */
  private deleteMessage(p: Params, res: http.ServerResponse, record: CallRecord): void {
    const chat_id = num(p.chat_id);
    const message_id = num(p.message_id);
    if (chat_id === undefined || message_id === undefined) return this.fail(res, record, reply.error(400, 'Bad Request: message identifier is not specified'));
    const retry = this.serviceRateLimited(chat_id);
    if (retry !== null) return this.fail(res, record, errors.tooManyRequests(retry));
    if (this.wasDeleted(chat_id, message_id)) return this.fail(res, record, reply.error(400, 'Bad Request: message to delete not found'));
    const sent = this.sent.find((x) => x.chat_id === chat_id && x.message_id === message_id);
    const notice = this.pinNotices.find((x) => x.chat_id === chat_id && x.message_id === message_id);
    const inc = this.incoming(chat_id, message_id);
    if ((sent && sent.deletedAt !== null) || (!sent && !notice && !inc)) return this.fail(res, record, reply.error(400, 'Bad Request: message to delete not found'));
    const now = Date.now();
    if (sent) sent.deletedAt = now;
    if (notice) notice.deletedAt = now;
    if (this.pinned.get(chat_id) === message_id) this.pinned.delete(chat_id);
    this.deleted.push({ chat_id, message_id, at: now });
    this.ok(res, record, true);
  }

  /** pinChatMessage: закрепить; в чате появляется служебное сообщение о закреплении (следующий номер). */
  private pinChatMessage(p: Params, res: http.ServerResponse, record: CallRecord): void {
    const chat_id = num(p.chat_id);
    const message_id = num(p.message_id);
    if (chat_id === undefined || message_id === undefined) return this.fail(res, record, reply.error(400, 'Bad Request: message to pin not found'));
    const retry = this.serviceRateLimited(chat_id);
    if (retry !== null) return this.fail(res, record, errors.tooManyRequests(retry));
    const sent = this.sent.find((x) => x.chat_id === chat_id && x.message_id === message_id);
    if ((!sent && !this.incoming(chat_id, message_id)) || (sent && sent.deletedAt !== null)) return this.fail(res, record, reply.error(400, 'Bad Request: message to pin not found'));
    const disable = p.disable_notification === true || p.disable_notification === 'true';
    const now = Date.now();
    this.pinned.set(chat_id, message_id);
    this.pins.push({ chat_id, message_id, disable_notification: disable, at: now });
    this.pinNotices.push({ chat_id, message_id: this.nextMessageId(chat_id), pinned_message_id: message_id, at: now, deletedAt: null });
    this.ok(res, record, true);
  }

  // ——— длинный опрос ———

  private getUpdates(p: Params, res: http.ServerResponse, record: CallRecord): void {
    if (this.webhookUrl) return this.fail(res, record, errors.conflictWebhook());
    // Второй опрос того же токена снимает первый: висящему — 409 (Ш-24).
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      this.respondReply(w.res, w.record, errors.conflictPolling());
    }
    const offset = num(p.offset);
    this.lastOffset = offset;
    if (offset !== undefined && offset > 0) this.queue = this.queue.filter((u) => u.update_id >= offset || this.forced.has(u));
    if (Array.isArray(p.allowed_updates)) {
      this.allowedUpdates = p.allowed_updates.length ? (p.allowed_updates as string[]) : DEFAULT_ALLOWED;
    }
    // Обновления вида, которого бот не просит, Telegram не выдаёт.
    this.queue = this.queue.filter((u) => this.allowedUpdates.includes(updateType(u)));
    const limit = Math.min(Math.max(num(p.limit) ?? 100, 1), 100);
    const timeout = Math.max(num(p.timeout) ?? 0, 0);
    const ready = this.take(offset, limit);
    if (ready.length || timeout === 0) {
      record.updateIds = ready.map((u) => u.update_id);
      return this.ok(res, record, ready);
    }
    const waiter: Waiter = {
      res,
      record,
      offset,
      limit,
      timer: setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        record.updateIds = [];
        this.ok(res, record, []);
      }, timeout * 1000),
    };
    this.waiters.push(waiter);
  }

  private take(offset: number | undefined, limit: number): Update[] {
    let list = this.queue;
    if (offset !== undefined && offset < 0) list = list.slice(offset);
    const out = list.slice(0, limit);
    const now = Date.now();
    for (const u of out) {
      this.forced.delete(u);
      if (!this.handedOut.has(u.update_id)) this.handedOut.set(u.update_id, now);
    }
    return out.map((u) => structuredClone(u));
  }

  private flushWaiters(): void {
    for (const w of this.waiters.splice(0)) {
      this.queue = this.queue.filter((u) => this.allowedUpdates.includes(updateType(u)));
      const ready = this.take(w.offset, w.limit);
      if (!ready.length) {
        this.waiters.push(w);
        continue;
      }
      clearTimeout(w.timer);
      w.record.updateIds = ready.map((u) => u.update_id);
      this.ok(w.res, w.record, ready);
    }
  }

  // ——— отправка ———

  private chatOf(chatId: number): Chat {
    return this.chats.get(chatId) ?? ({ id: chatId, type: 'private', first_name: 'Владелец' } as Chat.PrivateChat);
  }

  /** Предел частоты в чат: retry_after, если превышен; null — нет. Сообщения и правки — один счёт, реакции — другой. */
  private rateLimited(chatId: number, bucket: 'messages' | 'reactions' = 'messages'): number | null {
    const lim = bucket === 'messages' ? this.opts.chatRateLimit : this.opts.reactionRateLimit;
    if (!lim) return null;
    const store = bucket === 'messages' ? this.sendTimes : this.reactionTimes;
    const now = this.nowFn();
    const times = (store.get(chatId) ?? []).filter((t) => now - t < 1000);
    if (times.length >= lim.perSecond) {
      store.set(chatId, times);
      return lim.retryAfter;
    }
    times.push(now);
    store.set(chatId, times);
    return null;
  }

  /** Закрепление, открепление, удаление — в счёт сообщений, если так задано (rateLimitServiceCalls). */
  private serviceRateLimited(chatId: number): number | null {
    return this.opts.rateLimitServiceCalls ? this.rateLimited(chatId) : null;
  }

  private checkText(text: string, parseMode: string | null, limit: number, what: 'text' | 'caption'): FakeReply | null {
    let plain = text;
    if (parseMode === 'HTML') {
      const c = checkTelegramHtml(text);
      if (c.error) return errors.parseEntities(c.error);
      plain = c.plain;
    }
    if (what === 'text' && plain.trim() === '') return reply.error(400, 'Bad Request: message text is empty');
    if (plain.length > limit) {
      return what === 'text' ? errors.tooLong() : reply.error(400, 'Bad Request: message caption is too long');
    }
    return null;
  }

  private newMessage(chatId: number, fields: Record<string, unknown>): Message {
    return {
      message_id: this.nextMessageId(chatId),
      from: this.botUser,
      chat: this.chatOf(chatId),
      date: Math.floor(this.nowFn() / 1000),
      ...fields,
    } as unknown as Message;
  }

  private sendMessage(p: Params, res: http.ServerResponse, record: CallRecord): void {
    const chat_id = num(p.chat_id);
    if (chat_id === undefined) return this.fail(res, record, reply.error(400, 'Bad Request: chat not found'));
    const text = str(p.text) ?? '';
    const parse_mode = str(p.parse_mode);
    const bad = this.checkText(text, parse_mode, 4096, 'text');
    if (bad) return this.fail(res, record, bad);
    const retry = this.rateLimited(chat_id);
    if (retry !== null) return this.fail(res, record, errors.tooManyRequests(retry));
    const msg = this.newMessage(chat_id, {
      text: parse_mode === 'HTML' ? checkTelegramHtml(text).plain : text,
      ...(p.reply_markup ? { reply_markup: p.reply_markup } : {}),
    });
    this.sent.push({
      chat_id,
      message_id: msg.message_id,
      method: 'sendMessage',
      text,
      caption: null,
      parse_mode,
      reply_markup: p.reply_markup ?? null,
      reply_parameters: p.reply_parameters ?? null,
      link_preview_options: p.link_preview_options ?? null,
      voice: null,
      edits: [],
      at: Date.now(),
      message: msg,
      disable_notification: p.disable_notification === true || p.disable_notification === 'true',
      deletedAt: null,
    });
    this.ok(res, record, msg);
  }

  private sendVoice(p: Params, res: http.ServerResponse, record: CallRecord): void {
    const chat_id = num(p.chat_id);
    if (chat_id === undefined) return this.fail(res, record, reply.error(400, 'Bad Request: chat not found'));
    const voice = p.voice;
    const bytes = isUploadedFile(voice) ? voice.data.length : typeof voice === 'string' ? 0 : -1;
    if (bytes < 0) return this.fail(res, record, reply.error(400, 'Bad Request: there is no voice in the request'));
    const caption = str(p.caption);
    const parse_mode = str(p.parse_mode);
    if (caption) {
      const bad = this.checkText(caption, parse_mode, 1024, 'caption');
      if (bad) return this.fail(res, record, bad);
    }
    const retry = this.rateLimited(chat_id);
    if (retry !== null) return this.fail(res, record, errors.tooManyRequests(retry));
    const duration = num(p.duration) ?? null;
    const fileId = `sent_voice_${++this.fileSeq}`;
    if (isUploadedFile(voice)) this.addFile(voice.data, { fileId, path: `voice/${fileId}.oga` });
    const msg = this.newMessage(chat_id, {
      voice: { file_id: fileId, file_unique_id: `u${fileId}`, duration: duration ?? 0, mime_type: 'audio/ogg', file_size: Math.max(bytes, 0) },
      ...(caption ? { caption } : {}),
    });
    this.sent.push({
      chat_id,
      message_id: msg.message_id,
      method: 'sendVoice',
      text: null,
      caption,
      parse_mode,
      reply_markup: p.reply_markup ?? null,
      reply_parameters: p.reply_parameters ?? null,
      link_preview_options: null,
      voice: { bytes: Math.max(bytes, 0), duration },
      edits: [],
      at: Date.now(),
      message: msg,
      disable_notification: p.disable_notification === true || p.disable_notification === 'true',
      deletedAt: null,
    });
    this.ok(res, record, msg);
  }

  /**
   * Документ (посылки, 0.3.3): как настоящий API — файл загрузкой (multipart), подпись до 1024 знаков, предел 50 МБ
   * (общий сервер Bot API); пустой файл — 400.
   */
  private sendDocument(p: Params, res: http.ServerResponse, record: CallRecord): void {
    const chat_id = num(p.chat_id);
    if (chat_id === undefined) return this.fail(res, record, reply.error(400, 'Bad Request: chat not found'));
    const doc = p.document;
    if (!isUploadedFile(doc)) return this.fail(res, record, reply.error(400, 'Bad Request: there is no document in the request'));
    if (doc.data.length === 0) return this.fail(res, record, reply.error(400, 'Bad Request: file must be non-empty'));
    if (doc.data.length > 50 * 1024 * 1024) return this.fail(res, record, reply.error(413, 'Request Entity Too Large'));
    const caption = str(p.caption);
    const parse_mode = str(p.parse_mode);
    if (caption) {
      const bad = this.checkText(caption, parse_mode, 1024, 'caption');
      if (bad) return this.fail(res, record, bad);
    }
    const retry = this.rateLimited(chat_id);
    if (retry !== null) return this.fail(res, record, errors.tooManyRequests(retry));
    const fileId = `sent_doc_${++this.fileSeq}`;
    this.addFile(doc.data, { fileId, path: `documents/${doc.filename ?? fileId}` });
    const msg = this.newMessage(chat_id, {
      document: { file_id: fileId, file_unique_id: `u${fileId}`, file_name: doc.filename ?? undefined, mime_type: doc.contentType ?? undefined, file_size: doc.data.length },
      ...(caption ? { caption } : {}),
    });
    this.sent.push({
      chat_id,
      message_id: msg.message_id,
      method: 'sendDocument',
      text: null,
      caption,
      parse_mode,
      reply_markup: p.reply_markup ?? null,
      reply_parameters: p.reply_parameters ?? null,
      link_preview_options: null,
      voice: null,
      document: { filename: doc.filename, contentType: doc.contentType, data: doc.data },
      edits: [],
      at: Date.now(),
      message: msg,
      disable_notification: p.disable_notification === true || p.disable_notification === 'true',
      deletedAt: null,
    });
    this.ok(res, record, msg);
  }

  /**
   * Фото (посылки, #60): как настоящий API — файл загрузкой (multipart), подпись до 1024 знаков; пределы фото из описания
   * sendPhoto (до 10 МБ, ширина и высота вместе до 10 000, стороны не вытянутее 1:20) — отказ 400, как у Telegram
   * (PHOTO_SAVE_FILE_INVALID, PHOTO_INVALID_DIMENSIONS); не картинка — IMAGE_PROCESS_FAILED. Размеры — по заголовку
   * (imageInfo из stg-core).
   */
  private sendPhoto(p: Params, res: http.ServerResponse, record: CallRecord): void {
    const chat_id = num(p.chat_id);
    if (chat_id === undefined) return this.fail(res, record, reply.error(400, 'Bad Request: chat not found'));
    const photo = p.photo;
    if (!isUploadedFile(photo)) return this.fail(res, record, reply.error(400, 'Bad Request: there is no photo in the request'));
    if (photo.data.length === 0) return this.fail(res, record, reply.error(400, 'Bad Request: file must be non-empty'));
    if (photo.data.length > 10 * 1024 * 1024) return this.fail(res, record, reply.error(400, 'Bad Request: PHOTO_SAVE_FILE_INVALID'));
    const info = imageInfo(photo.data);
    if (!info) return this.fail(res, record, reply.error(400, 'Bad Request: IMAGE_PROCESS_FAILED'));
    const { width, height } = info;
    if (width + height > 10_000 || Math.max(width, height) > 20 * Math.min(width, height)) {
      return this.fail(res, record, reply.error(400, 'Bad Request: PHOTO_INVALID_DIMENSIONS'));
    }
    const caption = str(p.caption);
    const parse_mode = str(p.parse_mode);
    if (caption) {
      const bad = this.checkText(caption, parse_mode, 1024, 'caption');
      if (bad) return this.fail(res, record, bad);
    }
    const retry = this.rateLimited(chat_id);
    if (retry !== null) return this.fail(res, record, errors.tooManyRequests(retry));
    const fileId = `sent_photo_${++this.fileSeq}`;
    this.addFile(photo.data, { fileId, path: `photos/${fileId}.jpg` });
    const msg = this.newMessage(chat_id, {
      photo: [{ file_id: fileId, file_unique_id: `u${fileId}`, width, height, file_size: photo.data.length }],
      ...(caption ? { caption } : {}),
    });
    this.sent.push({
      chat_id,
      message_id: msg.message_id,
      method: 'sendPhoto',
      text: null,
      caption,
      parse_mode,
      reply_markup: p.reply_markup ?? null,
      reply_parameters: p.reply_parameters ?? null,
      link_preview_options: null,
      voice: null,
      photo: { filename: photo.filename, contentType: photo.contentType, data: photo.data },
      edits: [],
      at: Date.now(),
      message: msg,
      disable_notification: p.disable_notification === true || p.disable_notification === 'true',
      deletedAt: null,
    });
    this.ok(res, record, msg);
  }

  /**
   * Что можно править (Bot API, «Updating messages»): только сообщения без разметки или со встроенными кнопками;
   * новая разметка — только встроенные кнопки. Иначе — 400, как у настоящего API.
   */
  private editable(target: SentMessage, p: Params): FakeReply | null {
    const current = target.edits.at(-1)?.reply_markup ?? (target.edits.length ? null : target.reply_markup);
    if (current && !isInlineMarkup(current)) return reply.error(400, "Bad Request: message can't be edited");
    if (p.reply_markup !== undefined && p.reply_markup !== null && !isInlineMarkup(p.reply_markup)) {
      return reply.error(400, 'Bad Request: inline keyboard expected');
    }
    return null;
  }

  private editMessageReplyMarkup(p: Params, res: http.ServerResponse, record: CallRecord): void {
    const chat_id = num(p.chat_id);
    const message_id = num(p.message_id);
    const target = this.sent.find((s) => s.chat_id === chat_id && s.message_id === message_id && s.deletedAt === null);
    if (!target || chat_id === undefined) return this.fail(res, record, reply.error(400, 'Bad Request: message to edit not found'));
    const bad = this.editable(target, p);
    if (bad) return this.fail(res, record, bad);
    const current = target.edits.at(-1) ?? { text: target.text ?? target.caption ?? '', reply_markup: target.reply_markup };
    if (sameJson(current.reply_markup, p.reply_markup ?? null)) return this.fail(res, record, errors.notModified());
    const retry = this.rateLimited(chat_id);
    if (retry !== null) return this.fail(res, record, errors.tooManyRequests(retry));
    target.edits.push({ text: current.text, reply_markup: p.reply_markup ?? null, at: Date.now() });
    this.ok(res, record, { ...target.message, edit_date: Math.floor(this.nowFn() / 1000) });
  }

  private editMessageText(p: Params, res: http.ServerResponse, record: CallRecord): void {
    const chat_id = num(p.chat_id);
    const message_id = num(p.message_id);
    const target = this.sent.find((s) => s.chat_id === chat_id && s.message_id === message_id && s.deletedAt === null);
    if (!target || chat_id === undefined) return this.fail(res, record, reply.error(400, 'Bad Request: message to edit not found'));
    if (target.method === 'sendVoice') return this.fail(res, record, reply.error(400, 'Bad Request: there is no text in the message to edit'));
    const notEditable = this.editable(target, p);
    if (notEditable) return this.fail(res, record, notEditable);
    const text = str(p.text) ?? '';
    const parse_mode = str(p.parse_mode);
    const bad = this.checkText(text, parse_mode, 4096, 'text');
    if (bad) return this.fail(res, record, bad);
    const current = target.edits.at(-1) ?? { text: target.text ?? '', reply_markup: target.reply_markup };
    if (current.text === text && sameJson(current.reply_markup, p.reply_markup ?? null)) {
      return this.fail(res, record, errors.notModified());
    }
    const retry = this.rateLimited(chat_id);
    if (retry !== null) return this.fail(res, record, errors.tooManyRequests(retry));
    target.edits.push({ text, reply_markup: p.reply_markup ?? null, at: Date.now() });
    this.ok(res, record, { ...target.message, text, edit_date: Math.floor(this.nowFn() / 1000) });
  }
}

export { privateChatOf };
