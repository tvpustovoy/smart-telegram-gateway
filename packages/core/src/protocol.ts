// Протокол шлюз ⇄ переходник (TECH-SPEC 5.10) — источник правды; таблица в спецификации — пересказ.
// Unix-сокет gateway.sock. Кадр — одна JSON-строка UTF-8, конец — `\n`, не длиннее 1 МБ. У каждого сообщения поле
// `type`, у запросов переходника — `req_id`. На каждый запрос шлюз отвечает `ack {req_id, result}` или
// `error {req_id, code, text}`.
//
// Входящее от переходника проверяется строго (лишнее поле — bad_request: так `role` в `episode` даёт отказ, A3.19).
// Исходящее от шлюза переходник читает терпимо: лишние поля отбрасываются — так шлюз может добавлять поля в пределах
// той же версии протокола.

import { z } from 'zod';
import { PARCEL_TARGET_RE } from './parcels.js';
import { EPISODE_CLOSE_REASONS, EVENT_KINDS, MODES, TRUST_LABELS } from './schema.js';

/** Номер протокола: целое в `hello.version`. Несовпадение — `error version_mismatch`. */
export const PROTOCOL_VERSION = 1;

/** Предел кадра вместе с `\n`. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/**
 * Предел кадра шлюз → переходник с картинкой (ответ на `media`, 0.3): файл до 3,75 МБ ⟨предл.⟩ — в base64 до 5 МБ, кадр
 * до 8 МБ — с запасом (если предел просмотра поднимут до 5 МБ файлом, в base64 это 6,7 МБ). Кадры от
 * переходника к шлюзу — по-прежнему не длиннее 1 МБ; прежний переходник `media` не шлёт и таких кадров не получает.
 */
export const MAX_MEDIA_FRAME_BYTES = 8 * 1024 * 1024;

export const ERROR_CODES = [
  'not_your_lease',
  'stale_turn',
  'unknown_seq',
  'already_processed',
  'busy',
  'unverified',
  'bad_request',
  'version_mismatch',
  'unavailable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const reqId = z.string().min(1).max(128);
const seq = z.int().positive();

export const ModeSchema = z.enum(MODES);
export const TrustSchema = z.enum(TRUST_LABELS);

// ——— Правила (5.9): изменение — список операций ———

export const SUBJECT_FIELDS = ['who', 'transports'] as const;
export const CHAT_FIELDS = ['space', 'role'] as const;

export const RuleOpSchema = z
  .strictObject({
    op: z.enum(['add', 'remove', 'set']),
    target: z.enum(['subject', 'chat']),
    id: z.string().min(1).max(128),
    field: z.string().min(1).optional(),
    value: z.unknown().optional(),
  })
  .superRefine((o, ctx) => {
    const fields: readonly string[] = o.target === 'subject' ? SUBJECT_FIELDS : CHAT_FIELDS;
    if (o.op === 'remove') {
      if (o.field !== undefined || o.value !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'remove — без field и value' });
      }
      return;
    }
    if (o.op === 'set') {
      if (o.field === undefined || !fields.includes(o.field)) {
        ctx.addIssue({ code: 'custom', path: ['field'], message: `set: field — одно из ${fields.join(', ')}` });
      }
      if (o.value === undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: 'set: нужно value' });
      return;
    }
    // add: value — объект с полями цели
    if (o.field !== undefined) ctx.addIssue({ code: 'custom', path: ['field'], message: 'add — без field' });
    if (o.value === null || typeof o.value !== 'object' || Array.isArray(o.value)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `add: value — объект с полями ${fields.join(', ')}` });
      return;
    }
    for (const k of Object.keys(o.value)) {
      if (!fields.includes(k)) ctx.addIssue({ code: 'custom', path: ['value', k], message: `add: лишнее поле ${k}` });
    }
  });
export type RuleOp = z.infer<typeof RuleOpSchema>;

export const RuleChangeSchema = z.array(RuleOpSchema).min(1).max(50);
export type RuleChange = z.infer<typeof RuleChangeSchema>;

// ——— Переходник → шлюз ———

