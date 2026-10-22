// Картинки для агента (0.3, P-6, P-14): фото, скриншоты, кадры кружков и видео.
// Чистые функции: что во вложениях события можно показать агенту инструментом media(seq) и какой файл для этого
// скачать; формат и размеры картинки — по первым байтам, своим кодом (новых пакетов и программ нет).
//
// Что показывается:
// - фото (`message.photo`) — размер, у которого длинная сторона ближе всего к 1600 px, но файл не больше 3,75 МБ;
// - изображение, присланное файлом (`document` с mime image/png, image/jpeg, image/webp, image/gif), — сам файл, если он
//   не больше 3,75 МБ; больше — уменьшенная копия Telegram (обложка документа, до 320 px), если она есть, с пометкой
//   «слишком большое для просмотра»: уменьшать своим кодом нечем — новых программ нет;
// - видео-кружок и видео — кадр-обложка Telegram (`thumbnail`).
// Подгонку по сторонам (2000×2000 px) делает Claude Code: картинку из ответа MCP-инструмента он пропускает через свой
// обработчик изображений с теми же пределами, что у Read (сверено по строкам сборки Claude Code 2.1.307; на реальном
// боте — скриншот файлом 2880×1800). Фото Telegram выбирается и так не больше 2000 px (размеры 90, 320,
// 800, 1280, 2560 — ближе к 1600 оказывается 1280). Предел по весу — 3,75 МБ ⟨предл.⟩: у API модели 5 МБ на картинку
// считаются по base64, а 3,75 МБ в base64 — ровно 5 МБ; ужимает ли Claude Code картинку из ответа MCP и по весу, не
// проверено — пока файл больше 3,75 МБ показывается уменьшенной копией Telegram.

import type { Attachment } from './trust.js';

/**
 * Предел файла для просмотра агентом — 3,75 МБ ⟨предл.⟩: в base64 это 5 МБ — предел API модели на картинку. Задание 0.3
 * называло 5 МБ файлом; пока не проверено, ужимает ли Claude Code картинку из ответа MCP по весу, — с запасом.
 */
export const MEDIA_VIEW_MAX_BYTES = (15 * 1024 * 1024) / 4;
/** Желаемая длинная сторона фото ⟨предл.⟩: ближе к ней — размер для агента. */
export const PHOTO_TARGET_SIDE = 1600;
/** Изображения, которые агент видит файлом (у модели — те же четыре формата). */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

/** Что за картинка у события: фото · изображение файлом · кружок · видео. */
export const MEDIA_WHATS = ['photo', 'image', 'video_note', 'video'] as const;
export type MediaWhat = (typeof MEDIA_WHATS)[number];

export interface FileRef {
  fileId: string;
  width: number | null;
  height: number | null;
  /** Размер из метаданных Telegram, байты; null — нет. */
  size: number | null;
}

/** Что можно показать по вложениям события. */
export type Viewable =
  | { what: 'photo'; pick: FileRef }
  | { what: 'image'; file: FileRef & { mime: string; name: string | null }; thumb: FileRef | null }
  | { what: 'video_note' | 'video'; thumb: FileRef | null };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function fileRef(v: unknown): FileRef | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const fileId = str(o.file_id);
  if (!fileId) return null;
  return { fileId, width: num(o.width), height: num(o.height), size: num(o.file_size) };
}

/**
 * Размер фото для агента: длинная сторона ближе всего к 1600 px среди размеров не больше предела просмотра (размер
 * неизвестен — не мешает); при равенстве — меньший. Все больше предела — самый лёгкий.
 */
export function pickPhotoSize(sizes: readonly FileRef[]): FileRef | null {
  if (!sizes.length) return null;
  const side = (s: FileRef): number => Math.max(s.width ?? 0, s.height ?? 0);
  const fits = sizes.filter((s) => s.size === null || s.size <= MEDIA_VIEW_MAX_BYTES);
  if (!fits.length) return [...sizes].sort((a, b) => (a.size ?? 0) - (b.size ?? 0))[0]!;
  return [...fits].sort((a, b) => Math.abs(side(a) - PHOTO_TARGET_SIDE) - Math.abs(side(b) - PHOTO_TARGET_SIDE) || side(a) - side(b))[0]!;
}

/** Изображение файлом: mime из Telegram — один из четырёх (содержимое потом сверяется по первым байтам). */
export function isImageMime(mime: string | null | undefined): mime is ImageMime {
  return typeof mime === 'string' && (IMAGE_MIMES as readonly string[]).includes(mime.toLowerCase());
}

/** Что во вложениях события можно показать агенту; null — ничего (текст, голос, аудиофайл, pdf…). */
export function viewableOf(attachments: readonly Attachment[] | null | undefined): Viewable | null {
  for (const a of attachments ?? []) {
    const ref = a.ref ?? {};
    if (a.kind === 'photo') {
      const listed = Array.isArray(ref.sizes) ? (ref.sizes as unknown[]).map(fileRef).filter((x): x is FileRef => x !== null) : [];
      // До 0.3 в событии — только самый большой размер.
      const sizes = listed.length ? listed : [fileRef(ref)].filter((x): x is FileRef => x !== null);
      const pick = pickPhotoSize(sizes);
      if (pick) return { what: 'photo', pick };
      continue;
    }
    if (a.kind !== 'document') continue;
    const type = str(ref.type);
    const thumb = fileRef(ref.thumbnail);
    if (type === 'video_note' || type === 'video') return { what: type, thumb };
    const mime = str(ref.mime_type)?.toLowerCase() ?? null;
    if (type === 'document' && isImageMime(mime)) {
      const file = fileRef(ref);
      if (file) return { what: 'image', file: { ...file, mime, name: str(ref.file_name) }, thumb };
    }
  }
  return null;
}

export interface ImageInfo {
  format: 'png' | 'jpeg' | 'gif' | 'webp';
  mime: ImageMime;
  width: number;
  height: number;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Формат и размеры картинки по первым байтам: PNG, JPEG, GIF, WebP. Не картинка или битая — null. */
export function imageInfo(buf: Buffer): ImageInfo | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIG) && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { format: 'png', mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a')) {
    return { format: 'gif', mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return webpInfo(buf);
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return jpegInfo(buf);
  return null;
}

function webpInfo(buf: Buffer): ImageInfo | null {
  const chunk = buf.toString('latin1', 12, 16);
  const base = { format: 'webp' as const, mime: 'image/webp' as const };
  if (chunk === 'VP8X' && buf.length >= 30) {
    return { ...base, width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    const b = buf.readUInt32LE(21);
    return { ...base, width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
    return { ...base, width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** JPEG: размеры — в маркере SOF (C0…CF, кроме C4 DHT, C8 JPG, CC DAC). */
function jpegInfo(buf: Buffer): ImageInfo | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Маркеры без длины.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return width && height ? { format: 'jpeg', mime: 'image/jpeg', width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/** Расширение файла картинки в raw/. */
export function imageExt(info: Pick<ImageInfo, 'format'>): string {
  return info.format === 'jpeg' ? 'jpg' : info.format;
}

/** «7,2 МБ», «840 КБ» — для строк агенту. */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  return `${Math.max(1, Math.round(n / 1024))} КБ`;
}
