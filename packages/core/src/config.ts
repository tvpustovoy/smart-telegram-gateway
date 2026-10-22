// config.yaml и rules.yaml: загрузка и проверка (TECH-SPEC 5.1, 5.9). Владелец задан в config.yaml, а не в
// правилах: правилом его не убрать (Ш-21). Номер Telegram — запись о транспорте субъекта (AD-9).
// Голос (5.8): stt и tts — независимо, каждый со своим провайдером (openai по умолчанию | elevenlabs), адресом, моделью
// и именем ключа в связке ключей.

import fs from 'node:fs';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { writeFileAtomicSync } from './fsutil.js';
import { ELEVENLABS_BASE_URL } from './elevenlabs.js';
import { OPENAI_BASE_URL } from './openai.js';
import { DEFAULT_PARCEL_TARGET, PARCEL_TARGET_RE } from './parcels.js';
import { roleLabel } from './strings.js';
import { VOICE_PROVIDERS, type VoiceProviderName } from './voice-provider.js';

const ru = z.locales.ru().localeError;

/** Сети записей о транспорте. В 0.1 — только Telegram. */
export const NETWORKS = ['telegram'] as const;

const positiveMinutes = z.int().positive();

const httpUrl = z.url({ protocol: /^https?$/ });

const keyterm = z
  .string()
  .min(1)
  .refine((s) => s.length < 50, { message: 'термин словаря — меньше 50 знаков' })
  .refine((s) => s.trim().split(/\s+/).length <= 5, { message: 'термин словаря — не больше 5 слов' });

/** Словарь распознавания (5.8): у ElevenLabs больше 100 терминов — запрос не быстрее 20 с, больше 1000 — не берёт. */
export const KEYTERMS_FAST_LIMIT = 100;
export const KEYTERMS_MAX = 1000;

const vocabulary = z.array(keyterm).max(KEYTERMS_MAX, { message: `словарь — не больше ${KEYTERMS_MAX} терминов` }).default([]);

/**
 * Имя ключа голоса — учётная запись в связке ключей (служба smart-telegram-gateway) ровно как задано; по умолчанию —
 * имя провайдера. Знаки — такие, чтобы команда `security … -a <имя> -w` читалась без кавычек.
 */
const keyName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/, { message: 'имя ключа — латиница, цифры, «_», «.», «@», «-», до 64 знаков' });

const modelName = z.string().min(1);
const language = z.string().min(2).default('ru');
/**
 * Аудиофайлы (J-2: файлы до 15 минут распознаются сразу, без нарезки): длиннее — не распознаются, файл сохраняется. Общая настройка распознавания, у обоих провайдеров.
 */
export const DEFAULT_AUDIO_MAX_MINUTES = 15;
const audioMaxMinutes = z.int().positive().max(240).default(DEFAULT_AUDIO_MAX_MINUTES);

/** Провайдер голоса по умолчанию — openai. */
export const DEFAULT_VOICE_PROVIDER: VoiceProviderName = 'openai';

/**
 * Модель распознавания openai по умолчанию (P-20): сверка на реальных записях —
 * gpt-4o-transcribe терял текст (33 с звука → 6 слов), gpt-4o-mini-transcribe и whisper-1 — текст целиком.
 */
export const DEFAULT_OPENAI_STT_MODEL = 'gpt-4o-mini-transcribe';

const OpenAiSttSchema = z.strictObject({
  provider: z.literal('openai'),
  // OpenAI напрямую; любой OpenAI-совместимый адрес. OpenRouter — https://openrouter.ai/api/v1 (модель с префиксом:
  // openai/…) — только распознавание: синтез OpenRouter отдаёт mp3 или pcm, не Ogg/Opus.
  base_url: httpUrl.default(OPENAI_BASE_URL),
  // Модель по умолчанию — gpt-4o-mini-transcribe (P-20). Основание — сверка на реальных записях: gpt-4o-transcribe теряет текст и непостоянен (33 с звука → 6 слов; потеряны начало и конец фразы), а
  // gpt-4o-mini-transcribe и whisper-1 дают текст целиком. Другая модель — stt.model в config.yaml.
  model: modelName.default(DEFAULT_OPENAI_STT_MODEL),
  key: keyName.default('openai'),
  language,
  // Словарь — в поле prompt строкой через запятую.
  vocabulary,
  audio_max_minutes: audioMaxMinutes,
});

