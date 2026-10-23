// «Печатает…» (TECH-SPEC 5.5 ⟨предл. принято в M3⟩): пока событие отдано агенту и ответа нет, шлюз шлёт
// sendChatAction typing каждые 4 с, но не дольше 2 минут на событие: статус в Telegram живёт до 5 с и гаснет, когда бот
// прислал сообщение. Начало — `delivered` от переходника (канал толкнул событие в сессию); конец — ответ или done на
// это событие, «стоп», потеря аренды, 2 минуты.
// Ход агента идёт (`working`, #55): переходник, который видит начало и конец хода (адаптер Codex), держит «печатает…» в
// чатах событий хода всё время хода — и после промежуточного ответа на них (ответ снимает событие, а ход — нет). Конец —
// `working {on: false}`, «стоп», потеря аренды или WORKING_HOLD_MS без нового working (переходник замолчал, ход завис).
// Ход есть — агент «думает» (🟡) в закреплённой строке. Пока ход держит событие (holds), ответ на него 👀 не снимает
// (#52 × #55): снятие ждёт конца хода. Ход больше не держит события (набор сменился, off, «стоп», аренда, срок) —
// onWorkingChange с их № (released): шлюз снимает отложенное (adapter.ts); тот же вызов — и когда ход начался или кончился
// (кружок закреплённой строки).
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
  /** № событий хода в этом чате (working); пусто — хода нет. Ответ на них 👀 не снимает, пока ход идёт. */
  workSeqs: Set<number>;
  timer: Timer | null;
}

/** Событие хода: № и его чат (и тема). */
export interface WorkingEvent {
  seq: number;
  chatId: number;
  threadId: number | null;
}

/** Что держит ход: идёт ли он и какие № держит — до изменения (для onWorkingChange). */
interface Mark {
  working: boolean;
  held: Set<number>;
}

function keyOf(chatId: number, threadId: number | null): string {
  return `${chatId}:${threadId ?? ''}`;
}

export class Typing {
  private readonly chats = new Map<string, ChatTyping>();
  private failing = false;

  /**
   * onWorkingChange(released) — ход больше не держит события released (их отложенные снятия 👀 — пора), или ход начался
   * или кончился (в каком-нибудь чате): закреплённой строке пора сменить кружок.
   */
  constructor(
    private readonly ctx: Ctx,
    private readonly onWorkingChange: (released: number[]) => void = () => undefined,
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
   * Ход агента идёт с этими событиями (working {on: true}); пусто — хода нет (working {on: false}). Набор заменяет
   * прежний: чат и №, которых в нём нет, больше не держатся ходом. Каждый working продлевает срок на WORKING_HOLD_MS.
   * Возвращает, в скольких чатах ход держит «печатает…».
   */
  working(events: readonly WorkingEvent[]): number {
    const before = this.mark();
    const until = this.ctx.clock.now() + WORKING_HOLD_MS;
    const keep = new Map<string, ChatTyping>();
    if (this.ctx.api) {
      for (const e of events) {
        const key = keyOf(e.chatId, e.threadId);
        let c = keep.get(key);
        if (!c) {
          c = this.chat(e.chatId, e.threadId);
          c.workSeqs = new Set();
          c.workUntil = until;
          keep.set(key, c);
        }
        c.workSeqs.add(e.seq);
      }
      for (const c of keep.values()) this.arm(c);
    }
    for (const [key, c] of this.chats) {
      if (keep.has(key) || c.workUntil === null) continue;
      c.workUntil = null;
      c.workSeqs = new Set();
      if (!c.seqs.size) this.end(key, c);
    }
    this.changed(before);
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
    const before = this.mark();
    for (const [key, c] of this.chats) this.end(key, c);
    this.changed(before);
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

  /** Событие — в идущем ходе агента (working): ответ на него 👀 не снимает, пока ход идёт (#52 × #55). */
  holds(seq: number): boolean {
    for (const c of this.chats.values()) if (c.workUntil !== null && c.workSeqs.has(seq)) return true;
    return false;
  }

  private heldSeqs(): Set<number> {
    const out = new Set<number>();
    for (const c of this.chats.values()) if (c.workUntil !== null) for (const s of c.workSeqs) out.add(s);
    return out;
  }

  private mark(): Mark {
    return { working: this.isWorking, held: this.heldSeqs() };
  }

  private chat(chatId: number, threadId: number | null): ChatTyping {
    const key = keyOf(chatId, threadId);
    let c = this.chats.get(key);
    if (!c) {
      c = { chatId, threadId, seqs: new Map(), workUntil: null, workSeqs: new Set(), timer: null };
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

  /** Ход начался или кончился, или больше не держит какие-то № — onWorkingChange. */
  private changed(before: Mark): void {
    const held = this.heldSeqs();
    const released = [...before.held].filter((s) => !held.has(s)).sort((a, b) => a - b);
    if (released.length || before.working !== this.isWorking) this.onWorkingChange(released);
  }

  private end(key: string, c: ChatTyping): void {
    c.timer?.cancel();
    c.timer = null;
    this.chats.delete(key);
  }

  private beat(c: ChatTyping): void {
    const now = this.ctx.clock.now();
    for (const [seq, started] of c.seqs) if (now - started >= TYPING_MAX_MS) c.seqs.delete(seq);
    const before = this.mark();
    if (c.workUntil !== null && now >= c.workUntil) {
      // Переходник не повторил working за срок: ход завис или переходник замолчал — «печатает…» больше не держится.
      c.workUntil = null;
      c.workSeqs = new Set();
      this.ctx.journal.write('working_expired', { chat_id: c.chatId, hold_ms: WORKING_HOLD_MS });
    }
    if (!c.seqs.size && c.workUntil === null) {
      this.end(keyOf(c.chatId, c.threadId), c);
      this.changed(before);
      return;
    }
    this.changed(before);
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
