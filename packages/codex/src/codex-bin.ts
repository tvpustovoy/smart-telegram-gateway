// Где Codex и как его запустить (#55). Обёртка npm (`@openai/codex/bin/codex.js`) начинается с `#!/usr/bin/env node`, а
// PATH у службы короткий: если codex — это скрипт .js, адаптер запускает его тем же Node, что и себя. Обёртка отдаёт
// stdio бинарю напрямую, так что закрытие stdin доходит до app-server.
// Из подкоманд Codex адаптер запускает только `app-server` (stdio).

import fs from 'node:fs';
import path from 'node:path';

export interface CodexCommand {
  command: string;
  args: string[];
  /** Что показать в журнале: путь к codex. */
  display: string;
}

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** codex в PATH: первый исполняемый файл с этим именем. */
export function findInPath(name: string, envPath: string | undefined): string | null {
  for (const dir of (envPath ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (isExecutableFile(p)) return p;
  }
  return null;
}

/**
 * Команда запуска `codex app-server`. explicit — путь из --codex или STG_CODEX_BIN; иначе codex из PATH. Скрипт .js
 * (.mjs, .cjs) — через node (nodePath, по умолчанию — этот же Node). null — Codex не найден.
 */
export function codexCommand(explicit: string | undefined, envPath: string | undefined, nodePath = process.execPath): CodexCommand | null {
  const found = explicit ? path.resolve(explicit) : findInPath('codex', envPath);
  if (!found || !fs.existsSync(found)) return null;
  let real = found;
  try {
    real = fs.realpathSync(found);
  } catch {
    // висячая ссылка — как есть: запуск скажет, что не так
  }
  if (/\.(c|m)?js$/.test(real)) return { command: nodePath, args: [real, 'app-server'], display: real };
  return { command: real, args: ['app-server'], display: real };
}

/** Версия Codex из userAgent ответа initialize: «stg-codex/0.163.0 (Mac OS …)» → «0.163.0». */
export function versionFromUserAgent(userAgent: string | undefined): string | null {
  const m = /^[^/\s]+\/(\d+\.\d+\.\d+[^\s(]*)/.exec(userAgent ?? '');
  return m ? m[1]! : null;
}
