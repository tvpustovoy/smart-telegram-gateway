// MCP-сервер «smart-telegram-gateway» (TECH-SPEC 5.11) на @modelcontextprotocol/sdk 1.x (закреплён): возможность
// канала `capabilities.experimental['claude/channel'] = {}` и инструменты (`capabilities.tools`); события шлюза —
// уведомлениями `notifications/claude/channel` {content, meta}. hello шлюзу — после уведомления `initialized` от Claude
// Code (жизненный цикл MCP): до него уведомлениям некуда идти. `claude/channel/permission` в 0.1 не объявляется: текст в
// личке, в том числе «yes …», ничего не разрешает.
// Почему SDK 1.x: на runtime v2 Claude Code не регистрирует каналом сервер, договорившийся о ревизии MCP 2026-07-28;
// 1.32.1 знает ревизии до 2025-11-25.

import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { CHANNEL_SERVER_NAME, PRODUCT_VERSION, type Mode } from 'stg-core';
import { CHANNEL_NOTIFICATION, formatEvent, formatMode, type ChannelNotice } from './format.js';
import { GatewayClient } from './gateway-client.js';
import { INSTRUCTIONS, INSTRUCTIONS_VERSION } from './instructions.js';
import type { ChannelTiming } from './timing.js';
import { TOOLS, callTool } from './tools.js';

/** Имя пакета — stg-channel; имя сервера — smart-telegram-gateway (ключ в .mcp.json и `server:` флага). */
export const PACKAGE_NAME = 'stg-channel';
export const SERVER_NAME = CHANNEL_SERVER_NAME;

export interface ChannelOptions {
  socketPath: string;
  timezone: string;
  timing: ChannelTiming;
  log: (line: string) => void;
  /** Ключ процесса канала (0.3.2); по умолчанию — случайный при создании. */
  instanceId?: string;
}

export interface Channel {
  server: Server;
  client: GatewayClient;
  connect(transport: Transport): Promise<void>;
  /** Канал завершается (закрыт stdin): аренда снимается. */
  stop(): Promise<void>;
}

export function createChannel(opts: ChannelOptions): Channel {
  const server = new Server(
    { name: SERVER_NAME, version: PRODUCT_VERSION },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions: INSTRUCTIONS,
    },
  );
  const push = async (n: ChannelNotice): Promise<void> => {
    await server.notification({ method: CHANNEL_NOTIFICATION, params: n } as unknown as ServerNotification);
  };
  const client = new GatewayClient({
    socketPath: opts.socketPath,
    adapter: PACKAGE_NAME,
    timing: opts.timing,
    hint: { cwd: process.cwd(), pid: process.pid },
    // Ключ процесса канала (0.3.2, R-4 а): тот же процесс — та же сессия Claude Code; шлюз не шлёт пробу при
    // переподключении. Только в памяти — ни в журнал, ни на диск.
    instanceId: opts.instanceId ?? crypto.randomBytes(18).toString('base64url'),
    // Версия своих instructions (0.3.5, issue #47): продолженному разговору Claude Code их не передаёт — шлюз пришлёт
    // событием «правила канала», если разговор этой версии не получал.
    instructionsVersion: INSTRUCTIONS_VERSION,
    log: opts.log,
    onEvent: async (ev) => {
      await push(formatEvent(ev));
      return true;
    },
    onMode: (state: Mode, _turn: number, previous: Mode | null) => {
      // Смена режима — служебное уведомление в сессию; первое known — running по умолчанию.
      if (state === (previous ?? 'running')) return;
      const n = formatMode(state, previous ?? 'running');
      if (n) void push(n).catch((err: unknown) => opts.log(`режим в сессию не ушёл: ${(err as Error).message}`));
    },
  });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const out = await callTool(
      { client, timezone: opts.timezone, log: opts.log, mediaTimeoutMs: opts.timing.mediaTimeoutMs },
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
    );
    const first = out.content.find((c) => c.type === 'text');
    const images = out.content.filter((c) => c.type === 'image').length;
    opts.log(`инструмент ${req.params.name}: ${out.isError ? 'отказ' : 'ок'} — ${first?.type === 'text' ? first.text.slice(0, 120) : ''}${images ? ` (+ картинка)` : ''}`);
    return out;
  });
  server.oninitialized = () => {
    opts.log('initialized от Claude Code — hello шлюзу');
    client.start();
  };
  return {
    server,
    client,
    connect: (transport) => server.connect(transport),
    stop: async () => {
      await client.stop();
    },
  };
}
