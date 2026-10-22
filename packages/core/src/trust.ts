// Метки доверия (TECH-SPEC 5.4; Ш-4, Ш-20; AD-7). Чистая функция: сообщение Telegram → метка собственных слов
// владельца, признак «к ним приложено чужое» и список приложенного. Решает код, а не модель: чужое не выдаётся за
// слово владельца.
//
// «Слово владельца» (Ш-20) — новое сообщение в личке с его номера, без пересылки, ответа из другого чата, цитаты
// и инлайн-бота. Файлы и снимки экрана — «чужое», даже от владельца. Исключение — свой звук файлом: аудиофайл владельца
// без пересылки — его слово, как голосовое (R-2); так же свой видео-кружок (R-20); пересланный или от другого
// участника — «чужое», как раньше.

import type { Message, MessageOrigin, PhotoSize } from '@grammyjs/types';
import { isAudioDocumentRef } from './audio.js';
import type { TrustLabel } from './schema.js';

/** Виды приложенного (events.attachments_json). */
export const ATTACHMENT_KINDS = ['quote', 'external_reply', 'via_bot', 'photo', 'document', 'voice'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export interface Attachment {
  kind: AttachmentKind;
  trust: TrustLabel;
  /** Ссылка на содержимое: file_id, имя, источник, текст цитаты. Содержимое файлов здесь не хранится. */
  ref: Record<string, unknown>;
}

export const FORWARD_ORIGIN_TYPES = ['user', 'hidden_user', 'chat', 'channel'] as const;
export type ForwardOriginType = (typeof FORWARD_ORIGIN_TYPES)[number];

export interface ForwardInfo {
  origin_type: ForwardOriginType;
  /** Имя автора или название чата/канала; null — не указано. */
  from_name: string | null;
  /** Дата исходного сообщения, мс. */
  date: number;
  from_id: number | null;
  chat_id: number | null;
  message_id: number | null;
}

/** Вид содержимого события. */
export type ContentKind = 'text' | 'voice' | 'photo' | 'document';

export interface VoiceInfo {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type: string | null;
}

export interface Labeled {
  kind: ContentKind;
  /** Метка собственных слов отправителя в этом сообщении (events.trust). */
  trust: TrustLabel;
  /** К словам владельца приложено чужое (events.mixed). */
  mixed: boolean;
  /** Текст или подпись. */
  text: string | null;
  attachments: Attachment[];
  forward: ForwardInfo | null;
  voice: VoiceInfo | null;
  /** Вид носителя для квитанции: фото, файл, стикер… (null — текст или голос). */
  mediaType: string | null;
  /**
   * Чистые слова владельца: от владельца, без пересылки, цитаты, external_reply, инлайн-бота и файлов. Только
   * такое сообщение может быть командой (5.6).
   */
  plainOwnerText: boolean;
  /** Номер сообщения, на которое это — реплай в этом же чате (5.5а). */
  replyToMessageId: number | null;
}

type AnyMsg = Message & Record<string, unknown>;

function originName(o: MessageOrigin): string | null {
  switch (o.type) {
    case 'user':
      return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ') || null;
    case 'hidden_user':
      return o.sender_user_name || null;
    case 'chat':
      return ('title' in o.sender_chat && typeof o.sender_chat.title === 'string' ? o.sender_chat.title : null) ?? null;
    case 'channel':
      return ('title' in o.chat && typeof o.chat.title === 'string' ? o.chat.title : null) ?? null;
    default:
      return null;
  }
}

export function forwardInfo(o: MessageOrigin): ForwardInfo {
  const base = { from_name: originName(o), date: o.date * 1000, from_id: null, chat_id: null, message_id: null };
  switch (o.type) {
    case 'user':
      return { ...base, origin_type: 'user', from_id: o.sender_user.id };
    case 'hidden_user':
      return { ...base, origin_type: 'hidden_user' };
    case 'chat':
      return { ...base, origin_type: 'chat', chat_id: o.sender_chat.id };
    case 'channel':
      return { ...base, origin_type: 'channel', chat_id: o.chat.id, message_id: o.message_id };
    default:
      return { ...base, origin_type: 'hidden_user' };
  }
}

/** Носители, которые идут как «файл» (kind document). */
const DOCUMENT_LIKE = ['document', 'video', 'animation', 'audio', 'video_note', 'sticker', 'location', 'venue', 'contact', 'poll', 'dice', 'story', 'game', 'paid_media', 'checklist'] as const;

interface Media {
  kind: ContentKind;
  attachment: Attachment | null;
  voice: VoiceInfo | null;
  mediaType: string | null;
}

/** Размер фото или обложка файла — ссылка для скачивания (media, 0.3): без содержимого. */
function photoSizeRef(p: PhotoSize): Record<string, unknown> {
  return {
    file_id: p.file_id,
    file_unique_id: p.file_unique_id,
    width: p.width,
    height: p.height,
    ...(typeof p.file_size === 'number' ? { file_size: p.file_size } : {}),
  };
}

/**
 * Свой звук файлом: аудиофайл (`audio`, или `document` с `audio/*` или расширением аудио; R-2) и видео-кружок
 * (`video_note`; R-20). Без пересылки и инлайн-бота — метка как у голосового (слово владельца, если от него); видео
 * (`video`) — нет: снято может быть что угодно ⟨предл.: решения о видео нет⟩.
 */
export function isOwnSoundRef(ref: Record<string, unknown>): boolean {
  const t = ref.type;
  return t === 'audio' || t === 'video_note' || (t === 'document' && isAudioDocumentRef(ref));
}

/**
 * Носитель сообщения. trust — метка голоса (голос владельца — его слово); тем же словом — свой звук файлом (аудиофайл —
 * R-2; кружок — R-20); фото, видео и прочие файлы — всегда чужое.
 */
function mediaOf(m: AnyMsg, trust: TrustLabel): Media {
  if (m.voice) {
    const v = m.voice;
    const voice: VoiceInfo = { file_id: v.file_id, file_unique_id: v.file_unique_id, duration: v.duration, mime_type: v.mime_type ?? null };
    return { kind: 'voice', voice, mediaType: null, attachment: { kind: 'voice', trust, ref: { file_id: v.file_id, duration: v.duration } } };
  }
  if (m.photo && m.photo.length) {
    const p = m.photo[m.photo.length - 1]!;
    return {
      kind: 'photo',
      voice: null,
      mediaType: 'photo',
      // Снимок экрана и фото — чужое даже от владельца (5.4): что на картинке, владелец не писал. Все размеры (sizes) —
      // для media(seq): агенту — размер с длинной стороной ближе к 1600 px (media.ts, 0.3).
      attachment: {
        kind: 'photo',
        trust: 'untrusted',
        ref: { file_id: p.file_id, file_unique_id: p.file_unique_id, width: p.width, height: p.height, sizes: m.photo.map(photoSizeRef) },
      },
    };
  }
  for (const t of DOCUMENT_LIKE) {
    const v = m[t] as Record<string, unknown> | undefined;
    if (v === undefined || v === null) continue;
    const ref: Record<string, unknown> = { type: t };
    // file_size, title, performer — для аудиофайлов (audio.ts): предел скачивания и имя в квитанции; width, height,
    // length (поперечник кружка) и thumbnail (обложка Telegram) — для media(seq) (media.ts, 0.3).
    for (const k of ['file_id', 'file_unique_id', 'file_name', 'mime_type', 'duration', 'file_size', 'title', 'performer', 'emoji', 'width', 'height', 'length']) {
      if (typeof v === 'object' && k in v) ref[k] = v[k];
    }
    const thumb = (v as { thumbnail?: PhotoSize }).thumbnail;
    if (thumb && typeof thumb === 'object' && typeof thumb.file_id === 'string') ref.thumbnail = photoSizeRef(thumb);
    const own = isOwnSoundRef(ref);
    return { kind: 'document', voice: null, mediaType: t, attachment: { kind: 'document', trust: own ? trust : 'untrusted', ref } };
  }
  return { kind: 'text', voice: null, mediaType: null, attachment: null };
}

export interface LabelOptions {
  /** Номер владельца из config.yaml; null — первая настройка. */
  ownerId: number | null;
  /** Отправитель — владелец (субъект owner). */
  fromOwner: boolean;
}

/**
 * Метка по таблице 5.4.
 *
 * - пересылка: `user` с номером владельца — `owner_forward`, иначе `untrusted`; всё содержимое пересылки — того же
 *   происхождения, `mixed = нет`;
 * - слова владельца с цитатой или ответом на сообщение другого чата — `owner`, приложенное `untrusted`, `mixed = да`;
 * - через инлайн-бота: текст написал не владелец, а бот по его выбору — `untrusted` (Ш-20: такое сообщение — не слово
 *   владельца), `mixed = нет`;
 * - файл, фото, снимок экрана, видео — содержимое `untrusted`, подпись владельца — `owner`, `mixed = да`;
 * - голос владельца — `owner`; свой аудиофайл (R-2) и свой кружок (R-20) — так же:
 *   вложение `owner`, `mixed = нет`; реплай в этом же чате (в том числе с цитатой из сообщения бота или своего) —
 *   `owner`, `mixed = нет`, ссылка — в replyToMessageId.
 */
export function labelMessage(msg: Message, opts: LabelOptions): Labeled {
  const m = msg as AnyMsg;
  const text = (typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : null) ?? null;
  const replyToMessageId = m.reply_to_message ? m.reply_to_message.message_id : null;
  const attachments: Attachment[] = [];

  if (m.forward_origin) {
    const forward = forwardInfo(m.forward_origin);
    const trust: TrustLabel =
      opts.fromOwner && forward.origin_type === 'user' && opts.ownerId !== null && forward.from_id === opts.ownerId
        ? 'owner_forward'
        : 'untrusted';
    const media = mediaOf(m, trust);
    // Пересылка целиком одного происхождения: и файлы в ней — с меткой пересылки.
    if (media.attachment) attachments.push({ ...media.attachment, trust });
    return {
      kind: media.kind,
      trust,
      mixed: false,
      text,
      attachments,
      forward,
      voice: media.voice,
      mediaType: media.mediaType,
      plainOwnerText: false,
      replyToMessageId,
    };
  }

  // Через инлайн-бота (5.4 по Ш-20): текст составил бот, а не владелец — чужое целиком, слов владельца в сообщении нет
  // (mixed = нет); голос и подпись — тоже чужие. Вложение via_bot говорит агенту, через какого бота.
  const base: TrustLabel = opts.fromOwner && !m.via_bot ? 'owner' : 'untrusted';
  const trust: TrustLabel = base;
  let foreign = false;

  if (m.via_bot) {
    attachments.push({ kind: 'via_bot', trust: 'untrusted', ref: { bot_id: m.via_bot.id, username: m.via_bot.username ?? null } });
    foreign = true;
  }
  if (m.external_reply) {
    const o = forwardInfo(m.external_reply.origin);
    attachments.push({
      kind: 'external_reply',
      trust: 'untrusted',
      ref: { origin_type: o.origin_type, from_name: o.from_name, chat_id: m.external_reply.chat?.id ?? o.chat_id, message_id: m.external_reply.message_id ?? o.message_id },
    });
    foreign = true;
  }
  // Цитата: из сообщения другого чата — чужое; из сообщения этого чата (бота или своего) — часть реплая (5.5а),
  // её текст не вкладывается: в квитанции бывает начало чужого.
  if (m.quote && !m.reply_to_message) {
    attachments.push({ kind: 'quote', trust: 'untrusted', ref: { text: m.quote.text } });
    foreign = true;
  }
  const media = mediaOf(m, base);
  if (media.attachment) {
    attachments.push(media.attachment);
    // Голос, свой аудиофайл и свой кружок владельца — его слово (метка base); фото, видео и прочие файлы — чужое.
    if (media.attachment.trust !== 'owner') foreign = true;
  }
  const mixed = trust === 'owner' && foreign;
  const plainOwnerText =
    opts.fromOwner && trust === 'owner' && !mixed && media.kind === 'text' && !m.quote && !m.external_reply && !m.via_bot && text !== null;
  return {
    kind: media.kind,
    trust,
    mixed,
    text,
    attachments,
    forward: null,
    voice: media.voice,
    mediaType: media.mediaType,
    plainOwnerText,
    replyToMessageId,
  };
}

/** Есть ли в событии чужое — для метки итога эпизода (Ш-25). */
export function hasForeign(trust: TrustLabel | null, attachments: readonly Attachment[]): boolean {
  return trust === 'untrusted' || trust === 'owner_forward' || attachments.some((a) => a.trust !== 'owner');
}
