// Переходник: аренда и обмен событиями — протокол целиком (TECH-SPEC 5.10; Оч-2…Оч-4, Оч-6; К-2…К-5).
//
// Аренда. hello → welcome {lease_id, mode, turn} — аренда предварительная: шлюз отдаёт одно событие probe (строка
// events вида probe) с кодом, и только done на него с этим кодом делает аренду проверенной (код есть лишь в тексте
// события — его видит только сессия, куда событие дошло; в отказах нет ни номера, ни кода); до этого другие события не
// отдаются, а новый hello вытесняет предварительную аренду. Ответа нет 120 с — error unverified, сокет закрыт,
// `stg status` и «статус» говорят «сессия открыта без канала — перезапусти start.sh» (meta.channel_unverified). Проверенную аренду второй
// hello не вытесняет — ему busy {holder, since} (Оч-3). Ping аренде — каждые 15 с; нет pong 45 с — аренда снята.
// Аренда снята (закрыто соединение, нет pong, не прошла проверку, вытеснена) — отданное без «обработано» снова new.
// Новая аренда первым делом возвращает в new всё отданное прежним арендам (даже если при их закрытии запись не прошла —
// диск был полон): аренда одна, отданное чужой аренде — ничьё. Проба без ответа закрывается шлюзом (handled).
//
// Та же сессия — без пробы (0.3.2; развилка R-4 а: проба — ход модели по всему контексту агента, а
// переподключение того же переходника — перезапуск шлюза, сон ноутбука, обрыв — его не требует). Переходник 0.3.2 при
// старте процесса заводит случайный instance_id и шлёт его в hello вместе с арендой, которую держал до обрыва
// (prev_lease). Шлюз помнит последнюю проверенную аренду в meta.last_lease: её id, SHA-256 instance_id (сам ключ — ни в
// базу, ни в журнал) и session_id сессии Claude Code в каталоге аренды (строка состояния, 5.14). Тот же instance_id, та
// же аренда, сессия не сменилась (или неизвестна) — «та же сессия» ⟨предл.⟩: новая аренда проверена сразу (lease_verified
// reason same_instance; meta.probes_saved +1), отданное прежней аренде без ответа не возвращается в new и не отдаётся
// снова — переходит к новой аренде со своим сроком повтора (в том же процессе шлюза — прежним, после перезапуска шлюза —
// заново, 10 мин). Поэтому проверенная аренда переходника, который назвал себя, при снятии отданное не возвращает, а
// старт шлюза оставляет отданное последней проверенной аренде; придёт другой переходник — его hello вернёт всё в new,
// как раньше. Сессия сменилась — /clear в том же процессе (session_id строки состояния новый): при переподключении —
// проба и возврат отданного, как у новой сессии; при живой аренде — повтор отданного прежнему разговору (redelivery: да)
// без пробы ⟨предл.⟩: процесс тот же, канал тот же, а разговор новый и прежних событий не видит. Переходник до 0.3.2 —
// как раньше: проба на каждую аренду.
//
// Сроки аренды — по часам шлюза (поддельным под тестом) и не раньше, чем у переходника была хотя бы 1 с настоящего
// времени ответить: поддельные часы тест двигает на минуты за миллисекунды — pong и done по сокету за это время не
// доходят. На настоящих часах это ничего не меняет (45 с ≫ 1 с). Скачок часов (сон ноутбука; переходник спал вместе со
// шлюзом) — ожидание pong и срок пробы начинаются заново, аренда не снимается.
//
// Отдача — по курсору аренды (№ больше последнего отданного), строго по порядку, порциями. Голосовое в распознавании
// держит следующие (5.8), но не дольше 90 с от записи: дальше они идут мимо него, а голосовое — когда готово. В stopped
// не отдаётся ничего.
//
// Повтор (К-5). У каждого отданного этой аренде — срок redeliver_after_minutes. Срок вышел, а события нет в processed:
// если после отдачи от аренды был хоть один вызов инструментов канала (reply, done, episode, episode_summary, where,
// rule) — сессия занята, повтор откладывается ещё на срок, но не больше 3 раз подряд (J-8: пропущенное моделью событие
// придёт снова, даже пока сессия работает); если вызовов не было или откладывать больше нельзя — событие отдаётся ещё
// раз, с redelivery: да (один раз). После повтора — так же: до 3 откладываний, затем строка владельцу (по сообщениям
// владельца; итог эпизода и возврат темы видны в «где мы»). Так же отдаётся и событие, которое ушло кадром, но delivered на него не пришёл (канал
// не толкнул его в сессию): курсор аренды его второй раз не возьмёт — его возвращает срок.
//
// Ответ = обработано (Оч-2): reply с seq одной транзакцией пишет ответ в outbox и ставит событию processed — если оно
// отдано этой аренде (Оч-6); ответ на событие, отданное не ей, уходит, а событие остаётся ждать своей отдачи. Ход
// (Оч-4): reply со старым turn — dropped_stale_turn (проверка первой: ответ хода, прерванного «стопом», — это он);
// любой reply в stopped — dropped_stopped. В паузе уходят только ответы на события этой аренды, ещё ждущие ответа;
// остальное — held. done(seqs) — только события этой аренды. reply с ключом повтора (idem), который уже принят, второй
// строки не даёт: обрыв связи посреди reply не удваивает ответ.
//
// «Печатает…» (5.5) — typing.ts: от delivered до ответа, не дольше 2 минут.
//
// Реакции на сообщении владельца (reactions.ts): delivered — 👀 «агент увидел» (и при повторной отдаче правки), reply на
// событие или done — 👌 «агент ответил». Агент не на связи — реакции нет.
//
// Картинки (0.3, media.ts): media(seq) — только проверенной аренде и только по сообщению, которое уже отдавалось
// агенту: этой аренде или прежней (после переподключения агент снова открывает фото, на которое ответил час назад;
// ⟨предл.⟩, развилка R-21); ещё не отданное (стоп, ждёт распознавания) — нет. Ответ — картинкой в base64 кадром до
// MAX_MEDIA_FRAME_BYTES. В кадре события — подсказка media {what, frame} (что можно посмотреть) и у звука файлом
// audio.source (аудиофайл, кружок, видео): прежний канал эти поля отбрасывает.
//
// Посылки (0.3.3, parcels.ts; P-23, issue #29): send_file(path, seq?) — проверенной аренде; ход, стоп, пауза, from,
// idem — как у reply; файл с seq — ответ на событие (обработано, 👌), без seq — по своей инициативе в личку владельца.
// Путь, копия, доставка — ParcelService; отказ — bad_request словами агенту и send_file_refused в журнал.
//
// Реакция владельца на ответ агента (0.3.4; P-31, issue #34): событие базы вида reaction отдаётся, как прочие, по
// порядку и в «стоп» ждёт; кадр — вида text с полем reaction {to_seq, emoji, old, excerpt} и текстом «Реакция на твой
// ответ к № M: 👍 — твой ответ: «…»»: прежний канал вида reaction не знает (его схема отбросила бы кадр целиком) и
// читает событие текстом, новый строит заголовок по полю. Ответ на реакцию не обязателен — done (инструкции канала); 👀
// и 👌 на ней нет, «агент молчит» о ней владельцу не пишется (не сообщение).
// Окно отмены реакции (0.3.4, issue #46; hold.ts): реакция в окне — held, курсор её не ждёт: сообщения и прочие
// события идут мимо неё, а сама она, когда окно прошло (held → new), отдаётся вне очереди (lease.skipped — как голосовое,
// распознававшееся дольше VOICE_HOLD_MS); отменённая в окне (cancelled) не отдаётся вовсе.
// Окно для материала без слов владельца (0.3.6, issue #51; material.ts, hold.ts) — тот же held: курсор его не ждёт.
// Слова владельца отпускают материал в той же транзакции, что их записывает, поэтому отдача идёт по № — материал, затем
// слова, подряд (материал, мимо которого курсор уже прошёл, — из lease.skipped первым). В кадре — поле material
// {words: after · before · none, words_seq, waited_ms}: канал пишет по нему пометку в заголовке; прежний канал поле
// отбрасывает.
//
// Правила канала (0.3.5, issue #47). Claude Code передаёт instructions MCP-сервера разговору только при первом
// подключении канала к нему: продолженный (--resume) разговор новых instructions не получает (описания инструментов
// обновляются), а разговор, начатый без канала, не получает их вовсе. Канал 0.3.5 называет в hello версию своих
// instructions (instructions_version — начало SHA-256 текста). Шлюз помнит, какую версию получил каждый разговор агента
// (таблица conversations; ключ — session_id строки состояния, 5.14, а если сессия неизвестна — SHA-256 instance_id
// процесса канала), и проверенной аренде, чей разговор не получал этой версии, отдаёт одно событие вида instructions —
// «правила канала» (offerInstructions): после проверки канала (verify), при той же сессии (grantSameSession), при смене
// или первой известной сессии у живой аренды (checkSession) и на where() агента. Событие служебное, как probe: мимо
// курсора, в «стоп» и в паузе тоже; текст правил подставляет канал (шлюз хранит только версию и ключ разговора —
// events.instructions_json). done на него — версия записана за разговором. Не ответил — повтор по сроку К-5, как у
// прочих; оборвалась связь — открытое событие правил отдаётся снова тому же разговору (новая аренда, перезапуск шлюза),
// а событие правил другого разговора закрывается (handled). Отданное этой арендой прежнему её разговору (сессия
// сменилась) остаётся открытым — done по нему засчитывается, повтором по сроку не отдаётся: за аренду разговору — не
// больше одного события, даже если строки состояния двух сессий чередуются. Новый разговор, которому Claude Code
// instructions уже дал, шлюз от продолженного не отличает: он тоже получает событие (лишний раз — безвредно) ⟨предл.⟩.

import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  getMeta,
  sql,
  audioFileOf,
  AGENT_EVENT_KINDS,
  LEASE_PING_MS,
  LEASE_PONG_TIMEOUT_MS,
  MAX_MEDIA_FRAME_BYTES,
  MESSAGE_EVENT_KINDS,
  META_KEYS,
  PROBE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  readMode,
  readProbesSaved,
  readTurn,
  instructionsWhereLine,
  ownerReactionText,
  relayNameProblem,
  setMeta,
  silentAgentNotice,
  transaction,
  viewableOf,
  type AdapterMessage,
  type Attachment,
  type DeferredRetryResult,
  type EventMessage,
  type ForwardInfo,
  type InstructionsState,
  type MaterialHold,
  type Mode,
  type OwnerReaction,
  type Timer,
} from 'stg-core';
import { enqueueServiceLine, insertOutbox, type Ctx } from './context.js';
import type { AgentResult, Control, Effects } from './control.js';
import type { Episodes } from './episodes.js';
import type { MediaService } from './media.js';
import type { ParcelService } from './parcels.js';
import { requestProcessed, requestSeen } from './reactions.js';
import type { GatewayConnection } from './socket-server.js';
import { Typing } from './typing.js';

/**
 * Откладываний повтора подряд — не больше (5.10, J-8): дальше событие отдаётся снова (или после повтора — строка
 * владельцу), даже если вызовы инструментов были. Срок 10 минут: повтор не позже 40 минут после отдачи.
 * ⟨предл.: число 3; ждёт решения — issue #40⟩
 */
