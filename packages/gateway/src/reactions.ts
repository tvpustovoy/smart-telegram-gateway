// Квитанции реакциями (TECH-SPEC 5.5; Ш-5; J-1). С 0.3.2 — без ✍ при записи, по итогам проверки 0.3 + 0.3.1
// (развилка R-1 б). Порядок на сообщении владельца:
// - 👀 «агент увидел» — событие отдано агенту (delivered от переходника: канал толкнул его в сессию), adapter.ts;
// - 👌 «агент ответил» — reply на событие или done (processed), adapter.ts.
// С 0.3.6 (issue #52; ui.clear_receipts, по умолчанию да) квитанция живёт, пока владелец ждёт ответа:
// - агент ответил на событие (reply или send_file с его seq) — реакция бота снимается (requestAnswered), а не сменяется
//   на 👌: знак ответа — сам ответ в чате. Снимается, когда ответ ушёл в Telegram (sender.ts, отметка sent), не раньше;
//   до того на сообщении 👀;
// - ответ не ушёл («стоп» бросил его, Telegram не принял, копии посылки нет) — 👌, как у done (requestAnswerLost)
//   ⟨предл.⟩: событие закрыто, ответа в чате нет, а 👀 висел бы на нём всегда;
// - событие закрыто без ответа (done) — 👌, как раньше; эти 👌 снимает следующее сообщение владельца в этом чате
//   (requestClosedCleared, admission.ts: любое новое сообщение — текст, голосовое, фото, команда словом; не нажатие, не
//   реакция и не правка ⟨предл.⟩) — все 👌 «закрыто без ответа» бота на его сообщениях здесь, поставленные за неделю
//   (REACTIONS_KEEP_MS) ⟨предл.⟩; старую историю шлюз не обходит, при старте ничего не снимает. 👌 на сообщении, ответ
//   на которое ушёл (так ставили версии до 0.3.6 и ui.clear_receipts: false), — не «закрыто без ответа»: остаётся, иначе
//   первое сообщение после обновления снимало бы разом 👌 почти со всех сообщений недели (находка проверки);
// - снятие — та же строка и та же очередь с повторами: want пуст (REACTION_CLEARED), setMessageReaction с пустым
//   списком; схема та же (v13). В полосе снятия идут после 👀 и 👌 (pick): знак «агент увидел» нового сообщения не ждёт
//   очереди снятий — ждёт не больше одного снятия, которое уже в пути. Текстовой квитанции нет с 0.3.2 (fallback_at,
//   fallback_sent не заполняются): удалять нечего.
// - ход агента идёт (`working`, #55; адаптер Codex): ответ на событие хода может быть промежуточным («Нарисую…»), а
//   агент работает над ним дальше — снятие ждёт конца хода (typing.holds; отправитель не снимает): 👀 держится на
//   сообщении весь ход. Ход больше не держит событие (working off или другой набор, «стоп», снятие аренды, срок хода) —
//   снимается (requestAnsweredAfterTurn, adapter.ts), если ответ ушёл. done — 👌 сразу, как без хода: агент сам сказал,
//   что с сообщением закончил. Конец хода, которого шлюз не увидел (перезапуск шлюза посреди хода), — снятие при старте
//   (requestAnsweredStale): 👀 на обработанном событии с ушедшим ответом без хода не бывает. Канал Claude Code working
//   не шлёт — у него всё как выше;
// ui.clear_receipts: false — как до 0.3.6: reply и send_file с seq ставят 👌 сразу, 👌 остаётся.
// Агент не на связи — на сообщении ничего (видно по ⚪ и 📥 N в закреплённой строке, а через 10 мин — по строке «агент
// не на связи»). Команды и нажатия реакций не получают (сообщение с командой удаляется); закрытая тема — тоже: агенту
// она не уходит.
//
// - Строка таблицы reactions — на сообщение Telegram: важна только последняя реакция (want); запрос, который ещё не
//   ушёл, сливается с новым (👀 не встал, а агент ответил — сразу 👌). Реакция того же события сменяется только более
//   поздней по порядку 👀 → 👌 (REACTION_ORDER): запоздалый 👀 (повторная отдача, обрыв, повтор К-5) не затирает 👌.
// - Правка сообщения — та же строка, событие правки новее. На сообщении стоит реакция (👀 или 👌 к прежнему тексту) —
//   она снимается (want = REACTION_CLEARED, setMessageReaction с пустым списком) ⟨предл.⟩: агент правку ещё не видел;
//   затем 👀 при отдаче правки и 👌. Реакции не было — снимать нечего, строку правка не заводит. Отдача или ответ на
//   старое событие того же сообщения строку не трогает — реакцию держит последнее событие сообщения.
// - ✍ прежней версии (0.3.1): строка, где ✍ ещё ждёт отправки, закрывается без запроса (reaction_retired); стоящий ✍
//   не трогается — его сменят 👀 и 👌 своим ходом, а на обработанном сообщении он так и останется ⟨предл.⟩.
// - Отдельная полоса отправителя: реакции не ждут сообщений и правок (их шаг — 1 в секунду), у них свой шаг в чат
//   (REACTION_SPACING_MS ⟨предл.⟩); 429 — ждать retry_after, и полоса сообщений ждёт тоже (общая пауза чата). Полоса
//   одна и шлёт по одной реакции, поэтому реакции одного сообщения не обгоняют друг друга и в Telegram.
// - Реакция не встала (400, 403, попытки кончились) — только журнал (reaction_failed, final); текстовой квитанции нет
//   ⟨предл.⟩.
// - t_receipt — когда встала первая реакция события (👀 или 👌 вместо него); t_eyes (Ш-16) — тоже, от отдачи агенту.
//   «Записал» (L-2) с 0.3.2 — по записи (t_admit, core/where.ts): видимого ✍ нет.
// - Нужная реакция уже стоит (shown = want; правка, а реакции на сообщении нет) — запроса нет, строка done
//   (reaction_kept) ⟨предл.⟩.
// - Точка сбоя in_send — после ответа Telegram, до отметки: после старта реакция ставится ещё раз (безвредно).

