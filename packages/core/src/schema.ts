// Схема базы (TECH-SPEC 5.2) и её миграции. Перечни из 5.2 — константы здесь и CHECK в схеме; совпадение
// проверяет модульный тест. Миграция, однажды выпущенная, не меняется: изменение схемы — новая миграция.
// Время — целые миллисекунды от часов шлюза (§7); datetime('now') в SQL не используется.

/**
 * events.kind. reaction (0.3.4, схема v11) — реакция владельца на ответ агента (P-31, issue #34): событие агенту, а не
 * сообщение владельца — 👀 и 👌 на нём нет, «ждут агента» его не считают.
 */
export const EVENT_KINDS = [
  'text',
  'voice',
  'photo',
  'document',
  'edit',
  'command',
  'callback',
  'closed_topic',
  'episode_closed',
  'episode_reopened',
  'probe',
  'reaction',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * events.status: new → delivered → processed; голосовое — с transcribing; handled — команды и нажатия. held и cancelled
 * (0.3.4, окно отмены реакции; GitHub issue #46: поставил не то и сразу убрал — агенту ничего, как при отмене отправки
 * письма) — только у реакции владельца: held — записана и ждёт
 * окна (events.hold_until), затем new; cancelled — в окне итог совпал с тем, что стояло до него (поставил и снял): агенту
 * ничего.
 */
export const EVENT_STATUSES = ['transcribing', 'held', 'new', 'delivered', 'processed', 'handled', 'closed_topic', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Метки доверия (5.4). */
export const TRUST_LABELS = ['owner', 'untrusted', 'owner_forward'] as const;
export type TrustLabel = (typeof TRUST_LABELS)[number];

/** updates.status */
export const UPDATE_STATUSES = ['in_progress', 'admitted', 'ignored', 'deferred'] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

/** outbox.status */
export const OUTBOX_STATUSES = ['pending', 'held', 'sent', 'dropped'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** edits.status: правки сообщений бота (M4) — квитанция голосового, кнопки после нажатия. */
export const EDIT_STATUSES = ['pending', 'sent', 'dropped'] as const;
export type EditStatus = (typeof EDIT_STATUSES)[number];

/** outbox.origin */
export const OUTBOX_ORIGINS = ['gateway', 'agent'] as const;
export type OutboxOrigin = (typeof OUTBOX_ORIGINS)[number];

/** messages_out.kind и outbox.kind: к чему относится сообщение бота (5.5а). */
export const MESSAGE_OUT_KINDS = ['agent', 'receipt', 'service'] as const;
export type MessageOutKind = (typeof MESSAGE_OUT_KINDS)[number];

/** episodes.opened_by */
export const EPISODE_OPENED_BY = [
  'first_event',
  'idle',
  'owner_new_topic',
  'telegram_topic',
  'agent_new',
  'owner_rejected',
] as const;
export type EpisodeOpenedBy = (typeof EPISODE_OPENED_BY)[number];

/** episodes.close_reason; role_change — со второй ролью. */
export const EPISODE_CLOSE_REASONS = [
  'idle',
  'owner_new_topic',
  'telegram_topic',
  'agent_new',
  'owner_rejected',
  'role_change',
] as const;
export type EpisodeCloseReason = (typeof EPISODE_CLOSE_REASONS)[number];

/** episodes.summary_trust: итог по эпизоду с чужим — untrusted кодом (Ш-25). */
export const SUMMARY_TRUST = ['owner', 'untrusted'] as const;

/** rules_log.status */
export const RULES_LOG_STATUSES = ['applied', 'pending', 'rejected', 'expired'] as const;
export type RulesLogStatus = (typeof RULES_LOG_STATUSES)[number];

/**
 * rules_log.actor — кто просил изменение (M5; без CHECK): agent — инструмент rule через протокол шлюза; owner_file —
 * ручная правка rules.yaml владельцем, прочитанная при перезапуске. Кто решил (кнопка владельца, срок, отказ шлюза) —
 * в rules_log.note.
 */
export const RULES_LOG_ACTORS = ['agent', 'owner_file'] as const;
export type RulesLogActor = (typeof RULES_LOG_ACTORS)[number];

/** Режим шлюза (meta.mode). */
export const MODES = ['running', 'paused', 'stopped'] as const;
export type Mode = (typeof MODES)[number];

/** Ключи meta. */
export const META_KEYS = {
  schemaVersion: 'schema_version',
  offset: 'offset',
  lastUpdateAt: 'last_update_at',
  cleanShutdown: 'clean_shutdown',
  startHistory: 'start_history',
  turn: 'turn',
  mode: 'mode',
  lastUnknownFrom: 'last_unknown_from',
  /** «Агент не на связи» уже сказано; снова — после того, как агент побывал на связи (Ш-14). */
  offlineNotice: 'offline_notice',
  /** Счётчик незнакомых (Ш-3: в журнал только счётчик). */
  ignoredCount: 'ignored_count',
  /** Адрес вебхука, о котором уже сказано владельцу. */
  webhookNotice: 'webhook_notice',
  /** Пробная запись тикера, пока диск полон (время). */
  diskProbe: 'disk_probe',
  /**
   * Последняя аренда не прошла проверку канала (5.10: probe без done 120 с) — JSON {at, adapter, cwd, pid}; снимается,
   * когда аренда проверена. `stg status`: «сессия открыта без канала — перезапусти start.sh».
   */
  channelUnverified: 'channel_unverified',
  /**
   * Отложенные обновления, которые сейчас повторяются (stg deferred retry) — JSON-список update_id. Упал шлюз на таком
   * снова — при старте оно уходит в отложенное, не трогая offset: его номер давно позади.
   */
  retrying: 'deferred_retrying',
  /** Хранение и чистка (5.8) — когда шла последняя (раз в сутки). */
  retentionAt: 'retention_at',
  /**
   * Закреплённая строка состояния (5.7, J-4) — JSON {chat_id, message_id, text, at, retry_at}: какое сообщение бота она,
   * что в нём сейчас, когда правилось (не чаще раза в 3 с) и когда повторить после сбоя.
   */
  statusLine: 'status_line',
  /**
   * Подсказка поля ввода, с которой последней ушла нижняя клавиатура в личку владельца (5.7, до 0.3.1). С 0.3.1 нижней
   * клавиатуры нет (P-18) и шлюз ключ не пишет: он остаётся в базе прежних версий только как
   * знак, что клавиатура у владельца была (keyboardRemoved).
   */
  keyboardPlaceholder: 'keyboard_placeholder',
  /**
   * Нижняя клавиатура снята у владельца (0.3.1; P-18: все команды — в меню) — JSON {at, outbox_id}: когда решено и какая строка с reply_markup {remove_keyboard: true} ушла владельцу
   * (outbox_id = null — снимать было нечего: бот владельцу ещё не писал, клавиатуры у него не было). Ключ есть — при
   * старте строка снятия больше не ставится: она уходит один раз, при первом старте версии.
   */
  keyboardRemoved: 'keyboard_removed',
  /**
   * Рабочая копия правил доступа (M5, AD-9) — JSON {v, rules, hash, file, pending}: правила целиком (их проекция —
   * subjects и transports), отпечаток rules.yaml, каким шлюз его знает, и «файл ещё не переписан».
   */
  rulesState: 'rules_state',
  /**
   * Строка владельцу об отказе модели (5.14, D-6) — JSON {sig, at, failure_at}: о какой ошибке сказано, когда и про
   * какой отказ (время из agent-state.json). Та же ошибка — снова не раньше, чем через час.
   */
  agentFailureNotice: 'agent_failure_notice',
  /**
   * Последняя проверенная аренда переходника, который назвал себя (0.3.2, R-4 а: ход модели —
   * только новой сессии) — JSON {lease_id, instance_hash, session_id, at}: какую аренду держал процесс переходника
   * (instance_hash — SHA-256 его instance_id: сам ключ в базу и журнал не пишется) и какая сессия Claude Code была тогда
   * в его каталоге (session_id строки состояния, 5.14; null — неизвестно). Тот же переходник с этой арендой в hello и
   * та же сессия — новая аренда проверена сразу, без пробы; отданное прежней аренде остаётся за ним (adapter.ts).
   */
  lastLease: 'last_lease',
  /** Сколько проверок канала обошлось без хода модели (0.3.2, R-4 а) — JSON {n, since, last_at}: «статус», stg status. */
  probesSaved: 'probes_saved',
} as const;

/** События, которые отдаются агенту (5.2): команды, нажатия и закрытая тема — нет; реакция владельца (0.3.4) — да. */
export const AGENT_EVENT_KINDS = ['text', 'voice', 'photo', 'document', 'edit', 'episode_closed', 'episode_reopened', 'probe', 'reaction'] as const;
/** События из сообщений владельца, которые «ждут агента» (строка «не на связи», Ш-14). */
export const MESSAGE_EVENT_KINDS = ['text', 'voice', 'photo', 'document', 'edit'] as const;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * Миграция пересобирает таблицу, на которую ссылаются внешние ключи (порядок из документации SQLite «Making Other Kinds
   * Of Table Schema Changes»): внешние ключи выключаются до транзакции, после SQL — PRAGMA foreign_key_check (нарушение —
   * откат), затем включаются снова (db.ts, migrate).
   */
  foreignKeysOff?: boolean;
}

/** Версия 1 — все таблицы 5.2. */
const SCHEMA_V1 = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
) STRICT;

-- Справочник участников (AD-9): кто есть кто. world_ref — ссылка на участника в модели мира агента, без содержимого.
CREATE TABLE subjects (
  id        TEXT PRIMARY KEY,
  who       TEXT NOT NULL,
  world_ref TEXT
) STRICT;

-- Записи о транспорте: telegram → номер. Номер принадлежит одному субъекту.
CREATE TABLE transports (
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  network    TEXT NOT NULL,
  address    TEXT NOT NULL,
  PRIMARY KEY (network, address)
) STRICT;
CREATE INDEX transports_subject ON transports(subject_id);

-- Приём и защита от дублей. raw_json — только у in_progress и deferred (у ignored не пишется, Ш-3).
CREATE TABLE updates (
  update_id   INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('in_progress','admitted','ignored','deferred')),
  crash_count INTEGER NOT NULL DEFAULT 0 CHECK (crash_count >= 0),
  raw_json    TEXT,
  CHECK (raw_json IS NULL OR status IN ('in_progress','deferred'))
) STRICT;
CREATE INDEX updates_status ON updates(status);
CREATE INDEX updates_received ON updates(received_at);

