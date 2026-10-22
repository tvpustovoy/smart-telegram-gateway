// «Где мы» (TECH-SPEC 5.6, Ш-6; J-4) и задержки за сутки (5.13) — по базе, только чтением: одна сборка для шлюза
// (команда владельца, запрос переходника `where`) и для `stg where`, когда шлюз не отвечает. На связи ли агент, знает
// только шлюз (аренда — в его памяти): CLI без шлюза пишет «неизвестно».

import { shownRole } from './config.js';
import { getMeta, sql, type Db } from './db.js';
import type { WhereData } from './protocol.js';
import { MESSAGE_EVENT_KINDS, META_KEYS, type Mode } from './schema.js';
import { CLOSED_EPISODE_MARK, NO_EPISODES_YET, SERVICE_MARK, episodeLabel, episodeTag, formatElapsed, roleLabel, seqList } from './strings.js';
import { localTime } from './time.js';

const MSG_KINDS_SQL = MESSAGE_EVENT_KINDS.map((k) => `'${k}'`).join(',');
const DAY_MS = 24 * 3600_000;
/** Сколько № «ждут ответа» отдавать полями. */
const WAITING_LIMIT = 50;

/** Режим шлюза (meta.mode): running по умолчанию. */
export function readMode(db: Db): Mode {
  const m = getMeta(db, META_KEYS.mode);
  return m === 'paused' || m === 'stopped' ? m : 'running';
}

/** Ход (meta.turn): 0 по умолчанию. */
export function readTurn(db: Db): number {
  return Number(getMeta(db, META_KEYS.turn) ?? '0') || 0;
}

export interface WhereInput {
  now: number;
  timezone: string;
  /** Личка владельца; null — первая настройка. */
  chatId: number | null;
  subjectId: string | null;
  /** Роль по правилам — эпизод, который откроет следующее сообщение. */
  defaultRole: string;
  /** На связи ли агент (есть аренда); null — неизвестно. */
  agentOnline: boolean | null;
}

interface EpisodeLite {
  id: number;
  topic: string;
  role: string;
  opened_at: number;
  thread_id: number | null;
}

/** Открытый эпизод лички владельца. */
export function openEpisodeOf(db: Db, chatId: number, subjectId: string | null): EpisodeLite | null {
  return (
    (sql(db, "SELECT id, topic, role, opened_at, thread_id FROM episodes WHERE chat_id = ? AND COALESCE(subject_id, '') = COALESCE(?, '') AND closed_at IS NULL")
      .get(chatId, subjectId) as EpisodeLite | undefined) ?? null
  );
}

export interface ClosedEpisodeLite {
  id: number;
  topic: string;
  role: string;
  closed_at: number;
}

/**
 * Последний закрытый эпизод лички владельца — по времени закрытия (как Episodes.lastClosed), а не по номеру: после [не то]
 * прежний эпизод открыт снова и закрывается позже отвергнутого, у которого номер больше (проверка 0.2.0). Для
 * закреплённой строки и «где мы», когда открытого нет.
 */
export function lastClosedEpisodeOf(db: Db, chatId: number, subjectId: string | null): ClosedEpisodeLite | null {
  return (
    (sql(db,
      `SELECT id, topic, role, closed_at FROM episodes WHERE chat_id = ? AND COALESCE(subject_id, '') = COALESCE(?, '')
       AND closed_at IS NOT NULL ORDER BY closed_at DESC, id DESC LIMIT 1`,
    ).get(chatId, subjectId) as ClosedEpisodeLite | undefined) ?? null
  );
}

function messageAt(raw: string | null, fallback: number): number {
  try {
    const u = JSON.parse(raw ?? 'null') as {
      message?: { date?: number };
      edited_message?: { date?: number };
      message_reaction?: { date?: number };
    } | null;
    // Реакция (0.3.4) — время реакции.
    const d = u?.message?.date ?? u?.edited_message?.date ?? u?.message_reaction?.date;
    if (typeof d === 'number') return d * 1000;
  } catch {
    // raw_json не разобрался — время приёма
  }
  return fallback;
}

