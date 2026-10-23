// Учения Codex (#55, уровень С): настоящий шлюз (STG_TEST=1, настоящие часы, поддельный Telegram) и адаптер stg-codex с
// настоящим `codex app-server`. Не тест: в npm test не входит (в имени нет .test.), запускается руками:
//
//   node test/e2e/dist/drill-codex.js <каталог прогона> [--codex <путь>] [--agent-dir P] [--message "текст" | --no-message] [--interactive]
//
// Codex — с настройками и входом пользователя как есть (CODEX_HOME не задаётся), поэтому расход — из лимитов его тарифа:
// по умолчанию одно сообщение владельца. Папка агента по умолчанию — <каталог>/agent с коротким AGENTS.md учений; своя —
// --agent-dir (адаптер в неё не пишет; учения — тоже). Ни настоящего Telegram, ни связки ключей, ни launchd.
//   --message T     сообщение владельца (по умолчанию — просьба ответить одним словом)
//   --no-message    без сообщения: подъём, тред (тот же каталог прогона — тот же тред, thread/resume), аренда, проба — и
//                   выход; хода модели нет
//   --interactive   после первого ответа строки, набранные здесь, уходят сообщениями владельца; пустая строка — конец
// По ходу печатается лента адаптера и что бот отправил «владельцу»; в конце — дошёл ли ответ агента до Telegram.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { GATEWAY_NODE_FLAGS } from 'stg-core';
import { codexCommand } from 'stg-codex';
import { FakeTelegram, user } from 'stg-fake-telegram';
import { CodexAdapter } from './codex-adapter.js';

// Обвязку тестов (harness.ts) учения не грузят: она подключает node:test.
const require = createRequire(import.meta.url);
const GATEWAY_ENTRY = path.join(path.dirname(require.resolve('stg-gateway/package.json')), 'dist', 'index.js');
const TEST_TOKEN = '7000000001:AAdrill-TOKEN_never-written';
const OWNER = user(111, 'Владелец', { username: 'owner' });
const DEFAULT_MESSAGE = 'Привет! Это проверка связи. Ответь мне одним коротким словом: «работает».';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
}