-- Журнал эпизодов (Ш-12). Открытый эпизод на пару «чат × субъект» — один.
CREATE TABLE episodes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id          INTEGER NOT NULL,
  subject_id       TEXT,
  topic            TEXT NOT NULL,
  role             TEXT NOT NULL,
  space            TEXT,
  opened_by        TEXT NOT NULL CHECK (opened_by IN ('first_event','idle','owner_new_topic','telegram_topic','agent_new','owner_rejected')),
  opened_at        INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  closed_at        INTEGER,
  close_reason     TEXT CHECK (close_reason IN ('idle','owner_new_topic','telegram_topic','agent_new','owner_rejected','role_change')),
  summary          TEXT,
  summary_trust    TEXT CHECK (summary_trust IN ('owner','untrusted')),
  prev_episode_id  INTEGER REFERENCES episodes(id),
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
) STRICT;
CREATE UNIQUE INDEX episodes_one_open ON episodes(chat_id, COALESCE(subject_id, '')) WHERE closed_at IS NULL;

-- Очередь событий. seq — сквозной и не переиспользуется (AUTOINCREMENT).
CREATE TABLE events (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id        INTEGER,
  message_id       INTEGER,
  chat_id          INTEGER,
  thread_id        INTEGER,
  subject_id       TEXT,
  trust            TEXT CHECK (trust IN ('owner','untrusted','owner_forward')),
  mixed            INTEGER NOT NULL DEFAULT 0 CHECK (mixed IN (0,1)),
  attachments_json TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('text','voice','photo','document','edit','command','callback','closed_topic','episode_closed','episode_reopened','probe')),
  text             TEXT,
  transcript       TEXT,
  raw_ref          TEXT,
  forward_json     TEXT,
  reply_to         TEXT,
  edit_of          INTEGER REFERENCES events(seq),
  episode_id       INTEGER REFERENCES episodes(id),
  status           TEXT NOT NULL CHECK (status IN ('transcribing','new','delivered','processed','handled','closed_topic')),
  lease_id         TEXT,
  delivered_at     INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processed_at     INTEGER,
  processed_silent INTEGER NOT NULL DEFAULT 0 CHECK (processed_silent IN (0,1)),
  turn             INTEGER,
  created_at       INTEGER NOT NULL,
  message_date     INTEGER
) STRICT;
CREATE INDEX events_status ON events(status, seq);
CREATE INDEX events_message ON events(chat_id, message_id);
CREATE INDEX events_update ON events(update_id);
CREATE INDEX events_episode ON events(episode_id);

