// Установка (TECH-SPEC 5.3 «LaunchAgent», 5.12): плист службы из шаблона scripts/launchd/gateway.plist.template и
// папка агента из шаблона scripts/agent-folder/. Здесь — только сборка файлов: службу ставит и запускает
// scripts/install-macos.sh (launchctl bootstrap), по слову владельца. stg doctor читает плист этим же разбором.
// Флаги Node в плисте — GATEWAY_NODE_FLAGS (stg-core/version.ts): одно место для шебанга, тестов и службы (N-2).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL_SERVER_NAME, GATEWAY_NODE_FLAGS, ensureDir, launchdLabel, stgPaths, writeFileAtomicSync } from 'stg-core';

/** Корень репозитория: packages/cli/dist → ../../.. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PLIST_TEMPLATE = path.join(REPO_ROOT, 'scripts', 'launchd', 'gateway.plist.template');
export const AGENT_FOLDER_TEMPLATE = path.join(REPO_ROOT, 'scripts', 'agent-folder');
export const GATEWAY_ENTRY = path.join(REPO_ROOT, 'packages', 'gateway', 'dist', 'index.js');
export const CHANNEL_ENTRY = path.join(REPO_ROOT, 'packages', 'channel', 'dist', 'index.js');
export const CLI_ENTRY = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
/** Настройки строки состояния и перехватчиков агента (5.14) — для `claude --settings`, в папке агента. */
export const AGENT_STATE_SETTINGS = path.join('.claude', 'agent-state.settings.json');
/** Node из Homebrew на macOS (TECH-SPEC §6); его нет — тот Node, которым запущен stg (process.execPath). */
export const HOMEBREW_NODE = '/opt/homebrew/bin/node';

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface PlistParams {
  bot: string;
  /** Каталог бота (STG_HOME). */
  home: string;
  node: string;
  gatewayEntry?: string;
}

export function plistProgramArguments(p: PlistParams): string[] {
  return [p.node, ...GATEWAY_NODE_FLAGS, p.gatewayEntry ?? GATEWAY_ENTRY];
}

/** Плист службы по шаблону. */
export function renderGatewayPlist(p: PlistParams, template = fs.readFileSync(PLIST_TEMPLATE, 'utf8')): string {
  const home = path.resolve(p.home);
  const args = plistProgramArguments(p)
    .map((a) => `\t\t<string>${xmlEscape(a)}</string>`)
    .join('\n');
  const values: Record<string, string> = {
    LABEL: xmlEscape(launchdLabel(p.bot)),
    PROGRAM_ARGUMENTS: args,
    STG_HOME: xmlEscape(home),
    LOG: xmlEscape(stgPaths(home).launchdLog),
  };
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => {
    const v = values[k];
    if (v === undefined) throw new Error(`шаблон плиста: неизвестная подстановка ${m}`);
    return v;
  });
  return out;
}

// ——— разбор плиста (XML) для stg doctor: dict, array, string, integer, true, false ———

export type PlistValue = string | number | boolean | PlistValue[] | { [k: string]: PlistValue };

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

export class PlistError extends Error {}

/** Плист XML → значение. Только то, что пишет шаблон службы (и типичный плист launchd). */
export function parsePlist(xml: string): PlistValue {
  const body = xml
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const tokens = body.match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  const next = (): string => {
    while (i < tokens.length && /^\s*$/.test(tokens[i]!)) i++;
    if (i >= tokens.length) throw new PlistError('плист оборвался');
    return tokens[i++]!;
  };
  const text = (close: string): string => {
    let s = '';
    while (i < tokens.length && tokens[i] !== close) s += tokens[i++]!;
    if (tokens[i] !== close) throw new PlistError(`нет ${close}`);
    i++;
    return xmlUnescape(s);
  };
  const value = (tag: string): PlistValue => {
    if (tag === '<true/>') return true;
    if (tag === '<false/>') return false;
    if (tag === '<string/>') return '';
    if (tag === '<string>') return text('</string>');
    if (tag === '<integer>') return Number(text('</integer>'));
    if (tag === '<real>') return Number(text('</real>'));
    if (tag === '<array/>') return [];
    if (tag === '<dict/>') return {};
    if (tag === '<array>') {
      const out: PlistValue[] = [];
      for (;;) {
        const t = next();
        if (t === '</array>') return out;
        out.push(value(t));
      }
    }
    if (tag === '<dict>') {
      const out: { [k: string]: PlistValue } = {};
      for (;;) {
        const t = next();
        if (t === '</dict>') return out;
        if (t !== '<key>') throw new PlistError(`в dict ждал <key>, а не ${t}`);
        const k = text('</key>');
        out[k] = value(next());
      }
    }
    throw new PlistError(`не знаю ${tag}`);
  };
  const root = next();
  if (!/^<plist\b/.test(root)) throw new PlistError('нет <plist>');
  const v = value(next());
  if (next() !== '</plist>') throw new PlistError('нет </plist>');
  return v;
}

