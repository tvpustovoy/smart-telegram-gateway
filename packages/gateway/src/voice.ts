// Голос (TECH-SPEC 5.5, 5.8; Ш-7, Ш-8, Ш-26; J-2).
//
// Внутрь — распознавание после записи (⟨предл.⟩ «расшифровка после записи»: зависший провайдер не держит приём).
// Голосовое записывается событием со статусом transcribing (на сообщении с 0.3.2 ничего, до 👀; строки, пока
// распознаётся, нет ⟨предл.⟩); распознаватель берёт такие события по одному, по порядку №: провайдер из config.yaml
// (stt.provider — OpenAI-совместимый или ElevenLabs, за общим интерфейсом SpeechToText из stg-core), язык явно,
// словарь; срок попытки 60 с, два повтора, всё вместе — не дольше 3 минут (A4.6). Провайдер не отвечает —
// предохранитель: следующие голосовые 5 минут получают одну попытку 20 с. Результат одной транзакцией: transcript (или
// отказ) → статус new → ответ владельцу на само голосовое (reply): расшифровка целиком, без номера и вводных, или
// короткая причина «Не смог распознать — звук сохранён…» (P-19; образец — бот Voice Messages; кнопки под ним — позже,
// место оставлено). С 0.3.4 расшифровка — цитатой (развилка R-23 а, issue #44; outbox.quote, sender.ts). Агенту события
// отдаются по №: следующие ждут распознанного или отказа, но не дольше 90 с (5.8 ⟨предл.⟩; барьер — в adapter.ts).
// После перезапуска transcribing распознаётся заново: точка сбоя in_stt — ответ провайдера получен, а не записан (A4.7:
// расшифровка ровно одна). Закрытая тема сюда не попадает: её звук идёт в raw/closed/ событием closed_topic, провайдеру
// не уходит (Ш-11).
//
// Аудиофайлы (J-2; файлы до 15 минут распознаются сразу, без нарезки) — тем же путём: событие вида document со статусом
// transcribing; файл скачивается здесь, после записи (getFile; больше 20 МБ бот не скачает — «слишком большой для
// бота»), в raw/<дата>/<update_id>.<расширение из имени файла>; провайдеру — с верным именем и mime по расширению
// (audio.ts). Длительность — из метаданных Telegram, а у document её нет: тогда — по самому файлу после скачивания
// (audio-duration.ts; events.audio_seconds). Длиннее stt.audio_max_minutes — только скачивается, не распознаётся
// (events.stt_note = too_long). По файлу не вышло — распознаётся, срок попытки — по оценке из размера. Срок попытки
// растёт с длительностью ⟨предл.: ¼ длительности, не меньше 60 с и не больше 4 минут — сверить на реальном провайдере⟩.
// Расшифровка файла — «чужое» (Ш-20; свой аудиофайл и кружок — слово владельца, 0.3, ниже): в журнал — с меткой
// вложения, хранение — как у файлов (retention.ts).
// Владельцу — так же, как у голосового: расшифровка ответом на файл или короткая причина (длиннее предела, больше
// 20 МБ, не распознан) без номера.
//
// Две очереди (находка проверки): голосовые и аудиофайлы распознаются раздельно, каждая — по порядку №. Длинный
// файл (скачивание до 3 минут и попытки до 4 минут) не держит голосовые, присланные после него. Предохранитель — только
// у голосовых: исчерпанный срок на длинном файле — не «провайдер не отвечает»; отказ по аудиофайлу виден в ответе на
// него, а «статус» (последний отказ, счётчики) — о голосовых.
//
// Видео-кружок и видео (0.3): распознаётся звуковая дорожка, тем же провайдером — файл уходит как `<имя>.mp4`,
// `video/mp4` (mp4 — в списке форматов OpenAI; у ElevenLabs — не проверено). Кружок — событие document, но очередь
// голосовая ⟨предл.: кружки короткие, до минуты⟩; видео — очередь аудиофайлов ⟨предл.⟩. Владельцу —
// как у голосового и аудиофайла в 0.3.1 (сведение 0.3 и 0.3.1): пока распознаётся — ничего, потом расшифровка ответом
// на кружок (видео) или короткая причина («Не смог распознать — кружок сохранён. Срочное — текстом», «… — видео
// сохранено»); видео не в mp4 — сразу «Видео не в mp4 — звук не распознаю» ⟨предл.⟩. Метка расшифровки — метка
// вложения: свой аудиофайл (развилка R-2 а) и свой кружок (развилка R-20 а) без пересылки — слово владельца (журнал —
// с меткой owner), пересланное, от другого участника и видео — «чужое».
//
// Наружу — синтез (5.5): ответ агента с voice: true → провайдер из config.yaml (tts.provider, интерфейс TextToSpeech) →
// Ogg/Opus, проверенный своим кодом, длительность по Ogg → sendVoice (sender.ts). Синтез идёт рядом с отправителем, а
// не в нём: квитанции и строки шлюза не ждут его; ждут только следующие ответы агента в тот же чат — порядок ответов
// сохраняется. Не вышло — ответ текстом с пометкой «⚙ голос не получился»; отметка voice_failed в базе держит порядок
// частей после перезапуска.
//
// Окно для материала без слов владельца (0.3.6, issue #51; material.ts): распознавание кончилось — в той же транзакции
// пересланное голосовое (материал) снова удерживается, если окно ещё идёт, а материал, ждавший этого голосового (кружка)
// владельца — его слов, — отдаётся вместе с ним.
//
// Здесь нет ничего от конкретного провайдера: отказ любого — VoiceProviderError (вид, код, повторять ли). Ключи голоса —
// по имени из config.yaml (stt.key, tts.key); одно имя — один ключ на оба.

