// Окно отмены реакции владельца на ответ агента (0.3.4; GitHub issue #46; TECH-SPEC 5.17): реакцию, поставленную по
// ошибке и сразу снятую, агент не получает — как отмена отправки письма в почте. Окно короткое (не больше 3 с), чтобы
// не мешать разговору в чате.
//
// Реакция записывается сразу (событие, updates, offset — одна транзакция, Ш-15; admission.ts, handleReaction), но
// событие — held с events.hold_until = «можно отдавать». Здесь — таймер на ближайший hold_until (часы шлюза, не тикер
// 15 с: агент получает реакцию через окно, а не через такт): срок пришёл — held → new одной транзакцией, журнал
// reaction_released {seq, held_ms}, переходнику — pump. Склейка и отмена в окне — в приёме (handleReaction): новое
// обновление реакции на тот же ответ меняет удерживаемое событие и сдвигает hold_until; итог совпал с тем, что стояло до
// окна, — cancelled. После перезапуска шлюза schedule() при старте досчитывает остаток (или отдаёт сразу, если окно уже
// прошло). Диск полон — отпустить не вышло: повтор после восстановления (disk.onRecovered → schedule).
// Окно не задерживает ничего другого: сообщения, команды, расшифровки идут мимо удерживаемой реакции (adapter.ts, pump:
// held не держит курсор, как распознаваемое голосовое после 90 с).

import { sql, transaction, type Timer } from 'stg-core';
import type { Ctx } from './context.js';

/** Окно отмены реакции из config.yaml (reactions.hold_seconds), мс; 0 — без окна. */
export function reactionHoldMs(ctx: Pick<Ctx, 'config'>): number {
  return Math.max(0, Math.round((ctx.config.reactions?.hold_seconds ?? 0) * 1000));
}

export class ReactionHold {
  private timer: Timer | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: Ctx,
    /** Отпущено хотя бы одно событие — отдать агенту (adapter.pump). */
    private readonly onReleased: () => void,
  ) {}

  /** Таймер на ближайший срок удерживаемой реакции (старт, после записи и склейки, после «диск полон»). */
  schedule(): void {
    if (this.stopped) return;
    this.timer?.cancel();
    this.timer = null;
    let at: number | null;
    try {
      at = (sql(this.ctx.db, "SELECT min(hold_until) AS t FROM events WHERE status = 'held'").get() as { t: number | null }).t;
    } catch (err) {
      if (this.ctx.disk.check(err, 'reaction_hold')) return;
      throw err;
    }
    if (at === null) return;
    const wait = at - this.ctx.clock.now();
    // Окно уже прошло (шлюз стоял дольше остатка) — отдать сразу, не дожидаясь таймера (release отпускает все прошедшие
    // разом и снова зовёт schedule — уже на будущий срок).
    if (wait <= 0) {
      this.release();
      return;
    }
    this.timer = this.ctx.clock.setTimeout(() => {
      this.timer = null;
      this.release();
    }, wait);
  }

  /** Отпустить реакции, чьё окно прошло: held → new; журнал reaction_released; затем — таймер на следующую. */
  release(): void {
    if (this.stopped) return;
    const now = this.ctx.clock.now();
    let rows: Array<{ seq: number; created_at: number; hold_until: number }>;
    try {
      rows = transaction(this.ctx.db, () => {
        const due = sql(this.ctx.db, "SELECT seq, created_at, hold_until FROM events WHERE status = 'held' AND hold_until <= ? ORDER BY seq").all(now) as Array<{
          seq: number;
          created_at: number;
          hold_until: number;
        }>;
        if (due.length) sql(this.ctx.db, "UPDATE events SET status = 'new' WHERE status = 'held' AND hold_until <= ?").run(now);
        return due;
      });
    } catch (err) {
      // Диск полон: удерживаемые остаются held — отпустит schedule после восстановления.
      if (this.ctx.disk.check(err, 'reaction_hold')) return;
      throw err;
    }
    // held_ms — от записи первого изменения до отдачи (со всеми сдвигами окна).
    for (const r of rows) this.ctx.journal.write('reaction_released', { seq: r.seq, held_ms: now - r.created_at });
    if (rows.length) this.onReleased();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
  }
}