/** Ключ повтора ответа, код проверочного события, ключ процесса переходника — короткие строки из латиницы и цифр. */
const token = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const HelloSchema = z.strictObject({
  type: z.literal('hello'),
  req_id: reqId,
  adapter: z.string().min(1).max(128),
  version: z.int().nonnegative(),
  role: z.enum(['adapter', 'cli']),
  // Для журнала: каталог и pid; шлюз по нему ничего не решает.
  session_hint: z
    .strictObject({ cwd: z.string().max(4096).optional(), pid: z.int().positive().optional() })
    .optional(),
  // Та же сессия (0.3.2, R-4 а; в пределах v1, необязательные): instance_id — случайный ключ,
  // который переходник заводит при старте процесса (не меняется, пока жив процесс); prev_lease — аренда, которую этот
  // процесс держал до обрыва. Тот же процесс, прежняя аренда проверена, сессия Claude Code в каталоге та же — новая
  // аренда проверена сразу, без пробы (без хода модели), отданное прежней аренде остаётся за ней (adapter.ts). Шлюз до
  // 0.3.2 эти поля не знает и отвечает bad_request — переходник тогда повторяет hello без них.
  instance_id: token.optional(),
  prev_lease: z.string().min(1).max(128).optional(),
  // Версия instructions канала (0.3.5, issue #47; в пределах v1, необязательное): начало SHA-256 текста instructions,
  // которые этот процесс канала отдал Claude Code. Claude Code передаёт instructions только при первом подключении канала
  // к разговору — продолженный (--resume) разговор их не получает; шлюз помнит, какую версию получил каждый разговор,
  // и разговору со старой или неизвестной отдаёт событие «правила канала» (вид instructions). Без поля (канал до
  // 0.3.5) — событий правил нет, как раньше. Шлюз до 0.3.5 поле не знает и отвечает bad_request — канал повторяет hello
  // без него.
  instructions_version: token.optional(),
});

export const DeliveredSchema = z.strictObject({ type: z.literal('delivered'), req_id: reqId, seq });

/**
 * Предел текста ответа агента, единиц UTF-16: ~16 частей по 4096. Разметка и нарезка идут синхронно, в одном потоке с
 * приёмом, — неограниченный текст держал бы приём; длиннее — bad_request, канал вернёт агенту отказ.
 */
export const MAX_REPLY_TEXT = 65_536;

export const ReplySchema = z.strictObject({
  type: z.literal('reply'),
  req_id: reqId,
  // null — сообщение по своей инициативе, в личку владельца.
  seq: seq.nullable(),
  text: z.string().min(1).max(MAX_REPLY_TEXT),
  voice: z.boolean().default(false),
  turn: z.int().nonnegative(),
  // Ключ повтора (в пределах v1, необязательное): тот же ответ после обрыва связи посреди reply шлюз второй раз не
  // ставит в очередь, а отвечает тем же исходом. Ключ ставит канал; шлюз помнит его у строки outbox.
  idem: token.optional(),
  // Чьи слова агент передаёт (0.3.2, P-26; в пределах v1, необязательное): шлюз ставит перед ответом «↪ <имя>: ». Имя
  // проверяет шлюз (relayNameProblem: до 64 знаков, одной строкой, не «шлюз» и без знаков шлюза) — иначе bad_request.
  // Шлюз до 0.3.2 поле не знает — bad_request «нераспознанный ключ», канал говорит агенту «шлюз старой версии».
  from: z.string().max(256).optional(),
});

export const DoneSchema = z.strictObject({
  type: z.literal('done'),
  req_id: reqId,
  seqs: z.array(seq).min(1).max(1000),
  // Код проверочного события (в пределах v1): done на probe засчитывается только с кодом из его текста — код видит
  // только сессия, куда событие дошло (5.10, «проверка канала»).
  code: token.optional(),
});

export const EpisodeSchema = z.strictObject({
  type: z.literal('episode'),
  req_id: reqId,
  action: z.enum(['name', 'new']),
  topic: z.string().min(1).max(256),
  reason: z.string().max(1000).optional(),
});

export const EpisodeSummarySchema = z.strictObject({
  type: z.literal('episode_summary'),
  req_id: reqId,
  episode_id: z.int().positive(),
  text: z.string().min(1).max(MAX_REPLY_TEXT),
});

export const RuleSchema = z.strictObject({ type: z.literal('rule'), req_id: reqId, change: RuleChangeSchema });

/**
 * Картинка события (0.3, P-6, P-14): фото, изображение файлом, кадр кружка или видео — только событие этой
 * аренды (отданное ей). `ack.result` — MediaResult (ниже); шлюз скачивает файл при первом запросе (media.ts).
 */
