// Цикл приёма Telegram (TECH-SPEC 5.3; Ш-1, Ш-24). Свой цикл getUpdates: timeout 30 с, allowed_updates явно.
// - Запрос рвётся через 40 с по часам шлюза (как AbortSignal.timeout(40 с)): мёртвое после сна соединение не держит
//   приём 300 с по умолчанию fetch; под поддельными часами срок двигает тест.
// - Следующий getUpdates — только после COMMIT всей пачки: так Telegram узнаёт «получил».
// - 409 (второй опрос, вебхук): цикл не выходит; ждёт 10 + 10·n с, до 5 раз; затем строка владельцу и опрос раз в 60 с
//   без новых строк. 429 — ровно retry_after. 5xx и обрыв — пауза 1…30 с.
// - Последнее обновление старше 7 дней — getUpdates без offset (номера могли начаться заново). Проверяется на каждом
//   опросе, а не только на первом после старта: шлюз мог проработать неделю тишины без перезапуска.
// - После пробуждения (wake) — сначала забрать накопленное (timeout 0), потом проверять сроки. Первый опрос после сна
//   часто падает (сеть ещё не поднялась) — тогда опрос с timeout 0 повторяется, а сроки ждут удачного; но не дольше
//   WAKE_FETCH_LIMIT_MS по часам шлюза или WAKE_FETCH_ATTEMPTS попыток — потом сроки проверяются всё равно.
// - quietSince — с какого времени висит длинный опрос: пачка до него вся записана, а новых обновлений с тех пор нет
//   (иначе Telegram ответил бы сразу). По нему отправитель узнаёт, что приём догнал момент закрепления строки
//   состояния, и находит номер служебного «бот закрепил» (sender.ts).

import { createHash } from 'node:crypto';
import {
  META_KEYS,
  POLL_CONFLICT_NOTICE,
  TelegramApiError,
  TelegramNetworkError,
  WEBHOOK_NOTICE,
  getMeta,
  setMeta,
  transaction,
  type Update,
} from 'stg-core';
import type { Admission } from './admission.js';
import { enqueueServiceLine, type Ctx } from './context.js';
import type { PollState } from './control.js';
import type { Sender } from './sender.js';

/**
 * Виды обновлений, которые просим у Telegram (5.3). message_reaction (0.3.4) — реакции владельца на ответы агента: без
 * явной просьбы Telegram их не присылает (Bot API, getUpdates.allowed_updates: «all update types except chat_member,
 * message_reaction, and message_reaction_count»). В группах — только если бот администратор (Update.message_reaction);
 * реакции ботов (и 👀 👌 самого шлюза) не приходят вовсе.
 */
export const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'message_reaction'] as const;
export const POLL_TIMEOUT_S = 30;
/** Сколько обновлений Telegram отдаёт за раз по умолчанию. */
export const POLL_LIMIT = 100;
export const POLL_ABORT_MS = 40_000;
export const CONFLICT_STEP_MS = 10_000;
export const CONFLICT_STEPS = 5;
export const CONFLICT_SLOW_MS = 60_000;
/** Сколько без 409, чтобы счёт конфликтов начался заново. */
export const CONFLICT_RESET_MS = 5 * 60_000;
export const DISK_RETRY_MS = 60_000;
export const STALE_OFFSET_MS = 7 * 24 * 3600_000;
/** Сколько ждать удачного опроса после сна, прежде чем всё же проверить сроки. */
export const WAKE_FETCH_LIMIT_MS = 2 * 60_000;
export const WAKE_FETCH_ATTEMPTS = 5;

class PollTimeout extends Error {}
class WakeAbort extends Error {}

