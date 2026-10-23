// Поддельный `codex app-server` для тестов (#55): путь к скрипту и чтение его журнала. Сама подделка — app-server.ts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Скрипт подделки: адаптер запускает его как codex — `node <он> app-server`. */
export const FAKE_CODEX_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app-server.js');

/** Строка журнала подделки: что пришло от адаптера (dir: in), чем адаптер ответил на вызов инструмента (tool-result) и т. п. */
export interface FakeCodexLine {
  pid: number;
  at: number;
  dir: 'in' | 'tool-result' | 'turn-start-result' | 'turn-completed' | 'crash' | 'down' | 'exit';
  method?: string;
  params?: Record<string, unknown> | null;
  id?: number | null;
  tool?: string;
  args?: Record<string, unknown>;
  turnId?: string;
  result?: { contentItems?: Array<{ type: string; text?: string; imageUrl?: string }>; success?: boolean } | null;
  error?: unknown;
  steered?: boolean;
  status?: string;
  seq?: number;
}

export function readFakeCodexLog(dir: string): FakeCodexLine[] {
  const f = path.join(dir, 'log.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as FakeCodexLine);
}

/** Запросы адаптера к подделке с этим методом, по порядку. */
export function requestsOf(dir: string, method: string): FakeCodexLine[] {
  return readFakeCodexLog(dir).filter((l) => l.dir === 'in' && l.method === method);
}

/** Текст ввода turn/start. */
export function inputOf(l: FakeCodexLine): string {
  const input = (l.params?.input as Array<{ text?: string }> | undefined) ?? [];
  return input.map((i) => i.text ?? '').join('\n');
}