const ElevenSttSchema = z.strictObject({
  provider: z.literal('elevenlabs'),
  base_url: httpUrl.default(ELEVENLABS_BASE_URL),
  // Модель Scribe (имя — по документации ElevenLabs; на реальном ключе не сверено). Прежнее имя поля — model_id.
  model: modelName.default('scribe_v2'),
  key: keyName.default('elevenlabs'),
  language,
  // Словарь — поля keyterms. Прежнее имя поля — keyterms.
  vocabulary,
  audio_max_minutes: audioMaxMinutes,
});

const OpenAiTtsSchema = z.strictObject({
  provider: z.literal('openai'),
  base_url: httpUrl.default(OPENAI_BASE_URL),
  // ⟨предл.⟩ Модель — по документации OpenAI; на реальном ключе не сверено.
  model: modelName.default('gpt-4o-mini-tts'),
  key: keyName.default('openai'),
  // Голос из стандартных голосов OpenAI; alloy есть у всех моделей синтеза.
  voice: z.string().min(1).default('alloy'),
  // Как говорить (только у gpt-4o-mini-tts и новее): «спокойно, по-деловому».
  instructions: z.string().min(1).max(2000).nullable().default(null),
});

const ElevenTtsSchema = z.strictObject({
  provider: z.literal('elevenlabs'),
  base_url: httpUrl.default(ELEVENLABS_BASE_URL),
  // Прежнее имя поля — model_id.
  model: modelName.default('eleven_multilingual_v2'),
  key: keyName.default('elevenlabs'),
  voice_id: z.string().min(1).nullable().default(null),
  output_format: z.string().regex(/^opus_48000_\d+$/, { message: 'голос в Telegram — только Ogg/Opus: opus_48000_<битрейт>' }).default('opus_48000_64'),
});

/** Прежние имена полей ElevenLabs (config ранних сборок): model_id → model, keyterms → vocabulary. */
const ELEVEN_ALIASES: Record<'stt' | 'tts', Array<[string, string]>> = {
  stt: [
    ['model_id', 'model'],
    ['keyterms', 'vocabulary'],
  ],
  tts: [['model_id', 'model']],
};

/** Поля раздела у каждого провайдера (с прежними именами ElevenLabs) — чтобы подсказать, у кого поле есть. */
const FIELDS_OF: Record<'stt' | 'tts', Record<VoiceProviderName, ReadonlySet<string>>> = {
  stt: {
    openai: new Set(Object.keys(OpenAiSttSchema.shape)),
    elevenlabs: new Set([...Object.keys(ElevenSttSchema.shape), ...ELEVEN_ALIASES.stt.map(([old]) => old)]),
  },
  tts: {
    openai: new Set(Object.keys(OpenAiTtsSchema.shape)),
    elevenlabs: new Set([...Object.keys(ElevenTtsSchema.shape), ...ELEVEN_ALIASES.tts.map(([old]) => old)]),
  },
};

/** Поля, которые есть только у другого провайдера, — подсказка вместо «нераспознанный ключ». */
const FOREIGN_FIELDS: Record<'stt' | 'tts', Record<VoiceProviderName, Record<string, string>>> = {
  stt: {
    openai: { keyterms: 'у openai словарь — vocabulary', model_id: 'у openai модель — model' },
    elevenlabs: {},
  },
  tts: {
    openai: {
      voice_id: 'у openai голос — voice',
      output_format: 'у openai формат один — opus (Ogg/Opus для Telegram), поле не нужно',
      model_id: 'у openai модель — model',
    },
    elevenlabs: { voice: 'у elevenlabs голос — voice_id', instructions: 'instructions — только у openai' },
  },
};

/**
 * Раздел stt или tts до проверки схемой: провайдер по умолчанию; неизвестный провайдер — ошибка по-русски; прежние
 * имена полей ElevenLabs; поля другого провайдера — с подсказкой.
 */