export class Reception {
  private readonly stopCtl = new AbortController();
  private pollCtl: AbortController | null = null;
  private sleepCtl: AbortController | null = null;
  private running: Promise<void> | null = null;
  private wakeRequested = false;
  private afterWakeCb: (() => void) | null = null;
  /** Когда пришло пробуждение и сколько опросов после него не удалось. */
  private wakeSince: number | null = null;
  private wakeFailures = 0;
  private staleLogged = false;
  private conflicts = 0;
  private lastConflictAt = 0;
  private conflictNotified = false;
  private netBackoff = 1000;
  /** Для «статус»: последний удачный опрос и последний сбой. */
  private lastOkAt: number | null = null;
  private lastErrorAt: number | null = null;
  private lastError: string | null = null;
  /** Длинный опрос висит с этого времени (часы шлюза); null — не висит (приём пачки, пауза, опрос timeout 0). */
  private waitingSince: number | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly admission: Admission,
    private readonly sender: Sender,
  ) {}

  /** Ошибка вне известных путей отдаётся наверх: процесс падает без маркера чистой остановки (5.3). */
  start(onFatal: (err: unknown) => void): void {
    this.running ??= this.loop().catch(onFatal);
  }

  async stop(): Promise<void> {
    this.stopCtl.abort(new Error('остановка'));
    await this.running?.catch(() => undefined);
  }

  get isRunning(): boolean {
    return this.running !== null && !this.stopped;
  }

  /**
   * С какого времени приём «догнал» Telegram: висит длинный опрос, пачка до него записана. null — приём занят, ждёт
   * паузы или опрос короткий.
   */
  quietSince(): number | null {
    return this.waitingSince;
  }

  /** Состояние опроса для «статус» (5.6). */
  pollState(): PollState {
    return { running: this.isRunning, lastOkAt: this.lastOkAt, lastErrorAt: this.lastErrorAt, lastError: this.lastError, conflicts: this.conflicts };
  }

  /**
   * Пробуждение: оборвать возможно мёртвый запрос, забрать накопленное и затем вызвать cb (проверка сроков).
   * false — цикл не идёт (нет токена): cb не будет вызван.
   */
  wake(cb: () => void): boolean {
    if (!this.isRunning) return false;
    this.wakeRequested = true;
    this.afterWakeCb = cb;
    this.wakeSince ??= this.ctx.clock.now();
    this.pollCtl?.abort(new WakeAbort('wake'));
    this.sleepCtl?.abort(new WakeAbort('wake'));
    return true;
  }

  private get stopped(): boolean {
    return this.stopCtl.signal.aborted;
  }

  private async sleep(ms: number): Promise<void> {
    const ctl = new AbortController();
    this.sleepCtl = ctl;
    try {
      await this.ctx.clock.sleep(ms, AbortSignal.any([ctl.signal, this.stopCtl.signal]));
    } catch {
      // остановка или пробуждение — цикл решит сам
    } finally {
      this.sleepCtl = null;
    }
  }

  private offsetForPoll(): number | null {
    const raw = getMeta(this.ctx.db, META_KEYS.offset);
    const last = Number(getMeta(this.ctx.db, META_KEYS.lastUpdateAt) ?? 'NaN');
    if (Number.isFinite(last) && this.ctx.clock.now() - last > STALE_OFFSET_MS) {
      if (!this.staleLogged) this.ctx.journal.write('poll_without_offset', { last_update_at: last, offset: raw });
      this.staleLogged = true;
      return null;
    }
    this.staleLogged = false;
    return raw === null ? null : Number(raw);
  }

  /** Накопленное после сна забрано (или ждать дальше нельзя) — проверить сроки. */
  private afterWake(): void {
    const cb = this.afterWakeCb;
    this.afterWakeCb = null;
    this.wakeSince = null;
    this.wakeFailures = 0;
    cb?.();
  }

  /** Опрос после сна не удался: повторить с timeout 0 или, если ждать дальше нельзя, проверить сроки. */
  private afterWakeFailure(): void {
    this.wakeFailures++;
    const since = this.wakeSince ?? this.ctx.clock.now();
    if (this.wakeFailures >= WAKE_FETCH_ATTEMPTS || this.ctx.clock.now() - since >= WAKE_FETCH_LIMIT_MS) {
      this.ctx.journal.write('wake_fetch_gave_up', { failures: this.wakeFailures, waited_ms: this.ctx.clock.now() - since });
      this.afterWake();
      return;
    }
    this.wakeRequested = true;
  }

  private async loop(): Promise<void> {
    const api = this.ctx.api;
    if (!api) return;
    while (!this.stopped) {
      const wakeFetch = this.wakeRequested;
      this.wakeRequested = false;
      const params: Record<string, unknown> = { timeout: wakeFetch ? 0 : POLL_TIMEOUT_S, allowed_updates: ALLOWED_UPDATES };
      const offset = this.offsetForPoll();
      if (offset !== null) params.offset = offset;
      const ctl = new AbortController();
      this.pollCtl = ctl;
      const timer = this.ctx.clock.setTimeout(() => ctl.abort(new PollTimeout('нет ответа 40 с')), POLL_ABORT_MS);
      let updates: Update[];
      if (!wakeFetch) this.waitingSince = this.ctx.clock.now();
      try {
        updates = await api.call<Update[]>('getUpdates', params, { signal: AbortSignal.any([ctl.signal, this.stopCtl.signal]) });
      } catch (err) {
        if (this.stopped) return;
        const reason: unknown = ctl.signal.aborted ? ctl.signal.reason : null;
        if (reason instanceof WakeAbort) continue;
        if (wakeFetch) this.afterWakeFailure();
        await this.onError(err, reason instanceof PollTimeout);
        continue;
      } finally {
        timer.cancel();
        this.pollCtl = null;
        this.waitingSince = null;
      }
      this.onSuccess();
      if (updates.length) {
        const r = await this.admission.handleBatch(updates, this.ctx.clock.now(), this.stopCtl.signal);
        if (r === 'stopped') return;
        if (r === 'disk_full') {
          if (wakeFetch) this.afterWake();
          // Диск полон: offset не сдвинут — Telegram держит сообщения; пробуем раз в минуту.
          this.ctx.journal.write('disk_full_wait', { retry_ms: DISK_RETRY_MS });
          await this.sleep(DISK_RETRY_MS);
          continue;
        }
      }
      // После сна накопленного может быть больше одной выдачи (100) — забирать, пока не кончится, потом сроки.
      if (wakeFetch) {
        if (updates.length >= POLL_LIMIT) this.wakeRequested = true;
        else this.afterWake();
      }
    }
  }

  private onSuccess(): void {
    this.lastOkAt = this.ctx.clock.now();
    this.netBackoff = 1000;
    if (this.conflicts > 0 && this.ctx.clock.now() - this.lastConflictAt >= CONFLICT_RESET_MS) {
      this.conflicts = 0;
      this.conflictNotified = false;
    }
  }

  private async onError(err: unknown, timedOut: boolean): Promise<void> {
    const { journal } = this.ctx;
    const redact = (s: string): string => this.ctx.api?.redact(s) ?? s;
    this.lastErrorAt = this.ctx.clock.now();
    this.lastError =
      err instanceof TelegramApiError ? `${err.errorCode} ${redact(err.description).slice(0, 80)}` : timedOut ? 'нет ответа 40 с' : 'сеть';
    if (err instanceof TelegramApiError) {
      if (err.errorCode === 409) {
        const webhook = /webhook/i.test(err.description);
        this.conflicts++;
        this.lastConflictAt = this.ctx.clock.now();
        const wait = this.conflicts <= CONFLICT_STEPS ? CONFLICT_STEP_MS * this.conflicts : CONFLICT_SLOW_MS;
        journal.write('poll_conflict', { n: this.conflicts, wait_ms: wait, webhook });
        if (this.conflicts === CONFLICT_STEPS && !this.conflictNotified) {
          this.conflictNotified = true;
          if (webhook) this.notifyWebhook(null);
          else {
            try {
              transaction(this.ctx.db, () => enqueueServiceLine(this.ctx, POLL_CONFLICT_NOTICE));
              journal.write('poll_conflict_notice', { n: this.conflicts });
              this.sender.kick();
            } catch (e) {
              if (!this.ctx.disk.check(e, 'poll_conflict_notice')) throw e;
            }
          }
        }
        await this.sleep(wait);
        return;
      }
      if (err.errorCode === 429) {
        const wait = Math.max(1, err.retryAfter ?? 1) * 1000;
        journal.write('poll_rate_limited', { retry_after_ms: wait });
        await this.sleep(wait);
        return;
      }
      if (err.errorCode === 401 || err.errorCode === 404) {
        journal.write('token_rejected', { code: err.errorCode, error: redact(err.message) });
        await this.sleep(CONFLICT_SLOW_MS);
        return;
      }
    }
    if (timedOut) {
      // Соединение молчит 40 с — переподключиться сразу.
      journal.write('poll_timeout', { after_ms: POLL_ABORT_MS });
      return;
    }
    const wait = this.netBackoff;
    this.netBackoff = Math.min(this.netBackoff * 2, 30_000);
    journal.write('poll_error', {
      error: redact((err as Error).message),
      network: err instanceof TelegramNetworkError,
      retry_ms: wait,
    });
    await this.sleep(wait);
  }

  /** Стоит вебхук — одна строка владельцу на адрес (без повторов при перезапусках). deleteWebhook — только по его слову. */
  notifyWebhook(url: string | null): void {
    const told = getMeta(this.ctx.db, META_KEYS.webhookNotice);
    // url = null — вебхук виден только по 409: адреса нет, сказано ли уже — по любой записи. В базе — отпечаток адреса,
    // не сам адрес: в пути вебхука бывает секрет.
    const mark = url === null ? '409' : createHash('sha256').update(url).digest('hex').slice(0, 16);
    if (told !== null && (url === null || told === mark)) return;
    try {
      transaction(this.ctx.db, () => {
        setMeta(this.ctx.db, META_KEYS.webhookNotice, mark);
        enqueueServiceLine(this.ctx, WEBHOOK_NOTICE);
      });
    } catch (err) {
      if (this.ctx.disk.check(err, 'webhook_notice')) return;
      throw err;
    }
    this.ctx.journal.write('webhook_notice', { host: url === null ? null : safeHost(url) });
    this.sender.kick();
  }

  /** При старте: getWebhookInfo (5.3). */
  async checkWebhook(): Promise<void> {
    const api = this.ctx.api;
    if (!api || this.ctx.config.owner_id === null) return;
    try {
      const info = await api.getWebhookInfo({ timeoutMs: 15_000 });
      if (info.url) {
        this.ctx.journal.write('webhook_found', { host: safeHost(info.url) });
        this.notifyWebhook(info.url);
      } else if (getMeta(this.ctx.db, META_KEYS.webhookNotice) !== null) {
        transaction(this.ctx.db, () => setMeta(this.ctx.db, META_KEYS.webhookNotice, null));
      }
    } catch (err) {
      if (this.ctx.disk.check(err, 'webhook_check')) return;
      this.ctx.journal.write('webhook_check_failed', { error: api.redact((err as Error).message) });
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}
