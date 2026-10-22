// stg status, stg deferred list, stg deferred retry, stg log tail (TECH-SPEC 5, 5.3, 5.10, 5.13). База — только на
// чтение; в сокет — ping, «где мы» (на связи ли агент) и повтор отложенного: в базу пишет только шлюз, CLI его просит
// (hello role cli, deferred_retry).

import fs from 'node:fs';
import path from 'node:path';
import {
  CHANNEL_UNVERIFIED_HINT,
  META_KEYS,
  agentStatusLines,
  agentView,
  readAgentStateFile,
  getMeta,
  latencyStats,
  readProbesSaved,
  loadConfig,
  localDate,
  localTime,
  modeWord,
  openDatabase,
  ownerReactionLabel,
  readMode,
  resolveHome,
  stgPaths,
  type DeferredRetryResult,
  type Update,
} from 'stg-core';
import type { CmdResult } from './backup.js';
import { cliNow } from './backup.js';
import { askGateway, askWhereFull, pingSocket } from './socket.js';

/** Сколько ждать повтора отложенного: приём может скачивать звук (до 60 с). */
const RETRY_TIMEOUT_MS = 90_000;

function ms(v: number | null): string {
  return v === null ? '—' : v < 1000 ? `${v} мс` : `${(v / 1000).toFixed(1)} с`;
}

export async function runStatus(env: NodeJS.ProcessEnv, home?: string): Promise<CmdResult> {
  const paths = stgPaths(resolveHome(env, home));
  const config = loadConfig(paths.config, { test: env.STG_TEST === '1' });
  const running = fs.existsSync(paths.socket) && (await pingSocket(paths.socket));
  const out: string[] = [`шлюз: ${running ? 'работает' : 'не отвечает'}`];
  // На связи ли агент, знает только живой шлюз (аренда — в его памяти).
  const live = running ? await askWhereFull(paths.socket) : null;
  if (!fs.existsSync(paths.db)) return { code: running ? 0 : 1, out: [...out, 'базы ещё нет'] };
  const db = openDatabase(paths.db, { readOnly: true });
  try {
    const now = cliNow(env, paths);
    const saved = readProbesSaved(getMeta(db, META_KEYS.probesSaved));
    out.push(
      `переходник: ${adapterWords(live?.data?.agent_online ?? null, getMeta(db, META_KEYS.channelUnverified), config.timezone)}` +
        // Сколько проверок канала обошлось без хода модели (0.3.2, R-4 а).
        (saved && saved.n > 0 ? ` · без хода модели проверок канала: ${saved.n} (с ${localDate(saved.since, config.timezone)})` : ''),
    );
    out.push(...agentLines(paths.home, db, live?.data?.agent_online === true, config.timezone, now));
    const last = Number(getMeta(db, META_KEYS.lastUpdateAt) ?? 'NaN');
    out.push(
      `опрос: offset ${getMeta(db, META_KEYS.offset) ?? '—'}, последнее обновление ${Number.isFinite(last) ? `${localDate(last, config.timezone)} ${localTime(last, config.timezone)}` : '—'}`,
    );
    const ev = db.prepare('SELECT status, count(*) AS n FROM events GROUP BY status ORDER BY status').all() as Array<{ status: string; n: number }>;
    out.push(`события: ${ev.map((r) => `${r.status} ${r.n}`).join(', ') || 'нет'}`);
    const ob = db.prepare('SELECT status, count(*) AS n FROM outbox GROUP BY status ORDER BY status').all() as Array<{ status: string; n: number }>;
    out.push(`отправка: ${ob.map((r) => `${r.status} ${r.n}`).join(', ') || 'нет'}`);
    const deferred = (db.prepare("SELECT count(*) AS n FROM updates WHERE status = 'deferred'").get() as { n: number }).n;
    out.push(`отложено: ${deferred}${deferred ? ' (stg deferred list)' : ''}`);
    out.push(`режим: ${modeWord(readMode(db))}`);
    const lat = latencyStats(db, now);
    // «Записал» с 0.3.2 — по записи (✍ нет; core/where.ts) ⟨предл.⟩.
    out.push(`задержки за сутки: записал p50 ${ms(lat.admitted.p50)} · p90 ${ms(lat.admitted.p90)}; 👀 после отдачи агенту p50 ${ms(lat.eyes.p50)} · p90 ${ms(lat.eyes.p90)}`);
  } finally {
    db.close();
  }
  return { code: running ? 0 : 1, out };
}

/**
 * Агент (5.14): контекст, сжатие, лимиты и последний отказ модели — из agent-state.json, как в «статус». Каталог аренды
 * CLI не знает — каталог сессии не сверяется; когда агент последний раз ответил — по базе.
 */
function agentLines(home: string, db: ReturnType<typeof openDatabase>, online: boolean, tz: string, now: number): string[] {
  let state;
  try {
    state = readAgentStateFile(home);
  } catch (err) {
    return [`агент: agent-state.json не прочитан — ${(err as Error).message}`];
  }
  const t = db
    .prepare(
      `SELECT max(t) AS t FROM (SELECT max(processed_at) AS t FROM events WHERE status = 'processed'
       UNION ALL SELECT max(created_at) FROM outbox WHERE origin = 'agent')`,
    )
    .get() as { t: number | null };
  const view = agentView(state, { now, online, leaseCwd: null, lastAgentActivityAt: t.t ?? 0 });
  return agentStatusLines(state, view, tz, now).map((l) => l.charAt(0).toLowerCase() + l.slice(1));
}