export interface PlistCheck {
  ok: boolean;
  detail: string;
  /** Node из ProgramArguments[0]. */
  node: string | null;
}

/** Плист службы годится (doctor): Node, флаги памяти, stg-gateway, KeepAlive, STG_HOME. */
export function checkGatewayPlist(xml: string, home: string): PlistCheck {
  let v: PlistValue;
  try {
    v = parsePlist(xml);
  } catch (err) {
    return { ok: false, detail: `плист не разобрался: ${(err as Error).message}`, node: null };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, detail: 'плист — не словарь', node: null };
  const args = Array.isArray(v.ProgramArguments) ? v.ProgramArguments.filter((x): x is string => typeof x === 'string') : [];
  const node = args[0] ?? null;
  const problems: string[] = [];
  if (!node) problems.push('нет ProgramArguments');
  const missing = GATEWAY_NODE_FLAGS.filter((f) => !args.slice(1, -1).includes(f));
  if (missing.length) problems.push(`нет флагов памяти: ${missing.join(' ')}`);
  const entry = args[args.length - 1] ?? '';
  if (!entry.endsWith(path.join('packages', 'gateway', 'dist', 'index.js'))) problems.push('последний аргумент — не stg-gateway');
  else if (!fs.existsSync(entry)) problems.push(`нет ${entry} (npm run build)`);
  if (v.KeepAlive !== true) problems.push('нет KeepAlive');
  const env = v.EnvironmentVariables;
  const stgHome = env && typeof env === 'object' && !Array.isArray(env) ? env.STG_HOME : undefined;
  if (typeof stgHome !== 'string' || path.resolve(stgHome) !== path.resolve(home)) problems.push(`STG_HOME в плисте — ${String(stgHome ?? 'нет')}`);
  if (problems.length) return { ok: false, detail: problems.join('; '), node };
  return { ok: true, detail: `${node} · флаги памяти (${GATEWAY_NODE_FLAGS.length}) · stg-gateway · KeepAlive`, node };
}

// ——— папка агента ———

export interface AgentFolderParams {
  dest: string;
  home: string;
  node: string;
  channelEntry?: string;
  /**
   * Прежняя строка состояния агента (5.14): undefined — найти в настройках папки (findPreviousStatusline); '' — нет,
   * своя строка.
   */
  statuslineThen?: string;
}

export interface AgentFolderResult {
  written: string[];
  kept: string[];
  /** Какая прежняя строка состояния попала в файл настроек и откуда (null — флаг или не найдена). */
  statusline: PreviousStatusline;
}

/** Файлы шаблона, которые пишутся заново при каждой установке (пути); остальное — только если их нет. */
const REWRITE = new Set(['.mcp.json', 'start.sh', AGENT_STATE_SETTINGS]);
const TEMPLATE_FILES = ['CLAUDE.md', '.mcp.json', path.join('.claude', 'settings.json'), AGENT_STATE_SETTINGS, 'start.sh'];

