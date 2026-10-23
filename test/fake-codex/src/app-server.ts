#!/usr/bin/env node
// Поддельный `codex app-server` (#55): JSON-RPC построчно по stdio, как настоящий 0.163, и «модель» по сценарию в тексте
// ввода. Запускается адаптером stg-codex вместо Codex (--codex <этот файл>): `node app-server.js app-server`.
//
// Окружение:
//   FAKE_CODEX_DIR         каталог подделки: threads.json (треды переживают перезапуск процесса), log.jsonl (что пришло
//                          и что ответил адаптер), метки «уже падал»
//   FAKE_CODEX_NO_ACCOUNT  1 — account/read без входа
//   FAKE_CODEX_VERSION     версия в userAgent (по умолчанию 0.163.0)
//   FAKE_CODEX_DOWN_FLAG   путь к файлу: пока он есть, «Codex» не поднимается — процесс сразу выходит с кодом 1
//
// «Модель» читает события в тексте ввода — «[№ N · …] текст» — и по каждому, по порядку:
//   по умолчанию        reply(seq: N, text: «ответ на № N»)
//   «молчи»             ничего (ход кончается без ответа); на напоминание адаптера — reply «ответ после напоминания на № N»
//   «долго»             ждёт 1,5 с, затем reply (пока ждёт, адаптер может добавить ввод в ход)
//   «жди»               ждёт до turn/interrupt; тогда — поздний reply из прерванного хода, затем ход interrupted
//   «упади»             один раз: процесс выходит посреди хода (код 3); после перезапуска — как по умолчанию
//   «лимит»             один раз: ход кончается failed с usageLimitExceeded
//   «файл»              пишет файл в первую writable root треда (папку посылок) и send_file(<посылка>/<файл>, seq)
//   «картинка»          media(seq: N) и reply о том, что пришло (текст и картинка)
//   «медленно»          ответ на turn/start — через 0,8 с (проверка: delivered — только после ответа)
//   «промежуточно»      сразу reply «смотрю, № N», затем ход идёт молча, пока в каталоге подделки нет файла go-<N>
//                       (или до turn/interrupt, не дольше 60 с), — и reply «ответ на № N»; с «пульс» — не молча:
//                       пока ждёт, каждые 30 мс признак жизни (item/reasoning/summaryTextDelta), как Codex за работой
//   «нарисуй»           сразу reply «Нарисую, № N»; затем картинка, как у Codex 0.163: item/started imageGeneration
//                       (status in_progress), пока нет файла img-<N> — item/completed (completed, savedPath); затем ждёт
//                       go-<N> — и reply «ответ на № N» (оба ожидания — до turn/interrupt, не дольше 60 с)
// Повтор шлюза («повтор: проверь, не сделано ли уже») — всегда reply сразу, без «жди» и «молчи».

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DIR = process.env.FAKE_CODEX_DIR ?? process.cwd();
const LOG = path.join(DIR, 'log.jsonl');
const THREADS = path.join(DIR, 'threads.json');
const VERSION = process.env.FAKE_CODEX_VERSION ?? '0.163.0';

interface ThreadRec {
  cwd: string;
  developerInstructions: string;
  tools: string[];
  writableRoots: string[];
}

interface FakeTurn {
  id: string;
  threadId: string;
  inputs: Array<{ text: string; clientId: string | null }>;
  interrupted: boolean;
  onInterrupt: Array<() => void>;
}

