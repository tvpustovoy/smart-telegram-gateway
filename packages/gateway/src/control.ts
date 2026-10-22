// Команды владельца, режимы и ход, кнопки, объявления эпизодов (TECH-SPEC 5.6, 5.7, 5.9, 5.10 «Ход»; Ш-6, Ш-12, Ш-13,
// Ш-19, Ш-22; Оч-4; AD-6, AD-8). Команды и нажатия исполняет код, мимо агента: команда и нажатие — события handled, их
// действие идёт в той же главной транзакции приёма, что и запись события (упал после COMMIT — команда уже исполнена,
// повтор обновления её не повторит). Что сказать переходнику и отправителю после COMMIT — Effects.
//
// Режимы (meta.mode) и ход (meta.turn):
// - «стоп» — stopped, turn + 1: события не отдаются; ответы агента из outbox (pending, held) — dropped; строка и кнопка
//   [продолжить] (остаётся в чате — важное). Снять стоп — только кнопкой: «продолжить» и «пауза» текстом в stopped
//   отвечают «Стоп снимается кнопкой [продолжить]» и присылают кнопку ещё раз;
// - [продолжить] — running, turn + 1; события, накопленные в stopped, отдаются по порядку; все кнопки [продолжить] гаснут;
//   нажатая строка правится в одну строку без кнопок «Стоп снят…» (новой строки нет);
// - «пауза» — paused: ответы на события уходят, сообщения агента без seq — held; «продолжить» — held уходят по порядку.
//   Ни «пауза», ни «продолжить» из паузы ответной строки не дают: режим виден в закреплённой строке (J-4).
//   Строка не закрепилась (3 попытки, statusline.ts) — её не видно: тогда «пауза», «продолжить» и «новая тема» отвечают
//   временной строкой, которая удаляется, как ответ «где мы» (находка проверки).
// Каждая смена режима — кадр mode переходнику.
//
// Чистый чат (J-4: без лишних сообщений): сообщение владельца с командой удаляется после исполнения
// (deletions); ответ «где мы» живёт ui.where_ttl_minutes (5 минут) или до следующего «где мы»; «новая тема» и смена
// эпизода строк не дают — их видно в закреплённой строке.
//
// Эпизоды: агент называет тему (episode name) или открывает новую (episode new) — строка `⚙ ↪ #N · тема` с [верно]
// [не то] (номер — `#N`, роль по умолчанию не показывается, другая — последней: shownRole); после
// нажатия она правится в одну строку без кнопок. [верно] — отметка в журнале и «— верно». [не то] после new: прежний
// эпизод открывается снова, если закрыт меньше 4 часов назад, объявленный закрывается (owner_rejected), строка —
// «↩ #N · прежняя тема»; если больше — «— не то» и кнопки с темами трёх последних эпизодов за сутки (`#N · тема`)
// отдельным сообщением (после выбора — тоже одна строка). [не то] после name возвращает прежнюю тему. В обоих случаях
// агенту — episode_reopened в общей очереди.

import {
  sql,
  BUTTON_LABELS,
  BUTTON_REFUSALS,
  CHANNEL_UNVERIFIED_HINT,
  MESSAGE_EVENT_KINDS,
  META_KEYS,
  NEW_TOPIC,
  PARCEL_NOTE_STOP,
  PAUSED_NOTE_TEXT,
  PICK_EPISODE_TEXT,
  RESUMED_NOTE_TEXT,
  SERVICE_MARK,
  STOPPED_TEXT,
  STOP_NEEDS_BUTTON_TEXT,
  agentTopic,
  cutGraphemes,
  episodeAnnounceText,
  episodeTag,
  episodeConfirmedText,
  episodeRejectedText,
  episodeReturnedText,
  flatTopic,
  helpText,
  formatMs,
  getMeta,
  latencyStats,
  localDate,
  localTime,
  modeWord,
  agentStatusLines,
  newTopicNoteText,
  readMode,
  readProbesSaved,
  readTurn,
  setMeta,
  shownRole,
  stopLiftedText,
  transaction,
  sttVocabularyUse,
  ttsVoice,
  ttsVoiceField,
  voiceProviderLabel,
  whereData,
  whereText,
  type CallbackQuery,
  type ChatRule,
  type CommandName,
  type Mode,
  type RuleOp,
  type WhereData,
  type AgentStateFile,
  type AgentView,
} from 'stg-core';
import { checkButton, createButton, newGroup, useGroup, useKind, type ButtonPayload } from './buttons.js';
import { enqueueDeletion, enqueueEdit, enqueueServiceLine, type Ctx, type InlineMarkup } from './context.js';
import type { Resolved } from './directory.js';
import type { EpisodeRow, Episodes } from './episodes.js';
import type { RulesService } from './rules.js';
import { statusLinePinFailed } from './statusline.js';
import { VOICE_LANE_SQL, enqueueSttReply } from './voice.js';