-- Отправка с повтором.
CREATE TABLE outbox (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_seq      INTEGER REFERENCES events(seq),
  chat_id        INTEGER NOT NULL,
  thread_id      INTEGER,
  kind           TEXT NOT NULL CHECK (kind IN ('agent','receipt','service')),
  text           TEXT,
  voice          INTEGER NOT NULL DEFAULT 0 CHECK (voice IN (0,1)),
  turn           INTEGER,
  origin         TEXT NOT NULL CHECK (origin IN ('gateway','agent')),
  status         TEXT NOT NULL CHECK (status IN ('pending','held','sent','dropped')),
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_try_at    INTEGER,
  tg_message_ids TEXT,
  created_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX outbox_status ON outbox(status, next_try_at);
CREATE INDEX outbox_event ON outbox(event_seq);

-- Квитанция события → сообщение Telegram (для правки). Сводная квитанция — одно сообщение на несколько событий.
CREATE TABLE receipts (
  event_seq     INTEGER PRIMARY KEY REFERENCES events(seq),
  tg_message_id INTEGER NOT NULL
) STRICT;
CREATE INDEX receipts_message ON receipts(tg_message_id);

-- Всё, что отправил бот: к чему относится каждое его сообщение (реплаи владельца, 5.5а).
CREATE TABLE messages_out (
  chat_id       INTEGER NOT NULL,
  tg_message_id INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('agent','receipt','service')),
  outbox_id     INTEGER REFERENCES outbox(id),
  event_seq     INTEGER REFERENCES events(seq),
  PRIMARY KEY (chat_id, tg_message_id)
) STRICT;

