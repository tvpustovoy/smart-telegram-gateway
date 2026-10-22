// Звук файлом для распознавания (J-2; TECH-SPEC 5.8). Аудиофайл (до 15 минут — сразу, без нарезки) — `message.audio`
// или `message.document` с mime `audio/*` или расширением аудио. С 0.3 (P-14) — ещё видео-кружок (`message.video_note`,
// всегда mp4) и видео (`message.video` в mp4 ⟨предл.⟩): у них распознаётся звуковая дорожка, тем же распознавателем
// (mp4 — в списке форматов OpenAI; ElevenLabs — не сверено). Событие — вида `document`; что это звук и как его
// распознавать, видно по вложению (attachments_json: тип, имя, mime, длительность, размер). Метка: свой аудиофайл
// (R-2) и свой кружок (R-20) без пересылки — слово владельца, как голосовое; пересланное, от другого участника и видео —
// «чужое» (trust.ts).
//
// Расширение — из имени файла: Telegram может отдать для .m4a mime audio/mpeg. Провайдеру уходит имя с расширением,
// которое он понимает (.oga и .opus — это Ogg: уходят как .ogg), и mime по расширению; кружок и видео — `.mp4`,
// `video/mp4`.

import type { TrustLabel } from './schema.js';
import type { Attachment } from './trust.js';

/** Расширения аудио (без точки). */
export const AUDIO_EXTENSIONS = ['m4a', 'mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'aac', 'webm'] as const;
export type AudioExtension = (typeof AUDIO_EXTENSIONS)[number];

/** Предел Bot API на скачивание файла ботом (getFile): 20 МБ. */
export const BOT_API_FILE_LIMIT = 20 * 1024 * 1024;

/** mime по расширению — для провайдера распознавания. */
const MIME_OF: Record<AudioExtension, string> = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  webm: 'audio/webm',
};

/** Расширение по mime — если в имени файла его нет. */
const EXT_OF_MIME: Record<string, AudioExtension> = {
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/webm': 'webm',
};

/** Откуда звук: аудиофайл · видео-кружок · видео (0.3). */
export const SOUND_SOURCES = ['audio', 'video_note', 'video'] as const;
export type SoundSource = (typeof SOUND_SOURCES)[number];

export interface AudioFile {
  /** Аудиофайл, кружок или видео (0.3). */
  source: SoundSource;
  /** Метка вложения: свой аудиофайл (R-2) и кружок (R-20) без пересылки — owner, иначе — как файл. */
  trust: TrustLabel;
  fileId: string;
  /** Имя файла из Telegram (null — нет). */
  fileName: string | null;
  /**
   * Как назвать агенту (audio.name): имя файла, иначе название трека, иначе «без имени»; кружок — «кружок», видео без имени
   * — «видео». Владельцу имя не показывается: ответ на звук — только расшифровка или причина (0.3.1, P-19).
   */
  label: string;
  mime: string | null;
  /** Длительность из метаданных Telegram, с; null — нет (у document её нет). */
  duration: number | null;
  /** Размер из метаданных, байты; null — нет. */
  size: number | null;
  /** Расширение для файла в raw/: из имени, иначе по mime, иначе «bin». */
  ext: string;
}

function extOfName(name: string | null): string | null {
  if (!name) return null;
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
  return m ? m[1]!.toLowerCase() : null;
}