export const MediaSchema = z.strictObject({ type: z.literal('media'), req_id: reqId, seq });

export const WhereSchema = z.strictObject({ type: z.literal('where'), req_id: reqId });

/**
 * Отдать файл из папки посылок (0.3.3, 5.16; P-23, issue #29). path — путь
 * внутри папки посылок (от неё или полный); seq — ответом на событие (в его чат; событие становится обработанным, как у
 * reply), null — по своей инициативе, в личку владельца; caption — подпись (Markdown); from — чьи слова (файл) агент
 * передаёт, как у reply (P-26); target — куда доставить (по умолчанию telegram; другие цели — позже, parcels.targets);
 * turn и idem — как у reply. `ack.result` — SendFileResult. Шлюз до 0.3.3 отвечает bad_request «неизвестный type» —
 * канал говорит агенту «шлюз старой версии».
 */
export const SendFileSchema = z.strictObject({
  type: z.literal('send_file'),
  req_id: reqId,
  path: z.string().min(1).max(4096),
  seq: seq.nullable(),
  caption: z.string().max(MAX_REPLY_TEXT).optional(),
  from: z.string().max(256).optional(),
  target: z.string().regex(PARCEL_TARGET_RE).optional(),
  turn: z.int().nonnegative(),
  idem: token.optional(),
});

/**
 * Ход агента идёт (#55; в пределах v1, необязательное): «печатает…» держится в чатах событий хода всё время хода, и после
 * промежуточного ответа на них (5.5). on: true — seqs: № событий хода (отданных агенту — этой аренде или прежней;
 * прочие пропускаются); кадр заменяет прежний набор. Повторять, пока ход идёт: без нового working за WORKING_HOLD_MS
 * шлюз снимает «печатает…» сам. on: false — ход кончился. «Стоп» и снятие аренды снимают сразу; в «стопе» working
 * не действует. `ack.result` — WorkingResult. Только проверенной аренде. Канал Claude Code его не шлёт (конца хода он не
 * видит) — у него всё как раньше. Шлюз без working отвечает bad_request «неизвестный type» — переходник больше не шлёт.
 */
export const WorkingSchema = z.strictObject({
  type: z.literal('working'),
  req_id: reqId,
  on: z.boolean(),
  seqs: z.array(seq).max(1000).optional(),
});

/** Без нового working столько — шлюз снимает «печатает…» хода сам (переходник замолчал, ход завис) ⟨предл.⟩. */
export const WORKING_HOLD_MS = 15 * 60_000;

/**
 * Ответ на working: chats — в скольких чатах «печатает…» держится ходом; seqs — какие № приняты (прочие — не
 * сообщения, не отданы агенту, нет чата; в «стопе» — ни одного). Терпимо: новые поля не ломают прежний переходник.
 */
export const WorkingResultSchema = z.object({ chats: z.int().nonnegative(), seqs: z.array(seq) });
export type WorkingResult = z.infer<typeof WorkingResultSchema>;

/**
 * Повтор отложенного обновления (5.3, `stg deferred retry <update_id>`): только соединение CLI (`hello role cli`). В
 * базу пишет только шлюз — поэтому повтор идёт через его сокет. `ack.result`: `{update_id, status, seq}`.
 */
export const DeferredRetrySchema = z.strictObject({ type: z.literal('deferred_retry'), req_id: reqId, update_id: z.int().positive() });

export const PingSchema = z.strictObject({ type: z.literal('ping') });
export const PongSchema = z.strictObject({ type: z.literal('pong') });

export const AdapterMessageSchema = z.discriminatedUnion('type', [
  HelloSchema,
  DeliveredSchema,
  ReplySchema,
  DoneSchema,
  EpisodeSchema,
  EpisodeSummarySchema,
  RuleSchema,
  WhereSchema,
  DeferredRetrySchema,
  MediaSchema,
  SendFileSchema,
  WorkingSchema,
  PingSchema,
  PongSchema,
]);
export type AdapterMessage = z.infer<typeof AdapterMessageSchema>;
export type AdapterMessageType = AdapterMessage['type'];
export const ADAPTER_MESSAGE_TYPES: readonly AdapterMessageType[] = [
  'hello',
  'delivered',
  'reply',
  'done',
  'episode',
  'episode_summary',
  'rule',
  'where',
  'deferred_retry',
  'media',
  'send_file',
  'working',
  'ping',
  'pong',
];

