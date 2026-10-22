// stg agent-state statusline · stg agent-state hook (TECH-SPEC 5.14; J-4; P-1, D-6). Их запускает
// Claude Code в сессии агента — строкой состояния (statusLine) и перехватчиками PreCompact, PostCompact, StopFailure
// (шаблон — scripts/agent-folder/.claude/agent-state.settings.json). Обе подкоманды пишут $STG_HOME/agent-state.json
// (атомарно, 0600, слиянием под замком — packages/core/src/agent-state.ts); шлюз его читает.
//
// Главное правило — никогда не ломать строку агента: любая ошибка (нет каталога, кривой JSON, нет места) — строка в
// stderr, выход 0. Быстро: без сети и без базы; модуль грузит только лёгкую часть ядра (stg-core/agent-state), не весь
// stg-core. Каталог — только явный: --home или STG_HOME (у строки состояния и перехватчиков нет окружения канала;
// «единственный каталог в ~/.smart-telegram-gateway» здесь не угадывается — тест не должен задеть настоящий).
//
// statusline [--then <команда>]: прежняя строка агента (например, claude-hud) сохраняется — команда идёт через sh с тем
// же stdin, её вывод печатается как есть. Без --then (или с пустой) — своя короткая строка `Opus · 🧠 16% · 🕐 31% · 📅 64%`.
// Прежняя команда — в своей группе процессов: по пределу 10 с или по отмене (Claude Code шлёт сигнал, когда начинает
// новую перерисовку) снимается вся группа — и внуки (конвейер, `bash -c '…; node …'`), и те, кто глух к SIGTERM.
// Её stderr идёт через канал в наш stderr, пока мы живы, — сирота не держит канал stderr строки Claude Code.
// Сигнал посреди записи файла не оставляет замок: обработчик сигналов ставится до записи и срабатывает после неё.
// hook: stdout пустой (StopFailure его не читает, PreCompact и PostCompact поняли бы JSON на stdout как решение).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { agentStateNow, applyHook, applyStatusline, statuslineShortLine, updateAgentStateFile } from 'stg-core/agent-state';

/** Предел входа: JSON строки состояния — килобайты. */
const STDIN_MAX = 1024 * 1024;
/** Сколько ждать конца stdin: Claude Code закрывает его сразу после JSON ⟨предл.⟩. */
const STDIN_WAIT_MS = 3_000;
/** Предел на прежнюю строку (--then): Claude Code и сам отменяет её новой перерисовкой ⟨предл.⟩. */
const THEN_TIMEOUT_MS = 10_000;
/** После SIGTERM группе прежней строки — столько до SIGKILL (глухих к SIGTERM) ⟨предл.⟩. */
const THEN_KILL_GRACE_MS = 300;
/** Сколько stderr прежней строки пропускать в наш stderr. */
const THEN_STDERR_MAX = 8 * 1024;

/** Предел на --then: под тестом (STG_TEST=1) — из STG_THEN_TIMEOUT_MS, чтобы не ждать 10 с. */
function thenTimeoutMs(env: NodeJS.ProcessEnv): number {
  const t = Number(env.STG_THEN_TIMEOUT_MS);
  return env.STG_TEST === '1' && Number.isFinite(t) && t > 0 ? t : THEN_TIMEOUT_MS;
}

/** Группа процессов прежней строки, пока она идёт: её снимает и обработчик сигналов. */
let thenGroup: number | null = null;

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    // группы уже нет
  }
}

/**
 * Сигнал отмены (SIGTERM, SIGINT, SIGHUP): снять группу прежней строки (SIGKILL — новая перерисовка уже идёт, ждать
 * нечего) и выйти с 0. Ставится в начале подкоманды: сигнал посреди записи файла (она синхронная) обработается после неё
 * — замок снят в finally, файл целый.
 */