function voiceSection(what: 'stt' | 'tts') {
  return (value: unknown, ctx: z.core.$RefinementCtx): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const v: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    // Провайдер не задан — по умолчанию openai. В ранних сборках по умолчанию был elevenlabs: такой config подсказкой ведётся к
    // provider: elevenlabs, а не молча к полям OpenAI.
    const defaulted = v.provider === undefined;
    if (defaulted) v.provider = DEFAULT_VOICE_PROVIDER;
    const provider = v.provider;
    if (typeof provider !== 'string' || !(VOICE_PROVIDERS as readonly string[]).includes(provider)) {
      ctx.addIssue({
        code: 'custom',
        path: ['provider'],
        message: `неизвестный провайдер «${String(provider)}»: ${VOICE_PROVIDERS.join(' или ')}`,
        input: provider,
      });
      return z.NEVER;
    }
    const p = provider as VoiceProviderName;
    if (p === 'elevenlabs') {
      for (const [old, now] of ELEVEN_ALIASES[what]) {
        if (!(old in v)) continue;
        if (now in v) {
          ctx.addIssue({ code: 'custom', path: [old], message: `${old} и ${now} — одно поле: оставь ${now}`, input: v[old] });
          continue;
        }
        v[now] = v[old];
        delete v[old];
      }
    }
    for (const [field, hint] of Object.entries(FOREIGN_FIELDS[what][p])) {
      if (!(field in v)) continue;
      const owners = VOICE_PROVIDERS.filter((q) => q !== p && FIELDS_OF[what][q].has(field));
      const alt = defaulted && owners.length ? `; если это настройка ${owners.join(' или ')} — укажи provider: ${owners[0]} (без provider — ${p}; в ранних сборках — elevenlabs)` : '';
      ctx.addIssue({ code: 'custom', path: [field], message: `нет такого поля у ${p}: ${hint}${alt}`, input: v[field] });
    }
    return v;
  };
}

export const SttConfigSchema = z.preprocess(voiceSection('stt'), z.discriminatedUnion('provider', [OpenAiSttSchema, ElevenSttSchema]));

export const TtsConfigSchema = z.preprocess(voiceSection('tts'), z.discriminatedUnion('provider', [OpenAiTtsSchema, ElevenTtsSchema]));

/**
 * Окно отмены реакции владельца на ответ агента (0.3.4; GitHub issue #46): поставил не ту реакцию и сразу убрал — агенту
 * ничего, как при отмене отправки письма. Окно короткое, чтобы не мешать переписке: по умолчанию — 3 с; 0 — без окна;
 * больше 3 — ошибка настройки.
 */
export const DEFAULT_REACTION_HOLD_SECONDS = 3;
export const MAX_REACTION_HOLD_SECONDS = 3;

const reactionHoldSeconds = z
  .number({ error: 'окно отмены реакции — число секунд' })
  .min(0, { message: 'окно отмены реакции — не меньше 0 (0 — без окна)' })
  .max(MAX_REACTION_HOLD_SECONDS, {
    message: `окно отмены реакции — не больше ${MAX_REACTION_HOLD_SECONDS} с; 0 — без окна`,
  })
  .default(DEFAULT_REACTION_HOLD_SECONDS);

/**
 * Окно для материала без слов владельца (0.3.6; GitHub issue #51): пересылка, файл, фото без подписи ждут его слов в том
 * же чате — материал и слова агент получает вместе. По умолчанию — 120 с; 0 — без окна (материал отдаётся сразу, как до
 * 0.3.6); больше 600 — ошибка настройки: дольше десяти минут материал не держится ⟨предл.⟩.
 */
export const DEFAULT_MATERIAL_HOLD_SECONDS = 120;
export const MAX_MATERIAL_HOLD_SECONDS = 600;

const materialHoldSeconds = z
  .number({ error: 'окно для материала без слов владельца — число секунд' })
  .min(0, { message: 'окно для материала без слов владельца — не меньше 0 (0 — без окна)' })
  .max(MAX_MATERIAL_HOLD_SECONDS, {
    message: `окно для материала без слов владельца — не больше ${MAX_MATERIAL_HOLD_SECONDS} с; 0 — без окна`,
  })
  .default(DEFAULT_MATERIAL_HOLD_SECONDS);

