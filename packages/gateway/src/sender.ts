// Отправитель (TECH-SPEC 5.5, 5.5а; Ш-5, Ш-8, Ш-9, Ш-23). Отдельный от цикла приёма: приём квитанцию не ждёт.
// - В один чат — не чаще 1 сообщения или правки в секунду (считаем от ответа на прошлое: так и задержка сети не сжимает
//   шаг).
// - Квитанции сообщением нет ни у чего: 👀 «агент увидел», 👌 «агент ответил» — реакции (reactions.ts; P-11; с 0.3.2 без
//   ✍). Прежняя запасная текстовая квитанция и сводная `№ N–M … записал` убраны; строки квитанций, оставшиеся в очереди
//   от прежней версии, уходят как есть, по одной. Голосовое и аудиофайл получают ответом расшифровку (или короткую
//   причину) — строку шлюза вида receipt (voice.ts; P-19): только текст, без меток частей; длинная — несколькими
//   сообщениями подряд, и каждое — реплаем на то же голосовое. С 0.3.4 (развилка R-23 а, issue #44) расшифровка —
//   цитатой: <blockquote>, длинная часть — <blockquote expandable> (outbox.quote, splitQuote); 400 разбора — та же
//   часть простым текстом, и тогда с пометкой «⚙ », если начата с 💬 или ↪ (Ш-23).
// - Ответ агента: Markdown → HTML Telegram, нарезка ≤ 4096 с меткой (1/N); 400 разбора — та же часть без разметки;
//   реплаем — только первая часть и только если после сообщения владельца были другие. С 0.3.2 (P-26) — чистым
//   текстом: `💬 ` ставится только перед частью, первый видимый знак которой — знак шлюза (⚙ 📍 №
//   ↪ 💬; Ш-23); слова другого через агента (reply.from) — «↪ <имя>: » в начале каждой части (место под пометку — в
//   пределе части). С 0.3.4 `💬 ` — и перед частью, которая вся цитата (так выглядит расшифровка) ⟨предл.⟩.
// - Ответ голосом (5.5, Ш-8): синтез (voice.ts, рядом с отправителем — квитанции его не ждут; следующие ответы агента в
//   тот же чат ждут, чтобы не обогнать) → sendVoice с duration по Ogg; текст — в подписи (до 1024 знаков), длиннее —
//   следом отдельным сообщением ⟨предл. принято⟩. Синтез не удался — строка «⚙ голос не получился» и ответ текстом.
// - Правки (M4, таблица edits): снятие встроенных кнопок после нажатия, нажатая строка в одну строку без кнопок,
//   истёкшая карточка правил. Квитанции голоса больше не правятся (0.3.1: ни «распознаю…», ни «→ ответил» — расшифровка
//   приходит отдельным ответом, ответ агента виден по 👌). Правка ждёт, пока её сообщение отправлено; идёт в общей
//   очереди с той же частотой; «message is not modified» — уже сделано.
// - 429 — ждать retry_after, до 3 попыток; дальше next_try_at и повтор по таймеру. 5xx и обрыв — повтор с паузой
//   1…30 с. Отправка «как минимум один раз»: падение между отправкой и отметкой даёт повтор (точка in_send).
// - Всё, что отправил бот, — в messages_out: к чему относится каждое его сообщение (реплаи владельца, 5.5а).
// - Одна испорченная строка не держит очередь: исключение при подготовке или отметке строки (не Telegram и не сеть) —
//   строка бросается с записью в журнал, отправка идёт дальше; таймер повтора ставится всегда. Разметка ответа агента
//   не удалась — та же часть уходит простым текстом.
// - 401 и 404 (токен, адрес api_base) — не повод бросать: повтор через 60 с, как у цикла приёма; бросаются 400 и 403.
// - Диск полон — отправитель стоит (повтор раз в минуту и сразу после восстановления): отправленное, которое не
//   записать, ушло бы снова на каждой попытке.
// - Нижней клавиатуры и подсказки поля ввода нет (P-18: всё — в меню): команды — меню (setMyCommands, main.ts) и
//   словом. Разметка у сообщения — только своя: встроенные кнопки строки ([продолжить], [верно] [не то], карточка
//   правил) — на последней части. Один раз, при первом старте этой версии, — строка KEYBOARD_REMOVED_TEXT с
//   reply_markup {remove_keyboard: true}: клавиатура прежних версий у клиента держится, пока бот её не снимет
//   (upgradeTo031OnStart). Строка не удаляется ⟨предл.⟩.
// - Реакции 👀 и 👌 — своя полоса (reactions.ts): не ждут шага сообщений; 429 — общая пауза чата.
// - Закреплённая строка состояния (statusline.ts) — правка на месте не чаще раза в 3 с; нет сообщения — новое и
//   закрепить; служебное сообщение о закреплении — удалить. Его номер Telegram боту не сообщает: это первый номер после
//   закреплённого, которого нет ни у сообщений владельца, ни у сообщений бота. Владелец мог написать между отправкой
//   строки и закреплением (находка проверки) — его сообщение тогда «закреплённое + 1», а служебное — дальше.
//   Поэтому номер ищется, только когда приём догнал закрепление (висит длинный опрос, начатый не меньше 3 с назад, —
//   reception.quietSince): тогда всё, что владелец написал до закрепления, уже в базе. Не догнал за 5 минут — не удалять.
// - Удаление сообщений (deletions): команда владельца после исполнения, ответ «где мы» через ui.where_ttl_minutes или при
//   следующем «где мы», служебное сообщение о закреплении; не удалилось (старое, уже удалено) — в журнал.
// - Посылка (0.3.3, parcels.ts; 5.16): строка ответа агента со строкой доставки (deliveries.outbox_id) уходит документом
//   (sendDocument) — из копии шлюза raw/parcels/<sha256>, а не из папки агента: правка и удаление исходника доставку не
//   меняют. Подпись — как у голосового: до 1024 знаков с пометками P-26, длиннее — документ без неё и следом текст
//   ⟨предл.⟩; чужой файл без подписи — подпись «↪ <имя>» (from не теряется); новая версия того же файла — последней
//   строкой «⚙ обновлено» ⟨предл.⟩. Документ дошёл — доставка sent с его message_id сразу, независимо от текста следом;
//   брошено (400, 403, копии нет, загрузка трижды не успела) — failed с причиной и строкой владельцу «⚙ файл … не
//   отправлен: …» ⟨предл.⟩; «стоп» — dropped (control.ts). Документ читается с диска по ходу отправки (fs.openAsBlob).
//   Очередь одна на все чаты, поэтому загрузку держат в узде (находка проверки) ⟨предл.⟩: предел запроса — по
//   размеру (минута + время на 1 Мбит/с, documentTimeoutMs), после трёх таймаутов — failed «не успел загрузить», а
//   «стоп» прерывает документ в пути (kick → cancelStoppedUpload): «⚙ Остановлен» не ждёт конца загрузки; Telegram мог
//   успеть принять прерванный документ — доставка dropped с пометкой «мог уйти».
// - «Стоп» посреди длинного ответа агента: следующая часть не уходит (строка уже dropped); то же — для части, которая
//   ждала повтора (429, повтор без разметки): после паузы строка проверяется снова. Часть, уже бывшая в пути, когда
//   пришёл «стоп», не отзывается: строка остаётся dropped, в журнале — sent_after_stop.

import fs from 'node:fs';
import path from 'node:path';
import {
  sql,
  AGENT_PREFIX,
  AGENT_SIDE_MARKS,
  KEYBOARD_REMOVED_TEXT,
  META_KEYS,
  SERVICE_MARK,
  TELEGRAM_TEXT_LIMIT,
  TelegramApiError,
  VOICE_FAILED_TEXT,
  faultPoint,
  getMeta,
  escapeHtml,
  htmlToPlain,
  isNotModifiedError,
  isParseEntitiesError,
  markdownToTelegramHtml,
  needsAgentMark,
  DOCUMENT_MAX_TIMEOUTS,
  PARCEL_NOTE_AFTER_STOP,
  PARCEL_NOTE_STOP_UPLOAD,
  PARCEL_UPDATED_TEXT,
  TelegramNetworkError,
  documentTimeoutMs,
  parcelContentType,
  parcelFailedText,
  relayLabel,
  relayPrefix,
  setMeta,
  splitHtml,
  splitPlain,
  isWholeQuote,
  splitQuote,
  startsWithMark,
  transaction,
  voiceDurationSeconds,
  type Message,
  type MessageOutKind,
  type MultipartFile,
  type TextToSpeech,
  type Timer,
} from 'stg-core';
import { enqueueDeletion, enqueueServiceLine, type Ctx } from './context.js';
import { ReactionLane } from './reactions.js';
import { STATUS_LINE_MIN_INTERVAL_MS, StatusLine, type StatusLineSaved } from './statusline.js';
import { type VoiceKey, VoiceSynth } from './voice.js';

export interface OutRow {
  id: number;
  event_seq: number | null;
  chat_id: number;
  thread_id: number | null;
  kind: 'agent' | 'receipt' | 'service';
  text: string | null;
  voice: number;
  turn: number | null;
  origin: 'gateway' | 'agent';
  status: string;
  attempts: number;
  next_try_at: number | null;
  tg_message_ids: string | null;
  created_at: number;
  reply_markup: string | null;
  reply_to_message_id: number | null;
  voice_failed: number;
  bare: number;
  /** Чьи слова передаёт агент (0.3.2, P-26; схема v9): «↪ <имя>: » перед ответом. */
  from_name?: string | null;
  /** Строка шлюза — цитатой (0.3.4, R-23 а; схема v11): расшифровка. */
  quote?: number;
}