-- Одноразовые кнопки владельца (Ш-22). token — callback_data, не длиннее 64 байт.
CREATE TABLE buttons (
  token        TEXT PRIMARY KEY CHECK (length(CAST(token AS BLOB)) BETWEEN 1 AND 64),
  kind         TEXT NOT NULL,
  payload_json TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
) STRICT;

-- Изменения правил (Ш-17).
CREATE TABLE rules_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  change_json  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('applied','pending','rejected','expired')),
  button_token TEXT REFERENCES buttons(token)
) STRICT;

-- Журнал задержек (Ш-16), миллисекунды.
CREATE TABLE latency (
  event_seq     INTEGER PRIMARY KEY REFERENCES events(seq),
  t_update      INTEGER,
  t_eyes        INTEGER,
  t_admit       INTEGER,
  t_receipt     INTEGER,
  t_delivered   INTEGER,
  t_reply_sent  INTEGER
) STRICT;
`;

/**
 * Версия 2 (M2): разметка сообщения бота и тема Telegram эпизода.
 * - outbox.reply_markup — встроенные кнопки шлюза ([продолжить], [верно] [не то]); нижняя клавиатура со строкой
 *   состояния к строке не пишется — её ставит отправитель в момент отправки (подсказка — по эпизоду на этот момент);
 * - episodes.thread_id — тема Telegram, в которой идёт эпизод (null — основной поток): сообщение в другую тему
 *   закрывает эпизод (telegram_topic, 5.7).
 */
const SCHEMA_V2 = `
ALTER TABLE outbox ADD COLUMN reply_markup TEXT;
ALTER TABLE episodes ADD COLUMN thread_id INTEGER;
`;

/**
 * Версия 3 (M4): голос.
 * - edits — правки сообщений бота с повтором, как outbox: снятие встроенных кнопок после нажатия (до 0.3.1 — и квитанция
 *   голосового «распознаю…» → первые слова, затем «→ ответил»; с 0.3.1 она не правится). Цель — первое сообщение строки
 *   outbox (outbox_id) или сообщение Telegram прямо (tg_message_id). text = NULL — правится только разметка;
 *   reply_markup = NULL — кнопки снимаются;
 * - outbox.reply_to_message_id — строка шлюза реплаем на сообщение владельца (полная расшифровка — ответом на
 *   голосовое, 5.5);
 * - outbox.voice_failed — синтез ответа голосом не удался (5.5): ответ уходит текстом с пометкой «⚙ голос не
 *   получился»; отметка в базе — чтобы после перезапуска части ответа шли тем же порядком.
 */
const SCHEMA_V3 = `
CREATE TABLE edits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  outbox_id     INTEGER REFERENCES outbox(id),
  tg_message_id INTEGER,
  event_seq     INTEGER REFERENCES events(seq),
  text          TEXT,
  reply_markup  TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending','sent','dropped')),
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_try_at   INTEGER,
  created_at    INTEGER NOT NULL,
  CHECK (outbox_id IS NOT NULL OR tg_message_id IS NOT NULL)
) STRICT;
CREATE INDEX edits_status ON edits(status, next_try_at);
CREATE INDEX edits_outbox ON edits(outbox_id);
ALTER TABLE outbox ADD COLUMN reply_to_message_id INTEGER;
ALTER TABLE outbox ADD COLUMN voice_failed INTEGER NOT NULL DEFAULT 0 CHECK (voice_failed IN (0,1));
`;

/**
 * Версия 4 (M5): правила и кнопки.
 * - rules_log.decided_at — когда изменение применено, отклонено или истекло (at — когда его попросили);
 * - rules_log.outbox_id — карточка изменения владельцу (кнопки [разрешить] [нет] снимаются по сроку);
 * - rules_log.note — кто или что решил: кнопка владельца, срок кнопки, отказ шлюза и его причина.
 */
const SCHEMA_V4 = `
ALTER TABLE rules_log ADD COLUMN decided_at INTEGER;
ALTER TABLE rules_log ADD COLUMN outbox_id INTEGER REFERENCES outbox(id);
ALTER TABLE rules_log ADD COLUMN note TEXT;
CREATE INDEX rules_log_status ON rules_log(status);
`;

/**
 * Версия 5 (исправления по проверке M2–M5): ключ повтора ответа агента.
 * - outbox.idem — ключ, который канал ставит в reply (протокол v1, необязательное поле): обрыв связи посреди reply —
 *   тот же ответ, присланный снова с тем же ключом, второй строкой не встаёт (ответ дошёл бы дважды). Ключ помнится, пока
 *   жива строка outbox; смотрится за сутки.
 */
const SCHEMA_V5 = `
ALTER TABLE outbox ADD COLUMN idem TEXT;
CREATE INDEX outbox_idem ON outbox(idem) WHERE idem IS NOT NULL;
`;

/**
 * Версия 6 (0.2.0, J-4: меньше лишних сообщений, квитанции реакциями; аудиофайлы до 15 минут).
 * - reactions — реакция шлюза на сообщение владельца (с 0.3.2: 👀 «агент увидел» после delivered, 👌 «агент ответил»
 *   после reply или done, правка — реакция снимается до 👀; 0.3.1 — ещё ✍ «записал» после COMMIT; ещё раньше — 👀 при
 *   приёме и ✍). Строка на сообщение
 *   Telegram (chat_id, message_id): важна только последняя реакция (want), event_seq — последнее событие этого сообщения
 *   (правка — тоже). shown — что стоит сейчас; fallback_at и fallback_sent — запасная текстовая квитанция ранних версий
 *   (теперь её нет, поля не заполняются);
 * - deletions — сообщения, которые бот удаляет: команда владельца после исполнения (command), ответ «где мы» через срок
 *   или при следующем «где мы» (where), служебное сообщение Telegram о закреплении строки состояния (pin_notice). Цель —
 *   сообщение Telegram прямо или строка outbox (все её части, когда отправлена);
 * - outbox.bare — без разметки шлюза (до 0.3.1 — без нижней клавиатуры): квитанции голоса и аудио (с 0.3.1 —
 *   расшифровка ответом на голосовое) и ответ «где мы» (его удаляют);
 * - events.stt_note — почему аудиофайл не распознаётся: too_long (длиннее stt.audio_max_minutes — только скачивается) ·
 *   too_big (больше 20 МБ — бот его не скачает).
 */
const SCHEMA_V6 = `
CREATE TABLE reactions (
  chat_id       INTEGER NOT NULL,
  message_id    INTEGER NOT NULL,
  event_seq     INTEGER NOT NULL REFERENCES events(seq),
  want          TEXT NOT NULL,
  shown         TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_try_at   INTEGER,
  created_at    INTEGER NOT NULL,
  fallback_at   INTEGER,
  fallback_sent INTEGER NOT NULL DEFAULT 0 CHECK (fallback_sent IN (0,1)),
  PRIMARY KEY (chat_id, message_id)
) STRICT;
CREATE INDEX reactions_status ON reactions(status, next_try_at);
CREATE INDEX reactions_event ON reactions(event_seq);
CREATE TABLE deletions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  tg_message_id INTEGER,
  outbox_id     INTEGER REFERENCES outbox(id),
  reason        TEXT NOT NULL CHECK (reason IN ('command','where','pin_notice')),
  due_at        INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','sent','dropped')),
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_try_at   INTEGER,
  created_at    INTEGER NOT NULL,
  CHECK (outbox_id IS NOT NULL OR tg_message_id IS NOT NULL)
) STRICT;
CREATE INDEX deletions_status ON deletions(status, due_at);
ALTER TABLE outbox ADD COLUMN bare INTEGER NOT NULL DEFAULT 0 CHECK (bare IN (0,1));
ALTER TABLE events ADD COLUMN stt_note TEXT CHECK (stt_note IN ('too_long','too_big'));
`;

/**
 * Версия 7 (исправления по проверке 0.2.0): events.audio_seconds — длительность аудиофайла, определённая шлюзом по самому
 * файлу (audio-duration.ts), когда у Telegram её нет (document): по ней — предел stt.audio_max_minutes, срок попытки
 * распознавания, квитанция и поле audio агенту. NULL — метаданные Telegram есть (берутся они) или по файлу не вышло.
 */
const SCHEMA_V7 = `
ALTER TABLE events ADD COLUMN audio_seconds REAL CHECK (audio_seconds IS NULL OR audio_seconds >= 0);
`;

/**
 * Версия 8 (0.3: агент видит картинки и скриншоты; кружки и видео распознаются): events.media_ref — картинка, которую агент смотрит инструментом media(seq):
 * выбранный размер фото, изображение, присланное файлом, кадр-обложка кружка или видео (или уменьшенная копия Telegram,
 * когда файл слишком большой для просмотра). Шлюз скачивает её по первому запросу агента и кладёт в
 * raw/<дата>/<update_id>.media.<расширение>; повторный запрос берёт файл отсюда. raw_ref — по-прежнему звук (голосовое,
 * аудиофайл, звуковая дорожка кружка и видео). Хранение и чистка — как у файлов (retention.ts).
 */
const SCHEMA_V8 = `
ALTER TABLE events ADD COLUMN media_ref TEXT;
`;

/**
 * Версия 9 (0.3.2; P-26: владельцу видно, чьи это слова — агента, шлюза или переданные через агента):
 * outbox.from_name — чьи слова агент передаёт (reply.from): шлюз ставит перед ответом
 * «↪ <имя>: ». NULL — отвечает сам агент.
 */
const SCHEMA_V9 = `
ALTER TABLE outbox ADD COLUMN from_name TEXT;
`;

/**
 * Версия 10 (0.3.3, посылки; P-23, issue #29: агент присылает владельцу файлы из промежуточной папки, из неё же потом
 * — публикация в веб-сервис): deliveries — доставки посылок. Строка на каждую отдачу файла агентом
 * (send_file): какая посылка и файл (путь внутри посылки), версия — SHA-256 содержимого, копия в хранилище шлюза
 * (copy_ref — raw/parcels/<sha256>: повтор не зависит от правок агента; NULL — копия удалена по сроку), куда (target —
 * telegram; дальше — web), в какой чат, к какому событию и строке outbox (у telegram), статус (pending → sent · dropped ·
 * failed), message_id документа в Telegram, «где смотреть» (url — у будущей цели web), новая ли это версия того же файла
 * (updated — подпись «обновлено»), ключ повтора (idem), почему не дошло (note), сколько попыток загрузки кончились
 * таймаутом (timeouts — после третьей доставка failed: медленная сеть не держит очередь без конца, находка проверки
 * 0.3.3). Состояние доставок посылку в папке агента не засоряет: его ведёт шлюз здесь.
 */
const SCHEMA_V10 = `
CREATE TABLE deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  parcel        TEXT NOT NULL,
  file          TEXT NOT NULL,
  bytes         INTEGER NOT NULL CHECK (bytes > 0),
  sha256        TEXT NOT NULL,
  copy_ref      TEXT,
  target        TEXT NOT NULL,
  chat_id       INTEGER,
  event_seq     INTEGER REFERENCES events(seq),
  outbox_id     INTEGER REFERENCES outbox(id),
  status        TEXT NOT NULL CHECK (status IN ('pending','sent','dropped','failed')),
  tg_message_id INTEGER,
  url           TEXT,
  updated       INTEGER NOT NULL DEFAULT 0 CHECK (updated IN (0,1)),
  idem          TEXT,
  note          TEXT,
  timeouts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  sent_at       INTEGER
) STRICT;
CREATE INDEX deliveries_file ON deliveries(parcel, file, target, chat_id);
CREATE INDEX deliveries_outbox ON deliveries(outbox_id);
CREATE INDEX deliveries_status ON deliveries(status);
CREATE INDEX deliveries_copy ON deliveries(copy_ref) WHERE copy_ref IS NOT NULL;
CREATE INDEX deliveries_idem ON deliveries(idem) WHERE idem IS NOT NULL;
`;

/**
 * Версия 11 (0.3.4; сведена в main поверх 0.3.3 — миграции по порядку 10 → 11). Номер 10 — у 0.3.3 (посылки, таблица
 * deliveries). Пересборка events копирует столбцы явным списком: 0.3.3 events не меняла; deliveries ссылается на
 * events(seq) и outbox(id) — foreign_key_check в конце миграции проверяет и её.
 * - events.kind = 'reaction' и events.reaction_json — реакция владельца на ответ агента (P-31, issue #34): JSON
 *   {message_id, outbox_id, to_seq, emoji, old, excerpt} — на какое сообщение бота (ответ агента), к какому событию
 *   был ответ, что стоит теперь и что стояло, начало ответа (admission.ts, handleReaction). CHECK вида в SQLite не
 *   меняется на месте — таблица пересобирается по документации SQLite (внешние ключи выключены на время миграции,
 *   foreignKeysOff): новая таблица → копия строк → счётчик AUTOINCREMENT не меньше прежнего (номер события не
 *   переиспользуется, 5.2) → старая удаляется → новая переименовывается → индексы заново → foreign_key_check.
 * - outbox.quote — строка шлюза уходит цитатой: расшифровка голосового, кружка, аудиофайла, видео (R-23 а: по цитате
 *   видно, что это не слова агента): отправитель шлёт текст в <blockquote> (sender.ts, splitQuote). Строки прежних
 *   версий — 0: уходят как раньше.
 * - Окно отмены реакции (дописано в v11 до её выпуска: баз на v11 ещё не было, отдельной v12 не нужно; GitHub issue
 *   #46: окно не больше 3 с, чтобы не мешать переписке): статусы held и cancelled — только у реакции (CHECK);
 *   events.hold_until — с какого времени (часы шлюза) реакцию можно отдавать агенту: у held обязателен, после окна остаётся как отметка (reaction-hold.ts).
 */
const SCHEMA_V11 = `
CREATE TABLE events_v11 (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id        INTEGER,
  message_id       INTEGER,
  chat_id          INTEGER,
  thread_id        INTEGER,
  subject_id       TEXT,
  trust            TEXT CHECK (trust IN ('owner','untrusted','owner_forward')),
  mixed            INTEGER NOT NULL DEFAULT 0 CHECK (mixed IN (0,1)),
  attachments_json TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('text','voice','photo','document','edit','command','callback','closed_topic','episode_closed','episode_reopened','probe','reaction')),
  text             TEXT,
  transcript       TEXT,
  raw_ref          TEXT,
  forward_json     TEXT,
  reply_to         TEXT,
  edit_of          INTEGER REFERENCES events(seq),
  episode_id       INTEGER REFERENCES episodes(id),
  status           TEXT NOT NULL CHECK (status IN ('transcribing','held','new','delivered','processed','handled','closed_topic','cancelled')),
  lease_id         TEXT,
  delivered_at     INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processed_at     INTEGER,
  processed_silent INTEGER NOT NULL DEFAULT 0 CHECK (processed_silent IN (0,1)),
  turn             INTEGER,
  created_at       INTEGER NOT NULL,
  message_date     INTEGER,
  stt_note         TEXT CHECK (stt_note IN ('too_long','too_big')),
  audio_seconds    REAL CHECK (audio_seconds IS NULL OR audio_seconds >= 0),
  media_ref        TEXT,
  reaction_json    TEXT,
  hold_until       INTEGER,
  CHECK ((kind = 'reaction') = (reaction_json IS NOT NULL)),
  CHECK (status NOT IN ('held','cancelled') OR kind = 'reaction'),
  CHECK (status <> 'held' OR hold_until IS NOT NULL)
) STRICT;
INSERT INTO events_v11(seq, update_id, message_id, chat_id, thread_id, subject_id, trust, mixed, attachments_json, kind, text,
  transcript, raw_ref, forward_json, reply_to, edit_of, episode_id, status, lease_id, delivered_at, attempts, processed_at,
  processed_silent, turn, created_at, message_date, stt_note, audio_seconds, media_ref)