import { MESSAGE_EVENT_KINDS, REACTIONS, REACTION_CLEARED, REACTION_ORDER, TelegramApiError, faultPoint, sql, transaction, type Timer } from 'stg-core';
import type { Ctx } from './context.js';

/** Шаг реакций в один чат ⟨предл.⟩: не чаще 4 в секунду (у сообщений — 1 в секунду). */
export const REACTION_SPACING_MS = 250;
/** Попыток на одну реакцию (обрыв, 5xx); 400 и 403 — без повтора; 429 попыткой не считается. */
export const REACTION_ATTEMPTS = 3;
/** Предел запроса — по настоящему времени (как у отправки). */
const REACTION_TIMEOUT_MS = 10_000;
/**
 * Сколько помнить строки реакций, которые больше не меняются: 👌 после недели — уже не квитанция. Тот же срок — у снятия
 * 👌 следующим сообщением владельца (0.3.6, #52): старше недели строк нет, обходить нечего.
 */
export const REACTIONS_KEEP_MS = 7 * 24 * 3600_000;

const kindsSql = (kinds: readonly string[]): string => kinds.map((k) => `'${k}'`).join(',');
/** Виды событий — сообщения владельца (и других по правилам): 👀 и 👌. */
const MSG_KINDS_SQL = kindsSql(MESSAGE_EVENT_KINDS);

/** Место реакции в порядке (✍) → 👀 → 👌 — выражением SQL (неизвестная и «снять» — 0: её сменит любая). */
function rankSql(col: string): string {
  return `CASE ${col} ${REACTION_ORDER.map((e, i) => `WHEN '${e}' THEN ${i + 1}`).join(' ')} ELSE 0 END`;
}

