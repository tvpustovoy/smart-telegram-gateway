// stg rules show (TECH-SPEC 5, 5.9): правила доступа — рабочая копия шлюза из базы (по ней проверяется каждое
// сообщение, AD-9), как с ней соотносится rules.yaml, что ждёт кнопки владельца и последние изменения (rules_log). База —
// только на чтение. Копии в базе ещё нет (шлюз не запускался после M5) — правила из rules.yaml, как их прочтёт шлюз.

import fs from 'node:fs';
import {
  META_KEYS,
  OWNER_WHO,
  chatLabel,
  defaultRules,
  effectiveRules,
  getMeta,
  loadConfig,
  localDayMonth,
  localTime,
  openDatabase,
  parcelsLabel,
  parseRulesState,
  readRulesFile,
  resolveHome,
  rulesFileStatus,
  schemaVersion,
  stgPaths,
  type Rules,
  type RulesState,
} from 'stg-core';
import type { CmdResult } from './backup.js';

/** С какой схемы в rules_log есть decided_at, outbox_id, note. */
const RULES_SCHEMA = 4;
const LOG_LIMIT = 10;

const STATUS_WORDS: Record<string, string> = {
  applied: 'применено',
  pending: 'ждёт кнопки владельца',
  rejected: 'не применено',
  expired: 'срок кнопки истёк',
};

const ACTOR_WORDS: Record<string, string> = { agent: 'агент', owner_file: 'правка rules.yaml' };

interface LogRow {
  id: number;
  at: number;
  actor: string;
  status: string;
  change_json: string;
  note: string | null;
  expires_at: number | null;
}

function rulesLines(rules: Rules): string[] {
  const out = ['Субъекты:'];
  for (const s of rules.subjects) {
    const tr = s.transports.length ? s.transports.map((t) => `${t.network} ${t.address}`).join(', ') : 'номеров нет';
    const who = s.who === OWNER_WHO ? 'владелец (config.yaml)' : `кто: «${s.who}»`;
    out.push(`  ${s.id} — ${who} · ${tr}${s.world_ref ? ` · модель мира: ${s.world_ref}` : ''}`);
  }
  out.push('Чаты:');
  for (const c of rules.chats) out.push(`  ${chatLabel(c.chat)} — пространство «${c.space}» · роль «${c.role}»${c.parcels === true ? ` · ${parcelsLabel(c.chat)}: да` : ''}`);
  return out;
}

function fileLine(st: RulesState | null, file: ReturnType<typeof readRulesFile>): string {
  if (!st) {
    if (file.kind === 'missing') return 'rules.yaml: нет — шлюз создаст его при старте';
    if (file.kind === 'broken') return `rules.yaml: не читается (${file.problems[0] ?? '?'}) — шлюз возьмёт только владельца`;
    return 'rules.yaml: рабочей копии в базе ещё нет — показаны правила из файла';
  }
  switch (rulesFileStatus(st, file)) {
    case 'same':
      return 'rules.yaml: совпадает с рабочей копией';
    case 'pending_write':
      return 'rules.yaml: ещё не переписан по рабочей копии — шлюз допишет (диск был полон)';
    case 'broken':
      return `rules.yaml: не читается (${file.kind === 'broken' ? (file.problems[0] ?? '?') : '?'}) — действуют правила рабочей копии`;
    case 'missing':
      return 'rules.yaml: нет — шлюз восстановит его из рабочей копии при старте';
    case 'edited':
      return 'rules.yaml: правлен вручную — правка прочитается при перезапуске шлюза';
  }
}

function changeLines(json: string): string[] {
  try {
    const c = JSON.parse(json) as { lines?: unknown };
    return Array.isArray(c.lines) ? c.lines.map(String) : [];
  } catch {
    return [];
  }
}

export async function runRulesShow(env: NodeJS.ProcessEnv, home?: string): Promise<CmdResult> {
  const paths = stgPaths(resolveHome(env, home));
  const config = loadConfig(paths.config, { test: env.STG_TEST === '1' });
  const tz = config.timezone;
  const file = readRulesFile(paths.rules);
  let st: RulesState | null = null;
  let logs: LogRow[] = [];
  if (fs.existsSync(paths.db)) {
    const db = openDatabase(paths.db, { readOnly: true });
    try {
      if (schemaVersion(db) >= RULES_SCHEMA) {
        st = parseRulesState(getMeta(db, META_KEYS.rulesState));
        logs = db
          .prepare(
            `SELECT r.id, r.at, r.actor, r.status, r.change_json, r.note, b.expires_at FROM rules_log r
             LEFT JOIN buttons b ON b.token = r.button_token ORDER BY r.id DESC LIMIT ${LOG_LIMIT + 50}`,
          )
          .all() as unknown as LogRow[];
      }
    } finally {
      db.close();
    }
  }
  const rules = st?.rules ?? effectiveRules(config, file.kind === 'ok' ? file.rules : defaultRules(config.owner_id)).rules;
  const when = (ms: number): string => `${localDayMonth(ms, tz)} ${localTime(ms, tz)}`;
  const out = [st ? 'Правила доступа — рабочая копия шлюза:' : 'Правила доступа (рабочей копии в базе ещё нет):', ...rulesLines(rules), fileLine(st, file)];
  const pending = logs.filter((l) => l.status === 'pending');
  out.push(pending.length ? `Ждут кнопки владельца: ${pending.length}` : 'Ждут кнопки владельца: нет');
  for (const l of pending) {
    out.push(`  #${l.id} · ${when(l.at)}${l.expires_at !== null ? ` · до ${when(l.expires_at)}` : ''}`);
    for (const line of changeLines(l.change_json)) out.push(`    ${line}`);
  }
  const recent = logs.filter((l) => l.status !== 'pending').slice(0, LOG_LIMIT);
  if (recent.length) {
    out.push(`Изменения (последние ${recent.length}):`);
    for (const l of recent) {
      out.push(`  #${l.id} · ${when(l.at)} · ${ACTOR_WORDS[l.actor] ?? l.actor} · ${STATUS_WORDS[l.status] ?? l.status}${l.note ? ` (${l.note})` : ''}`);
      for (const line of changeLines(l.change_json)) out.push(`    ${line}`);
    }
  }
  return { code: 0, out };
}