export type SttConfig = z.infer<typeof SttConfigSchema>;
export type TtsConfig = z.infer<typeof TtsConfigSchema>;

export const ConfigSchema = z.strictObject({
  bot: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,64}$/, { message: 'имя бота — латиница, цифры и «_»' }),
  // Пусто — режим первой настройки (5.3).
  owner_id: z.int().positive().nullable().default(null),
  timezone: z.string().refine(isValidTimeZone, { message: 'неизвестный часовой пояс' }),
  telegram: z
    .strictObject({ api_base: httpUrl.default('https://api.telegram.org') })
    .prefault({}),
  episode_idle_minutes: positiveMinutes.default(33),
  agent_offline_notice_minutes: positiveMinutes.default(10),
  redeliver_after_minutes: positiveMinutes.default(10),
  stt: SttConfigSchema.prefault({}),
  tts: TtsConfigSchema.prefault({}),
  closed_topics: z.array(z.int()).default([]),
  closed_marker: z.string().min(1).nullable().default(null),
  retention: z
    .strictObject({
      owner_voice_days: z.int().positive().default(30),
      untrusted_days: z.int().positive().default(90),
      logs_days: z.int().positive().default(90),
      closed_days: z.int().positive().default(30),
    })
    .prefault({}),
  // Интерфейс чата (5.6, 5.7; J-4, 0.2.0): сколько живёт ответ «где мы»; свои (короче) имена ролей для подсказки
  // поля ввода и закреплённой строки (роль → как показывать; без записи — полное имя роли с большой буквы: одно имя роли
  // везде). Роль по умолчанию не показывается вовсе — запись для неё ни на что не влияет. delete_confirmed_topic (0.3.5,
  // issue #48): строка темы `⚙ ↪ #N · тема` после [верно] удаляется из чата (тема и так видна в закреплённой строке);
  // false — как раньше: правится в одну строку «… — верно». material_hold_seconds (0.3.6, issue #51): материал без слов
  // владельца (пересылка, файл, фото без подписи) ждёт его слов в том же чате столько секунд от последнего материала;
  // слова пришли — материал уходит агенту вместе с ними, не пришли — с пометкой «слов владельца не было».
  ui: z
    .strictObject({
      where_ttl_minutes: positiveMinutes.default(5),
      role_short: z.record(z.string().min(1), z.string().min(1).max(32)).default({}),
      delete_confirmed_topic: z.boolean().default(true),
      material_hold_seconds: materialHoldSeconds,
    })
    .prefault({}),
  // Посылки (5.16; 0.3.3, P-23): dir — папка посылок, единственное место, откуда агент отдаёт файлы (send_file);
  // null — `<каталог сессии агента>/parcels` (session_hint.cwd канала — папка агента, как notes/ шаблона). Путь —
  // полный или с «~/». targets — куда можно доставлять: сейчас есть только telegram (sendDocument в чат); веб-публикация
  // — позже, новой целью (5.16, «Дальше») ⟨предл.⟩.
  // Реакции владельца на ответы агента (5.17; 0.3.4): hold_seconds — окно отмены (issue #46): реакция записана сразу,
  // а агенту уходит только через столько секунд после последнего изменения; поставил и снял (или вернул прежнюю) в окне
  // — агенту ничего. Сообщения, команды и расшифровки окно не задерживает.
  reactions: z
    .strictObject({
      hold_seconds: reactionHoldSeconds,
    })
    .prefault({}),
  parcels: z
    .strictObject({
      dir: z
        .string()
        .refine((d) => d.startsWith('/') || d.startsWith('~/'), { message: 'папка посылок — полный путь или с «~/»' })
        .nullable()
        .default(null),
      targets: z
        .array(z.string().regex(PARCEL_TARGET_RE, { message: 'имя цели — латиница, цифры, «_», «-»' }))
        .default([DEFAULT_PARCEL_TARGET]),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

const telegramAddress = z
  .union([z.string().regex(/^\d+$/, { message: 'номер Telegram — цифры' }), z.int().positive()])
  .transform((v) => String(v));

export const TransportSchema = z.strictObject({
  network: z.enum(NETWORKS),
  address: telegramAddress,
});

export const SubjectRuleSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, { message: 'id субъекта — латиница, цифры, «_», «.», «-»' }),
  who: z.string().min(1),
  transports: z.array(TransportSchema).default([]),
  // Ссылка на участника в модели мира агента — без её содержимого (AD-9) ⟨предл.⟩.
  world_ref: z.string().min(1).nullable().optional(),
});

