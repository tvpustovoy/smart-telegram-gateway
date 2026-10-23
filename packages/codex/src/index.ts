#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// stg-codex — адаптер Codex (#55): подключает к шлюзу существующего агента Codex — его папку, его AGENTS.md, настройки и
// вход Codex пользователя как есть (CODEX_HOME не задаётся). Держит аренду у шлюза и дочерний `codex app-server`.
//
//   STG_HOME=<каталог бота> stg-codex --agent-dir <папка агента> [--codex <путь к codex>] [--no-color]
//
// stdout — живая лента разговора для окна терминала; stderr — технический журнал. Состояние (id треда) — в
// $STG_HOME/codex/state.json; в папку агента адаптер не пишет. Ctrl-C или SIGTERM — аренда снимается, app-server
// закрывается, процесс выходит.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gatewayFromEnv, type GatewayEnv } from 'stg-channel';
import { codexCommand } from './codex-bin.js';
import { createFeed } from './feed.js';
import { ADAPTER_NAME, Runner } from './runner.js';
import { codexTimingFromEnv } from './timing.js';

export { Runner, ADAPTER_NAME, errorKind, type RunnerOptions } from './runner.js';
export { AppServer, RpcError, parseLine } from './app-server.js';
export { codexCommand, findInPath, versionFromUserAgent, type CodexCommand } from './codex-bin.js';
export { createFeed, oneLine, NO_FEED, type Feed, type FeedKind } from './feed.js';
export { loadState, saveState, emptyState, type AdapterState } from './state.js';
export { DEFAULT_CODEX_TIMING, codexTimingFromEnv, type CodexTiming } from './timing.js';
export { dynamicTools, toToolResponse, answeredBy, refusal, describeCall } from './tools-bridge.js';

const USAGE = `stg-codex — адаптер Codex для smart-telegram-gateway

  STG_HOME=<каталог бота> stg-codex --agent-dir <папка агента> [--codex <путь к codex>] [--no-color]

  --agent-dir   папка агента Codex (его AGENTS.md, рабочий каталог команд); адаптер в неё не пишет
  --codex       codex или его codex.js; по умолчанию — codex из PATH (или STG_CODEX_BIN)
  --no-color    лента без цветов
`;

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${ADAPTER_NAME}: ${line}\n`);
}

/** Окружение app-server: как у пользователя, без наших STG_* (Codex отдаёт окружение командам модели). */
export function codexEnvOf(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('STG_')) out[k] = v;
  return out;
}

/**
 * Папка посылок и session_hint.cwd. Шлюз берёт папку посылок из config.yaml (parcels.dir), а без неё —
 * <session_hint.cwd>/parcels. Папка агента — чужой репозиторий, посылкам там не место: без parcels.dir адаптер
 * называет шлюзу каталог бота, и посылки лежат в $STG_HOME/parcels.
 */
export function parcelsLayout(gw: Pick<GatewayEnv, 'home' | 'parcelsDir'>, agentDir: string): { parcelsDir: string; hintCwd: string } {
  if (gw.parcelsDir !== null) return { parcelsDir: gw.parcelsDir, hintCwd: agentDir };
  return { parcelsDir: path.join(gw.home, 'parcels'), hintCwd: gw.home };
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: { 'agent-dir': { type: 'string' }, codex: { type: 'string' }, 'no-color': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
    }).values;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args['agent-dir']) {
    process.stderr.write(`нужен --agent-dir\n\n${USAGE}`);
    return 2;
  }
  let agentDir: string;
  try {
    agentDir = fs.realpathSync(path.resolve(args['agent-dir']));
    if (!fs.statSync(agentDir).isDirectory()) throw new Error('не каталог');
  } catch (err) {
    process.stderr.write(`папка агента ${args['agent-dir']}: ${(err as Error).message}\n`);
    return 2;
  }
  const env = process.env;
  let gw: GatewayEnv;
  try {
    gw = gatewayFromEnv(env, log);
  } catch (err) {
    process.stderr.write(`каталог бота не найден: ${(err as Error).message}. Задай STG_HOME\n`);
    return 2;
  }
  const codex = codexCommand(args.codex ?? env.STG_CODEX_BIN, env.PATH);
  if (!codex) {
    process.stderr.write('Codex не найден: поставь его (npm install -g @openai/codex) или передай --codex <путь>\n');
    return 2;
  }
  const { parcelsDir, hintCwd } = parcelsLayout(gw, agentDir);
  const color = process.stdout.isTTY === true && !args['no-color'] && !env.NO_COLOR;
  const feed = createFeed({ write: (s) => process.stdout.write(s), timezone: gw.timezone, color });
  feed.line('sys', `${ADAPTER_NAME}: бот ${path.basename(gw.home)} · Ctrl-C — остановить`);
  const runner = new Runner({
    agentDir,
    gateway: gw,
    parcelsDir,
    hintCwd,
    stateFile: path.join(gw.home, 'codex', 'state.json'),
    codex,
    codexEnv: codexEnvOf(env),
    timing: codexTimingFromEnv(env),
    botName: path.basename(gw.home),
    log,
    feed,
  });
  let stopping = false;
  const shutdown = (why: string): void => {
    if (stopping) {
      log(`${why} ещё раз — выхожу сразу`);
      process.exit(130);
    }
    stopping = true;
    log(`завершаюсь: ${why}`);
    feed.line('sys', 'останавливаюсь: аренда снимается, Codex закрывается');
    void runner.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  await runner.start();
  return -1;
}

function isEntry(): boolean {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main().then(
    (code) => {
      if (code >= 0) process.exit(code);
    },
    (err: unknown) => {
      log(`не стартовал: ${(err as Error).stack ?? (err as Error).message}`);
      process.exit(1);
    },
  );
}