// ——— Аренда и сроки (5.10) ⟨числа — предл., приняты в M3⟩ ———

/** Шлюз шлёт ping аренде каждые 15 с. */
export const LEASE_PING_MS = 15_000;
/** Нет pong 45 с — аренда снята, отданное вернулось в new. */
export const LEASE_PONG_TIMEOUT_MS = 45_000;
/** Нет done на probe 120 с — error unverified, сокет закрыт. */
export const PROBE_TIMEOUT_MS = 120_000;
/** Получив busy, канал повторяет hello каждые 30 с. */
export const BUSY_RETRY_MS = 30_000;
/** Шлюз пропал — канал переподключается с паузой 1…30 с. */
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * Ответ шлюза на `media` (0.3). image — картинка в base64 (mime по первым байтам файла: png, jpeg, webp, gif) или null,
 * если показать нечего (слишком большое и уменьшенной копии нет, удалено по сроку хранения, кадра нет); shown — что
 * показано: сам файл (original) или уменьшенная копия Telegram (telegram_thumbnail); note — короткий текст агенту
 * (почему копия или почему ничего). Поля — строки и числа без перечислений: новый шлюз может добавить значение, и
 * прежний канал не ломается.
 */
export const MediaResultSchema = z.object({
  seq,
  /** photo · image · video_note · video; file — вложение стёрто чисткой, какой это был файл, не узнать */
  what: z.string(),
  image: z
    .object({
      mime: z.string(),
      data: z.string(),
      width: z.int().nonnegative().nullable(),
      height: z.int().nonnegative().nullable(),
      bytes: z.int().nonnegative(),
      /** original · telegram_thumbnail */
      shown: z.string(),
    })
    .nullable(),
  note: z.string().nullable(),
});
export type MediaResult = z.infer<typeof MediaResultSchema>;

/**
 * Ответ шлюза на send_file (0.3.3). status — как у reply: queued · held_paused (пауза: уйдёт после «продолжить») ·
 * dropped_stopped · dropped_stale_turn (тогда остальных полей нет: копии и доставки нет). delivery — № доставки
 * (deliveries.id); version — начало SHA-256 содержимого; sent_before — сколько раз эта же версия уже уходила в эту цель и
 * чат (повтор можно); updated — прежде уходила другая версия того же файла: владелец увидит «обновлено»; where — где
 * смотреть (у telegram — словами, у будущей цели web — адрес). repeated — это исход прежнего вызова с тем же ключом
 * повтора (idem): шлюз второй раз не отправлял, а сказал, что стало с первым; тогда status — по доставке: queued ·
 * held_paused (ждёт) · sent (ушла) · dropped_stopped («стоп») · failed (не ушла, note — почему). Поля без перечислений,
 * терпимо: новый шлюз может добавить поле, прежний канал не ломается.
 */
export const SendFileResultSchema = z.object({
  status: z.string(),
  delivery: z.int().positive().optional(),
  parcel: z.string().optional(),
  file: z.string().optional(),
  bytes: z.int().nonnegative().optional(),
  version: z.string().optional(),
  sent_before: z.int().nonnegative().optional(),
  updated: z.boolean().optional(),
  target: z.string().optional(),
  where: z.string().nullable().optional(),
  repeated: z.boolean().optional(),
  note: z.string().nullable().optional(),
});
export type SendFileResult = z.infer<typeof SendFileResultSchema>;

/** Ответ шлюза на deferred_retry. */
export const DeferredRetryResultSchema = z.object({
  update_id: z.int().positive(),
  /** admitted — принято событием; ignored — отправитель уже не из правил (Ш-3). */
  status: z.enum(['admitted', 'ignored']),
  seq: seq.nullable(),
});
export type DeferredRetryResult = z.infer<typeof DeferredRetryResultSchema>;

// ——— Шлюз → переходник ———

export const WelcomeSchema = z.object({
  type: z.literal('welcome'),
  req_id: reqId,
  lease_id: z.string().min(1),
  mode: ModeSchema,
  turn: z.int().nonnegative(),
});