function say(s: string): void {
  process.stdout.write(`${s}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function q<T>(dir: string, sql: string, ...params: Array<string | number>): T[] {
  const file = path.join(dir, 'gateway.db');
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function journal(dir: string): Array<{ ev: string; [k: string]: unknown }> {
  const logs = path.join(dir, 'logs');
  if (!fs.existsSync(logs)) return [];
  return fs
    .readdirSync(logs)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(logs, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { ev: string }));
}

async function waitFor<T>(fn: () => T | null | undefined | false, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(200);
  }
}

async function main(): Promise<number> {
  const dir = process.argv[2];
  if (!dir || dir.startsWith('--')) {
    say('node test/e2e/dist/drill-codex.js <каталог прогона> [--codex <путь>] [--agent-dir P] [--message "текст" | --no-message] [--interactive]');
    return 2;
  }
  const codex = codexCommand(arg('--codex') ?? undefined, process.env.PATH);
  if (!codex) {
    say('codex не найден: --codex <путь> или codex в PATH');
    return 2;
  }
  const root = path.resolve(dir);
  const homeDir = path.join(root, 'home');
  const ownAgent = arg('--agent-dir');
  const agentDir = path.resolve(ownAgent ?? path.join(root, 'agent'));
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(homeDir, 0o700);
  if (!ownAgent) {
    fs.mkdirSync(agentDir, { recursive: true });
    const agents = path.join(agentDir, 'AGENTS.md');
    if (!fs.existsSync(agents)) fs.writeFileSync(agents, '# Учебный агент\n\nТы — учебный агент шлюза smart-telegram-gateway. Отвечай владельцу коротко, по-русски.\n');
  }
  const fake = await FakeTelegram.start({ token: TEST_TOKEN, bot: { username: 'drill_codex_bot' } });
  fs.writeFileSync(
    path.join(homeDir, 'config.yaml'),
    `bot: drill_codex_bot\nowner_id: ${OWNER.id}\ntimezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}\n` +
      `telegram: { api_base: "${fake.apiBase}" }\nui: { material_hold_seconds: 0 }\n`,
  );
  // Каталог прогона можно взять прежний (тот же тред): журнал шлюза смотрим только с этого запуска.
  const since = journal(homeDir).length;
  const fresh = (): Array<{ ev: string; [k: string]: unknown }> => journal(homeDir).slice(since);
  const env = { ...process.env, STG_HOME: homeDir, STG_TEST: '1', STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN };
  delete (env as Record<string, string | undefined>).STG_CLOCK;
  const gw = spawn(process.execPath, [...GATEWAY_NODE_FLAGS, GATEWAY_ENTRY], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  let adapter: CodexAdapter | null = null;
  let shown = 0;
  const show = (): void => {
    const out = fake.sentTo(OWNER.id);
    for (; shown < out.length; shown++) {
      const m = out[shown]!;
      say(`  бот → владельцу: ${m.text ?? m.caption ?? (m.document ? `файл ${m.document.filename}` : '(голосовое)')}`);
    }
  };
  const watch = setInterval(show, 300);
  const stopAll = async (): Promise<void> => {
    clearInterval(watch);
    if (adapter?.alive) await adapter.stop(15_000).catch(() => adapter?.kill9());
    gw.kill('SIGTERM');
    await fake.stop();
  };
  process.on('SIGINT', () => void stopAll().then(() => process.exit(130)));
  const ready = await waitFor(() => fresh().some((l) => l.ev === 'ready'), 15_000);
  if (!ready) {
    say('шлюз не поднялся');
    await stopAll();
    return 1;
  }
  say(`шлюз: ${homeDir} (поддельный Telegram ${fake.apiBase})`);
  say(`агент: ${agentDir}`);
  say(`codex: ${codex.display}`);
  say('— лента stg-codex —');
  // FAKE_CODEX_DIR — прогон самих учений против подделки (stg-fake-codex), без расхода лимитов.
  const fakeDir = process.env.FAKE_CODEX_DIR;
  adapter = CodexAdapter.start({ home: homeDir, agentDir, codex: codex.display, fast: false, echo: process.stdout, inheritEnv: true, ...(fakeDir ? { env: { FAKE_CODEX_DIR: fakeDir } } : {}) });
  const verified = await waitFor(() => fresh().some((l) => l.ev === 'lease_verified' && l.adapter === 'stg-codex'), 120_000);
  if (!verified) {
    say(`аренда stg-codex не проверена за 2 минуты; журнал адаптера:\n${adapter.log.slice(-3000)}`);
    await stopAll();
    return 1;
  }
  const sandbox = (): void => {
    for (const l of adapter!.log.split('\n').filter((x) => /thread\/(start|resume) .*песочница/.test(x))) say(`  ${l.replace(/^\S+ /, '')}`);
  };
  if (process.argv.includes('--no-message')) {
    say('\n— итог (без сообщения) —');
    sandbox();
    await stopAll();
    return 0;
  }
  const t0 = Date.now();
  const text = arg('--message') ?? DEFAULT_MESSAGE;
  const u = fake.push(fake.builder.text(OWNER, text))[0]!;
  say(`  владелец → боту: ${text}`);
  const seq = await waitFor(() => q<{ seq: number }>(homeDir, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)[0]?.seq, 10_000);
  const answered = await waitFor(
    () => (seq ? q<{ n: number }>(homeDir, "SELECT count(*) AS n FROM outbox WHERE origin = 'agent' AND status = 'sent' AND event_seq = ?", seq)[0]?.n : 0),
    180_000,
  );
  // Ход дожить до конца: адаптер останавливается не посреди хода.
  if (answered) await waitFor(() => adapter!.lines().some((l) => / закончен за /.test(l)), 60_000);
  show();
  const replies = seq ? q<{ text: string | null }>(homeDir, "SELECT text FROM outbox WHERE origin = 'agent' AND status = 'sent' AND event_seq = ? ORDER BY id", seq) : [];
  const status = seq ? q<{ status: string }>(homeDir, 'SELECT status FROM events WHERE seq = ?', seq)[0]?.status : null;
  if (process.argv.includes('--interactive') && answered) {
    say('пиши сообщения владельца (пустая строка — конец):');
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      const t = line.trim();
      if (!t) break;
      fake.push(fake.builder.text(OWNER, t));
    }
    rl.close();
    await sleep(2000);
  }
  say('\n— итог —');
  say(`№ ${seq ?? '?'}: ${status ?? '?'}; ответов агента в Telegram: ${replies.length}${answered ? ` (первый через ${Math.round((Date.now() - t0) / 100) / 10} с после сообщения — с учётом опроса)` : ''}`);
  for (const r of replies) say(`  ответ агента: ${r.text ?? '(файл)'}`);
  sandbox();
  const state = path.join(homeDir, 'codex', 'state.json');
  if (fs.existsSync(state)) say(`state.json: ${fs.readFileSync(state, 'utf8').trim().replace(/\s+/g, ' ')}`);
  await stopAll();
  return answered && status === 'processed' ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`drill-codex: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  },
);