import fs from 'node:fs';
import path from 'node:path';
import {
  SecretError,
  TelegramApiError,
  audioDurationEstimate,
  audioDurationOf,
  audioFileOf,
  isNotMp4Video,
  providerAudioFile,
  VoiceProviderError,
  clockDeadline,
  createSpeechToText,
  createTextToSpeech,
  ensureDir,
  faultPoint,
  isLocalUrl,
  localDate,
  secretStoreFromEnv,
  sql,
  sttReplyText,
  transaction,
  ttsVoice,
  voiceKeyName,
  writeFileAtomicSync,
  type Attachment,
  type SpeechToText,
  type SttReplyState,
  type TextToSpeech,
  type Timer,
  type VoiceProviderName,
  type VoiceWhat,
} from 'stg-core';
import { insertOutbox, type Ctx } from './context.js';
import { settleTranscribed, type SettleResult } from './material.js';

/** Срок одной попытки распознавания (5.8). */
export const STT_ATTEMPT_MS = 60_000;
/** Попыток: первая и два повтора (5.8). */
export const STT_ATTEMPTS = 3;
/** Всё распознавание одного голосового — не дольше 3 минут (A4.6). */
export const STT_BUDGET_MS = 3 * 60_000;
/** Пауза перед повтором после 429 и 5xx (без Retry-After); после срока — сразу. */
export const STT_PAUSE_MS = 2_000;
/**
 * Предохранитель: провайдер не отвечает (срок, сеть, 5xx — все попытки голосового) — следующие голосовые 5 минут
 * получают одну короткую попытку (20 с), а не три по 60 с: пять голосовых во время сбоя — не 15 минут ожидания.
 * Удачное распознавание снимает предохранитель; ещё один такой отказ — продлевает.
 */
export const STT_DEGRADED_MS = 5 * 60_000;
export const STT_DEGRADED_ATTEMPT_MS = 20_000;
/** Синтез: срок попытки и попыток. */
export const TTS_ATTEMPT_MS = 60_000;
export const TTS_ATTEMPTS = 2;
/** Диск полон — распознанное ждёт записи и пробует снова через минуту. */
const DISK_RETRY_MS = 60_000;
const FILE_TIMEOUT_MS = 60_000;
/** Аудиофайл — до 20 МБ: скачивание дольше ⟨предл.⟩. */
const AUDIO_FILE_TIMEOUT_MS = 180_000;
/** Пауза между повторами — не больше. */
const MAX_PAUSE_MS = 30_000;
/** Срок попытки для длинного звука ⟨предл.⟩: ¼ длительности, не больше 4 минут (не меньше STT_ATTEMPT_MS). */
export const STT_LONG_ATTEMPT_MAX_MS = 4 * 60_000;
const STT_MS_PER_AUDIO_SECOND = 250;

class Stopped extends Error {}

/** Диск полон: распознавание этого голосового — позже (не «звук не скачался»). */
class DiskFullLater extends Error {}

/**
 * Ключ голоса — из связки ключей по имени из config.yaml (stt.key, tts.key; под тестом — STG_TEST_VOICE_KEY_<ИМЯ>);
 * нашёлся — помним и маскируем в журнале; провайдер не принял (401, 403) — перечитать при следующем запросе.
 */
export class VoiceKey {
  private cached: string | null = null;
  /** Был ли ключ при последней проверке (null — ещё не смотрели). */
  known: boolean | null = null;

  constructor(
    private readonly ctx: Ctx,
    /** Учётная запись в связке ключей — как в config.yaml. */
    readonly name: string,
  ) {}

  async get(): Promise<string | null> {
    if (this.cached) return this.cached;
    let v: string | null = null;
    try {
      v = await secretStoreFromEnv(this.ctx.env, this.ctx.config.bot).get(voiceKeyName(this.name));
    } catch (err) {
      this.ctx.journal.write('secret_error', { what: `voice:${this.name}`, error: err instanceof SecretError ? err.message : String(err) });
    }
    this.known = !!v;
    if (v) {
      this.ctx.journal.addSecret(v);
      this.cached = v;
    }
    return v;
  }

  /** Провайдер не принял ключ: перечитать при следующем запросе. */
  invalidate(): void {
    this.cached = null;
  }
}

/** Голос по config.yaml: распознавание и синтез — каждый своим провайдером и ключом; одно имя ключа — один ключ. */
export interface VoiceSetup {
  stt: SpeechToText;
  sttKey: VoiceKey;
  tts: TextToSpeech;
  ttsKey: VoiceKey;
}

