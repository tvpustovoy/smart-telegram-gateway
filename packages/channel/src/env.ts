// Где шлюз и как к нему ходить — по окружению (общее для переходников: канал Claude Code и адаптер Codex, #55). Один
// источник, чтобы шов под удалённый шлюз (#57: TLS, ключ ноутбука, пояс из welcome) менялся в одном месте, а не в каждом
// переходнике. Сейчас — локальный шлюз: STG_HOME, сокет gateway.sock, пояс и папка посылок из config.yaml.

import os from 'node:os';
import path from 'node:path';
import { isValidTimeZone, loadConfig, resolveHome, stgPaths } from 'stg-core';
import { timingFromEnv, type ChannelTiming } from './timing.js';

export interface GatewayEnv {
  /** Каталог бота (STG_HOME). */
  home: string;
  /** Сокет шлюза. */
  socketPath: string;
  /** Часовой пояс строк для агента: из config.yaml, иначе — пояс системы. */
  timezone: string;
  timing: ChannelTiming;
  /** Папка посылок из config.yaml (parcels.dir, «~/» раскрыт); null — не задана или config.yaml не прочитан. */
  parcelsDir: string | null;
}

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Шлюз по окружению. Каталог бота не найден — HomeError из stg-core (переходник решает, как сказать). config.yaml не
 * прочитан — пояс системы и папки посылок нет; причина — в log.
 */
export function gatewayFromEnv(env: NodeJS.ProcessEnv, log: (line: string) => void): GatewayEnv {
  const paths = stgPaths(resolveHome(env));
  let timezone = systemTimezone();
  let parcelsDir: string | null = null;
  try {
    const config = loadConfig(paths.config, { test: env.STG_TEST === '1' });
    if (isValidTimeZone(config.timezone)) timezone = config.timezone;
    if (config.parcels.dir !== null) parcelsDir = expandHome(config.parcels.dir);
  } catch (err) {
    log(`config.yaml не прочитан (${(err as Error).message}) — время в строках по поясу системы`);
  }
  return { home: paths.home, socketPath: paths.socket, timezone, timing: timingFromEnv(env), parcelsDir };
}