interface DeletionRow {
  id: number;
  chat_id: number;
  tg_message_id: number | null;
  outbox_id: number | null;
  reason: string;
  due_at: number;
  status: string;
  attempts: number;
  next_try_at: number | null;
  created_at: number;
  o_status: string | null;
  o_ids: string | null;
}

interface StatusDue {
  chat_id: number;
  text: string;
  /** Текст без значков агента, значки, подпись важных переходов (statusline.ts). */
  base: string;
  ind: string;
  urgent: string;
  saved: StatusLineSaved | null;
}

interface EditRow {
  id: number;
  chat_id: number;
  outbox_id: number | null;
  tg_message_id: number | null;
  event_seq: number | null;
  text: string | null;
  reply_markup: string | null;
  status: string;
  attempts: number;
  next_try_at: number | null;
  created_at: number;
  o_status: string | null;
  o_ids: string | null;
}

interface GroupRow extends OutRow {
  ev_kind: string | null;
  ev_episode: number | null;
  ev_update: number | null;
  ev_message_id: number | null;
}

/** Посылка строки ответа агента (0.3.3): доставка в Telegram (deliveries). */
interface DeliveryRow {
  id: number;
  parcel: string;
  file: string;
  bytes: number;
  copy_ref: string | null;
  updated: number;
}

/** Часть отправки: сообщение, голосовое или документ (посылка); чьё оно — для messages_out. */
export interface Part {
  method: 'sendMessage' | 'sendVoice' | 'sendDocument';
  /** Текст сообщения или подпись голосового и документа; null — без подписи. */
  text: string | null;
  html: boolean;
  kind: MessageOutKind;
  /** Что слать, если Telegram не разобрал разметку (400): по умолчанию — тот же текст без тегов. */
  plain?: string;
}

/** Шаг отправки в один чат, мс (5.5: не чаще 1 в секунду). */
export const CHAT_SPACING_MS = 1000;
/** Предел подписи голосового (5.5): до 1024 знаков, длиннее — отдельным сообщением. */
export const CAPTION_LIMIT = 1024;
/** Подпись голосового: Telegram считает видимые знаки (до 1024); разметку держим в разумных пределах. */
const TELEGRAM_CAPTION_HTML_MAX = 4 * CAPTION_LIMIT;
/** Предел на один запрос отправки. */
const SEND_TIMEOUT_MS = 30_000;
const VOICE_SEND_TIMEOUT_MS = 60_000;
const MAX_429_ATTEMPTS = 3;
/** Пауза при токене, который Telegram не принял (401, 404), и при полном диске. */
const TOKEN_RETRY_MS = 60_000;
const DISK_RETRY_MS = 60_000;
/** Сколько строк очереди смотреть, ища незаблокированную синтезом. */
const PICK_WINDOW = 50;

class Stopped extends Error {}

/** Строку не записать: диск полон — отправка стоит. */
class DiskFullPause extends Error {}

/** cancelled — «стоп» во время повтора или загрузки; upload — прерван документ в пути (Telegram мог успеть принять). */
type Outcome = { ok: true; message: Message; plain: boolean } | { ok: false; voiceRejected?: boolean; cancelled?: boolean; upload?: boolean };

type Item =
  | { type: 'out'; row: OutRow }
  | { type: 'edit'; row: EditRow }
  | { type: 'delete'; row: DeletionRow }
  | { type: 'status'; row: StatusDue };

/** Попыток удалить сообщение при сбое сети и 5xx. */
const DELETE_ATTEMPTS = 5;
/**
 * Служебное сообщение о закреплении удаляется не раньше, чем через столько после закрепления, и когда длинный опрос висит
 * не меньше этого: всё, что владелец написал до закрепления, уже пришло (ответ Telegram — быстрее).
 */
export const PIN_NOTICE_DELAY_MS = 3_000;
/** Приём ещё не догнал — проверить снова через столько. */
const PIN_NOTICE_RECHECK_MS = 1_000;
/** Не догнал за столько — служебное не удаляется (лучше лишняя строка, чем удалённое сообщение владельца). */
export const PIN_NOTICE_GIVE_UP_MS = 5 * 60_000;
/** Попыток закрепить строку состояния. */
const PIN_ATTEMPTS = 3;

function backoffMs(attempts: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempts));
}

/** Поля значков агента прежней строки (statusline.ts) — переносятся при повторе: текст в сообщении тот же. */
function indicatorFields(prev: StatusLineSaved | null): Partial<StatusLineSaved> {
  if (!prev || prev.base === undefined) return {};
  return { base: prev.base, ind: prev.ind ?? '', urgent: prev.urgent ?? '', ...(prev.ind_at !== undefined ? { ind_at: prev.ind_at } : {}) };
}

/**
 * Строка шлюза простым текстом не начинается знаком стороны агента (Ш-23): `💬` — ответ агента, начатый со знака шлюза,
 * `↪` — слова другого через агента (0.3.2). Начатая с них уходит с `⚙ ` в начале; начатая с `⚙`, `📍` или `№` — как
 * есть: это и так строка шлюза (core/strings.ts, AGENT_SIDE_MARKS) ⟨предл.⟩. Расшифровка с 0.3.4 — цитатой (R-23 а):
 * цитата сама отличает её от ответа агента, пометки нет; пометка — только у её запасного пути без разметки (quoteParts).
 */
export function guardServiceText(text: string): string {
  if (startsWithMark(text, AGENT_SIDE_MARKS)) return `${SERVICE_MARK} ${text.trimStart()}`;
  return text;
}

/**
 * Расшифровка цитатой (0.3.4; развилка R-23 а, issue #44 — так видно, что это не слова агента): части `<blockquote>`
 * (длинная — `<blockquote expandable>`) по пределу 4096 вместе с разметкой, без меток (i/N) и без `⚙` — цитата и так не
 * похожа ни на ответ агента, ни на строку шлюза. Telegram не разобрал разметку (400) — та же часть простым текстом, как
 * у ответов агента; без цитаты расшифровка снова обычный текст, поэтому там — guardServiceText (Ш-23). Место под «⚙ » в
 * пределе есть: разметка части длиннее пометки.
 */
export function quoteParts(text: string, kind: MessageOutKind): Part[] {
  return splitQuote(text).map((t) => ({ method: 'sendMessage', text: t, html: true, kind, plain: guardServiceText(htmlToPlain(t)) }));
}

/** Метка части длинного ответа «(i/N) » — её ставит нарезка (split.ts), а не агент. */
const PART_LABEL = /^\(\d+\/\d+\) /;

/**
 * Часть ответа агента с пометкой `💬 `, если текст агента в ней начинается со знака шлюза (Ш-23, 0.3.2) или вся она —
 * цитата (0.3.4: так выглядит расшифровка; isWholeQuote — вне цитат не видно ничего, по тем же классам Юникода, что
 * невидимое в начале, — по проверке 0.3.4) ⟨предл.⟩; html — часть в HTML; labeled — у части метка (i/N):
 * решают по тексту после метки (по проверке 0.3.2: «(1/2) ⚙ Остановлен…» — тоже ответ, начатый с ⚙), а `💬 ` встаёт
 * перед меткой — как «↪ Имя: » у ответа с from.
 */
export function markAgentPart(part: string, html: boolean, labeled = false): string {
  const body = labeled ? part.replace(PART_LABEL, '') : part;
  if (html && isWholeQuote(body)) return `${AGENT_PREFIX}${part}`;
  let plain = html ? htmlToPlain(part) : part;
  if (labeled) plain = plain.replace(PART_LABEL, '');
  return needsAgentMark(plain) ? `${AGENT_PREFIX}${part}` : part;
}

/** Отправленные части строки (tg_message_ids). Испорчено — исключение: строка бросается, очередь идёт дальше. */
function sentIds(json: string | null): number[] {
  const v: unknown = JSON.parse(json ?? '[]');
  if (!Array.isArray(v)) throw new Error('tg_message_ids — не список');
  return v.filter((x): x is number => typeof x === 'number');
}

export interface SenderHooks {
  /** Сообщение агента ушло. */
  onAgentSent?(row: OutRow): void;
}

/** Что отправитель знает о приёме: догнал ли он Telegram (reception.ts). */
export interface ReceptionView {
  quietSince(): number | null;
}

