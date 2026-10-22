// Общее для интеграционных тестов M4 (голос): подделки Telegram и провайдера голоса — диалект OpenAI или ElevenLabs
// (одни и те же сценарии идут на обоих), ключ голоса из STG_TEST_VOICE_KEY_<ИМЯ>, голосовые владельца и чужие,
// ответ на голосовое (расшифровка или причина — реплаем на него, 0.3.1), нажатие кнопки под правленым сообщением.

import {
  FakeElevenLabs,
  FakeOpenAiAudio,
  makeOggOpus,
  type FakeVoiceOptions,
  type FakeVoiceServer,
  type SttRecord,
  type VoiceDialect,
} from 'stg-fake-elevenlabs';
import type { OriginSpec, SentMessage } from 'stg-fake-telegram';
import type { Update, User } from 'stg-core';
import { filesContaining, outputsContaining, pump, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, setup, type Setup } from './m1-common.js';

export type { VoiceDialect } from 'stg-fake-elevenlabs';

/** Ключи голоса под тестом — ни в один файл и вывод не попадают (П-2). */
export const VOICE_KEYS: Record<VoiceDialect, string> = {
  openai: 'sk-test-OPENAI_key-never-written',
  elevenlabs: 'xi-test-ELEVEN_key-never-written',
};
/** Прежнее имя. */
export const ELEVEN_KEY = VOICE_KEYS.elevenlabs;

