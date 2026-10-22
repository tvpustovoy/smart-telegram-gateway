// Каталоги и имена (TECH-SPEC 5.1, 5.11).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Служба в связке ключей macOS. */
export const KEYCHAIN_SERVICE = 'smart-telegram-gateway';
/** Имя MCP-сервера канала: ключ в .mcp.json, `server:` флага, правила mcp__smart-telegram-gateway__*. */
export const CHANNEL_SERVER_NAME = 'smart-telegram-gateway';
/** Корень состояния: ~/.smart-telegram-gateway/<bot>/. */
export const STATE_ROOT_NAME = '.smart-telegram-gateway';

/** Метка службы launchd для бота ⟨реализация M0; установка — M3⟩. */
export function launchdLabel(bot: string): string {
  return `local.smart-telegram-gateway.${bot}`;
}

export interface StgPaths {
  home: string;
  config: string;
  rules: string;
  db: string;
  raw: string;
  rawClosed: string;
  backup: string;
  logs: string;
  launchdLog: string;
  socket: string;
  pid: string;
  /** Замок одного экземпляра (блокировка SQLite держится, пока жив процесс). */
  lock: string;
  /** Отметка «о сбое базы владельцу уже сказано» — чтобы перезапуски launchd не повторяли строку. */
  dbFailureMark: string;
  /** Поддельные часы (только под тестом). */
  clockFile: string;
  clockSocket: string;
}

export function stgPaths(home: string): StgPaths {
  const h = path.resolve(home);
  return {
    home: h,
    config: path.join(h, 'config.yaml'),
    rules: path.join(h, 'rules.yaml'),
    db: path.join(h, 'gateway.db'),
    raw: path.join(h, 'raw'),
    rawClosed: path.join(h, 'raw', 'closed'),
    backup: path.join(h, 'backup'),
    logs: path.join(h, 'logs'),
    launchdLog: path.join(h, 'logs', 'launchd.log'),
    socket: path.join(h, 'gateway.sock'),
    pid: path.join(h, 'gateway.pid'),
    lock: path.join(h, 'gateway.lock'),
    dbFailureMark: path.join(h, 'db-failure-notified.json'),
    clockFile: path.join(h, 'test-clock.json'),
    clockSocket: path.join(h, 'test-clock.sock'),
  };
}

export class HomeError extends Error {}

/**
 * Каталог бота: STG_HOME; иначе — единственный каталог в ~/.smart-telegram-gateway/.
 * Под тестом (STG_TEST=1) STG_HOME обязателен: тест не должен задеть настоящий каталог.
 */
export function resolveHome(env: NodeJS.ProcessEnv, explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (env.STG_HOME) return path.resolve(env.STG_HOME);
  if (env.STG_TEST === '1') throw new HomeError('под тестом нужен STG_HOME');
  const root = path.join(os.homedir(), STATE_ROOT_NAME);
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    throw new HomeError(`нет каталога ${root}: задай STG_HOME или установи шлюз`);
  }
  if (dirs.length === 1 && dirs[0]) return path.join(root, dirs[0]);
  if (dirs.length === 0) throw new HomeError(`в ${root} нет каталога бота: задай STG_HOME`);
  throw new HomeError(`в ${root} несколько ботов (${dirs.join(', ')}): задай STG_HOME`);
}