export function voiceFromConfig(ctx: Ctx): VoiceSetup {
  const sttKey = new VoiceKey(ctx, ctx.config.stt.key);
  const ttsKey = ctx.config.tts.key === ctx.config.stt.key ? sttKey : new VoiceKey(ctx, ctx.config.tts.key);
  return { stt: createSpeechToText(ctx.config.stt), sttKey, tts: createTextToSpeech(ctx.config.tts), ttsKey };
}

/** Любой отказ — общим видом: не VoiceProviderError (ошибка кода, а не провайдера) — как сеть, повторяемый. */
function providerError(what: VoiceWhat, provider: VoiceProviderName, err: unknown): VoiceProviderError {
  return err instanceof VoiceProviderError ? err : new VoiceProviderError(what, provider, null, 'network', 'network', (err as Error).message, true);
}

interface VoiceEventRow {
  seq: number;
  kind: string;
  stt_note: string | null;
  update_id: number | null;
  chat_id: number | null;
  thread_id: number | null;
  message_id: number | null;
  trust: string | null;
  attachments_json: string | null;
  raw_ref: string | null;
  transcript: string | null;
  episode_id: number | null;
  status: string;
  created_at: number;
  /** Длительность аудиофайла по самому файлу (v7); NULL — из метаданных или не определена. */
  audio_seconds: number | null;
}

function attachmentsOf(row: { attachments_json: string | null }): Attachment[] {
  try {
    const list: unknown = JSON.parse(row.attachments_json ?? '[]');
    return Array.isArray(list) ? (list as Attachment[]) : [];
  } catch {
    return [];
  }
}

function voiceAttachment(row: { attachments_json: string | null }): { fileId: string | null; duration: number } {
  const v = attachmentsOf(row).find((a) => a.kind === 'voice');
  return {
    fileId: typeof v?.ref.file_id === 'string' ? v.ref.file_id : null,
    duration: typeof v?.ref.duration === 'number' ? v.ref.duration : 0,
  };
}

/**
 * Что распознавать: голосовое (Ogg/Opus, .oga) или звук файлом — аудиофайл, кружок, видео (audio.ts). file — звук
 * файлом (событие document: скачивается после записи, длительность может быть по самому файлу, предел
 * stt.audio_max_minutes); lane — очередь (кружок — голосовая, 0.3); source — откуда звук; trust — метка расшифровки
 * (метка вложения). Имя и mime — для провайдера, ext — для файла в raw/, seconds — длительность из метаданных Telegram,
 * а у файла без них — определённая по файлу (null — нет).
 */
interface SttSource {
  file: boolean;
  lane: SttLaneName;
  source: 'voice' | 'audio' | 'video_note' | 'video';
  trust: string | null;
  fileId: string | null;
  ext: string;
  seconds: number | null;
  filename: string;
  mime: string;
}

function sttSourceOf(row: VoiceEventRow): SttSource | null {
  const base = String(row.update_id ?? row.seq);
  if (row.kind === 'voice') {
    const v = voiceAttachment(row);
    // Голосовое Telegram — Ogg/Opus (.oga); провайдеру — как audio/ogg с именем *.ogg.
    return { file: false, lane: 'voice', source: 'voice', trust: row.trust, fileId: v.fileId, ext: 'oga', seconds: v.duration, filename: `${base}.ogg`, mime: 'audio/ogg' };
  }
  const a = audioFileOf(attachmentsOf(row));
  if (!a) return null;
  const p = providerAudioFile(a, base);
  return {
    file: true,
    lane: a.source === 'video_note' ? 'voice' : 'audio',
    source: a.source,
    trust: a.trust,
    fileId: a.fileId,
    ext: a.ext,
    seconds: a.duration ?? row.audio_seconds,
    filename: p.filename,
    mime: p.mime,
  };
}

/**
 * Событие — видео-кружок (0.3): по вложению (тип video_note). SQL — для очередей и «статус»: кружок — в голосовой
 * очереди и в счётчиках голосовых.
 */
export const VIDEO_NOTE_SQL = "EXISTS (SELECT 1 FROM json_each(events.attachments_json) AS a WHERE json_extract(a.value, '$.ref.type') = 'video_note')";
/** Голосовая очередь и голосовые в «статус»: голосовое или кружок. */
export const VOICE_LANE_SQL = `(events.kind = 'voice' OR (events.kind = 'document' AND ${VIDEO_NOTE_SQL}))`;

/**
 * Ответ на голосовое, кружок, аудиофайл или видео по состоянию в базе (5.5; P-19): расшифровка
 * целиком или короткая причина — без номера и вводных, реплаем на само сообщение. Кружок и видео (0.3) — так же, как
 * голосовое и аудиофайл (сведение 0.3 и 0.3.1): слово в отказе — «кружок», «видео»; видео не в mp4 — «звук не
 * распознаю» ⟨предл.⟩. null — ответа нет: событие не звук (фото, изображение файлом, прочий файл — у них только
 * реакции), ещё распознаётся (пока распознаётся — ничего) или чата нет.
 */