const MSG_KINDS_SQL = MESSAGE_EVENT_KINDS.map((k) => `'${k}'`).join(',');

/** [не то] после new: прежний эпизод открывается снова, если закрыт меньше 4 часов назад (5.7). */
export const REJECT_REOPEN_MS = 4 * 3600_000;
/** Иначе — кнопки с темами эпизодов за сутки, не больше трёх. */
export const REJECT_PICK_WINDOW_MS = 24 * 3600_000;
export const REJECT_PICK_LIMIT = 3;
/** Подпись кнопки с темой (Telegram режет длинные). */
const PICK_LABEL_MAX = 40;

/** Что сделать после COMMIT. */
export interface Effects {
  /** Режим или ход сменились — кадр mode переходнику. */
  mode?: boolean;
  /** В очереди новые события для агента. */
  pump?: boolean;
  /** Ответ на нажатие (answerCallbackQuery): текст отказа или null — без текста. undefined — это не нажатие. */
  answer?: string | null;
  /** Рабочая копия правил сменилась — справочник и rules.yaml (rules.ts, refresh). */
  rules?: boolean;
}

/** Состояние цикла опроса — для «статус». */
export interface PollState {
  running: boolean;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  conflicts: number;
}

/** Что знает только живой шлюз (память, не база). */
export interface LiveView {
  /**
   * Аренда; verified — done на probe получен (непроверенная — «на связи» не считается); sameSession — проверена без пробы:
   * тот же переходник, та же сессия (0.3.2).
   */
  lease(): { adapter: string; since: number; verified: boolean; sameSession?: boolean } | null;
  poll(): PollState | null;
  /** Распознавание: есть ли ключ (по имени из config.yaml), последний отказ. */
  stt?(): { keyKnown: boolean | null; lastFailure: { at: number; reason: string } | null } | null;
  /** Синтез: есть ли ключ. */
  tts?(): { keyKnown: boolean | null } | null;
  /** Состояние агента — контекст, сжатие, лимиты, отказ модели (5.14, agent-state.ts). */
  agent?(): { state: AgentStateFile | null; view: AgentView } | null;
}

export interface CommandEvent {
  seq: number;
  chatId: number;
  threadId: number | null;
  subjectId: string | null;
  chatRule: ChatRule;
  messageDate: number;
  /** Сообщение владельца с командой — удаляется после исполнения (null — неизвестно). */
  messageId?: number | null;
}

export type AgentResult = { ok: true; result: unknown; effects: Effects } | { ok: false; code: 'bad_request' | 'unavailable'; text: string };

function inline(rows: Array<Array<{ text: string; token: string }>>): InlineMarkup {
  return { inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.token }))) };
}

