// Эпизоды — сервис шлюза (TECH-SPEC 5.7; Ш-12, Ш-13, Ш-25; AD-8). Сессия — на пару «чат × субъект», открытый эпизод
// у пары один. Здесь — данные и правила; объявления, кнопки и строки владельцу — control.ts.
//
// - Эпизод открывается первым событием, если открытого нет; тема — «Новая тема», роль и пространство — из правил.
// - Закрытие: тишина episode_idle_minutes по message.date ⟨предл. принято⟩ — при следующем событии и по таймеру раз в
//   минуту (idle); другая тема Telegram (telegram_topic; тема — только при is_topic_message, иначе основной поток);
//   «новая тема» (owner_new_topic), агент объявил новую (agent_new), [не то] (owner_rejected) — control.ts.
// - Закрытие кладёт в очередь событие episode_closed с № (итог присылает агент). Эпизод без единого сообщения
//   (открыт «новой темой» или агентом, а владелец не писал) закрывается без episode_closed: итога у пустого нет.
// - Открытый снова ([не то]) — тот же эпизод (closed_at снят), агенту — событие episode_reopened с №.
// - Итог эпизода, где было хоть одно событие untrusted или owner_forward, — summary_trust = untrusted кодом (Ш-25);
//   смешанное (к словам владельца приложено чужое) — тоже: итог мог быть сделан по чужому.

import { sql, MESSAGE_EVENT_KINDS, NEW_TOPIC, transaction, type ChatRule, type EpisodeCloseReason, type EpisodeOpenedBy } from 'stg-core';
import type { Ctx } from './context.js';

export { NEW_TOPIC };

const MSG_KINDS_SQL = MESSAGE_EVENT_KINDS.map((k) => `'${k}'`).join(',');

export interface EpisodeRow {
  id: number;
  chat_id: number;
  subject_id: string | null;
  topic: string;
  role: string;
  space: string | null;
  opened_by: EpisodeOpenedBy;
  opened_at: number;
  last_activity_at: number;
  closed_at: number | null;
  close_reason: EpisodeCloseReason | null;
  summary: string | null;
  summary_trust: 'owner' | 'untrusted' | null;
  prev_episode_id: number | null;
  thread_id: number | null;
}

export interface Assigned {
  episode: EpisodeRow;
  /** Эпизод открыт этим событием. */
  opened: boolean;
  /** № события episode_closed, если по пути закрылся прежний эпизод (null — не закрылся или был пуст). */
  closedEventSeq: number | null;
}

export interface OpenSpec {
  chatId: number;
  subjectId: string | null;
  topic: string;
  role: string;
  space: string | null;
  openedBy: EpisodeOpenedBy;
  threadId: number | null;
  /** Время последней активности (для тишины): дата сообщения или время действия. */
  activityAt: number;
  prevId: number | null;
}

export class Episodes {
  constructor(private readonly ctx: Ctx) {}

  get idleMs(): number {
    return this.ctx.config.episode_idle_minutes * 60_000;
  }

  openFor(chatId: number, subjectId: string | null): EpisodeRow | null {
    return (
      (sql(this.ctx.db, "SELECT * FROM episodes WHERE chat_id = ? AND COALESCE(subject_id, '') = COALESCE(?, '') AND closed_at IS NULL")
        .get(chatId, subjectId) as EpisodeRow | undefined) ?? null
    );
  }

  get(id: number): EpisodeRow | null {
    return (sql(this.ctx.db, 'SELECT * FROM episodes WHERE id = ?').get(id) as EpisodeRow | undefined) ?? null;
  }

  lastClosed(chatId: number, subjectId: string | null): EpisodeRow | null {
    return (
      (sql(this.ctx.db, "SELECT * FROM episodes WHERE chat_id = ? AND COALESCE(subject_id, '') = COALESCE(?, '') AND closed_at IS NOT NULL ORDER BY closed_at DESC, id DESC LIMIT 1")
        .get(chatId, subjectId) as EpisodeRow | undefined) ?? null
    );
  }

