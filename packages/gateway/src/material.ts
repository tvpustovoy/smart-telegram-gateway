// Окно для материала без слов владельца (0.3.6; GitHub issue #51; TECH-SPEC 5.18). Владелец часто присылает ссылку,
// пересылку или файл, а что с ними делать, говорит следом. Шлюз держит такой материал окном ui.material_hold_seconds
// (по умолчанию 120 с) и отдаёт агенту вместе со словами — одним заходом: материал, затем слова.
// Что материал, а что слова, — core/material.ts (materialClass). Здесь — шаги внутри транзакций приёма и распознавания:
// - admitMaterial — материал записывается: слова владельца были раньше в пределах окна (в том же чате и теме) — сразу,
//   с пометкой before (правило 3); иначе — held (пересланное голосовое — transcribing) с hold_until = сейчас + окно;
// - extendWindow — несколько материалов подряд — одно окно, отсчёт от последнего (правило 2);
// - releaseByWords — слова владельца в том же чате и теме (текст, подпись, голосовое, кружок, свой аудиофайл; правка
//   удерживаемого материала, в которой есть слова, — дописал подпись) отпускают весь удерживаемый материал с пометкой
//   after. Голосовое и кружок — слова с момента прихода (правило 1): материал не обгоняет их и не ждёт окна — held до
//   конца их распознавания, затем отдаётся с ними;
// - joinWindow — правка удерживаемого материала без слов (живое место шлёт координаты правками; фото заменено без
//   подписи) — не слова: ждёт вместе с исходным, тем же сроком, окно не сдвигает, и отпускается с ним — иначе она ушла бы
//   агенту раньше исходного ⟨предл.⟩;
// - settleTranscribed — распознавание кончилось: сам материал (пересланное голосовое) снова held, если окно ещё идёт, а
//   материал, ждавший этих слов, — new в той же транзакции;
// - releaseOnEpisodeClose — эпизод материала закрылся раньше слов («новая тема», агент открыл новую, другая тема Telegram,
//   тишина; episodes.ts): удерживаемый материал отдаётся с пометкой none до события «эпизод закрыт», чтобы итог эпизода
//   агент писал, видя его ⟨предл.: материал — в эпизоде, где пришёл; правило роли «материал по ходу разговора — в тот же
//   эпизод»⟩.
// Конец окна без слов — таймер hold.ts: пометка none и сколько материал ждал.
// Команды («стоп», «где мы» …), нажатия, реакции и жесты (стикер) окна не трогают; «стоп» — как прежде: окно идёт, затем
// материал ждёт [продолжить] в new.

import { HELD_MATERIAL_SQL, hasOwnerWords, sql, type Attachment, type EventStatus, type MaterialHold, type TrustLabel } from 'stg-core';
import type { Ctx } from './context.js';
import { materialHoldMs } from './hold.js';

/** Где окно: чат, тема Telegram и отправитель (окно — только у владельца). */
export interface MaterialPlace {
  chatId: number;
  threadId: number | null;
  subjectId: string;
}

export interface MaterialDecision {
  status: EventStatus;
  holdUntil: number | null;
  material: MaterialHold | null;
}

/**
 * Последние слова владельца в этом чате и теме не раньше since (часы шлюза): № события или null. Слова — по тем же
 * правилам, что при приёме (hasOwnerWords): текст, подпись, голосовое, свой кружок и аудиофайл; команды — не слова.
 */
function recentOwnerWords(ctx: Ctx, p: MaterialPlace, since: number): number | null {
  const rows = sql(ctx.db,
    `SELECT seq, kind, trust, text, attachments_json FROM events
     WHERE chat_id = ? AND thread_id IS ? AND subject_id IS ? AND update_id IS NOT NULL
       AND kind IN ('text', 'voice', 'photo', 'document') AND forward_json IS NULL AND created_at >= ?
     ORDER BY seq DESC LIMIT 50`,
  ).all(p.chatId, p.threadId, p.subjectId, since) as Array<{ seq: number; kind: 'text' | 'voice' | 'photo' | 'document'; trust: TrustLabel | null; text: string | null; attachments_json: string | null }>;
  for (const r of rows) {
    const attachments = r.attachments_json ? (JSON.parse(r.attachments_json) as Attachment[]) : [];
    if (hasOwnerWords({ kind: r.kind, trust: r.trust, text: r.text, attachments })) return r.seq;
  }
  return null;
}

/**
 * Материал записывается (до INSERT): окно 0 — как до 0.3.6; слова владельца были раньше в пределах окна — сразу, с
 * пометкой before; иначе — в окно: new → held (transcribing остаётся: распознаётся, окно идёт), hold_until — конец окна.
 */
