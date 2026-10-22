// Построители обновлений для всех форм TECH-SPEC 5.4, правок и нажатий (ACCEPTANCE §1).
// Номера: update_id — сквозной; message_id — по чату, общий с сообщениями бота (номера в личке общие).

import type {
  CallbackQuery,
  Chat,
  Message,
  MessageEntity,
  MessageOrigin,
  PhotoSize,
  ReactionType,
  Update,
  User,
} from '@grammyjs/types';

export interface IdSource {
  nextUpdateId(): number;
  nextMessageId(chatId: number): number;
  /** Секунды Unix для message.date. */
  nowSeconds(): number;
  newFileId(kind: string): string;
  newCallbackId(): string;
}

export function user(id: number, firstName: string, opts: { lastName?: string; username?: string } = {}): User {
  return {
    id,
    is_bot: false,
    first_name: firstName,
    ...(opts.lastName ? { last_name: opts.lastName } : {}),
    ...(opts.username ? { username: opts.username } : {}),
    language_code: 'ru',
  };
}

export function privateChatOf(u: User): Chat.PrivateChat {
  return { id: u.id, type: 'private', first_name: u.first_name, ...(u.username ? { username: u.username } : {}) };
}

export interface ChannelInfo {
  id: number;
  title: string;
  username?: string;
}

export interface MessageOpts {
  /** Номер сообщения; по умолчанию — следующий в чате. */
  messageId?: number;
  /** Секунды Unix. */
  date?: number;
  /** Тема: message_thread_id и признак is_topic_message. */
  thread?: { id: number; isTopic: boolean };
  /** Чат; по умолчанию — личка отправителя. */
  chat?: Chat;
}

type AnyMessage = Message & Update.NonChannel;

export class UpdateBuilder {
  constructor(private readonly ids: IdSource) {}

  private base(from: User, opts: MessageOpts): AnyMessage {
    const chat = opts.chat ?? privateChatOf(from);
    const msg = {
      message_id: opts.messageId ?? this.ids.nextMessageId(chat.id),
      from,
      chat,
      date: opts.date ?? this.ids.nowSeconds(),
      ...(opts.thread ? { message_thread_id: opts.thread.id, ...(opts.thread.isTopic ? { is_topic_message: true } : {}) } : {}),
    };
    return msg as unknown as AnyMessage;
  }

  private wrap(message: AnyMessage): Update {
    return { update_id: this.ids.nextUpdateId(), message };
  }

  /** Обычный текст владельца (или любого) в личке. */
  text(from: User, text: string, opts: MessageOpts = {}): Update {
    return this.wrap({ ...this.base(from, opts), text } as AnyMessage);
  }

  /** Команда со сущностью bot_command: `/stop`. */
  command(from: User, text: string, opts: MessageOpts = {}): Update {
    const cmdLen = (/^\/\S+/.exec(text)?.[0] ?? text).length;
    const entities: MessageEntity[] = [{ type: 'bot_command', offset: 0, length: cmdLen }];
    return this.wrap({ ...this.base(from, opts), text, entities } as AnyMessage);
  }

  voiceMessage(from: User, voice: { duration: number; fileId?: string; caption?: string }, opts: MessageOpts = {}): AnyMessage {
    const file_id = voice.fileId ?? this.ids.newFileId('voice');
    return {
      ...this.base(from, opts),
      voice: { file_id, file_unique_id: `u${file_id}`, duration: voice.duration, mime_type: 'audio/ogg', file_size: 1000 },
      ...(voice.caption ? { caption: voice.caption } : {}),
    } as AnyMessage;
  }

  /** Голосовое. */
  voice(from: User, voice: { duration: number; fileId?: string; caption?: string }, opts: MessageOpts = {}): Update {
    return this.wrap(this.voiceMessage(from, voice, opts));
  }