/**
 * Материал без слов владельца в окне (0.3.6, issue #51): № событий, которые ждут его слов — агенту ещё не отданы (held
 * или, пока распознаётся пересланное голосовое, transcribing; material_json.state = waiting).
 */
export const HELD_MATERIAL_SQL = "material_json IS NOT NULL AND json_extract(material_json, '$.state') = 'waiting' AND status IN ('held', 'transcribing')";

/** Сколько сообщений владельца ждут агента (new · delivered · transcribing) — «где мы» и закреплённая строка. */
export function waitingCount(db: Db): number {
  return (sql(db, `SELECT count(*) AS n FROM events WHERE status IN ('new', 'delivered', 'transcribing') AND kind IN (${MSG_KINDS_SQL})`).get() as { n: number }).n;
}

export function whereData(db: Db, input: WhereInput): WhereData {
  const { now } = input;
  const episode = input.chatId !== null ? openEpisodeOf(db, input.chatId, input.subjectId) : null;
  const lastClosed = !episode && input.chatId !== null ? lastClosedEpisodeOf(db, input.chatId, input.subjectId) : null;
  const waitingRows = sql(db, `SELECT seq FROM events WHERE status IN ('new', 'delivered', 'transcribing') AND kind IN (${MSG_KINDS_SQL}) ORDER BY seq LIMIT ${WAITING_LIMIT}`)
    .all() as Array<{ seq: number }>;
  const waiting = waitingCount(db);
  // Правка удерживаемого материала без слов ждёт вместе с исходным (0.3.6) — в списке её нет: живое место дало бы десятки №.
  const heldWhere = `${HELD_MATERIAL_SQL} AND kind <> 'edit'`;
  const heldMaterial = (sql(db, `SELECT seq FROM events WHERE ${heldWhere} ORDER BY seq LIMIT ${WAITING_LIMIT}`).all() as Array<{ seq: number }>).map((r) => r.seq);
  const heldMaterialCount = (sql(db, `SELECT count(*) AS n FROM events WHERE ${heldWhere}`).get() as { n: number }).n;
  const deferred = (sql(db, "SELECT update_id, raw_json, received_at FROM updates WHERE status = 'deferred' ORDER BY update_id").all() as Array<{
    update_id: number;
    raw_json: string | null;
    received_at: number;
  }>).map((r) => ({ update_id: r.update_id, message_at: messageAt(r.raw_json, r.received_at) }));
  const closedSilent = (sql(db, `SELECT seq FROM events WHERE processed_silent = 1 AND processed_at >= ? AND kind IN (${MSG_KINDS_SQL}) ORDER BY seq`).all(now - DAY_MS) as Array<{
    seq: number;
  }>).map((r) => r.seq);
  // Итог не получен: episode_closed отдан агенту больше суток назад, итога нет, эпизод закрыт (открытый снова — не в счёт).
  const missing = (sql(db,
    `SELECT DISTINCT ep.id AS id FROM episodes ep JOIN events e ON e.episode_id = ep.id AND e.kind = 'episode_closed'
     WHERE ep.summary IS NULL AND ep.closed_at IS NOT NULL AND e.delivered_at IS NOT NULL AND e.delivered_at < ?
     ORDER BY ep.id DESC LIMIT 20`,
  ).all(now - DAY_MS) as Array<{ id: number }>).map((r) => r.id);
  return {
    episode: episode ? { id: episode.id, topic: episode.topic, role: episode.role, opened_at: episode.opened_at, thread_id: episode.thread_id } : null,
    last_closed: lastClosed ? { id: lastClosed.id, topic: lastClosed.topic, role: lastClosed.role, closed_at: lastClosed.closed_at } : null,
    mode: readMode(db),
    waiting: waitingRows.map((r) => r.seq),
    waiting_count: waiting,
    held_material: heldMaterial,
    held_material_count: heldMaterialCount,
    agent_online: input.agentOnline,
    deferred,
    closed_silent: closedSilent,
    summary_missing: missing,
  };
}

