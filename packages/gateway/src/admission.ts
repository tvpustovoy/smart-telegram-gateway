// Приём одного обновления (TECH-SPEC 5.2 «Приём обновления», 5.3 «Порядок для каждого обновления»; Ш-1…Ш-5, Ш-10,
// Ш-20, Ш-27; Оч-1). Порядок:
//  (повтор) строка updates уже есть со статусом admitted, ignored или deferred — пропустить (дубль — только по
//           таблице updates; номер ниже offset дублем не считается);
//  (0)  кто и где — в памяти; незнакомый → одна транзакция «updates ignored + offset», больше ничего;
//                                                                                      точка after_eyes (имя прежнее:
//       до 0.3.2 здесь, до записи, ставился 👀; теперь 👀 — «агент увидел», после отдачи агенту, reactions.ts)
//  (2)  короткая транзакция: updates in_progress + raw_json;                            точка in_handler
//  (1, 2) закрытая тема, метка доверия, правка, реплай, команда — в памяти;
//  (3)  файлы содержимого (звук) — временный файл → fsync → переименование;            точки before_files, after_files
//  (4)  главная транзакция: событие → updates admitted, raw_json = NULL → квитанция → offset = update_id + 1;
//                                                                                      точка after_commit
//       Квитанции при записи с 0.3.2 нет (развилка R-1 б): на сообщении —
//       👀 и 👌, когда агент увидел и ответил (reactions.ts); правка снимает реакцию к прежнему тексту ⟨предл.⟩.
//       Новое сообщение владельца (0.3.6, issue #52; ui.clear_receipts) снимает 👌 бота на его прежних сообщениях в
//       этом чате (за неделю): событие закрыто, владелец пошёл дальше; нажатие, реакция и правка — нет ⟨предл.⟩.
//       Текстовой квитанции нет ни у чего (P-19): голосовое и звук файлом получают ответом расшифровку, когда она готова
//       (voice.ts); звук файлом больше 20 МБ по метаданным и видео не в mp4 — сразу короткий ответ («слишком большой»,
//       «видео не в mp4»).
//  (5)  реакцию и ответ шлёт отдельный отправитель; (6) голосовое и звук файлом (аудиофайл, с 0.3 — кружок и видео в
//       mp4) распознаются после записи (voice.ts): событие — transcribing, пока распознаётся — на нём ничего; файл
//       скачивается там же, после записи; (7) уведомить переходник. Фото и изображения файлом при приёме не
//       скачиваются: их скачивает media(seq) по первому запросу агента (media.ts, 0.3).
// Реакция владельца на ответ агента (0.3.4; P-31, issue #34) — message_reaction: in_progress (Ш-15: на
// чём шлюз падает трижды — в отложенное, как у сообщения) и одна транзакция без файлов (содержимого, кроме значков,
// нет): событие reaction (new) — только если реакцию поменял
// владелец и только на сообщении бота, которое — ответ агента (messages_out.kind = agent и outbox.origin = agent; тема
// Telegram события — тема ответа);
// остальное (строка шлюза, расшифровка, своё сообщение, чужая реакция) — updates ignored без содержимого и журнал
// reaction_skipped с причиной ⟨предл.⟩. Повтор того же обновления — по updates, как у всех (второго события нет).
// Окно отмены (0.3.4, issue #46; hold.ts): событие записывается сразу, но held до hold_until; новое обновление
// реакции на тот же ответ, пока событие удерживается, меняет его же (итог — последний, «было» — до первого изменения в
// окне, окно — заново от последнего изменения) — само обновление без своего события (ignored, reaction_merged); итог
// совпал с «было» (поставил и снял) — событие cancelled, агенту ничего (reaction_cancelled).
// Окно для материала без слов владельца (0.3.6, issue #51; TECH-SPEC 5.18; material.ts): в главной транзакции сообщение
// владельца получает роль — материал (пересылка, инлайн-бот, текст из одних ссылок, фото, файл, видео без подписи: held
// до его слов или конца окна; слова были раньше в пределах окна — сразу), слова (текст, подпись — не из одних ссылок,
// голосовое, свой кружок или аудиофайл; правка удерживаемого материала, в которой есть слова: отпускают весь
// удерживаемый материал чата и темы), правка удерживаемого материала без слов (ждёт вместе с исходным) или никакую
// (в том числе текст из одних ссылок реплаем на сообщение агента — ответ ему: сразу, словом владельца, окна не трогает).
// После COMMIT — таймер окна. После окна: реплай на материал (в любое время) — reply_to.material («слова к материалу
// № N»); первые слова владельца после материала, ушедшего без слов, в том же чате, теме и эпизоде, не позже
// ui.material_followup_minutes, — linkFollowup («слова после материала № N»); реплай на материал — приоритет, пометки
// «после» у него нет.
// Команда и нажатие (5.6, 5.9) — события handled; их действие (режим, ход, эпизод, строка владельцу) исполняется в той
// же главной транзакции (control.ts): упал после COMMIT — команда уже исполнена, повтор обновления её не повторит.
// После COMMIT — кадр mode переходнику, отдача событий, answerCallbackQuery с текстом отказа (если отказ).
// Диск полон (ENOSPC, SQLITE_FULL) — не падение: crash_count не растёт, offset не двигается, приём пробует раз в минуту
// (общее состояние — disk.ts).
// offset всегда ставится ровно update_id + 1 этого обновления — и у принятого, и у повтора, и у незнакомого (5.2: «не
// максимум из виденных»): после недели тишины Telegram может начать нумерацию с меньшего числа.
// Файл содержимого не записался:
//  - скачивание (сеть, Telegram, файл больше 20 МБ) — событие записывается, file_id остаётся (у обычного голосового —
//    в attachments_json, у закрытой темы — в raw/closed/<№>.json); в журнал — file_failed;
//  - диск полон — как выше: не падение, offset стоит;
//  - иная местная ошибка (EACCES, EIO) у звука — то же, что скачивание; у записи закрытой темы (.json, .txt) — исключение
//    наверх: содержимое закрытой темы больше негде хранить, и обновление идёт путём падений (3 раза — отложено с
//    raw_json, строка владельцу), а не коммитится пустым.

import fs from 'node:fs';
import path from 'node:path';
import {
  sql,
  BOT_API_FILE_LIMIT,
  META_KEYS,
  agentExcerpt,
  audioFileOf,
  ownerReactionLabel,
  ensureDir,
  faultPoint,
  getMeta,
  hasOwnerWords,
  isNotMp4Video,
  labelMessage,
  localDate,
  materialClass,
  parseCommand,
  setMeta,
  transaction,
  writeFileAtomicSync,
  type Attachment,
  type AudioFile,
  type CallbackQuery,
  type ChatRule,
  type CommandName,
  type DeferredRetryResult,
  type EventKind,
  type EventStatus,
  type ForwardInfo,
  type Message,
  type OwnerReaction,
  type SttNote,
  type TrustLabel,
  type Update,
  type User,
  type VoiceInfo,
} from 'stg-core';
import type { AdapterService } from './adapter.js';
import type { Ctx } from './context.js';
import type { Control, Effects } from './control.js';
import type { Directory, Resolved } from './directory.js';
import type { Episodes } from './episodes.js';
import { reactionHoldMs } from './hold.js';
import {
  admitMaterial,
  extendWindow,
  isHeldMaterial,
  isMaterialEvent,
  joinWindow,
  linkFollowup,
  releaseByWords,
  type MaterialDecision,
  type MaterialPlace,
  type WordsRelease,
} from './material.js';