  private origin(o: OriginSpec, date: number): MessageOrigin {
    switch (o.type) {
      case 'user':
        return { type: 'user', date, sender_user: o.user };
      case 'hidden_user':
        return { type: 'hidden_user', date, sender_user_name: o.name };
      case 'chat':
        return { type: 'chat', date, sender_chat: { id: o.chat.id, type: 'group', title: o.chat.title } as Chat.GroupChat };
      case 'channel':
        return {
          type: 'channel',
          date,
          chat: { id: o.chat.id, type: 'channel', title: o.chat.title, ...(o.chat.username ? { username: o.chat.username } : {}) },
          message_id: o.messageId ?? 1,
        };
    }
  }

  /** Пересылка: от другого user, своя (sender_user = владелец), hidden_user, из канала, из чата. */
  forward(from: User, origin: OriginSpec, text: string, opts: MessageOpts = {}): Update {
    const date = (opts.date ?? this.ids.nowSeconds()) - 3600;
    return this.wrap({ ...this.base(from, opts), text, forward_origin: this.origin(origin, date) } as AnyMessage);
  }

  /** Пересланное голосовое. */
  forwardVoice(from: User, origin: OriginSpec, voice: { duration: number; fileId?: string }, opts: MessageOpts = {}): Update {
    const msg = this.voiceMessage(from, voice, opts);
    return this.wrap({ ...msg, forward_origin: this.origin(origin, msg.date - 3600) } as AnyMessage);
  }

  /** Ответ на сообщение из другого чата (external_reply); можно с цитатой. */
  externalReply(from: User, text: string, ext: { origin: OriginSpec; quote?: string }, opts: MessageOpts = {}): Update {
    const date = (opts.date ?? this.ids.nowSeconds()) - 3600;
    return this.wrap({
      ...this.base(from, opts),
      text,
      external_reply: { origin: this.origin(ext.origin, date) },
      ...(ext.quote ? { quote: { text: ext.quote, position: 0, is_manual: true } } : {}),
    } as AnyMessage);
  }

  /** Сообщение с цитатой (quote) из сообщения другого чата. */
  quoteExternal(from: User, text: string, quote: string, origin: OriginSpec, opts: MessageOpts = {}): Update {
    return this.externalReply(from, text, { origin, quote }, opts);
  }

  /** Стикер (0.3.6: жест — не слова владельца и не материал, окна материала не трогает). */
  sticker(from: User, emoji = '👍', opts: MessageOpts = {}): Update {
    const id = this.ids.newFileId('sticker');
    return this.wrap({
      ...this.base(from, opts),
      sticker: { file_id: id, file_unique_id: `u${id}`, type: 'regular', width: 512, height: 512, is_animated: false, is_video: false, emoji },
    } as AnyMessage);
  }

  /** Через инлайн-бота. */
  viaBot(from: User, text: string, bot: User, opts: MessageOpts = {}): Update {
    return this.wrap({ ...this.base(from, opts), text, via_bot: { ...bot, is_bot: true } } as AnyMessage);
  }

  /**
   * Фото (снимок экрана) с подписью. sizes — свои размеры (0.3: выбор размера для media); по умолчанию — два, 90×160 и
   * 720×1280. forwardFrom — пересланное фото.
   */
  photo(from: User, caption: string | null, opts: MessageOpts & { sizes?: SizeSpec[]; forwardFrom?: OriginSpec } = {}): Update {
    const id = this.ids.newFileId('photo');
    const sizes: PhotoSize[] = opts.sizes
      ? opts.sizes.map((x) => photoSize(x))
      : [
          { file_id: `${id}_s`, file_unique_id: `u${id}_s`, width: 90, height: 160, file_size: 1500 },
          { file_id: id, file_unique_id: `u${id}`, width: 720, height: 1280, file_size: 90_000 },
        ];
    const msg = { ...this.base(from, opts), photo: sizes, ...(caption !== null ? { caption } : {}) } as AnyMessage;
    if (opts.forwardFrom) return this.wrap({ ...msg, forward_origin: this.origin(opts.forwardFrom, msg.date - 3600) } as AnyMessage);
    return this.wrap(msg);
  }