export const ReplyToSchema = z.object({
  kind: z.enum(['agent', 'receipt', 'service', 'owner', 'unknown']),
  event_seq: seq.nullable().optional(),
  // Начало ответа агента, до 200 знаков, — только у kind = agent (5.4).
  excerpt: z.string().max(200).optional(),
  episode_topic: z.string().nullable().optional(),
  // Ответ — на материал без слов владельца (0.3.6, issue #51; в пределах v1): событие с material_json или такое по
  // классификации (core/material.ts). Канал пишет «слова к материалу № N»; прежний канал поле отбрасывает.
  material: z.boolean().optional(),
});

export const EventMessageSchema = z.object({
  type: z.literal('event'),
  seq,
  kind: z.enum(EVENT_KINDS),
  // У служебных событий (probe, episode_closed) метки нет.
  trust: TrustSchema.nullable(),
  mixed: z.boolean(),
  text: z.string().nullable(),
  transcript: z.string().nullable(),
  // Только вид и метка, без содержимого файлов.
  attachments: z.array(
    z.object({
      kind: z.enum(['quote', 'external_reply', 'via_bot', 'photo', 'document', 'voice']),
      trust: TrustSchema,
    }),
  ),
  forward: z.object({ origin_type: z.enum(['user', 'hidden_user', 'chat', 'channel']), from_name: z.string().nullable() }).nullable(),
  reply_to: ReplyToSchema.nullable(),
  edit_of: seq.nullable(),
  chat: z.object({ id: z.int(), kind: z.enum(['private', 'group', 'supergroup', 'channel']) }).nullable(),
  subject: z.object({ id: z.string(), who: z.string() }).nullable(),
  // close_reason — у episode_closed: почему закрыт (idle, owner_new_topic, telegram_topic, agent_new, owner_rejected).
  episode: z
    .object({
      id: z.int().positive(),
      topic: z.string(),
      role: z.string(),
      new: z.boolean(),
      close_reason: z.enum(EPISODE_CLOSE_REASONS).nullable().optional(),
    })
    .nullable(),
  redelivery: z.boolean(),
  // Только у probe: код, который модель возвращает в done (в пределах v1; старый канал его не знает и не теряет).
  code: z.string().optional(),
  // Только у аудиофайла (J-2; в пределах v1, как code): имя, длительность (по метаданным Telegram, а у файла без них — по
  // самому файлу; null — не определена) и что с распознаванием —
  // распознан (расшифровка в transcript) · длиннее stt.audio_max_minutes · больше 20 МБ (бот не скачал) · не вышло.
  // source (0.3, в пределах v1): откуда звук — audio · video_note · video; строкой, без перечисления (прежний канал поле не
  // знает и отбрасывает).
  audio: z
    .object({
      name: z.string(),
      seconds: z.number().nonnegative().nullable(),
      state: z.enum(['transcribed', 'too_long', 'too_big', 'failed']),
      max_minutes: z.int().positive(),
      source: z.string().optional(),
    })
    .optional(),
  // Картинка, которую агент может посмотреть инструментом media(seq) (0.3, в пределах v1): what — photo · image ·
  // video_note · video (строкой: прежний канал поле отбрасывает, новый значение может пополниться); frame — у кружка и
  // видео есть кадр-обложка.
  media: z.object({ what: z.string(), frame: z.boolean().optional() }).optional(),
  // Реакция владельца на ответ агента (0.3.4; в пределах v1, как media): событие базы вида reaction уходит кадром вида
  // text — прежний канал (до 0.3.4) вида reaction не знает и отбросил бы кадр целиком, а так читает событие обычным
  // текстом «Реакция на твой ответ к № M: 👍 …» (поле reaction он отбрасывает). Новый канал строит заголовок по этому полю
  // (format.ts). to_seq — событие, на которое был ответ (null — сообщение по своей инициативе); emoji — что стоит теперь
  // (пусто — снял), old — что стояло; excerpt — начало ответа, до 200 знаков.
  reaction: z
    .object({
      to_seq: seq.nullable(),
      emoji: z.array(z.string()),
      old: z.array(z.string()),
      excerpt: z.string().max(200).nullable(),
    })
    .optional(),
  // Только у события «правила канала» (0.3.5, issue #47; вид instructions): какую версию instructions шлюз просит
  // показать разговору. Текст правил подставляет канал — свой, той же версии (шлюз шлёт это событие только каналу,
  // который назвал версию в hello: прежний канал вида instructions не получает).
  instructions: z.object({ version: z.string() }).optional(),
  // Материал без слов владельца (0.3.6, issue #51; в пределах v1, как media): words — after (слова владельца пришли
  // следом: событие words_seq отдаётся сразу за этим) · before (слова были раньше, в пределах окна: событие words_seq) ·
  // none (окно кончилось без слов: waited_ms — сколько материал ждал). Строкой, без перечисления: прежний канал поле
  // отбрасывает, новый строит по нему пометку в заголовке (format.ts).
  material: z
    .object({
      words: z.string(),
      words_seq: seq.nullable(),
      waited_ms: z.int().nonnegative().nullable(),
    })
    .optional(),
  // Слова после материала (0.3.6, issue #51; в пределах v1): это — первые слова владельца после материала, ушедшего без
  // слов (none), в том же чате, теме и эпизоде, не позже ui.material_followup_minutes; № того материала (одного или
  // нескольких). Канал пишет «слова после материала № N, K»; прежний канал поле отбрасывает.
  after_material: z.array(seq).optional(),
});
export type EventMessage = z.infer<typeof EventMessageSchema>;