// Набор реакций без учёта порядка: у Premium их несколько, Telegram может вернуть их в другом порядке.
const sameEmoji = (a: readonly string[], b: readonly string[]): boolean => [...a].sort().join(' ') === [...b].sort().join(' ');
import { clearReceipts, requestCleared, requestClosedCleared } from './reactions.js';
import { retryingUpdates } from './recovery.js';
import type { Sender } from './sender.js';
import type { TestHooks } from './testhooks.js';
import { enqueueSttReply } from './voice.js';

export type AdmitResult = 'ok' | 'disk_full' | 'stopped';

const FILE_TIMEOUT_MS = 60_000;

/** Источник файла недоступен (нет клиента Telegram, getFile без пути) — как ошибка скачивания. */
class FileSourceError extends Error {}

/** Файл содержимого: что записать и куда (относительно STG_HOME). */
interface FileJob {
  ref: string;
  source: { voiceFileId: string } | { text: string };
  /** Местная ошибка записи — исключение наверх (путь падений), а не пустое событие: содержимое больше негде хранить. */
  mustWrite: boolean;
}

export interface ReplyTo {
  kind: 'agent' | 'receipt' | 'service' | 'owner' | 'unknown';
  event_seq: number | null;
  excerpt?: string;
  episode_topic?: string | null;
  /** Ответ — на материал без слов владельца (0.3.6, issue #51): «слова к материалу № N». */
  material?: boolean;
}

interface Draft {
  update: Update;
  updateId: number;
  who: Resolved;
  kind: EventKind;
  status: EventStatus;
  chatId: number;
  threadId: number | null;
  messageId: number | null;
  trust: TrustLabel | null;
  mixed: boolean;
  attachments: Attachment[] | null;
  text: string | null;
  forward: ForwardInfo | null;
  replyTo: ReplyTo | null;
  editOf: number | null;
  messageDate: number;
  voice: VoiceInfo | null;
  mediaType: string | null;
  /** Звук файлом (audio.ts): аудиофайл, кружок, видео в mp4 — распознаётся после записи, как голосовое. */
  audio: AudioFile | null;
  /** Почему аудиофайл не распознаётся: длиннее предела · больше 20 МБ. */
  sttNote: SttNote | null;
  /** Эпизод: по сообщению (открыть, если нет; закрыть по тишине) · текущий открытый · никакой. */
  episode: 'message' | 'current' | 'none';
  receipt: boolean;
  command: CommandName | null;
  callback: CallbackQuery | null;
  /** Файл содержимого в событии (raw_ref): относительный путь в STG_HOME; ставится по записанным файлам. */
  rawRef: string | null;
  /** Файлы содержимого по порядку записи; raw_ref — первый записанный из `primary`. */
  files: FileJob[];
  /** Порядок выбора raw_ref среди записанных. */
  primary: string[];
}

export function senderOf(u: Update): { from: User | null; chat: Message['chat'] | null } {
  const msg = u.message ?? u.edited_message;
  if (msg) return { from: msg.from ?? null, chat: msg.chat };
  if (u.callback_query) return { from: u.callback_query.from, chat: u.callback_query.message?.chat ?? null };
  // Реакция (0.3.4): кто поменял — user; анонимный администратор группы (actor_chat) — незнакомый.
  if (u.message_reaction) return { from: u.message_reaction.user ?? null, chat: u.message_reaction.chat };
  return { from: null, chat: null };
}

/**
 * Что стало с реакцией владельца в окне отмены (0.3.4, issue #46): new — новое событие (held или сразу new); merged —
 * изменила удерживаемое событие того же ответа; cancelled — итог в окне совпал с «было», событие отменено.
 */
type ReactionOutcome =
  | { kind: 'new'; seq: number; held: boolean }
  | { kind: 'merged'; seq: number; emoji: string[]; old: string[] }
  | { kind: 'cancelled'; seq: number; emoji: string[]; old: string[]; heldMs: number };

/** Почему реакция не стала событием (журнал reaction_skipped) ⟨предл.⟩. */
export type ReactionSkip = 'not_owner' | 'own_message' | 'unknown_message' | 'transcript' | 'gateway_line' | 'no_change';

/** Что за сообщение бота: к какой строке outbox и событию, чьё (messages_out + outbox). */
interface BotMessage {
  kind: 'agent' | 'receipt' | 'service';
  outbox_id: number | null;
  event_seq: number | null;
  origin: 'gateway' | 'agent' | null;
  text: string | null;
  /** Тема Telegram, в которую ушёл ответ (outbox.thread_id): туда же — ответ агента на реакцию. */
  thread_id: number | null;
}

export function fullName(u: User): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

export class Admission {
  constructor(
    private readonly ctx: Ctx,
    private readonly episodes: Episodes,
    private readonly sender: Sender,
    private readonly adapter: AdapterService,
    private readonly hooks: TestHooks,
    private readonly control: Control,
    /** Распознаватель голосовых (5.8): после записи голосового — его очередь. */
    private readonly transcriber: { kick(): void } | null = null,
    /**
     * Окна удержания (hold.ts): окно отмены реакции (0.3.4) — после записи и склейки, окно материала без слов владельца
     * (0.3.6) — после записи материала, — таймер на ближайший срок.
     */
    private readonly hold: { schedule(): void } | null = null,
  ) {}

  private updateStatus(id: number): string | null {
    const r = sql(this.ctx.db, 'SELECT status FROM updates WHERE update_id = ?').get(id) as { status: string } | undefined;
    return r?.status ?? null;
  }

  /** Пачка от одного getUpdates: приём строго по порядку (кто и где — по правилам на момент разбора пачки). */
  async handleBatch(updates: Update[], tUpdate: number, signal: AbortSignal): Promise<AdmitResult> {
    const plan = updates.map((u) => {
      const status = this.updateStatus(u.update_id);
      const repeat = status === 'admitted' || status === 'ignored' || status === 'deferred' ? status : null;
      const { from, chat } = senderOf(u);
      const dir = this.ctx.directory;
      const who = repeat ? null : dir.resolve(from?.id, chat);
      return { u, repeat, who, dir, inProgress: status === 'in_progress' };
    });
    for (const p of plan) {
      if (signal.aborted) return 'stopped';
      const r = await this.handleOne(p.u, p.repeat, p.who, p.inProgress, tUpdate, signal, false, p.dir);
      if (r !== 'ok') return r;
    }
    return 'ok';
  }