interface ReactionRow {
  chat_id: number;
  message_id: number;
  event_seq: number;
  want: string;
  shown: string | null;
  status: string;
  attempts: number;
  next_try_at: number | null;
  created_at: number;
  ev_update: number | null;
}

/**
 * Реакция на сообщения событий seqs — в очередь полосы. Строка сообщения заводится по событию (сообщение из Telegram:
 * есть update_id и message_id); у сообщения, которое уже в таблице, она меняется, только если событие новее (правка) или
 * это то же событие, а реакция — позже по порядку 👀 → 👌. Внутри транзакции. Возвращает, сколько реакций поставлено
 * в очередь.
 */
function request(ctx: Ctx, seqs: readonly number[], emoji: string): number {
  if (!seqs.length) return 0;
  const r = sql(ctx.db,
    `INSERT INTO reactions(chat_id, message_id, event_seq, want, shown, status, attempts, next_try_at, created_at, fallback_at, fallback_sent)
     SELECT chat_id, message_id, seq, ?, NULL, 'pending', 0, NULL, ?, NULL, 0 FROM events
     WHERE seq IN (SELECT value FROM json_each(?)) AND message_id IS NOT NULL AND update_id IS NOT NULL AND kind IN (${MSG_KINDS_SQL})
     ORDER BY seq
     ON CONFLICT(chat_id, message_id) DO UPDATE SET event_seq = excluded.event_seq, want = excluded.want, status = 'pending',
       attempts = 0, next_try_at = NULL, created_at = excluded.created_at
     WHERE excluded.event_seq > reactions.event_seq
       OR (excluded.event_seq = reactions.event_seq AND ${rankSql('excluded.want')} > ${rankSql('reactions.want')})`,
  ).run(emoji, ctx.clock.now(), JSON.stringify(seqs));
  return Number(r.changes);
}

/**
 * Правка записана (0.3.2) — реакцию к прежнему тексту снять ⟨предл.⟩: 👀 и 👌 на сообщении относились к старому тексту,
 * а агент правку ещё не видел (до 0.3.2 правку отмечал ✍). Только у сообщения, у которого строка уже есть и событие
 * правки новее; строки нет — на сообщении ничего не стоит, снимать нечего. Внутри транзакции главной записи приёма.
 */
export function requestCleared(ctx: Ctx, seqs: readonly number[]): number {
  let n = 0;
  for (const seq of seqs) {
    const r = sql(ctx.db,
      `UPDATE reactions SET event_seq = e.seq, want = ?, status = 'pending', attempts = 0, next_try_at = NULL, created_at = ?
       FROM (SELECT seq, chat_id, message_id FROM events WHERE seq = ? AND kind = 'edit' AND message_id IS NOT NULL AND update_id IS NOT NULL) e
       WHERE reactions.chat_id = e.chat_id AND reactions.message_id = e.message_id AND e.seq > reactions.event_seq`,
    ).run(REACTION_CLEARED, ctx.clock.now(), seq);
    n += Number(r.changes);
  }
  return n;
}

/**
 * Квитанция снимается, когда своё сделала (0.3.6, issue #52): ui.clear_receipts, по умолчанию да. Без настроек (модульный
 * тест полосы) — да.
 */
export function clearReceipts(ctx: Pick<Ctx, 'config'>): boolean {
  return ctx.config?.ui?.clear_receipts !== false;
}

/**
 * Ответ на события seqs ушёл в Telegram (0.3.6, issue #52) — реакцию бота на их сообщениях снять: знак ответа — сам
 * ответ в чате. Только у обработанного события (reply или send_file с его seq, done раньше) и только если строку
 * сообщения не держит более позднее событие (правка, которую агент ещё не видел, — у неё своя реакция). Строки нет
 * (реакции не было) или реакция уже снята — ничего. Внутри транзакции отметки отправки (sender.ts).
 */