/** Переменная ключа голоса под тестом (как testSecretEnv в stg-core). */
export function voiceKeyEnv(name: string): string {
  return `STG_TEST_VOICE_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Чем диалекты отличаются в ожиданиях тестов: модели и формат по умолчанию, как провайдер назван в «статус». */
export const DIALECT: Record<
  VoiceDialect,
  { sttModel: string; ttsModel: string; ttsFormat: string; label(baseUrl: string): string; sttExtra(rec: SttRecord): Record<string, unknown>; sttExtraExpected: Record<string, unknown> }
> = {
  openai: {
    // По умолчанию (P-20): подделка модели в config.yaml не задаёт.
    sttModel: 'gpt-4o-mini-transcribe',
    ttsModel: 'gpt-4o-mini-tts',
    ttsFormat: 'opus',
    label: (base) => `OpenAI-совместимый (${new URL(base).host})`,
    sttExtra: (rec) => ({ response_format: rec.fields.response_format, type: rec.file?.type }),
    sttExtraExpected: { response_format: ['json'], type: 'audio/ogg' },
  },
  elevenlabs: {
    sttModel: 'scribe_v2',
    ttsModel: 'eleven_multilingual_v2',
    ttsFormat: 'opus_48000_64',
    label: () => 'ElevenLabs',
    sttExtra: (rec) => ({ tag_audio_events: rec.fields.tag_audio_events, type: rec.file?.type }),
    sttExtraExpected: { tag_audio_events: ['false'], type: 'audio/ogg' },
  },
};

export function startFakeVoice(dialect: VoiceDialect, opts: Partial<FakeVoiceOptions> = {}): Promise<FakeVoiceServer> {
  const o = { apiKey: VOICE_KEYS[dialect], ...opts };
  return dialect === 'openai' ? FakeOpenAiAudio.start(o) : FakeElevenLabs.start(o);
}

export interface VoiceSetup extends Setup {
  /** Диалект распознавания (и синтеза, если не смешанный случай). */
  dialect: VoiceDialect;
  /** Подделка распознавания (и синтеза, если не смешанный случай). */
  voice: FakeVoiceServer;
  /** Подделка синтеза: та же, кроме смешанного случая (ttsDialect). */
  synth: FakeVoiceServer;
}

/**
 * Каталог бота с распознаванием и синтезом в подделку провайдера голоса. По умолчанию — openai (как в config.yaml по
 * умолчанию). ttsDialect — синтез другой подделкой (смешанный случай). Ключи — по именам из config.yaml (по умолчанию —
 * имя провайдера). П-2 и для ключей голоса — при закрытии.
 */
export async function voiceSetup(
  opts: {
    dialect?: VoiceDialect;
    ttsDialect?: VoiceDialect;
    fake?: Partial<FakeVoiceOptions>;
    extraConfig?: string;
    rules?: string;
    voiceId?: string | null;
    /** Имена ключей в config.yaml (stt.key, tts.key). */
    sttKey?: string;
    ttsKey?: string;
    withKey?: boolean;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<VoiceSetup> {
  const dialect = opts.dialect ?? 'openai';
  const ttsDialect = opts.ttsDialect ?? dialect;
  const voice = await startFakeVoice(dialect, opts.fake);
  const synth = ttsDialect === dialect ? voice : await startFakeVoice(ttsDialect, opts.fake);
  const sttKey = opts.sttKey ?? dialect;
  const ttsKey = opts.ttsKey ?? ttsDialect;
  const keyEnv: Record<string, string> = {};
  if (opts.withKey !== false) {
    keyEnv[voiceKeyEnv(sttKey)] = VOICE_KEYS[dialect];
    keyEnv[voiceKeyEnv(ttsKey)] = VOICE_KEYS[ttsDialect];
  }
  const yaml =
    voice.sttYaml(opts.sttKey ? { key: opts.sttKey } : {}) +
    synth.ttsYaml({ voiceId: opts.voiceId, ...(opts.ttsKey ? { key: opts.ttsKey } : {}) });
  const s = await setup({
    home: { extraConfig: yaml + (opts.extraConfig ?? ''), ...(opts.rules ? { rules: opts.rules } : {}) },
    env: { ...keyEnv, ...opts.env },
  });
  const close = s.close.bind(s);
  return Object.assign(s, {
    dialect,
    voice,
    synth,
    async close() {
      await close();
      await voice.stop();
      if (synth !== voice) await synth.stop();
      for (const key of new Set([VOICE_KEYS[dialect], VOICE_KEYS[ttsDialect]])) {
        const hits = [...filesContaining(s.home.dir, key), ...outputsContaining(s.home, key)];
        if (hits.length) throw new Error(`П-2: ключ голоса найден в ${hits.join(', ')}`);
      }
    },
  });
}

/** Строка «Распознавание: …» начинается так: провайдер и модель (по подделке и диалекту). */
export function sttHead(s: VoiceSetup): string {
  return `${DIALECT[s.dialect].label(s.voice.baseUrl)} ${DIALECT[s.dialect].sttModel}`;
}

let fileSeq = 0;

/** Голосовое владельца (или пересланное чужое): файл звука — в подделке Telegram. */
export function pushVoice(
  s: Setup,
  seconds: number,
  opts: { from?: User; caption?: string; thread?: { id: number; isTopic: boolean }; forwardFrom?: OriginSpec; noFile?: boolean } = {},
): Update {
  const fileId = `m4v${++fileSeq}`;
  if (!opts.noFile) s.fake.addFile(makeOggOpus(seconds), { fileId, path: `voice/${fileId}.oga` });
  const from = opts.from ?? OWNER;
  const msgOpts = opts.thread ? { thread: opts.thread } : {};
  const u = opts.forwardFrom
    ? s.fake.builder.forwardVoice(from, opts.forwardFrom, { duration: seconds, fileId }, msgOpts)
    : s.fake.builder.voice(from, { duration: seconds, fileId, ...(opts.caption ? { caption: opts.caption } : {}) }, msgOpts);
  return s.fake.push(u)[0]!;
}

/**
 * Расшифровка — цитатой (0.3.4; R-23 а, #44): HTML, всё сообщение — `<blockquote>` (длинная часть —
 * `<blockquote expandable>`).
 */
export function isQuote(m: SentMessage): boolean {
  return m.parse_mode === 'HTML' && /^<blockquote( expandable)?>[\s\S]*<\/blockquote>$/.test(m.text ?? '');
}

/** Видимый текст сообщения бота — как его видит владелец: у цитаты — без тегов, сущности раскрыты. */
export function sttText(m: SentMessage): string {
  return (m.message as { text?: string }).text ?? '';
}

/**
 * Ответы шлюза на голосовое или аудиофайл (0.3.1; P-19): сообщения бота реплаем на само
 * сообщение владельца — расшифровка (длинная — несколькими сообщениями подряд) или короткая причина. Ответы агента — не
 * сюда: с 0.3.2 (P-26) они без 💬; отказ шлюза — простым текстом, расшифровка с 0.3.4 — цитатой (isQuote), а ответ агента
 * — HTML не цитатой целиком.
 */
export function sttRepliesOf(s: Setup, u: Update): SentMessage[] {
  const msg = u.message!;
  return s.fake
    .sentTo(msg.chat.id)
    .filter((m) => m.method === 'sendMessage' && (m.reply_parameters as { message_id?: number } | null)?.message_id === msg.message_id && (m.parse_mode !== 'HTML' || isQuote(m)));
}

/** Дождаться ответа шлюза на голосовое (аудиофайл): n сообщений (частей) — двигая поддельные часы. */
export function waitSttReply(s: Setup, gw: GatewayProcess, u: Update, n = 1, what = 'ответа на голосовое'): Promise<SentMessage[]> {
  return pump(gw, () => {
    const list = sttRepliesOf(s, u);
    return list.length >= n ? list : null;
  }, { what });
}

/** Ответ на сообщение владельца: так выглядит reply_parameters у бота (5.5а). */
export function replyTo(u: Update): { message_id: number; allow_sending_without_reply: true } {
  return { message_id: u.message!.message_id, allow_sending_without_reply: true };
}

/** Текст сообщения бота сейчас — с последней правкой. */
export function currentText(m: SentMessage): string {
  return m.edits.at(-1)?.text ?? m.text ?? '';
}

/** Разметка сообщения бота сейчас. */
export function currentMarkup(m: SentMessage): unknown {
  return m.edits.length ? (m.edits.at(-1)?.reply_markup ?? null) : m.reply_markup;
}

/** Встроенные кнопки сообщения сейчас (после правок). */
export function currentButtons(m: SentMessage): Array<{ text: string; data: string }> {
  const rm = currentMarkup(m) as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | null;
  return (rm?.inline_keyboard ?? []).flat().map((b) => ({ text: b.text, data: b.callback_data }));
}

/** Нажать кнопку под сообщением (с учётом правок) и дождаться ответа на нажатие; вернуть его текст. */
export async function pressCurrent(s: Setup, m: SentMessage, label: string, from = OWNER): Promise<string | null> {
  const b = currentButtons(m).find((x) => x.text === label);
  if (!b) throw new Error(`нет кнопки «${label}» под «${currentText(m)}»`);
  const [u] = s.fake.push(s.fake.builder.callback(from, b.data, m.message));
  const id = u!.callback_query!.id;
  const a = await waitUntil(() => s.fake.callbackAnswers.find((x) => x.callback_query_id === id), 10_000, `ответа на нажатие «${label}»`);
  return a.text;
}
