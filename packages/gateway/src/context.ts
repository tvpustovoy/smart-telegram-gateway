// Общее для частей шлюза: база, часы, журнал, настройки, справочник, клиент Telegram. Пишет в базу только процесс
// шлюза (AD-3); все части работают в одном потоке, транзакции — синхронные (node:sqlite).

import { sql, type Clock, type Config, type Db, type DeletionReason, type Journal, type MessageOutKind, type StgPaths, type TelegramApi } from 'stg-core';
import type { Directory } from './directory.js';
import type { DiskState } from './disk.js';

export interface Ctx {
  db: Db;
  clock: Clock;
  journal: Journal;
  config: Config;
  paths: StgPaths;
  env: NodeJS.ProcessEnv;
  directory: Directory;
  /** Клиент Telegram — когда есть токен. */
  api: TelegramApi | null;
  /** STG_TEST=1. */
  test: boolean;
  /** Диск полон — общее состояние шлюза (disk.ts). */
  disk: DiskState;
}

export interface OutboxInsert {
  eventSeq: number | null;
  chatId: number;
  threadId: number | null;
  kind: MessageOutKind;
  text: string;
  origin: 'gateway' | 'agent';
  voice?: boolean;
  turn?: number | null;
  status?: 'pending' | 'held';
  /**
   * Разметка строки шлюза: встроенные кнопки (inline_keyboard) или снятие нижней клавиатуры (remove_keyboard — один раз,
   * при первом старте 0.3.1). Нижней клавиатуры с 0.3.1 нет (P-18).
   */
  replyMarkup?: GatewayMarkup | null;
  /**
   * Строка шлюза реплаем на это сообщение Telegram (расшифровка — ответом на голосовое, 5.5): каждая её часть, если
   * частей несколько.
   */
  replyToMessageId?: number | null;
  /** Ключ повтора ответа агента (reply.idem). */
  idem?: string | null;
  /** Чьи слова передаёт агент (reply.from, 0.3.2, P-26): отправитель ставит «↪ <имя>: » в начало. */
  fromName?: string | null;
  /**
   * Без разметки шлюза (до 0.3.1 — без нижней клавиатуры): ответ на голосовое и аудиофайл (кнопок под ним пока нет —
   * место оставлено) и ответ «где мы» (его удаляют).
   */
  bare?: boolean;
  /**
   * Строка шлюза — цитатой (0.3.4; развилка R-23 а, issue #44): расшифровка голосового, кружка, аудиофайла, видео
   * уходит в <blockquote> (sender.ts, splitQuote). Отказы распознавания — нет ⟨предл.⟩.
   */
  quote?: boolean;
}

/** Встроенная клавиатура Telegram: ряды кнопок с callback_data (токен кнопки шлюза). */
export interface InlineMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/** Снять нижнюю клавиатуру у клиента (ReplyKeyboardRemove) — один раз, при первом старте 0.3.1 (P-18). */
export interface RemoveKeyboardMarkup {
  remove_keyboard: true;
}

/** Разметка строки шлюза. */
export type GatewayMarkup = InlineMarkup | RemoveKeyboardMarkup;