export function requestAnswered(ctx: Ctx, seqs: readonly number[]): number {
  let n = 0;
  for (const seq of seqs) {
    const r = sql(ctx.db,
      `UPDATE reactions SET event_seq = e.seq, want = ?, status = 'pending', attempts = 0, next_try_at = NULL, created_at = ?
       FROM (SELECT seq, chat_id, message_id FROM events
             WHERE seq = ? AND status = 'processed' AND message_id IS NOT NULL AND update_id IS NOT NULL AND kind IN (${MSG_KINDS_SQL})) e
       WHERE reactions.chat_id = e.chat_id AND reactions.message_id = e.message_id AND reactions.event_seq <= e.seq AND reactions.want <> ?`,
    ).run(REACTION_CLEARED, ctx.clock.now(), seq, REACTION_CLEARED);
    n += Number(r.changes);
  }
  return n;
}

/** Ответ агента на событие `e` ушёл в Telegram: строка outbox агента — sent (SQL, событие — под псевдонимом e). */
const ANSWER_SENT_SQL = `EXISTS (SELECT 1 FROM outbox o WHERE o.event_seq = e.seq AND o.origin = 'agent' AND o.status = 'sent')`;

/**
 * Ход агента больше не держит события seqs (#55 × #52: working off, «стоп», снятие аренды, срок хода): ответ на них,
 * ушедший, пока ход шёл, реакцию не снимал (👀 держался ходом) — снять теперь, как снял бы отправитель
 * (requestAnswered). Только у событий, ответ агента на которые ушёл; ответ ещё ждёт отправки — снимет отправитель; done
 * без ответа — 👌 остаётся. Внутри транзакции.
 */
export function requestAnsweredAfterTurn(ctx: Ctx, seqs: readonly number[]): number {
  if (!seqs.length) return 0;
  const sent = (sql(ctx.db, `SELECT seq FROM events e WHERE seq IN (SELECT value FROM json_each(?)) AND ${ANSWER_SENT_SQL}`).all(JSON.stringify(seqs)) as Array<{
    seq: number;
  }>).map((r) => r.seq);
  return requestAnswered(ctx, sent);
}

/**
 * 👀, который держал ход агента, а конца хода шлюз не увидел (#55 × #52): перезапуск шлюза посреди хода (ход — в памяти),
 * снятие, не записанное из-за полного диска. На сообщении — 👀 события, которое обработано, и ответ агента на него ушёл:
 * без хода так не бывает (ответ ушёл — реакция снята в той же записи) — снять. Кроме событий, которые ход держит сейчас
 * (held). Только 👀 и только за REACTIONS_KEEP_MS: 👌 прежних версий на отвеченных сообщениях не трогается. Внутри
 * транзакции.
 */
export function requestAnsweredStale(ctx: Ctx, held: (seq: number) => boolean): number {
  const rows = sql(ctx.db,
    `SELECT r.event_seq AS seq FROM reactions r JOIN events e ON e.seq = r.event_seq
     WHERE r.want = ? AND r.created_at >= ? AND e.status = 'processed' AND ${ANSWER_SENT_SQL}`,
  ).all(REACTIONS.seen, ctx.clock.now() - REACTIONS_KEEP_MS) as Array<{ seq: number }>;
  return requestAnswered(ctx, rows.map((r) => r.seq).filter((s) => !held(s)));
}

/**
 * Ответ на события seqs не ушёл (0.3.6, issue #52): «стоп» бросил его, Telegram не принял, копии посылки нет. Событие
 * обработано, а ответа в чате нет — 👌, как у done ⟨предл.⟩: иначе 👀 «агент увидел» висел бы на нём всегда. Только
 * если ни один ответ агента на это событие не ушёл и на сообщении ещё 👀 этого события (или реакции не было): снятая
 * реакция (ответ уже был, владелец написал дальше) не возвращается. Внутри транзакции.
 */
