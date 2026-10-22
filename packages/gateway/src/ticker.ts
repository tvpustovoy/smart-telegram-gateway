// Сроки и сон (TECH-SPEC 5.3 «Сон ноутбука», 5.7; Ш-12, Ш-14). Один таймер часов раз в 15 с:
// - скачок часов больше 2 минут — запись `wake`; шлюз сначала забирает накопленное, потом проверяет сроки;
// - раз в минуту — сроки: тишина эпизода (33 минуты), «агент не на связи», чистка updates (и строк реакций и удалений),
//   строки in_progress старше суток, голосовые, ждущие распознавания, срок карточек правил (24 ч) и отставший rules.yaml
//   (M5), закреплённая строка состояния (отправитель сверяет её текст); раз в сутки — хранение и чистка (5.8,
//   retention.ts).
// Один таймер, а не несколько, — после сна каждый срок проверяется один раз, повторы не удваиваются.
// Диск полон — не падение (disk.ts): ошибка записи уходит в общее состояние, следующий срок — через минуту; пока диск
// полон, тикер раз в минуту пробует мелкую запись — в базу и файлом в raw/ (там лежит звук: место может кончиться и
// только для файлов) — так шлюз узнаёт, что место освободилось.

import { sql, MESSAGE_EVENT_KINDS, META_KEYS, getMeta, offlineNotice, setMeta, transaction, type Timer } from 'stg-core';
import type { AdapterService } from './adapter.js';
import { enqueueServiceLine, type Ctx } from './context.js';
import type { Episodes } from './episodes.js';
import type { Reception } from './reception.js';
import { REACTIONS_KEEP_MS } from './reactions.js';
import { deferStaleInProgress } from './recovery.js';
import type { Retention } from './retention.js';
import type { Sender } from './sender.js';

export const TICK_MS = 15_000;
export const WAKE_JUMP_MS = 2 * 60_000;
export const DEADLINE_EVERY_MS = 60_000;
/** Сколько помнить номера принятого и незнакомого (Ш-2): Telegram держит неподтверждённое 24 часа. */
export const UPDATES_KEEP_MS = 24 * 3600_000;

const MSG_KINDS_SQL = MESSAGE_EVENT_KINDS.map((k) => `'${k}'`).join(',');