function log(entry: Record<string, unknown>): void {
  fs.appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, at: Date.now(), ...entry })}\n`);
}

const DOWN_FLAG = process.env.FAKE_CODEX_DOWN_FLAG;
if (DOWN_FLAG && fs.existsSync(DOWN_FLAG)) {
  log({ dir: 'down' });
  process.stderr.write('fake codex: down\n');
  process.exit(1);
}

function loadThreads(): Record<string, ThreadRec> {
  try {
    return JSON.parse(fs.readFileSync(THREADS, 'utf8')) as Record<string, ThreadRec>;
  } catch {
    return {};
  }
}

function saveThreads(t: Record<string, ThreadRec>): void {
  fs.writeFileSync(THREADS, JSON.stringify(t, null, 2));
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function notify(method: string, params: Record<string, unknown>): void {
  send({ method, params });
}

let experimental = false;
let threadId: string | null = null;
let active: FakeTurn | null = null;
let serverReq = 0;
let idSeq = 0;
const waiting = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();

function newId(prefix: string): string {
  return `${prefix}-${process.pid}-${++idSeq}`;
}

function serverRequest(method: string, params: Record<string, unknown>): Promise<{ result?: unknown; error?: unknown }> {
  const id = serverReq++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ id, method, params });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function marker(name: string): boolean {
  const f = path.join(DIR, `once-${name}`);
  if (fs.existsSync(f)) return false;
  fs.writeFileSync(f, String(process.pid));
  return true;
}

async function toolCall(turn: FakeTurn, tool: string, args: Record<string, unknown>): Promise<{ result?: unknown; error?: unknown }> {
  const callId = newId('call');
  notify('item/started', { threadId: turn.threadId, turnId: turn.id, item: { type: 'dynamicToolCall', id: callId, tool, arguments: args, status: 'inProgress' } });
  const r = await serverRequest('item/tool/call', { threadId: turn.threadId, turnId: turn.id, callId, namespace: null, tool, arguments: args });
  log({ dir: 'tool-result', tool, args, turnId: turn.id, result: r.result ?? null, error: r.error ?? null });
  notify('item/completed', { threadId: turn.threadId, turnId: turn.id, item: { type: 'dynamicToolCall', id: callId, tool, status: 'completed', success: (r.result as { success?: boolean } | undefined)?.success ?? false } });
  return r;
}

interface Ev {
  seq: number;
  head: string;
  text: string;
}

/** События в тексте ввода: «[№ N · …] текст» до следующего заголовка. */
function eventsOf(text: string): Ev[] {
  const out: Ev[] = [];
  const re = /^\[№ (\d+)([^\]\n]*)\] ?/gm;
  const marks: Array<{ seq: number; head: string; start: number; bodyStart: number }> = [];
  for (let m = re.exec(text); m; m = re.exec(text)) marks.push({ seq: Number(m[1]), head: m[2] ?? '', start: m.index, bodyStart: m.index + m[0].length });
  for (let i = 0; i < marks.length; i++) {
    const mk = marks[i]!;
    const end = i + 1 < marks.length ? marks[i + 1]!.start : text.length;
    out.push({ seq: mk.seq, head: mk.head, text: text.slice(mk.bodyStart, end).trim() });
  }
  return out;
}

function threadRoots(): string[] {
  return threadId ? (loadThreads()[threadId]?.writableRoots ?? []) : [];
}

/** Ход ждёт файла name в каталоге подделки (или turn/interrupt, не дольше 60 с); pulse — с признаками жизни каждые 30 мс. */
async function waitGate(turn: FakeTurn, name: string, pulse = false): Promise<void> {
  const gate = path.join(DIR, name);
  const until = Date.now() + 60_000;
  const itemId = newId('rs');
  while (!turn.interrupted && !fs.existsSync(gate) && Date.now() < until) {
    if (pulse) notify('item/reasoning/summaryTextDelta', { threadId: turn.threadId, turnId: turn.id, itemId, delta: '…', summaryIndex: 0 });
    await sleep(pulse ? 30 : 20);
  }
}

async function handleInput(turn: FakeTurn, text: string): Promise<'crash' | 'fail' | null> {
  const remind = /^\[адаптер · напоминание\][^\n]*/m.exec(text);
  if (remind) {
    for (const m of remind[0].matchAll(/(\d+)/g)) {
      const seq = Number(m[1]);
      await toolCall(turn, 'reply', { seq, text: `ответ после напоминания на № ${seq}` });
    }
  }
  for (const ev of eventsOf(text)) {
    if (turn.interrupted) return null;
    const repeat = ev.head.includes('повтор');
    const body = ev.text;
    if (!repeat && body.includes('упади') && marker('crash')) {
      log({ dir: 'crash', seq: ev.seq });
      process.exit(3);
    }
    if (!repeat && body.includes('лимит') && marker('limit')) return 'fail';
    if (!repeat && body.includes('молчи')) continue;
    if (!repeat && body.includes('жди')) {
      await new Promise<void>((resolve) => {
        turn.onInterrupt.push(resolve);
        setTimeout(resolve, 20_000).unref();
      });
      // Вызов, который был «в пути», когда пришёл стоп: адаптер должен отказать сам.
      await toolCall(turn, 'reply', { seq: ev.seq, text: `поздно: ответ на № ${ev.seq}` });
      return null;
    }
    if (!repeat && body.includes('промежуточно')) {
      await toolCall(turn, 'reply', { seq: ev.seq, text: `смотрю, № ${ev.seq}` });
      await waitGate(turn, `go-${ev.seq}`, body.includes('пульс'));
      if (turn.interrupted) return null;
    }
    if (!repeat && body.includes('нарисуй')) {
      await toolCall(turn, 'reply', { seq: ev.seq, text: `Нарисую, № ${ev.seq}` });
      const id = newId('ig');
      notify('item/started', { threadId: turn.threadId, turnId: turn.id, startedAtMs: Date.now(), item: { type: 'imageGeneration', id, status: 'in_progress', revisedPrompt: null, result: '' } });
      await waitGate(turn, `img-${ev.seq}`);
      if (turn.interrupted) return null;
      notify('item/completed', {
        threadId: turn.threadId,
        turnId: turn.id,
        completedAtMs: Date.now(),
        item: { type: 'imageGeneration', id, status: 'completed', revisedPrompt: 'кот', result: 'iVBORw0KGgo=', savedPath: path.join(DIR, `${id}.png`) },
      });
      await waitGate(turn, `go-${ev.seq}`);
      if (turn.interrupted) return null;
    }
    if (!repeat && body.includes('долго')) await sleep(1500);
    if (turn.interrupted) return null;
    if (body.includes('файл')) {
      const root = threadRoots()[0];
      if (root) {
        fs.mkdirSync(path.join(root, 'p1'), { recursive: true });
        fs.writeFileSync(path.join(root, 'p1', 'report.txt'), `отчёт для № ${ev.seq}\n`);
      }
      await toolCall(turn, 'send_file', { path: 'p1/report.txt', seq: ev.seq, caption: 'отчёт' });
      continue;
    }
    if (body.includes('картинка')) {
      const r = await toolCall(turn, 'media', { seq: ev.seq });
      const items = ((r.result as { contentItems?: Array<{ type: string; imageUrl?: string }> } | undefined)?.contentItems ?? []).map((c) =>
        c.type === 'inputImage' ? `inputImage:${(c.imageUrl ?? '').slice(0, 22)}` : c.type,
      );
      await toolCall(turn, 'reply', { seq: ev.seq, text: `вижу: ${items.join(', ')}` });
      continue;
    }
    await toolCall(turn, 'reply', { seq: ev.seq, text: `ответ на № ${ev.seq}` });
  }
  return null;
}

async function runTurn(turn: FakeTurn): Promise<void> {
  notify('turn/started', { threadId: turn.threadId, turn: { id: turn.id, status: 'inProgress', items: [], error: null } });
  const started = Date.now();
  let outcome: 'crash' | 'fail' | null = null;
  while (turn.inputs.length && !turn.interrupted && outcome === null) {
    const input = turn.inputs.shift()!;
    notify('item/completed', { threadId: turn.threadId, turnId: turn.id, item: { type: 'userMessage', id: newId('msg'), clientId: input.clientId, content: [{ type: 'text', text: input.text }] } });
    outcome = await handleInput(turn, input.text);
  }
  if (active === turn) active = null;
  const durationMs = Date.now() - started;
  const status = turn.interrupted ? 'interrupted' : outcome === 'fail' ? 'failed' : 'completed';
  const error = outcome === 'fail' ? { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } : null;
  notify('thread/tokenUsage/updated', { threadId: turn.threadId, turnId: turn.id, tokenUsage: { last: { inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 12 } } });
  log({ dir: 'turn-completed', turnId: turn.id, status });
  notify('turn/completed', { threadId: turn.threadId, turn: { id: turn.id, status, error, durationMs } });
}

/** Как Codex: AGENTS.md папки агента — источник инструкций треда. */
function agentsMd(cwd: string): string[] {
  const f = path.join(cwd, 'AGENTS.md');
  return fs.existsSync(f) ? [f] : [];
}

type Handler = (params: Record<string, unknown>) => unknown;

const handlers: Record<string, Handler> = {
  initialize: (p) => {
    experimental = (p.capabilities as { experimentalApi?: boolean } | undefined)?.experimentalApi === true;
    const name = (p.clientInfo as { name?: string } | undefined)?.name ?? 'client';
    return { userAgent: `${name}/${VERSION} (fake)`, codexHome: DIR, platformOs: 'macos' };
  },
  'account/read': () => (process.env.FAKE_CODEX_NO_ACCOUNT === '1' ? { account: null, requiresOpenaiAuth: true } : { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true }),
  'thread/start': (p) => {
    if (p.dynamicTools !== undefined && !experimental) throw { code: -32600, message: 'thread/start.dynamicTools requires experimentalApi capability' };
    const threads = loadThreads();
    const id = newId('thread');
    const roots = ((p.config as Record<string, unknown> | undefined)?.['sandbox_workspace_write.writable_roots'] as string[] | undefined) ?? [];
    threads[id] = {
      cwd: String(p.cwd),
      developerInstructions: String(p.developerInstructions ?? ''),
      tools: ((p.dynamicTools as Array<{ name: string }> | undefined) ?? []).map((t) => t.name),
      writableRoots: roots,
    };
    saveThreads(threads);
    threadId = id;
    notify('thread/started', { thread: { id } });
    return { thread: { id }, model: 'fake-model', cwd: p.cwd, approvalPolicy: p.approvalPolicy, sandbox: { type: 'workspaceWrite', writableRoots: roots, networkAccess: false }, instructionSources: agentsMd(String(p.cwd)) };
  },
  'thread/resume': (p) => {
    const threads = loadThreads();
    const id = String(p.threadId);
    const t = threads[id];
    if (!t) throw { code: -32600, message: `no rollout found for thread id ${id}` };
    const roots = ((p.config as Record<string, unknown> | undefined)?.['sandbox_workspace_write.writable_roots'] as string[] | undefined) ?? t.writableRoots;
    threads[id] = { ...t, developerInstructions: String(p.developerInstructions ?? t.developerInstructions), writableRoots: roots };
    saveThreads(threads);
    threadId = id;
    return { thread: { id }, model: 'fake-model', cwd: p.cwd, approvalPolicy: p.approvalPolicy, sandbox: { type: 'workspaceWrite', writableRoots: roots, networkAccess: false }, instructionSources: agentsMd(String(p.cwd)) };
  },
  'thread/name/set': () => ({}),
  'turn/start': (p) => {
    const tid = String(p.threadId);
    if (tid !== threadId) throw { code: -32600, message: `thread not loaded: ${tid}` };
    const input = ((p.input as Array<{ text?: string }> | undefined) ?? []).map((i) => i.text ?? '').join('\n');
    const clientId = typeof p.clientUserMessageId === 'string' ? p.clientUserMessageId : null;
    if (active && !active.interrupted) {
      active.inputs.push({ text: input, clientId });
      log({ dir: 'turn-start-result', turnId: active.id, steered: true });
      return { turn: { id: active.id, status: 'inProgress', items: [], error: null } };
    }
    const turn: FakeTurn = { id: newId('turn'), threadId: tid, inputs: [{ text: input, clientId }], interrupted: false, onInterrupt: [] };
    active = turn;
    log({ dir: 'turn-start-result', turnId: turn.id, steered: false });
    setImmediate(() => void runTurn(turn));
    return { turn: { id: turn.id, status: 'inProgress', items: [], error: null } };
  },
  'turn/interrupt': (p) => {
    if (active && active.id === p.turnId) {
      active.interrupted = true;
      for (const f of active.onInterrupt.splice(0)) f();
    }
    return {};
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const method = typeof msg.method === 'string' ? msg.method : null;
  if (method === null && typeof msg.id === 'number') {
    const w = waiting.get(msg.id);
    waiting.delete(msg.id);
    w?.({ result: msg.result, error: msg.error });
    return;
  }
  if (!method) return;
  log({ dir: 'in', method, params: msg.params ?? null, id: msg.id ?? null });
  if (msg.id === undefined) return;
  const h = handlers[method];
  if (!h) {
    send({ id: msg.id, error: { code: -32601, message: `unknown method ${method}` } });
    return;
  }
  const id = msg.id;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const slow = method === 'turn/start' && JSON.stringify(params.input ?? '').includes('медленно');
  void (async () => {
    if (slow) await sleep(800);
    try {
      send({ id, result: h(params) });
    } catch (err) {
      const e = err as { code?: number; message?: string };
      send({ id, error: { code: e.code ?? -32000, message: e.message ?? String(err) } });
    }
  })();
});
rl.on('close', () => {
  log({ dir: 'exit', why: 'stdin closed' });
  process.exit(0);
});