/** .mcp.json папки агента: ключ ровно smart-telegram-gateway (5.11). */
export function renderMcpJson(p: { node: string; channelEntry?: string; home: string }, template?: string): string {
  const raw = template ?? fs.readFileSync(path.join(AGENT_FOLDER_TEMPLATE, '.mcp.json'), 'utf8');
  const values: Record<string, string> = { NODE: p.node, CHANNEL_ENTRY: p.channelEntry ?? CHANNEL_ENTRY, STG_HOME: path.resolve(p.home) };
  const sub = (x: unknown): unknown => {
    if (typeof x === 'string') {
      return x.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => {
        const v = values[k];
        if (v === undefined) throw new Error(`шаблон .mcp.json: неизвестная подстановка ${m}`);
        return v;
      });
    }
    if (Array.isArray(x)) return x.map(sub);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, sub(v)]));
    return x;
  };
  const doc = sub(JSON.parse(raw)) as { mcpServers?: Record<string, unknown> };
  const keys = Object.keys(doc.mcpServers ?? {});
  if (keys.length !== 1 || keys[0] !== CHANNEL_SERVER_NAME) throw new Error(`шаблон .mcp.json: сервер должен быть ровно «${CHANNEL_SERVER_NAME}»`);
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Значение для командной строки sh: в одинарных кавычках, «'» внутри — «'\''». */
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export interface AgentStateSettingsParams {
  node: string;
  home: string;
  cliEntry?: string;
  /** Прежняя строка состояния (её вывод сохраняется); '' или нет — своя короткая строка. */
  statuslineThen?: string;
}

/**
 * Файл настроек строки состояния и перехватчиков агента (5.14) по шаблону: подстановки {{NODE}}, {{CLI_ENTRY}},
 * {{STG_HOME}}, {{STATUSLINE_THEN}} — в командах sh, поэтому каждое значение — в одинарных кавычках (пустая прежняя строка
 * — `--then ''`, то есть своя короткая строка).
 */
export function renderAgentStateSettings(p: AgentStateSettingsParams, template?: string): string {
  const raw = template ?? fs.readFileSync(path.join(AGENT_FOLDER_TEMPLATE, AGENT_STATE_SETTINGS), 'utf8');
  const values: Record<string, string> = {
    NODE: p.node,
    CLI_ENTRY: p.cliEntry ?? CLI_ENTRY,
    STG_HOME: path.resolve(p.home),
    STATUSLINE_THEN: p.statuslineThen ?? '',
  };
  const sub = (x: unknown): unknown => {
    if (typeof x === 'string') {
      return x.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => {
        const v = values[k];
        if (v === undefined) throw new Error(`шаблон ${AGENT_STATE_SETTINGS}: неизвестная подстановка ${m}`);
        return shellQuote(v);
      });
    }
    if (Array.isArray(x)) return x.map(sub);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, sub(v)]));
    return x;
  };
  return JSON.stringify(sub(JSON.parse(raw)), null, 2) + '\n';
}

export interface PreviousStatusline {
  /** Команда прежней строки; '' — нет (своя строка). */
  command: string;
  /** Откуда: путь к файлу настроек; 'flag' — задана флагом; null — не найдена. */
  from: string | null;
  /** Где искали (по порядку) — для строки «не найдена». */
  looked: string[];
}

/** Своя команда (`agent-state statusline`) — не прежняя строка: иначе строка звала бы сама себя. */
function isOwnStatusline(cmd: string): boolean {
  return cmd.includes('agent-state statusline');
}

function statuslineCommandOf(file: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { statusLine?: { type?: string; command?: unknown } };
    const cmd = v.statusLine?.command;
    return typeof cmd === 'string' && cmd.trim() && !isOwnStatusline(cmd) ? cmd.trim() : null;
  } catch {
    return null; // нет файла или не JSON
  }
}

