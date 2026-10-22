// Посылки (TECH-SPEC 5.16; 0.3.3; P-23, issue #29) — общее для шлюза, канала и тестов: пределы, имена, проверки пути
// без файловой системы. Агент отвечает владельцу файлами из промежуточной папки, которую сам обновляет; из неё же потом —
// публикация в веб-сервис.
//
// Папка посылок — единственное место, откуда агент отдаёт что-то наружу: посылка — подпапка `<папка посылок>/<имя>/` с
// файлами, которые агент создаёт и обновляет сам. Шлюз отдаёт файл (send_file) так: проверяет путь, снимает копию в своё
// хранилище (`raw/parcels/<sha256>`) и ставит доставку в очередь цели (сейчас одна — telegram, sendDocument). Состояние
// доставок — в базе шлюза (deliveries), а не в папке посылки.

import path from 'node:path';

/**
 * Предел файла: 50 МБ — столько бот отправляет через общий сервер Bot API (описание sendDocument, `@grammyjs/types` 5.0.0,
 * methods.d.ts:372; у людей в Telegram — 2 ГБ, к ботам не относится; со своим сервером Bot API — до 2000 МБ, P-7).
 */
export const PARCEL_MAX_BYTES = 50 * 1024 * 1024;

/** Папка посылок по умолчанию — `<папка агента>/parcels`, рядом с notes/ (шаблон scripts/agent-folder). */
export const PARCELS_DIR_NAME = 'parcels';

/** Хранилище копий у шлюза: `raw/parcels/<sha256>` (в копию stg backup входит вместе с raw/). */
export const PARCEL_STORE_DIR = 'parcels';

/** Цель доставки по умолчанию — личка владельца в Telegram. Другие цели (web) — позже, через настройку parcels.targets. */
export const DEFAULT_PARCEL_TARGET = 'telegram';

/** Имя цели в config.yaml и в send_file.target: латиница, цифры, «_», «-». */
export const PARCEL_TARGET_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Новая версия того же файла в тот же чат — пометка шлюза последней строкой подписи ⟨предл.: текст⟩. */
export const PARCEL_UPDATED_TEXT = '⚙ обновлено';

/** deliveries.note: брошена «стопом» (control.ts). */
export const PARCEL_NOTE_STOP = 'стоп';
/** deliveries.note: «стоп» прервал загрузку документа в пути (sender.ts) — Telegram мог успеть его принять. */
export const PARCEL_NOTE_STOP_UPLOAD = 'стоп во время загрузки: документ мог уйти';
/** deliveries.note: документ был в пути при «стопе» и дошёл — доставка sent (sender.ts). */
export const PARCEL_NOTE_AFTER_STOP = 'ушёл после стопа';

/**
 * Загрузка документа в Telegram: предел запроса — минута на соединение и ответ плюс время загрузки на 1 Мбит/с
 * (125 000 байт/с) ⟨предл.⟩: 50 МБ — около 8 минут. Медленнее — таймаут; после DOCUMENT_MAX_TIMEOUTS таймаутов доставка
 * failed «не успел загрузить» (находка проверки 0.3.3: прежде файл перезаливался без конца и держал очередь).
 */
export const DOCUMENT_TIMEOUT_BASE_MS = 60_000;
export const DOCUMENT_MIN_BYTES_PER_S = 125_000;
export const DOCUMENT_MAX_TIMEOUTS = 3;

/** Предел запроса sendDocument по размеру файла, мс. */
export function documentTimeoutMs(bytes: number): number {
  return DOCUMENT_TIMEOUT_BASE_MS + Math.ceil((Math.max(0, bytes) * 1000) / DOCUMENT_MIN_BYTES_PER_S);
}

/** Версия файла для агента и журнала — начало SHA-256 содержимого. */
export function parcelVersion(sha256: string): string {
  return sha256.slice(0, 8);
}

/**
 * Управляющие (Cc) и невидимые знаки форматирования (Cf: нулевой ширины U+200B–U+200D, U+2060, U+FEFF, мягкий перенос
 * U+00AD, монгольский разделитель U+180E, знаки направления письма U+061C, U+200E/F, U+202A–U+202E, U+2066–U+2069),
 * разделители строк и абзацев U+2028/2029 — в имени файла или посылки: такие имена не отправляются (находка проверки
 * 0.3.3: прежде пропускались знаки нулевой ширины).
 */
const UNSAFE_NAME_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** Сегменты относительного пути: «a/b/c» → [a, b, c] (разделитель — системный и «/»). */
export function pathSegments(rel: string): string[] {
  return rel.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
}

/** Скрытый сегмент (.git, .env, .claude …) — такие файлы и папки не отправляются ⟨предл.⟩. */
export function hasHiddenSegment(rel: string): boolean {
  return pathSegments(rel).some((s) => s.startsWith('.'));
}

/** Плохое имя: управляющие и невидимые знаки (UNSAFE_NAME_RE). */
export function hasUnsafeName(rel: string): boolean {
  return UNSAFE_NAME_RE.test(rel);
}

/**
 * Путь p относительно корня root, если p внутри root (не сам root); иначе null. Чисто по строкам: симлинки решает
 * вызывающий (realpath).
 */
export function relativeInside(root: string, p: string): string | null {
  const r = path.relative(root, p);
  if (!r || path.isAbsolute(r) || r === '..' || r.startsWith(`..${path.sep}`)) return null;
  return r;
}

/** Посылка и файл по пути внутри папки посылок: первый сегмент — посылка, остальное — файл в ней. */
export function parcelPartsOf(rel: string): { parcel: string; file: string; name: string } | null {
  const segs = pathSegments(rel);
  if (segs.length < 2) return null;
  return { parcel: segs[0]!, file: segs.slice(1).join('/'), name: segs[segs.length - 1]! };
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Тип содержимого для sendDocument — по расширению; неизвестное — application/octet-stream. */
export function parcelContentType(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