export class Ticker {
  private timer: Timer | null = null;
  private lastTick: number;
  private lastDeadlines: number;
  private waking = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly episodes: Episodes,
    private readonly adapter: AdapterService,
    private readonly sender: Sender,
    private reception: Reception | null,
    /** Пробная запись файла в raw/ (пока диск полон). */
    private readonly fileProbe: (() => void) | null = null,
    /** Хранение и чистка — раз в сутки (5.8). */
    private readonly retention: Retention | null = null,
    /** Распознаватель голосовых: напомнить о transcribing (после диска полон, после сна). */
    private readonly transcriber: { kick(): void } | null = null,
    /** Правила (M5): истёкшие карточки изменений, отставший rules.yaml. */
    private readonly rules: { tick(now: number): boolean } | null = null,
  ) {
    this.lastTick = ctx.clock.now();
    this.lastDeadlines = this.lastTick;
  }

  setReception(r: Reception): void {
    this.reception = r;
  }

  start(): void {
    this.timer ??= this.ctx.clock.setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  private tick(): void {
    const now = this.ctx.clock.now();
    const delta = now - this.lastTick;
    this.lastTick = now;
    if (delta > WAKE_JUMP_MS + TICK_MS) {
      this.ctx.journal.write('wake', { slept_ms: delta - TICK_MS });
      if (!this.waking) {
        this.waking = true;
        const later = this.reception?.wake(() => {
          this.waking = false;
          this.checkDeadlines();
        });
        if (later) return;
        this.waking = false;
        this.checkDeadlines();
        return;
      }
    }
    if (this.waking) return;
    if (now - this.lastDeadlines >= DEADLINE_EVERY_MS) this.checkDeadlines();
  }

  /** Сроки: тишина эпизодов, «не на связи», чистка, зависшие in_progress; при полном диске — пробная запись. */
  checkDeadlines(): void {
    const now = this.ctx.clock.now();
    this.lastDeadlines = now;
    try {
      const closed = this.episodes.closeIdle(now);
      if (closed.length) this.adapter.pump();
      this.checkOffline(now);
      this.purgeUpdates(now);
      this.purgeUi(now);
      if (deferStaleInProgress(this.ctx, now).length) this.sender.kick();
      if (this.rules?.tick(now)) this.sender.kick();
      if (this.ctx.disk.isFull || this.ctx.disk.needsProbe) {
        transaction(this.ctx.db, () => setMeta(this.ctx.db, META_KEYS.diskProbe, String(now)));
        this.fileProbe?.();
        this.ctx.disk.probeOk(now);
      }
      this.transcriber?.kick();
      // Закреплённая строка (эпизод закрылся по тишине, сменилось число ждущих) и реакции — сверить раз в минуту.
      this.sender.kick();
    } catch (err) {
      if (!this.ctx.disk.check(err, 'ticker')) throw err;
    }
    // Чистка — отдельно: её сбой (права на файл, занятый каталог) не роняет сроки и не роняет шлюз; повтор — завтра.
    try {
      this.retention?.maybeRun(now);
    } catch (err) {
      if (!this.ctx.disk.check(err, 'retention')) this.ctx.journal.write('retention_failed', { error: (err as Error).message });
    }
  }

  /** Чистка admitted и ignored старше 24 ч (5.2, Ш-2). in_progress и deferred не трогаются: в них содержимое. */
  purgeUpdates(now: number): number {
    const r = transaction(this.ctx.db, () =>
      sql(this.ctx.db, "DELETE FROM updates WHERE status IN ('admitted', 'ignored') AND received_at < ?").run(now - UPDATES_KEEP_MS),
    );
    const n = Number(r.changes);
    if (n) this.ctx.journal.write('updates_purged', { count: n, older_than_ms: UPDATES_KEEP_MS });
    return n;
  }

  /**
   * Чистка строк интерфейса, которые больше не меняются: реакции (👌 после недели — уже не квитанция) и удаления старше
   * суток.
   */
  purgeUi(now: number): void {
    const r = transaction(this.ctx.db, () => {
      const a = sql(this.ctx.db, "DELETE FROM reactions WHERE status IN ('done', 'failed') AND created_at < ?").run(now - REACTIONS_KEEP_MS);
      const b = sql(this.ctx.db, "DELETE FROM deletions WHERE status IN ('sent', 'dropped') AND created_at < ?").run(now - UPDATES_KEEP_MS);
      return { reactions: Number(a.changes), deletions: Number(b.changes) };
    });
    if (r.reactions || r.deletions) this.ctx.journal.write('ui_purged', r);
  }

  /**
   * Агент не на связи (нет аренды), а события ждут дольше agent_offline_notice_minutes — одна строка владельцу; снова —
   * только после того, как агент побывал на связи (метка в meta сбрасывается при аренде).
   */
  checkOffline(now: number): void {
    if (this.adapter.hasLease || this.ctx.config.owner_id === null) return;
    if (getMeta(this.ctx.db, META_KEYS.offlineNotice) === '1') return;
    const row = sql(this.ctx.db, `SELECT count(*) AS n, min(created_at) AS oldest FROM events WHERE status IN ('new', 'delivered', 'transcribing') AND kind IN (${MSG_KINDS_SQL})`)
      .get() as { n: number; oldest: number | null };
    if (!row.n || row.oldest === null) return;
    if (now - row.oldest < this.ctx.config.agent_offline_notice_minutes * 60_000) return;
    transaction(this.ctx.db, () => {
      enqueueServiceLine(this.ctx, offlineNotice(row.n));
      setMeta(this.ctx.db, META_KEYS.offlineNotice, '1');
    });
    this.ctx.journal.write('offline_notice', { waiting: row.n, oldest_ms: now - row.oldest });
    this.sender.kick();
  }
}