export function sttReplyOf(
  ctx: Ctx,
  seq: number,
): { text: string; quote: boolean; chatId: number; threadId: number | null; messageId: number | null } | null {
  const ev = sql(ctx.db, "SELECT * FROM events WHERE seq = ? AND kind IN ('voice', 'document')").get(seq) as VoiceEventRow | undefined;
  if (!ev || ev.chat_id === null || ev.status === 'transcribing') return null;
  const audio = ev.kind === 'document';
  const attachments = audio ? attachmentsOf(ev) : [];
  const sound = audio ? audioFileOf(attachments) : null;
  const notMp4 = audio && !sound && isNotMp4Video(attachments);
  if (audio && !sound && !notMp4) return null;
  const state: SttReplyState = notMp4
    ? 'not_mp4'
    : audio && ev.stt_note === 'too_big'
      ? 'too_big'
      : audio && ev.stt_note === 'too_long'
        ? ev.raw_ref
          ? 'too_long'
          : 'too_long_no_file'
        : ev.transcript
          ? 'transcribed'
          : ev.raw_ref
            ? 'failed'
            : 'no_audio';
  const text = sttReplyText({
    audio,
    source: sound?.source ?? (notMp4 ? 'video' : undefined),
    state,
    transcript: ev.transcript,
    maxMinutes: ctx.config.stt.audio_max_minutes,
  });
  // Расшифровка — цитатой (0.3.4, R-23 а); отказ (и пустая расшифровка — её текст тоже отказ) — простым текстом ⟨предл.⟩.
  const quote = state === 'transcribed' && !!ev.transcript?.trim();
  return { text, quote, chatId: ev.chat_id, threadId: ev.thread_id, messageId: ev.message_id };
}

/**
 * Ответ на голосовое, кружок, аудиофайл или видео — в очередь отправки (строка шлюза вида receipt: реплай владельца на неё — к этому
 * событию, 5.5а). Без разметки (bare): кнопок под расшифровкой пока нет — место для них оставлено. Расшифровка —
 * цитатой (outbox.quote; 0.3.4, развилка R-23 а, issue #44: так видно, что это не слова агента); длинная —
 * несколькими цитатами подряд, все ответом на то же сообщение (sender.ts). Внутри транзакции. Возвращает id строки
 * outbox или null (ответа нет).
 */
export function enqueueSttReply(ctx: Ctx, seq: number): number | null {
  const r = sttReplyOf(ctx, seq);
  if (!r) return null;
  return insertOutbox(ctx, {
    eventSeq: seq,
    chatId: r.chatId,
    threadId: r.threadId,
    kind: 'receipt',
    text: r.text,
    origin: 'gateway',
    replyToMessageId: r.messageId,
    bare: true,
    quote: r.quote,
  });
}

type SttOutcome =
  | { ok: true; text: string; attempts: number; elapsedMs: number; outputTokens: number | null }
  | { ok: false; reason: string; attempts: number; elapsedMs: number; error?: string }
  /** Не распознавать (аудиофайл длиннее предела): файл скачан или нет — видно по raw_ref. */
  | { ok: 'skipped'; reason: string; attempts: 0; elapsedMs: number };

/** Файл больше предела Bot API: getFile отвечает «file is too big». */
class TooBig extends Error {}

export interface SttView {
  /** Есть ли ключ распознавания (null — ещё не проверяли). */
  keyKnown: boolean | null;
  /** Последний отказ распознавания. */
  lastFailure: { at: number; reason: string } | null;
}

export interface TranscriberHooks {
  /** Расшифровка или отказ записаны: ответ владельцу — в очереди, событие — new. */
  onSettled(seq: number): void;
}

/** Очередь распознавания: голосовые · аудиофайлы (события document). */
export type SttLaneName = 'voice' | 'audio';

interface SttLaneState {
  running: boolean;
  again: boolean;
  current: Promise<void>;
  retryTimer: Timer | null;
}

/**
 * Распознаватель: события transcribing — по одному, по порядку №, в двух очередях: голосовые и аудиофайлы идут
 * независимо (длинный файл не держит голосовые).
 */