SELECT seq, update_id, message_id, chat_id, thread_id, subject_id, trust, mixed, attachments_json, kind, text,
  transcript, raw_ref, forward_json, reply_to, edit_of, episode_id, status, lease_id, delivered_at, attempts, processed_at,
  processed_silent, turn, created_at, message_date, stt_note, audio_seconds, media_ref
FROM events ORDER BY seq;
UPDATE sqlite_sequence SET seq = max(seq, (SELECT seq FROM sqlite_sequence WHERE name = 'events'))
WHERE name = 'events_v11' AND EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'events');
INSERT INTO sqlite_sequence(name, seq) SELECT 'events_v11', seq FROM sqlite_sequence
WHERE name = 'events' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'events_v11');
DROP TABLE events;
ALTER TABLE events_v11 RENAME TO events;
CREATE INDEX events_status ON events(status, seq);
CREATE INDEX events_message ON events(chat_id, message_id);
CREATE INDEX events_update ON events(update_id);
CREATE INDEX events_episode ON events(episode_id);
ALTER TABLE outbox ADD COLUMN quote INTEGER NOT NULL DEFAULT 0 CHECK (quote IN (0,1));
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'схема 0.1: все таблицы 5.2', sql: SCHEMA_V1 },
  { version: 2, name: 'кнопки в outbox, тема Telegram у эпизода', sql: SCHEMA_V2 },
  { version: 3, name: 'голос: правки сообщений бота, реплай строки шлюза, отказ синтеза', sql: SCHEMA_V3 },
  { version: 4, name: 'правила: когда решено, карточка, кто решил', sql: SCHEMA_V4 },
  { version: 5, name: 'ключ повтора ответа агента', sql: SCHEMA_V5 },
  { version: 6, name: 'квитанции реакциями, удаление сообщений, аудиофайлы', sql: SCHEMA_V6 },
  { version: 7, name: 'длительность аудиофайла по самому файлу', sql: SCHEMA_V7 },
  { version: 8, name: 'картинка для агента: файл для просмотра (media)', sql: SCHEMA_V8 },
  { version: 9, name: 'чьи слова передаёт агент (reply.from)', sql: SCHEMA_V9 },
  { version: 10, name: 'посылки: доставки файлов агента (send_file)', sql: SCHEMA_V10 },
  { version: 11, name: 'реакция владельца на ответ агента; расшифровка цитатой', sql: SCHEMA_V11, foreignKeysOff: true },
];

