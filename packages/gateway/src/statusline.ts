// Закреплённая строка состояния (TECH-SPEC 5.7; Ш-13; J-4: состояние видно в одной закреплённой строке, которую бот
// меняет правкой, а не новыми сообщениями). Одно сообщение бота в личке владельца, закреплённое без звука: номер эпизода и тема —
// `📍 #7 · Задачи на неделю` (номер — коротко, `#7`, а не «Эп 7»; роль по умолчанию не показывается, другая — последней,
// ownerRoleName). Открытого эпизода нет — последний с пометкой «закрыт» (`📍 #5 · Отпуск в мае · закрыт`; прежнее
// «Эпизода нет» рядом с «Эп. 5» в чате читалось как противоречие); эпизодов не было — `📍 Тем ещё не было` ⟨предл.⟩.
// Значками — режим (если не «работает»), агент (🟢 свободен · 🟡 думает · ⚪ не на связи — только кружок, без слов), сколько
// сообщений ждут. «Думает» — агенту отдано (delivered), ответа или done ещё нет. Значки агента (5.14; J-4, P-1, D-6) —
// из файла agent-state.json, который пишет сессия агента (agent-state.ts): `🧠 16%` (или `🌀` — идёт сжатие),
// `🕐 31% · 📅 64%` (5 часов · неделя, выше 80% — `⚠85% до 14:00`), отказ модели — кружок 🔴 вместо 🟢 / 🟡 / ⚪. Нет
// данных, они от другой сессии или старые — значка нет.
//
// Здесь — что должно быть в строке и что в ней сейчас (meta.status_line); отправляет и правит отправитель (sender.ts):
// - правка на месте — не чаще раза в STATUS_LINE_MIN_INTERVAL_MS (3 с); «message is not modified» — не ошибка;
// - сменились только значки агента (проценты контекста и лимитов) — не чаще раза в AGENT_INDICATORS_MIN_INTERVAL_MS
//   (60 с) ⟨предл.⟩; сразу (через 3 с) — начало и конец сжатия, переход лимита через 80 %, отказ модели и его снятие
//   (agentUrgentSignature);
// - сообщения нет (удалено) или его нельзя править — новое, закрепить (disable_notification); служебное сообщение
//   Telegram о закреплении — удалить (deletions, pin_notice; номер — первый неизвестный после строки, когда приём догнал
//   закрепление, sender.ts; не вышло — не беда). Нижней клавиатуры следом больше нет (0.3.1, P-18: команды — в меню).
//   Открепил владелец, а сообщение есть — правится на месте, само снова не закрепляется (Telegram не говорит боту об
//   откреплении). Закрепить не вышло за 3 попытки — pin_failed: «пауза»,
//   «продолжить» и «новая тема» тогда отвечают временной строкой (control.ts);
// - сбой сети, 429, 5xx — повтор позже (retry_at).
// Строки «⚙ #N · …» о смене эпизода больше не отправляются: смена видна здесь. Первым шлюз не пишет: строка
// появляется с первым сообщением владельца (или нажатием) и дальше только правится.

import {
  MESSAGE_EVENT_KINDS,
  META_KEYS,
  agentIndicatorParts,
  agentUrgentSignature,
  getMeta,
  lastClosedEpisodeOf,
  openEpisodeOf,
  ownerRoleName,
  readMode,
  setMeta,
  sql,
  statusLineText,
  waitingCount,
  type AgentState,
  type AgentView,
} from 'stg-core';
import type { Ctx } from './context.js';

/** Правка строки — не чаще раза в 3 с. */
export const STATUS_LINE_MIN_INTERVAL_MS = 3_000;
/** Сменились только значки агента (проценты) — правка не чаще раза в 60 с ⟨предл.⟩. */
export const AGENT_INDICATORS_MIN_INTERVAL_MS = 60_000;

const MSG_KINDS_SQL = MESSAGE_EVENT_KINDS.map((k) => `'${k}'`).join(',');

export interface StatusLineSaved {
  chat_id: number;
  /** Сообщение бота со строкой; null — ещё нет (или прежнее пропало). */
  message_id: number | null;
  /** Текст в сообщении сейчас. */
  text: string | null;
  /** Когда правилось или отправлялось (часы шлюза). */
  at: number;
  /** Сбой — повторить не раньше (часы шлюза). */
  retry_at?: number | null;
  /** Закреплено ли (false — закрепить ещё раз, до 3 попыток). */
  pinned?: boolean;
  pin_attempts?: number;
  /** Закрепить не вышло за 3 попытки: строка есть, но вверху чата её не видно. */
  pin_failed?: boolean;
  /** Текст строки без значков агента — сменился ли он (5.14). */
  base?: string;
  /** Значки агента в строке (`🧠 16% · 🕐 31% · 📅 64%`). */
  ind?: string;
  /** Подпись важных переходов значков (сжатие, ⚠ лимитов, отказ) — они не ждут минуты. */
  urgent?: string;
  /** Когда последний раз правились значки агента (часы шлюза). */
  ind_at?: number;
}

/** Что должно быть в строке: текст целиком и он же без значков агента. */
export interface StatusLineWant {
  chatId: number;
  text: string;
  base: string;
  ind: string;
  urgent: string;
}

