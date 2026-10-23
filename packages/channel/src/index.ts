#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// stg-channel — MCP-сервер «smart-telegram-gateway», переходник к Claude Code (TECH-SPEC 5.11). Его запускает Claude
// Code по .mcp.json папки агента: `node <репо>/packages/channel/dist/index.js`, STG_HOME — каталог бота. Канал держит
// аренду у шлюза (gateway.sock), толкает события в сессию и даёт агенту инструменты. Завершается, когда закрыт его stdin
// (Claude Code закрылся). stdout у MCP-сервера занят протоколом: журнал — только в stderr.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PROTOCOL_VERSION } from 'stg-core';
import { gatewayFromEnv } from './env.js';
import { createChannel, PACKAGE_NAME, SERVER_NAME } from './server.js';

export { createChannel, PACKAGE_NAME, SERVER_NAME } from './server.js';
export { formatEvent, formatMode, CHANNEL_NOTIFICATION, OUTCOME, type ChannelNotice } from './format.js';
export { TOOLS, TOOL_NAMES, callTool, toolsFor, type CallContext, type ToolContent, type ToolDef, type ToolName, type ToolOutcome } from './tools.js';
export { INSTRUCTIONS, INSTRUCTIONS_VERSION, instructionsFor, instructionsVersionOf, type Harness } from './instructions.js';
export { DEFAULT_TIMING, timingFromEnv, type ChannelTiming } from './timing.js';
// Общее для переходников (#55: адаптер Codex берёт клиент шлюза, инструменты и формат событий отсюда, а не копией).
export { GatewayClient, GatewayGoneError, GatewayLostError, GatewayTimeoutError, type ClientState, type GatewayClientOptions } from './gateway-client.js';
export { gatewayFromEnv, type GatewayEnv } from './env.js';
export const ADAPTER_PROTOCOL_VERSION = PROTOCOL_VERSION;

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${PACKAGE_NAME}: ${line}\n`);
}

async function main(): Promise<number> {
  let gw: ReturnType<typeof gatewayFromEnv>;
  try {
    gw = gatewayFromEnv(process.env, log);
  } catch (err) {
    log(`каталог бота не найден: ${(err as Error).message}. Задай STG_HOME в .mcp.json папки агента`);
    return 2;
  }
  const { socketPath, timezone, timing } = gw;
  const channel = createChannel({ socketPath, timezone, timing, log });
  const transport = new StdioServerTransport();
  let stopping = false;
  const shutdown = (why: string): void => {
    if (stopping) return;
    stopping = true;
    log(`завершаюсь: ${why}`);
    void channel.stop().finally(() => process.exit(0));
  };
  // Claude Code закрылся (или убит): stdin закрыт — аренда снимается, процесс выходит (5.10).
  process.stdin.on('end', () => shutdown('stdin закрыт'));
  process.stdin.on('close', () => shutdown('stdin закрыт'));
  process.stdout.on('error', () => shutdown('stdout закрыт'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  transport.onclose = () => shutdown('транспорт MCP закрыт');
  await channel.connect(transport);
  log(`сервер «${SERVER_NAME}» запущен; сокет шлюза ${socketPath}; hello — после initialized`);
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
      log(`не стартовал: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