export function requestAnswerLost(ctx: Ctx, seqs: readonly number[]): number {
  if (!seqs.length) return 0;
  const r = sql(ctx.db,
    `INSERT INTO reactions(chat_id, message_id, event_seq, want, shown, status, attempts, next_try_at, created_at, fallback_at, fallback_sent)
     SELECT chat_id, message_id, seq, ?, NULL, 'pending', 0, NULL, ?, NULL, 0 FROM events e
     WHERE seq IN (SELECT value FROM json_each(?)) AND status = 'processed' AND message_id IS NOT NULL AND update_id IS NOT NULL
       AND kind IN (${MSG_KINDS_SQL})
       AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.event_seq = e.seq AND o.origin = 'agent' AND o.status = 'sent')
     ORDER BY seq
     ON CONFLICT(chat_id, message_id) DO UPDATE SET event_seq = excluded.event_seq, want = excluded.want, status = 'pending',
       attempts = 0, next_try_at = NULL, created_at = excluded.created_at
     WHERE excluded.event_seq > reactions.event_seq OR (excluded.event_seq = reactions.event_seq AND reactions.want = ?)`,
  ).run(REACTIONS.processed, ctx.clock.now(), JSON.stringify(seqs), REACTIONS.seen);
  return Number(r.changes);
}

/**
 * Владелец написал следующее сообщение в этом чате (0.3.6, issue #52): 👌 бота на его сообщениях здесь (событие закрыто
 * без ответа) своё сделали — снять. Только поставленные за REACTIONS_KEEP_MS (неделя ⟨предл.⟩; строки старше и так
 * чистит ticker): старую историю шлюз не обходит. 👀 (агент ещё не ответил) не трогается. 👌 события, ответ агента на
 * которое ушёл (outbox: origin agent, sent), — не «закрыто без ответа»: его поставила версия до 0.3.6 (или
 * ui.clear_receipts: false) вместо снятия; он остаётся как был — без разовой пачки снятий при обновлении (находка
 * проверки). С 0.3.6 у такого события 👌 не бывает: ответ ушёл — реакция снята (requestAnswered), брошенный ответ ставит
 * 👌, только если ни один не ушёл (requestAnswerLost), а done на обработанное не действует. Внутри транзакции записи
 * сообщения (admission.ts).
 */
export function requestClosedCleared(ctx: Ctx, chatId: number, subjectId: string): number {
  const now = ctx.clock.now();
  const r = sql(ctx.db,
    `UPDATE reactions SET want = ?, status = 'pending', attempts = 0, next_try_at = NULL, created_at = ?
     WHERE chat_id = ? AND want = ? AND created_at >= ?
       AND EXISTS (SELECT 1 FROM events e WHERE e.seq = reactions.event_seq AND e.subject_id = ?)
       AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.event_seq = reactions.event_seq AND o.origin = 'agent' AND o.status = 'sent')`,
  ).run(REACTION_CLEARED, now, chatId, REACTIONS.processed, now - REACTIONS_KEEP_MS, subjectId);
  return Number(r.changes);
}

/** 👀 «агент увидел» — событие отдано агенту (delivered). Внутри транзакции. */
export function requestSeen(ctx: Ctx, seqs: readonly number[]): number {
  return request(ctx, seqs, REACTIONS.seen);
}

/**
 * 👌 «агент ответил» — done (и reply или send_file с seq при ui.clear_receipts: false). Только если оно — последнее
 * событие своего сообщения: правка, ещё не обработанная, держит свою реакцию. Внутри транзакции.
 */
export function requestProcessed(ctx: Ctx, seqs: readonly number[]): number {
  return request(ctx, seqs, REACTIONS.processed);
}

class Stopped extends Error {}

function backoffMs(attempts: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempts - 1));
}

export interface ReactionShared {
  /** Пауза чата после 429 (до какого времени, часы шлюза) — общая с полосой сообщений. */
  flood: Map<number, number>;
  signal: AbortSignal;
}