  /**
   * Повтор отложенного (5.3, `stg deferred retry <update_id>` ⟨предл. принято в M3⟩): то же обновление тем же путём
   * приёма, offset не трогается. Строка снова in_progress с содержимым: упадёт шлюз на нём снова —
   * crash_count уже не меньше трёх, и при следующем старте обновление сразу вернётся в отложенное со строкой владельцу.
   * Отправитель теперь не из правил — ignored (Ш-3).
   */
  async retryDeferred(
    updateId: number,
  ): Promise<{ ok: true; result: DeferredRetryResult } | { ok: false; code: 'unknown_seq' | 'bad_request' | 'unavailable'; text: string }> {
    const row = sql(this.ctx.db, 'SELECT status, raw_json FROM updates WHERE update_id = ?').get(updateId) as { status: string; raw_json: string | null } | undefined;
    if (!row) return { ok: false, code: 'unknown_seq', text: `обновления ${updateId} нет (stg deferred list)` };
    if (row.status !== 'deferred') return { ok: false, code: 'bad_request', text: `обновление ${updateId} не отложено (${row.status})` };
    let u: Update;
    try {
      u = JSON.parse(row.raw_json ?? '') as Update;
      if (!u || typeof u !== 'object' || u.update_id !== updateId) throw new Error('не то обновление');
    } catch (err) {
      return { ok: false, code: 'bad_request', text: `содержимое обновления ${updateId} не разобралось: ${(err as Error).message}` };
    }
    const setRetrying = (on: boolean): void => {
      const list = retryingUpdates(this.ctx).filter((x) => x !== updateId);
      if (on) list.push(updateId);
      setMeta(this.ctx.db, META_KEYS.retrying, list.length ? JSON.stringify(list) : null);
    };
    try {
      transaction(this.ctx.db, () => {
        sql(this.ctx.db, "UPDATE updates SET status = 'in_progress' WHERE update_id = ? AND status = 'deferred'").run(updateId);
        setRetrying(true);
      });
    } catch (err) {
      if (this.ctx.disk.check(err, 'deferred_retry', { update_id: updateId })) return { ok: false, code: 'unavailable', text: 'диск полон — повтори позже' };
      throw err;
    }
    this.ctx.journal.write('deferred_retry', { update_id: updateId });
    const { from, chat } = senderOf(u);
    const who = this.ctx.directory.resolve(from?.id, chat);
    const r = await this.handleOne(u, null, who, true, this.ctx.clock.now(), new AbortController().signal, true, this.ctx.directory);
    if (r !== 'ok') {
      // Диск полон: вернуть в отложенное (не вышло — строка in_progress через сутки уйдёт туда сама).
      try {
        transaction(this.ctx.db, () => {
          sql(this.ctx.db, "UPDATE updates SET status = 'deferred' WHERE update_id = ? AND status = 'in_progress'").run(updateId);
          setRetrying(false);
        });
      } catch (err) {
        if (!this.ctx.disk.check(err, 'deferred_retry', { update_id: updateId })) throw err;
      }
      return { ok: false, code: 'unavailable', text: 'диск полон — повтори позже' };
    }
    try {
      transaction(this.ctx.db, () => setRetrying(false));
    } catch (err) {
      if (!this.ctx.disk.check(err, 'deferred_retry', { update_id: updateId })) throw err;
    }
    const after = sql(this.ctx.db, 'SELECT status FROM updates WHERE update_id = ?').get(updateId) as { status: string } | undefined;
    const ev = sql(this.ctx.db, 'SELECT seq FROM events WHERE update_id = ? ORDER BY seq LIMIT 1').get(updateId) as { seq: number } | undefined;
    const status = after?.status === 'admitted' ? 'admitted' : 'ignored';
    this.ctx.journal.write('deferred_retried', { update_id: updateId, status, seq: ev?.seq ?? null });
    return { ok: true, result: { update_id: updateId, status, seq: ev?.seq ?? null } };
  }

  private async handleOne(
    u: Update,
    repeat: string | null,
    who: Resolved | null,
    inProgress: boolean,
    tUpdate: number,
    signal: AbortSignal,
    retry = false,
    resolvedBy: Directory | null = null,
  ): Promise<AdmitResult> {
    const id = u.update_id;
    if (repeat) return this.onRepeat(u, repeat);
    // Правила сменились после того, как пачку разобрали (нажатие [разрешить] выше в той же пачке, сужение от агента) —
    // кто и где решается по нынешней рабочей копии (AD-9).
    if (resolvedBy && resolvedBy !== this.ctx.directory) {
      who = this.resolveNow(u);
      resolvedBy = this.ctx.directory;
    }
    if (!who) return this.ignore(u, inProgress, retry);
    if (u.message_reaction) return this.handleReaction(u, who, retry);

    faultPoint('after_eyes', id);

    try {
      this.markInProgress(u);
    } catch (err) {
      if (this.ctx.disk.check(err, 'admission', { update_id: id, step: 'in_progress' })) return 'disk_full';
      throw err;
    }
    faultPoint('in_handler', id);

    const draft = this.build(u, who);

    faultPoint('before_files', id);
    const files = await this.writeFiles(draft, signal);
    if (files === 'stopped' || files === 'disk_full') return files;
    faultPoint('after_files', id);
    // Сужение применяется сразу (5.9): пока шло скачивание, отправителя могли убрать из правил — тогда он
    // незнакомый: ignored, raw_json стёрт, файлы удалены (Ш-3).
    if (resolvedBy && resolvedBy !== this.ctx.directory) {
      const again = this.resolveNow(u);
      if (!again) {
        this.dropFiles(draft);
        this.ctx.journal.write('update_narrowed', { update_id: id });
        return this.ignore(u, true, retry);
      }
      draft.who = again;
    }

    let seq: number;
    let effects: Effects;
    let material: MaterialOutcome;
    let receiptsCleared: number;
    try {
      ({ seq, effects, material, receiptsCleared } = this.commit(draft, tUpdate, retry));
    } catch (err) {
      if (this.ctx.disk.check(err, 'admission', { update_id: id, step: 'commit' })) return 'disk_full';
      throw err;
    }
    faultPoint('after_commit', id);
    this.ctx.disk.admitted(id);
    this.afterCommit(draft, seq, effects, material, receiptsCleared);
    return 'ok';
  }

  private resolveNow(u: Update): Resolved | null {
    const { from, chat } = senderOf(u);
    return this.ctx.directory.resolve(from?.id, chat);
  }

  /** Файлы содержимого обновления, которое так и не стало событием. */
  private dropFiles(d: Draft): void {
    for (const job of d.files) {
      try {
        fs.rmSync(path.join(this.ctx.paths.home, job.ref), { force: true });
      } catch {
        // не удалился — файл без ссылки из базы уберёт чистка (5.8)
      }
    }
  }

  /** Повтор от Telegram: второго события нет (Ш-2, Оч-1). offset = update_id + 1 этого обновления (5.2). */
  private onRepeat(u: Update, status: string): AdmitResult {
    try {
      transaction(this.ctx.db, () => {
        setMeta(this.ctx.db, META_KEYS.offset, String(u.update_id + 1));
        setMeta(this.ctx.db, META_KEYS.lastUpdateAt, String(this.ctx.clock.now()));
      });
    } catch (err) {
      if (this.ctx.disk.check(err, 'admission', { update_id: u.update_id, step: 'repeat' })) return 'disk_full';
      throw err;
    }
    if (status === 'ignored') this.ctx.journal.write('update_ignored', { update_id: u.update_id, repeat: true });
    else this.ctx.journal.write('update_repeat', { update_id: u.update_id, status });
    return 'ok';
  }