export class Control {
  private live: LiveView = { lease: () => null, poll: () => null };
  private rules: RulesService | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly episodes: Episodes,
  ) {}

  bindLive(live: LiveView): void {
    this.live = live;
  }

  /** Правила доступа (M5): rule агента, кнопки [разрешить] [нет]. */
  bindRules(rules: RulesService): void {
    this.rules = rules;
  }

  /** После COMMIT, если сменилась рабочая копия правил: справочник — по ней, rules.yaml — дописать. */
  refreshRules(): void {
    this.rules?.refresh();
  }

  /** rule(change) от переходника (5.9). */
  agentRule(ops: RuleOp[]): AgentResult {
    if (!this.rules) return { ok: false, code: 'unavailable', text: 'правила ещё не загружены — повтори позже' };
    return this.rules.requestChange(ops, this.mode());
  }

  mode(): Mode {
    return readMode(this.ctx.db);
  }

  turn(): number {
    return readTurn(this.ctx.db);
  }

  /** Сменить режим (и ход). Внутри транзакции. */
  private setMode(mode: Mode, turnInc: number, by: string): number {
    const turn = this.turn() + turnInc;
    setMeta(this.ctx.db, META_KEYS.mode, mode);
    if (turnInc) setMeta(this.ctx.db, META_KEYS.turn, String(turn));
    this.ctx.journal.write('mode', { mode, turn, by });
    return turn;
  }

  private ownerSubject(): string | null {
    return this.ctx.directory.ownerSubjectId();
  }

  private defaultRole(): string {
    return this.ctx.directory.ownerChatRule()?.role ?? '';
  }

  private resumeButton(): InlineMarkup {
    const token = createButton(this.ctx, 'resume', { group: 'resume' });
    return inline([[{ text: BUTTON_LABELS.resume, token }]]);
  }

  // ——— команды (внутри главной транзакции приёма) ———

  command(cmd: CommandName, ev: CommandEvent): Effects {
    const line = (text: string, replyMarkup: InlineMarkup | null = null): void => {
      enqueueServiceLine(this.ctx, text, { eventSeq: ev.seq, threadId: ev.threadId, replyMarkup });
    };
    /** Временная строка — только если закреплённую строку не видно (не закрепилась); удаляется, как ответ «где мы». */
    const note = (text: string): void => {
      if (!statusLinePinFailed(this.ctx)) return;
      const id = enqueueServiceLine(this.ctx, text, { eventSeq: ev.seq, threadId: ev.threadId, bare: true });
      if (id !== null) {
        enqueueDeletion(this.ctx, { chatId: ev.chatId, outboxId: id, reason: 'where', dueAt: this.ctx.clock.now() + this.ctx.config.ui.where_ttl_minutes * 60_000 });
      }
    };
    const mode = this.mode();
    this.ctx.journal.write('command', { seq: ev.seq, command: cmd, mode });
    // Нажатие не засоряет чат (J-4): сообщение владельца с командой удаляется после исполнения.
    if (ev.messageId !== null && ev.messageId !== undefined) {
      enqueueDeletion(this.ctx, { chatId: ev.chatId, tgMessageId: ev.messageId, reason: 'command', dueAt: this.ctx.clock.now() });
    }
    switch (cmd) {
      case 'stop': {
        // Ход + 1 и при повторном «стоп»: ответ, начатый до любого из них, не уйдёт.
        const turn = this.setMode('stopped', 1, 'command');
        const r = sql(this.ctx.db, "UPDATE outbox SET status = 'dropped' WHERE origin = 'agent' AND status IN ('pending', 'held')").run();
        // Посылки (0.3.3): недоставленные — тоже брошены (dropped), с причиной. Все ждущие, а не только связанные со
        // строкой outbox: у будущей веб-цели строки outbox нет, а «стоп» — «прекрати текущее дело» для всех целей
        // (находка проверки). Документ, который сейчас загружается, отправитель прервёт сам (sender.kick).
        const d = sql(this.ctx.db, "UPDATE deliveries SET status = 'dropped', note = ? WHERE status = 'pending'").run(PARCEL_NOTE_STOP);
        if (Number(r.changes)) this.ctx.journal.write('replies_dropped', { count: Number(r.changes), reason: 'stopped', turn, ...(Number(d.changes) ? { deliveries: Number(d.changes) } : {}) });
        line(STOPPED_TEXT, this.resumeButton());
        return { mode: true };
      }
      case 'pause': {
        if (mode === 'stopped') {
          line(STOP_NEEDS_BUTTON_TEXT, this.resumeButton());
          return {};
        }
        // Ответной строки нет: пауза видна в закреплённой строке (не закрепилась — временная строка).
        if (mode !== 'paused') this.setMode('paused', 0, 'command');
        note(PAUSED_NOTE_TEXT);
        return mode !== 'paused' ? { mode: true } : {};
      }
      case 'resume': {
        if (mode === 'stopped') {
          line(STOP_NEEDS_BUTTON_TEXT, this.resumeButton());
          return {};
        }
        if (mode === 'running') return {};
        this.setMode('running', 0, 'command');
        const r = sql(this.ctx.db, "UPDATE outbox SET status = 'pending' WHERE origin = 'agent' AND status = 'held'").run();
        if (Number(r.changes)) this.ctx.journal.write('held_released', { count: Number(r.changes) });
        note(RESUMED_NOTE_TEXT);
        return { mode: true };
      }
      case 'new': {
        const cur = this.episodes.openFor(ev.chatId, ev.subjectId);
        const closed = cur ? this.episodes.close(cur, 'owner_new_topic') : null;
        const prev = cur ?? this.episodes.lastClosed(ev.chatId, ev.subjectId);
        const opened = this.episodes.open({
          chatId: ev.chatId,
          subjectId: ev.subjectId,
          topic: NEW_TOPIC,
          role: ev.chatRule.role,
          space: ev.chatRule.space,
          openedBy: 'owner_new_topic',
          threadId: ev.threadId,
          activityAt: ev.messageDate,
          prevId: prev?.id ?? null,
        });
        // Строки нет: новый эпизод виден в закреплённой строке и в поле ввода (не закрепилась — временная строка).
        note(newTopicNoteText(opened.id));
        return closed !== null ? { pump: true } : {};
      }
      case 'where': {
        // Ответ «где мы» — на время: прежние ответы удаляются сейчас, этот — через ui.where_ttl_minutes.
        const now = this.ctx.clock.now();
        sql(this.ctx.db, "UPDATE deletions SET due_at = ? WHERE reason = 'where' AND status = 'pending' AND chat_id = ? AND due_at > ?").run(now, ev.chatId, now);
        const id = enqueueServiceLine(this.ctx, this.where().text, { eventSeq: ev.seq, threadId: ev.threadId, bare: true });
        if (id !== null) {
          enqueueDeletion(this.ctx, { chatId: ev.chatId, outboxId: id, reason: 'where', dueAt: now + this.ctx.config.ui.where_ttl_minutes * 60_000 });
        }
        return {};
      }
      case 'status': {
        line(this.statusText());
        return {};
      }
      case 'help': {
        line(helpText({ whereTtlMinutes: this.ctx.config.ui.where_ttl_minutes, audioMaxMinutes: this.ctx.config.stt.audio_max_minutes }));
        return {};
      }
    }
  }

  // ——— нажатия (внутри главной транзакции приёма) ———

  press(cq: CallbackQuery, who: Resolved): Effects {
    const chat = cq.message?.chat;
    // 5.9: засчитывается, только если нажал владелец в личке.
    if (!who.isOwner || !chat || chat.type !== 'private') return { answer: BUTTON_REFUSALS.notYours };
    const now = this.ctx.clock.now();
    const token = cq.data ?? '';
    const c = checkButton(this.ctx, token, now);
    if (!c.ok) {
      this.ctx.journal.write('button_refused', { kind: c.button?.kind ?? null, reason: c.refusal });
      // Кнопка больше не действует — убрать её из-под сообщения (M4: правка сообщений бота).
      if (c.button?.kind !== 'transcript') this.dropButtons(cq);
      // Срок карточки правил вышел раньше, чем тикер её закрыл, — rules_log expired сейчас.
      if (c.refusal === 'expired' && (c.button?.kind === 'rule_ok' || c.button?.kind === 'rule_no')) this.rules?.expireDue(now);
      return { answer: BUTTON_REFUSALS[c.refusal] };
    }
    const { button, payload } = c;
    this.ctx.journal.write('button', { kind: button.kind, group: payload.group });
    if (button.kind === 'transcript') return this.pressTranscript(payload);
    // Одноразовая кнопка нажата — кнопки сообщения больше не нужны (строку стопа и объявление темы ниже правят в одну
    // строку без кнопок: правка текста заменяет эту).
    this.dropButtons(cq);
    switch (button.kind) {
      case 'resume':
        return this.pressResume(now, cq);
      case 'episode_ok': {
        useGroup(this.ctx, payload.group, now);
        this.ctx.journal.write('episode_confirmed', { episode: payload.episode_id, action: payload.action });
        const ep = this.episodes.get(Number(payload.episode_id));
        if (ep) this.editPressed(cq, episodeConfirmedText(ep.id, typeof payload.topic === 'string' ? payload.topic : ep.topic, shownRole(ep.role)));
        return { answer: null };
      }
      case 'episode_reject':
        return this.pressReject(payload, now, cq);
      case 'episode_pick':
        return this.pressPick(payload, now, cq);
      case 'rule_ok':
      case 'rule_no':
        if (!this.rules) return { answer: BUTTON_REFUSALS.expired };
        return this.rules.press(button.kind, payload, now);
    }
  }

  /** Снять встроенные кнопки нажатого сообщения (правка с повтором). Внутри транзакции. */
  private dropButtons(cq: CallbackQuery): void {
    const m = cq.message;
    if (!m) return;
    enqueueEdit(this.ctx, { chatId: m.chat.id, tgMessageId: m.message_id, text: null, replyMarkup: null });
  }

  /** Нажатое сообщение — в одну строку без кнопок (J-4). Внутри транзакции. */
  private editPressed(cq: CallbackQuery, text: string): void {
    const m = cq.message;
    if (!m) return;
    enqueueEdit(this.ctx, { chatId: m.chat.id, tgMessageId: m.message_id, text, replyMarkup: null });
  }

  /**
   * [расшифровка] (5.5, Ш-26) — кнопка квитанций прежних версий (до 0.3.1; новых шлюз не ставит: расшифровка и так
   * приходит целиком, P-19). Нажатие на старой квитанции — та же расшифровка, что теперь
   * приходит сама: только текст, ответом на голосовое (файл), длинный — частями ⟨предл.⟩. Агенту нажатие не уходит.
   * Кнопка многоразовая; расшифровки нет (чужое старше срока хранения) — «истёк срок».
   */
  private pressTranscript(p: ButtonPayload): Effects {
    const seq = Number(p.event_seq);
    const ev = sql(this.ctx.db, "SELECT seq, transcript FROM events WHERE seq = ? AND kind IN ('voice', 'document')").get(seq) as
      | { seq: number; transcript: string | null }
      | undefined;
    if (!ev || !ev.transcript || enqueueSttReply(this.ctx, ev.seq) === null) return { answer: BUTTON_REFUSALS.expired };
    this.ctx.journal.write('transcript_requested', { seq: ev.seq });
    return { answer: null };
  }

  private pressResume(now: number, cq: CallbackQuery): Effects {
    useKind(this.ctx, 'resume', now);
    if (this.mode() !== 'stopped') return { answer: BUTTON_REFUSALS.used };
    const waiting = (sql(this.ctx.db, `SELECT count(*) AS n FROM events WHERE status = 'new' AND kind IN (${MSG_KINDS_SQL})`).get() as { n: number }).n;
    this.setMode('running', 1, 'button');
    // Строка стопа правится на месте (новой строки нет); сообщения нет под нажатием — строкой, как раньше.
    if (cq.message) this.editPressed(cq, stopLiftedText(waiting));
    else enqueueServiceLine(this.ctx, stopLiftedText(waiting));
    return { mode: true, pump: true, answer: null };
  }

  /** Вернуть эпизод: текущий (если есть) закрыть как отклонённый, выбранный открыть снова. Строку правит вызывающий. */
  private returnTo(target: EpisodeRow): void {
    const cur = this.episodes.openFor(target.chat_id, target.subject_id);
    if (cur && cur.id === target.id) return;
    if (cur) this.episodes.close(cur, 'owner_rejected');
    this.episodes.reopen(target);
  }

  private pressReject(p: ButtonPayload, now: number, cq: CallbackQuery): Effects {
    useGroup(this.ctx, p.group, now);
    const ep = this.episodes.get(Number(p.episode_id));
    if (!ep) return { answer: BUTTON_REFUSALS.expired };
    if (p.action === 'name') {
      // Объявление устарело: тему с тех пор переписали — возвращать нечего.
      if (ep.topic !== p.topic || typeof p.prev_topic !== 'string') return { answer: BUTTON_REFUSALS.expired };
      this.episodes.rename(ep, p.prev_topic);
      this.episodes.reopenedEvent(ep);
      this.editPressed(cq, episodeReturnedText(ep.id, ep.topic, shownRole(ep.role)));
      this.ctx.journal.write('episode_rejected', { episode: ep.id, action: 'name', topic: ep.topic });
      return { pump: true, answer: null };
    }
    // action new: объявленный — ep. Открыт уже другой эпизод — объявление устарело.
    const cur = this.episodes.openFor(ep.chat_id, ep.subject_id);
    if (cur && cur.id !== ep.id) return { answer: BUTTON_REFUSALS.expired };
    const prev = typeof p.prev_episode_id === 'number' ? this.episodes.get(p.prev_episode_id) : null;
    this.ctx.journal.write('episode_rejected', { episode: ep.id, action: 'new', prev: prev?.id ?? null });
    if (prev && prev.closed_at !== null && now - prev.closed_at < REJECT_REOPEN_MS) {
      this.returnTo(prev);
      this.editPressed(cq, episodeReturnedText(prev.id, prev.topic, shownRole(prev.role)));
      return { pump: true, answer: null };
    }
    this.editPressed(cq, episodeRejectedText(ep.id, ep.topic, shownRole(ep.role)));
    const exclude = [ep.id, ...(cur ? [cur.id] : [])];
    const recent = this.episodes.recentClosed(ep.chat_id, ep.subject_id, now - REJECT_PICK_WINDOW_MS, exclude, REJECT_PICK_LIMIT);
    if (!recent.length) {
      // Вернуть некуда: объявленный закрыт, следующее сообщение откроет новый эпизод (opened_by owner_rejected).
      if (cur) this.episodes.close(cur, 'owner_rejected');
      return { pump: true, answer: null };
    }
    const group = newGroup();
    const rows = recent.map((r) => [
      {
        text: cutGraphemes(`${episodeTag(r.id)} · ${flatTopic(r.topic)}`, PICK_LABEL_MAX).text,
        token: createButton(this.ctx, 'episode_pick', { group, episode_id: r.id, from_episode: ep.id }),
      },
    ]);
    enqueueServiceLine(this.ctx, PICK_EPISODE_TEXT, { threadId: ep.thread_id, replyMarkup: inline(rows) });
    return { answer: null };
  }

  private pressPick(p: ButtonPayload, now: number, cq: CallbackQuery): Effects {
    useGroup(this.ctx, p.group, now);
    const target = this.episodes.get(Number(p.episode_id));
    if (!target) return { answer: BUTTON_REFUSALS.expired };
    this.ctx.journal.write('episode_picked', { episode: target.id, from: p.from_episode ?? null });
    this.returnTo(target);
    this.editPressed(cq, episodeReturnedText(target.id, target.topic, shownRole(target.role)));
    return { pump: true, answer: null };
  }

  // ——— агент (своя транзакция; вызывает сокет переходника) ———

  /** Объявление смены (5.7): строка с [верно] [не то]. Внутри транзакции. */
  private announce(ep: EpisodeRow, reject: Record<string, unknown>): void {
    const group = newGroup();
    const ok = createButton(this.ctx, 'episode_ok', { group, episode_id: ep.id, action: reject.action });
    const no = createButton(this.ctx, 'episode_reject', { group, episode_id: ep.id, topic: ep.topic, ...reject });
    enqueueServiceLine(this.ctx, episodeAnnounceText(ep.id, ep.topic, shownRole(ep.role)), {
      threadId: ep.thread_id,
      replyMarkup: inline([[{ text: BUTTON_LABELS.ok, token: ok }, { text: BUTTON_LABELS.reject, token: no }]]),
    });
  }

  /** episode(name | new) от переходника (5.7, 5.10). В stopped — не исполняется: от агента ничего не уходит. */
  agentEpisode(action: 'name' | 'new', topicRaw: string, reason: string | undefined): AgentResult | { ok: true; result: 'dropped_stopped'; effects: Effects } {
    const owner = this.ctx.config.owner_id;
    if (owner === null) return { ok: false, code: 'unavailable', text: 'владелец не задан (первая настройка)' };
    const topic = agentTopic(topicRaw);
    if (!topic) return { ok: false, code: 'bad_request', text: 'тема пустая' };
    if (this.mode() === 'stopped') {
      this.ctx.journal.write('episode_dropped', { action, topic, reason: 'stopped' });
      return { ok: true, result: 'dropped_stopped', effects: {} };
    }
    const subjectId = this.ownerSubject();
    const rule = this.ctx.directory.ownerChatRule();
    return transaction(this.ctx.db, (): AgentResult => {
      const cur = this.episodes.openFor(owner, subjectId);
      if (action === 'name') {
        if (!cur) return { ok: false, code: 'bad_request', text: 'открытого эпизода нет — тему назовёшь, когда придёт сообщение' };
        if (cur.topic === topic) return { ok: true, result: { episode_id: cur.id, topic, action, changed: false }, effects: {} };
        const prevTopic = cur.topic;
        this.episodes.rename(cur, topic);
        this.ctx.journal.write('episode_named', { episode: cur.id, topic, prev_topic: prevTopic });
        this.announce(cur, { action: 'name', prev_topic: prevTopic });
        return { ok: true, result: { episode_id: cur.id, topic, action, changed: true }, effects: {} };
      }
      const closed = cur ? this.episodes.close(cur, 'agent_new') : null;
      const prev = cur ?? this.episodes.lastClosed(owner, subjectId);
      const ep = this.episodes.open({
        chatId: owner,
        subjectId,
        topic,
        role: cur?.role ?? rule?.role ?? '',
        space: cur?.space ?? rule?.space ?? null,
        openedBy: 'agent_new',
        threadId: cur?.thread_id ?? null,
        activityAt: this.ctx.clock.now(),
        prevId: prev?.id ?? null,
      });
      this.ctx.journal.write('episode_new_by_agent', { episode: ep.id, topic, prev: prev?.id ?? null, reason: reason ?? null });
      this.announce(ep, { action: 'new', prev_episode_id: prev?.id ?? null });
      return { ok: true, result: { episode_id: ep.id, topic, action, changed: true }, effects: closed !== null ? { pump: true } : {} };
    });
  }

  /** episode_summary от переходника: итог и его метка — кодом (Ш-25); episode_closed этого эпизода — обработано. */
  agentSummary(episodeId: number, text: string): AgentResult {
    const ep = this.episodes.get(episodeId);
    if (!ep) return { ok: false, code: 'bad_request', text: `нет эпизода ${episodeId}` };
    const now = this.ctx.clock.now();
    const trust = transaction(this.ctx.db, () => {
      const t = this.episodes.saveSummary(ep, text);
      sql(this.ctx.db,
        "UPDATE events SET status = 'processed', processed_at = ?, processed_silent = 1 WHERE kind = 'episode_closed' AND episode_id = ? AND status IN ('new', 'delivered')",
      ).run(now, ep.id);
      return t;
    });
    this.ctx.journal.write('episode_summary', { episode: ep.id, summary_trust: trust, text });
    return { ok: true, result: { episode_id: ep.id, summary_trust: trust }, effects: {} };
  }

  // ——— «где мы» и «статус» ———

  /** Переходник словами (5.10): на связи · проверка канала · сессия без канала · не на связи. */
  adapterLine(): string {
    const tz = this.ctx.config.timezone;
    const lease = this.live.lease();
    if (lease?.verified) return `на связи (${lease.adapter}, с ${localTime(lease.since, tz)}${lease.sameSession ? '; та же сессия — без проверочного события' : ''})${this.probesSavedWords()}`;
    if (lease) return `проверка канала — ждёт done на проверочное событие (с ${localTime(lease.since, tz)})`;
    const raw = getMeta(this.ctx.db, META_KEYS.channelUnverified);
    if (raw) {
      try {
        const u = JSON.parse(raw) as { at?: number };
        return `не на связи: ${CHANNEL_UNVERIFIED_HINT}${typeof u.at === 'number' ? ` (${localTime(u.at, tz)})` : ''}`;
      } catch {
        return `не на связи: ${CHANNEL_UNVERIFIED_HINT}`;
      }
    }
    return 'не на связи';
  }

  /**
   * Сколько проверок канала обошлось без хода модели (0.3.2, R-4 а; meta.probes_saved) — хвост строки «Переходник»; не
   * было — пусто.
   */
  private probesSavedWords(): string {
    const p = readProbesSaved(getMeta(this.ctx.db, META_KEYS.probesSaved));
    return p && p.n > 0 ? ` · без хода модели проверок канала: ${p.n} (с ${localDate(p.since, this.ctx.config.timezone)})` : '';
  }

  /**
   * «Распознавание» в «статус» (M4: текст строки): провайдер, модель и словарь; за сутки — сколько распознано и сколько
   * нет; ключа нет — что сделать; последний отказ за сутки — когда и почему.
   */
  sttLine(now: number): string {
    const { ctx } = this;
    const { stt } = ctx.config;
    const view = this.live.stt?.() ?? null;
    const n = (q: string): number => (sql(ctx.db, q).get(now - 24 * 3600_000) as { n: number }).n;
    // Голосовые и кружки (0.3: кружок — в голосовой очереди); отказ по аудиофайлу и видео — в ответе на них.
    const ok = n(`SELECT count(*) AS n FROM events WHERE ${VOICE_LANE_SQL} AND transcript IS NOT NULL AND created_at >= ?`);
    const failed = n(`SELECT count(*) AS n FROM events WHERE ${VOICE_LANE_SQL} AND transcript IS NULL AND status <> 'transcribing' AND created_at >= ?`);
    const busy = (sql(ctx.db, "SELECT count(*) AS n FROM events WHERE status = 'transcribing'").get() as { n: number }).n;
    const vocab = sttVocabularyUse(stt);
    const label = voiceProviderLabel({ provider: stt.provider, baseUrl: stt.base_url });
    const parts = [`${label} ${stt.model}, язык ${stt.language}, словарь ${vocab.terms}${vocab.note ? ` (${vocab.note})` : ''}`];
    if (view?.keyKnown === false) parts.push(`нет ключа ${stt.key} — stg doctor`);
    parts.push(`за сутки распознано ${ok}, не распознано ${failed}${busy ? `, распознаю ${busy}` : ''}`);
    const lf = view?.lastFailure;
    if (lf && now - lf.at < 24 * 3600_000) parts.push(`последний отказ в ${localTime(lf.at, ctx.config.timezone)}: ${lf.reason}`);
    return parts.join(' · ');
  }

  /** «Синтез» в «статус»: провайдер, модель и голос; голоса или ключа нет — что сделать. */
  ttsLine(): string {
    const { tts } = this.ctx.config;
    const view = this.live.tts?.() ?? null;
    const voice = ttsVoice(tts);
    const label = voiceProviderLabel({ provider: tts.provider, baseUrl: tts.base_url });
    const parts = [`${label} ${tts.model}, ${voice ? `голос ${voice}` : `голос не задан (${ttsVoiceField(tts)}) — stg doctor`}`];
    if (view?.keyKnown === false) parts.push(`нет ключа ${tts.key} — stg doctor`);
    return parts.join(' · ');
  }

  where(): { text: string; data: WhereData } {
    const input = {
      now: this.ctx.clock.now(),
      timezone: this.ctx.config.timezone,
      chatId: this.ctx.config.owner_id,
      subjectId: this.ownerSubject(),
      defaultRole: this.defaultRole(),
      agentOnline: this.live.lease()?.verified === true,
    };
    const data = whereData(this.ctx.db, input);
    return { text: whereText(data, input), data };
  }

  /**
   * «статус» (5.6, M2: формат строки): опрос, база, переходник, агент (контекст, сжатие, лимиты, последний отказ модели —
   * 5.14), распознавание, задержки p50/p90 за сутки.
   */
  statusText(): string {
    const { ctx } = this;
    const tz = ctx.config.timezone;
    const now = ctx.clock.now();
    const lines = [`${SERVICE_MARK} Статус`];
    const poll = this.live.poll();
    if (!poll) lines.push('Опрос: не идёт — нет токена бота (stg doctor)');
    else {
      let s = poll.running ? 'идёт' : 'остановлен';
      if (poll.lastOkAt !== null) s += `, последний ответ Telegram в ${localTime(poll.lastOkAt, tz)}`;
      if (poll.conflicts > 0) s += `; конфликт опроса (409) подряд: ${poll.conflicts}`;
      else if (poll.lastErrorAt !== null && (poll.lastOkAt === null || poll.lastErrorAt > poll.lastOkAt)) s += `; сбой: ${poll.lastError ?? '?'}`;
      lines.push(`Опрос: ${s}`);
    }
    const n = (q: string): number => (sql(ctx.db, q).get() as { n: number }).n;
    const events = n('SELECT count(*) AS n FROM events');
    const pending = n("SELECT count(*) AS n FROM outbox WHERE status IN ('pending', 'held')");
    const deferred = n("SELECT count(*) AS n FROM updates WHERE status = 'deferred'");
    lines.push(`База: ${ctx.disk.isFull ? 'диск полон — приём стоит' : 'в порядке'} · событий ${events} · ждёт отправки ${pending} · отложено ${deferred}`);
    lines.push(`Переходник: ${this.adapterLine()}`);
    // Контекст, сжатие, лимиты и последний отказ модели — из agent-state.json (5.14; D-6: время и текст отказа).
    const agent = this.live.agent?.() ?? null;
    if (agent) lines.push(...agentStatusLines(agent.state, agent.view, tz, now));
    lines.push(`Режим: ${modeWord(this.mode())}`);
    lines.push(`Распознавание: ${this.sttLine(now)}`);
    lines.push(`Синтез: ${this.ttsLine()}`);
    const lat = latencyStats(ctx.db, now);
    // «Записал» с 0.3.2 — по записи (✍ нет; core/where.ts) ⟨предл.⟩.
    lines.push(
      `Задержки за сутки: записал p50 ${formatMs(lat.admitted.p50)} · p90 ${formatMs(lat.admitted.p90)}; 👀 после отдачи агенту p50 ${formatMs(lat.eyes.p50)} · p90 ${formatMs(lat.eyes.p90)}`,
    );
    return lines.join('\n');
  }
}