export class Transcriber {
  private stopped = false;
  private readonly stopCtl = new AbortController();
  private readonly lanes: Record<SttLaneName, SttLaneState> = {
    voice: { running: false, again: false, current: Promise.resolve(), retryTimer: null },
    audio: { running: false, again: false, current: Promise.resolve(), retryTimer: null },
  };
  /** Распознано, а записать не вышло (диск полон): при следующей попытке — сразу запись, без провайдера. */
  private readonly unsaved = new Map<number, SttOutcome>();
  /** Последний отказ распознавания голосового (для «статус»; аудиофайл — в ответе на него). */
  lastFailure: { at: number; reason: string } | null = null;
  /** Предохранитель голосовых включён до (часы шлюза); null — выключен. */
  private degradedUntil: number | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly stt: SpeechToText,
    private readonly key: VoiceKey,
    private readonly hooks: TranscriberHooks,
  ) {}

  view(): SttView {
    return { keyKnown: this.key.known, lastFailure: this.lastFailure };
  }

  kick(): void {
    this.kickLane('voice');
    this.kickLane('audio');
  }

  private kickLane(name: SttLaneName): void {
    if (this.stopped) return;
    const lane = this.lanes[name];
    if (lane.running) {
      lane.again = true;
      return;
    }
    lane.running = true;
    lane.current = this.run(name)
      .catch((err: unknown) => {
        if (!(err instanceof Stopped)) this.ctx.journal.write('stt_error', { lane: name, error: (err as Error).message });
      })
      .finally(() => {
        lane.running = false;
        if (lane.again && !this.stopped) {
          lane.again = false;
          this.kickLane(name);
        }
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const lane of Object.values(this.lanes)) lane.retryTimer?.cancel();
    this.stopCtl.abort(new Stopped('остановка'));
    await Promise.all(Object.values(this.lanes).map((l) => l.current.catch(() => undefined)));
  }

  private next(name: SttLaneName): VoiceEventRow | null {
    // Голосовая очередь — голосовые и кружки (0.3); очередь файлов — всё остальное (аудиофайлы, видео).
    const lane = name === 'voice' ? VOICE_LANE_SQL : `NOT ${VOICE_LANE_SQL}`;
    return (sql(this.ctx.db, `SELECT * FROM events WHERE status = 'transcribing' AND ${lane} ORDER BY seq LIMIT 1`).get() as VoiceEventRow | undefined) ?? null;
  }

  private async run(name: SttLaneName): Promise<void> {
    const lane = this.lanes[name];
    for (;;) {
      if (this.stopped) return;
      lane.again = false;
      if (this.ctx.disk.isFull) {
        this.retryLater(name);
        return;
      }
      const row = this.next(name);
      if (!row) return;
      let outcome: SttOutcome;
      try {
        outcome = this.unsaved.get(row.seq) ?? (await this.recognize(row));
      } catch (err) {
        if (!(err instanceof DiskFullLater)) throw err;
        this.retryLater(name);
        return;
      }
      if (this.stopped) return;
      // Точка сбоя: ответ провайдера получен, а не записан — после перезапуска голосовое распознаётся заново (A4.7).
      faultPoint('in_stt', row.update_id);
      if (!this.commit(row, outcome)) {
        this.unsaved.set(row.seq, outcome);
        this.retryLater(name);
        return;
      }
      this.unsaved.delete(row.seq);
    }
  }

  private retryLater(name: SttLaneName): void {
    const lane = this.lanes[name];
    lane.retryTimer?.cancel();
    lane.retryTimer = this.ctx.clock.setTimeout(() => this.kickLane(name), DISK_RETRY_MS);
  }

  /**
   * Звук: файл raw/; нет файла (голосовое не скачалось при приёме, аудиофайл — ещё не скачивался) — скачать по file_id.
   * Больше 20 МБ — TooBig (бот такой файл не скачает).
   */
  private async audioOf(row: VoiceEventRow, src: SttSource): Promise<Buffer | null> {
    if (row.raw_ref) {
      try {
        return fs.readFileSync(path.join(this.ctx.paths.home, row.raw_ref));
      } catch (err) {
        this.ctx.journal.write('stt_audio_missing', { seq: row.seq, error: (err as Error).message });
      }
    }
    const { fileId } = src;
    const api = this.ctx.api;
    if (!fileId || !api || row.update_id === null) return null;
    try {
      const signal = AbortSignal.any([this.stopCtl.signal, AbortSignal.timeout(src.file ? AUDIO_FILE_TIMEOUT_MS : FILE_TIMEOUT_MS)]);
      let f: { file_path?: string };
      try {
        f = await api.call<{ file_path?: string }>('getFile', { file_id: fileId }, { signal });
      } catch (err) {
        if (err instanceof TelegramApiError && err.errorCode === 400 && /file is too big/i.test(err.description)) throw new TooBig(err.description);
        throw err;
      }
      if (!f.file_path) throw new Error('getFile: нет file_path');
      const data = await api.download(f.file_path, { signal });
      const ext = /^[a-z0-9]{1,8}$/.test(src.ext) ? src.ext : 'bin';
      const ref = path.posix.join('raw', localDate(row.created_at, this.ctx.config.timezone), `${row.update_id}.${ext}`);
      const full = path.join(this.ctx.paths.home, ref);
      ensureDir(path.dirname(full));
      writeFileAtomicSync(full, data, 0o600);
      transaction(this.ctx.db, () => sql(this.ctx.db, 'UPDATE events SET raw_ref = ? WHERE seq = ?').run(ref, row.seq));
      row.raw_ref = ref;
      this.ctx.journal.write('stt_audio_downloaded', { seq: row.seq, raw_ref: ref });
      return data;
    } catch (err) {
      if (this.stopCtl.signal.aborted) throw new Stopped('остановка');
      if (err instanceof TooBig) {
        this.ctx.journal.write('stt_audio_too_big', { seq: row.seq, error: api.redact(err.message) });
        throw err;
      }
      if (this.ctx.disk.check(err, 'stt_download', { seq: row.seq })) throw new DiskFullLater('диск полон');
      this.ctx.journal.write('stt_audio_failed', { seq: row.seq, error: api.redact((err as Error).message) });
      return null;
    }
  }

  /**
   * Аудиофайл без длительности в метаданных (document) — длительность по самому файлу (audio-duration.ts) и в базу
   * (events.audio_seconds): квитанция и агент видят её, предел и срок попытки — по ней. По файлу не вышло — оценка по
   * размеру, только для срока попытки (не для предела: оценка груба). Диск полон — в базу не записалось, не беда.
   */
  private fileSeconds(row: VoiceEventRow, data: Buffer): { seconds: number | null; estimate: number | null } {
    const parsed = audioDurationOf(data);
    if (parsed === null) {
      const estimate = audioDurationEstimate(data.length);
      this.ctx.journal.write('audio_duration', { seq: row.seq, how: 'estimate', seconds: Math.round(estimate), bytes: data.length });
      return { seconds: null, estimate };
    }
    const seconds = Math.round(parsed * 10) / 10;
    try {
      transaction(this.ctx.db, () => sql(this.ctx.db, 'UPDATE events SET audio_seconds = ? WHERE seq = ?').run(seconds, row.seq));
      row.audio_seconds = seconds;
    } catch (err) {
      if (!this.ctx.disk.check(err, 'stt_duration', { seq: row.seq })) throw err;
    }
    this.ctx.journal.write('audio_duration', { seq: row.seq, how: 'file', seconds });
    return { seconds, estimate: null };
  }

  /**
   * Распознать: до трёх попыток, срок попытки 60 с (у длинного звука — больше), всё вместе — не дольше 3 минут (у
   * длинного — не меньше двух попыток). Предохранитель — только у голосовых.
   */
  private async recognize(row: VoiceEventRow): Promise<SttOutcome> {
    const { clock, config } = this.ctx;
    const start = clock.now();
    const fail = (reason: string, attempts: number, error?: string): SttOutcome => ({
      ok: false,
      reason,
      attempts,
      elapsedMs: clock.now() - start,
      ...(error ? { error } : {}),
    });
    const src = sttSourceOf(row);
    if (!src) return fail('no_audio', 0);
    let audio: Buffer | null;
    try {
      audio = await this.audioOf(row, src);
    } catch (err) {
      if (err instanceof TooBig) return fail('too_big', 0);
      throw err;
    }
    // Звук файлом без длительности в метаданных — по самому файлу.
    let estimate: number | null = null;
    if (src.file && src.seconds === null && audio) {
      const d = this.fileSeconds(row, audio);
      src.seconds = d.seconds;
      estimate = d.estimate;
    }
    // Звук файлом длиннее предела — только сохранить (5.8): провайдеру не уходит.
    const tooLong = row.stt_note === 'too_long' || (src.file && src.seconds !== null && src.seconds > config.stt.audio_max_minutes * 60);
    if (tooLong) return { ok: 'skipped', reason: 'too_long', attempts: 0, elapsedMs: clock.now() - start };
    if (!audio) return fail('no_audio', 0);
    // Под тестом — только поддельный провайдер на этой машине.
    if (this.ctx.test && !isLocalUrl(this.stt.info.baseUrl)) return fail('real_api_under_test', 0);
    const key = await this.key.get();
    if (!key) return fail('no_key', 0);
    // Предохранитель — у голосовой очереди (голосовые и кружки).
    const degraded = src.lane === 'voice' && this.degradedUntil !== null && clock.now() < this.degradedUntil;
    const maxAttempts = degraded ? 1 : STT_ATTEMPTS;
    // Длинный звук (аудиофайл до 15 минут) — срок попытки по длительности ⟨предл.⟩; бюджет — не меньше двух попыток.
    const long = Math.min(STT_LONG_ATTEMPT_MAX_MS, Math.round((src.seconds ?? estimate ?? 0) * STT_MS_PER_AUDIO_SECOND));
    const attemptMs = degraded ? Math.max(STT_DEGRADED_ATTEMPT_MS, Math.round(long / 3)) : Math.max(STT_ATTEMPT_MS, long);
    const budgetMs = Math.max(STT_BUDGET_MS, attemptMs * 2);
    let last: VoiceProviderError | null = null;
    let attempt = 0;
    while (attempt < maxAttempts) {
      const left = budgetMs - (clock.now() - start);
      if (left <= 0) break;
      attempt++;
      const dl = clockDeadline(clock, Math.min(attemptMs, left), { signal: this.stopCtl.signal });
      try {
        const r = await this.stt.transcribe(
          audio,
          src.mime,
          { language: config.stt.language, vocabulary: config.stt.vocabulary, filename: src.filename },
          { key, signal: dl.signal },
        );
        if (this.degradedUntil !== null) {
          this.degradedUntil = null;
          this.ctx.journal.write('stt_recovered', { seq: row.seq });
        }
        return { ok: true, text: r.text, attempts: attempt, elapsedMs: clock.now() - start, outputTokens: r.outputTokens };
      } catch (err) {
        if (this.stopCtl.signal.aborted) throw new Stopped('остановка');
        const e = providerError('stt', this.stt.info.provider, err);
        last = e;
        this.ctx.journal.write('stt_attempt_failed', {
          seq: row.seq,
          attempt,
          provider: e.provider,
          kind: e.kind,
          code: e.code,
          status: e.status,
          error: e.message,
          ...(src.file ? { audio_file: true, source: src.source } : {}),
          ...(degraded ? { degraded: true } : {}),
        });
        if (e.kind === 'auth') this.key.invalidate();
        if (!e.retryable) return fail(e.code, attempt, e.message);
        if (attempt >= maxAttempts) break;
        const pause = e.code === 'timeout' ? 0 : Math.min(MAX_PAUSE_MS, e.retryAfterMs ?? STT_PAUSE_MS * attempt);
        if (clock.now() - start + pause >= budgetMs) break;
        if (pause > 0) {
          try {
            await clock.sleep(pause, this.stopCtl.signal);
          } catch {
            throw new Stopped('остановка');
          }
        }
      } finally {
        dl.cancel();
      }
    }
    // Провайдер не отвечает: срок, сеть или 5xx на всех попытках голосового (или кружка) — предохранитель на следующие
    // голосовые. Аудиофайл и видео его не включают: срок на длинном файле — ещё не «провайдер не отвечает».
    if (src.lane === 'voice' && (!last || last.kind === 'network' || last.kind === 'server')) {
      this.degradedUntil = clock.now() + STT_DEGRADED_MS;
      this.ctx.journal.write('stt_degraded', { seq: row.seq, until: this.degradedUntil, reason: last?.code ?? 'timeout' });
    }
    return fail(last?.code ?? 'timeout', attempt, last?.message);
  }

  /** Записать исход: transcript и new одной транзакцией с ответом владельцу на голосовое (файл). false — диск полон. */
  private commit(row: VoiceEventRow, o: SttOutcome): boolean {
    let changed = false;
    let material: SettleResult | null = null;
    try {
      changed = transaction(this.ctx.db, () => {
        const r =
          o.ok === true
            ? sql(this.ctx.db, "UPDATE events SET transcript = ?, status = 'new' WHERE seq = ? AND status = 'transcribing'").run(o.text, row.seq)
            : o.ok === false && o.reason === 'too_big'
              ? sql(this.ctx.db, "UPDATE events SET status = 'new', stt_note = 'too_big' WHERE seq = ? AND status = 'transcribing'").run(row.seq)
              : o.ok === 'skipped'
                ? sql(this.ctx.db, "UPDATE events SET status = 'new', stt_note = 'too_long' WHERE seq = ? AND status = 'transcribing'").run(row.seq)
                : sql(this.ctx.db, "UPDATE events SET status = 'new' WHERE seq = ? AND status = 'transcribing'").run(row.seq);
        if (!Number(r.changes)) return false;
        enqueueSttReply(this.ctx, row.seq);
        material = settleTranscribed(this.ctx, row.seq, this.ctx.clock.now());
        return true;
      });
    } catch (err) {
      if (this.ctx.disk.check(err, 'stt_commit', { seq: row.seq })) return false;
      throw err;
    }
    if (!changed) return true;
    const settled = material as SettleResult | null;
    if (settled) {
      const now = this.ctx.clock.now();
      if (settled.held) this.ctx.journal.write('material_held', { seq: row.seq, after: 'stt' });
      if (settled.timedOut) this.ctx.journal.write('material_released', { seq: row.seq, held_ms: now - row.created_at, words: 'none' });
      for (const m of settled.released) this.ctx.journal.write('material_released', { seq: m.seq, held_ms: m.heldMs, words: 'after', words_seq: row.seq });
    }
    const src = sttSourceOf(row);
    if (o.ok === 'skipped') {
      this.ctx.journal.write('stt_skipped', { seq: row.seq, reason: o.reason, saved: !!row.raw_ref, raw_ref: row.raw_ref, seconds: src?.seconds ?? null });
    } else if (o.ok) {
      // Входящее — дословно (Ш-16): расшифровка в журнал с меткой содержимого — меткой вложения: свой аудиофайл и свой
      // кружок без пересылки — owner (аудиофайл и кружок — развилки R-2 а и R-20 а), пересланный, чужой и
      // видео — untrusted (Ш-20).
      // Рядом — длительность звука, слов в расшифровке и токенов ответа (если провайдер назвал): у модели есть предел
      // ответа, и обрезанная длинная надиктовка видна по этим числам.
      this.ctx.journal.write('transcribed', {
        seq: row.seq,
        label: src?.file ? (src.trust ?? 'untrusted') : row.trust,
        ...(src?.file ? { audio_file: true, source: src.source, lane: src.lane } : {}),
        text: o.text,
        attempts: o.attempts,
        elapsed_ms: o.elapsedMs,
        seconds: src?.seconds ?? null,
        words: o.text.split(' ').length,
        ...(o.outputTokens !== null ? { output_tokens: o.outputTokens } : {}),
      });
    } else {
      // «Статус» — о голосовой очереди (голосовые и кружки): отказ по аудиофайлу и видео (и файл больше 20 МБ) виден в
      // ответе на него.
      if (o.reason !== 'too_big' && src?.lane === 'voice') this.lastFailure = { at: this.ctx.clock.now(), reason: o.reason };
      this.ctx.journal.write('stt_failed', {
        seq: row.seq,
        label: row.trust,
        reason: o.reason,
        attempts: o.attempts,
        elapsed_ms: o.elapsedMs,
        ...(src?.file ? { audio_file: true, source: src.source } : {}),
        ...(o.error ? { error: o.error } : {}),
      });
    }
    this.hooks.onSettled(row.seq);
    return true;
  }
}

