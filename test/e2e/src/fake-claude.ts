// Поддельный Claude Code (ACCEPTANCE M3, уровень И): клиент MCP SDK запускает stg-channel так же, как Claude Code по
// .mcp.json папки агента — `node packages/channel/dist/index.js`, STG_HOME, stdio; ловит уведомления
// notifications/claude/channel и вызывает инструменты. Настоящий claude не запускается.
// Поведение «сессии с флагом канала»: на событие probe сам вызывает done (как велят instructions); «без флага» —
// уведомления копятся, а на probe никто не отвечает (autoProbe: false).

import { createRequire } from 'node:module';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Каталог бота (как TestHome обвязки; здесь — без неё: прогон drill-m3 обвязку тестов не грузит). */
export interface ChannelHome {
  dir: string;
}

/** Ждать условия по настоящему времени. */
async function waitUntil<T>(fn: () => T | null | undefined | false, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`не дождались ${what} за ${timeoutMs} мс`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const require = createRequire(import.meta.url);
export const CHANNEL_ENTRY = path.join(path.dirname(require.resolve('stg-channel/package.json')), 'dist', 'index.js');

export interface ChannelNotice {
  content: string;
  meta: Record<string, string>;
  at: number;
}

export interface FakeClaudeOptions {
  /** На probe — done сам (сессия с флагом канала). */
  autoProbe?: boolean;
  /** Множитель сроков канала (STG_TEST_CHANNEL_TIME_SCALE). */
  timeScale?: number;
  env?: Record<string, string>;
}

export class FakeClaude {
  readonly notices: ChannelNotice[] = [];
  readonly probeResults: string[] = [];
  stderr = '';
  private closed = false;

  private constructor(
    readonly client: Client,
    readonly transport: StdioClientTransport,
  ) {}

  /** Запустить канал и пройти инициализацию MCP (initialize → initialized). */
  static async start(home: ChannelHome, opts: FakeClaudeOptions = {}): Promise<FakeClaude> {
    const env: Record<string, string> = {
      STG_HOME: home.dir,
      STG_TEST: '1',
      STG_TEST_CHANNEL_TIME_SCALE: String(opts.timeScale ?? 0.1),
      ...opts.env,
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', CHANNEL_ENTRY],
      env,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'fake-claude-code', version: '0.0.0' }, { capabilities: {} });
    const fc = new FakeClaude(client, transport);
    transport.stderr?.on('data', (d: Buffer) => (fc.stderr += d.toString()));
    client.fallbackNotificationHandler = async (n) => {
      if (n.method !== 'notifications/claude/channel') return;
      const p = (n.params ?? {}) as { content?: unknown; meta?: unknown };
      const notice: ChannelNotice = {
        content: String(p.content),
        meta: (p.meta ?? {}) as Record<string, string>,
        at: Date.now(),
      };
      fc.notices.push(notice);
      if (notice.meta.kind === 'probe' && opts.autoProbe !== false) {
        // Как модель: № и код — из текста события.
        const code = /code: "([^"]+)"/.exec(notice.content)?.[1];
        void fc.call('done', { seqs: [Number(notice.meta.seq)], ...(code ? { code } : {}) }).then(
          (t) => fc.probeResults.push(t.text),
          () => undefined,
        );
      }
    };
    await client.connect(transport);
    return fc;
  }

  get pid(): number | undefined {
    return this.transport.pid ?? undefined;
  }

  /** Уведомления о событиях (без probe и без строк режима). */
  events(): ChannelNotice[] {
    return this.notices.filter((n) => n.meta.kind !== 'probe' && n.meta.kind !== 'mode');
  }

  probes(): ChannelNotice[] {
    return this.notices.filter((n) => n.meta.kind === 'probe');
  }

  waitNotice(pred: (n: ChannelNotice) => boolean, timeoutMs = 10_000, what = 'уведомления канала'): Promise<ChannelNotice> {
    return waitUntil(() => this.notices.find(pred), timeoutMs, `${what}; stderr канала: ${this.stderr.slice(-600)}`);
  }

  /** Дождаться события с этим №. */
  waitEvent(seq: number, timeoutMs = 10_000): Promise<ChannelNotice> {
    return this.waitNotice((n) => n.meta.seq === String(seq) && n.meta.kind !== 'probe', timeoutMs, `события № ${seq}`);
  }

  /** Аренда проверена: проба пришла и done на неё прошёл. */
  async waitVerified(timeoutMs = 10_000): Promise<void> {
    await waitUntil(() => this.probeResults.some((t) => t.startsWith('отмечено')), timeoutMs, `done на пробу; stderr канала: ${this.stderr.slice(-600)}`);
  }

  /** Вызвать инструмент; исход — текстом и признаком ошибки. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const r = (await this.client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError === true };
  }

  /** Вызвать инструмент и получить содержимое как есть (текст и картинки — media, 0.3). */
  async callRaw(name: string, args: Record<string, unknown> = {}): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError: boolean }> {
    const r = (await this.client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
    return { content: r.content, isError: r.isError === true };
  }

  /** Claude Code закрылся: stdin канала закрыт (канал должен выйти сам). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
  }
}