export const ChatRuleSchema = z.strictObject({
  // private — личка с любым субъектом из subjects; число — номер чата (группы — позже).
  chat: z.union([z.literal('private'), z.int()]),
  space: z.string().min(1),
  role: z.string().min(1),
  // Посылки (5.16; 0.3.3) ⟨предл.⟩: агент может отдавать файлы (send_file) в этот чат. Личка владельца — всегда, без
  // поля; другие чаты — только с parcels: true. Поле правит владелец в rules.yaml (читается при перезапуске); инструмент
  // rule агента его не меняет.
  parcels: z.boolean().optional(),
});

export const RulesSchema = z
  .strictObject({
    subjects: z.array(SubjectRuleSchema).default([]),
    chats: z.array(ChatRuleSchema).default([]),
  })
  .superRefine((rules, ctx) => {
    const ids = new Set<string>();
    const addresses = new Map<string, string>();
    rules.subjects.forEach((s, i) => {
      if (ids.has(s.id)) ctx.addIssue({ code: 'custom', path: ['subjects', i, 'id'], message: `субъект «${s.id}» уже есть` });
      ids.add(s.id);
      s.transports.forEach((t, j) => {
        const key = `${t.network}:${t.address}`;
        const other = addresses.get(key);
        if (other !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['subjects', i, 'transports', j],
            message: `запись ${key} уже принадлежит субъекту «${other}»`,
          });
        }
        addresses.set(key, s.id);
      });
    });
    const chats = new Set<string>();
    rules.chats.forEach((c, i) => {
      const key = String(c.chat);
      if (chats.has(key)) ctx.addIssue({ code: 'custom', path: ['chats', i, 'chat'], message: `чат «${key}» уже есть` });
      chats.add(key);
    });
  });

export type Rules = z.infer<typeof RulesSchema>;
export type SubjectRule = Rules['subjects'][number];
export type ChatRule = Rules['chats'][number];

/** Внешняя роль по умолчанию (на старте одна — «личный ассистент»). */
export const DEFAULT_ROLE = 'личный ассистент';
/**
 * Имя роли в закреплённой строке и подсказке поля ввода (5.7): полное имя с большой буквы, как в объявлениях темы
 * (прежнее короткое «ассистент» по умолчанию убрано). Кто хочет короче — своё имя в config.yaml
 * (ui.role_short), оно берётся как есть. Роль по умолчанию владельцу не показывается вовсе — ownerRoleName.
 */
export function roleDisplayName(config: Pick<Config, 'ui'>, role: string): string {
  const r = role.replace(/\s+/g, ' ').trim();
  return config.ui.role_short[r] ?? roleLabel(r);
}

/**
 * Роль для строк владельцу (пока роль одна, её не выводят — «личный ассистент» не пишется): роль по умолчанию (DEFAULT_ROLE, без учёта регистра и лишних пробелов) — пустая строка, её не показывают
 * нигде — ни в закреплённой строке, ни в объявлениях темы, ни в «где мы», ни в подсказке поля ввода; другая роль (правила
 * лички сменили роль) — как есть ⟨предл.⟩.
 */
export function shownRole(role: string): string {
  const r = role.replace(/\s+/g, ' ').trim();
  return r.toLocaleLowerCase('ru') === DEFAULT_ROLE ? '' : r;
}

/**
 * Имя роли для закреплённой строки и подсказки поля ввода: роль по умолчанию — пустая строка (shownRole; своё имя в
 * ui.role_short её не возвращает); другая — roleDisplayName.
 */
