// stg where (TECH-SPEC 5, 5.6): «где мы» — у живого шлюза через сокет (role cli, аренда не берётся; в базу пишет только
// шлюз). Шлюз не отвечает — та же сборка по базе, открытой только на чтение; на связи ли агент, тогда неизвестно: аренда —
// в памяти шлюза.

import fs from 'node:fs';
import {
  META_KEYS,
  OWNER_SUBJECT_ID,
  getMeta,
  parseRulesState,
  SCHEMA_VERSION,
  defaultRules,
  effectiveRules,
  loadConfig,
  loadRules,
  openDatabase,
  resolveHome,
  schemaVersion,
  stgPaths,
  whereData,
  whereText,
} from 'stg-core';
import type { CmdResult } from './backup.js';
import { cliNow } from './backup.js';
import { askWhere } from './socket.js';

export async function runWhere(env: NodeJS.ProcessEnv, home?: string): Promise<CmdResult> {
  const paths = stgPaths(resolveHome(env, home));
  const config = loadConfig(paths.config, { test: env.STG_TEST === '1' });
  const live = fs.existsSync(paths.socket) ? await askWhere(paths.socket) : null;
  if (live !== null) return { code: 0, out: live.split('\n') };
  if (!fs.existsSync(paths.db)) return { code: 1, out: ['шлюз не отвечает, базы ещё нет'] };
  const db = openDatabase(paths.db, { readOnly: true });
  try {
    // База старее кода (шлюз её ещё не обновил) — читать нечем: полей M2 в ней нет.
    if (schemaVersion(db) < SCHEMA_VERSION) return { code: 1, out: ['шлюз не отвечает, а база старой схемы — запусти шлюз: он её обновит'] };
    // Правила — рабочая копия шлюза (M5, AD-9); её нет — как их прочтёт шлюз из rules.yaml.
    let eff = parseRulesState(getMeta(db, META_KEYS.rulesState))?.rules ?? null;
    if (!eff) {
      const { rules, missing } = loadRules(paths.rules);
      eff = effectiveRules(config, missing ? defaultRules(config.owner_id) : rules).rules;
    }
    const owner = eff.subjects.find((s) => s.who === 'owner');
    const role = eff.chats.find((c) => c.chat === 'private')?.role ?? '';
    const input = {
      now: cliNow(env, paths),
      timezone: config.timezone,
      chatId: config.owner_id,
      subjectId: owner?.id ?? OWNER_SUBJECT_ID,
      defaultRole: role,
      agentOnline: null,
    };
    const text = whereText(whereData(db, input), input);
    return { code: 1, out: ['шлюз не отвечает — по базе:', ...text.split('\n')] };
  } finally {
    db.close();
  }
}
