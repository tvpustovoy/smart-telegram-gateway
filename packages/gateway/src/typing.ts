// «Печатает…» (TECH-SPEC 5.5 ⟨предл. принято в M3⟩): пока событие отдано агенту и ответа нет, шлюз шлёт
// sendChatAction typing каждые 4 с, но не дольше 2 минут на событие: статус в Telegram живёт до 5 с и гаснет, когда бот
// прислал сообщение. Начало — `delivered` от переходника (канал толкнул событие в сессию); конец — ответ или done на
// это событие, «стоп», потеря аренды, 2 минуты.
// Ход агента идёт (`working`, #55): переходник, который видит начало и конец хода (адаптер Codex), держит «печатает…» в
// чатах событий хода всё время хода — и после промежуточного ответа на них (ответ снимает событие, а ход — нет). Конец —
// `working {on: false}`, «стоп», потеря аренды или WORKING_HOLD_MS без нового working (переходник замолчал, ход завис).
// Ход есть — агент «думает» (🟡) в закреплённой строке: о смене — onWorkingChange.
// Таймеры — часы шлюза (поддельные под тестом). Сбой запроса — не повод ни для чего: «печатает…» — подсказка, а не
// доставка; в журнал — первый сбой подряд.

import { MESSAGE_EVENT_KINDS, WORKING_HOLD_MS, type Timer } from 'stg-core';
import type { Ctx } from './context.js';

export const TYPING_EVERY_MS = 4_000;
export const TYPING_MAX_MS = 2 * 60_000;

interface ChatTyping {
  chatId: number;
  threadId: number | null;
  /** № события → когда начали. */
  seqs: Map<number, number>;
  /** Ход агента идёт в этом чате (working): держать до этого времени; null — хода нет. */
  workUntil: number | null;
  timer: Timer | null;
}

/** Чат (и тема) события хода. */
export interface WorkingChat {
  chatId: number;
  threadId: number | null;
}

function keyOf(chatId: number, threadId: number | null): string {
  return `${chatId}:${threadId ?? ''}`;
}

export class Typing {
  private readonly chats = new Map<string, ChatTyping>();
  private failing = false;

  /** onWorkingChange — ход агента начался или кончился (в каком-нибудь чате): закреплённой строке пора сменить кружок. */
  constructor(
    private readonly ctx: Ctx,
    private readonly onWorkingChange: () => void = () => undefined,
  ) {}

  /** Событие отдано агенту: печатать в его чат. Не сообщение владельца (итог эпизода, probe) — не печатать. */
  start(seq: number, kind: string, chatId: number | null, threadId: number | null): void {
    if (chatId === null || !(MESSAGE_EVENT_KINDS as readonly string[]).includes(kind) || !this.ctx.api) return;
    const c = this.chat(chatId, threadId);
    if (c.seqs.has(seq)) return;
    c.seqs.set(seq, this.ctx.clock.now());
    this.arm(c);
  }

  /**
   * Ход агента идёт в этих чатах (working {on: true}); пусто — хода нет (working {on: false}). Набор заменяет прежний:
   * чат, которого в нём нет, больше не держится ходом. Каждый working продлевает срок на WORKING_HOLD_MS. Возвращает,
   * в скольких чатах ход держит «печатает…».
   */
  working(chats: readonly WorkingChat[]): number {
    const was = this.isWorking;
    const until = this.ctx.clock.now() + WORKING_HOLD_MS;
    const keep = new Set<string>();
    if (this.ctx.api) {
      for (const w of chats) {
        const c = this.chat(w.chatId, w.threadId);
        keep.add(keyOf(w.chatId, w.threadId));
        c.workUntil = until;
        this.arm(c);
      }
    }
    for (const [key, c] of this.chats) {
      if (keep.has(key) || c.workUntil === null) continue;
      c.workUntil = null;
      if (!c.seqs.size) this.end(key, c);
    }
    this.changed(was);
    return keep.size;
  }

  /** Ответ или done на событие: больше не печатать о нём (ход агента, если идёт, держит «печатает…» дальше). */
  stop(seqs: Iterable<number>): void {
    for (const seq of seqs) {
      for (const c of this.chats.values()) c.seqs.delete(seq);
    }
    for (const [key, c] of this.chats) if (!c.seqs.size && c.workUntil === null) this.end(key, c);
  }

  /** «Стоп», потеря аренды, остановка шлюза — и ход агента тоже. */
  stopAll(): void {
    const was = this.isWorking;
    for (const [key, c] of this.chats) this.end(key, c);
    this.changed(was);
  }

  /** Сколько чатов «печатают» (для тестов и журнала). */
  get active(): number {
    return this.chats.size;
  }

  /** Ход агента идёт хоть в одном чате (working, срок не вышел): в закреплённой строке — 🟡 «думает». */
  get isWorking(): boolean {
    for (const c of this.chats.values()) if (c.workUntil !== null) return true;
    return false;
  }

  private chat(chatId: number, threadId: number | null): ChatTyping {
    const key = keyOf(chatId, threadId);
    let c = this.chats.get(key);
    if (!c) {
      c = { chatId, threadId, seqs: new Map(), workUntil: null, timer: null };
      this.chats.set(key, c);
    }
    return c;
  }

  /** Чат начал «печатать»: сразу и дальше каждые 4 с. */
  private arm(c: ChatTyping): void {
    if (c.timer) return;
    this.beat(c);
    if (this.chats.get(keyOf(c.chatId, c.threadId)) === c) c.timer = this.ctx.clock.setInterval(() => this.beat(c), TYPING_EVERY_MS);
  }

  private changed(was: boolean): void {
    if (was !== this.isWorking) this.onWorkingChange();
  }

  private end(key: string, c: ChatTyping): void {
    c.timer?.cancel();
    c.timer = null;
    this.chats.delete(key);
  }

  private beat(c: ChatTyping): void {
    const now = this.ctx.clock.now();
    for (const [seq, started] of c.seqs) if (now - started >= TYPING_MAX_MS) c.seqs.delete(seq);
    const was = this.isWorking;
    if (c.workUntil !== null && now >= c.workUntil) {
      // Переходник не повторил working за срок: ход завис или переходник замолчал — «печатает…» больше не держится.
      c.workUntil = null;
      this.ctx.journal.write('working_expired', { chat_id: c.chatId, hold_ms: WORKING_HOLD_MS });
    }
    if (!c.seqs.size && c.workUntil === null) {
      this.end(keyOf(c.chatId, c.threadId), c);
      this.changed(was);
      return;
    }
    this.changed(was);
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
