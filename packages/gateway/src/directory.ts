// Кто и где (TECH-SPEC 5.3, шаг 0; Ш-3; AD-6, AD-9) — решается в памяти, без записи: номер отправителя ставит
// Telegram, шлюз сверяет его со справочником участников (записи о транспорте) и правилами чатов.

import type { Chat, ChatRule, Config, Rules, SubjectRule } from 'stg-core';

export interface Resolved {
  subject: SubjectRule;
  isOwner: boolean;
  chatRule: ChatRule;
}

export class Directory {
  private readonly byAddress = new Map<string, SubjectRule>();

  constructor(
    readonly config: Config,
    readonly rules: Rules,
  ) {
    for (const s of rules.subjects) {
      for (const t of s.transports) this.byAddress.set(`${t.network}:${t.address}`, s);
    }
  }

  /** Первая настройка: владельца нет — незнакомы все. */
  get firstSetup(): boolean {
    return this.config.owner_id === null;
  }

  get ownerId(): number | null {
    return this.config.owner_id;
  }

  /** Субъект по номеру Telegram и правило чата; null — незнакомый или чат не из правил. */
  resolve(fromId: number | null | undefined, chat: Chat | null | undefined): Resolved | null {
    if (this.firstSetup || fromId === null || fromId === undefined || !chat) return null;
    const subject = this.byAddress.get(`telegram:${fromId}`);
    if (!subject) return null;
    let chatRule: ChatRule | undefined;
    if (chat.type === 'private') {
      // Личка — только своя: чат с номером отправителя.
      if (chat.id !== fromId) return null;
      chatRule = this.rules.chats.find((c) => c.chat === 'private') ?? this.rules.chats.find((c) => c.chat === chat.id);
    } else {
      chatRule = this.rules.chats.find((c) => c.chat === chat.id);
    }
    if (!chatRule) return null;
    return { subject, isOwner: subject.who === 'owner', chatRule };
  }

  /** Правило лички владельца — для служебных строк вне события. */
  ownerChatRule(): ChatRule | null {
    return this.rules.chats.find((c) => c.chat === 'private') ?? null;
  }

  ownerSubjectId(): string | null {
    return this.rules.subjects.find((s) => s.who === 'owner')?.id ?? null;
  }
}