function isAudioExt(e: string | null): e is AudioExtension {
  return e !== null && (AUDIO_EXTENSIONS as readonly string[]).includes(e);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Документ — аудио: mime `audio/*` или расширение аудио в имени (trust.ts — свой звук файлом). */
export function isAudioDocumentRef(ref: Record<string, unknown>): boolean {
  const mime = str(ref.mime_type)?.toLowerCase() ?? null;
  return (mime !== null && mime.startsWith('audio/')) || isAudioExt(extOfName(str(ref.file_name)));
}

/**
 * Видео в mp4: только его звук распознаём (OpenAI не принимает .mov) ⟨предл.⟩. Есть mime — по нему, нет — по расширению
 * имени. Нет ни mime, ни расширения — считаем mp4 и пробуем распознать (исправления по проверке сведения ⟨предл.⟩):
 * Telegram у видео обычно присылает mime, а сжатое клиентом видео — mp4; не примет провайдер — владелец получит «Не смог
 * распознать — видео сохранено», а не ложное «не в mp4».
 */
function isMp4Video(mime: string | null, fileName: string | null): boolean {
  if (mime !== null) return mime === 'video/mp4';
  const ext = extOfName(fileName);
  return ext === null || ext === 'mp4';
}

/**
 * Видео не в mp4 (`message.video` с mime не video/mp4, например .mov): звук не распознаётся — провайдер без перекодировки
 * его не примет, перекодировать нечем. Владельцу — короткий ответ «видео не в mp4» вместо расшифровки (сведение 0.3 и
 * 0.3.1 ⟨предл.⟩), агенту — «(видео: звук не распознаётся — формат не mp4)» (format.ts). Видео, присланное файлом
 * (`message.document` с mime `video/*` — iPhone `.mov` «файлом», без сжатия), сюда не входит: это обычный файл — без
 * расшифровки и без ответа, как в 0.3 (TECH-SPEC 5.8; распознавать ли его — развилка R-22, issue #43).
 */
export function isNotMp4Video(attachments: readonly Attachment[] | null | undefined): boolean {
  for (const a of attachments ?? []) {
    if (a.kind !== 'document') continue;
    const ref = a.ref ?? {};
    if (str(ref.type) !== 'video' || !str(ref.file_id)) continue;
    if (!isMp4Video(str(ref.mime_type)?.toLowerCase() ?? null, str(ref.file_name))) return true;
  }
  return false;
}

/**
 * Звук для распознавания во вложениях события (или сообщения): аудиофайл (`audio`, либо `document` с mime audio/* или
 * расширением аудио), видео-кружок (`video_note`) или видео в mp4 (`video`).
 */
export function audioFileOf(attachments: readonly Attachment[] | null | undefined): AudioFile | null {
  for (const a of attachments ?? []) {
    if (a.kind !== 'document') continue;
    const ref = a.ref ?? {};
    const type = str(ref.type);
    const fileId = str(ref.file_id);
    if (!fileId) continue;
    const fileName = str(ref.file_name);
    const mime = str(ref.mime_type)?.toLowerCase() ?? null;
    const base = { trust: a.trust, fileId, fileName, duration: num(ref.duration), size: num(ref.file_size) };
    if (type === 'video_note') {
      // Кружок — всегда mp4 (H.264 + AAC); mime у него Telegram не даёт.
      return { ...base, source: 'video_note', label: 'кружок', mime: 'video/mp4', ext: 'mp4' };
    }
    if (type === 'video') {
      if (!isMp4Video(mime, fileName)) continue;
      return { ...base, source: 'video', label: fileName ?? 'видео', mime: 'video/mp4', ext: 'mp4' };
    }
    const nameExt = extOfName(fileName);
    const audio = type === 'audio' || (type === 'document' && isAudioDocumentRef(ref));
    if (!audio) continue;
    const ext = isAudioExt(nameExt) ? nameExt : (mime !== null ? EXT_OF_MIME[mime] : undefined) ?? (nameExt ?? 'bin');
    const title = [str(ref.performer), str(ref.title)].filter(Boolean).join(' — ');
    return { ...base, source: 'audio', label: fileName ?? (title || 'без имени'), mime, ext };
  }
  return null;
}

/**
 * Что уходит провайдеру распознавания: имя файла с расширением, которое понимают OpenAI и ElevenLabs (.oga и .opus —
 * Ogg, уходят как .ogg), и mime по расширению (не по Telegram: для .m4a он бывает audio/mpeg). Кружок и видео —
 * `<имя>.mp4` и `video/mp4`: mp4 есть в списке форматов распознавания OpenAI, ElevenLabs принимает видео ⟨не сверено⟩.
 */
export function providerAudioFile(a: Pick<AudioFile, 'fileName' | 'ext' | 'mime'>, fallbackBase: string): { filename: string; mime: string } {
  const ext = a.ext === 'oga' || a.ext === 'opus' ? 'ogg' : a.ext;
  const base =
    (a.fileName ?? '')
      .replace(/\.[A-Za-z0-9]{1,8}$/, '')
      .replace(/[^\p{L}\p{N}_ .-]/gu, '_')
      .trim()
      .slice(0, 80) || fallbackBase;
  const mime = a.ext === 'mp4' ? 'video/mp4' : isAudioExt(a.ext) ? MIME_OF[a.ext] : (a.mime ?? 'application/octet-stream');
  return { filename: `${base}.${ext}`, mime };
}