export const REDELIVERY_MAX_POSTPONES = 3;

interface Tracked {
  /** Сколько вызовов инструментов было у аренды, когда начали ждать (отдача, повтор, откладывание). */
  calls: number;
  /** Когда проверить. */
  due: number;
  /** Повтор уже был. */
  redelivered: boolean;
  /** Откладываний подряд: вызовы были — сессия занята (после повтора счёт заново). */
  postponed: number;
  /**
   * Сессии Claude Code (session_id строки состояния), которым событие уже отдавалось (0.3.2): стала текущей сессия, которая
   * его не видела (/clear, /resume к прежнему разговору), — повтор ей (checkSession); видела — нет.
   */
  seen: Set<string>;
}

interface Lease {
  id: string;
  conn: GatewayConnection;
  adapter: string;
  hint: { cwd?: string | undefined; pid?: number | undefined } | null;
  since: number;
  /** Настоящее время начала (для «не раньше 1 с настоящего времени»). */
  sinceReal: number;
  /** done на probe получен. */
  verified: boolean;
  probeSeq: number | null;
  /**
   * Код проверочного события: он есть только в тексте события, которое дошло до сессии, — done на probe засчитывается
   * только с ним (номер пробы виден и без сессии канала). Только в памяти: ни в базу, ни в журнал.
   */
  probeCode: string;
  /** № событий, отданных этой аренде (кадр event ушёл). */
  pushed: Set<number>;
  /** Последний отданный №: следующая отдача — с номеров больше. */
  cursor: number;
  /**
   * Голосовые, мимо которых курсор прошёл, пока они распознавались дольше VOICE_HOLD_MS, и реакции владельца в окне отмены
   * (held, 0.3.4): отдаются, когда готовы (new); отменённая реакция (cancelled) выпадает.
   */
  skipped: Set<number>;
  /** Сроки повтора отданного (К-5). */
  track: Map<number, Tracked>;
  /** Вызовов инструментов канала от этой аренды — счётчик: были ли вызовы после отдачи (часы под тестом стоят). */
  calls: number;
  /** Последний вызов (часы шлюза) — для журнала. */
  lastCallAt: number;
  /** Ping без pong: когда ушёл (часы шлюза и настоящее время). */
  ping: { at: number; real: number } | null;
  /** SHA-256 instance_id переходника (0.3.2); null — переходник себя не назвал (до 0.3.2): как раньше, проба всегда. */
  instanceHash: string | null;
  /** Сессия Claude Code в каталоге аренды (session_id строки состояния, 5.14), какой её знает аренда; null — неизвестна. */
  session: string | null;
  /** session_id, уже виденные этой арендой (для журнала: вернулась прежняя — seen_before). */
  sessions: Set<string>;
  /** Версия instructions канала из hello (0.3.5, issue #47); null — канал до 0.3.5: событий правил нет. */
  instructions: string | null;
}

/**
 * Проверенная аренда переходника, который назвал себя, снятая обрывом (0.3.2): сроки повтора её отданного — до hello того
 * же процесса (в памяти; перезапуск шлюза их теряет — тогда срок заново).
 */
interface Parked {
  leaseId: string;
  instanceHash: string;
  track: Map<number, Tracked>;
}

/** meta.last_lease (0.3.2): последняя проверенная аренда. */
export interface LastLease {
  lease_id: string;
  /** SHA-256 instance_id; null — переходник до 0.3.2. */
  instance_hash: string | null;
  session_id: string | null;
  at: number;
}

/** Почему новой аренде проба (0.3.2, журнал lease_granted.probe_reason). */
export type ProbeReason = 'no_instance' | 'new_instance' | 'lease_unknown' | 'session_changed';

/** SHA-256 ключа процесса переходника: в базу — только он. */
export function instanceHashOf(instanceId: string): string {
  return crypto.createHash('sha256').update(instanceId).digest('hex');
}

/** Начало session_id — в журнал (весь не нужен). */
function sessionTag(id: string | null): string | null {
  return id === null ? null : id.slice(0, 8);
}

/** Кому событие отдано: текущей сессии аренды (неизвестна — пока никому). */
function seenBy(session: string | null): Set<string> {
  return new Set(session ? [session] : []);
}

/**
 * Разговор агента (0.3.5, issue #47) — ключ conversations: сессия Claude Code по строке состояния; неизвестна — процесс
 * канала (SHA-256 instance_id); канал до 0.3.2 себя не называет — null.
 */
function conversationKey(lease: { session: string | null; instanceHash: string | null }): string | null {
  if (lease.session) return `session:${lease.session}`;
  if (lease.instanceHash) return `instance:${lease.instanceHash}`;
  return null;
}

/** Ключ разговора — в журнал: вид и начало (весь не нужен). */
function conversationTag(key: string | null): string | null {
  if (key === null) return null;
  const i = key.indexOf(':');
  return `${key.slice(0, i)}:${key.slice(i + 1, i + 9)}`;
}

/** events.instructions_json (0.3.5): какую версию правил несёт событие и какому разговору оно отдано. */
interface InstructionsInfo {
  version: string;
  key: string;
}

function instructionsInfo(json: string | null | undefined): InstructionsInfo | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<InstructionsInfo>;
    return typeof v.version === 'string' && typeof v.key === 'string' ? { version: v.version, key: v.key } : null;
  } catch {
    return null;
  }
}

/** Что шлюз сделал с правилами канала для разговора аренды: none — не к чему (канал без версии, разговор не узнать). */
type InstructionsOffer = InstructionsState | { state: 'none' };

interface EventRow {
  seq: number;
  update_id: number | null;
  message_id: number | null;
  chat_id: number | null;
  thread_id: number | null;
  subject_id: string | null;
  trust: 'owner' | 'untrusted' | 'owner_forward' | null;
  mixed: number;
  attachments_json: string | null;
  kind: EventMessage['kind'];
  text: string | null;
  transcript: string | null;
  forward_json: string | null;
  reply_to: string | null;
  edit_of: number | null;
  episode_id: number | null;
  status: string;
  lease_id: string | null;
  attempts: number;
  /** Почему аудиофайл не распознан (схема v6). */
  stt_note?: string | null;
  /** Длительность аудиофайла по самому файлу (схема v7), если у Telegram её нет. */
  audio_seconds?: number | null;
  /** Когда событие отдано агенту (delivered); не сбрасывается при снятии аренды. */
  delivered_at?: number | null;
  /** Реакция владельца на ответ агента (схема v11; только у вида reaction). */
  reaction_json?: string | null;
  /** Правила канала (схема v12; только у вида instructions): {version, key}. */
  instructions_json?: string | null;
  /** Материал без слов владельца (схема v13, 0.3.6): MaterialHold. */
  material_json?: string | null;
}

/**
 * Материал без слов владельца (0.3.6, issue #51): слова пришли следом (after, № слов), были раньше (before) или окно
 * кончилось без них (none, сколько ждал). Отдаётся только отпущенный материал: в окне (waiting) он агенту не уходит.
 */
function materialField(ev: EventRow): { material?: NonNullable<EventMessage['material']> } {
  if (!ev.material_json) return {};
  const m = JSON.parse(ev.material_json) as MaterialHold;
  if (m.state === 'waiting') return {};
  return { material: { words: m.state, words_seq: m.words_seq ?? null, waited_ms: m.waited_ms ?? null } };
}

/**
 * Что отдаётся по курсору аренды: probe — нет (он свой у каждой аренды и уходит сразу после welcome); правила канала
 * (0.3.5) — тоже нет: они свои у разговора и уходят сами (offerInstructions).
 */
const PUMP_KINDS_SQL = AGENT_EVENT_KINDS.filter((k) => k !== 'probe' && k !== 'instructions')
  .map((k) => `'${k}'`)
  .join(',');
const MSG_KINDS_SQL = MESSAGE_EVENT_KINDS.map((k) => `'${k}'`).join(',');
/** Сколько событий отдавать за один проход. */
const PUMP_BATCH = 500;
/** Такт аренды: ping, сроки pong, пробы и повтора. */
export const LEASE_TICK_MS = LEASE_PING_MS;
/** Не раньше, чем у переходника была 1 с настоящего времени ответить (см. шапку). */
export const LEASE_REAL_GRACE_MS = 1_000;
/** Такт пришёл позже двух — часы прыгнули (сон): ожидание pong и срок пробы — заново. */
const LEASE_WAKE_GAP_MS = 2 * LEASE_TICK_MS;
/** Вызовы инструментов канала — признак «сессия занята» (К-5). delivered, ping, pong, hello — не вызовы модели. */
const TOOL_CALLS = new Set<AdapterMessage['type']>(['reply', 'done', 'episode', 'episode_summary', 'where', 'rule', 'media', 'send_file']);
/**
 * Голосовое в распознавании держит следующие события (5.8 ⟨предл.⟩) не дольше 90 с от записи: зависший провайдер не
 * выключает агента — текст «срочно» после голосовых уходит через ≤ 90 с, а голосовое — когда распознано или получен отказ.
 */
export const VOICE_HOLD_MS = 90_000;
/**
 * Отказ до проверки канала. Ни номера, ни кода пробы в нём нет: сессия без канала (событий не видит) не должна пройти
 * проверку, просто повторив за отказом (5.10).
 */
export const UNVERIFIED_REFUSAL = 'аренда не проверена: дождись проверочного события шлюза и ответь на него done с кодом из этого события';
/** Ключ повтора ответа (reply.idem) смотрится за сутки. */
const IDEM_WINDOW_MS = 24 * 3600_000;

/** Повтор отложенного обновления (5.3) — его делает приём (admission.ts). */
export type DeferredRetry = (
  updateId: number,
) => Promise<{ ok: true; result: DeferredRetryResult } | { ok: false; code: 'unknown_seq' | 'bad_request' | 'unavailable'; text: string }>;

export interface AdapterHooks {
  /**
   * В очереди отправки новое (ответ агента, объявление эпизода, строка владельцу, реакция 👌) или сменилось то, что видно
   * в закреплённой строке (агент на связи или нет, сколько ждут).
   */
  onReplyQueued(): void;
  /** Повтор отложенного — по запросу CLI. */
  retryDeferred?: DeferredRetry;
  /**
   * Агент что-то сделал инструментом канала — ответил (`reply`), отметил `done`, прислал итог эпизода: модель работает,
   * прежний отказ модели снят (5.14, D-6).
   */
  onAgentActivity?(): void;
  /**
   * Какая сессия Claude Code сейчас в каталоге cwd (0.3.2): session_id и время строки состояния agent-state.json с тем же
   * каталогом (5.14); null — не знаем (строка не подключена, другой каталог). По нему «та же сессия» и /clear.
   */
  sessionOf?(cwd: string | null): { id: string; at: number } | null;
}

export interface LeaseInfo {
  adapter: string;
  since: number;
  /** Проверена ли аренда (done на probe). Непроверенная — «на связи» не считается. */
  verified: boolean;
  /** Каталог сессии (session_hint.cwd канала): чья строка состояния — эта ли сессия (5.14). */
  cwd: string | null;
  /** Проверена без пробы: тот же переходник, та же сессия (0.3.2). */
  sameSession: boolean;
}