export function ownerRoleName(config: Pick<Config, 'ui'>, role: string): string {
  const r = shownRole(role);
  return r ? roleDisplayName(config, r) : '';
}
export const DEFAULT_SPACE = 'личное';
export const OWNER_SUBJECT_ID = 'owner';

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Ошибка настроек: список строк «файл: поле — что не так», по-русски. */
export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[],
  ) {
    super(`${file}: ${problems.join('; ')}`);
  }
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((iss) => {
    const where = iss.path.length ? iss.path.map(String).join('.') : '(корень)';
    return `${where} — ${iss.message}`;
  });
}

function parseYamlFile(file: string, label: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ConfigError(label, [code === 'ENOENT' ? `нет файла ${file}` : `не читается: ${code ?? String(err)}`]);
  }
  return parseYamlText(text, label);
}

function parseYamlText(text: string, label: string): unknown {
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: true });
  if (doc.errors.length) {
    throw new ConfigError(
      label,
      doc.errors.map((e) => `разбор YAML: ${e.message.split('\n')[0] ?? e.message}`),
    );
  }
  const value: unknown = doc.toJS();
  return value ?? {};
}

export interface LoadOptions {
  /** Под тестом (STG_TEST=1) разрешён http:// к 127.0.0.1 — для подделок. */
  test: boolean;
}

/**
 * Адрес вне теста — только https; под тестом — ещё http к 127.0.0.1/localhost. Токен и ключи не уходят в открытую сеть.
 * Логина и пароля в адресе нет: адрес пишется в журнал при старте и печатается в stg doctor без маски, а секрет — в
 * связке ключей (secret — где именно). В текст ошибки адрес не попадает.
 */
function checkUrl(field: string, value: string, opts: LoadOptions, problems: string[], secret: string): void {
  const u = new URL(value);
  if (u.username || u.password) problems.push(`${field} — без логина и ключа в адресе: ${secret}`);
  if (u.protocol === 'https:') return;
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (opts.test && local) return;
  problems.push(`${field} — нужен https:// (http:// — только к 127.0.0.1 под тестом)`);
}

export function parseConfig(value: unknown, opts: LoadOptions, label = 'config.yaml'): Config {
  const r = ConfigSchema.safeParse(value, { error: ru });
  if (!r.success) throw new ConfigError(label, formatIssues(r.error.issues));
  const problems: string[] = [];
  checkUrl('telegram.api_base', r.data.telegram.api_base, opts, problems, 'токен бота — в связке ключей');
  checkUrl('stt.base_url', r.data.stt.base_url, opts, problems, 'ключ — в связке ключей (stt.key)');
  checkUrl('tts.base_url', r.data.tts.base_url, opts, problems, 'ключ — в связке ключей (tts.key)');
  if (problems.length) throw new ConfigError(label, problems);
  return r.data;
}

export function loadConfig(file: string, opts: LoadOptions): Config {
  return parseConfig(parseYamlFile(file, 'config.yaml'), opts);
}

export function parseRules(value: unknown, label = 'rules.yaml'): Rules {
  const r = RulesSchema.safeParse(value, { error: ru });
  if (!r.success) throw new ConfigError(label, formatIssues(r.error.issues));
  return r.data;
}

/** Правила по умолчанию: владелец и личка с ролью «личный ассистент». */
export function defaultRules(ownerId: number | null): Rules {
  return {
    subjects: [
      {
        id: OWNER_SUBJECT_ID,
        who: 'owner',
        transports: ownerId !== null ? [{ network: 'telegram', address: String(ownerId) }] : [],
      },
    ],
    chats: [{ chat: 'private', space: DEFAULT_SPACE, role: DEFAULT_ROLE }],
  };
}

export interface RulesLoad {
  rules: Rules;
  /** Файла не было — правила по умолчанию. */
  missing: boolean;
}

export function loadRules(file: string): RulesLoad {
  if (!fs.existsSync(file)) return { rules: { subjects: [], chats: [] }, missing: true };
  return { rules: parseRules(parseYamlFile(file, 'rules.yaml')), missing: false };
}