/**
 * deliveries.status (0.3.3): pending → sent · dropped («стоп») · failed (Telegram не принял, копия пропала, загрузка трижды
 * не успела). dropped → sent — только когда документ был уже в пути при «стопе» и всё же дошёл (note «ушёл после стопа»).
 */
export const DELIVERY_STATUSES = ['pending', 'sent', 'dropped', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * Реакция владельца на сообщение бота (0.3.4), events.reaction_json. Событие заводится только на ответ агента (строка
 * outbox origin = agent, messages_out.kind = agent); снятие — тоже событие (emoji пуст, old — что было) ⟨предл.⟩.
 */
export interface OwnerReaction {
  /** Сообщение бота, на котором владелец поменял реакцию. */
  message_id: number;
  /** Строка outbox этого ответа. */
  outbox_id: number | null;
  /** Событие, на которое агент отвечал (outbox.event_seq); null — сообщение по своей инициативе. */
  to_seq: number | null;
  /** Что стоит теперь (эмодзи по порядку; свой эмодзи и платная — словами, ownerReactionLabel); пусто — снял. */
  emoji: string[];
  /** Что стояло до этого. */
  old: string[];
  /** Начало ответа агента, до 200 знаков (как у реплая, 5.4). */
  excerpt: string;
}

/**
 * Реакции шлюза на сообщение владельца (5.5). С 0.3.2 (развилка R-1 б: ✍ не ставится) — только 👀 «агент увидел» (событие
 * отдано агенту, delivered) → 👌 «агент ответил» (reply на него или done). ✍ «записал» (0.3.1) шлюз больше не ставит; знак остаётся здесь только как реакция
 * прежней версии: строки reactions, где он ждёт отправки, полоса закрывает без запроса, а стоящий ✍ сменят 👀 и 👌
 * своим ходом (reactions.ts). Порядок — по REACTION_ORDER: реакция того же события не сменяется более ранней.
 */
export const REACTIONS = { recorded: '✍', seen: '👀', processed: '👌' } as const;
export type ReactionEmoji = (typeof REACTIONS)[keyof typeof REACTIONS];
/** Порядок реакций одного события: (✍ прежней версии) → 👀 → 👌. */
export const REACTION_ORDER: readonly ReactionEmoji[] = [REACTIONS.recorded, REACTIONS.seen, REACTIONS.processed];
/**
 * «Реакции нет» (0.3.2) — want строки reactions, когда реакцию надо снять: владелец поправил сообщение, а агент правку
 * ещё не видел — прежние 👀 или 👌 относились к старому тексту ⟨предл.⟩. Место в порядке — самое раннее: 👀 и 👌 правки
 * его сменяют.
 */
export const REACTION_CLEARED = '';

/** reactions.status */
export const REACTION_STATUSES = ['pending', 'done', 'failed'] as const;

/** deletions.reason: команда владельца · ответ «где мы» · служебное сообщение о закреплении. */
export const DELETION_REASONS = ['command', 'where', 'pin_notice'] as const;
export type DeletionReason = (typeof DELETION_REASONS)[number];

/** events.stt_note: звук файлом (аудиофайл, кружок, видео) длиннее предела (только скачивается) · больше 20 МБ (не скачивается). */
export const STT_NOTES = ['too_long', 'too_big'] as const;
export type SttNote = (typeof STT_NOTES)[number];

/**
 * Виды одноразовых кнопок шлюза (buttons.kind; без CHECK — дополняются без миграции). rule_ok и rule_no — [разрешить] и
 * [нет] под карточкой изменения правил (M5).
 */
export const BUTTON_KINDS = ['resume', 'episode_ok', 'episode_reject', 'episode_pick', 'transcript', 'rule_ok', 'rule_no'] as const;
export type ButtonKind = (typeof BUTTON_KINDS)[number];

export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** Таблицы текущей схемы — для проверок doctor и тестов. */
export const SCHEMA_TABLES = [
  'meta',
  'subjects',
  'transports',
  'updates',
  'episodes',
  'events',
  'outbox',
  'receipts',
  'messages_out',
  'buttons',
  'rules_log',
  'latency',
  'edits',
  'reactions',
  'deletions',
  'deliveries',
] as const;