/** Полоса реакций отправителя. */
export class ReactionLane {
  private running = false;
  private again = false;
  private stopped = false;
  private timer: Timer | null = null;
  private current: Promise<void> = Promise.resolve();
  private readonly nextAllowed = new Map<number, number>();

  constructor(
    private readonly ctx: Ctx,
    private readonly shared: ReactionShared,
  ) {}

  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.current = this.run()
      .catch((err: unknown) => {
        if (!(err instanceof Stopped)) this.ctx.journal.write('reaction_error', { error: (err as Error).message });
      })
      .finally(() => {
        this.running = false;
        if (this.again && !this.stopped) {
          this.again = false;
          this.kick();
        }
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    await this.current.catch(() => undefined);
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        if (this.stopped) return;
        this.again = false;
        if (!this.ctx.api || this.ctx.disk.isFull) return;
        const row = this.pick();
        if (!row) return;
        if (this.retireLegacy(row) || this.alreadyShown(row)) continue;
        await this.wait(row.chat_id);
        // Пока ждали шага, строка могла смениться (агент ответил — 👌 вместо 👀): брать свежей.
        const fresh = this.row(row.chat_id, row.message_id);
        if (!fresh || fresh.status !== 'pending' || this.retireLegacy(fresh) || this.alreadyShown(fresh)) continue;
        await this.send(fresh);
      }
    } finally {
      if (!this.stopped) this.scheduleNext();
    }
  }

  private row(chatId: number, messageId: number): ReactionRow | null {
    return (
      (sql(this.ctx.db,
        `SELECT r.*, e.update_id AS ev_update FROM reactions r LEFT JOIN events e ON e.seq = r.event_seq
         WHERE r.chat_id = ? AND r.message_id = ?`,
      ).get(chatId, messageId) as ReactionRow | undefined) ?? null
    );
  }

  /**
   * Ближайшая готовая строка — по порядку постановки; снятия (want пуст) — после 👀 и 👌 (0.3.6, #52, находка проверки):
   * снятия 👌 следующим сообщением владельца и снятия после ответа не задерживают 👀 нового сообщения. Реакции одного
   * сообщения друг друга не обгоняют и так: строка на сообщение одна.
   */
  private pick(): ReactionRow | null {
    return (
      (sql(this.ctx.db,
        `SELECT r.*, e.update_id AS ev_update FROM reactions r LEFT JOIN events e ON e.seq = r.event_seq
         WHERE r.status = 'pending' AND (r.next_try_at IS NULL OR r.next_try_at <= ?)
         ORDER BY (r.want = ?), r.created_at, r.event_seq LIMIT 1`,
      ).get(this.ctx.clock.now(), REACTION_CLEARED) as ReactionRow | undefined) ?? null
    );
  }

  private async wait(chatId: number): Promise<void> {
    const at = Math.max(this.nextAllowed.get(chatId) ?? 0, this.shared.flood.get(chatId) ?? 0);
    const now = this.ctx.clock.now();
    if (at <= now) return;
    try {
      await this.ctx.clock.sleep(at - now, this.shared.signal);
    } catch {
      throw new Stopped('остановка');
    }
  }

  /** Отметка в базе: диск полон — полоса встаёт (повтор — после восстановления, sender.kick). */
  private record(fn: () => void): boolean {
    try {
      transaction(this.ctx.db, fn);
      return true;
    } catch (err) {
      if (this.ctx.disk.check(err, 'reactions')) return false;
      throw err;
    }
  }

  private async send(r: ReactionRow): Promise<void> {
    const api = this.ctx.api;
    if (!api) return;
    const emoji = r.want;
    // «Снять» (правка, 0.3.2) — пустой список: у бота на сообщении реакции нет.
    const reaction = emoji === REACTION_CLEARED ? [] : [{ type: 'emoji', emoji }];
    try {
      await api.call(
        'setMessageReaction',
        { chat_id: r.chat_id, message_id: r.message_id, reaction },
        { signal: this.shared.signal, timeoutMs: REACTION_TIMEOUT_MS },
      );
    } catch (err) {
      if (this.shared.signal.aborted || this.stopped) throw new Stopped('остановка');
      this.failed(r, err);
      return;
    }
    const now = this.ctx.clock.now();
    this.nextAllowed.set(r.chat_id, now + REACTION_SPACING_MS);
    // Точка сбоя: реакция стоит, а не отмечена — после старта ставится ещё раз.
    faultPoint('in_send', r.ev_update);
    const ok = this.record(() => {
      sql(this.ctx.db,
        `UPDATE reactions SET shown = ?, attempts = 0, next_try_at = NULL,
           status = CASE WHEN want = ? THEN 'done' ELSE 'pending' END
         WHERE chat_id = ? AND message_id = ?`,
      ).run(emoji, emoji, r.chat_id, r.message_id);
      this.markLatency(r.event_seq, emoji, now);
      // Пока запрос шёл, строку перевела на себя правка с той же реакцией (👀 в пути — правку уже отдали агенту): реакция правки
      // тоже встала — время и ей.
      const cur = sql(this.ctx.db, 'SELECT event_seq, want FROM reactions WHERE chat_id = ? AND message_id = ?').get(r.chat_id, r.message_id) as
        | { event_seq: number; want: string }
        | undefined;
      if (cur && cur.event_seq !== r.event_seq && cur.want === emoji) this.markLatency(cur.event_seq, emoji, now);
    });
    if (!ok) return;
    this.ctx.journal.write('reaction', {
      seq: r.event_seq,
      label: 'gateway',
      emoji,
      ...(emoji === REACTION_CLEARED ? { cleared: true } : {}),
      chat_id: r.chat_id,
      message_id: r.message_id,
      ...(r.attempts ? { attempts: r.attempts + 1 } : {}),
    });
  }

  /**
   * Первая вставшая реакция события — t_receipt; первая из 👀 и 👌 — t_eyes (Ш-16; ✍ прежней версии — только t_receipt).
   * «Снять» (правка) — не реакция: времени не пишет. Внутри транзакции.
   */
  private markLatency(seq: number, emoji: string, now: number): void {
    if (emoji === REACTION_CLEARED) return;
    sql(this.ctx.db, 'UPDATE latency SET t_receipt = COALESCE(t_receipt, ?) WHERE event_seq = ?').run(now, seq);
    if (emoji !== REACTIONS.recorded) sql(this.ctx.db, 'UPDATE latency SET t_eyes = COALESCE(t_eyes, ?) WHERE event_seq = ?').run(now, seq);
  }

  /**
   * ✍ прежней версии (0.3.1), который ещё ждал отправки (шлюз остановили до запроса), — не ставить (0.3.2, R-1 б: ✍ не ставится):
   * строка done без запроса, в журнал — reaction_retired. 👀 и 👌 того же события сменят её как обычно (у ✍ место в
   * порядке раньше). false — это не ✍.
   */
  private retireLegacy(r: ReactionRow): boolean {
    if (r.want !== REACTIONS.recorded) return false;
    const ok = this.record(() => {
      sql(this.ctx.db, "UPDATE reactions SET status = 'done', attempts = 0, next_try_at = NULL WHERE chat_id = ? AND message_id = ? AND status = 'pending' AND want = ?").run(
        r.chat_id,
        r.message_id,
        REACTIONS.recorded,
      );
    });
    if (ok) this.ctx.journal.write('reaction_retired', { seq: r.event_seq, emoji: r.want, chat_id: r.chat_id, message_id: r.message_id });
    return true;
  }

  /**
   * Нужная реакция уже стоит на сообщении (shown = want; «снять», а реакции нет — тоже). Запроса к Telegram нет ⟨предл.⟩:
   * строка — done, время — событию, которое она держит, в журнал — reaction_kept. false — реакцию надо ставить.
   */
  private alreadyShown(r: ReactionRow): boolean {
    const shown = r.shown ?? REACTION_CLEARED;
    if (shown !== r.want) return false;
    const now = this.ctx.clock.now();
    const ok = this.record(() => {
      sql(this.ctx.db, "UPDATE reactions SET status = 'done', attempts = 0, next_try_at = NULL WHERE chat_id = ? AND message_id = ? AND status = 'pending' AND want = ?").run(
        r.chat_id,
        r.message_id,
        r.want,
      );
      this.markLatency(r.event_seq, r.want, now);
    });
    if (ok) this.ctx.journal.write('reaction_kept', { seq: r.event_seq, emoji: r.want, chat_id: r.chat_id, message_id: r.message_id });
    return true;
  }

  /**
   * Ошибка Telegram: 429 — ждать retry_after (пауза чата; попытка не засчитывается); обрыв и 5xx — повтор; 400, 403 и
   * попытки кончились — отказ: только журнал (текстовой квитанции нет).
   */
  private failed(r: ReactionRow, err: unknown): void {
    const now = this.ctx.clock.now();
    const message = this.ctx.api?.redact((err as Error).message) ?? (err as Error).message;
    if (err instanceof TelegramApiError && err.errorCode === 429) {
      const ra = Math.max(1, err.retryAfter ?? 1) * 1000;
      if (now + ra > (this.shared.flood.get(r.chat_id) ?? 0)) this.shared.flood.set(r.chat_id, now + ra);
      this.ctx.journal.write('reaction_failed', { seq: r.event_seq, emoji: r.want, attempt: r.attempts, final: false, rate_limited: true, retry_after_ms: ra, error: message });
      this.record(() => {
        sql(this.ctx.db, 'UPDATE reactions SET next_try_at = ? WHERE chat_id = ? AND message_id = ?').run(now + ra, r.chat_id, r.message_id);
      });
      return;
    }
    const attempts = r.attempts + 1;
    let retryAt: number | null = null;
    if (err instanceof TelegramApiError) {
      if (err.errorCode >= 500) retryAt = now + backoffMs(attempts);
    } else {
      retryAt = now + backoffMs(attempts);
    }
    const final = retryAt === null || attempts >= REACTION_ATTEMPTS;
    this.ctx.journal.write('reaction_failed', { seq: r.event_seq, emoji: r.want, attempt: attempts, final, error: message });
    // Пока запрос шёл, строка могла смениться (агент увидел или ответил — ждёт 👀 или 👌, попытки сброшены): отказ
    // прежней реакции её не трогает — новая пойдёт своим чередом.
    this.record(() => {
      if (final) {
        sql(this.ctx.db, "UPDATE reactions SET status = 'failed', attempts = ?, next_try_at = NULL WHERE chat_id = ? AND message_id = ? AND want = ?").run(attempts, r.chat_id, r.message_id, r.want);
      } else {
        sql(this.ctx.db, 'UPDATE reactions SET attempts = ?, next_try_at = ? WHERE chat_id = ? AND message_id = ? AND want = ?').run(attempts, retryAt, r.chat_id, r.message_id, r.want);
      }
    });
  }

  /**
   * Таймер: ближайший повтор реакции — только будущие (наступившие цикл уже взял; без клиента Telegram и при полном диске
   * повторы ждут sender.kick).
   */
  private scheduleNext(): void {
    this.timer?.cancel();
    this.timer = null;
    if (!this.ctx.api || this.ctx.disk.isFull) return;
    const now = this.ctx.clock.now();
    let t: number | null;
    try {
      t = (sql(this.ctx.db, "SELECT min(next_try_at) AS t FROM reactions WHERE status = 'pending' AND next_try_at IS NOT NULL AND next_try_at > ?").get(now) as { t: number | null }).t;
    } catch {
      return;
    }
    if (t === null) return;
    this.timer = this.ctx.clock.setTimeout(() => {
      this.timer = null;
      this.kick();
    }, Math.max(0, t - this.ctx.clock.now()));
  }
}