const MODE_WORDS: Record<Mode, string> = {
  running: 'работает',
  paused: 'пауза — агент отвечает на твои сообщения, сам не пишет',
  stopped: 'стоп — ответы агента не уходят',
};

/** Слово режима для строк владельцу. */
export function modeWord(mode: Mode): string {
  return MODE_WORDS[mode];
}

/**
 * «Где мы» словами (M2: формат строки; состав — 5.6). Эпизод — `#N · тема`, как в закреплённой строке; роль по умолчанию
 * не показывается (shownRole), другая — последней и в скобках у «откроет новый».
 */
export function whereText(d: WhereData, input: WhereInput): string {
  const tz = input.timezone;
  const lines = [`${SERVICE_MARK} Где мы`];
  // Роль, с которой откроется следующий эпизод: по умолчанию — не называется.
  const nextRole = shownRole(input.defaultRole);
  if (d.episode) {
    const e = d.episode;
    lines.push(`${episodeLabel(e.id, e.topic, shownRole(e.role))} — идёт ${formatElapsed(input.now - e.opened_at)} (с ${localTime(e.opened_at, tz)})`);
  } else if (d.last_closed) {
    // Открытого нет — последний закрытый, как в закреплённой строке «📍 #5 · … · закрыт» (проверка 0.2.0: прежнее
    // «Эпизода сейчас нет» рядом со строкой — то же противоречие, что и в строке) ⟨предл.⟩. Роль нового — если
    // она другая и не по умолчанию.
    const e = d.last_closed;
    const next = nextRole && roleLabel(nextRole) !== roleLabel(e.role) ? ` (${roleLabel(nextRole)})` : '';
    lines.push(`${episodeLabel(e.id, e.topic, shownRole(e.role))} — ${CLOSED_EPISODE_MARK} ${formatElapsed(input.now - e.closed_at)} назад; следующее сообщение откроет новый${next}`);
  } else {
    lines.push(`${NO_EPISODES_YET} — первое сообщение откроет эпизод${nextRole ? ` (${roleLabel(nextRole)})` : ''}`);
  }
  lines.push(d.waiting_count ? `Ждут ответа агента: ${d.waiting_count} (${seqList(d.waiting)})` : 'Ждут ответа агента: нет');
  // Материал без слов владельца в окне (0.3.6, issue #51) — строка только когда он есть ⟨предл.⟩.
  // Число — всего (held_material — первые 50), как у «Ждут ответа агента»; прежний шлюз числа не шлёт — длина списка.
  const heldCount = d.held_material_count ?? d.held_material?.length ?? 0;
  if (heldCount && d.held_material?.length) lines.push(`Ждут слов владельца: ${heldCount} (${seqList(d.held_material)})`);
  lines.push(`Агент: ${d.agent_online === null ? 'неизвестно — шлюз не отвечает' : d.agent_online ? 'на связи' : 'не на связи'}`);
  lines.push(`Режим: ${modeWord(d.mode)}`);
  lines.push(
    d.deferred.length
      ? `Отложено: ${d.deferred.length} (сообщения от ${d.deferred.slice(0, 5).map((x) => localTime(x.message_at, tz)).join(', ')}${d.deferred.length > 5 ? ', …' : ''}; stg deferred list)`
      : 'Отложено: нет',
  );
  if (d.closed_silent.length) lines.push(`Закрыто без ответа за сутки: ${d.closed_silent.length} (${seqList(d.closed_silent)})`);
  if (d.summary_missing.length) {
    const ids = d.summary_missing.slice(0, 5).map(episodeTag).join(', ');
    lines.push(`Итог ${ids}${d.summary_missing.length > 5 ? ', …' : ''} не получен`);
  }
  return lines.join('\n');
}