  /** Документ с подписью. fileSize: null — размера в метаданных нет. thumbnail — обложка Telegram (0.3). */
  document(
    from: User,
    file: { fileName?: string; mimeType?: string; fileId?: string; fileSize?: number | null; thumbnail?: SizeSpec },
    caption: string | null,
    opts: MessageOpts & { forwardFrom?: OriginSpec } = {},
  ): Update {
    const id = file.fileId ?? this.ids.newFileId('doc');
    const msg = {
      ...this.base(from, opts),
      document: {
        file_id: id,
        file_unique_id: `u${id}`,
        ...(file.fileName !== undefined ? { file_name: file.fileName } : {}),
        mime_type: file.mimeType ?? 'application/pdf',
        ...(file.fileSize === null ? {} : { file_size: file.fileSize ?? 2000 }),
        ...(file.thumbnail ? { thumbnail: photoSize(file.thumbnail) } : {}),
      },
      ...(caption !== null ? { caption } : {}),
    } as AnyMessage;
    if (opts.forwardFrom) return this.wrap({ ...msg, forward_origin: this.origin(opts.forwardFrom, msg.date - 3600) } as AnyMessage);
    return this.wrap(msg);
  }

  /** Видео-кружок (message.video_note, 0.3): mp4, поперечник length, обложка thumbnail; подписи у кружка не бывает. */
  videoNote(
    from: User,
    note: { fileId?: string; duration: number; length?: number; fileSize?: number; thumbnail?: SizeSpec | null },
    opts: MessageOpts & { forwardFrom?: OriginSpec } = {},
  ): Update {
    const id = note.fileId ?? this.ids.newFileId('vnote');
    const msg = {
      ...this.base(from, opts),
      video_note: {
        file_id: id,
        file_unique_id: `u${id}`,
        length: note.length ?? 384,
        duration: note.duration,
        file_size: note.fileSize ?? 300_000,
        ...(note.thumbnail ? { thumbnail: photoSize(note.thumbnail) } : {}),
      },
    } as AnyMessage;
    if (opts.forwardFrom) return this.wrap({ ...msg, forward_origin: this.origin(opts.forwardFrom, msg.date - 3600) } as AnyMessage);
    return this.wrap(msg);
  }

  /** Видео (message.video, 0.3). mimeType: null — mime в метаданных нет (Bot API: поле необязательное). */
  video(
    from: User,
    v: { fileId?: string; duration: number; width?: number; height?: number; mimeType?: string | null; fileName?: string; fileSize?: number; thumbnail?: SizeSpec | null },
    caption: string | null = null,
    opts: MessageOpts & { forwardFrom?: OriginSpec } = {},
  ): Update {
    const id = v.fileId ?? this.ids.newFileId('video');
    const msg = {
      ...this.base(from, opts),
      video: {
        file_id: id,
        file_unique_id: `u${id}`,
        width: v.width ?? 720,
        height: v.height ?? 1280,
        duration: v.duration,
        ...(v.mimeType === null ? {} : { mime_type: v.mimeType ?? 'video/mp4' }),
        ...(v.fileName !== undefined ? { file_name: v.fileName } : {}),
        file_size: v.fileSize ?? 2_000_000,
        ...(v.thumbnail ? { thumbnail: photoSize(v.thumbnail) } : {}),
      },
      ...(caption !== null ? { caption } : {}),
    } as AnyMessage;
    if (opts.forwardFrom) return this.wrap({ ...msg, forward_origin: this.origin(opts.forwardFrom, msg.date - 3600) } as AnyMessage);
    return this.wrap(msg);
  }

  /** Аудиофайл (message.audio): длительность и размер — из метаданных Telegram. */
  audio(
    from: User,
    file: { fileId?: string; fileName?: string; mimeType?: string; duration: number; fileSize?: number; title?: string; performer?: string },
    caption: string | null = null,
    opts: MessageOpts & { forwardFrom?: OriginSpec } = {},
  ): Update {
    const id = file.fileId ?? this.ids.newFileId('audio');
    const msg = {
      ...this.base(from, opts),
      audio: {
        file_id: id,
        file_unique_id: `u${id}`,
        duration: file.duration,
        ...(file.fileName !== undefined ? { file_name: file.fileName } : {}),
        mime_type: file.mimeType ?? 'audio/mpeg',
        file_size: file.fileSize ?? 50_000,
        ...(file.title ? { title: file.title } : {}),
        ...(file.performer ? { performer: file.performer } : {}),
      },
      ...(caption !== null ? { caption } : {}),
    } as AnyMessage;
    if (opts.forwardFrom) return this.wrap({ ...msg, forward_origin: this.origin(opts.forwardFrom, msg.date - 3600) } as AnyMessage);
    return this.wrap(msg);
  }