export function admitMaterial(ctx: Ctx, p: MaterialPlace, status: EventStatus, now: number): MaterialDecision {
  const holdMs = materialHoldMs(ctx);
  if (holdMs === 0) return { status, holdUntil: null, material: null };
  const before = recentOwnerWords(ctx, p, now - holdMs);
  if (before !== null) return { status, holdUntil: null, material: { state: 'before', window_ms: holdMs, words_seq: before } };
  return { status: status === 'new' ? 'held' : status, holdUntil: now + holdMs, material: { state: 'waiting', window_ms: holdMs } };
}

/** Новый материал в окне — окно прочих удерживаемых в этом чате и теме отсчитывается от него: № сдвинутых. */
export function extendWindow(ctx: Ctx, p: MaterialPlace, seq: number, until: number): number[] {
  const rows = sql(ctx.db, `SELECT seq FROM events WHERE ${HELD_MATERIAL_SQL} AND chat_id = ? AND thread_id IS ? AND subject_id IS ? AND seq < ?`).all(
    p.chatId,
    p.threadId,
    p.subjectId,
    seq,
  ) as Array<{ seq: number }>;
  if (rows.length) {
    sql(ctx.db, `UPDATE events SET hold_until = ? WHERE ${HELD_MATERIAL_SQL} AND chat_id = ? AND thread_id IS ? AND subject_id IS ? AND seq < ?`).run(
      until,
      p.chatId,
      p.threadId,
      p.subjectId,
      seq,
    );
  }
  return rows.map((r) => r.seq);
}

/** Материал, отпущенный словами: № и сколько ждал (от записи до отдачи, мс). */
export interface Released {
  seq: number;
  heldMs: number;
}

export interface WordsRelease {
  /** Отданы сразу (held → new): слова уже готовы. */
  released: Released[];
  /** Ждут распознавания слов (голосовое, кружок) или своего (пересланное голосовое): отдаст распознаватель. */
  linked: number[];
}

/**
 * Слова владельца записаны (после INSERT, в той же транзакции): весь удерживаемый материал этого чата и темы — с ними
 * (пометка after, № слов). Слова готовы (new) — материал new сразу; слова распознаются — материал held до их расшифровки
 * (settleTranscribed); материал сам распознаётся — остаётся transcribing, по готовности уйдёт (если слова готовы).
 */
export function releaseByWords(ctx: Ctx, p: MaterialPlace, wordsSeq: number, wordsStatus: EventStatus, now: number): WordsRelease {
  const rows = sql(ctx.db, `SELECT seq, status, material_json, created_at FROM events WHERE ${HELD_MATERIAL_SQL} AND chat_id = ? AND thread_id IS ? AND subject_id IS ? AND seq < ? ORDER BY seq`).all(
    p.chatId,
    p.threadId,
    p.subjectId,
    wordsSeq,
  ) as Array<{ seq: number; status: EventStatus; material_json: string; created_at: number }>;
  const out: WordsRelease = { released: [], linked: [] };
  for (const r of rows) {
    const m: MaterialHold = { ...(JSON.parse(r.material_json) as MaterialHold), state: 'after', words_seq: wordsSeq };
    const go = r.status === 'held' && wordsStatus !== 'transcribing';
    sql(ctx.db, `UPDATE events SET material_json = ?${go ? ", status = 'new'" : ''} WHERE seq = ?`).run(JSON.stringify(m), r.seq);
    if (go) out.released.push({ seq: r.seq, heldMs: now - r.created_at });
    else out.linked.push(r.seq);
  }
  return out;
}

/**
 * Удерживаемый материал, который правит владелец: правка со словами (дописал подпись) — его слово, отпускает окно; без
 * слов — ждёт вместе с исходным (joinWindow).
 */
export function isHeldMaterial(ctx: Ctx, seq: number | null): boolean {
  if (seq === null) return false;
  return !!sql(ctx.db, `SELECT 1 FROM events WHERE seq = ? AND ${HELD_MATERIAL_SQL}`).get(seq);
}

/**
 * Правка удерживаемого материала без слов (до INSERT): held тем же сроком, что исходный, — окно не сдвигается (живое место
 * шлёт правки всё время, пока им делятся: окно не кончилось бы никогда). Отпускается вместе с исходным — словами,
 * концом окна или закрытием эпизода: в том же чате и теме, номер — после исходного.
 */
