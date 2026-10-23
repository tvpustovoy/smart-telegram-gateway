// Состояние адаптера (#55): id треда Codex, для какой папки агента он заведён, версия правил канала, номера событий,
// отданных в Codex и ещё без ответа. Лежит в каталоге бота ($STG_HOME/codex/state.json), не в папке агента: папка агента —
// чужой репозиторий, адаптер туда не пишет. Запись — через временный файл и переименование: обрыв посреди записи не
// портит прежний файл. Испорченный файл не роняет адаптер: начинаем с чистого состояния (новый тред), прежний файл
// остаётся рядом с суффиксом .bad.

import fs from 'node:fs';
import path from 'node:path';

export interface AdapterState {
  version: 1;
  /** Тред Codex разговора; null — ещё не заведён. */
  threadId: string | null;
  /** Папка агента, для которой заведён тред (сменилась — новый тред). */
  agentDir: string | null;
  /** Версия правил канала, переданных треду (developer instructions). */
  instructionsVersion: string | null;
  /** Версия Codex из initialize. */
  codexVersion: string | null;
  /** Номера событий, отданных в Codex и ещё без ответа агента. */
  pending: number[];
  /** Почему аренды нет (нет входа в ChatGPT и т. п.); null — всё в порядке. */
  problem: string | null;
  updatedAt: string | null;
}

export function emptyState(): AdapterState {
  return { version: 1, threadId: null, agentDir: null, instructionsVersion: null, codexVersion: null, pending: [], problem: null, updatedAt: null };
}

export interface LoadedState {
  state: AdapterState;
  /** Файл был, но не прочитался — что с ним. */
  warning: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

export function loadState(file: string): LoadedState {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: emptyState(), warning: null };
    return { state: emptyState(), warning: `state.json не прочитан: ${(err as Error).message}` };
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || raw.version !== 1) throw new Error('неизвестный формат');
    const pending = Array.isArray(raw.pending) ? raw.pending.filter((n): n is number => Number.isInteger(n) && (n as number) > 0) : [];
    return {
      state: {
        version: 1,
        threadId: str(raw.threadId),
        agentDir: str(raw.agentDir),
        instructionsVersion: str(raw.instructionsVersion),
        codexVersion: str(raw.codexVersion),
        pending,
        problem: str(raw.problem),
        updatedAt: str(raw.updatedAt),
      },
      warning: null,
    };
  } catch (err) {
    try {
      fs.renameSync(file, `${file}.bad`);
    } catch {
      // не вышло — перезапишется следующей записью
    }
    return { state: emptyState(), warning: `state.json испорчен (${(err as Error).message}) — начинаю с нового треда; прежний файл: state.json.bad` };
  }
}

/** Записать атомарно: временный файл → fsync → переименование. */
export function saveState(file: string, state: AdapterState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