/** Синтез ответа голосом: готовый звук — в памяти до отправки (после перезапуска — синтез заново). */
type SynthJob = { state: 'running' } | { state: 'ready'; audio: Buffer; seconds: number } | { state: 'failed'; reason: string };

export class VoiceSynth {
  private readonly jobs = new Map<number, SynthJob>();
  private readonly stopCtl = new AbortController();
  private stopped = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly tts: TextToSpeech,
    private readonly key: VoiceKey,
    /** Синтез закончился (готов или нет) — отправителю пора. */
    private readonly onSettled: () => void,
  ) {}

  job(outboxId: number): SynthJob | null {
    return this.jobs.get(outboxId) ?? null;
  }

  /** Начать синтез ответа (если ещё не идёт). */
  start(outboxId: number, text: string): void {
    if (this.stopped || this.jobs.has(outboxId)) return;
    this.jobs.set(outboxId, { state: 'running' });
    void this.synthesize(text).then(
      (r) => this.settle(outboxId, r),
      (err: unknown) => {
        if (!this.stopped) this.settle(outboxId, { state: 'failed', reason: `internal: ${(err as Error).message}` });
      },
    );
  }

  forget(outboxId: number): void {
    this.jobs.delete(outboxId);
  }

  /** Строки, для которых что-то синтезировано или синтезируется. */
  ids(): number[] {
    return [...this.jobs.keys()];
  }

  stop(): void {
    this.stopped = true;
    this.stopCtl.abort(new Stopped('остановка'));
  }

  private settle(outboxId: number, r: SynthJob): void {
    if (this.stopped) return;
    this.jobs.set(outboxId, r);
    if (r.state === 'failed') {
      this.ctx.journal.write('tts_failed', { outbox_id: outboxId, reason: r.reason });
      try {
        transaction(this.ctx.db, () => sql(this.ctx.db, 'UPDATE outbox SET voice_failed = 1 WHERE id = ?').run(outboxId));
      } catch (err) {
        // Диск полон: отметка останется в памяти — до перезапуска её хватит.
        if (!this.ctx.disk.check(err, 'tts_failed', { outbox_id: outboxId })) throw err;
      }
    } else if (r.state === 'ready') {
      this.ctx.journal.write('tts_ready', { outbox_id: outboxId, seconds: Math.round(r.seconds * 10) / 10, bytes: r.audio.length });
    }
    this.onSettled();
  }

  private async synthesize(text: string): Promise<SynthJob> {
    const { clock, config } = this.ctx;
    const voice = ttsVoice(config.tts);
    if (!voice) return { state: 'failed', reason: 'no_voice' };
    if (this.ctx.test && !isLocalUrl(this.tts.info.baseUrl)) return { state: 'failed', reason: 'real_api_under_test' };
    const key = await this.key.get();
    if (!key) return { state: 'failed', reason: 'no_key' };
    let reason = 'timeout';
    for (let attempt = 1; attempt <= TTS_ATTEMPTS; attempt++) {
      const dl = clockDeadline(clock, TTS_ATTEMPT_MS, { signal: this.stopCtl.signal });
      try {
        const r = await this.tts.synthesize(text, { voice }, { key, signal: dl.signal });
        return { state: 'ready', audio: r.audio, seconds: r.info.seconds };
      } catch (err) {
        if (this.stopCtl.signal.aborted) throw new Stopped('остановка');
        const e = providerError('tts', this.tts.info.provider, err);
        reason = e.code;
        this.ctx.journal.write('tts_attempt_failed', { attempt, provider: e.provider, kind: e.kind, code: e.code, status: e.status, error: e.message });
        if (e.kind === 'auth') this.key.invalidate();
        if (!e.retryable || attempt >= TTS_ATTEMPTS) break;
        const pause = e.code === 'timeout' ? 0 : Math.min(MAX_PAUSE_MS, e.retryAfterMs ?? STT_PAUSE_MS);
        if (pause > 0) {
          try {
            await clock.sleep(pause, this.stopCtl.signal);
          } catch {
            throw new Stopped('остановка');
          }
        }
      } finally {
        dl.cancel();
      }
    }
    return { state: 'failed', reason };
  }
}