  /**
   * Незнакомый (или первая настройка): updates ignored без raw_json и offset — одной транзакцией; в журнал — счётчик.
   * Строка in_progress того же номера (отправитель был в правилах, когда обновление пришло, а после перезапуска — нет)
   * тоже становится ignored, raw_json стирается: действуют нынешние правила (Ш-3), висеть «в работе» ей незачем.
   */
  private ignore(u: Update, wasInProgress: boolean, retry = false): AdmitResult {
    const now = this.ctx.clock.now();
    const firstSetup = this.ctx.directory.firstSetup;
    const { from, chat } = senderOf(u);
    let count = 0;
    try {
      count = transaction(this.ctx.db, () => {
        sql(this.ctx.db,
          `INSERT INTO updates(update_id, received_at, status) VALUES (?, ?, 'ignored')
           ON CONFLICT(update_id) DO UPDATE SET status = 'ignored', raw_json = NULL WHERE updates.status = 'in_progress'`,
        ).run(u.update_id, now);
        // Повтор отложенного (stg deferred retry): offset этого обновления давно позади — не трогать.
        if (!retry) {
          setMeta(this.ctx.db, META_KEYS.offset, String(u.update_id + 1));
          setMeta(this.ctx.db, META_KEYS.lastUpdateAt, String(now));
        }
        const n = Number(getMeta(this.ctx.db, META_KEYS.ignoredCount) ?? '0') + 1;
        setMeta(this.ctx.db, META_KEYS.ignoredCount, String(n));
        // Последний написавший — только в первой настройке: stg doctor предложит его номер.
        if (firstSetup) {
          setMeta(
            this.ctx.db,
            META_KEYS.lastUnknownFrom,
            JSON.stringify({ id: from?.id ?? null, name: from ? fullName(from) : null, username: from?.username ?? null, chat_type: chat?.type ?? null, at: now }),
          );
        }
        return n;
      });
    } catch (err) {
      if (this.ctx.disk.check(err, 'admission', { update_id: u.update_id, step: 'ignore' })) return 'disk_full';
      throw err;
    }
    this.ctx.journal.write('update_ignored', {
      update_id: u.update_id,
      reason: firstSetup ? 'first_setup' : 'unknown',
      repeat: false,
      count,
      ...(wasInProgress ? { was_in_progress: true } : {}),
    });
    return 'ok';
  }

  /**
   * Реакция (0.3.4): in_progress (как у сообщения: падение на ней считается, третье — в отложенное, Ш-15), затем одна
   * транзакция — событие reaction или ничего, updates, offset. Файлов нет (только значки): упал до COMMIT — Telegram
   * отдаст обновление снова.
   * Событие — только реакция владельца на ответ агента: текст, голосовое или документ посылки (send_file, 0.3.3 —
   * messages_out agent, outbox origin agent; начало ответа — «файл <посылка>/<файл>: <подпись>»). Тема Telegram — тема
   * ответа (outbox.thread_id): ответ агента на реакцию уходит туда же, а не в основной поток (по проверке 0.3.4).
   * Эпизод — открытый в этом чате, если он в той же теме; иначе — эпизод события, на которое был ответ; нет его —
   * открытый ⟨предл.⟩. Реакция эпизод не открывает и не продлевает (не сообщение). Агенту — по порядку, как прочие; в
   * «стоп» — ждёт, в паузе — отдаётся. 👀 и 👌 на реакции нет (не сообщение владельца); «ждут агента» её не считают.
   * Окно отмены (0.3.4, issue #46): reactions.hold_seconds > 0 — событие held до hold_until = сейчас + окно (отпускает
   * hold.ts). Пока событие на этот ответ удерживается, новое обновление реакции на него — не новое событие, а
   * то же: emoji — последние, old — что стояло до первого изменения в окне, окно — заново от этого изменения ⟨предл.⟩;
   * итог совпал с old — событие cancelled (агенту ничего). Само такое обновление — ignored (своего события у него нет:
   * у admitted ровно одно событие, П-1), журнал reaction_merged или reaction_cancelled. Отданное (окно прошло) — новое
   * событие, как без окна.
   */
  private handleReaction(u: Update, who: Resolved, retry: boolean): AdmitResult {
    const { db } = this.ctx;
    const mr = u.message_reaction!;
    const now = this.ctx.clock.now();
    const chatId = mr.chat.id;
    try {
      this.markInProgress(u);
    } catch (err) {
      if (this.ctx.disk.check(err, 'admission', { update_id: u.update_id, step: 'in_progress' })) return 'disk_full';
      throw err;
    }
    // Между in_progress и COMMIT — та же точка, что у сообщения (Ш-15: падение на реакции считается; по проверке 0.3.4).
    faultPoint('in_handler', u.update_id);
    const emoji = mr.new_reaction.map(ownerReactionLabel);
    const old = mr.old_reaction.map(ownerReactionLabel);
    let skip: ReactionSkip | null = null;
    let bot: BotMessage | null = null;
    if (!who.isOwner) skip = 'not_owner';
    else {
      bot =
        (sql(db,
          `SELECT m.kind, m.outbox_id, COALESCE(o.event_seq, m.event_seq) AS event_seq, o.origin, o.text, o.thread_id
           FROM messages_out m LEFT JOIN outbox o ON o.id = m.outbox_id WHERE m.chat_id = ? AND m.tg_message_id = ?`,
        ).get(chatId, mr.message_id) as BotMessage | undefined) ?? null;
      if (!bot) {
        // Не сообщение бота: своё сообщение владельца (на нём 👀 и 👌 шлюза — их Telegram боту не присылает, а реакция
        // самого владельца на своё — не отклик агенту) или старое, до шлюза.
        const own = sql(db, 'SELECT 1 FROM events WHERE chat_id = ? AND message_id = ? AND update_id IS NOT NULL LIMIT 1').get(chatId, mr.message_id);
        skip = own ? 'own_message' : 'unknown_message';
      } else if (bot.kind === 'receipt') skip = 'transcript';
      else if (bot.kind !== 'agent' || bot.origin !== 'agent') skip = 'gateway_line';
      else if (sameEmoji(emoji, old)) skip = 'no_change';
    }
    const holdMs = reactionHoldMs(this.ctx);
    let outcome: ReactionOutcome | null = null;
    try {
      outcome = transaction(db, (): ReactionOutcome | null => {
        let o: ReactionOutcome | null = null;
        if (!skip && bot) {
          // Окно отмены: на этот ответ уже есть удерживаемое событие — менять его, а не заводить новое.
          // Ищем всегда, и при окне 0: удерживаемое от прежнего запуска (окно было больше) склеивается, а не обгоняется.
          const held = this.heldReaction(chatId, mr.message_id);
          if (held) {
            const prev = JSON.parse(held.reaction_json) as OwnerReaction;
            const was = prev.old ?? [];
            const merged: OwnerReaction = { ...prev, emoji };
            if (sameEmoji(emoji, was)) {
              // Поставил и снял (или вернул прежнюю) — агенту ничего.
              sql(db, "UPDATE events SET status = 'cancelled', reaction_json = ? WHERE seq = ? AND status = 'held'").run(JSON.stringify(merged), held.seq);
              o = { kind: 'cancelled', seq: held.seq, emoji, old: was, heldMs: now - held.created_at };
            } else {
              sql(db, "UPDATE events SET reaction_json = ?, hold_until = ?, message_date = ? WHERE seq = ? AND status = 'held'").run(
                JSON.stringify(merged),
                now + holdMs,
                mr.date * 1000,
                held.seq,
              );
              o = { kind: 'merged', seq: held.seq, emoji, old: was };
            }
          } else {
            const toSeq = bot.event_seq;
            const reaction: OwnerReaction = {
              message_id: mr.message_id,
              outbox_id: bot.outbox_id,
              to_seq: toSeq,
              emoji,
              old,
              excerpt: agentExcerpt(this.agentAnswerText(bot.outbox_id, bot.text)),
            };
            const threadId = bot.thread_id ?? null;
            const open = this.episodes.openFor(chatId, who.subject.id);
            const answered =
              toSeq !== null ? ((sql(db, 'SELECT episode_id FROM events WHERE seq = ?').get(toSeq) as { episode_id: number | null } | undefined)?.episode_id ?? null) : null;
            const episodeId = open && (open.thread_id ?? null) === threadId ? open.id : (answered ?? open?.id ?? null);
            const r = sql(db,
              `INSERT INTO events(update_id, message_id, chat_id, thread_id, subject_id, trust, mixed, kind, episode_id, status, created_at, message_date, reaction_json, hold_until)
               VALUES (?, NULL, ?, ?, ?, 'owner', 0, 'reaction', ?, ?, ?, ?, ?, ?)`,
            ).run(
              u.update_id,
              chatId,
              threadId,
              who.subject.id,
              episodeId,
              holdMs > 0 ? 'held' : 'new',
              now,
              mr.date * 1000,
              JSON.stringify(reaction),
              holdMs > 0 ? now + holdMs : null,
            );
            o = { kind: 'new', seq: Number(r.lastInsertRowid), held: holdMs > 0 };
          }
        }
        // Без своего события (пропущена, склеена с удерживаемой, отменила её) — ignored без содержимого (у admitted ровно
        // одно событие, П-1); счётчик незнакомых не растёт.
        sql(db,
          `INSERT INTO updates(update_id, received_at, status) VALUES (?, ?, ?)
           ON CONFLICT(update_id) DO UPDATE SET status = excluded.status, raw_json = NULL`,
        ).run(u.update_id, now, o?.kind === 'new' ? 'admitted' : 'ignored');
        if (!retry) {
          setMeta(db, META_KEYS.offset, String(u.update_id + 1));
          setMeta(db, META_KEYS.lastUpdateAt, String(now));
        }
        return o;
      });
    } catch (err) {
      if (this.ctx.disk.check(err, 'admission', { update_id: u.update_id, step: 'reaction' })) return 'disk_full';
      throw err;
    }
    this.ctx.disk.admitted(u.update_id);
    if (outcome?.kind === 'new') {
      const seq = outcome.seq;
      this.ctx.journal.write('in', {
        seq,
        update_id: u.update_id,
        kind: 'reaction',
        label: 'owner',
        emoji,
        old,
        message_id: mr.message_id,
        outbox_id: bot?.outbox_id ?? null,
        to_seq: bot?.event_seq ?? null,
        ...(bot?.thread_id ? { thread_id: bot.thread_id } : {}),
        ...(outcome.held ? { hold_ms: holdMs } : {}),
      });
      if (outcome.held) this.hold?.schedule();
      else this.adapter.pump();
    } else if (outcome?.kind === 'merged') {
      this.ctx.journal.write('reaction_merged', { update_id: u.update_id, seq: outcome.seq, emoji: outcome.emoji, old: outcome.old, message_id: mr.message_id, hold_ms: holdMs });
      this.hold?.schedule();
    } else if (outcome?.kind === 'cancelled') {
      this.ctx.journal.write('reaction_cancelled', {
        update_id: u.update_id,
        seq: outcome.seq,
        reason: 'same_as_before',
        emoji: outcome.emoji,
        old: outcome.old,
        message_id: mr.message_id,
        held_ms: outcome.heldMs,
      });
      this.hold?.schedule();
    } else {
      this.ctx.journal.write('reaction_skipped', {
        update_id: u.update_id,
        reason: skip,
        chat_id: chatId,
        message_id: mr.message_id,
        emoji,
        old,
        ...(bot ? { target: bot.kind, outbox_id: bot.outbox_id } : {}),
      });
    }
    return 'ok';
  }