  /** Закрытые эпизоды пары, у которых была активность после `since`, — свежие первыми (для выбора после [не то]). */
  recentClosed(chatId: number, subjectId: string | null, since: number, exclude: readonly number[], limit: number): EpisodeRow[] {
    const rows = sql(this.ctx.db,
      `SELECT * FROM episodes WHERE chat_id = ? AND COALESCE(subject_id, '') = COALESCE(?, '') AND closed_at IS NOT NULL
       AND max(closed_at, last_activity_at) >= ? ORDER BY closed_at DESC, id DESC LIMIT ?`,
    ).all(chatId, subjectId, since, limit + exclude.length) as unknown as EpisodeRow[];
    return rows.filter((r) => !exclude.includes(r.id)).slice(0, limit);
  }

  /** Внутри транзакции приёма: эпизод для нового сообщения (по дате сообщения и теме Telegram). */
  forMessage(chatId: number, subjectId: string | null, rule: ChatRule, messageDate: number, threadId: number | null): Assigned {
    let cur = this.openFor(chatId, subjectId);
    let closedEventSeq: number | null = null;
    let openedBy: EpisodeOpenedBy | null = null;
    if (cur && messageDate - cur.last_activity_at > this.idleMs) {
      closedEventSeq = this.close(cur, 'idle');
      cur = null;
      openedBy = 'idle';
    } else if (cur && (cur.thread_id ?? null) !== threadId) {
      // Другая тема Telegram (или из темы — в основной поток): новый эпизод.
      closedEventSeq = this.close(cur, 'telegram_topic');
      cur = null;
      openedBy = 'telegram_topic';
    }
    if (cur) {
      this.touch(cur, messageDate);
      return { episode: cur, opened: false, closedEventSeq };
    }
    const last = this.lastClosed(chatId, subjectId);
    if (openedBy === null) {
      // Прежний закрыт тишиной (таймером) или отклонён владельцем без замены — это и открывает новый.
      openedBy = last?.close_reason === 'idle' ? 'idle' : last?.close_reason === 'owner_rejected' ? 'owner_rejected' : 'first_event';
    }
    const episode = this.open({
      chatId,
      subjectId,
      topic: NEW_TOPIC,
      role: rule.role,
      space: rule.space,
      openedBy,
      threadId,
      activityAt: messageDate,
      prevId: last?.id ?? null,
    });
    return { episode, opened: true, closedEventSeq };
  }

  /** Активность в эпизоде (дата сообщения): тишина считается от неё. */
  touch(ep: EpisodeRow, at: number): void {
    if (at > ep.last_activity_at) {
      sql(this.ctx.db, 'UPDATE episodes SET last_activity_at = ? WHERE id = ?').run(at, ep.id);
      ep.last_activity_at = at;
    }
  }

