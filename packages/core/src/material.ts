// Материал без слов владельца (0.3.6; GitHub issue #51; TECH-SPEC 5.18). Чистые функции: что в сообщении владельца —
// его слова, материал без слов или ни то ни другое. По этому решению шлюз держит материал окном
// ui.material_hold_seconds (gateway/src/material.ts): владелец часто присылает ссылку, пересылку или файл, а что с ними
// делать, говорит следом — агент должен получить материал вместе со словами, а не гадать над ним в одиночку.
//
// Слова владельца — новое сообщение владельца с его меткой (5.4: не пересылка, не инлайн-бот), в котором есть его
// собственные слова: текст, подпись к фото или файлу, голосовое, свой кружок и свой аудиофайл (R-2, R-20). Голосовое и
// кружок — слова с момента прихода, до расшифровки.
// Текст или подпись, в которых кроме ссылок ничего нет (linksOnly), — не слова: так приходит страница, которой владелец
// поделился из браузера («Отправить» → Telegram), — обычное его сообщение с одной ссылкой. Ссылка — http(s)://…, www.… или
// t.me/…; пробелы, переносы строк и разделяющая пунктуация вокруг ссылок не в счёт. Любое другое слово рядом —
// «посмотри https://…», заголовок страницы над ссылкой — слова: заголовок от слов владельца не отличить (Bot API
// заголовок превью не даёт). Ссылка на словах (text_link, «вот [статья](…)») — слова: в тексте видны слова, адреса нет.
// Сущности Telegram (url) не смотрим: в базе их нет, а то же решение принимается и по строке базы (gateway/src/material.ts:
// реплай на материал, правило «слова раньше», «слова после материала») — по сущностям оно разошлось бы с приёмом; адрес
// без www и схемы (example.com/…) — слова, как прежде.
// Материал — сообщение владельца, где его слов нет: пересылка (любая, и его собственного старого сообщения), сообщение
// через инлайн-бота, текст из одних ссылок, фото, файл, видео без подписи (или с подписью из одних ссылок).
// Ни то ни другое: жесты (стикер, кубик, GIF) — отклик, а не материал; команды, правки, нажатия, реакции,
// сообщения других участников ⟨предл.⟩. Правку удерживаемого материала шлюз решает сам (gateway/src/material.ts): есть в
// ней слова владельца (hasOwnerWords — подпись или текст не из одних ссылок) — слова, нет — ждёт вместе с исходным.

import type { Attachment } from './trust.js';
import type { EventKind, TrustLabel } from './schema.js';

/** Что за сообщение для окна материала: слова владельца · материал без слов · ни то ни другое (null). */
export type MaterialClass = 'words' | 'material' | null;

export interface MaterialInput {
  /** Отправитель — владелец. */
  fromOwner: boolean;
  kind: EventKind;
  /** Метка собственных слов (events.trust). */
  trust: TrustLabel | null;
  /** Текст или подпись. */
  text: string | null;
  attachments: readonly Attachment[];
  /** Пересылка (forward_origin). */
  forwarded: boolean;
}

/** Виды, у которых бывает окно материала: сообщения владельца. */
export const MATERIAL_KINDS = ['text', 'voice', 'photo', 'document'] as const;

/** Жесты: не слова и не материал — отдаются сразу, окна не открывают и не закрывают ⟨предл.⟩. */
const GESTURES = new Set(['sticker', 'dice', 'animation']);

/**
 * Ссылка: http(s)://…, www.… или t.me/… — до пробела; сразу за началом — буква или цифра. Не с середины слова или адреса
 * («art.me/…», «user@www.…»).
 */
const LINK_RE = /(?<![\p{L}\p{N}_@.\/-])(?:https?:\/\/|www\.|t\.me\/)[\p{L}\p{N}]\S*/giu;

/**
 * Что стоит вокруг ссылок, не будучи словами: пробелы, переносы строк, невидимые знаки и разделяющая пунктуация (запятая,
 * точка, двоеточие, скобки, кавычки, тире, маркер списка). «?» и «!» — не разделители: «https://… ?» — уже вопрос
 * владельца.
 */
const AROUND_LINKS_RE = /^[\s\u200B-\u200D\u2060\uFEFF,.;:|\/\\()[\]{}<>«»"'`“”„‘’•·*–—‐‑‒―…-]*$/u;

/**
 * Сколько ссылок в тексте, если кроме них в нём ничего нет (шапка файла); ссылок нет или рядом есть что-то ещё — 0.
 * Тот же ответ — и при приёме, и по строке базы: смотрит только текст.
 */
export function linksOnly(text: string | null | undefined): number {
  if (!text) return 0;
  const links = text.match(LINK_RE);
  if (!links) return 0;
  return AROUND_LINKS_RE.test(text.replace(LINK_RE, ' ')) ? links.length : 0;
}

/**
 * Есть ли в сообщении собственные слова владельца: его метка и текст или подпись (не из одних ссылок — linksOnly),
 * голосовое, свой кружок или аудиофайл (вложение с меткой owner — только свой звук, trust.ts).
 */
export function hasOwnerWords(x: Pick<MaterialInput, 'kind' | 'trust' | 'text' | 'attachments'>): boolean {
  if (x.trust !== 'owner') return false;
  if (x.kind === 'voice') return true;
  if (x.text !== null && x.text.trim() !== '' && linksOnly(x.text) === 0) return true;
  return x.attachments.some((a) => a.kind === 'document' && a.trust === 'owner');
}

/** Слова владельца, материал без слов или ни то ни другое (шапка файла). */
export function materialClass(x: MaterialInput): MaterialClass {
  if (!x.fromOwner) return null;
  if (!(MATERIAL_KINDS as readonly string[]).includes(x.kind)) return null;
  if (hasOwnerWords(x)) return 'words';
  if (x.forwarded) return 'material';
  if (x.attachments.some((a) => a.kind === 'via_bot')) return 'material';
  if (x.kind === 'photo') return 'material';
  // Текст владельца из одних ссылок — поделился страницей (шапка файла).
  if (x.kind === 'text') return x.trust === 'owner' && linksOnly(x.text) > 0 ? 'material' : null;
  if (x.kind === 'document') {
    const doc = x.attachments.find((a) => a.kind === 'document');
    const type = typeof doc?.ref.type === 'string' ? doc.ref.type : null;
    return type !== null && GESTURES.has(type) ? null : 'material';
  }
  return null;
}