export class AdapterService {
  private lease: Lease | null = null;
  /** Аренда, проверенная без пробы (0.3.2), — для «статус». */
  private sameSessionLease: string | null = null;
  /** Снятая обрывом проверенная аренда того же процесса переходника (0.3.2): сроки повтора её отданного. */
  private parked: Parked | null = null;
  private pumpQueued = false;
  private closed = false;
  private timer: Timer | null = null;
  private lastTick: number;
  readonly typing: Typing;
  /** Картинки для агента (0.3); null — ещё не подключены (media отвечает unavailable). */
  private media: MediaService | null = null;
  private parcels: ParcelService | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly episodes: Episodes,
    private readonly control: Control,
    private readonly hooks: AdapterHooks,
  ) {
    this.typing = new Typing(ctx);
    this.lastTick = ctx.clock.now();
  }

  setRetryDeferred(fn: DeferredRetry): void {
    this.hooks.retryDeferred = fn;
  }

  /** Посылки (0.3.3): parcels.ts. */
  setParcels(parcels: ParcelService): void {
    this.parcels = parcels;
  }

  /** Картинки для агента (0.3): media.ts. */
  setMedia(media: MediaService): void {
    this.media = media;
  }

  /** Такт аренды: ping, сроки. */
  start(): void {
    this.lastTick = this.ctx.clock.now();
    this.timer ??= this.ctx.clock.setInterval(() => this.tick(), LEASE_TICK_MS);
  }

  /** Остановка шлюза: база закрывается — отложенная отдача больше не идёт. */
  close(): void {
    this.closed = true;
    this.timer?.cancel();
    this.timer = null;
    this.typing.stopAll();
  }

  /** Есть проверенная аренда — агент на связи (Ш-14, «где мы»). */
  get hasLease(): boolean {
    return this.lease?.verified === true;
  }

  /** Кто держит аренду — для «где мы» и «статус». */
  leaseInfo(): LeaseInfo | null {
    const l = this.lease;
    return l ? { adapter: l.adapter, since: l.since, verified: l.verified, cwd: l.hint?.cwd ?? null, sameSession: this.sameSessionLease === l.id } : null;
  }

  mode(): Mode {
    return readMode(this.ctx.db);
  }

  turn(): number {
    return readTurn(this.ctx.db);
  }

  private get redeliverMs(): number {
    return this.ctx.config.redeliver_after_minutes * 60_000;
  }

  /** Режим или ход сменились — кадр mode аренде (5.10): канал ставит новый turn в следующие reply. */
  notifyMode(): void {
    const lease = this.lease;
    if (this.closed || !lease) return;
    const state = this.mode();
    const turn = this.turn();
    if (state === 'stopped') this.typing.stopAll();
    lease.conn.send({ type: 'mode', state, turn });
    this.ctx.journal.write('mode_sent', { lease: lease.id, state, turn });
  }

  /** После COMMIT действия переходника: правила, отдача, кадр mode, отправитель. */
  private apply(effects: Effects): void {
    if (effects.rules) this.control.refreshRules();
    if (effects.mode) this.notifyMode();
    this.hooks.onReplyQueued();
    this.pump();
  }

  /**
   * При старте шлюза аренд нет: отданное прежнему процессу — снова new (5.10); пробы прежних аренд — закрыты. Отданное
   * последней проверенной аренде переходника, который назвал себя (meta.last_lease с instance_hash, 0.3.2), остаётся
   * delivered: тот же процесс переходника переподключится и продолжит без пробы и без повтора; придёт другой — его hello
   * вернёт всё в new.
   */
  resetDelivered(): { returned: number; kept: number } {
    return transaction(this.ctx.db, () => {
      sql(this.ctx.db, "UPDATE events SET status = 'handled' WHERE kind = 'probe' AND status IN ('new', 'delivered')").run();
      const last = this.lastLease();
      const keep = last?.instance_hash ? last.lease_id : null;
      const r = sql(this.ctx.db, "UPDATE events SET status = 'new', lease_id = NULL WHERE status = 'delivered' AND kind <> 'probe' AND lease_id IS NOT ?").run(keep);
      const kept = keep === null ? 0 : (sql(this.ctx.db, "SELECT count(*) AS n FROM events WHERE status = 'delivered' AND lease_id = ?").get(keep) as { n: number }).n;
      return { returned: Number(r.changes), kept };
    });
  }

  /** meta.last_lease (0.3.2); нет или испорчена — null. */
  private lastLease(): LastLease | null {
    const raw = getMeta(this.ctx.db, META_KEYS.lastLease);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Partial<LastLease>;
      if (typeof v.lease_id !== 'string') return null;
      return {
        lease_id: v.lease_id,
        instance_hash: typeof v.instance_hash === 'string' ? v.instance_hash : null,
        session_id: typeof v.session_id === 'string' ? v.session_id : null,
        at: typeof v.at === 'number' ? v.at : 0,
      };
    } catch {
      return null;
    }
  }

  /** Записать проверенную аренду в meta.last_lease. Внутри транзакции. */
  private saveLastLease(lease: Lease): void {
    const v: LastLease = { lease_id: lease.id, instance_hash: lease.instanceHash, session_id: lease.session, at: this.ctx.clock.now() };
    setMeta(this.ctx.db, META_KEYS.lastLease, JSON.stringify(v));
  }

  /** Какая сессия Claude Code сейчас в каталоге аренды (строка состояния, 5.14); null — не знаем. */
  private sessionNow(cwd: string | null): { id: string; at: number } | null {
    try {
      return this.hooks.sessionOf?.(cwd) ?? null;
    } catch {
      return null;
    }
  }

  /** Сообщение переходника. true — обработано здесь. */
  handle(msg: AdapterMessage, conn: GatewayConnection): boolean {
    if (this.lease && this.lease.conn === conn && TOOL_CALLS.has(msg.type)) {
      this.lease.calls++;
      this.lease.lastCallAt = this.ctx.clock.now();
    }
    switch (msg.type) {
      case 'hello':
        this.onHello(msg, conn);
        return true;
      case 'delivered':
        this.onDelivered(msg, conn);
        return true;
      case 'reply':
        this.onReply(msg, conn);
        return true;
      case 'done':
        this.onDone(msg, conn);
        return true;
      case 'episode':
        this.onEpisode(msg, conn);
        return true;
      case 'episode_summary':
        this.onSummary(msg, conn);
        return true;
      case 'where':
        this.onWhere(msg, conn);
        return true;
      case 'rule':
        this.onRule(msg, conn);
        return true;
      case 'deferred_retry':
        this.onDeferredRetry(msg, conn);
        return true;
      case 'media':
        this.onMedia(msg, conn);
        return true;
      case 'send_file':
        this.onSendFile(msg, conn);
        return true;
      default:
        return false;
    }
  }

  /** pong от переходника: ожидание снято. */
  onPong(conn: GatewayConnection): void {
    if (this.lease?.conn === conn) this.lease.ping = null;
  }

  private answer(conn: GatewayConnection, reqId: string, r: AgentResult | { ok: true; result: unknown; effects: Effects }): void {
    if (!r.ok) {
      conn.send({ type: 'error', req_id: reqId, code: r.code, text: r.text });
      return;
    }
    conn.send({ type: 'ack', req_id: reqId, result: r.result });
    this.apply(r.effects);
  }

  /** episode (5.7, 5.10): тему называет и меняет агент; роль — нет (её отсекает разбор кадра). */
  private onEpisode(msg: Extract<AdapterMessage, { type: 'episode' }>, conn: GatewayConnection): void {
    if (!this.verifiedLease(conn, msg.req_id)) return;
    this.answer(conn, msg.req_id, this.control.agentEpisode(msg.action, msg.topic, msg.reason));
  }

  private onSummary(msg: Extract<AdapterMessage, { type: 'episode_summary' }>, conn: GatewayConnection): void {
    if (!this.verifiedLease(conn, msg.req_id)) return;
    const r = this.control.agentSummary(msg.episode_id, msg.text);
    if (r.ok) this.hooks.onAgentActivity?.();
    this.answer(conn, msg.req_id, r);
  }

  /**
   * rule (5.9, 5.10): сужение — сразу, расширение — карточка владельцу с кнопками. Как и episode, — только проверенной
   * аренде. Сужение действует до ack: справочник пересобран раньше, чем агент узнал «применено». Отказ (владельца не
   * убрать) несёт строку владельцу — отправителю нужно знать.
   */
  private onRule(msg: Extract<AdapterMessage, { type: 'rule' }>, conn: GatewayConnection): void {
    if (!this.verifiedLease(conn, msg.req_id)) return;
    const r = this.control.agentRule(msg.change);
    if (r.ok && r.effects.rules) this.control.refreshRules();
    this.answer(conn, msg.req_id, r);
    if (!r.ok) this.hooks.onReplyQueued();
  }

  /**
   * where — только чтение: и переходнику с арендой, и CLI (role cli), и без hello. Агенту (проверенная аренда этого
   * соединения, канал назвал версию правил) — ещё строка о правилах канала (0.3.5, issue #47): этот разговор их получил,
   * событие ждёт done или — не получал — событие отдано сейчас.
   */
  private onWhere(msg: Extract<AdapterMessage, { type: 'where' }>, conn: GatewayConnection): void {
    const w = this.control.where();
    const lease = this.lease?.conn === conn && this.lease.verified ? this.lease : null;
    const offer = lease ? this.offerInstructionsSafe(lease, 'where') : ({ state: 'none' } as const);
    const text = offer.state === 'none' ? w.text : `${w.text}\n${instructionsWhereLine(offer)}`;
    conn.send({ type: 'where_result', req_id: msg.req_id, text, data: w.data });
  }

  /**
   * media (0.3): картинка события — только проверенной аренде и только сообщению, которое уже отдавалось агенту (этой
   * аренде или прежней ⟨предл.⟩, R-21). Агент у шлюза один, аренда проверена пробой; после сна ноутбука или перезапуска
   * шлюза аренда новая, а фото — то же. Ещё не отданное (стоп, ждёт распознавания) — нет: агент не заглядывает в очередь
   * раньше отдачи. Скачивание идёт после ответа на кадр (async): приём и отдача его не ждут; соединение закрылось — ответ
   * некуда отдавать.
   */
  private onMedia(msg: Extract<AdapterMessage, { type: 'media' }>, conn: GatewayConnection): void {
    const lease = this.verifiedLease(conn, msg.req_id);
    if (!lease) return;
    const ev = this.event(msg.seq);
    if (!ev || !(MESSAGE_EVENT_KINDS as readonly string[]).includes(ev.kind)) {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'unknown_seq', text: `нет сообщения № ${msg.seq}` });
      return;
    }
    const given = this.ownsEvent(lease, ev) || (ev.delivered_at ?? null) !== null || ev.status === 'processed';
    if (!given) {
      this.ctx.journal.write('media_refused', { seq: ev.seq, lease: lease.id, reason: 'not_delivered' });
      conn.send({ type: 'error', req_id: msg.req_id, code: 'not_your_lease', text: `№ ${ev.seq} агенту ещё не отдавался` });
      return;
    }
    const media = this.media;
    if (!media) {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'unavailable', text: 'картинки ещё не подключены — повтори позже' });
      return;
    }
    void media.view(ev.seq).then(
      (r) => {
        if (r.ok) conn.send({ type: 'ack', req_id: msg.req_id, result: r.result }, MAX_MEDIA_FRAME_BYTES);
        else conn.send({ type: 'error', req_id: msg.req_id, code: r.code, text: r.text });
      },
      (err: unknown) => {
        this.ctx.journal.write('media_failed', { seq: ev.seq, error: (err as Error).message });
        conn.send({ type: 'error', req_id: msg.req_id, code: 'unavailable', text: `картинка не получилась: ${(err as Error).message}` });
      },
    );
  }

  /** stg deferred retry (5.3): повтор отложенного — только CLI; в базу пишет шлюз. */
  private onDeferredRetry(msg: Extract<AdapterMessage, { type: 'deferred_retry' }>, conn: GatewayConnection): void {
    if (conn.role !== 'cli') {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'bad_request', text: 'повтор отложенного — только из stg (hello role cli)' });
      return;
    }
    const retry = this.hooks.retryDeferred;
    if (!retry) {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'unavailable', text: 'приём ещё не запущен (нет токена бота) — повтори позже' });
      return;
    }
    void retry(msg.update_id).then(
      (r) => {
        if (r.ok) conn.send({ type: 'ack', req_id: msg.req_id, result: r.result });
        else conn.send({ type: 'error', req_id: msg.req_id, code: r.code, text: r.text });
        this.hooks.onReplyQueued();
        this.pump();
      },
      (err: unknown) => {
        conn.send({ type: 'error', req_id: msg.req_id, code: 'unavailable', text: `повтор не удался: ${(err as Error).message}` });
      },
    );
  }

  /** Соединение закрыто: аренда снята, отданное без «обработано» — снова new. */
  onClose(conn: GatewayConnection): void {
    if (this.lease?.conn !== conn) return;
    this.release(this.lease, 'closed');
  }

  /**
   * Снять аренду. Сначала в памяти (не прошла запись — диск полон — отданное вернёт в new следующая аренда), потом в
   * базе: её проба — handled; отданное этой аренде — new. Проверенная аренда переходника, который назвал себя (0.3.2),
   * отданное не возвращает: тот же процесс переподключится и продолжит без повтора (сроки — в this.parked); придёт
   * другой — его hello вернёт всё в new.
   */
  private release(lease: Lease, reason: string): void {
    if (this.lease === lease) this.lease = null;
    if (this.sameSessionLease === lease.id) this.sameSessionLease = null;
    this.typing.stopAll();
    const park = lease.verified && lease.instanceHash !== null;
    if (park) this.parked = { leaseId: lease.id, instanceHash: lease.instanceHash!, track: lease.track };
    const r = transaction(this.ctx.db, () => {
      sql(this.ctx.db, "UPDATE events SET status = 'handled' WHERE kind = 'probe' AND status IN ('new', 'delivered') AND lease_id = ?").run(lease.id);
      if (park) return { returned: 0, kept: (sql(this.ctx.db, "SELECT count(*) AS n FROM events WHERE status = 'delivered' AND lease_id = ?").get(lease.id) as { n: number }).n };
      const u = sql(this.ctx.db, "UPDATE events SET status = 'new', lease_id = NULL WHERE status = 'delivered' AND lease_id = ? AND kind <> 'probe'").run(lease.id);
      return { returned: Number(u.changes), kept: 0 };
    });
    this.ctx.journal.write('lease_released', {
      lease: lease.id,
      adapter: lease.adapter,
      reason,
      verified: lease.verified,
      returned: r.returned,
      ...(park ? { kept_for_session: r.kept } : {}),
    });
    // «агент не на связи» — в закреплённой строке.
    if (lease.verified) this.hooks.onReplyQueued();
  }

  private onHello(msg: Extract<AdapterMessage, { type: 'hello' }>, conn: GatewayConnection): void {
    if (msg.version !== PROTOCOL_VERSION) {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'version_mismatch', text: `протокол шлюза v${PROTOCOL_VERSION}, у переходника v${msg.version}` });
      conn.close();
      return;
    }
    if (msg.role === 'cli') {
      conn.role = 'cli';
      conn.send({ type: 'ack', req_id: msg.req_id, result: { role: 'cli' } });
      return;
    }
    conn.role = 'adapter';
    const instanceHash = msg.instance_id !== undefined ? instanceHashOf(msg.instance_id) : null;
    const cur = this.lease;
    if (cur && cur.conn !== conn && cur.conn.alive) {
      // Тот же процесс переходника со своей проверенной арендой (0.3.2): прежнее соединение ещё не закрылось у шлюза (сон,
      // полуоткрытый сокет), а переходник уже переподключился — прежнее закрыть, аренду снять, дальше — как та же сессия.
      const sameProcess = cur.verified && instanceHash !== null && cur.instanceHash === instanceHash && msg.prev_lease === cur.id;
      if (cur.verified && !sameProcess) {
        conn.send({
          type: 'error',
          req_id: msg.req_id,
          code: 'busy',
          text: 'очередь держит другая сессия',
          holder: cur.adapter,
          since: cur.since,
        });
        conn.close();
        return;
      }
      if (sameProcess) {
        cur.conn.destroy();
        this.release(cur, 'replaced');
      } else {
        // Предварительную аренду (проверка канала не пройдена) новый hello вытесняет (5.10).
        cur.conn.send({ type: 'error', req_id: null, code: 'busy', text: 'аренду взяла другая сессия: проверочное событие осталось без ответа', holder: msg.adapter, since: this.ctx.clock.now() });
        cur.conn.close();
        this.release(cur, 'displaced');
      }
    } else if (cur) {
      // Прежняя аренда — то же соединение (повторный hello) или мёртвое: снять.
      this.release(cur, cur.conn === conn ? 'rehello' : 'dead');
    }
    const now = this.ctx.clock.now();
    const id = crypto.randomUUID();
    const hint = msg.session_hint ?? null;
    // Та же сессия (0.3.2, R-4 а): тот же процесс переходника (instance_id), та аренда, что он держал, — последняя
    // проверенная, и сессия Claude Code в его каталоге не сменилась (или неизвестна — тогда держимся за процесс ⟨предл.⟩).
    const last = this.lastLease();
    const nowSession = this.sessionNow(hint?.cwd ?? null);
    let probeReason: ProbeReason | null = null;
    if (instanceHash === null) probeReason = 'no_instance';
    else if (!last || last.instance_hash !== instanceHash || msg.prev_lease === undefined || last.lease_id !== msg.prev_lease) {
      probeReason = msg.prev_lease === undefined ? 'new_instance' : 'lease_unknown';
    } else if (last.session_id !== null && nowSession !== null && nowSession.id !== last.session_id) probeReason = 'session_changed';
    if (probeReason === null) {
      this.grantSameSession(msg, conn, id, instanceHash!, last!, nowSession);
      return;
    }
    const probeCode = crypto.randomBytes(4).toString('hex');
    // Одной записью: отданное прежним арендам — снова new, их пробы закрыты; проба новой аренды. Запись не прошла —
    // аренды нет, переходнику ошибка (сокет: «повтори позже»).
    const { returned, probeSeq } = transaction(this.ctx.db, () => {
      sql(this.ctx.db, "UPDATE events SET status = 'handled' WHERE kind = 'probe' AND status IN ('new', 'delivered')").run();
      const r = sql(this.ctx.db, "UPDATE events SET status = 'new', lease_id = NULL WHERE status = 'delivered' AND kind <> 'probe'").run();
      const p = sql(this.ctx.db, "INSERT INTO events(kind, status, lease_id, delivered_at, attempts, created_at) VALUES ('probe', 'delivered', ?, ?, 1, ?)").run(id, now, now);
      return { returned: Number(r.changes), probeSeq: Number(p.lastInsertRowid) };
    });
    this.parked = null;
    const lease = this.newLease(id, conn, msg.adapter, hint, now, instanceHash, false, probeSeq, probeCode, msg.instructions_version ?? null);
    lease.pushed.add(probeSeq);
    // Сессия, какой её видно сейчас: при проверке пробой — она и записывается.
    lease.session = nowSession?.id ?? null;
    if (lease.session) lease.sessions.add(lease.session);
    this.lease = lease;
    this.ctx.journal.write('lease_granted', {
      lease: id,
      adapter: msg.adapter,
      hint,
      returned,
      probe: probeSeq,
      probe_reason: probeReason,
      ...(msg.instructions_version !== undefined ? { instructions: msg.instructions_version } : {}),
      ...(probeReason === 'session_changed' ? { session_from: sessionTag(last?.session_id ?? null), session_to: sessionTag(nowSession?.id ?? null) } : {}),
    });
    conn.send({ type: 'welcome', req_id: msg.req_id, lease_id: id, mode: this.mode(), turn: this.turn() });
    conn.send(this.probeFrame(probeSeq, probeCode));
  }

  private newLease(
    id: string,
    conn: GatewayConnection,
    adapter: string,
    hint: Lease['hint'],
    now: number,
    instanceHash: string | null,
    verified: boolean,
    probeSeq: number | null,
    probeCode: string,
    instructions: string | null = null,
  ): Lease {
    return {
      id,
      conn,
      adapter,
      hint,
      since: now,
      sinceReal: performance.now(),
      verified,
      probeSeq,
      probeCode,
      pushed: new Set(),
      cursor: 0,
      skipped: new Set(),
      track: new Map(),
      calls: 0,
      lastCallAt: Number.NEGATIVE_INFINITY,
      ping: null,
      instanceHash,
      session: null,
      sessions: new Set(),
      instructions,
    };
  }

  /**
   * Та же сессия (0.3.2, R-4 а): аренда проверена сразу, пробы нет — хода модели нет. Отданное прежней аренде этого
   * процесса без ответа переходит к новой и не отдаётся снова (срок повтора — прежний, если шлюз не перезапускался, иначе
   * заново); отданное другим арендам (их уже нет) — new, как всегда. meta.probes_saved +1.
   */
  private grantSameSession(
    msg: Extract<AdapterMessage, { type: 'hello' }>,
    conn: GatewayConnection,
    id: string,
    instanceHash: string,
    last: LastLease,
    nowSession: { id: string; at: number } | null,
  ): void {
    const now = this.ctx.clock.now();
    const hint = msg.session_hint ?? null;
    const lease = this.newLease(id, conn, msg.adapter, hint, now, instanceHash, true, null, '', msg.instructions_version ?? null);
    lease.session = nowSession?.id ?? last.session_id;
    if (lease.session) lease.sessions.add(lease.session);
    const prev = last.lease_id;
    const { returned, adopted } = transaction(this.ctx.db, () => {
      sql(this.ctx.db, "UPDATE events SET status = 'handled' WHERE kind = 'probe' AND status IN ('new', 'delivered')").run();
      const r = sql(this.ctx.db, "UPDATE events SET status = 'new', lease_id = NULL WHERE status = 'delivered' AND kind <> 'probe' AND lease_id IS NOT ?").run(prev);
      const rows = sql(this.ctx.db, "SELECT seq FROM events WHERE status = 'delivered' AND lease_id = ? AND kind <> 'probe' ORDER BY seq").all(prev) as Array<{ seq: number }>;
      sql(this.ctx.db, "UPDATE events SET lease_id = ? WHERE status = 'delivered' AND lease_id = ? AND kind <> 'probe'").run(id, prev);
      this.saveLastLease(lease);
      const saved = readProbesSaved(getMeta(this.ctx.db, META_KEYS.probesSaved));
      setMeta(this.ctx.db, META_KEYS.probesSaved, JSON.stringify({ n: (saved?.n ?? 0) + 1, since: saved?.since ?? now, last_at: now }));
      setMeta(this.ctx.db, META_KEYS.offlineNotice, '0');
      setMeta(this.ctx.db, META_KEYS.channelUnverified, null);
      return { returned: Number(r.changes), adopted: rows.map((x) => x.seq) };
    });
    // Сроки повтора отданного: в том же процессе шлюза — прежние (снятие их сохранило), после перезапуска — заново.
    const parked = this.parked?.leaseId === prev ? this.parked : null;
    this.parked = null;
    for (const seq of adopted) {
      lease.pushed.add(seq);
      const t = parked?.track.get(seq);
      // Кому отдавалось: из прежней аренды того же процесса шлюза; после его перезапуска — сессии, какой её знает аренда.
      lease.track.set(seq, t ? { ...t, calls: 0 } : { calls: 0, due: now + this.redeliverMs, redelivered: false, postponed: 0, seen: seenBy(lease.session) });
    }
    this.lease = lease;
    this.sameSessionLease = id;
    this.ctx.journal.write('lease_granted', {
      lease: id,
      adapter: msg.adapter,
      hint,
      returned,
      probe: null,
      same_session: true,
      prev_lease: prev,
      adopted,
      ...(msg.instructions_version !== undefined ? { instructions: msg.instructions_version } : {}),
    });
    conn.send({ type: 'welcome', req_id: msg.req_id, lease_id: id, mode: this.mode(), turn: this.turn() });
    this.ctx.journal.write('lease_verified', { lease: id, adapter: msg.adapter, after_ms: 0, reason: 'same_instance', session: sessionTag(lease.session) });
    // Правила канала разговору, который их не получал (0.3.5), — раньше накопленного.
    this.offerInstructionsSafe(lease, 'same_session');
    this.pump();
    this.hooks.onReplyQueued();
  }

  private probeFrame(seq: number, code: string | undefined): EventMessage {
    return {
      type: 'event',
      seq,
      kind: 'probe',
      trust: null,
      mixed: false,
      text: null,
      transcript: null,
      attachments: [],
      forward: null,
      reply_to: null,
      edit_of: null,
      chat: null,
      subject: null,
      episode: null,
      redelivery: false,
      ...(code !== undefined ? { code } : {}),
    };
  }

  /** done на probe: аренда проверена — агент на связи, отдача пошла. */
  private verify(lease: Lease): void {
    if (lease.verified) return;
    lease.verified = true;
    // Сессия, какой её видно сейчас (0.3.2): по ней следующее переподключение того же процесса узнает «ту же сессию».
    const s = this.sessionNow(lease.hint?.cwd ?? null);
    if (s) {
      lease.session = s.id;
      lease.sessions.add(s.id);
    }
    // Агент побывал на связи — строка «не на связи» снова возможна (Ш-14); проверка канала пройдена; последняя проверенная
    // аренда — эта (0.3.2). Диск полон — не беда: отметки догонят при следующей аренде, отдача от них не зависит.
    try {
      transaction(this.ctx.db, () => {
        setMeta(this.ctx.db, META_KEYS.offlineNotice, '0');
        setMeta(this.ctx.db, META_KEYS.channelUnverified, null);
        this.saveLastLease(lease);
      });
    } catch (err) {
      if (!this.ctx.disk.check(err, 'lease_verify')) throw err;
    }
    this.ctx.journal.write('lease_verified', { lease: lease.id, adapter: lease.adapter, after_ms: this.ctx.clock.now() - lease.since, reason: 'probe', session: sessionTag(lease.session) });
    // Правила канала разговору, который их не получал (0.3.5), — раньше накопленного.
    this.offerInstructionsSafe(lease, 'verified');
    this.pump();
    // «агент на связи» — в закреплённой строке.
    this.hooks.onReplyQueued();
  }

  /**
   * Сменилась ли сессия Claude Code у живой аренды (0.3.2): строка состояния каталога аренды пришла с другим session_id —
   * /clear или /resume в том же процессе: процесс переходника и канал те же, а разговор другой. Отданное без ответа,
   * которого этот разговор не видел (сессии нет в Tracked.seen, и отдано раньше его строки состояния), отдаётся снова с
   * redelivery: да, без пробы ⟨предл.⟩ — проба проверила бы канал процесса, а он не менялся. Вернулась уже виденная
   * сессия (/resume S1 → S2 → S1) — ей повторяется то, что ушло, пока её не было; то, что она видела, — нет. Каждое
   * событие — не больше одного повтора на сессию: две сессии в одном каталоге, чьи строки состояния чередуются, дают не
   * больше одного лишнего повтора на событие. Зовёт наблюдатель agent-state.json (main.ts) при каждой смене файла.
   */
  checkSession(): void {
    const lease = this.lease;
    if (this.closed || !lease || !lease.verified) return;
    const s = this.sessionNow(lease.hint?.cwd ?? null);
    if (!s || s.id === lease.session) return;
    const prev = lease.session;
    const seenBefore = lease.sessions.has(s.id);
    lease.session = s.id;
    lease.sessions.add(s.id);
    try {
      transaction(this.ctx.db, () => this.saveLastLease(lease));
    } catch (err) {
      if (!this.ctx.disk.check(err, 'lease_session')) throw err;
    }
    // Первая известная сессия аренды (строка состояния ещё не приходила): отданное ушло ей — не повод для повтора. Правила
    // канала, отданные процессу (сессии не знали — ключ instance), — тоже её (0.3.5): ключ разговора — теперь сессия.
    if (prev === null) {
      for (const t of lease.track.values()) t.seen.add(s.id);
      this.ctx.journal.write('agent_session', { lease: lease.id, session: sessionTag(s.id) });
      this.instructionsToSession(lease, s.id);
      this.offerInstructionsSafe(lease, 'session_known');
      return;
    }
    const resent = this.resendForSession(lease, s.id, s.at);
    this.ctx.journal.write('agent_session_changed', {
      lease: lease.id,
      from: sessionTag(prev),
      to: sessionTag(s.id),
      since: s.at,
      resent,
      ...(seenBefore ? { seen_before: true } : {}),
    });
    // Другой разговор — свои правила канала (0.3.5): не получал этой версии — событие ему.
    this.offerInstructionsSafe(lease, 'session_changed');
  }

  /**
   * Сессия аренды стала известна (0.3.5): правила канала, записанные за процессом канала (ключ instance), — за этой
   * сессией, если у неё своей записи нет или своя не новее (процесс подтвердил правила позже, чем сессия когда-то
   * раньше); открытое событие правил процесса — теперь её. Ошибка записи — не беда: событие правил придёт ещё раз.
   */
  private instructionsToSession(lease: Lease, sessionId: string): void {
    if (lease.instanceHash === null || lease.instructions === null) return;
    const from = `instance:${lease.instanceHash}`;
    const to = `session:${sessionId}`;
    try {
      transaction(this.ctx.db, () => {
        sql(this.ctx.db,
          `INSERT INTO conversations(key, instructions, seq, at) SELECT ?, instructions, seq, at FROM conversations WHERE key = ?
           ON CONFLICT(key) DO UPDATE SET instructions = excluded.instructions, seq = excluded.seq, at = excluded.at
           WHERE excluded.at >= conversations.at`,
        ).run(to, from);
        sql(this.ctx.db,
          `UPDATE events SET instructions_json = json_set(instructions_json, '$.key', ?)
           WHERE kind = 'instructions' AND status IN ('new', 'delivered') AND json_extract(instructions_json, '$.key') = ?`,
        ).run(to, from);
      });
    } catch (err) {
      if (!this.ctx.disk.check(err, 'instructions_session')) throw err;
    }
  }

  /** Записанные правила канала разговора (0.3.5); нет — null. */
  private conversationInstructions(key: string): { instructions: string; seq: number | null } | null {
    return (sql(this.ctx.db, 'SELECT instructions, seq FROM conversations WHERE key = ?').get(key) as { instructions: string; seq: number | null } | undefined) ?? null;
  }

  /**
   * Правила канала разговору аренды (0.3.5, issue #47; шапка). Получил эту версию — ничего (current). Открытое событие
   * правил ему и этой версии уже у аренды — ждёт done (pending); у прежней аренды (обрыв, перезапуск шлюза) — отдать
   * снова этой, с redelivery. Иначе — новое событие (sent). Открытые события правил другим разговорам или другой версии,
   * которых эта аренда не отдавала, закрываются (handled): разговор у аренды один. Отданные этой арендой другим её
   * разговорам (сессия сменилась) остаются открытыми: они в том же потоке канала, и done по ним засчитывается, — так
   * строки состояния двух сессий в одном каталоге, чередуясь, дают не больше одного события на разговор за аренду.
   * Проверенной аренде; в «стоп» и паузе — тоже (служебное, как probe).
   */
  private offerInstructions(lease: Lease, trigger: string): InstructionsOffer {
    const version = lease.instructions;
    const key = conversationKey(lease);
    if (this.closed || !lease.verified || version === null || key === null) return { state: 'none' };
    const rec = this.conversationInstructions(key);
    if (rec?.instructions === version) return { state: 'current', version, seq: rec.seq };
    const open = sql(this.ctx.db, "SELECT * FROM events WHERE kind = 'instructions' AND status IN ('new', 'delivered') ORDER BY seq").all() as unknown as EventRow[];
    const fits = (ev: EventRow): boolean => {
      const info = instructionsInfo(ev.instructions_json);
      return info?.key === key && info.version === version;
    };
    // Своё (отданное этой арендой) — первым: второе событие тому же разговору за аренду не создаётся.
    const same = open.find((ev) => fits(ev) && this.ownsEvent(lease, ev)) ?? open.find(fits) ?? null;
    const stale = open.filter((ev) => ev !== same && !this.ownsEvent(lease, ev)).map((ev) => ev.seq);
    const now = this.ctx.clock.now();
    const seq = transaction(this.ctx.db, () => {
      if (stale.length) sql(this.ctx.db, "UPDATE events SET status = 'handled' WHERE seq IN (SELECT value FROM json_each(?))").run(JSON.stringify(stale));
      if (same) return same.seq;
      const r = sql(this.ctx.db, "INSERT INTO events(kind, status, attempts, created_at, instructions_json) VALUES ('instructions', 'new', 0, ?, ?)").run(
        now,
        JSON.stringify({ version, key }),
      );
      return Number(r.lastInsertRowid);
    });
    for (const st of stale) lease.track.delete(st);
    if (stale.length) this.ctx.journal.write('instructions_closed', { seqs: stale, lease: lease.id, reason: 'other_conversation_or_version' });
    if (same && this.ownsEvent(lease, same)) return { state: 'pending', version, seq: same.seq };
    const ev = this.event(seq);
    if (!ev) return { state: 'none' };
    lease.pushed.add(seq);
    lease.track.set(seq, { calls: lease.calls, due: now + this.redeliverMs, redelivered: false, postponed: 0, seen: seenBy(lease.session) });
    this.ctx.journal.write('instructions_offered', {
      seq,
      lease: lease.id,
      version,
      conversation: conversationTag(key),
      had: rec?.instructions ?? null,
      trigger,
      ...(same ? { again: true } : {}),
    });
    lease.conn.send(this.frame(ev, same !== null));
    return { state: 'sent', version, seq };
  }

  /** offerInstructions из такта аренды: диск полон — не беда, правила придут при следующей возможности. */
  private offerInstructionsSafe(lease: Lease, trigger: string): InstructionsOffer {
    try {
      return this.offerInstructions(lease, trigger);
    } catch (err) {
      if (!this.ctx.disk.check(err, 'instructions_offer')) throw err;
      return { state: 'none' };
    }
  }

  /**
   * Отданное, которого сессия sid не видела, — ей снова, с redelivery: да (checkSession). Отдано после её строки состояния
   * (since) — видела. В stopped — нет: отдача ждёт [продолжить], повтор — по сроку К-5.
   */
  private resendForSession(lease: Lease, sid: string, since: number): number[] {
    if (this.mode() === 'stopped') return [];
    const now = this.ctx.clock.now();
    const resent: number[] = [];
    for (const [seq, t] of lease.track) {
      const ev = this.event(seq);
      if (!ev || (ev.status !== 'new' && ev.status !== 'delivered')) {
        lease.track.delete(seq);
        continue;
      }
      // Правила канала — свои у каждого разговора (0.3.5): новому — offerInstructions, а не повтор чужих.
      if (ev.kind === 'instructions') continue;
      if (t.seen.has(sid) || ((ev.delivered_at ?? null) !== null && ev.delivered_at! >= since)) {
        t.seen.add(sid);
        continue;
      }
      t.seen.add(sid);
      t.redelivered = true;
      t.calls = lease.calls;
      t.due = now + this.redeliverMs;
      t.postponed = 0;
      lease.conn.send(this.frame(ev, true));
      resent.push(seq);
    }
    return resent;
  }

  /**
   * Отдать проверенной аренде все события new по порядку. Голосовое в распознавании держит следующие (5.8), но не
   * дольше VOICE_HOLD_MS от записи: дальше следующие идут мимо него, а оно само отдаётся, когда распознано или получен
   * отказ (lease.skipped). Реакция в окне отмены (held, 0.3.4) не держит никого: курсор идёт мимо, она — в lease.skipped
   * и отдаётся, когда окно прошло.
   */
  pump(): void {
    const lease = this.lease;
    if (this.closed || !lease || !lease.verified || this.mode() === 'stopped') return;
    const now = this.ctx.clock.now();
    const send = (ev: EventRow): void => {
      lease.pushed.add(ev.seq);
      lease.track.set(ev.seq, { calls: lease.calls, due: now + this.redeliverMs, redelivered: false, postponed: 0, seen: seenBy(lease.session) });
      lease.conn.send(this.frame(ev));
    };
    if (lease.skipped.size) {
      const ids = JSON.stringify([...lease.skipped]);
      const ready = sql(this.ctx.db, "SELECT * FROM events WHERE status = 'new' AND seq IN (SELECT value FROM json_each(?)) ORDER BY seq").all(ids) as unknown as EventRow[];
      for (const ev of ready) {
        lease.skipped.delete(ev.seq);
        send(ev);
      }
      const still = new Set(
        (sql(this.ctx.db, "SELECT seq FROM events WHERE status IN ('transcribing', 'held') AND seq IN (SELECT value FROM json_each(?))").all(ids) as Array<{ seq: number }>).map((r) => r.seq),
      );
      for (const seq of lease.skipped) if (!still.has(seq)) lease.skipped.delete(seq);
    }
    const barrier = sql(this.ctx.db, `SELECT min(seq) AS s FROM events WHERE status = 'transcribing' AND kind IN (${PUMP_KINDS_SQL}) AND seq > ? AND created_at > ?`)
      .get(lease.cursor, now - VOICE_HOLD_MS) as { s: number | null };
    const from = lease.cursor;
    const rows = sql(this.ctx.db, `SELECT * FROM events WHERE status = 'new' AND kind IN (${PUMP_KINDS_SQL}) AND seq > ? AND seq < ? ORDER BY seq LIMIT ${PUMP_BATCH}`)
      .all(from, barrier.s ?? Number.MAX_SAFE_INTEGER) as unknown as EventRow[];
    for (const ev of rows) {
      lease.cursor = ev.seq;
      send(ev);
    }
    if (rows.length) {
      // Голосовые, мимо которых прошёл курсор (распознаются дольше VOICE_HOLD_MS), — отдать, когда будут готовы.
      const passed = sql(this.ctx.db, `SELECT seq, created_at FROM events WHERE status = 'transcribing' AND kind IN (${PUMP_KINDS_SQL}) AND seq > ? AND seq < ?`)
        .all(from, lease.cursor) as Array<{ seq: number; created_at: number }>;
      for (const p of passed) {
        lease.skipped.add(p.seq);
        this.ctx.journal.write('voice_hold_released', { seq: p.seq, lease: lease.id, held_ms: now - p.created_at });
      }
      // Реакции в окне отмены (0.3.4): окно не держит остальных — отдать, когда окно пройдёт (held → new).
      const held = sql(this.ctx.db, "SELECT seq FROM events WHERE status = 'held' AND seq > ? AND seq < ?").all(from, lease.cursor) as Array<{ seq: number }>;
      for (const h of held) lease.skipped.add(h.seq);
    }
    // Есть ещё — следующая порция после того, как поток освободится (приём не ждёт отдачи тысяч событий разом).
    if (rows.length === PUMP_BATCH && !this.pumpQueued) {
      this.pumpQueued = true;
      setImmediate(() => {
        this.pumpQueued = false;
        this.pump();
      });
    }
  }

  // ——— такт аренды ———

  private tick(): void {
    const now = this.ctx.clock.now();
    const delta = now - this.lastTick;
    this.lastTick = now;
    const lease = this.lease;
    if (this.closed || !lease) return;
    try {
      const real = performance.now();
      if (delta > LEASE_WAKE_GAP_MS) {
        // Часы прыгнули: переходник спал вместе со шлюзом — ждать его ответа заново, а не снимать аренду.
        lease.ping = null;
        if (!lease.verified) {
          lease.since = now;
          lease.sinceReal = real;
        }
        this.ctx.journal.write('lease_wake', { lease: lease.id, gap_ms: delta });
      }
      if (!lease.verified && now - lease.since >= PROBE_TIMEOUT_MS && real - lease.sinceReal >= LEASE_REAL_GRACE_MS) {
        this.unverified(lease);
        return;
      }
      if (lease.ping) {
        if (now - lease.ping.at >= LEASE_PONG_TIMEOUT_MS && real - lease.ping.real >= LEASE_REAL_GRACE_MS) {
          this.ctx.journal.write('lease_lost', { lease: lease.id, adapter: lease.adapter, reason: 'no_pong', waited_ms: now - lease.ping.at });
          lease.conn.destroy();
          this.release(lease, 'no_pong');
          return;
        }
      } else {
        lease.ping = { at: now, real };
        lease.conn.send({ type: 'ping' });
      }
      if (lease.verified) {
        this.checkRedelivery(lease, now);
        // Голосовое могло пересидеть VOICE_HOLD_MS: следующие за ним — отдать.
        this.pump();
      }
    } catch (err) {
      if (!this.ctx.disk.check(err, 'lease_tick')) throw err;
    }
  }

  /** Проба без done 120 с: сессия открыта без канала (5.10). */
  private unverified(lease: Lease): void {
    const at = this.ctx.clock.now();
    this.ctx.journal.write('lease_unverified', { lease: lease.id, adapter: lease.adapter, hint: lease.hint, probe: lease.probeSeq });
    transaction(this.ctx.db, () =>
      setMeta(this.ctx.db, META_KEYS.channelUnverified, JSON.stringify({ at, adapter: lease.adapter, cwd: lease.hint?.cwd ?? null, pid: lease.hint?.pid ?? null })),
    );
    lease.conn.send({
      type: 'error',
      req_id: null,
      code: 'unverified',
      text: `на проверочное событие нет done за ${PROBE_TIMEOUT_MS / 1000} с: сессия открыта без канала — перезапусти start.sh`,
    });
    lease.conn.close();
    this.release(lease, 'unverified');
  }

  /** Сроки повтора отданного (К-5). */
  private checkRedelivery(lease: Lease, now: number): void {
    const T = this.redeliverMs;
    const stopped = this.mode() === 'stopped';
    const silent: number[] = [];
    for (const [seq, t] of lease.track) {
      if (now < t.due) continue;
      const ev = this.event(seq);
      if (!ev || (ev.status !== 'new' && ev.status !== 'delivered')) {
        lease.track.delete(seq);
        continue;
      }
      if (stopped) {
        // В stopped ничего не отдаётся и ответы не уходят: срок ждёт [продолжить].
        t.calls = lease.calls;
        t.due = now + T;
        continue;
      }
      // Правила другого разговора этой аренды (сессия сменилась, 0.3.5): событие открыто — done по нему засчитывается, —
      // но повтором не отдаётся: у текущего разговора свои; вернулся тот разговор — срок идёт снова.
      if (ev.kind === 'instructions' && instructionsInfo(ev.instructions_json)?.key !== conversationKey(lease)) {
        t.calls = lease.calls;
        t.due = now + T;
        continue;
      }
      // Вызовы были — сессия занята: откладываем, но не больше REDELIVERY_MAX_POSTPONES раз подряд.
      const busy = lease.calls > t.calls;
      if (busy && t.postponed < REDELIVERY_MAX_POSTPONES) {
        t.calls = lease.calls;
        t.due = now + T;
        t.postponed++;
        this.ctx.journal.write('redelivery_postponed', { seq, lease: lease.id, last_call_ms: now - lease.lastCallAt, postponed: t.postponed, redelivered: t.redelivered });
        continue;
      }
      // Предел откладываний — в журнале: повтор (или строка владельцу) несмотря на вызовы.
      const limit = busy ? { postponed: t.postponed, despite_calls: true } : {};
      if (!t.redelivered) {
        t.redelivered = true;
        t.calls = lease.calls;
        t.due = now + T;
        t.postponed = 0;
        if (lease.session) t.seen.add(lease.session);
        lease.conn.send(this.frame(ev, true));
        this.ctx.journal.write('redelivered', { seq, lease: lease.id, kind: ev.kind, ...limit });
        continue;
      }
      lease.track.delete(seq);
      this.ctx.journal.write('agent_silent', { seq, lease: lease.id, kind: ev.kind, ...limit });
      if ((MESSAGE_EVENT_KINDS as readonly string[]).includes(ev.kind)) silent.push(seq);
    }
    if (silent.length && this.ctx.config.owner_id !== null) {
      transaction(this.ctx.db, () => enqueueServiceLine(this.ctx, silentAgentNotice(silent)));
      this.hooks.onReplyQueued();
    }
  }

  private frame(ev: EventRow, redelivery?: boolean): EventMessage {
    if (ev.kind === 'probe') return this.probeFrame(ev.seq, this.lease?.probeSeq === ev.seq ? this.lease.probeCode : undefined);
    if (ev.kind === 'instructions') {
      // Правила канала (0.3.5): шлюз шлёт только версию — текст своих instructions той же версии подставляет канал.
      return {
        ...this.probeFrame(ev.seq, undefined),
        kind: 'instructions',
        redelivery: redelivery ?? ev.attempts > 0,
        instructions: { version: instructionsInfo(ev.instructions_json)?.version ?? '' },
      };
    }
    const attachments = ev.attachments_json ? (JSON.parse(ev.attachments_json) as Attachment[]) : [];
    const forward = ev.forward_json ? (JSON.parse(ev.forward_json) as ForwardInfo) : null;
    const replyTo = ev.reply_to ? (JSON.parse(ev.reply_to) as NonNullable<EventMessage['reply_to']>) : null;
    const episode = ev.episode_id !== null ? this.episodes.get(ev.episode_id) : null;
    // «Эпизод новый» — у первого сообщения эпизода (команды и служебные события не в счёт).
    const first = episode
      ? (sql(this.ctx.db, `SELECT min(seq) AS s FROM events WHERE episode_id = ? AND kind IN (${MSG_KINDS_SQL})`).get(episode.id) as { s: number | null }).s
      : null;
    const subject = ev.subject_id
      ? ((sql(this.ctx.db, 'SELECT id, who FROM subjects WHERE id = ?').get(ev.subject_id) as { id: string; who: string } | undefined) ?? null)
      : null;
    if (ev.kind === 'reaction') {
      // Реакция владельца (0.3.4): кадр вида text — прежний канал читает её текстом, новый — по полю reaction.
      const r = JSON.parse(ev.reaction_json ?? '{}') as Partial<OwnerReaction>;
      const reaction = { to_seq: r.to_seq ?? null, emoji: r.emoji ?? [], old: r.old ?? [], excerpt: r.excerpt ? r.excerpt : null };
      return {
        type: 'event',
        seq: ev.seq,
        kind: 'text',
        trust: ev.trust,
        mixed: false,
        text: ownerReactionText(reaction),
        transcript: null,
        attachments: [],
        forward: null,
        reply_to: null,
        edit_of: null,
        chat: ev.chat_id !== null ? { id: ev.chat_id, kind: ev.chat_id > 0 ? 'private' : 'group' } : null,
        subject,
        episode: episode ? { id: episode.id, topic: episode.topic, role: episode.role, new: false } : null,
        redelivery: redelivery ?? ev.attempts > 0,
        reaction,
      };
    }
    return {
      type: 'event',
      seq: ev.seq,
      kind: ev.kind,
      trust: ev.trust,
      mixed: ev.mixed === 1,
      text: ev.text,
      transcript: ev.transcript,
      attachments: attachments.map((a) => ({ kind: a.kind, trust: a.trust })),
      forward: forward ? { origin_type: forward.origin_type, from_name: forward.from_name } : null,
      reply_to: replyTo,
      edit_of: ev.edit_of,
      chat: ev.chat_id !== null ? { id: ev.chat_id, kind: ev.chat_id > 0 ? 'private' : 'group' } : null,
      subject,
      episode: episode
        ? {
            id: episode.id,
            topic: episode.topic,
            role: episode.role,
            new: first === ev.seq,
            ...(ev.kind === 'episode_closed' ? { close_reason: episode.close_reason } : {}),
          }
        : null,
      redelivery: redelivery ?? ev.attempts > 0,
      ...this.audioField(ev, attachments),
      ...mediaField(attachments),
      ...materialField(ev),
    };
  }

  /**
   * Аудиофайл (J-2): имя, длительность (из метаданных Telegram, у document — по самому файлу) и что с распознаванием —
   * агенту, чтобы он знал, что файл не распознан и почему.
   */
  private audioField(ev: EventRow, attachments: Attachment[]): { audio?: NonNullable<EventMessage['audio']> } {
    if (ev.kind !== 'document') return {};
    const a = audioFileOf(attachments);
    if (!a) return {};
    const state = ev.transcript !== null ? 'transcribed' : ev.stt_note === 'too_long' ? 'too_long' : ev.stt_note === 'too_big' ? 'too_big' : 'failed';
    return {
      audio: { name: a.label, seconds: a.duration ?? ev.audio_seconds ?? null, state, max_minutes: this.ctx.config.stt.audio_max_minutes, source: a.source },
    };
  }

  private ownLease(conn: GatewayConnection, reqId: string): Lease | null {
    if (this.lease && this.lease.conn === conn) return this.lease;
    conn.send({ type: 'error', req_id: reqId, code: 'not_your_lease', text: 'у этого соединения нет аренды: сначала hello' });
    return null;
  }

  /** Аренда этого соединения и проверена (done на probe получен). */
  private verifiedLease(conn: GatewayConnection, reqId: string): Lease | null {
    const lease = this.ownLease(conn, reqId);
    if (!lease) return null;
    if (lease.verified) return lease;
    conn.send({ type: 'error', req_id: reqId, code: 'unverified', text: UNVERIFIED_REFUSAL });
    return null;
  }

  private event(seq: number): EventRow | null {
    return (sql(this.ctx.db, 'SELECT * FROM events WHERE seq = ?').get(seq) as EventRow | undefined) ?? null;
  }

  /** Событие отдано этой аренде (кадр ушёл ей, или delivered от неё). */
  private ownsEvent(lease: Lease, ev: EventRow): boolean {
    return lease.pushed.has(ev.seq) || ev.lease_id === lease.id;
  }

  private onDelivered(msg: Extract<AdapterMessage, { type: 'delivered' }>, conn: GatewayConnection): void {
    const lease = this.ownLease(conn, msg.req_id);
    if (!lease) return;
    const ev = this.event(msg.seq);
    if (!ev) {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'unknown_seq', text: `нет события № ${msg.seq}` });
      return;
    }
    if (!lease.pushed.has(msg.seq)) {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'not_your_lease', text: `№ ${msg.seq} не отдавался этой аренде` });
      return;
    }
    if (ev.kind === 'probe') {
      // Проба толкнута в сессию; проверку делает только done на неё.
      conn.send({ type: 'ack', req_id: msg.req_id, result: 'delivered' });
      return;
    }
    const now = this.ctx.clock.now();
    const changed = transaction(this.ctx.db, () => {
      const r = sql(this.ctx.db,
        "UPDATE events SET status = 'delivered', lease_id = ?, delivered_at = ?, attempts = attempts + 1 WHERE seq = ? AND status IN ('new', 'delivered')",
      ).run(lease.id, now, msg.seq);
      sql(this.ctx.db, 'UPDATE latency SET t_delivered = COALESCE(t_delivered, ?) WHERE event_seq = ?').run(now, msg.seq);
      // 👀 на сообщении владельца: агент увидел (уже обработанное — без реакции: 👌 не откатывается).
      if (r.changes) requestSeen(this.ctx, [msg.seq]);
      return Number(r.changes);
    });
    this.ctx.journal.write('delivered', { seq: msg.seq, lease: lease.id });
    conn.send({ type: 'ack', req_id: msg.req_id, result: 'delivered' });
    if (changed && this.mode() !== 'stopped') this.typing.start(ev.seq, ev.kind, ev.chat_id, ev.thread_id);
    // 🟡 «думает» — в закреплённой строке; 👀 — полосе реакций.
    if (changed) this.hooks.onReplyQueued();
  }

  /**
   * Тот же ответ уже принят (reply.idem): связь оборвалась после отправки, канал прислал его снова — второй строки нет,
   * исход тот же. null — такого ключа не было.
   */
  private repeatedReply(msg: Extract<AdapterMessage, { type: 'reply' }>): 'queued' | 'held_paused' | null {
    if (!msg.idem) return null;
    const row = sql(this.ctx.db, "SELECT id, status FROM outbox WHERE idem = ? AND origin = 'agent' AND created_at >= ? ORDER BY id LIMIT 1")
      .get(msg.idem, this.ctx.clock.now() - IDEM_WINDOW_MS) as { id: number; status: string } | undefined;
    if (!row) return null;
    this.ctx.journal.write('reply_repeated', { seq: msg.seq, outbox_id: row.id, status: row.status });
    return row.status === 'held' ? 'held_paused' : 'queued';
  }

  private onReply(msg: Extract<AdapterMessage, { type: 'reply' }>, conn: GatewayConnection): void {
    const lease = this.verifiedLease(conn, msg.req_id);
    if (!lease) return;
    const repeated = this.repeatedReply(msg);
    if (repeated) {
      conn.send({ type: 'ack', req_id: msg.req_id, result: repeated });
      return;
    }
    const mode = this.mode();
    const turn = this.turn();
    const ev = msg.seq !== null ? this.event(msg.seq) : null;
    if (msg.seq !== null && (!ev || !(AGENT_EVENT_KINDS as readonly string[]).includes(ev.kind))) {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'unknown_seq', text: `нет события № ${msg.seq}` });
      return;
    }
    if (ev?.kind === 'probe') {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'bad_request', text: `№ ${ev.seq} — проверочное событие: на него отвечают done, а не reply` });
      return;
    }
    if (ev?.kind === 'instructions') {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'bad_request', text: `№ ${ev.seq} — правила канала: на них отвечают done, а не reply` });
      return;
    }
    // Чьи слова агент передаёт (0.3.2, P-26): имя проверяет шлюз — агент не выдаёт чужие слова за строку шлюза ⟨предл.⟩.
    const fromName = msg.from !== undefined ? msg.from.trim() : null;
    if (msg.from !== undefined) {
      const why = relayNameProblem(msg.from);
      if (why) {
        this.ctx.journal.write('reply_refused', { seq: msg.seq, reason: 'from', from: msg.from.slice(0, 80), text: why });
        conn.send({ type: 'error', req_id: msg.req_id, code: 'bad_request', text: why });
        return;
      }
    }
    // Сначала ход: ответ хода, прерванного «стопом», — dropped_stale_turn (A2.4); затем любой ответ в stopped.
    if (msg.turn !== turn) {
      this.ctx.journal.write('reply_dropped', { seq: msg.seq, reason: 'stale_turn', turn: msg.turn, current: turn, text: msg.text });
      conn.send({ type: 'ack', req_id: msg.req_id, result: 'dropped_stale_turn' });
      return;
    }
    if (mode === 'stopped') {
      this.ctx.journal.write('reply_dropped', { seq: msg.seq, reason: 'stopped', text: msg.text });
      conn.send({ type: 'ack', req_id: msg.req_id, result: 'dropped_stopped' });
      return;
    }
    const owner = this.ctx.config.owner_id;
    const chatId = ev?.chat_id ?? owner;
    if (chatId === null) {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'unavailable', text: 'владелец не задан (первая настройка)' });
      return;
    }
    const now = this.ctx.clock.now();
    // Ответ = обработано (Оч-2) — событию этой аренды (Оч-6); повторный ответ на то же событие допустим и тоже уходит.
    const marks = ev !== null && ev.status !== 'processed' && this.ownsEvent(lease, ev);
    // Пауза: уходят только ответы на сообщения, ждущие ответа этой сессии. Сообщение без seq и ответ со старым № (событие
    // уже обработано или отдано не ей) — по своей инициативе: придерживаются (иначе паузу обходил бы любой прошлый №).
    const held = mode === 'paused' && !marks;
    const outboxId = transaction(this.ctx.db, () => {
      const id = insertOutbox(this.ctx, {
        eventSeq: msg.seq,
        chatId,
        threadId: ev?.thread_id ?? null,
        kind: 'agent',
        text: msg.text,
        origin: 'agent',
        voice: msg.voice,
        turn: msg.turn,
        status: held ? 'held' : 'pending',
        idem: msg.idem ?? null,
        fromName,
      });
      if (marks) {
        sql(this.ctx.db, "UPDATE events SET status = 'processed', processed_at = ?, processed_silent = 0 WHERE seq = ?").run(now, ev.seq);
        // 👌 на сообщении владельца: агент ответил.
        requestProcessed(this.ctx, [ev.seq]);
      }
      return id;
    });
    this.ctx.journal.write('reply', {
      seq: msg.seq,
      outbox_id: outboxId,
      label: 'agent',
      text: msg.text,
      voice: msg.voice,
      ...(fromName ? { from: fromName } : {}),
      held,
      ...(ev && !marks && ev.status !== 'processed' ? { not_this_lease: true } : {}),
    });
    if (ev) {
      lease.track.delete(ev.seq);
      this.typing.stop([ev.seq]);
    }
    conn.send({ type: 'ack', req_id: msg.req_id, result: held ? 'held_paused' : 'queued' });
    this.hooks.onAgentActivity?.();
    this.hooks.onReplyQueued();
  }

  /**
   * Файл из папки посылок (0.3.3, 5.16). Порядок проверок — как у reply: аренда, ключ повтора, событие, from, ход, стоп;
   * затем ParcelService (цель, чат, путь, снимок) и одной транзакцией — строка outbox, доставка, «обработано» и 👌.
   */
  private onSendFile(msg: Extract<AdapterMessage, { type: 'send_file' }>, conn: GatewayConnection): void {
    const lease = this.verifiedLease(conn, msg.req_id);
    if (!lease) return;
    const parcels = this.parcels;
    if (!parcels) {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'unavailable', text: 'посылки не подключены' });
      return;
    }
    const repeated = parcels.repeated(msg.idem ?? null);
    if (repeated) {
      this.ctx.journal.write('send_file_repeated', { seq: msg.seq, delivery: repeated.delivery, status: repeated.status });
      conn.send({ type: 'ack', req_id: msg.req_id, result: repeated });
      return;
    }
    const refuse = (reason: string, text: string): void => {
      this.ctx.journal.write('send_file_refused', { seq: msg.seq, path: msg.path.slice(0, 200), reason, text });
      conn.send({ type: 'error', req_id: msg.req_id, code: 'bad_request', text });
    };
    const mode = this.mode();
    const turn = this.turn();
    const ev = msg.seq !== null ? this.event(msg.seq) : null;
    if (msg.seq !== null && (!ev || !(AGENT_EVENT_KINDS as readonly string[]).includes(ev.kind))) {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'unknown_seq', text: `нет события № ${msg.seq}` });
      return;
    }
    if (ev?.kind === 'probe') {
      refuse('probe', `№ ${ev.seq} — проверочное событие: на него отвечают done`);
      return;
    }
    if (ev?.kind === 'instructions') {
      refuse('instructions', `№ ${ev.seq} — правила канала: на них отвечают done`);
      return;
    }
    const fromName = msg.from !== undefined ? msg.from.trim() : null;
    if (msg.from !== undefined) {
      const why = relayNameProblem(msg.from);
      if (why) {
        refuse('from', why);
        return;
      }
    }
    if (msg.turn !== turn) {
      this.ctx.journal.write('send_file_dropped', { seq: msg.seq, path: msg.path.slice(0, 200), reason: 'stale_turn', turn: msg.turn, current: turn });
      conn.send({ type: 'ack', req_id: msg.req_id, result: { status: 'dropped_stale_turn' } });
      return;
    }
    if (mode === 'stopped') {
      this.ctx.journal.write('send_file_dropped', { seq: msg.seq, path: msg.path.slice(0, 200), reason: 'stopped' });
      conn.send({ type: 'ack', req_id: msg.req_id, result: { status: 'dropped_stopped' } });
      return;
    }
    const owner = this.ctx.config.owner_id;
    const chatId = ev?.chat_id ?? owner;
    if (chatId === null) {
      conn.send({ type: 'error', req_id: msg.req_id, code: 'unavailable', text: 'владелец не задан (первая настройка)' });
      return;
    }
    const now = this.ctx.clock.now();
    const marks = ev !== null && ev.status !== 'processed' && this.ownsEvent(lease, ev);
    const held = mode === 'paused' && !marks;
    let out;
    try {
      out = parcels.send({
        path: msg.path,
        target: msg.target,
        leaseCwd: lease.hint?.cwd ?? null,
        idem: msg.idem ?? null,
        req: { seq: msg.seq, chatId, threadId: ev?.thread_id ?? null, caption: msg.caption ?? '', fromName, turn: msg.turn, held },
        inTx: () => {
          if (!marks) return;
          sql(this.ctx.db, "UPDATE events SET status = 'processed', processed_at = ?, processed_silent = 0 WHERE seq = ?").run(now, ev.seq);
          requestProcessed(this.ctx, [ev.seq]);
        },
      });
    } catch (err) {
      if (this.ctx.disk.check(err, 'send_file', { seq: msg.seq })) {
        conn.send({ type: 'error', req_id: msg.req_id, code: 'unavailable', text: 'диск шлюза полон: файл не принят — повтори позже' });
        return;
      }
      // Иная ошибка записи копии или базы (права на raw/, сбой SQLite): транзакции не было — ничего не принято. Шлюз не
      // падает: иначе повтор агента ронял бы его снова и снова ⟨предл.⟩.
      this.ctx.journal.write('send_file_failed', { seq: msg.seq, path: msg.path.slice(0, 200), error: (err as Error)?.message ?? String(err) });
      conn.send({ type: 'error', req_id: msg.req_id, code: 'unavailable', text: `файл не принят: ошибка шлюза (${(err as NodeJS.ErrnoException)?.code ?? 'внутренняя'}) — повтори позже` });
      return;
    }
    if (!out.ok) {
      refuse(out.reason, out.text);
      return;
    }
    const r = out.result;
    this.ctx.journal.write('send_file', {
      seq: msg.seq,
      delivery: r.delivery,
      outbox_id: out.outboxId,
      target: r.target,
      chat: chatId,
      parcel: r.parcel,
      file: r.file,
      bytes: r.bytes,
      sha256: out.sha256,
      sent_before: r.sent_before,
      updated: r.updated,
      caption: msg.caption ?? '',
      ...(fromName ? { from: fromName } : {}),
      held,
      ...(ev && !marks && ev.status !== 'processed' ? { not_this_lease: true } : {}),
    });
    if (ev) {
      lease.track.delete(ev.seq);
      this.typing.stop([ev.seq]);
    }
    conn.send({ type: 'ack', req_id: msg.req_id, result: r });
    this.hooks.onAgentActivity?.();
    this.hooks.onReplyQueued();
  }

  private onDone(msg: Extract<AdapterMessage, { type: 'done' }>, conn: GatewayConnection): void {
    const lease = this.ownLease(conn, msg.req_id);
    if (!lease) return;
    const rows: EventRow[] = [];
    for (const seq of msg.seqs) {
      const ev = this.event(seq);
      if (!ev) {
        conn.send({ type: 'error', req_id: msg.req_id, code: 'unknown_seq', text: `нет события № ${seq}` });
        return;
      }
      // «Обработано» — только событию, отданному этой аренде (Оч-6).
      if (!this.ownsEvent(lease, ev)) {
        conn.send({ type: 'error', req_id: msg.req_id, code: 'not_your_lease', text: `№ ${seq} отдан не этой сессии` });
        return;
      }
      // До проверки канала у аренды нет ничего, кроме пробы; done на пробу — только с её кодом (номер пробы угадывается).
      if (!lease.verified && (ev.seq !== lease.probeSeq || msg.code !== lease.probeCode)) {
        if (ev.seq === lease.probeSeq) this.ctx.journal.write('probe_code_refused', { lease: lease.id, seq: ev.seq, code: msg.code === undefined ? 'none' : 'wrong' });
        conn.send({ type: 'error', req_id: msg.req_id, code: 'unverified', text: UNVERIFIED_REFUSAL });
        return;
      }
      rows.push(ev);
    }
    const now = this.ctx.clock.now();
    const learned: Array<{ seq: number } & InstructionsInfo> = [];
    const changed = transaction(this.ctx.db, () => {
      const done: number[] = [];
      for (const ev of rows) {
        if (ev.status === 'processed' || ev.status === 'handled') continue;
        sql(this.ctx.db, "UPDATE events SET status = 'processed', processed_at = ?, processed_silent = 1 WHERE seq = ?").run(now, ev.seq);
        done.push(ev.seq);
        // Правила канала прочитаны (0.3.5): версия — за разговором, которому событие отдано.
        const info = ev.kind === 'instructions' ? instructionsInfo(ev.instructions_json) : null;
        if (info) {
          sql(this.ctx.db,
            `INSERT INTO conversations(key, instructions, seq, at) VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET instructions = excluded.instructions, seq = excluded.seq, at = excluded.at`,
          ).run(info.key, info.version, ev.seq, now);
          learned.push({ seq: ev.seq, ...info });
        }
      }
      // 👌 на сообщениях владельца: агент обработал без ответа (материал, пересылка) — тоже 👌.
      requestProcessed(this.ctx, done);
      return done.length;
    });
    this.ctx.journal.write('done', { seqs: msg.seqs, processed: changed });
    for (const l of learned) this.ctx.journal.write('instructions_received', { seq: l.seq, lease: lease.id, version: l.version, conversation: conversationTag(l.key) });
    for (const ev of rows) lease.track.delete(ev.seq);
    this.typing.stop(msg.seqs);
    conn.send({ type: 'ack', req_id: msg.req_id, result: { processed: changed } });
    // done — вызов модели (и на проверочное событие: его делает модель в сессии).
    this.hooks.onAgentActivity?.();
    if (lease.probeSeq !== null && msg.seqs.includes(lease.probeSeq)) this.verify(lease);
    else if (changed) this.hooks.onReplyQueued();
  }
}

/** Подсказка агенту (0.3): в событии есть картинка для media(seq) — что за она и есть ли кадр у кружка и видео. */
function mediaField(attachments: Attachment[]): { media?: NonNullable<EventMessage['media']> } {
  const v = viewableOf(attachments);
  if (!v) return {};
  if (v.what === 'video_note' || v.what === 'video') return { media: { what: v.what, frame: v.thumb !== null } };
  return { media: { what: v.what } };
}