function armSignals(): void {
  const onSignal = (): void => {
    if (thenGroup !== null) killGroup(thenGroup, 'SIGKILL');
    process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(sig, onSignal);
}

function note(line: string): void {
  try {
    process.stderr.write(`stg agent-state: ${line}\n`);
  } catch {
    // stderr закрыт — молчим
  }
}

function readStdin(): Promise<Buffer> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.pause();
      resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(finish, STDIN_WAIT_MS);
    process.stdin.on('data', (d: Buffer) => {
      size += d.length;
      if (size <= STDIN_MAX) chunks.push(d);
      else finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function writeOut(data: string | Buffer): Promise<void> {
  return new Promise((resolve) => {
    try {
      process.stdout.write(data, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Каталог бота: --home или STG_HOME; нет или не каталог — null (строка в stderr). */
function homeOf(flag: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const home = flag || env.STG_HOME || '';
  if (!home) {
    note('нет --home и STG_HOME — состояние не записано');
    return null;
  }
  try {
    if (!fs.statSync(home).isDirectory()) throw new Error('не каталог');
  } catch {
    note(`нет каталога бота ${home} — состояние не записано`);
    return null;
  }
  return home;
}

/**
 * Прежняя строка состояния: sh -c <команда> в своей группе процессов, тот же stdin; вывод — как есть. Ошибка — null.
 * Предел — вся группа получает SIGTERM, через 0,3 с — SIGKILL; что успела напечатать — печатается.
 */
function runThen(cmd: string, stdin: Buffer, env: NodeJS.ProcessEnv): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/bin/sh', ['-c', cmd], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      note(`--then не запустилась: ${(err as Error).message}`);
      resolve(null);
      return;
    }
    if (child.pid !== undefined) thenGroup = child.pid;
    const out: Buffer[] = [];
    let errBytes = 0;
    let settled = false;
    /** Предел вышел, группа снимается: ждать SIGKILL, даже если каналы уже закрылись (внук без stdout). */
    let killing = false;
    const settle = (v: Buffer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      thenGroup = null;
      resolve(v);
    };
    const limit = thenTimeoutMs(env);
    const timer = setTimeout(() => {
      note(`--then не ответила за ${limit / 1000} с — снята`);
      const pid = child.pid;
      if (pid === undefined) {
        settle(Buffer.concat(out));
        return;
      }
      killing = true;
      killGroup(pid, 'SIGTERM');
      setTimeout(() => {
        killGroup(pid, 'SIGKILL');
        settle(Buffer.concat(out));
      }, THEN_KILL_GRACE_MS);
    }, limit);
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => {
      if (errBytes >= THEN_STDERR_MAX) return;
      errBytes += d.length;
      try {
        process.stderr.write(d.subarray(0, Math.max(0, THEN_STDERR_MAX - errBytes + d.length)));
      } catch {
        // stderr закрыт — молчим
      }
    });
    child.on('error', (err) => {
      note(`--then: ${err.message}`);
      settle(null);
    });
    child.on('close', () => {
      if (!killing) settle(Buffer.concat(out));
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(stdin);
  });
}

interface Flags {
  home?: string;
  then?: string;
  bad: string[];
}

function parseFlags(args: string[], allowThen: boolean): Flags {
  const f: Flags = { bad: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--home') f.home = args[++i];
    else if (a === '--then' && allowThen) f.then = args[++i] ?? '';
    else f.bad.push(a);
  }
  return f;
}

/** stg agent-state statusline [--home <каталог>] [--then <команда>] — всегда 0. */
export async function runAgentStateStatusline(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  armSignals();
  const flags = parseFlags(args, true);
  if (flags.bad.length) note(`не знаю аргумент «${flags.bad[0]}»`);
  const raw = await readStdin();
  let input: unknown;
  let parsed = false;
  try {
    input = JSON.parse(raw.toString('utf8'));
    parsed = true;
  } catch {
    note('на stdin не JSON — состояние не записано');
  }
  const home = homeOf(flags.home, env);
  if (home && parsed) {
    try {
      const now = agentStateNow(env, home);
      updateAgentStateFile(home, (prev) => applyStatusline(prev, input, now), now);
    } catch (err) {
      note(`состояние не записано: ${(err as Error).message}`);
    }
  }
  const then = flags.then?.trim() ?? '';
  if (then) {
    const out = await runThen(then, raw, env);
    // Прежняя строка ничего не напечатала (или не запустилась) — своя, чтобы строка агента не пустела ⟨предл.⟩.
    if (out && out.length > 0) {
      await writeOut(out);
      return 0;
    }
  }
  await writeOut(statuslineShortLine(parsed ? input : null) + '\n');
  return 0;
}

/** stg agent-state hook [--home <каталог>] — PreCompact, PostCompact, StopFailure; stdout пустой, всегда 0. */
export async function runAgentStateHook(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  armSignals();
  const flags = parseFlags(args, false);
  if (flags.bad.length) note(`не знаю аргумент «${flags.bad[0]}»`);
  const raw = await readStdin();
  let input: unknown;
  try {
    input = JSON.parse(raw.toString('utf8'));
  } catch {
    note('на stdin не JSON — состояние не записано');
    return 0;
  }
  const home = homeOf(flags.home, env);
  if (!home) return 0;
  try {
    const now = agentStateNow(env, home);
    updateAgentStateFile(home, (prev) => applyHook(prev, input, now).state, now);
  } catch (err) {
    note(`состояние не записано: ${(err as Error).message}`);
  }
  return 0;
}
