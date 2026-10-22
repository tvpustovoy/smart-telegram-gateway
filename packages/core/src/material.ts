// Материал без слов владельца (0.3.6; GitHub issue #51; TECH-SPEC 5.18). Чистые функции: что в сообщении владельца —
// его слова, материал без слов или ни то ни другое. По этому решению шлюз держит материал окном
// ui.material_hold_seconds (gateway/src/material.ts): владелец часто присылает ссылку, пересылку или файл, а что с ними
// делать, говорит следом — агент должен получить материал вместе со словами, а не гадать над ним в одиночку.
//
// Слова владельца — новое сообщение владельца с его меткой (5.4: не пересылка, не инлайн-бот), в котором есть его
// собственные слова: текст (в том числе ссылка, которую он написал сам), подпись к фото или файлу, голосовое, свой кружок
// и свой аудиофайл (R-2, R-20). Голосовое и кружок — слова с момента прихода, до расшифровки.
// Материал — сообщение владельца, где его слов нет: пересылка (любая, и его собственного старого сообщения), сообщение
// через инлайн-бота, фото, файл, видео без подписи.
// Ни то ни другое: жесты (стикер, кубик, GIF) — отклик, а не материал; команды, правки, нажатия, реакции,
// сообщения других участников ⟨предл.⟩. Правку удерживаемого материала шлюз решает сам (gateway/src/material.ts): есть в
// ней слова владельца (hasOwnerWords — подпись) — слова, нет — ждёт вместе с исходным.

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
 * Есть ли в сообщении собственные слова владельца: его метка и текст или подпись, голосовое, свой кружок или аудиофайл
 * (вложение с меткой owner — только свой звук, trust.ts).
 */
export function hasOwnerWords(x: Pick<MaterialInput, 'kind' | 'trust' | 'text' | 'attachments'>): boolean {
  if (x.trust !== 'owner') return false;
  if (x.kind === 'voice') return true;
  if (x.text !== null && x.text.trim() !== '') return true;
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
  if (x.kind === 'document') {
    const doc = x.attachments.find((a) => a.kind === 'document');
    const type = typeof doc?.ref.type === 'string' ? doc.ref.type : null;
    return type !== null && GESTURES.has(type) ? null : 'material';
  }
  return null;
}