  /** Реплай в этом же чате на сообщение (бота или своё); можно с цитатой из него. */
  replyTo(from: User, text: string, replied: Message, opts: MessageOpts & { quote?: string } = {}): Update {
    const repliedCopy = { ...replied } as Record<string, unknown>;
    delete repliedCopy.reply_to_message;
    return this.wrap({
      ...this.base(from, { chat: replied.chat, ...opts }),
      text,
      reply_to_message: repliedCopy,
      ...(opts.quote ? { quote: { text: opts.quote, position: 0, is_manual: true } } : {}),
    } as unknown as AnyMessage);
  }

  /** Правка: тот же message_id и чат, новый текст, edit_date. */
  edited(original: Update, newText: string, editDate?: number): Update {
    const msg = original.message ?? original.edited_message;
    if (!msg) throw new Error('edited: в обновлении нет сообщения');
    const { text: _old, caption: _oldCaption, ...rest } = msg as AnyMessage & { caption?: string };
    const body = 'voice' in msg || 'photo' in msg || 'document' in msg ? { caption: newText } : { text: newText };
    return {
      update_id: this.ids.nextUpdateId(),
      edited_message: { ...rest, ...body, edit_date: editDate ?? this.ids.nowSeconds() } as Message & Update.Edited & Update.NonChannel,
    };
  }

  /**
   * Реакция на сообщение (message_reaction, Bot API 7.0; 0.3.4): кто поменял (null — анонимно, от имени чата actorChat),
   * в каком чате и на каком сообщении, что стоит теперь и что стояло. Строка — эмодзи; иначе — ReactionType как есть
   * (свой эмодзи, платная).
   */
  reaction(
    from: User | null,
    chat: Chat,
    messageId: number,
    now: Array<string | ReactionType>,
    old: Array<string | ReactionType> = [],
    opts: { actorChat?: Chat } = {},
  ): Update {
    const r = (x: string | ReactionType): ReactionType => (typeof x === 'string' ? ({ type: 'emoji', emoji: x } as ReactionType) : x);
    return {
      update_id: this.ids.nextUpdateId(),
      message_reaction: {
        chat,
        message_id: messageId,
        ...(from ? { user: from } : {}),
        ...(opts.actorChat ? { actor_chat: opts.actorChat } : {}),
        date: this.ids.nowSeconds(),
        old_reaction: old.map(r),
        new_reaction: now.map(r),
      },
    };
  }

  /** Нажатие встроенной кнопки; message — сообщение бота с кнопкой. */
  callback(from: User, data: string, message?: Message): Update {
    const cq: CallbackQuery = {
      id: this.ids.newCallbackId(),
      from,
      chat_instance: `ci${from.id}`,
      data,
      ...(message ? { message: message as CallbackQuery['message'] & object } : {}),
    } as CallbackQuery;
    return { update_id: this.ids.nextUpdateId(), callback_query: cq };
  }
}

/** Размер фото или обложка: file_id, ширина, высота, размер файла (null — нет в метаданных). */
export interface SizeSpec {
  fileId: string;
  width: number;
  height: number;
  fileSize?: number | null;
}

function photoSize(x: SizeSpec): PhotoSize {
  return {
    file_id: x.fileId,
    file_unique_id: `u${x.fileId}`,
    width: x.width,
    height: x.height,
    ...(x.fileSize === null ? {} : { file_size: x.fileSize ?? 50_000 }),
  };
}

export type OriginSpec =
  | { type: 'user'; user: User }
  | { type: 'hidden_user'; name: string }
  | { type: 'chat'; chat: { id: number; title: string } }
  | { type: 'channel'; chat: ChannelInfo; messageId?: number };

/** Вид обновления — для allowed_updates. */
export function updateType(u: Update): string {
  for (const k of Object.keys(u)) if (k !== 'update_id') return k;
  return 'unknown';
}