/** Строка в очередь отправки. Вызывать внутри транзакции или как самостоятельную запись. */
export function insertOutbox(ctx: Ctx, o: OutboxInsert): number {
  const r = sql(ctx.db,
      `INSERT INTO outbox(event_seq, chat_id, thread_id, kind, text, voice, turn, origin, status, attempts, created_at, reply_markup, reply_to_message_id, idem, bare, from_name, quote)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.eventSeq,
      o.chatId,
      o.threadId,
      o.kind,
      o.text,
      o.voice ? 1 : 0,
      o.turn ?? null,
      o.origin,
      o.status ?? 'pending',
      ctx.clock.now(),
      o.replyMarkup ? JSON.stringify(o.replyMarkup) : null,
      o.replyToMessageId ?? null,
      o.idem ?? null,
      o.bare ? 1 : 0,
      o.fromName ?? null,
      o.quote ? 1 : 0,
    );
  return Number(r.lastInsertRowid);
}

export interface EditInsert {
  chatId: number;
  /** Править сообщение строки outbox (последнее: на нём кнопки) — когда оно отправлено. */
  outboxId?: number | null;
  /** Или прямо это сообщение Telegram (кнопки под нажатым сообщением). */
  tgMessageId?: number | null;
  eventSeq?: number | null;
  /** Новый текст; null — правится только разметка. */
  text: string | null;
  /** Встроенные кнопки после правки; null — кнопок нет. */
  replyMarkup: InlineMarkup | null;
}

/**
 * Правка сообщения бота (M4) — в очередь отправителя, с повтором. Внутри транзакции. Правка несёт состояние целиком,
 * поэтому прежние неотправленные правки того же сообщения больше не нужны: они бросаются (правка только кнопок не
 * отменяет правку текста).
 */
export function enqueueEdit(ctx: Ctx, e: EditInsert): number {
  const outboxId = e.outboxId ?? null;
  const tgId = e.tgMessageId ?? null;
  if (outboxId === null && tgId === null) throw new Error('правка без цели');
  sql(ctx.db,
    `UPDATE edits SET status = 'dropped' WHERE status = 'pending' AND chat_id = ?
     AND (outbox_id IS ? AND tg_message_id IS ?) AND (? IS NOT NULL OR text IS NULL)`,
  ).run(e.chatId, outboxId, tgId, e.text);
  const r = sql(ctx.db,
    `INSERT INTO edits(chat_id, outbox_id, tg_message_id, event_seq, text, reply_markup, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
  ).run(e.chatId, outboxId, tgId, e.eventSeq ?? null, e.text, e.replyMarkup ? JSON.stringify(e.replyMarkup) : null, ctx.clock.now());
  return Number(r.lastInsertRowid);
}

export interface ServiceLineOptions {
  /** К какому событию строка (реплай владельца на неё — reply_to.event_seq). */
  eventSeq?: number | null;
  /** Тема Telegram (null — основной поток). */
  threadId?: number | null;
  replyMarkup?: GatewayMarkup | null;
  /** Без разметки шлюза (ответ «где мы» — его удаляют). */
  bare?: boolean;
}

/** Служебная строка владельцу в личку (`⚙ …`). null — владельца нет (первая настройка). */
export function enqueueServiceLine(ctx: Ctx, text: string, opts: number | null | ServiceLineOptions = null): number | null {
  const owner = ctx.config.owner_id;
  if (owner === null) return null;
  if (!text.startsWith('⚙')) throw new Error(`служебная строка должна начинаться с ⚙: «${text.slice(0, 20)}»`);
  const o: ServiceLineOptions = typeof opts === 'number' || opts === null ? { eventSeq: opts } : opts;
  return insertOutbox(ctx, {
    eventSeq: o.eventSeq ?? null,
    chatId: owner,
    threadId: o.threadId ?? null,
    kind: 'service',
    text,
    origin: 'gateway',
    replyMarkup: o.replyMarkup ?? null,
    bare: o.bare ?? false,
  });
}

export interface DeletionInsert {
  chatId: number;
  /** Сообщение Telegram прямо (команда владельца, служебное сообщение о закреплении). */
  tgMessageId?: number | null;
  /** Или все части строки outbox — когда она отправлена (ответ «где мы»). */
  outboxId?: number | null;
  reason: DeletionReason;
  /** Когда удалить (часы шлюза). */
  dueAt: number;
  /**
   * Строка темы после [верно] (reason topic, 0.3.5, issue #48): не удалилась — правится на этот текст без кнопок (null —
   * снимаются только кнопки).
   */
  fallbackText?: string | null;
}

/**
 * Удалить сообщение (чистый чат, J-4: нажатие не оставляет лишнего) — в очередь отправителя, с повтором. Внутри
 * транзакции. Не удалилось (старше 48 часов, уже удалено) — не беда: в журнал; у строки темы (reason topic) — ещё и
 * правка без кнопок (sender.ts).
 */
export function enqueueDeletion(ctx: Ctx, d: DeletionInsert): number {
  if ((d.tgMessageId ?? null) === null && (d.outboxId ?? null) === null) throw new Error('удаление без цели');
  const r = sql(ctx.db,
    `INSERT INTO deletions(chat_id, tg_message_id, outbox_id, reason, due_at, status, attempts, created_at, fallback_text)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(d.chatId, d.tgMessageId ?? null, d.outboxId ?? null, d.reason, d.dueAt, ctx.clock.now(), d.fallbackText ?? null);
  return Number(r.lastInsertRowid);
}