export const ModeMessageSchema = z.object({ type: z.literal('mode'), state: ModeSchema, turn: z.int().nonnegative() });

export const ReplyResultSchema = z.enum(['queued', 'held_paused', 'dropped_stopped', 'dropped_stale_turn']);
/** rule: applied — сужение применено; pending_owner — расширение ждёт кнопки владельца; dropped_stopped — «стоп» (M5). */
export const RuleResultSchema = z.enum(['applied', 'pending_owner', 'dropped_stopped']);

export const AckSchema = z.object({ type: z.literal('ack'), req_id: reqId, result: z.unknown() });

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  // null — на кадр, который не разобрался (req_id не прочитан).
  req_id: reqId.nullable(),
  code: z.enum(ERROR_CODES),
  text: z.string(),
  // busy: кто держит аренду и с какого времени.
  holder: z.string().optional(),
  since: z.int().optional(),
});

/** «Где мы» полями (5.6): то же, что словами в `text`. */
export const WhereDataSchema = z.object({
  episode: z
    .object({ id: z.int().positive(), topic: z.string(), role: z.string(), opened_at: z.int(), thread_id: z.int().nullable() })
    .nullable(),
  /**
   * Открытого эпизода нет — последний закрытый (по времени закрытия), как в закреплённой строке (проверка 0.2.0);
   * необязательное: прежний шлюз его не шлёт.
   */
  last_closed: z.object({ id: z.int().positive(), topic: z.string(), role: z.string(), closed_at: z.int() }).nullable().optional(),
  mode: ModeSchema,
  /** № событий, ждущих ответа агента (первые 50) и сколько всего. */
  waiting: z.array(seq),
  waiting_count: z.int().nonnegative(),
  /**
   * Материал без слов владельца в окне (0.3.6, issue #51): № событий, которые ждут его слов (первые 50); агенту ещё не
   * отданы. Необязательное: прежний шлюз его не шлёт.
   */
  held_material: z.array(seq).optional(),
  /** Сколько всего материала ждёт слов владельца (held_material — первые 50); необязательное, как held_material. */
  held_material_count: z.int().nonnegative().optional(),
  /** На связи ли агент; null — неизвестно (шлюз не ответил, CLI читал базу сам). */
  agent_online: z.boolean().nullable(),
  deferred: z.array(z.object({ update_id: z.int(), message_at: z.int() })),
  /** Закрыто без ответа за сутки (Оч-6). */
  closed_silent: z.array(seq),
  /** Эпизоды, у которых итога нет больше суток после отдачи episode_closed. */
  summary_missing: z.array(z.int().positive()),
});
export type WhereData = z.infer<typeof WhereDataSchema>;

export const WhereResultSchema = z.object({
  type: z.literal('where_result'),
  req_id: reqId,
  // То же, что «где мы» владельцу, словами.
  text: z.string(),
  data: WhereDataSchema.optional(),
});

export const GatewayMessageSchema = z.discriminatedUnion('type', [
  WelcomeSchema,
  EventMessageSchema,
  ModeMessageSchema,
  AckSchema,
  ErrorMessageSchema,
  WhereResultSchema,
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('pong') }),
]);
export type GatewayMessage = z.infer<typeof GatewayMessageSchema>;

// ——— Кадры ———

