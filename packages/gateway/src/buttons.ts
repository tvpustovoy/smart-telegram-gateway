// Кнопки владельца (TECH-SPEC §3, 5.9; Ш-22): одноразовые встроенные кнопки шлюза в личке, со сроком. callback_data —
// случайный токен (≤ 64 байт), всё остальное — в таблице buttons. Нажатие засчитывается, только если оно от владельца
// в личке, а токен не использован и не истёк; иначе — отказ текстом answerCallbackQuery. Кнопки одного сообщения —
// одна группа: нажатие одной гасит все ([верно] гасит [не то]).

import crypto from 'node:crypto';
import { sql, type ButtonKind } from 'stg-core';
import type { Ctx } from './context.js';

/** Срок кнопки (5.9: 24 часа). */
export const BUTTON_TTL_MS = 24 * 3600_000;

export interface ButtonRow {
  token: string;
  kind: ButtonKind;
  payload_json: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export interface ButtonPayload {
  /** Группа кнопок одного сообщения. */
  group: string;
  [k: string]: unknown;
}

export function newGroup(): string {
  return crypto.randomBytes(6).toString('base64url');
}

/** Новая кнопка. Внутри транзакции. */
export function createButton(ctx: Ctx, kind: ButtonKind, payload: ButtonPayload, ttlMs = BUTTON_TTL_MS): string {
  const token = crypto.randomBytes(12).toString('base64url');
  const now = ctx.clock.now();
  sql(ctx.db, 'INSERT INTO buttons(token, kind, payload_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    token,
    kind,
    JSON.stringify(payload),
    now,
    now + ttlMs,
  );
  return token;
}

export type ButtonCheck =
  | { ok: true; button: ButtonRow; payload: ButtonPayload }
  | { ok: false; refusal: 'expired' | 'used'; button: ButtonRow | null };

/** Годна ли кнопка: неизвестный токен — как истёкший (кнопка не наша или из базы до восстановления копии). */
export function checkButton(ctx: Ctx, token: string, now: number): ButtonCheck {
  const b = (sql(ctx.db, 'SELECT * FROM buttons WHERE token = ?').get(token) as ButtonRow | undefined) ?? null;
  if (!b) return { ok: false, refusal: 'expired', button: null };
  if (b.used_at !== null) return { ok: false, refusal: 'used', button: b };
  if (b.expires_at <= now) return { ok: false, refusal: 'expired', button: b };
  let payload: ButtonPayload;
  try {
    payload = JSON.parse(b.payload_json ?? '{}') as ButtonPayload;
  } catch {
    return { ok: false, refusal: 'expired', button: b };
  }
  return { ok: true, button: b, payload };
}

/** Погасить кнопки группы. Внутри транзакции. */
export function useGroup(ctx: Ctx, group: string, now: number): number {
  const r = sql(ctx.db, "UPDATE buttons SET used_at = ? WHERE used_at IS NULL AND json_extract(payload_json, '$.group') = ?").run(now, group);
  return Number(r.changes);
}

/** Погасить все неиспользованные кнопки вида. Внутри транзакции. */
export function useKind(ctx: Ctx, kind: ButtonKind, now: number): number {
  const r = sql(ctx.db, 'UPDATE buttons SET used_at = ? WHERE used_at IS NULL AND kind = ?').run(now, kind);
  return Number(r.changes);
}