export function percentile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export interface LatencyStats {
  /**
   * «Записал» (L-2): от получения обновления до записи в базу — COMMIT главной транзакции приёма (t_admit − t_update). С
   * 0.3.2 ✍ нет (R-1 б: ✍ не ставится), видимой отметки «записал» у владельца нет,
   * а сама запись — по-прежнему то, после чего сообщение не потеряется; меряется она ⟨предл.⟩. По первой реакции (👀)
   * мерить нельзя: она ждёт агента — агент не на связи час, и p90 «записал» был бы час.
   */
  admitted: { p50: number | null; p90: number | null; n: number };
  /**
   * 👀 «агент увидел»: от отдачи агенту (delivered) до реакции (t_eyes − t_delivered; 👌 вместо 👀 — тоже) ⟨предл.⟩ —
   * доля шлюза. Сколько событие ждало агента (не на связи), видно по ⚪ и 📥 в закреплённой строке, а не здесь.
   */
  eyes: { p50: number | null; p90: number | null; n: number };
}

/**
 * Пачка (L-2) ⟨предл.⟩: сообщение отдано агенту (👀) меньше чем через столько после предыдущего — оно в пачке. Реакции
 * пачки идут шагом полосы (250 мс в чат): N-я встаёт через ≈ N × 250 мс — так задумано, это не задержка шлюза; в счёт
 * идёт только первое сообщение пачки. Тот же 1 с — в цели TECH-SPEC §6 («при сообщениях не чаще 1 в секунду»).
 */
export const LATENCY_PACK_GAP_MS = 1000;

/** Строки, кроме пачек: первая строка пачки остаётся (по времени отметки, при равенстве — по №). */
function withoutPackTail<T extends { event_seq: number }>(rows: T[], at: (r: T) => number): T[] {
  const sorted = [...rows].sort((a, b) => at(a) - at(b) || a.event_seq - b.event_seq);
  return sorted.filter((r, i) => i === 0 || at(r) - at(sorted[i - 1]!) >= LATENCY_PACK_GAP_MS);
}

/**
 * Задержки за сутки (Ш-16, 5.13; L-2): «записал» — запись (COMMIT) от получения обновления (0.3.2: ✍ нет, видимой
 * отметки нет ⟨предл.⟩) и 👀 «агент увидел» — от отдачи агенту; в 👀 сообщения пачки, кроме первого, в счёт не идут
 * (LATENCY_PACK_GAP_MS) ⟨предл.⟩. Запись пачке не мешает: каждое обновление — своя короткая транзакция.
 */
export function latencyStats(db: Db, now: number): LatencyStats {
  const lat = sql(db, 'SELECT event_seq, t_update, t_admit, t_delivered, t_eyes FROM latency WHERE t_update >= ?').all(now - DAY_MS) as Array<{
    event_seq: number;
    t_update: number;
    t_admit: number | null;
    t_delivered: number | null;
    t_eyes: number | null;
  }>;
  const adm = lat.filter((l) => l.t_admit !== null && l.t_admit >= l.t_update).map((l) => l.t_admit! - l.t_update);
  // Только 👀 после отдачи: у строк ранних сборок t_eyes — ранний 👀 при приёме, раньше отдачи; с обрезкой до
  // нуля они занижали бы p50 и p90 до 0 мс в первые сутки после обновления (проверка 0.2.0).
  const delivered = lat.filter((l): l is typeof l & { t_delivered: number } => l.t_delivered !== null);
  const eyes = withoutPackTail(delivered, (l) => l.t_delivered)
    .filter((l) => l.t_eyes !== null && l.t_eyes >= l.t_delivered)
    .map((l) => l.t_eyes! - l.t_delivered);
  return {
    admitted: { p50: percentile(adm, 50), p90: percentile(adm, 90), n: adm.length },
    eyes: { p50: percentile(eyes, 50), p90: percentile(eyes, 90), n: eyes.length },
  };
}

/** meta.probes_saved (0.3.2, R-4 а): сколько проверок канала обошлось без хода модели — «статус» и stg status. */
export interface ProbesSaved {
  n: number;
  since: number;
  last_at: number;
}

/** meta.probes_saved словами в поля; нет или испорчено — null. */
export function readProbesSaved(raw: string | null): ProbesSaved | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ProbesSaved>;
    return typeof v.n === 'number' && typeof v.since === 'number' && typeof v.last_at === 'number' ? { n: v.n, since: v.since, last_at: v.last_at } : null;
  } catch {
    return null;
  }
}