export function joinWindow(ctx: Ctx, editOf: number, status: EventStatus): MaterialDecision {
  const row = sql(ctx.db, `SELECT hold_until, material_json FROM events WHERE seq = ? AND ${HELD_MATERIAL_SQL}`).get(editOf) as
    | { hold_until: number | null; material_json: string }
    | undefined;
  if (!row || row.hold_until === null) return { status, holdUntil: null, material: null };
  const m = JSON.parse(row.material_json) as MaterialHold;
  return { status: status === 'new' ? 'held' : status, holdUntil: row.hold_until, material: { state: 'waiting', window_ms: m.window_ms } };
}

/**
 * Эпизод закрывается (внутри транзакции закрытия, до записи события «эпизод закрыт»): удерживаемый материал этого эпизода
 * — пометка none, сколько ждал; held → new. Распознаваемое пересланное голосовое остаётся transcribing, но уже с none:
 * после расшифровки распознаватель его не придержит. Номер материала меньше номера события «эпизод закрыт» — агент
 * получит материал раньше и напишет итог, видя его.
 */
export function releaseOnEpisodeClose(ctx: Ctx, episodeId: number, now: number): Released[] {
  const rows = sql(ctx.db, `SELECT seq, status, material_json, created_at FROM events WHERE ${HELD_MATERIAL_SQL} AND episode_id = ? ORDER BY seq`).all(
    episodeId,
  ) as Array<{ seq: number; status: EventStatus; material_json: string; created_at: number }>;
  const out: Released[] = [];
  for (const r of rows) {
    const m: MaterialHold = { ...(JSON.parse(r.material_json) as MaterialHold), state: 'none', waited_ms: now - r.created_at };
    sql(ctx.db, `UPDATE events SET material_json = ?${r.status === 'held' ? ", status = 'new'" : ''} WHERE seq = ?`).run(JSON.stringify(m), r.seq);
    out.push({ seq: r.seq, heldMs: now - r.created_at });
  }
  return out;
}

export interface SettleResult {
  /** Распознанное — материал в окне или ждёт распознавания своих слов: снова held. */
  held: boolean;
  /** Материал, ждавший этих слов: отдан (held → new) вместе с ними. */
  released: Released[];
  /** Окно распознанного материала кончилось, пока он распознавался: отдан с пометкой «слов не было». */
  timedOut: boolean;
}

/**
 * Распознавание кончилось (внутри транзакции распознавателя, после transcribing → new): сам материал — held, если окно
 * ещё идёт (или его слова ещё распознаются); окно прошло — пометка none; материал, ждавший этих слов, — new.
 */
export function settleTranscribed(ctx: Ctx, seq: number, now: number): SettleResult {
  const out: SettleResult = { held: false, released: [], timedOut: false };
  const row = sql(ctx.db, 'SELECT material_json, hold_until, created_at FROM events WHERE seq = ?').get(seq) as
    | { material_json: string | null; hold_until: number | null; created_at: number }
    | undefined;
  if (row?.material_json) {
    const m = JSON.parse(row.material_json) as MaterialHold;
    if (m.state === 'waiting') {
      if (row.hold_until !== null && row.hold_until > now) {
        sql(ctx.db, "UPDATE events SET status = 'held' WHERE seq = ? AND status = 'new'").run(seq);
        out.held = true;
      } else {
        sql(ctx.db, 'UPDATE events SET material_json = ? WHERE seq = ?').run(JSON.stringify({ ...m, state: 'none', waited_ms: now - row.created_at }), seq);
        out.timedOut = true;
      }
    } else if (m.state === 'after' && m.words_seq !== undefined) {
      const words = sql(ctx.db, 'SELECT status FROM events WHERE seq = ?').get(m.words_seq) as { status: EventStatus } | undefined;
      if (words?.status === 'transcribing') {
        // hold_until — конец окна при записи (у held он обязателен); отпустит распознаватель вместе со словами.
        sql(ctx.db, "UPDATE events SET status = 'held', hold_until = COALESCE(hold_until, ?) WHERE seq = ? AND status = 'new'").run(now, seq);
        out.held = true;
      }
    }
  }
  const linked = sql(ctx.db,
    "SELECT seq, created_at FROM events WHERE status = 'held' AND material_json IS NOT NULL AND json_extract(material_json, '$.state') = 'after' AND json_extract(material_json, '$.words_seq') = ? ORDER BY seq",
  ).all(seq) as Array<{ seq: number; created_at: number }>;
  for (const r of linked) {
    sql(ctx.db, "UPDATE events SET status = 'new' WHERE seq = ? AND status = 'held'").run(r.seq);
    out.released.push({ seq: r.seq, heldMs: now - r.created_at });
  }
  return out;
}