  /** Открыть эпизод. Внутри транзакции; открытого у пары быть не должно (уникальный индекс). */
  open(s: OpenSpec): EpisodeRow {
    const r = sql(this.ctx.db,
      `INSERT INTO episodes(chat_id, subject_id, topic, role, space, opened_by, opened_at, last_activity_at, prev_episode_id, thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.chatId, s.subjectId, s.topic, s.role, s.space, s.openedBy, this.ctx.clock.now(), s.activityAt, s.prevId, s.threadId);
    const episode = this.get(Number(r.lastInsertRowid))!;
    this.ctx.journal.write('episode_open', { episode: episode.id, opened_by: s.openedBy, chat_id: s.chatId, thread_id: s.threadId, topic: s.topic });
    return episode;
  }

  /** Были ли в эпизоде сообщения владельца (или других субъектов). */
  hasMessages(episodeId: number): boolean {
    return !!sql(this.ctx.db, `SELECT 1 FROM events WHERE episode_id = ? AND kind IN (${MSG_KINDS_SQL}) LIMIT 1`).get(episodeId);
  }

  /**
   * Закрыть эпизод (5.7). Внутри транзакции. Возвращает № события episode_closed; null — эпизод был пуст (итога нет) или
   * уже закрыт.
   */
  close(ep: EpisodeRow, reason: EpisodeCloseReason): number | null {
    const now = this.ctx.clock.now();
    const r = sql(this.ctx.db, 'UPDATE episodes SET closed_at = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL').run(now, reason, ep.id);
    if (!Number(r.changes)) return null;
    ep.closed_at = now;
    ep.close_reason = reason;
    let seq: number | null = null;
    if (this.hasMessages(ep.id)) {
      const ins = sql(this.ctx.db,
        `INSERT INTO events(chat_id, subject_id, kind, episode_id, status, created_at)
         VALUES (?, ?, 'episode_closed', ?, 'new', ?)`,
      ).run(ep.chat_id, ep.subject_id, ep.id, now);
      seq = Number(ins.lastInsertRowid);
    }
    this.ctx.journal.write('episode_close', { episode: ep.id, reason, seq, idle_ms: now - ep.last_activity_at, ...(seq === null ? { empty: true } : {}) });
    return seq;
  }

  /** Таймер раз в минуту: закрыть эпизоды, где тишина дольше срока. Возвращает № событий episode_closed. */
  closeIdle(now: number): number[] {
    const rows = sql(this.ctx.db, 'SELECT * FROM episodes WHERE closed_at IS NULL AND last_activity_at < ?')
      .all(now - this.idleMs) as unknown as EpisodeRow[];
    const seqs: number[] = [];
    for (const ep of rows) {
      const seq = transaction(this.ctx.db, () => this.close(ep, 'idle'));
      if (seq !== null) seqs.push(seq);
    }
    return seqs;
  }

  /** Переписать тему, не закрывая эпизод. Внутри транзакции. */
  rename(ep: EpisodeRow, topic: string): void {
    sql(this.ctx.db, 'UPDATE episodes SET topic = ? WHERE id = ?').run(topic, ep.id);
    ep.topic = topic;
  }

  /**
   * Открыть закрытый эпизод снова ([не то], 5.7): closed_at снят, тишина — от сейчас; агенту — episode_reopened с №.
   * Внутри транзакции; открытого у пары быть не должно.
   */
  reopen(ep: EpisodeRow): number {
    const now = this.ctx.clock.now();
    sql(this.ctx.db, 'UPDATE episodes SET closed_at = NULL, close_reason = NULL, last_activity_at = max(last_activity_at, ?) WHERE id = ?').run(now, ep.id);
    ep.closed_at = null;
    ep.close_reason = null;
    ep.last_activity_at = Math.max(ep.last_activity_at, now);
    return this.reopenedEvent(ep);
  }

  /** Событие episode_reopened в общую очередь (и для возврата прежней темы — эпизод тот же). */
  reopenedEvent(ep: EpisodeRow): number {
    const r = sql(this.ctx.db,
      `INSERT INTO events(chat_id, subject_id, kind, episode_id, status, created_at)
       VALUES (?, ?, 'episode_reopened', ?, 'new', ?)`,
    ).run(ep.chat_id, ep.subject_id, ep.id, this.ctx.clock.now());
    const seq = Number(r.lastInsertRowid);
    this.ctx.journal.write('episode_reopen', { episode: ep.id, seq, topic: ep.topic });
    return seq;
  }

  /** Было ли в эпизоде чужое (Ш-25): событие untrusted или owner_forward, или к словам владельца приложено чужое. */
  hadForeign(episodeId: number): boolean {
    return !!sql(this.ctx.db,
      `SELECT 1 FROM events WHERE episode_id = ? AND kind IN (${MSG_KINDS_SQL})
       AND (trust IN ('untrusted', 'owner_forward') OR mixed = 1) LIMIT 1`,
    ).get(episodeId);
  }

  /** Итог эпизода от агента: метка — кодом (Ш-25). Внутри транзакции. */
  saveSummary(ep: EpisodeRow, text: string): 'owner' | 'untrusted' {
    const trust = this.hadForeign(ep.id) ? 'untrusted' : 'owner';
    sql(this.ctx.db, 'UPDATE episodes SET summary = ?, summary_trust = ? WHERE id = ?').run(text, trust, ep.id);
    return trust;
  }
}