/** `--then '<…>'` из нашего прежнего файла настроек (значение в кавычках sh, как пишет shellQuote). */
function thenFromOwnSettings(file: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { statusLine?: { command?: unknown } };
    const cmd = v.statusLine?.command;
    if (typeof cmd !== 'string' || !isOwnStatusline(cmd)) return null;
    const m = /\s--then\s+'((?:[^']|'\\'')*)'\s*$/.exec(cmd);
    const then = m ? m[1]!.replace(/'\\''/g, "'") : '';
    return then.trim() && !isOwnStatusline(then) ? then.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Прежняя строка состояния сессии агента — команда statusLine из её настроек Claude Code, в порядке старшинства Claude
 * Code: `.claude/settings.local.json` папки → `.claude/settings.json` папки → настройки пользователя
 * (`<userConfigDir>/settings.json`: у шаблона это `.claude-config/` папки — его задаёт start.sh) ⟨предл.⟩. Не нашлась —
 * `--then` из нашего прежнего `.claude/agent-state.settings.json` (её задали флагом при прошлом развёртывании). Нет
 * нигде — command ''.
 */
export function findPreviousStatusline(dest: string, userConfigDir = path.join(dest, '.claude-config')): PreviousStatusline {
  const files = [path.join(dest, '.claude', 'settings.local.json'), path.join(dest, '.claude', 'settings.json'), path.join(userConfigDir, 'settings.json')];
  for (const f of files) {
    const cmd = statuslineCommandOf(f);
    if (cmd) return { command: cmd, from: f, looked: files };
  }
  const own = path.join(dest, AGENT_STATE_SETTINGS);
  const then = thenFromOwnSettings(own);
  if (then) return { command: then, from: own, looked: [...files, own] };
  return { command: '', from: null, looked: [...files, own] };
}

/** Строка для владельца: какая прежняя строка состояния попала в файл настроек. */
export function describePreviousStatusline(p: PreviousStatusline, base?: string): string {
  const rel = (f: string): string => (base ? path.relative(base, f) || f : f);
  if (p.from === 'flag') return p.command ? `прежняя строка состояния: ${p.command} (задана флагом)` : 'прежняя строка состояния: нет (--statusline-then \'\') — внизу экрана агента своя строка';
  if (p.command && p.from) return `прежняя строка состояния: ${p.command} (из ${rel(p.from)})`;
  return `прежняя строка состояния: не найдена (смотрел ${p.looked.map(rel).join(', ')}) — внизу экрана агента будет своя строка; если была другая (claude-hud и т. п.) — --statusline-then '<команда>'`;
}

/** Развернуть шаблон папки агента. CLAUDE.md и .claude/settings.json владельца не перезаписываются. */
export function deployAgentFolder(p: AgentFolderParams): AgentFolderResult {
  const dest = path.resolve(p.dest);
  ensureDir(dest);
  // Прежняя строка — до записи файлов: наш прежний файл настроек ещё не переписан.
  const statusline: PreviousStatusline = p.statuslineThen !== undefined ? { command: p.statuslineThen.trim(), from: 'flag', looked: [] } : findPreviousStatusline(dest);
  const statuslineThen = statusline.command;
  const res: AgentFolderResult = { written: [], kept: [], statusline };
  for (const rel of TEMPLATE_FILES) {
    const to = path.join(dest, rel);
    if (fs.existsSync(to) && !REWRITE.has(rel)) {
      res.kept.push(rel);
      continue;
    }
    ensureDir(path.dirname(to));
    const from = path.join(AGENT_FOLDER_TEMPLATE, rel);
    const content =
      rel === '.mcp.json'
        ? renderMcpJson({ node: p.node, home: p.home, ...(p.channelEntry ? { channelEntry: p.channelEntry } : {}) })
        : rel === AGENT_STATE_SETTINGS
          ? renderAgentStateSettings({ node: p.node, home: p.home, statuslineThen })
          : fs.readFileSync(from, 'utf8');
    writeFileAtomicSync(to, content, rel === 'start.sh' ? 0o755 : 0o644);
    if (rel === 'start.sh') fs.chmodSync(to, 0o755);
    res.written.push(rel);
  }
  // parcels/ — папка посылок (0.3.3, 5.16): файлы, которые агент отдаёт владельцу (send_file).
  for (const dir of ['notes', 'parcels']) {
    const d = path.join(dest, dir);
    if (!fs.existsSync(d)) {
      ensureDir(d);
      res.written.push(`${dir}/`);
    } else res.kept.push(`${dir}/`);
  }
  return res;
}