  /**
   * Удерживаемое окном событие реакции на это сообщение бота (0.3.4, issue #46): одно на ответ — склейка меняет его,
   * а не заводит второе.
   */
  private heldReaction(chatId: number, messageId: number): { seq: number; reaction_json: string; created_at: number } | null {
    return (
      (sql(this.ctx.db,
        `SELECT seq, reaction_json, created_at FROM events
         WHERE kind = 'reaction' AND status = 'held' AND chat_id = ? AND json_extract(reaction_json, '$.message_id') = ?
         ORDER BY seq DESC LIMIT 1`,
      ).get(chatId, messageId) as { seq: number; reaction_json: string; created_at: number } | undefined) ?? null
    );
  }

  private markInProgress(u: Update): void {
    transaction(this.ctx.db, () => {
      sql(this.ctx.db,
          `INSERT INTO updates(update_id, received_at, status, raw_json) VALUES (?, ?, 'in_progress', ?)
           ON CONFLICT(update_id) DO UPDATE SET raw_json = excluded.raw_json WHERE updates.status = 'in_progress'`,
        )
        .run(u.update_id, this.ctx.clock.now(), JSON.stringify(u));
    });
  }

  private isClosedTopic(msg: Message, text: string | null): boolean {
    const { closed_topics, closed_marker } = this.ctx.config;
    if (msg.message_thread_id !== undefined && closed_topics.includes(msg.message_thread_id)) return true;
    if (closed_marker && text) {
      const esc = closed_marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'iu').test(text)) return true;
    }
    return false;
  }

  /**
   * Реплай владельца в этом же чате (5.5а): на сообщение бота — по messages_out, на своё — по events. Своё — материал без
   * слов владельца (0.3.6, issue #51; material.ts, isMaterialEvent) — material: true: агент видит «слова к материалу № N».
   */
  lookupReplyTo(chatId: number, messageId: number): ReplyTo {
    const db = this.ctx.db;
    const topicOf = (seq: number | null): string | null => {
      if (seq === null) return null;
      const r = sql(db, 'SELECT ep.topic AS topic FROM events e JOIN episodes ep ON ep.id = e.episode_id WHERE e.seq = ?').get(seq) as
        | { topic: string }
        | undefined;
      return r?.topic ?? null;
    };
    const mo = sql(db, 'SELECT kind, outbox_id, event_seq FROM messages_out WHERE chat_id = ? AND tg_message_id = ?').get(chatId, messageId) as
      | { kind: 'agent' | 'receipt' | 'service'; outbox_id: number | null; event_seq: number | null }
      | undefined;
    if (mo) {
      if (mo.kind === 'agent') {
        const o = mo.outbox_id !== null ? (sql(db, 'SELECT text FROM outbox WHERE id = ?').get(mo.outbox_id) as { text: string | null } | undefined) : undefined;
        // Начало ответа агента — с меткой «слова агента» (5.4); текст квитанций не вкладывается.
        return { kind: 'agent', event_seq: mo.event_seq, excerpt: agentExcerpt(this.agentAnswerText(mo.outbox_id, o?.text ?? null)), episode_topic: topicOf(mo.event_seq) };
      }
      return { kind: mo.kind, event_seq: mo.event_seq, episode_topic: topicOf(mo.event_seq) };
    }
    const ev = sql(db, 
        `SELECT seq FROM events WHERE chat_id = ? AND message_id = ? AND update_id IS NOT NULL
         AND kind NOT IN ('callback', 'edit') ORDER BY seq LIMIT 1`,
      )
      .get(chatId, messageId) as { seq: number } | undefined;
    if (ev) return { kind: 'owner', event_seq: ev.seq, episode_topic: topicOf(ev.seq), ...(isMaterialEvent(this.ctx, ev.seq) ? { material: true } : {}) };
    // Старое сообщение, до шлюза: текст из Telegram не вкладывается.
    return { kind: 'unknown', event_seq: null };
  }

  /**
   * Текст ответа агента для реплая и реакции владельца на него: у посылки (0.3.3) — «файл <посылка>/<файл>: <подпись>»
   * (агенту видно, на какой файл ответил или отреагировал владелец ⟨предл.⟩; реакция — при сведении 0.3.4 в main поверх
   * 0.3.3), у прочих — текст строки outbox.
   */
  private agentAnswerText(outboxId: number | null, text: string | null): string {
    const d =
      outboxId !== null
        ? (sql(this.ctx.db, 'SELECT parcel, file FROM deliveries WHERE outbox_id = ? LIMIT 1').get(outboxId) as { parcel: string; file: string } | undefined)
        : undefined;
    return d ? `файл ${d.parcel}/${d.file}${text?.trim() ? `: ${text}` : ''}` : (text ?? '');
  }

  private originalOf(chatId: number, messageId: number): number | null {
    const r = sql(this.ctx.db, 
        `SELECT seq FROM events WHERE chat_id = ? AND message_id = ? AND update_id IS NOT NULL
         AND kind NOT IN ('edit', 'callback') ORDER BY seq LIMIT 1`,
      )
      .get(chatId, messageId) as { seq: number } | undefined;
    return r?.seq ?? null;
  }

  private rawPath(closed: boolean, ext: string, updateId: number): string {
    const day = localDate(this.ctx.clock.now(), this.ctx.config.timezone);
    return path.posix.join('raw', ...(closed ? ['closed'] : []), day, `${updateId}.${ext}`);
  }

  private build(u: Update, who: Resolved): Draft {
    const base = { update: u, updateId: u.update_id, who };
    if (u.callback_query) {
      const cq = u.callback_query;
      const m = cq.message;
      return {
        ...base,
        kind: 'callback',
        status: 'handled',
        chatId: m?.chat.id ?? cq.from.id,
        threadId: null,
        messageId: m?.message_id ?? null,
        trust: who.isOwner ? 'owner' : 'untrusted',
        mixed: false,
        attachments: null,
        text: cq.data ?? null,
        forward: null,
        replyTo: null,
        editOf: null,
        messageDate: this.ctx.clock.now(),
        voice: null,
        mediaType: null,
        audio: null,
        sttNote: null,
        episode: 'none',
        receipt: false,
        command: null,
        callback: cq,
        rawRef: null,
        files: [],
        primary: [],
      };
    }
    const msg = (u.message ?? u.edited_message)!;
    const isEdit = !u.message && !!u.edited_message;
    const labeled = labelMessage(msg, { ownerId: this.ctx.directory.ownerId, fromOwner: who.isOwner });
    const threadId = msg.is_topic_message && msg.message_thread_id !== undefined ? msg.message_thread_id : null;
    const messageDate = ((isEdit ? msg.edit_date : undefined) ?? msg.date) * 1000;
    const common = {
      ...base,
      chatId: msg.chat.id,
      threadId,
      messageId: msg.message_id,
      messageDate,
      voice: labeled.voice,
      mediaType: labeled.mediaType,
      audio: null as AudioFile | null,
      sttNote: null as SttNote | null,
      callback: null,
    };
    if (this.isClosedTopic(msg, labeled.text)) {
      // Закрытая тема (Ш-11): мимо агента и распознавания; в базе и журнале содержимого нет — оно в raw/closed/:
      // само сообщение <№>.json (текст, подпись, file_id звука, фото и файлов — по ним можно докачать), текст и подпись —
      // <№>.txt, звук — <№>.oga. Фото и файлы не скачиваются — как и вне закрытой темы: ссылка на них — в .json.
      const voice = labeled.voice;
      const json = this.rawPath(true, 'json', u.update_id);
      const txt = this.rawPath(true, 'txt', u.update_id);
      const oga = this.rawPath(true, 'oga', u.update_id);
      const files: FileJob[] = [{ ref: json, source: { text: JSON.stringify(msg) + '\n' }, mustWrite: true }];
      if (labeled.text !== null) files.push({ ref: txt, source: { text: labeled.text }, mustWrite: true });
      if (voice) files.push({ ref: oga, source: { voiceFileId: voice.file_id }, mustWrite: false });
      return {
        ...common,
        kind: 'closed_topic',
        status: 'closed_topic',
        trust: labeled.trust,
        mixed: labeled.mixed,
        attachments: null,
        text: null,
        forward: null,
        replyTo: null,
        editOf: null,
        episode: 'none',
        receipt: true,
        command: null,
        rawRef: null,
        files,
        primary: [oga, txt, json],
      };
    }
    const replyTo = labeled.replyToMessageId !== null ? this.lookupReplyTo(msg.chat.id, labeled.replyToMessageId) : null;
    const voice = labeled.voice;
    const oga = voice ? this.rawPath(false, 'oga', u.update_id) : null;
    const content = {
      ...common,
      trust: labeled.trust,
      mixed: labeled.mixed,
      attachments: labeled.attachments,
      text: labeled.text,
      forward: labeled.forward,
      replyTo,
      rawRef: null,
      // Звук — файлом в raw/; не скачался — file_id остаётся в attachments_json.
      files: voice && oga ? [{ ref: oga, source: { voiceFileId: voice.file_id }, mustWrite: false }] : [],
      primary: oga ? [oga] : [],
    };
    if (isEdit) {
      // Правка (Ш-10): событие edit со ссылкой на исходное; командой не бывает, эпизод не меняет.
      return { ...content, kind: 'edit', status: 'new', editOf: this.originalOf(msg.chat.id, msg.message_id), episode: 'current', receipt: true, command: null };
    }
    const command = labeled.plainOwnerText && msg.chat.type === 'private' && who.isOwner ? parseCommand(labeled.text) : null;
    if (command) {
      // Команда исполняется кодом, мимо агента (Ш-6): событие handled, действие — в главной транзакции (control.ts).
      return { ...content, kind: 'command', status: 'handled', editOf: null, episode: 'current', receipt: false, command };
    }
    // Голосовое распознаётся после записи (5.8): событие ждёт расшифровки в статусе transcribing, агенту оно и
    // следующие за ним уйдут, когда расшифровка или отказ записаны. Аудиофайл (J-2), кружок и видео в mp4 (0.3) — так
    // же: скачиваются и распознаются после записи; длиннее stt.audio_max_minutes (по метаданным) — только скачиваются;
    // больше 20 МБ — бот не скачает: событие сразу new.
    const audio = labeled.kind === 'document' ? audioFileOf(labeled.attachments) : null;
    let sttNote: SttNote | null = null;
    if (audio) {
      if (audio.size !== null && audio.size > BOT_API_FILE_LIMIT) sttNote = 'too_big';
      else if (audio.duration !== null && audio.duration > this.ctx.config.stt.audio_max_minutes * 60) sttNote = 'too_long';
    }
    const status: EventStatus = labeled.kind === 'voice' || (audio && sttNote !== 'too_big') ? 'transcribing' : 'new';
    return { ...content, audio, sttNote, kind: labeled.kind, status, editOf: null, episode: 'message', receipt: true, command: null };
  }

  /**
   * Файлы содержимого (5.3, шаг 3): временный файл → fsync → переименование. Сбой скачивания (и местная ошибка у
   * звука) — событие всё равно записывается; диск полон — 'disk_full'; местная ошибка у записи закрытой темы —
   * исключение наверх (путь падений).
   */
  private async writeFiles(d: Draft, signal: AbortSignal): Promise<'ok' | 'stopped' | 'disk_full'> {
    const written = new Set<string>();
    for (const job of d.files) {
      let data: Buffer;
      try {
        data = 'text' in job.source ? Buffer.from(job.source.text, 'utf8') : await this.download(job.source.voiceFileId, signal);
      } catch (err) {
        if (signal.aborted) return 'stopped';
        // Сеть, Telegram, файл больше 20 МБ: file_id остаётся — звук можно докачать.
        this.ctx.journal.write('file_failed', { update_id: d.updateId, file: path.basename(job.ref), stage: 'download', error: this.ctx.api?.redact((err as Error).message) ?? String(err) });
        continue;
      }
      try {
        const full = path.join(this.ctx.paths.home, job.ref);
        ensureDir(path.dirname(full));
        writeFileAtomicSync(full, data, 0o600, this.hooks.fileIo());
        written.add(job.ref);
      } catch (err) {
        if (this.ctx.disk.check(err, 'admission', { update_id: d.updateId, step: 'files' })) return 'disk_full';
        if (job.mustWrite) throw err;
        this.ctx.journal.write('file_failed', { update_id: d.updateId, file: path.basename(job.ref), stage: 'write', error: (err as Error).message });
      }
    }
    d.rawRef = d.primary.find((r) => written.has(r)) ?? null;
    return 'ok';
  }

  private async download(fileId: string, signal: AbortSignal): Promise<Buffer> {
    const api = this.ctx.api;
    if (!api) throw new FileSourceError('нет клиента Telegram');
    const f = await api.call<{ file_path?: string }>('getFile', { file_id: fileId }, { signal, timeoutMs: FILE_TIMEOUT_MS });
    if (!f.file_path) throw new FileSourceError('getFile: нет file_path');
    return api.download(f.file_path, { signal, timeoutMs: FILE_TIMEOUT_MS });
  }

  /**
   * Окно для материала без слов владельца (0.3.6, issue #51; material.ts): что это сообщение для окна — материал (держать
   * или отдать сразу, если слова были раньше), слова владельца (отпустить удерживаемый материал этого чата) или ничего.
   * Правка удерживаемого материала со словами — тоже его слово (дописал подпись) ⟨предл.⟩; без слов (живое место шлёт
   * координаты правками, фото заменено без подписи) — не слово: ждёт вместе с исходным (edit_material, joinWindow).
   * Текст из одних ссылок реплаем на сообщение агента — ответ ему (replyToAgent): ничего, как и по строке базы
   * (isMaterialEvent — reply_to события).
   */
  private materialRole(d: Draft): 'material' | 'words' | 'edit_material' | null {
    if (d.kind === 'edit') {
      if (!d.who.isOwner || !isHeldMaterial(this.ctx, d.editOf)) return null;
      return hasOwnerWords({ kind: 'text', trust: d.trust, text: d.text, attachments: [] }) ? 'words' : 'edit_material';
    }
    return materialClass({
      fromOwner: d.who.isOwner,
      kind: d.kind,
      trust: d.trust,
      text: d.text,
      attachments: d.attachments ?? [],
      forwarded: d.forward !== null,
      replyToAgent: d.replyTo?.kind === 'agent',
    });
  }

  private commit(d: Draft, tUpdate: number, retry = false): { seq: number; effects: Effects; material: MaterialOutcome; receiptsCleared: number } {
    const { db } = this.ctx;
    const now = this.ctx.clock.now();
    return transaction(db, () => {
      this.hooks.onCommit(db);
      const subjectId = d.who.subject.id;
      const place: MaterialPlace = { chatId: d.chatId, threadId: d.threadId, subjectId };
      const role = this.materialRole(d);
      const decision: MaterialDecision =
        role === 'material'
          ? admitMaterial(this.ctx, place, d.status, now)
          : role === 'edit_material'
            ? joinWindow(this.ctx, d.editOf!, d.status)
            : { status: d.status, holdUntil: null, material: null };
      let episodeId: number | null = null;
      let effects: Effects = {};
      if (d.episode === 'message') {
        const a = this.episodes.forMessage(d.chatId, subjectId, d.who.chatRule as ChatRule, d.messageDate, d.threadId);
        episodeId = a.episode.id;
        if (a.closedEventSeq !== null) effects = { pump: true };
      } else if (d.episode === 'current') {
        episodeId = this.episodes.openFor(d.chatId, subjectId)?.id ?? null;
        if (episodeId === null && d.editOf !== null) {
          episodeId = (sql(db, 'SELECT episode_id FROM events WHERE seq = ?').get(d.editOf) as { episode_id: number | null } | undefined)?.episode_id ?? null;
        }
      }
      const r = sql(db, 
          `INSERT INTO events(update_id, message_id, chat_id, thread_id, subject_id, trust, mixed, attachments_json, kind, text,
             raw_ref, forward_json, reply_to, edit_of, episode_id, status, created_at, message_date, stt_note, hold_until, material_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          d.updateId,
          d.messageId,
          d.chatId,
          d.threadId,
          subjectId,
          d.trust,
          d.mixed ? 1 : 0,
          d.attachments ? JSON.stringify(d.attachments) : null,
          d.kind,
          d.text,
          d.rawRef,
          d.forward ? JSON.stringify(d.forward) : null,
          d.replyTo ? JSON.stringify(d.replyTo) : null,
          d.editOf,
          episodeId,
          decision.status,
          now,
          d.messageDate,
          d.sttNote,
          decision.holdUntil,
          decision.material ? JSON.stringify(decision.material) : null,
        );
      const seq = Number(r.lastInsertRowid);
      // Окно материала (0.3.6): материал в окне — окно прочих в этом чате от него; слова — удерживаемый материал с ними;
      // новые слова (не правка, не реплай на материал) — первые после материала, ушедшего без слов: «слова после материала».
      const material: MaterialOutcome = { decision, extended: [], words: null, joined: role === 'edit_material' && decision.material ? d.editOf : null, followup: [] };
      if (role === 'material' && decision.material?.state === 'waiting' && decision.holdUntil !== null) material.extended = extendWindow(this.ctx, place, seq, decision.holdUntil);
      else if (role === 'words') {
        const w = releaseByWords(this.ctx, place, seq, d.status, now);
        if (w.released.length || w.linked.length) material.words = w;
        if (d.kind !== 'edit' && !d.replyTo?.material) material.followup = linkFollowup(this.ctx, place, seq, episodeId, now);
      }
      sql(db, "UPDATE updates SET status = 'admitted', raw_json = NULL WHERE update_id = ?").run(d.updateId);
      // Следующее сообщение владельца в этом чате (0.3.6, #52): 👌 на его прежних сообщениях (закрыто без ответа) своё
      // сделали — снять. Любое новое сообщение — текст, голосовое, фото, пересылка, команда словом, закрытая тема; не
      // нажатие (callback), не реакция (handleReaction) и не правка ⟨предл.⟩. До команды: 👌, которые поставит «стоп»
      // (брошенные ответы, control.ts), живут до следующего сообщения.
      const receiptsCleared =
        d.who.isOwner && d.update.message !== undefined && d.kind !== 'callback' && clearReceipts(this.ctx) ? requestClosedCleared(this.ctx, d.chatId, subjectId) : 0;
      if (d.receipt) {
        // ✍ при записи с 0.3.2 нет (развилка R-1 б): 👀 и 👌 — когда агент увидел и ответил
        // (reactions.ts). Правка — реакция к прежнему тексту снимается в той же транзакции, что и запись ⟨предл.⟩: агент
        // правку ещё не видел; упал до COMMIT — ни записи, ни снятия, Telegram отдаст обновление снова.
        if (d.kind === 'edit') requestCleared(this.ctx, [seq]);
        // Звук файлом больше 20 МБ по метаданным (аудиофайл, кружок, видео) распознаваться не будет — короткий ответ на
        // него сразу (P-19); видео не в mp4 — тоже (сведение 0.3 и 0.3.1 ⟨предл.⟩: иначе владелец ждал бы расшифровку).
        // Остальным голосовым и звуку файлом ответ — расшифровка или причина — когда распознавание кончится (voice.ts).
        if ((d.audio && d.sttNote === 'too_big') || (d.kind === 'document' && !d.audio && isNotMp4Video(d.attachments))) enqueueSttReply(this.ctx, seq);
      }
      // t_admit — COMMIT («записал», L-2; с 0.3.2 — по записи, ✍ нет); t_receipt и t_eyes — когда встанет 👀 (reactions.ts).
      sql(db, 'INSERT INTO latency(event_seq, t_update, t_admit) VALUES (?, ?, ?)').run(seq, tUpdate, now);
      if (d.command) {
        effects = this.control.command(d.command, {
          seq,
          chatId: d.chatId,
          threadId: d.threadId,
          subjectId,
          chatRule: d.who.chatRule as ChatRule,
          messageDate: d.messageDate,
          messageId: d.messageId,
        });
      } else if (d.callback) {
        effects = this.control.press(d.callback, d.who);
      }
      // Повтор отложенного: offset этого обновления давно позади — не трогать (5.2: offset — ровно последнее + 1).
      if (!retry) {
        setMeta(db, META_KEYS.offset, String(d.updateId + 1));
        setMeta(db, META_KEYS.lastUpdateAt, String(now));
      }
      return { seq, effects, material, receiptsCleared };
    });
  }

  private afterCommit(d: Draft, seq: number, effects: Effects, material: MaterialOutcome, receiptsCleared = 0): void {
    const { journal } = this.ctx;
    if (d.kind === 'closed_topic') {
      // Закрытая тема — в журнал только №, дата, длительность (Ш-16).
      journal.write('in', {
        seq,
        kind: 'closed_topic',
        date: new Date(d.messageDate).toISOString(),
        duration: d.voice?.duration ?? null,
        ...(receiptsCleared ? { receipts_cleared: receiptsCleared } : {}),
      });
    } else {
      journal.write('in', {
        seq,
        update_id: d.updateId,
        kind: d.kind,
        label: d.trust,
        mixed: d.mixed,
        text: d.text,
        ...(d.attachments?.length ? { attachments: d.attachments.map((a) => `${a.kind}:${a.trust}`) } : {}),
        ...(d.forward ? { forward: d.forward.origin_type } : {}),
        ...(d.replyTo ? { reply_to: d.replyTo.kind, reply_to_seq: d.replyTo.event_seq, ...(d.replyTo.material ? { reply_to_material: true } : {}) } : {}),
        ...(d.kind === 'edit' ? { edit_of: d.editOf } : {}),
        ...(d.command ? { command: d.command } : {}),
        ...(d.rawRef ? { raw_ref: d.rawRef } : {}),
        // Окно материала (0.3.6): в окне — hold_ms и чьё окно сдвинуто; слова были раньше — их №.
        ...(material.decision.material?.state === 'waiting'
          ? {
              material: 'held',
              hold_ms: material.decision.material.window_ms,
              ...(material.extended.length ? { extended: material.extended } : {}),
              ...(material.joined !== null ? { joined: material.joined } : {}),
            }
          : material.decision.material?.state === 'before'
            ? { material: 'words_before', words_seq: material.decision.material.words_seq }
            : {}),
        // Слова после материала, ушедшего без слов (0.3.6): № того материала.
        ...(material.followup.length ? { after_material: material.followup } : {}),
        // Сколько 👌 на прежних сообщениях владельца в этом чате снимает это сообщение (0.3.6, #52).
        ...(receiptsCleared ? { receipts_cleared: receiptsCleared } : {}),
      });
    }
    // Слова владельца отпустили удерживаемый материал (0.3.6): отдан с ними — или ждёт, пока слова распознаются.
    if (material.words) {
      for (const r of material.words.released) journal.write('material_released', { seq: r.seq, held_ms: r.heldMs, words: 'after', words_seq: seq });
      for (const m of material.words.linked) journal.write('material_linked', { seq: m, words_seq: seq });
    }
    if (d.callback && this.ctx.api) {
      // На каждое нажатие — ровно один answerCallbackQuery; при отказе — с текстом причины (5.9).
      const api = this.ctx.api;
      const text = effects.answer ?? null;
      void api
        .call('answerCallbackQuery', { callback_query_id: d.callback.id, ...(text ? { text } : {}) }, { timeoutMs: 10_000 })
        .catch((err: unknown) => {
          journal.write('callback_answer_failed', { seq, error: api.redact((err as Error).message) });
        });
    }
    // Нажатие [разрешить] сменило рабочую копию правил: справочник — по ней, rules.yaml — дописать (5.9).
    if (effects.rules) this.control.refreshRules();
    if (effects.mode) this.adapter.notifyMode();
    this.sender.kick();
    if (d.status === 'transcribing') this.transcriber?.kick();
    // Материал в окне или слова, которые его отпустили (0.3.6): таймер окна — на новый ближайший срок.
    if (material.decision.holdUntil !== null || material.words) this.hold?.schedule();
    this.adapter.pump();
  }
}

/** Что окно материала сделало при записи (0.3.6): решение о самом событии, сдвинутые окна, отпущенное словами. */
interface MaterialOutcome {
  decision: MaterialDecision;
  /** Удерживаемый материал этого чата, чьё окно теперь — от этого события. */
  extended: number[];
  /** Это — слова владельца: какой материал они отпустили. */
  words: WordsRelease | null;
  /** Это — правка удерживаемого материала без слов: № исходного, с которым она ждёт. */
  joined: number | null;
  /** Это — первые слова владельца после материала, ушедшего без слов: № того материала (linkFollowup). */
  followup: number[];
}
