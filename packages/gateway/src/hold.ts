// Удержание событий окном (TECH-SPEC 5.17, 5.18): статус held и срок events.hold_until — «можно отдавать». Один таймер на
// два окна:
// - окно отмены реакции владельца на ответ агента (0.3.4; GitHub issue #46): реакцию, поставленную по ошибке и сразу
//   снятую, агент не получает — как отмена отправки письма в почте. Окно короткое (не больше 3 с), чтобы не мешать
//   разговору в чате. Склейка и отмена в окне — в приёме (admission.ts, handleReaction);
// - окно для материала без слов владельца (0.3.6; issue #51): пересылка, файл, фото без подписи ждут его слов в том же
//   чате (до 600 с, по умолчанию 120). Слова пришли — материал отпускает приём (material.ts, releaseByWords) в той же
//   транзакции, что записывает слова; слова — голосовое в распознавании — отпускает распознаватель вместе с ним
//   (material.ts, settleTranscribed). Здесь — только конец окна: материал уходит с пометкой «слов владельца не было».
//
// Событие записывается сразу (событие, updates, offset — одна транзакция, Ш-15), но held. Здесь — таймер на ближайший
// срок (часы шлюза, не тикер 15 с: агент получает событие через окно, а не через такт): срок пришёл — held → new одной
// транзакцией, журнал reaction_released {seq, held_ms} или material_released {seq, held_ms, words: none}, переходнику —
// pump. После перезапуска шлюза schedule() при старте досчитывает остаток (или отдаёт сразу, если окно уже прошло). Диск
// полон — отпустить не вышло: повтор после восстановления (disk.onRecovered → schedule).
// Окно не задерживает ничего другого: сообщения, команды, расшифровки идут мимо удерживаемого (adapter.ts, pump: held не
// держит курсор, как распознаваемое голосовое после 90 с).

import { sql, transaction, type MaterialHold, type Timer } from 'stg-core';
import type { Ctx } from './context.js';

/** Окно отмены реакции из config.yaml (reactions.hold_seconds), мс; 0 — без окна. */
export function reactionHoldMs(ctx: Pick<Ctx, 'config'>): number {
  return Math.max(0, Math.round((ctx.config.reactions?.hold_seconds ?? 0) * 1000));
}

/** Окно для материала без слов владельца из config.yaml (ui.material_hold_seconds), мс; 0 — без окна. */
export function materialHoldMs(ctx: Pick<Ctx, 'config'>): number {
  return Math.max(0, Math.round((ctx.config.ui?.material_hold_seconds ?? 0) * 1000));
}

/**
 * Материал, отпущенный словами владельца, которые ещё распознаются (голосовое, кружок): его отпустит распознаватель вместе
 * со словами (material.ts, settleTranscribed) — таймер его не трогает.
 */
const WAITS_FOR_WORDS_SQL = `(events.material_json IS NOT NULL AND json_extract(events.material_json, '$.state') <> 'waiting'
  AND EXISTS (SELECT 1 FROM events w WHERE w.seq = json_extract(events.material_json, '$.words_seq') AND w.status = 'transcribing'))`;
/**
 * Срок удерживаемого: у реакции и у материала в окне — hold_until; у материала, чьи слова уже распознаны, — сразу
 * (страховка: обычно его отпускает распознаватель в той же транзакции).
 */
const DUE_SQL = `(CASE WHEN events.material_json IS NOT NULL AND json_extract(events.material_json, '$.state') <> 'waiting' THEN 0 ELSE events.hold_until END)`;

interface DueRow {
  seq: number;
  kind: string;
  created_at: number;
  material_json: string | null;
}

export class Hold {
  private timer: Timer | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: Ctx,
    /** Отпущено хотя бы одно событие — отдать агенту (adapter.pump). */
    private readonly onReleased: () => void,
  ) {}

  /** Таймер на ближайший срок удерживаемого события (старт, после записи и склейки, после «диск полон»). */
  schedule(): void {
    if (this.stopped) return;
    this.timer?.cancel();
    this.timer = null;
    let at: number | null;
    try {
      at = (sql(this.ctx.db, `SELECT min(${DUE_SQL}) AS t FROM events WHERE status = 'held' AND NOT ${WAITS_FOR_WORDS_SQL}`).get() as { t: number | null }).t;
    } catch (err) {
      if (this.ctx.disk.check(err, 'hold')) return;
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

  /**
   * Отпустить события, чей срок пришёл: held → new; у материала, окно которого кончилось без слов, — пометка none и
   * сколько ждал; журнал; затем — таймер на следующее.
   */
  release(): void {
    if (this.stopped) return;
    const now = this.ctx.clock.now();
    let rows: Array<DueRow & { words: string | null }>;
    try {
      rows = transaction(this.ctx.db, () => {
        const due = sql(this.ctx.db,
          `SELECT seq, kind, created_at, material_json FROM events WHERE status = 'held' AND NOT ${WAITS_FOR_WORDS_SQL} AND ${DUE_SQL} <= ? ORDER BY seq`,
        ).all(now) as unknown as DueRow[];
        return due.map((r) => {
          if (r.material_json === null) {
            sql(this.ctx.db, "UPDATE events SET status = 'new' WHERE seq = ? AND status = 'held'").run(r.seq);
            return { ...r, words: null };
          }
          const m = JSON.parse(r.material_json) as MaterialHold;
          // Окно кончилось без слов — пометка, сколько материал ждал (от записи до отдачи, со всеми сдвигами окна).
          const next: MaterialHold = m.state === 'waiting' ? { ...m, state: 'none', waited_ms: now - r.created_at } : m;
          sql(this.ctx.db, "UPDATE events SET status = 'new', material_json = ? WHERE seq = ? AND status = 'held'").run(JSON.stringify(next), r.seq);
          return { ...r, words: next.state };
        });
      });
    } catch (err) {
      // Диск полон: удерживаемые остаются held — отпустит schedule после восстановления.
      if (this.ctx.disk.check(err, 'hold')) return;
      throw err;
    }
    // held_ms — от записи до отдачи (со всеми сдвигами окна).
    for (const r of rows) {
      if (r.words === null) this.ctx.journal.write('reaction_released', { seq: r.seq, held_ms: now - r.created_at });
      else this.ctx.journal.write('material_released', { seq: r.seq, held_ms: now - r.created_at, words: r.words });
    }
    if (rows.length) this.onReleased();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
  }
}