/** Переходник словами для stg status (5.10): на связи · не на связи · сессия открыта без канала. */
function adapterWords(online: boolean | null, unverified: string | null, tz: string): string {
  if (online === true) return 'на связи';
  let hint = '';
  if (unverified) {
    try {
      const u = JSON.parse(unverified) as { at?: number; cwd?: string | null };
      hint = ` — ${CHANNEL_UNVERIFIED_HINT}${typeof u.at === 'number' ? ` (${localDate(u.at, tz)} ${localTime(u.at, tz)}${u.cwd ? `, ${u.cwd}` : ''})` : ''}`;
    } catch {
      hint = ` — ${CHANNEL_UNVERIFIED_HINT}`;
    }
  }
  return online === false ? `не на связи${hint}` : `неизвестно — шлюз не отвечает${hint}`;
}

/** stg deferred retry <update_id> (5.3): повтор делает шлюз — запрос через его сокет. */
export async function runDeferredRetry(env: NodeJS.ProcessEnv, updateIdRaw: string, home?: string): Promise<CmdResult> {
  const paths = stgPaths(resolveHome(env, home));
  if (!/^\d+$/.test(updateIdRaw)) return { code: 2, out: [`stg deferred retry: «${updateIdRaw}» — не номер обновления (stg deferred list)`] };
  const updateId = Number(updateIdRaw);
  const r = fs.existsSync(paths.socket) ? await askGateway(paths.socket, 'deferred_retry', { update_id: updateId }, RETRY_TIMEOUT_MS) : ({ ok: false, reason: 'no_gateway' } as const);
  if (!r.ok) {
    if (r.reason === 'closed') {
      return { code: 1, out: [`шлюз закрыл соединение посреди повтора ${updateId} — похоже, упал на этом обновлении снова; после перезапуска оно опять будет в отложенном (stg deferred list)`] };
    }
    if (r.reason === 'timeout') return { code: 1, out: [`шлюз не ответил за ${RETRY_TIMEOUT_MS / 1000} с — смотри stg log tail`] };
    return { code: 1, out: ['шлюз не отвечает: повтор делает шлюз — запусти службу и повтори'] };
  }
  const m = r.reply;
  if (m.type === 'error') return { code: 1, out: [`повтор ${updateId}: ${String(m.text)}`] };
  const res = m.result as DeferredRetryResult;
  if (res.status === 'admitted') return { code: 0, out: [`обновление ${updateId} принято: № ${res.seq ?? '?'}`] };
  return { code: 0, out: [`обновление ${updateId}: отправителя нет в правилах — не принято (ignored)`] };
}

export async function runDeferredList(env: NodeJS.ProcessEnv, home?: string): Promise<CmdResult> {
  const paths = stgPaths(resolveHome(env, home));
  const config = loadConfig(paths.config, { test: env.STG_TEST === '1' });
  if (!fs.existsSync(paths.db)) return { code: 0, out: ['базы ещё нет'] };
  const db = openDatabase(paths.db, { readOnly: true });
  try {
    const rows = db.prepare("SELECT update_id, crash_count, raw_json, received_at FROM updates WHERE status = 'deferred' ORDER BY update_id").all() as Array<{
      update_id: number;
      crash_count: number;
      raw_json: string | null;
      received_at: number;
    }>;
    if (!rows.length) return { code: 0, out: ['отложенного нет'] };
    return {
      code: 0,
      out: rows.map((r) => {
        let when = r.received_at;
        let text = '';
        try {
          const u = JSON.parse(r.raw_json ?? 'null') as Update | null;
          const m = u?.message ?? u?.edited_message;
          if (m?.date) when = m.date * 1000;
          text = (m?.text ?? m?.caption ?? '').replace(/\s+/g, ' ').slice(0, 60);
          // Реакция (0.3.4): содержимого нет — что стоит теперь и на каком сообщении.
          const mr = u?.message_reaction;
          if (mr) {
            if (mr.date) when = mr.date * 1000;
            const now = mr.new_reaction.map(ownerReactionLabel).join(' ');
            text = `реакция ${now || 'снята'} на сообщение ${mr.message_id}`;
          }
        } catch {
          text = '(raw_json не разобрался)';
        }
        return `${r.update_id} · ${localDate(when, config.timezone)} ${localTime(when, config.timezone)} · падений ${r.crash_count} · ${text || '(без текста)'}`;
      }),
    };
  } finally {
    db.close();
  }
}

export function runLogTail(env: NodeJS.ProcessEnv, lines: number, home?: string): CmdResult {
  const paths = stgPaths(resolveHome(env, home));
  if (!fs.existsSync(paths.logs)) return { code: 0, out: ['журнала ещё нет'] };
  const files = fs.readdirSync(paths.logs).filter((f) => f.endsWith('.jsonl')).sort();
  const out: string[] = [];
  for (let i = files.length - 1; i >= 0 && out.length < lines; i--) {
    const content = fs.readFileSync(path.join(paths.logs, files[i]!), 'utf8').split('\n').filter(Boolean);
    out.unshift(...content.slice(-(lines - out.length)));
  }
  return { code: 0, out };
}
