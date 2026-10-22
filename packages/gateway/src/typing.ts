// «Печатает…» (TECH-SPEC 5.5 ⟨предл. принято в M3⟩): пока событие отдано агенту и ответа нет, шлюз шлёт
// sendChatAction typing каждые 4 с, но не дольше 2 минут на событие: статус в Telegram живёт до 5 с и гаснет, когда бот
// прислал сообщение. Начало — `delivered` от переходника (канал толкнул событие в сессию); конец — ответ или done на
// это событие, «стоп», потеря аренды, 2 минуты.
// Таймеры — часы шлюза (поддельные под тестом). Сбой запроса — не повод ни для чего: «печатает…» — подсказка, а не
// доставка; в журнал — первый сбой подряд.

import { MESSAGE_EVENT_KINDS, type Timer } from 'stg-core';
import type { Ctx } from './context.js';

export const TYPING_EVERY_MS = 4_000;
export const TYPING_MAX_MS = 2 * 60_000;

interface ChatTyping {
  chatId: number;
  threadId: number | null;
  /** № события → когда начали. */
  seqs: Map<number, number>;
  timer: Timer | null;
}

export class Typing {
  private readonly chats = new Map<string, ChatTyping>();
  private failing = false;

  constructor(private readonly ctx: Ctx) {}

  /** Событие отдано агенту: печатать в его чат. Не сообщение владельца (итог эпизода, probe) — не печатать. */
  start(seq: number, kind: string, chatId: number | null, threadId: number | null): void {
    if (chatId === null || !(MESSAGE_EVENT_KINDS as readonly string[]).includes(kind) || !this.ctx.api) return;
    const key = `${chatId}:${threadId ?? ''}`;
    let c = this.chats.get(key);
    if (!c) {
      c = { chatId, threadId, seqs: new Map(), timer: null };
      this.chats.set(key, c);
    }
    if (c.seqs.has(seq)) return;
    c.seqs.set(seq, this.ctx.clock.now());
    if (!c.timer) {
      const chat = c;
      this.beat(chat);
      chat.timer = this.ctx.clock.setInterval(() => this.beat(chat), TYPING_EVERY_MS);
    }
  }

  /** Ответ или done на событие: больше не печатать о нём. */
  stop(seqs: Iterable<number>): void {
    for (const seq of seqs) {
      for (const c of this.chats.values()) c.seqs.delete(seq);
    }
    for (const [key, c] of this.chats) if (!c.seqs.size) this.end(key, c);
  }

  /** «Стоп», потеря аренды, остановка шлюза. */
  stopAll(): void {
    for (const [key, c] of this.chats) this.end(key, c);
  }

  /** Сколько чатов «печатают» (для тестов и журнала). */
  get active(): number {
    return this.chats.size;
  }

  private end(key: string, c: ChatTyping): void {
    c.timer?.cancel();
    c.timer = null;
    this.chats.delete(key);
  }

  private beat(c: ChatTyping): void {
    const now = this.ctx.clock.now();
    for (const [seq, started] of c.seqs) if (now - started >= TYPING_MAX_MS) c.seqs.delete(seq);
    if (!c.seqs.size) {
      this.end(`${c.chatId}:${c.threadId ?? ''}`, c);
      return;
    }
    const api = this.ctx.api;
    if (!api) return;
    const params: Record<string, unknown> = { chat_id: c.chatId, action: 'typing' };
    if (c.threadId !== null) params.message_thread_id = c.threadId;
    void api.call('sendChatAction', params, { timeoutMs: 10_000 }).then(
      () => {
        this.failing = false;
      },
      (err: unknown) => {
        if (!this.failing) this.ctx.journal.write('typing_failed', { chat_id: c.chatId, error: api.redact((err as Error).message) });
        this.failing = true;
      },
    );
  }
}
