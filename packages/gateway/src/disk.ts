// Диск полон (TECH-SPEC 5.2: ENOSPC, SQLITE_FULL — не падение): одно общее состояние шлюза. Его сообщает любой
// писатель — приём, сокет переходника, тикер сроков, отправитель, старт и остановка; процесс при этом не падает, а
// значит, crash_count висящего обновления не растёт и «3 старта за 60 с» не уводят сообщение в отложенное.
// - Владельцу одна строка (напрямую через API: в базу её не записать) — на эпизод «диск полон».
// - Эпизод кончается настоящим восстановлением: обновление принято (главная транзакция приёма прошла) или пробная
//   запись тикера проходит 10 минут подряд. Удачная мелкая запись посреди эпизода строку не повторяет: при почти полном
//   диске мелкие записи проходят, а крупные — нет, и строка не должна идти каждую минуту.
// - Пока диск полон, отправитель стоит: отправленное, которое не записать, ушло бы снова на каждой попытке.

import { DISK_FULL_NOTICE, isDiskFullError } from 'stg-core';
import type { Ctx } from './context.js';

/** Сколько пробная запись должна проходить подряд, чтобы эпизод «диск полон» кончился без принятого обновления. */
export const DISK_OK_QUIET_MS = 10 * 60_000;

export class DiskState {
  private full = false;
  private notified = false;
  private okSince: number | null = null;
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly ctx: Ctx) {}

  get isFull(): boolean {
    return this.full;
  }

  /** Эпизод «диск полон» ещё не закончен: пробная запись тикера нужна, пока строка не может повториться. */
  get needsProbe(): boolean {
    return this.notified && this.okSince !== null;
  }

  /** Вызвать после восстановления (отправитель снова шлёт). */
  onRecovered(cb: () => void): void {
    this.listeners.push(cb);
  }

  /** Ошибка «диск полон» в месте `where`. true — это она (обработана); false — другая ошибка. */
  check(err: unknown, where: string, extra: Record<string, unknown> = {}): boolean {
    if (!isDiskFullError(err)) return false;
    this.report(err, where, extra);
    return true;
  }

  report(err: unknown, where: string, extra: Record<string, unknown> = {}): void {
    const first = !this.full;
    this.full = true;
    this.okSince = null;
    this.ctx.journal.write('disk_full', { where, error: (err as Error)?.message ?? String(err), first, ...extra });
    // Клиента Telegram ещё нет (старт, токен не прочитан) — строка уйдёт при следующем сбое.
    if (!this.notified && this.notify()) this.notified = true;
  }

  /** Обновление принято: место есть — эпизод кончился. */
  admitted(updateId: number): void {
    if (this.full) this.ctx.journal.write('disk_ok', { update_id: updateId });
    this.notified = false;
    this.okSince = null;
    this.setOk();
  }

  /** Пробная запись тикера прошла. */
  probeOk(now: number): void {
    if (this.full) this.ctx.journal.write('disk_ok', { where: 'probe' });
    this.setOk();
    this.okSince ??= now;
    if (this.notified && now - this.okSince >= DISK_OK_QUIET_MS) this.notified = false;
  }

  private setOk(): void {
    if (!this.full) return;
    this.full = false;
    for (const cb of this.listeners) cb();
  }

  /** Строка «диск полон» — мимо очереди отправки: записать её в базу нельзя. false — слать некому или нечем. */
  private notify(): boolean {
    const api = this.ctx.api;
    const owner = this.ctx.config.owner_id;
    if (!api || owner === null) return false;
    void api.call('sendMessage', { chat_id: owner, text: DISK_FULL_NOTICE }, { timeoutMs: 30_000 }).then(
      () => this.ctx.journal.write('out', { kind: 'service', label: 'gateway', chat_id: owner, text: DISK_FULL_NOTICE, direct: true }),
      (e: unknown) => this.ctx.journal.write('send_failed', { what: 'disk_full_notice', error: api.redact((e as Error).message) }),
    );
    return true;
  }
}