/** Строка состояния не закрепилась (3 попытки): её не видно вверху чата. Читает meta — для control.ts. */
export function statusLinePinFailed(ctx: Ctx): boolean {
  const raw = getMeta(ctx.db, META_KEYS.statusLine);
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as StatusLineSaved).pin_failed === true;
  } catch {
    return false;
  }
}

export interface StatusLineLive {
  /** Агент на связи — проверенная аренда (adapter.ts). */
  online(): boolean;
  /** Значки агента: контекст, сжатие, лимиты, отказ модели (agent-state.ts); нет — без значков. */
  agent?(now: number): AgentView | null;
}

export class StatusLine {
  constructor(
    private readonly ctx: Ctx,
    private live: StatusLineLive = { online: () => false },
  ) {}

  bindLive(live: StatusLineLive): void {
    this.live = live;
  }

  /**
   * Что должно быть в строке сейчас; null — владельца нет (первая настройка) или строки ещё нет, а владелец боту ещё
   * ничего не писал: шлюз не пишет первым (строка появляется с первым сообщением).
   */
  desired(): StatusLineWant | null {
    const owner = this.ctx.config.owner_id;
    if (owner === null) return null;
    const db = this.ctx.db;
    if (!this.saved() && !sql(db, 'SELECT 1 FROM events WHERE chat_id = ? AND update_id IS NOT NULL LIMIT 1').get(owner)) return null;
    const subject = this.ctx.directory.ownerSubjectId();
    const open = openEpisodeOf(db, owner, subject);
    // Открытого нет — последний закрытый эпизод лички с пометкой «закрыт» (следующее сообщение откроет новый). Последний —
    // по времени закрытия, а не по номеру: после [не то] прежний эпизод открыт снова и закрывается позже отвергнутого
    // (у отвергнутого номер больше) — в строке должен быть тот, к которому вернулись (находка проверки), как в
    // Episodes.lastClosed.
    const last = open ? null : lastClosedEpisodeOf(db, owner, subject);
    const ep = open ?? last;
    // Роль — эпизода; эпизодов не было — та, с которой откроется первый (правило лички владельца). Роль по умолчанию — не
    // показывается (ownerRoleName — пустая строка).
    const role = ep?.role ?? this.ctx.directory.ownerChatRule()?.role ?? '';
    const now = this.ctx.clock.now();
    const view = this.live.agent?.(now) ?? null;
    const input = {
      episode: ep ? { id: ep.id, topic: ep.topic, closed: !open } : null,
      role: ownerRoleName(this.ctx.config, role),
      agent: this.agentState(view),
      waiting: waitingCount(db),
      mode: readMode(db),
    };
    const parts = view ? agentIndicatorParts(view, this.ctx.config.timezone, now) : [];
    const base = statusLineText(input);
    const text = parts.length ? statusLineText({ ...input, indicators: parts }) : base;
    return { chatId: owner, text, base, ind: parts.join(' · '), urgent: view ? agentUrgentSignature(view) : '' };
  }

  /** 🔴 модель не отвечает (отказ модели) · 🟢 свободен · 🟡 думает (отдано, ответа или done ещё нет) · ⚪ не на связи. */
  private agentState(view: AgentView | null): AgentState {
    if (view?.failure) return 'failed';
    if (!this.live.online()) return 'offline';
    const busy = sql(this.ctx.db, `SELECT 1 FROM events WHERE status = 'delivered' AND kind IN (${MSG_KINDS_SQL}) LIMIT 1`).get();
    return busy ? 'busy' : 'free';
  }

  saved(): StatusLineSaved | null {
    const raw = getMeta(this.ctx.db, META_KEYS.statusLine);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as StatusLineSaved;
      return typeof v.chat_id === 'number' ? v : null;
    } catch {
      return null;
    }
  }

  /** Внутри транзакции. */
  save(v: StatusLineSaved): void {
    setMeta(this.ctx.db, META_KEYS.statusLine, JSON.stringify(v));
  }

  /**
   * Когда строке пора: null — не нужно (совпадает); иначе — не раньше этого времени (часы шлюза). Чат владельца сменился
   * (owner_id) — строка заводится заново.
   */
  dueAt(): (StatusLineWant & { at: number; saved: StatusLineSaved | null }) | null {
    const want = this.desired();
    if (!want) return null;
    const cur = this.saved();
    const same = cur && cur.chat_id === want.chatId;
    if (same && cur.message_id !== null && cur.text === want.text && cur.pinned !== false) return null;
    let at = same ? Math.max(cur.at + STATUS_LINE_MIN_INTERVAL_MS, cur.retry_at ?? 0) : 0;
    // Сменились только проценты в значках агента — не чаще раза в минуту; важные переходы (urgent) — как всё прочее.
    if (same && cur.message_id !== null && cur.pinned !== false && cur.base === want.base && cur.urgent === want.urgent && cur.ind !== want.ind) {
      at = Math.max(at, (cur.ind_at ?? cur.at) + AGENT_INDICATORS_MIN_INTERVAL_MS);
    }
    return { ...want, at, saved: same ? cur : null };
  }
}