/** Правила из текста rules.yaml (M5: сверка файла с рабочей копией шлюза). Ошибка — ConfigError. */
export function parseRulesText(text: string, label = 'rules.yaml'): Rules {
  return parseRules(parseYamlText(text, label), label);
}

/** Правила для файла: без пустых полей (world_ref: null не пишется). */
export function rulesForFile(rules: Rules): Rules {
  return {
    subjects: rules.subjects.map((s) => ({
      id: s.id,
      who: s.who,
      transports: s.transports.map((t) => ({ network: t.network, address: t.address })),
      ...(s.world_ref ? { world_ref: s.world_ref } : {}),
    })),
    chats: rules.chats.map((c) => ({ chat: c.chat, space: c.space, role: c.role, ...(c.parcels === true ? { parcels: true } : {}) })),
  };
}

/** Записать rules.yaml целиком: временный файл → fsync → переименование (пишет только шлюз, 5.9). */
export function writeRules(file: string, rules: Rules): void {
  const header =
    '# Правила доступа шлюза. Пишет только шлюз; ручная правка читается при перезапуске.\n' +
    '# Владелец задан в config.yaml (owner_id): правилом его не убрать.\n';
  writeFileAtomicSync(file, header + stringify(rulesForFile(rules)));
}

export interface EffectiveRules {
  rules: Rules;
  /** Что пришлось поправить, чтобы владелец из config.yaml был в правилах. */
  notes: string[];
}

/**
 * Правила, которые исполняет шлюз: владелец из config.yaml есть всегда, с его номером Telegram (Ш-21).
 * Пустой owner_id — первая настройка: у владельца нет записи о транспорте.
 */
export function effectiveRules(config: Config, rules: Rules): EffectiveRules {
  const notes: string[] = [];
  const subjects = rules.subjects.map((s) => ({ ...s, transports: [...s.transports] }));
  let owner = subjects.find((s) => s.who === 'owner');
  if (!owner) {
    owner = { id: OWNER_SUBJECT_ID, who: 'owner', transports: [] };
    if (subjects.some((s) => s.id === OWNER_SUBJECT_ID)) owner.id = `${OWNER_SUBJECT_ID}_config`;
    subjects.unshift(owner);
    notes.push('владельца не было в правилах — добавлен из config.yaml');
  }
  for (const extra of subjects.filter((s) => s.who === 'owner' && s !== owner)) {
    notes.push(`субъект «${extra.id}» помечен owner, но владелец один — считаю его обычным`);
    extra.who = 'subject';
  }
  const ownerAddr = config.owner_id !== null ? String(config.owner_id) : null;
  const tg = owner.transports.filter((t) => t.network === 'telegram');
  if (ownerAddr === null) {
    if (tg.length) notes.push('owner_id в config.yaml пуст — номер владельца из правил не действует');
    owner.transports = owner.transports.filter((t) => t.network !== 'telegram');
  } else if (tg.length !== 1 || tg[0]?.address !== ownerAddr) {
    if (tg.length) notes.push('номер владельца в правилах расходится с config.yaml — действует config.yaml');
    owner.transports = [...owner.transports.filter((t) => t.network !== 'telegram'), { network: 'telegram', address: ownerAddr }];
    // Номер владельца не может принадлежать другому субъекту.
    for (const s of subjects) {
      if (s === owner) continue;
      const before = s.transports.length;
      s.transports = s.transports.filter((t) => !(t.network === 'telegram' && t.address === ownerAddr));
      if (s.transports.length !== before) notes.push(`номер владельца снят с субъекта «${s.id}»`);
    }
  }
  let chats = rules.chats.map((c) => ({ ...c }));
  const privateDefault = defaultRules(config.owner_id).chats;
  if (!chats.length) {
    chats = privateDefault;
    notes.push('в правилах нет чатов — личка с ролью «личный ассистент»');
  } else if (!chats.some((c) => c.chat === 'private')) {
    // Команды владельца («стоп», «где мы») — только в личке: без неё владельца не слышно (Ш-21).
    chats.unshift(...privateDefault);
    notes.push('в правилах нет лички — добавлена с ролью «личный ассистент»: в ней команды владельца');
  }
  return { rules: { subjects, chats }, notes };
}