export class Sender {
  private running = false;
  private again = false;
  private stopped = false;
  private timer: Timer | null = null;
  private readonly nextAllowed = new Map<number, number>();
  /** Пауза чата после 429 — общая для сообщений, правок и реакций (часы шлюза). */
  private readonly flood = new Map<number, number>();
  private readonly abort = new AbortController();
  private current: Promise<void> = Promise.resolve();
  /** Синтез ответов голосом — рядом с отправителем (5.5); провайдер — из config.yaml; без ключа — отказ синтеза. */
  readonly synth: VoiceSynth | null;
  /** Реакции 👀 и 👌 — своя полоса (reactions.ts). */
  readonly reactions: ReactionLane;
  /** Закреплённая строка состояния (statusline.ts). */
  readonly statusLine: StatusLine;
  /** Приём — для номера служебного «бот закрепил». */
  private reception: ReceptionView | null = null;
  /** Документ посылки в пути (0.3.3): строка outbox и свой сигнал отмены — «стоп» прерывает загрузку. */
  private upload: { outboxId: number; ctl: AbortController } | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly hooks: SenderHooks = {},
    voice: { tts: TextToSpeech; key: VoiceKey } | null = null,
  ) {
    this.synth = voice ? new VoiceSynth(ctx, voice.tts, voice.key, () => this.kick()) : null;
    this.reactions = new ReactionLane(ctx, { flood: this.flood, signal: this.abort.signal });
    this.statusLine = new StatusLine(ctx);
  }

  bindReception(r: ReceptionView): void {
    this.reception = r;
  }

  /** Есть что отправить — запустить обе полосы (повторные вызовы сливаются). */
  kick(): void {
    if (this.stopped) return;
    this.cancelStoppedUpload();
    this.reactions.kick();
    this.kickMessages();
  }

  /**
   * «Стоп» бросил строку, чей документ сейчас загружается (0.3.3; находка проверки), — прервать загрузку: иначе
   * «⚙ Остановлен» и всё остальное ждали бы её конца (до минут), а документ всё равно пришёл бы. Зовётся из kick — после
   * каждой записи приёма, в том числе после «стопа».
   */
  private cancelStoppedUpload(): void {
    const u = this.upload;
    if (!u || u.ctl.signal.aborted) return;
    try {
      if (this.stillPending(u.outboxId)) return;
    } catch {
      return;
    }
    u.ctl.abort();
  }

  /** Полоса сообщений и правок. */
  private kickMessages(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.current = this.run()
      .catch((err: unknown) => {
        if (!(err instanceof Stopped)) this.ctx.journal.write('sender_error', { error: (err as Error).message });
      })
      .finally(() => {
        this.running = false;
        if (this.again && !this.stopped) {
          this.again = false;
          this.kickMessages();
        }
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.synth?.stop();
    this.abort.abort(new Stopped('остановка'));
    await this.current.catch(() => undefined);
    await this.reactions.stop();
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        if (this.stopped || !this.ctx.api) return;
        if (this.ctx.disk.isFull) return;
        this.again = false;
        const item = this.pick();
        if (!item) return;
        await this.waitChat(item.row.chat_id);
        if (item.type === 'delete' || item.type === 'status') {
          try {
            if (item.type === 'delete') await this.sendDeletion(item.row);
            else await this.sendStatus(item.row);
          } catch (err) {
            if (err instanceof Stopped || err instanceof DiskFullPause) throw err;
            if (this.ctx.disk.check(err, 'sender', { [item.type]: item.type === 'delete' ? item.row.id : 'status_line' })) return;
            this.ctx.journal.write('sender_error', { [item.type]: item.type === 'delete' ? item.row.id : 'status_line', error: (err as Error).message });
            if (item.type === 'delete') this.finishDeletion(item.row, 'dropped', (err as Error).message);
            else this.statusRetryLater(item.row, (err as Error).message);
          }
          continue;
        }
        if (item.type === 'edit') {
          try {
            await this.sendEdit(item.row);
          } catch (err) {
            if (err instanceof Stopped || err instanceof DiskFullPause) throw err;
            if (this.ctx.disk.check(err, 'sender', { edit_id: item.row.id })) return;
            this.ctx.journal.write('sender_error', { edit_id: item.row.id, error: (err as Error).message });
            this.finishEdit(item.row, 'dropped');
          }
          continue;
        }
        const one = this.rowWithEvent(item.row.id);
        if (!one || one.status !== 'pending') continue;
        const group = [one];
        try {
          await this.sendGroup(group);
        } catch (err) {
          if (err instanceof Stopped || err instanceof DiskFullPause) throw err;
          if (this.ctx.disk.check(err, 'sender', { outbox_ids: group.map((g) => g.id) })) return;
          // Не Telegram и не сеть — повтор дал бы то же: строка бросается, очередь идёт дальше.
          this.ctx.journal.write('sender_error', { outbox_ids: group.map((g) => g.id), error: (err as Error).message });
          this.drop(group, `внутренняя ошибка: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      if (err instanceof DiskFullPause) return;
      throw err;
    } finally {
      if (!this.stopped) this.scheduleNext();
    }
  }

  /**
   * Что слать дальше: самая ранняя из готовых строки outbox и правки. Ответ агента голосом ждёт синтеза — а с ним и
   * следующие ответы агента в тот же чат; квитанции и строки шлюза идут мимо.
   */
  private pick(): Item | null {
    const now = this.ctx.clock.now();
    let edit: EditRow | null = null;
    const edits = sql(this.ctx.db,
      `SELECT e.*, o.status AS o_status, o.tg_message_ids AS o_ids FROM edits e LEFT JOIN outbox o ON o.id = e.outbox_id
       WHERE e.status = 'pending' AND (e.next_try_at IS NULL OR e.next_try_at <= ?) ORDER BY e.id LIMIT ${PICK_WINDOW}`,
    ).all(now) as unknown as EditRow[];
    for (const e of edits) {
      if (e.outbox_id !== null) {
        // Сообщения нет и не будет (строку бросили) — правка не нужна; ещё не ушло — правка ждёт.
        if (e.o_status === 'dropped' || e.o_status === null) {
          this.finishEdit(e, 'dropped');
          continue;
        }
        if (e.o_status !== 'sent') continue;
      }
      edit = e;
      break;
    }
    const rows = sql(this.ctx.db, `SELECT * FROM outbox WHERE status = 'pending' AND (next_try_at IS NULL OR next_try_at <= ?) ORDER BY id LIMIT ${PICK_WINDOW}`)
      .all(now) as unknown as OutRow[];
    let out: OutRow | null = null;
    const blocked = new Set<number>();
    for (const r of rows) {
      if (r.origin === 'agent') {
        if (blocked.has(r.chat_id)) continue;
        if (this.waitsForVoice(r)) {
          blocked.add(r.chat_id);
          continue;
        }
      }
      out = r;
      break;
    }
    if (edit && (!out || edit.created_at < out.created_at)) return { type: 'edit', row: edit };
    if (out) return { type: 'out', row: out };
    const del = this.dueDeletion(now);
    if (del) return { type: 'delete', row: del };
    const st = this.statusLine.dueAt();
    if (st && st.at <= now) return { type: 'status', row: { chat_id: st.chatId, text: st.text, base: st.base, ind: st.ind, urgent: st.urgent, saved: st.saved } };
    return null;
  }

  /** Удаление, которому пора: цель — строка outbox — ждёт её отправки; брошенная строка — удалять нечего. */
  private dueDeletion(now: number): DeletionRow | null {
    const rows = sql(this.ctx.db,
      `SELECT d.*, o.status AS o_status, o.tg_message_ids AS o_ids FROM deletions d LEFT JOIN outbox o ON o.id = d.outbox_id
       WHERE d.status = 'pending' AND d.due_at <= ? AND (d.next_try_at IS NULL OR d.next_try_at <= ?) ORDER BY d.due_at, d.id LIMIT ${PICK_WINDOW}`,
    ).all(now, now) as unknown as DeletionRow[];
    for (const d of rows) {
      if (d.outbox_id !== null) {
        if (d.o_status === 'dropped' || d.o_status === null) {
          this.finishDeletion(d, 'dropped', 'сообщение не отправлялось');
          continue;
        }
        if (d.o_status !== 'sent') continue;
      }
      return d;
    }
    return null;
  }

  /** Ответ голосом, звука ещё нет: синтез идёт (или запускается сейчас). */
  private waitsForVoice(r: OutRow): boolean {
    if (!r.voice || r.voice_failed || !this.synth) return false;
    // Голосовое уже ушло (первая часть) — дальше только текст; испорченную строку бросит отправка.
    try {
      if (sentIds(r.tg_message_ids).length > 0) return false;
    } catch {
      return false;
    }
    const job = this.synth.job(r.id);
    if (job?.state === 'ready' || job?.state === 'failed') return false;
    if (!job) this.synth.start(r.id, this.ttsText(r.text ?? ''));
    return true;
  }

  /** Что читать голосом: ответ без разметки. */
  private ttsText(text: string): string {
    try {
      return htmlToPlain(markdownToTelegramHtml(text)).trim();
    } catch {
      return text.trim();
    }
  }

  /** Ближайший отложенный повтор — по таймеру часов; пока диск полон — через минуту. */
  private scheduleNext(): void {
    this.timer?.cancel();
    this.timer = null;
    // Синтез ответа, который больше не уйдёт («стоп» бросил строку), — забыть.
    for (const id of this.synth?.ids() ?? []) {
      try {
        if (!this.stillPending(id)) this.synth?.forget(id);
      } catch {
        break;
      }
    }
    if (this.ctx.disk.isFull) {
      this.timer = this.ctx.clock.setTimeout(() => this.kick(), DISK_RETRY_MS);
      return;
    }
    // Без клиента Telegram слать нечем — разбудит startReception (sender.kick).
    if (!this.ctx.api) return;
    const now = this.ctx.clock.now();
    let row: { t: number | null };
    let status: number | null = null;
    try {
      // Удаление и строка состояния — только будущие сроки: наступившие берёт цикл, а удаление, ждущее отправки своей
      // строки outbox, разбудит её отправка (иначе — таймер на 0 мс по кругу).
      row = sql(this.ctx.db,
        `SELECT min(t) AS t FROM (
           SELECT min(next_try_at) AS t FROM outbox WHERE status = 'pending' AND next_try_at IS NOT NULL
           UNION ALL SELECT min(next_try_at) FROM edits WHERE status = 'pending' AND next_try_at IS NOT NULL
           UNION ALL SELECT min(max(due_at, COALESCE(next_try_at, 0))) FROM deletions WHERE status = 'pending'
             AND max(due_at, COALESCE(next_try_at, 0)) > ?)`,
      ).get(now) as { t: number | null };
      const st = this.statusLine.dueAt()?.at ?? null;
      status = st !== null && st > now ? st : null;
    } catch {
      return;
    }
    const t = row.t === null ? status : status === null ? row.t : Math.min(row.t, status);
    if (t === null) return;
    const wait = Math.max(0, t - this.ctx.clock.now());
    this.timer = this.ctx.clock.setTimeout(() => this.kickMessages(), wait);
  }

  private async waitChat(chatId: number): Promise<void> {
    const at = Math.max(this.nextAllowed.get(chatId) ?? 0, this.flood.get(chatId) ?? 0);
    const now = this.ctx.clock.now();
    if (at > now) {
      try {
        await this.ctx.clock.sleep(at - now, this.abort.signal);
      } catch {
        throw new Stopped('остановка');
      }
    }
  }

  private rowWithEvent(id: number): GroupRow | undefined {
    return sql(this.ctx.db,
        `SELECT o.*, e.kind AS ev_kind, e.episode_id AS ev_episode, e.update_id AS ev_update, e.message_id AS ev_message_id
         FROM outbox o LEFT JOIN events e ON e.seq = o.event_seq WHERE o.id = ?`,
      )
      .get(id) as GroupRow | undefined;
  }

  /**
   * К какому сообщению — реплаем. Строка шлюза — на заданное (расшифровка — ответом на голосовое, каждой частью). Ответ
   * агента (5.5а) — на сообщение владельца, только если после него в чате уже были другие его сообщения, и только первой
   * частью.
   */
  private replyTarget(r: GroupRow): number | null {
    if (r.origin === 'gateway') return r.reply_to_message_id;
    if (r.event_seq === null || r.ev_message_id === null) return null;
    const later = sql(this.ctx.db,
        `SELECT 1 FROM events WHERE chat_id = ? AND message_id > ? AND update_id IS NOT NULL
         AND kind NOT IN ('callback', 'edit') LIMIT 1`,
      )
      .get(r.chat_id, r.ev_message_id);
    return later ? r.ev_message_id : null;
  }

  /**
   * Части ответа агента текстом (5.5; 0.3.2, P-26): HTML; слова другого (from_name) — «↪ <имя>: » в начале каждой части;
   * без него — `💬 ` только перед частью, текст агента в которой начинается со знака шлюза (у частей с меткой (i/N) — по
   * тексту после метки; пометка — перед меткой). Место под пометку оставлено в пределе части — с ней часть тоже ≤ 4096.
   * Разметка не удалась — простой текст.
   */
  private agentTextParts(r0: GroupRow): Part[] {
    const text = r0.text ?? '';
    const relay = r0.from_name ? relayPrefix(r0.from_name) : null;
    const noRelay = { limit: TELEGRAM_TEXT_LIMIT - AGENT_PREFIX.length };
    // Префикс — в HTML: splitPlain нарезает экранированный текст и раскрывает сущности в каждой части вместе с префиксом,
    // поэтому и в простом тексте имя приходит как есть (имя «A&amp;B» не станет «A&B», «&#9881;» — знаком ⚙).
    const opts = relay ? { prefix: escapeHtml(relay) } : noRelay;
    const mark = (parts: string[], html: boolean): Part[] =>
      parts.map((t) => ({ method: 'sendMessage', text: relay ? t : markAgentPart(t, html, parts.length > 1), html, kind: 'agent' }));
    try {
      return mark(splitHtml(markdownToTelegramHtml(text), opts), true);
    } catch (err) {
      // Разметка не удалась — тот же ответ простым текстом (с теми же пометками), а не застрявшая очередь.
      this.ctx.journal.write('format_failed', { outbox_id: r0.id, error: (err as Error).message });
      return mark(splitPlain(text, opts), false);
    }
  }

  /**
   * Ответ голосом (5.5): голосовое с подписью, если ответ в неё помещается (до 1024 знаков вместе с пометкой), иначе
   * голосовое без подписи и следом текст. Подпись — как текст (0.3.2): «↪ <имя>: » со словами другого, `💬 ` — только если
   * она начинается со знака шлюза. Синтез не удался — строка «⚙ голос не получился» и текст. Порядок частей зависит
   * только от строки (voice_failed, текст) — после перезапуска уходят оставшиеся части того же порядка.
   */
  private voiceParts(r0: GroupRow, failed: boolean): Part[] {
    const textParts = this.agentTextParts(r0);
    if (failed) return [{ method: 'sendMessage', text: VOICE_FAILED_TEXT, html: false, kind: 'service' }, ...textParts];
    const relay = r0.from_name ? relayPrefix(r0.from_name) : null;
    let caption: string | null = null;
    let html = false;
    try {
      const body = markdownToTelegramHtml(r0.text ?? '');
      const h = relay ? escapeHtml(relay) + body : markAgentPart(body, true);
      if (htmlToPlain(h).length <= CAPTION_LIMIT && h.length <= TELEGRAM_CAPTION_HTML_MAX) {
        caption = h;
        html = true;
      }
    } catch {
      const p = relay ? relay + (r0.text ?? '') : markAgentPart(r0.text ?? '', false);
      if (p.length <= CAPTION_LIMIT) caption = p;
    }
    if (caption !== null) return [{ method: 'sendVoice', text: caption, html, kind: 'agent' }];
    return [{ method: 'sendVoice', text: null, html: false, kind: 'agent' }, ...textParts];
  }

  /** Посылка строки ответа агента (0.3.3); null — обычный ответ. */
  private deliveryOf(outboxId: number): DeliveryRow | null {
    return (sql(this.ctx.db, "SELECT id, parcel, file, bytes, copy_ref, updated FROM deliveries WHERE outbox_id = ? AND target = 'telegram' ORDER BY id LIMIT 1").get(outboxId) as
      | DeliveryRow
      | undefined) ?? null;
  }

  /** Предел запроса документа (documentTimeoutMs); под тестом — STG_TEST_DOCUMENT_TIMEOUT_MS (настоящие мс). */
  private documentTimeout(bytes: number): number {
    const t = this.ctx.test ? Number(this.ctx.env.STG_TEST_DOCUMENT_TIMEOUT_MS) : Number.NaN;
    return Number.isFinite(t) && t > 0 ? t : documentTimeoutMs(bytes);
  }

  /**
   * Посылка (0.3.3, 5.16): документ с подписью, если подпись помещается (до 1024 знаков с пометками P-26 и строкой
   * «⚙ обновлено»), иначе документ с короткой подписью — «↪ <имя>» чужого файла и «⚙ обновлено» новой версии (или без
   * подписи) — и следом текст ⟨предл.⟩. Чужой файл (from) помечен всегда — и без подписи агента (находка проверки:
   * иначе он приходил как собственный файл агента). Порядок частей зависит только от строки — после перезапуска уходят
   * оставшиеся части того же порядка.
   */
  private documentParts(r0: GroupRow, d: DeliveryRow): Part[] {
    const updated = d.updated === 1 ? PARCEL_UPDATED_TEXT : null;
    const text = r0.text ?? '';
    const short = [r0.from_name ? relayLabel(r0.from_name) : null, updated].filter((x): x is string => x !== null).join('\n\n');
    const bare: Part = { method: 'sendDocument', text: short || null, html: false, kind: 'agent' };
    if (!text.trim()) return [bare];
    const relay = r0.from_name ? relayPrefix(r0.from_name) : null;
    try {
      const body = markdownToTelegramHtml(text);
      const h = (relay ? escapeHtml(relay) + body : markAgentPart(body, true)) + (updated ? `\n\n${escapeHtml(updated)}` : '');
      if (htmlToPlain(h).length <= CAPTION_LIMIT && h.length <= TELEGRAM_CAPTION_HTML_MAX) return [{ method: 'sendDocument', text: h, html: true, kind: 'agent' }];
    } catch {
      const p = (relay ? relay + text : markAgentPart(text, false)) + (updated ? `\n\n${updated}` : '');
      if (p.length <= CAPTION_LIMIT) return [{ method: 'sendDocument', text: p, html: false, kind: 'agent' }];
    }
    return [bare, ...this.agentTextParts(r0)];
  }

  private async sendGroup(group: GroupRow[]): Promise<void> {
    const { ctx } = this;
    const r0 = group[0]!;
    const isAgent = r0.origin === 'agent';
    const sent: number[] = sentIds(r0.tg_message_ids);
    let parts: Part[];
    let audio: { data: Buffer; seconds: number } | null = null;
    const parcel = isAgent ? this.deliveryOf(r0.id) : null;
    if (parcel) {
      parts = this.documentParts(r0, parcel);
    } else if (!isAgent && r0.quote) {
      // Расшифровка — цитатой (0.3.4, R-23 а): части-цитаты подряд, каждая — ответом на голосовое (кружок, файл, видео).
      parts = quoteParts(r0.text ?? '', r0.kind);
    } else if (!isAgent) {
      // Строка шлюза — без меток (i/N): длинная — это расшифровка, её части идут подряд ответом на голосовое (P-19:
      // в начале номер сообщения не нужен). Ни одна часть не начинается знаком стороны агента — 💬 или ↪ (Ш-23):
      // пометка «⚙ » — в запасе предела части.
      parts = serviceTextParts(r0.text ?? '').map((t) => ({
        method: 'sendMessage',
        text: t,
        html: false,
        kind: r0.kind,
      }));
    } else if (r0.voice) {
      const job = this.synth?.job(r0.id) ?? null;
      const failed = r0.voice_failed === 1 || !this.synth || job?.state === 'failed';
      parts = this.voiceParts(r0, failed);
      if (!failed && sent.length === 0) {
        if (job?.state !== 'ready') return; // синтез ещё идёт — строку возьмут, когда он закончится
        audio = { data: job.audio, seconds: job.seconds };
      }
    } else {
      parts = this.agentTextParts(r0);
    }
    const replyTo = this.replyTarget(r0);
    const markup = this.markupFor(r0);
    const ids = group.map((g) => g.id);
    const idsJson = JSON.stringify(ids);
    let plainUsed = false;
    for (let k = sent.length; k < parts.length; k++) {
      const part = parts[k]!;
      await this.waitChat(r0.chat_id);
      // «Стоп» мог прийти, пока шла предыдущая часть: строка ответа уже dropped — дальше не слать.
      if (isAgent && !this.stillPending(r0.id)) {
        ctx.journal.write('send_cancelled', { outbox_id: r0.id, parts_sent: sent.length, parts: parts.length });
        this.synth?.forget(r0.id);
        return;
      }
      const params: Record<string, unknown> = { chat_id: r0.chat_id };
      let files: Record<string, MultipartFile> | null = null;
      if (part.method === 'sendDocument') {
        const doc = parcel ? await this.parcelFile(parcel) : null;
        if (!doc) {
          // Копии нет (удалена по сроку, диск чистили руками): доставить нечего — строка брошена, доставка failed.
          ctx.journal.write('parcel_copy_missing', { outbox_id: r0.id, delivery: parcel?.id ?? null, copy_ref: parcel?.copy_ref ?? null });
          this.drop(group, 'копии посылки нет');
          return;
        }
        files = { document: doc };
        if (part.text !== null) params.caption = part.text;
      } else if (part.method === 'sendVoice') {
        if (!audio) {
          // Голосовое не ушло, а звука нет (синтез забыт) — синтез заново.
          this.synth?.forget(r0.id);
          return;
        }
        files = { voice: { data: audio.data, filename: 'voice.ogg', contentType: 'audio/ogg' } };
        params.duration = voiceDurationSeconds(audio.seconds);
        if (part.text !== null) params.caption = part.text;
      } else {
        params.text = part.text;
        params.link_preview_options = { is_disabled: true };
      }
      if (part.html && part.text !== null) params.parse_mode = 'HTML';
      if (r0.thread_id !== null) params.message_thread_id = r0.thread_id;
      // Ответ агента — реплаем только первой частью (5.5а); строка шлюза (расшифровка) — каждой (P-19).
      if (replyTo !== null && (k === 0 || !isAgent)) params.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
      if (k === parts.length - 1 && markup) params.reply_markup = markup;
      const out = await this.attempt(
        group,
        part.method,
        params,
        files,
        part.html && part.text !== null ? (part.plain ?? htmlToPlain(part.text)) : null,
        part.method === 'sendDocument' ? parcel : null,
      );
      if (!out.ok) {
        if (out.cancelled) {
          // «Стоп» пришёл, пока часть ждала повтора (429, повтор без разметки) или пока документ загружался: дальше не слать.
          ctx.journal.write('send_cancelled', { outbox_id: r0.id, parts_sent: sent.length, parts: parts.length, during: out.upload ? 'upload' : 'retry' });
          if (out.upload && parcel) {
            // Загрузка прервана посреди: Telegram мог успеть принять документ — доставка брошена «стопом», с пометкой.
            this.record(group, () => sql(ctx.db, "UPDATE deliveries SET note = ? WHERE id = ? AND status = 'dropped'").run(PARCEL_NOTE_STOP_UPLOAD, parcel.id));
          }
          this.synth?.forget(r0.id);
          return;
        }
        // Голосовое не принято — строку возьмут снова, теперь текстом.
        if (out.voiceRejected) this.again = true;
        return;
      }
      plainUsed ||= out.plain;
      // Точка сбоя: отправлено, но не отмечено — после старта уйдёт ещё раз («как минимум один раз»).
      for (const g of group) faultPoint('in_send', g.ev_update);
      sent.push(out.message.message_id);
      this.record(group, () => {
        sql(ctx.db, 'UPDATE outbox SET tg_message_ids = ? WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(sent), idsJson);
        sql(ctx.db, 'INSERT OR REPLACE INTO messages_out(chat_id, tg_message_id, kind, outbox_id, event_seq) VALUES (?, ?, ?, ?, ?)')
          .run(r0.chat_id, out.message.message_id, part.kind, r0.id, r0.event_seq);
        // Посылка: документ дошёл — доставка sent сразу, что бы ни стало с текстом подписи следом (400, «стоп» между
        // частями; находка проверки). «Стоп» пришёл, пока документ был в пути, а он дошёл — тоже sent, с пометкой.
        if (part.method === 'sendDocument' && parcel) {
          sql(ctx.db,
            `UPDATE deliveries SET status = 'sent', tg_message_id = ?, sent_at = ?, note = CASE status WHEN 'dropped' THEN ? ELSE note END
             WHERE id = ? AND status IN ('pending', 'dropped')`,
          ).run(out.message.message_id, ctx.clock.now(), PARCEL_NOTE_AFTER_STOP, parcel.id);
        }
      });
    }
    const now = ctx.clock.now();
    let afterStop = false;
    this.record(group, () => {
      // Только из pending: «стоп», пришедший, пока последняя часть была в пути, оставляет строку dropped — решение владельца
      // в базе не перетирается; что часть всё же ушла, видно в журнале (sent_after_stop) и в messages_out.
      const r = sql(ctx.db, "UPDATE outbox SET status = 'sent', attempts = attempts + 1, next_try_at = NULL WHERE id IN (SELECT value FROM json_each(?)) AND status = 'pending'").run(idsJson);
      afterStop = isAgent && Number(r.changes) < ids.length;
      for (const g of group) {
        if (g.event_seq === null) continue;
        if (g.kind === 'receipt') {
          // Ответ на голосовое (расшифровка) — сообщение события: реплай владельца на него — к этому событию (5.5а).
          // Время реакции (t_receipt) — по 👀 и 👌 (reactions.ts), «записал» — по записи (t_admit), а не по этому ответу.
          sql(ctx.db, 'INSERT OR REPLACE INTO receipts(event_seq, tg_message_id) VALUES (?, ?)').run(g.event_seq, sent[0] ?? null);
        } else if (g.kind === 'agent') {
          sql(ctx.db, 'UPDATE latency SET t_reply_sent = COALESCE(t_reply_sent, ?) WHERE event_seq = ?').run(now, g.event_seq);
        }
      }
    });
    this.synth?.forget(r0.id);
    if (afterStop) ctx.journal.write('sent_after_stop', { outbox_id: r0.id, tg_message_ids: sent });
    ctx.journal.write('out', {
      kind: r0.kind,
      label: r0.origin,
      outbox_ids: ids,
      event_seqs: group.map((g) => g.event_seq),
      chat_id: r0.chat_id,
      text: parts.length === 1 ? (parts[0]!.text ?? null) : parts.map((p) => p.text),
      tg_message_ids: sent,
      ...(r0.voice && isAgent ? { voice: parts[0]?.method === 'sendVoice' ? { seconds: audio ? Math.round(audio.seconds * 10) / 10 : null } : 'failed' } : {}),
      ...(replyTo !== null ? { reply_to_message_id: replyTo } : {}),
      ...(plainUsed ? { plain_fallback: true } : {}),
      ...(parcel ? { delivery: parcel.id, parcel: parcel.parcel, file: parcel.file } : {}),
      ...(r0.quote && !isAgent ? { quote: true } : {}),
    });
    if (isAgent) this.hooks.onAgentSent?.(r0);
  }

  /** Документ посылки из копии шлюза — с диска по ходу отправки; копии нет — null. */
  private async parcelFile(d: DeliveryRow): Promise<MultipartFile | null> {
    if (!d.copy_ref) return null;
    const full = path.join(this.ctx.paths.home, d.copy_ref);
    try {
      if (!fs.statSync(full).isFile()) return null;
      const name = path.posix.basename(d.file);
      const type = parcelContentType(name);
      return { data: await fs.openAsBlob(full, { type }), filename: name, contentType: type };
    } catch {
      return null;
    }
  }

  private stillPending(id: number): boolean {
    const r = sql(this.ctx.db, 'SELECT status FROM outbox WHERE id = ?').get(id) as { status: string } | undefined;
    return r?.status === 'pending';
  }

  /**
   * Разметка сообщения — только своя у строки: встроенные кнопки ([продолжить], [верно] [не то], карточка правил) или
   * снятие клавиатуры (remove_keyboard, один раз — upgradeTo031OnStart). Нижней клавиатуры с 0.3.1 нет
   * (P-18).
   */
  private markupFor(r: GroupRow): Record<string, unknown> | null {
    return r.reply_markup ? (JSON.parse(r.reply_markup) as Record<string, unknown>) : null;
  }

  /** Отметка после ответа Telegram. Диск полон — отправка встаёт (не «внутренняя ошибка» и не повтор сразу). */
  private record(group: Array<{ id: number }>, fn: () => void): void {
    try {
      transaction(this.ctx.db, fn);
    } catch (err) {
      if (this.ctx.disk.check(err, 'sender', { outbox_ids: group.map((g) => g.id), step: 'record' })) throw new DiskFullPause('диск полон');
      throw err;
    }
  }

  /**
   * Одна часть: 429 — ждать и повторить (до 3 раз); 400 разбора — без разметки; остальное — отложить или бросить.
   * sendVoice и sendDocument — с файлом (multipart). Документ посылки (doc) — свой сигнал отмены («стоп» прерывает
   * загрузку), предел запроса по размеру, после DOCUMENT_MAX_TIMEOUTS таймаутов — брошен (0.3.3).
   */
  private async attempt(
    group: GroupRow[],
    method: Part['method'],
    params: Record<string, unknown>,
    files: Record<string, MultipartFile> | null,
    plainFallback: string | null,
    doc: DeliveryRow | null = null,
  ): Promise<Outcome> {
    const { ctx } = this;
    const api = ctx.api;
    if (!api) return { ok: false };
    const r0 = group[0]!;
    const textKey = method === 'sendMessage' ? 'text' : 'caption';
    const timeoutMs = doc ? this.documentTimeout(doc.bytes) : VOICE_SEND_TIMEOUT_MS;
    let p = params;
    let plain = false;
    let n429 = 0;
    for (;;) {
      if (this.stopped) throw new Stopped('остановка');
      const own = doc ? new AbortController() : null;
      try {
        if (own) {
          this.upload = { outboxId: r0.id, ctl: own };
          // «Стоп» мог прийти, пока готовился файл (openAsBlob): kick тогда загрузку ещё не видел.
          if (!this.stillPending(r0.id)) return { ok: false, cancelled: true };
        }
        const signal = own ? AbortSignal.any([this.abort.signal, own.signal]) : this.abort.signal;
        // Предел запроса — по настоящему времени: это защита от мёртвого соединения, а не срок шлюза; скачок поддельных
        // часов не должен рвать уже ушедшую отправку (иначе повтор того, что дошло).
        const message = files
          ? await api.callMultipart<Message>(method, p, files, { signal, timeoutMs })
          : await api.call<Message>(method, p, { signal, timeoutMs: SEND_TIMEOUT_MS });
        this.nextAllowed.set(r0.chat_id, ctx.clock.now() + CHAT_SPACING_MS);
        return { ok: true, message, plain };
      } catch (err) {
        if (this.stopped) throw new Stopped('остановка');
        // «Стоп» прервал документ в пути (cancelStoppedUpload): строка уже брошена — не повторять.
        if (own?.signal.aborted) return { ok: false, cancelled: true, upload: true };
        const now = ctx.clock.now();
        if (err instanceof TelegramApiError) {
          if (err.errorCode === 429) {
            n429++;
            const ra = Math.max(1, err.retryAfter ?? 1) * 1000;
            this.nextAllowed.set(r0.chat_id, now + ra);
            this.flood.set(r0.chat_id, now + ra);
            if (n429 >= MAX_429_ATTEMPTS) {
              this.defer(group, now + ra, err.message);
              return { ok: false };
            }
            ctx.journal.write('send_retry', { outbox_id: r0.id, retry_after_ms: ra, attempt: n429 });
            try {
              await ctx.clock.sleep(ra, this.abort.signal);
            } catch {
              throw new Stopped('остановка');
            }
            // Пока ждали, владелец мог сказать «стоп»: ответ агента больше не уходит.
            if (r0.origin === 'agent' && !this.stillPending(r0.id)) return { ok: false, cancelled: true };
            continue;
          }
          if (isParseEntitiesError(err) && plainFallback !== null && !plain) {
            ctx.journal.write('send_plain', { outbox_id: r0.id, error: err.description });
            p = { ...p, [textKey]: plainFallback };
            delete p.parse_mode;
            plain = true;
            this.nextAllowed.set(r0.chat_id, now + CHAT_SPACING_MS);
            await this.waitChat(r0.chat_id);
            if (r0.origin === 'agent' && !this.stillPending(r0.id)) return { ok: false, cancelled: true };
            continue;
          }
          if (err.errorCode >= 500 || err.errorCode === 401 || err.errorCode === 404) {
            this.defer(group, now + (err.errorCode < 500 ? TOKEN_RETRY_MS : backoffMs(r0.attempts)), err.message);
            return { ok: false };
          }
          // Голосовое не принято (владелец запретил голосовые от ботов — VOICE_MESSAGES_FORBIDDEN, файл не тот): ответ не
          // бросается, а уходит текстом с пометкой «голос не получился».
          if (method === 'sendVoice' && err.errorCode === 400) {
            this.ctx.journal.write('voice_rejected', { outbox_id: r0.id, error: err.description });
            this.record(group, () => sql(ctx.db, 'UPDATE outbox SET voice_failed = 1 WHERE id = ?').run(r0.id));
            this.synth?.forget(r0.id);
            return { ok: false, voiceRejected: true };
          }
          this.drop(group, err.message);
          return { ok: false };
        }
        // Документ не успел загрузиться за предел (медленная сеть): после DOCUMENT_MAX_TIMEOUTS — брошен, а не без конца.
        if (doc && err instanceof TelegramNetworkError && err.timedOut && this.countTimeout(group, doc.id) >= DOCUMENT_MAX_TIMEOUTS) {
          this.drop(group, `не успел загрузить: ${DOCUMENT_MAX_TIMEOUTS} попытки кончились таймаутом — медленная сеть`);
          return { ok: false };
        }
        // Сеть: обрыв, таймаут.
        this.defer(group, now + backoffMs(r0.attempts), (err as Error).message);
        return { ok: false };
      } finally {
        if (own && this.upload?.ctl === own) this.upload = null;
      }
    }
  }

  /** Таймаут загрузки документа — в доставку (deliveries.timeouts); сколько их теперь. */
  private countTimeout(group: GroupRow[], deliveryId: number): number {
    let n = 0;
    this.record(group, () => {
      sql(this.ctx.db, 'UPDATE deliveries SET timeouts = timeouts + 1 WHERE id = ?').run(deliveryId);
      n = (sql(this.ctx.db, 'SELECT timeouts FROM deliveries WHERE id = ?').get(deliveryId) as { timeouts: number } | undefined)?.timeouts ?? 0;
    });
    return n;
  }

  private defer(group: GroupRow[], at: number, reason: string): void {
    const ids = group.map((g) => g.id);
    this.record(group, () =>
      sql(this.ctx.db, 'UPDATE outbox SET attempts = attempts + 1, next_try_at = ? WHERE id IN (SELECT value FROM json_each(?))').run(at, JSON.stringify(ids)),
    );
    this.ctx.journal.write('send_deferred', { outbox_ids: ids, next_try_at: at, reason: this.ctx.api?.redact(reason) ?? reason });
  }

  private drop(group: GroupRow[], reason: string): void {
    const ids = group.map((g) => g.id);
    const why = this.ctx.api?.redact(reason) ?? reason;
    let failed: Array<{ id: number; parcel: string; file: string; chat_id: number | null }> = [];
    this.record(group, () => {
      sql(this.ctx.db, "UPDATE outbox SET status = 'dropped', attempts = attempts + 1 WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(ids));
      // Посылка (0.3.3): Telegram не принял, копии нет, загрузка не успела — доставка не удалась, с причиной; владельцу —
      // строка шлюза: он просил файл и видит 👌, без неё не узнал бы, что файла не будет ⟨предл.⟩.
      failed = sql(this.ctx.db, "SELECT id, parcel, file, chat_id FROM deliveries WHERE status = 'pending' AND outbox_id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(ids)) as Array<{ id: number; parcel: string; file: string; chat_id: number | null }>;
      sql(this.ctx.db, "UPDATE deliveries SET status = 'failed', note = ? WHERE status = 'pending' AND outbox_id IN (SELECT value FROM json_each(?))").run(why.slice(0, 500), JSON.stringify(ids));
      const owner = this.ctx.config.owner_id;
      for (const d of failed) {
        const words = why.replace(/^sendDocument: /, 'Telegram не принял: ').slice(0, 300);
        enqueueServiceLine(this.ctx, parcelFailedText(`${d.parcel}/${d.file}`, words, d.chat_id !== null && d.chat_id !== owner ? d.chat_id : null));
      }
    });
    if (failed.length) this.ctx.journal.write('parcel_failed', { outbox_ids: ids, deliveries: failed.map((d) => d.id), reason: why });
    for (const id of ids) this.synth?.forget(id);
    this.ctx.journal.write('send_dropped', { outbox_ids: ids, reason: this.ctx.api?.redact(reason) ?? reason });
  }

  // ——— удаление сообщений ———

  private finishDeletion(d: DeletionRow, status: 'sent' | 'dropped', reason?: string): void {
    this.record([{ id: d.outbox_id ?? 0 }], () =>
      sql(this.ctx.db, 'UPDATE deletions SET status = ?, attempts = attempts + 1, next_try_at = NULL WHERE id = ?').run(status, d.id),
    );
    if (status === 'dropped') this.ctx.journal.write('delete_dropped', { deletion_id: d.id, reason: d.reason, why: reason ?? null });
  }

  /** Номер известен шлюзу: сообщение владельца (событие или обновление, которое ещё принимается) или бота. */
  private knownMessage(chatId: number, messageId: number): boolean {
    const db = this.ctx.db;
    return !!(
      sql(db, 'SELECT 1 FROM events WHERE chat_id = ? AND message_id = ? LIMIT 1').get(chatId, messageId) ??
      sql(db, 'SELECT 1 FROM messages_out WHERE chat_id = ? AND tg_message_id = ? LIMIT 1').get(chatId, messageId) ??
      sql(db,
        `SELECT 1 FROM updates WHERE status IN ('in_progress', 'deferred') AND raw_json IS NOT NULL
           AND COALESCE(json_extract(raw_json, '$.message.chat.id'), json_extract(raw_json, '$.edited_message.chat.id')) = ?
           AND COALESCE(json_extract(raw_json, '$.message.message_id'), json_extract(raw_json, '$.edited_message.message_id')) = ? LIMIT 1`,
      ).get(chatId, messageId)
    );
  }

  /**
   * Номер служебного «бот закрепил»: первый от tg_message_id (закреплённое + 1), которого нет ни у владельца, ни у бота.
   * Только когда приём догнал закрепление (висит длинный опрос не меньше PIN_NOTICE_DELAY_MS): иначе сообщение владельца,
   * написанное между отправкой строки и закреплением, ещё не в базе, и под угаданным номером оказалось бы оно.
   */
  private pinNoticeTarget(d: DeletionRow): number | 'wait' | 'give_up' {
    const now = this.ctx.clock.now();
    const quiet = this.reception?.quietSince() ?? null;
    if (quiet === null || now - quiet < PIN_NOTICE_DELAY_MS || now - d.created_at < PIN_NOTICE_DELAY_MS) {
      return now - d.created_at >= PIN_NOTICE_GIVE_UP_MS ? 'give_up' : 'wait';
    }
    let id = d.tg_message_id!;
    for (let i = 0; i < 1000 && this.knownMessage(d.chat_id, id); i++) id++;
    return id;
  }

  /**
   * Удалить сообщение (или все части строки outbox). 400 и 403 — его уже нет или удалить нельзя (старше 48 часов) — не
   * беда. 429 — ждать; сеть и 5xx — повтор, до DELETE_ATTEMPTS. Служебное сообщение о закреплении — по номеру, найденному,
   * когда приём догнал закрепление (pinNoticeTarget).
   */
  private async sendDeletion(d: DeletionRow): Promise<void> {
    const { ctx } = this;
    const api = ctx.api;
    if (!api) return;
    let ids = d.tg_message_id !== null ? [d.tg_message_id] : sentIds(d.o_ids);
    if (d.reason === 'pin_notice' && d.tg_message_id !== null) {
      const target = this.pinNoticeTarget(d);
      if (target === 'give_up') {
        this.finishDeletion(d, 'dropped', 'приём не догнал закрепление — номер служебного сообщения не установить');
        return;
      }
      if (target === 'wait') {
        this.record([{ id: 0 }], () =>
          sql(ctx.db, 'UPDATE deletions SET next_try_at = ? WHERE id = ?').run(ctx.clock.now() + PIN_NOTICE_RECHECK_MS, d.id),
        );
        return;
      }
      if (target !== d.tg_message_id) ctx.journal.write('pin_notice_shifted', { deletion_id: d.id, guessed: d.tg_message_id, tg_message_id: target });
      ids = [target];
    }
    const gone: number[] = [];
    for (const id of ids) {
      await this.waitChat(d.chat_id);
      try {
        await api.call('deleteMessage', { chat_id: d.chat_id, message_id: id }, { signal: this.abort.signal, timeoutMs: SEND_TIMEOUT_MS });
        this.nextAllowed.set(d.chat_id, ctx.clock.now() + CHAT_SPACING_MS);
      } catch (err) {
        if (this.stopped) throw new Stopped('остановка');
        const now = ctx.clock.now();
        this.nextAllowed.set(d.chat_id, now + CHAT_SPACING_MS);
        if (err instanceof TelegramApiError && err.errorCode !== 429 && err.errorCode < 500 && err.errorCode !== 401 && err.errorCode !== 404) {
          // Сообщения уже нет или его нельзя удалить — не беда.
          gone.push(id);
          ctx.journal.write('delete_failed', { deletion_id: d.id, reason: d.reason, tg_message_id: id, error: api.redact(err.description) });
          continue;
        }
        let at = now + backoffMs(d.attempts);
        if (err instanceof TelegramApiError && err.errorCode === 429) {
          const ra = Math.max(1, err.retryAfter ?? 1) * 1000;
          this.flood.set(d.chat_id, now + ra);
          at = now + ra;
        } else if (d.attempts + 1 >= DELETE_ATTEMPTS) {
          this.finishDeletion(d, 'dropped', api.redact((err as Error).message));
          return;
        }
        this.record([{ id: d.outbox_id ?? 0 }], () =>
          sql(ctx.db, 'UPDATE deletions SET attempts = attempts + 1, next_try_at = ? WHERE id = ?').run(at, d.id),
        );
        ctx.journal.write('delete_deferred', { deletion_id: d.id, next_try_at: at, reason: api.redact((err as Error).message) });
        return;
      }
    }
    this.finishDeletion(d, 'sent');
    ctx.journal.write('deleted', { deletion_id: d.id, label: 'gateway', reason: d.reason, chat_id: d.chat_id, tg_message_ids: ids, ...(gone.length ? { already_gone: gone } : {}) });
  }

  // ——— закреплённая строка состояния ———

  private saveStatus(v: StatusLineSaved): void {
    this.record([{ id: 0 }], () => this.statusLine.save(v));
  }

  /** Сбой — повторить позже (не чаще раза в 3 с, после 429 — по retry_after). */
  private statusRetryLater(st: StatusDue, reason: string, at?: number): void {
    const now = this.ctx.clock.now();
    const prev = st.saved;
    this.saveStatus({
      chat_id: st.chat_id,
      message_id: prev?.message_id ?? null,
      text: prev?.text ?? null,
      at: prev?.at ?? now,
      retry_at: at ?? now + STATUS_LINE_MIN_INTERVAL_MS * 2,
      ...(prev?.pinned !== undefined ? { pinned: prev.pinned, pin_attempts: prev.pin_attempts ?? 0 } : {}),
      ...(prev?.pin_failed ? { pin_failed: true } : {}),
      ...indicatorFields(prev),
    });
    this.ctx.journal.write('status_line_deferred', { reason: this.ctx.api?.redact(reason) ?? reason });
  }

  /**
   * Строка состояния: правка на месте; сообщения нет или его нельзя править — новое, закрепить без звука, служебное
   * сообщение о закреплении — удалить. «message is not modified» — уже так.
   */
  private async sendStatus(st: StatusDue): Promise<void> {
    const { ctx } = this;
    const api = ctx.api;
    if (!api) return;
    const saved = st.saved;
    if (saved && saved.message_id !== null) {
      if (saved.text !== st.text) {
        try {
          await api.call(
            'editMessageText',
            { chat_id: st.chat_id, message_id: saved.message_id, text: st.text, link_preview_options: { is_disabled: true } },
            { signal: this.abort.signal, timeoutMs: SEND_TIMEOUT_MS },
          );
          this.nextAllowed.set(st.chat_id, ctx.clock.now() + CHAT_SPACING_MS);
        } catch (err) {
          if (this.stopped) throw new Stopped('остановка');
          const now = ctx.clock.now();
          this.nextAllowed.set(st.chat_id, now + CHAT_SPACING_MS);
          if (!isNotModifiedError(err)) {
            if (!(err instanceof TelegramApiError) || err.errorCode === 429 || err.errorCode >= 500 || err.errorCode === 401 || err.errorCode === 404) {
              const ra = err instanceof TelegramApiError && err.errorCode === 429 ? Math.max(1, err.retryAfter ?? 1) * 1000 : null;
              if (ra !== null) this.flood.set(st.chat_id, now + ra);
              this.statusRetryLater(st, (err as Error).message, ra !== null ? now + ra : undefined);
              return;
            }
            // Сообщения нет (удалено) или его нельзя править — новое.
            ctx.journal.write('status_line_lost', { tg_message_id: saved.message_id, error: api.redact(err.description) });
            await this.createStatus(st);
            return;
          }
        }
        const pinned = saved.pinned;
        const now = ctx.clock.now();
        this.saveStatus({
          chat_id: st.chat_id,
          message_id: saved.message_id,
          text: st.text,
          at: now,
          ...(pinned !== undefined ? { pinned, pin_attempts: saved.pin_attempts ?? 0 } : {}),
          ...(saved.pin_failed ? { pin_failed: true } : {}),
          base: st.base,
          ind: st.ind,
          urgent: st.urgent,
          ind_at: saved.ind !== st.ind ? now : (saved.ind_at ?? now),
        });
        ctx.journal.write('status_line', { label: 'gateway', action: 'edit', tg_message_id: saved.message_id, text: st.text });
      }
      if (saved.pinned === false) await this.pinStatus(st.chat_id, saved.message_id, saved.pin_attempts ?? 0);
      return;
    }
    await this.createStatus(st);
  }

  private async createStatus(st: StatusDue): Promise<void> {
    const { ctx } = this;
    const api = ctx.api;
    if (!api) return;
    await this.waitChat(st.chat_id);
    let message: Message;
    try {
      message = await api.call<Message>(
        'sendMessage',
        { chat_id: st.chat_id, text: st.text, disable_notification: true, link_preview_options: { is_disabled: true } },
        { signal: this.abort.signal, timeoutMs: SEND_TIMEOUT_MS },
      );
      this.nextAllowed.set(st.chat_id, ctx.clock.now() + CHAT_SPACING_MS);
    } catch (err) {
      if (this.stopped) throw new Stopped('остановка');
      const now = ctx.clock.now();
      this.nextAllowed.set(st.chat_id, now + CHAT_SPACING_MS);
      const ra = err instanceof TelegramApiError && err.errorCode === 429 ? Math.max(1, err.retryAfter ?? 1) * 1000 : null;
      if (ra !== null) this.flood.set(st.chat_id, now + ra);
      // Прежнее сообщение уже не годится — строка заводится заново при следующей попытке.
      this.statusRetryLater({ ...st, saved: null }, (err as Error).message, ra !== null ? now + ra : err instanceof TelegramApiError && err.errorCode < 500 ? now + TOKEN_RETRY_MS : undefined);
      return;
    }
    const now = ctx.clock.now();
    this.record([{ id: 0 }], () => {
      sql(ctx.db, 'INSERT OR REPLACE INTO messages_out(chat_id, tg_message_id, kind, outbox_id, event_seq) VALUES (?, ?, ?, NULL, NULL)').run(st.chat_id, message.message_id, 'service');
      this.statusLine.save({ chat_id: st.chat_id, message_id: message.message_id, text: st.text, at: now, pinned: false, pin_attempts: 0, base: st.base, ind: st.ind, urgent: st.urgent, ind_at: now });
    });
    ctx.journal.write('status_line', { label: 'gateway', action: 'new', tg_message_id: message.message_id, text: st.text });
    await this.pinStatus(st.chat_id, message.message_id, 0);
  }

  /** Закрепить строку без звука; служебное сообщение о закреплении — удалить (через PIN_NOTICE_DELAY_MS). */
  private async pinStatus(chatId: number, messageId: number, attempts: number): Promise<void> {
    const { ctx } = this;
    const api = ctx.api;
    if (!api) return;
    await this.waitChat(chatId);
    const update = (pinned: boolean, n: number, retryAt: number | null, failed = false): void => {
      const cur = this.statusLine.saved();
      if (!cur || cur.message_id !== messageId) return;
      this.saveStatus({ ...cur, pinned, pin_attempts: n, retry_at: retryAt, ...(failed ? { pin_failed: true } : {}) });
    };
    try {
      await api.call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true }, { signal: this.abort.signal, timeoutMs: SEND_TIMEOUT_MS });
      this.nextAllowed.set(chatId, ctx.clock.now() + CHAT_SPACING_MS);
    } catch (err) {
      if (this.stopped) throw new Stopped('остановка');
      const now = ctx.clock.now();
      this.nextAllowed.set(chatId, now + CHAT_SPACING_MS);
      const n = attempts + 1;
      ctx.journal.write('status_pin_failed', { tg_message_id: messageId, attempt: n, error: api.redact((err as Error).message) });
      // Не закрепилось — повтор позже; после PIN_ATTEMPTS — строка остаётся незакреплённой (правится на месте; pin_failed —
      // «пауза», «продолжить» и «новая тема» тогда отвечают временной строкой, control.ts).
      if (n >= PIN_ATTEMPTS) update(true, n, null, true);
      else update(false, n, now + backoffMs(n) + STATUS_LINE_MIN_INTERVAL_MS);
      return;
    }
    const now = ctx.clock.now();
    this.record([{ id: 0 }], () => {
      const cur = this.statusLine.saved();
      if (cur && cur.message_id === messageId) this.statusLine.save({ ...cur, pinned: true, pin_attempts: attempts + 1, retry_at: null, pin_failed: false });
      enqueueDeletion(ctx, { chatId, tgMessageId: messageId + 1, reason: 'pin_notice', dueAt: now + PIN_NOTICE_DELAY_MS });
    });
    ctx.journal.write('status_line', { label: 'gateway', action: 'pinned', tg_message_id: messageId });
  }

  // ——— правки ———

  private finishEdit(e: EditRow, status: 'sent' | 'dropped', reason?: string): void {
    this.record([{ id: e.outbox_id ?? 0 }], () =>
      sql(this.ctx.db, 'UPDATE edits SET status = ?, attempts = attempts + 1, next_try_at = NULL WHERE id = ?').run(status, e.id),
    );
    if (status === 'dropped') this.ctx.journal.write('edit_dropped', { edit_id: e.id, event_seq: e.event_seq, reason: reason ? (this.ctx.api?.redact(reason) ?? reason) : 'нет сообщения' });
  }

  /**
   * Правка (M4): текст и встроенные кнопки (editMessageText) или только кнопки (editMessageReplyMarkup). Сообщение —
   * последнее в строке outbox (на нём кнопки) или заданное прямо. «Не изменилось» — уже сделано.
   */
  private async sendEdit(e: EditRow): Promise<void> {
    const { ctx } = this;
    const api = ctx.api;
    if (!api) return;
    const messageId = e.tg_message_id ?? sentIds(e.o_ids).at(-1) ?? null;
    if (messageId === null) {
      this.finishEdit(e, 'dropped');
      return;
    }
    const method = e.text !== null ? 'editMessageText' : 'editMessageReplyMarkup';
    const params: Record<string, unknown> = { chat_id: e.chat_id, message_id: messageId };
    if (e.text !== null) {
      params.text = guardServiceText(e.text);
      params.link_preview_options = { is_disabled: true };
    }
    // Без reply_markup Telegram снимает встроенные кнопки.
    if (e.reply_markup) params.reply_markup = JSON.parse(e.reply_markup) as unknown;
    let n429 = 0;
    for (;;) {
      if (this.stopped) throw new Stopped('остановка');
      try {
        await api.call(method, params, { signal: this.abort.signal, timeoutMs: SEND_TIMEOUT_MS });
        this.nextAllowed.set(e.chat_id, ctx.clock.now() + CHAT_SPACING_MS);
        this.finishEdit(e, 'sent');
        ctx.journal.write('edit_sent', { edit_id: e.id, label: 'gateway', event_seq: e.event_seq, chat_id: e.chat_id, tg_message_id: messageId, ...(e.text !== null ? { text: e.text } : { markup: e.reply_markup ? 'buttons' : 'removed' }) });
        return;
      } catch (err) {
        if (this.stopped) throw new Stopped('остановка');
        const now = ctx.clock.now();
        this.nextAllowed.set(e.chat_id, now + CHAT_SPACING_MS);
        if (isNotModifiedError(err)) {
          this.finishEdit(e, 'sent');
          return;
        }
        if (err instanceof TelegramApiError) {
          if (err.errorCode === 429) {
            n429++;
            const ra = Math.max(1, err.retryAfter ?? 1) * 1000;
            this.nextAllowed.set(e.chat_id, now + ra);
            this.flood.set(e.chat_id, now + ra);
            if (n429 < MAX_429_ATTEMPTS) {
              try {
                await ctx.clock.sleep(ra, this.abort.signal);
              } catch {
                throw new Stopped('остановка');
              }
              continue;
            }
            this.deferEdit(e, now + ra, err.message);
            return;
          }
          if (err.errorCode >= 500 || err.errorCode === 401 || err.errorCode === 404) {
            this.deferEdit(e, now + (err.errorCode < 500 ? TOKEN_RETRY_MS : backoffMs(e.attempts)), err.message);
            return;
          }
          // 400 (сообщения нет, его нельзя править) и 403 — править нечего.
          this.finishEdit(e, 'dropped', err.message);
          return;
        }
        this.deferEdit(e, now + backoffMs(e.attempts), (err as Error).message);
        return;
      }
    }
  }

  private deferEdit(e: EditRow, at: number, reason: string): void {
    this.record([{ id: e.outbox_id ?? 0 }], () => sql(this.ctx.db, 'UPDATE edits SET attempts = attempts + 1, next_try_at = ? WHERE id = ?').run(at, e.id));
    this.ctx.journal.write('edit_deferred', { edit_id: e.id, next_try_at: at, reason: this.ctx.api?.redact(reason) ?? reason });
  }
}

/**
 * Части строки шлюза (5.5, P-19): без меток (i/N) — длинная строка шлюза — это расшифровка, её части идут подряд ответом
 * на голосовое; ни одна часть не начинается знаком стороны агента (💬, ↪; Ш-23, guardServiceText) — место под пометку
 * «⚙ » оставлено в пределе части, поэтому с пометкой часть тоже ≤ 4096.
 */
export function serviceTextParts(text: string): string[] {
  return splitPlain(text, { labels: false, limit: TELEGRAM_TEXT_LIMIT - SERVICE_MARK.length - 1 }).map(guardServiceText);
}

/** Строка прежних версий (до 0.3.1) под нижней клавиатурой — неушедшую при первом старте 0.3.1 не шлём. */
const LEGACY_KEYBOARD_NOTE_TEXT = `${SERVICE_MARK} Команды — кнопками внизу; справка — /help`;

/**
 * Первый старт 0.3.1 — один раз, отметкой meta.keyboard_removed в той же транзакции (повторный старт ничего не делает).
 * Внутри транзакции.
 * - Снять нижнюю клавиатуру у владельца (P-18: всё — в меню). Клавиатура прежних версий у клиента держится, пока бот не
 *   пришлёт сообщение с reply_markup {remove_keyboard: true}: в очередь — строка KEYBOARD_REMOVED_TEXT с ним ⟨предл.:
 *   текст; строка не удаляется⟩; если она ещё в очереди при следующем старте — уйдёт одна, обычным повтором. Бот
 *   владельцу ещё не писал (новая установка: ни сообщений бота, ни отметки прежней клавиатуры) — клавиатуры у него не
 *   было: только отметка, без строки.
 * - Неушедшие строки прежних версий «⚙ Команды — кнопками внизу; справка — /help» — в dropped ⟨предл.⟩: без клавиатуры и
 *   рядом со строкой «Кнопки убраны» они противоречили бы ей. Неушедшие квитанции голосового прежних версий
 *   («распознаю…» и их правки) уходят как есть ⟨предл.⟩.
 * - ✍ записанному прежней версией (0.3.1: requestRecordedBacklog) с 0.3.2 не ставится
 *   (развилка R-1 б).
 */
export function upgradeTo031OnStart(ctx: Ctx): { outboxId: number | null; notesDropped: number } | null {
  const owner = ctx.config.owner_id;
  if (owner === null) return null;
  if (getMeta(ctx.db, META_KEYS.keyboardRemoved) !== null) return null;
  const hadKeyboard =
    getMeta(ctx.db, META_KEYS.keyboardPlaceholder) !== null || !!sql(ctx.db, 'SELECT 1 FROM messages_out WHERE chat_id = ? LIMIT 1').get(owner);
  const notesDropped = Number(
    sql(ctx.db, "UPDATE outbox SET status = 'dropped' WHERE status IN ('pending', 'held') AND origin = 'gateway' AND kind = 'service' AND text = ?").run(LEGACY_KEYBOARD_NOTE_TEXT).changes,
  );
  const outboxId = hadKeyboard ? enqueueServiceLine(ctx, KEYBOARD_REMOVED_TEXT, { replyMarkup: { remove_keyboard: true } }) : null;
  setMeta(ctx.db, META_KEYS.keyboardRemoved, JSON.stringify({ at: ctx.clock.now(), outbox_id: outboxId }));
  return { outboxId, notesDropped };
}
