// stg service plist · stg agent-folder · stg agent-state settings (TECH-SPEC 5.3, 5.12, 5.14): сборка файлов установки.
// Ничего не ставит и не запускает — это делает scripts/install-macos.sh (launchctl bootstrap), по слову владельца;
// настройки строки состояния к работающей сессии подключает человек (`claude --resume … --settings <файл>`).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveHome, stgPaths } from 'stg-core';
import type { CmdResult } from './backup.js';
import {
  AGENT_STATE_SETTINGS,
  CHANNEL_ENTRY,
  CLI_ENTRY,
  HOMEBREW_NODE,
  deployAgentFolder,
  describePreviousStatusline,
  findPreviousStatusline,
  renderAgentStateSettings,
  renderGatewayPlist,
  type PreviousStatusline,
} from './service.js';

interface InstallFlags {
  node: string;
  rest: string[];
  statuslineThen: string | undefined;
  agentDir: string | undefined;
  claudeConfig: string | undefined;
}

function takeNode(args: string[]): InstallFlags {
  const rest: string[] = [];
  let node = fs.existsSync(HOMEBREW_NODE) ? HOMEBREW_NODE : process.execPath;
  let statuslineThen: string | undefined;
  let agentDir: string | undefined;
  let claudeConfig: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--node') node = args[++i] ?? node;
    else if (args[i] === '--statusline-then') statuslineThen = args[++i] ?? '';
    else if (args[i] === '--agent-dir') agentDir = args[++i];
    else if (args[i] === '--claude-config') claudeConfig = args[++i];
    else rest.push(args[i]!);
  }
  return { node, rest, statuslineThen, agentDir, claudeConfig };
}

/** Плист службы — на stdout (install-macos.sh кладёт его в ~/Library/LaunchAgents/). */
export async function runServicePlist(env: NodeJS.ProcessEnv, args: string[], home?: string): Promise<CmdResult> {
  const { node, rest, statuslineThen, agentDir, claudeConfig } = takeNode(args);
  const extra = statuslineThen !== undefined ? '--statusline-then' : agentDir !== undefined ? '--agent-dir' : claudeConfig !== undefined ? '--claude-config' : undefined;
  if (rest.length || extra) return { code: 2, out: [`stg service plist: не знаю аргумент «${rest[0] ?? extra}»`] };
  const paths = stgPaths(resolveHome(env, home));
  const config = loadConfig(paths.config, { test: env.STG_TEST === '1' });
  return { code: 0, out: [renderGatewayPlist({ bot: config.bot, home: paths.home, node }).replace(/\n$/, '')] };
}

/** Развернуть шаблон папки агента; пути в .mcp.json — этого репозитория, Node и каталог бота. */
export async function runAgentFolder(env: NodeJS.ProcessEnv, args: string[], home?: string): Promise<CmdResult> {
  const { node, rest, statuslineThen, agentDir, claudeConfig } = takeNode(args);
  if (rest.length !== 1 || agentDir !== undefined || claudeConfig !== undefined) {
    return { code: 2, out: ['stg agent-folder <папка> [--node <путь>] [--statusline-then <команда>] [--home <каталог бота>]'] };
  }
  const paths = stgPaths(resolveHome(env, home));
  if (!fs.existsSync(CHANNEL_ENTRY)) return { code: 1, out: [`нет ${CHANNEL_ENTRY}: сначала npm run build`] };
  const r = deployAgentFolder({ dest: rest[0]!, home: paths.home, node, ...(statuslineThen !== undefined ? { statuslineThen } : {}) });
  return {
    code: 0,
    out: [
      `папка агента: ${rest[0]}`,
      ...r.written.map((f) => `  записан  ${f}`),
      ...r.kept.map((f) => `  оставлен ${f} (уже был)`),
      `канал: ${node} ${CHANNEL_ENTRY}; STG_HOME=${paths.home}`,
      `строка состояния и перехватчики агента: ${path.join(rest[0]!, AGENT_STATE_SETTINGS)} (start.sh подключает его флагом --settings)`,
      describePreviousStatusline(r.statusline, path.resolve(rest[0]!)),
    ],
  };
}

/**
 * Файл настроек строки состояния и перехватчиков агента (5.14) — на stdout: для сессии, которая уже работает и
 * развёрнута не этим шаблоном (`claude --resume <id> --settings <файл>`). Какая прежняя строка состояния попала в файл —
 * строкой в stderr (stdout — сам файл). Прежняя строка: --statusline-then; или найти в папке сессии (--agent-dir) в
 * порядке старшинства Claude Code — `.claude/settings.local.json`, `.claude/settings.json`, настройки пользователя
 * сессии: --claude-config, иначе `.claude-config/` папки (если есть — так у шаблона), иначе CLAUDE_CONFIG_DIR, иначе
 * `~/.claude` ⟨предл.⟩.
 */
export async function runAgentStateSettings(env: NodeJS.ProcessEnv, args: string[], home?: string): Promise<CmdResult> {
  const { node, rest, statuslineThen, agentDir, claudeConfig } = takeNode(args);
  if (rest.length) return { code: 2, out: [`stg agent-state settings: не знаю аргумент «${rest[0]}»`] };
  const paths = stgPaths(resolveHome(env, home));
  if (!fs.existsSync(CLI_ENTRY)) return { code: 1, out: [`нет ${CLI_ENTRY}: сначала npm run build`] };
  let prev: PreviousStatusline;
  if (statuslineThen !== undefined) prev = { command: statuslineThen.trim(), from: 'flag', looked: [] };
  else if (agentDir) {
    const dir = path.resolve(agentDir);
    const userDir = claudeConfig
      ? path.resolve(claudeConfig)
      : fs.existsSync(path.join(dir, '.claude-config'))
        ? path.join(dir, '.claude-config')
        : env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
    prev = findPreviousStatusline(dir, userDir);
  } else prev = { command: '', from: null, looked: [] };
  const text = renderAgentStateSettings({ node, home: paths.home, statuslineThen: prev.command });
  const note =
    prev.from === null && !agentDir
      ? "прежняя строка состояния: не задана — внизу экрана агента будет своя строка; сохранить прежнюю (claude-hud и т. п.): --statusline-then '<команда>' или --agent-dir <папка сессии>"
      : describePreviousStatusline(prev);
  return { code: 0, out: [text.replace(/\n$/, '')], err: [`stg agent-state settings: ${note}`] };
}