export type ParseResult<T> =
  | { ok: true; message: T }
  | { ok: false; code: 'bad_request'; text: string; req_id: string | null };

function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.map(String).join('.') : '(кадр)'}: ${i.message}`)
    .join('; ');
}

const ru = z.locales.ru().localeError;

function peekReqId(value: unknown): string | null {
  if (value && typeof value === 'object' && 'req_id' in value) {
    const r = (value as { req_id: unknown }).req_id;
    if (typeof r === 'string' && r.length > 0 && r.length <= 128) return r;
  }
  return null;
}

/** Разобрать строку от переходника. Ошибка — bad_request с req_id, если его удалось прочитать. */
export function parseAdapterLine(line: string): ParseResult<AdapterMessage> {
  if (Buffer.byteLength(line, 'utf8') + 1 > MAX_FRAME_BYTES) {
    return { ok: false, code: 'bad_request', text: 'кадр длиннее 1 МБ', req_id: null };
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, code: 'bad_request', text: 'кадр — не JSON', req_id: null };
  }
  const req_id = peekReqId(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'bad_request', text: 'кадр — не объект', req_id };
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !(ADAPTER_MESSAGE_TYPES as readonly string[]).includes(type)) {
    return { ok: false, code: 'bad_request', text: `неизвестный type «${String(type)}»`, req_id };
  }
  if (type === 'episode' && 'role' in value) {
    return { ok: false, code: 'bad_request', text: 'episode не принимает role: смена роли — со второй ролью', req_id };
  }
  const r = AdapterMessageSchema.safeParse(value, { error: ru });
  if (!r.success) return { ok: false, code: 'bad_request', text: issuesText(r.error), req_id };
  return { ok: true, message: r.data };
}

/** Разобрать строку от шлюза (сторона переходника). */
export function parseGatewayLine(line: string): { ok: true; message: GatewayMessage } | { ok: false; text: string } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, text: 'кадр — не JSON' };
  }
  const r = GatewayMessageSchema.safeParse(value, { error: ru });
  if (!r.success) return { ok: false, text: issuesText(r.error) };
  return { ok: true, message: r.data };
}

export class FrameTooLargeError extends Error {}

/**
 * Кадр: JSON + `\n`. Длиннее предела — ошибка (отправитель должен ужать, а не резать). Предел — 1 МБ; ответ шлюза на
 * `media` — до MAX_MEDIA_FRAME_BYTES.
 */
export function encodeFrame(message: object, maxBytes = MAX_FRAME_BYTES): string {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, 'utf8') + 1 > maxBytes) throw new FrameTooLargeError(`кадр длиннее ${Math.round(maxBytes / 1024 / 1024)} МБ`);
  return line + '\n';
}

export type DecodedFrame = { kind: 'line'; line: string } | { kind: 'oversize'; bytes: number };

/**
 * Резка потока на кадры по `\n`. Байты копятся до перевода строки, поэтому многобайтовый знак на границе куска
 * не рвётся. Кадр больше предела отбрасывается до следующего `\n` и даёт одно `oversize`: сокет не падает (A3.19).
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropping = false;
  private droppedBytes = 0;

  constructor(private readonly maxBytes = MAX_FRAME_BYTES) {}

  push(chunk: Buffer): DecodedFrame[] {
    const out: DecodedFrame[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) {
        this.append(chunk.subarray(start));
        break;
      }
      this.append(chunk.subarray(start, nl));
      if (this.dropping) {
        out.push({ kind: 'oversize', bytes: this.droppedBytes + 1 });
      } else {
        const line = Buffer.concat(this.chunks, this.size).toString('utf8');
        if (line.trim() !== '') out.push({ kind: 'line', line });
      }
      this.reset();
      start = nl + 1;
    }
    return out;
  }

  private append(part: Buffer): void {
    if (part.length === 0) return;
    if (this.dropping) {
      this.droppedBytes += part.length;
      return;
    }
    if (this.size + part.length + 1 > this.maxBytes) {
      this.dropping = true;
      this.droppedBytes = this.size + part.length;
      this.chunks = [];
      this.size = 0;
      return;
    }
    this.chunks.push(Buffer.from(part));
    this.size += part.length;
  }

  private reset(): void {
    this.chunks = [];
    this.size = 0;
    this.dropping = false;
    this.droppedBytes = 0;
  }
}
