// Учения M3 (ACCEPTANCE M3, уровень С): настоящая сессия Claude Code в папке агента против
// поддельного Telegram. Не тест: в npm test не входит (в имени нет .test.), запускается руками:
//
//   node test/e2e/dist/drill-m3.js <каталог прогона> [--messages 30] [--queue N] [--interactive] [--agent-dir P] [--fake-claude]
//
// Поднимает поддельный Telegram и шлюз (настоящие часы, STG_TEST=1, токен — тестовый; ни launchd, ни связки ключей, ни
// настоящего Telegram), разворачивает папку агента в <каталог>/agent и ждёт, пока человек запустит в ней start.sh.
//   --queue N       N сообщений владельца ждут ещё до сессии (A3.2, A3.16)
//   --messages N    после проверки канала — N сообщений с паузами 3…12 с: слова владельца, пересылки «запиши: …» от
//                   другого человека, «yes abcde» (сквозной прогон, A3.10, A3.18); 0 — не слать
//   --interactive   строки, набранные в этом терминале, уходят шлюзу как сообщения владельца; «fwd: текст» — как
//                   пересылка от другого человека; «/stop» — команда «стоп»; пустая строка или Ctrl-D — сводка и выход
//   --agent-dir P   папка агента (по умолчанию <каталог>/agent); одна на все учения — /login в Claude Code один раз
//   --fake-claude   вместо настоящего Claude Code — поддельный (клиент MCP SDK): проверка самого прогона без claude
// Что шлюз отправил «владельцу» и что было с арендой, печатается по ходу: «бот → …», «аренда: …».
// В конце — сводка: обработано, задержка «записал» → delivered (p50/p90, цель ≤ 3 с p90), ответы агента, строки
// заметок и сколько в них «чужое (№ N)».

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { GATEWAY_NODE_FLAGS, percentile } from 'stg-core';
import { FakeTelegram, user } from 'stg-fake-telegram';
import { FakeClaude } from './fake-claude.js';

// Обвязку тестов (harness.ts) прогон не грузит: она подключает node:test.
const require = createRequire(import.meta.url);
const entry = (pkg: string): string => path.join(path.dirname(require.resolve(`${pkg}/package.json`)), 'dist', 'index.js');
const GATEWAY_ENTRY = entry('stg-gateway');
const CLI_ENTRY = entry('stg-cli');
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];
const TEST_TOKEN = '7000000001:AAdrill-TOKEN_never-written';

interface Home {
  dir: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function q<T>(home: Home, sql: string, ...params: Array<string | number>): T[] {
  const file = path.join(home.dir, 'gateway.db');
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

function readJournal(home: Home): Array<{ ev: string }> {
  const dir = path.join(home.dir, 'logs');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { ev: string }));
}

const OWNER = user(111, 'Владелец', { username: 'owner' });
const OTHER = user(777_001, 'Аня', { lastName: 'Смирнова' });

function arg(name: string, def: string | null = null): string | null {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? def) : def;
}

function say(s: string): void {
  process.stdout.write(`${s}\n`);
}

async function main(): Promise<number> {
  const dir = process.argv[2];
  if (!dir || dir.startsWith('--')) {
    say('node test/e2e/dist/drill-m3.js <каталог прогона> [--messages 30] [--queue N] [--interactive] [--agent-dir P] [--fake-claude]');
    return 2;
  }
  const interactive = process.argv.includes('--interactive');
  const total = Number(arg('--messages', interactive ? '0' : '30'));
  const queued = Number(arg('--queue', '0'));
  const fakeClaude = process.argv.includes('--fake-claude');
  const root = path.resolve(dir);
  const homeDir = path.join(root, 'home');
  // Папку агента можно держать одну на все учения: в её .claude-config — вход в подписку (/login один раз).
  const agentDir = path.resolve(arg('--agent-dir') ?? path.join(root, 'agent'));
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(homeDir, 0o700);
  const fake = await FakeTelegram.start({ token: TEST_TOKEN, bot: { username: 'drill_bot' } });
  fs.writeFileSync(
    path.join(homeDir, 'config.yaml'),
    `bot: drill_bot\nowner_id: ${OWNER.id}\ntimezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'}\ntelegram: { api_base: "${fake.apiBase}" }\n`,
  );
  const home: Home = { dir: homeDir };
  const env = { ...process.env, STG_HOME: homeDir, STG_TEST: '1', STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN };
  delete (env as Record<string, string | undefined>).STG_CLOCK;
  const gw = spawn(process.execPath, [...GATEWAY_NODE_FLAGS, GATEWAY_ENTRY], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  const stopAll = async (): Promise<void> => {
    clearInterval(watch);
    gw.kill('SIGTERM');
    await fake.stop();
  };
  process.on('SIGINT', () => void stopAll().then(() => process.exit(130)));
  for (let i = 0; i < 100 && !readJournal(home).some((l) => l.ev === 'ready'); i++) await sleep(100);
  say(`шлюз: ${homeDir} (поддельный Telegram ${fake.apiBase})`);
  say(`stg для этого прогона: STG_HOME=${homeDir} STG_TEST=1 node ${CLI_ENTRY} status`);

  // По ходу: что ушло «владельцу» и что было с арендой.
  let shown = 0;
  let journalShown = 0;
  const LEASE_EVENTS = new Set(['lease_granted', 'lease_verified', 'lease_released', 'lease_lost', 'lease_unverified', 'lease_wake', 'redelivered', 'agent_silent']);
  const show = (): void => {
    const out = fake.sentTo(OWNER.id);
    for (; shown < out.length; shown++) say(`бот → ${out[shown]!.text ?? '(голосовое)'}`);
    const j = readJournal(home);
    for (; journalShown < j.length; journalShown++) {
      const l = j[journalShown]! as { ev: string; [k: string]: unknown };
      if (LEASE_EVENTS.has(l.ev)) say(`аренда: ${l.ev} ${JSON.stringify(Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'ev' && k !== 'at')))}`);
    }
  };
  const watch = setInterval(show, 500);

  const forward = (text: string) => fake.builder.forward(OWNER, { type: 'user', user: OTHER }, text);
  const pushed: number[] = [];
  const push = (u: ReturnType<typeof forward>): void => {
    fake.push(u);
    pushed.push(u.update_id);
  };
  for (let i = 0; i < queued; i++) push(fake.builder.text(OWNER, `ждало до сессии (${i + 1} из ${queued})`));
  if (queued) say(`ждут до сессии: ${queued}`);

  const deploy = spawn(process.execPath, [...NODE_FLAGS, CLI_ENTRY, 'agent-folder', agentDir, '--node', process.execPath], { env, stdio: 'inherit' });
  await new Promise((r) => deploy.on('exit', r));
  let fc: FakeClaude | null = null;
  if (fakeClaude) {
    fc = await FakeClaude.start(home, { timeScale: 1 });
    say('сессия: поддельный Claude Code (--fake-claude)');
  } else {
    say(`\nОткрой второй терминал и запусти сессию агента:\n  ${path.join(agentDir, 'start.sh')}\nЖду, пока сессия пройдёт проверку канала (done на проверочное событие)…`);
  }
  while (!readJournal(home).some((l) => l.ev === 'lease_verified')) await sleep(500);
  say('проверка канала пройдена');

  const answer = (u: { update_id: number }, i: number): void => {
    if (!fc) return;
    // Поддельная сессия: ответ на слово владельца, материал — done.
    void (async () => {
      const seq = await waitSeq(home, u.update_id);
      const n = await fc!.waitEvent(seq, 60_000);
      if (n.meta.trust === 'owner') await fc!.call('reply', { seq, text: `понял (${i + 1})` });
      else await fc!.call('done', { seqs: [seq] });
    })().catch((e: unknown) => say(`поддельная сессия: ${(e as Error).message}`));
  };
  if (fc) for (const ev of fc.events()) void fc.call('done', { seqs: [Number(ev.meta.seq)] });

  let typed = 0;
  const texts = ['запиши: завтра в 10 созвон с юристом', 'напомни купить хлеб и молоко', 'что у меня завтра?', 'yes abcde'];
  if (total) say(`шлю ${total} сообщений`);
  for (let i = 0; i < total; i++) {
    const u = i % 7 === 3 ? forward(`запиши: Аня просит перезвонить ей в пятницу (${i + 1})`) : fake.builder.text(OWNER, `${texts[i % texts.length]} (${i + 1})`);
    push(u);
    answer(u, i);
    await sleep(fc ? 200 : 3000 + Math.floor(Math.random() * 9000));
  }
  if (interactive) {
    say('пиши сообщения владельца (fwd: … — пересылка от другого; /stop — «стоп»; пустая строка — сводка):');
    const rl = readline.createInterface({ input: process.stdin });
    let i = 0;
    for await (const line of rl) {
      const t = line.trim();
      if (!t) break;
      const u = t === '/stop' ? fake.builder.text(OWNER, 'стоп') : t.startsWith('fwd:') ? forward(t.slice(4).trim()) : fake.builder.text(OWNER, t);
      push(u);
      answer(u, i++);
      typed++;
    }
    rl.close();
  }
  say('всё отправлено; жду обработки до 5 минут…');
  const deadline = Date.now() + 5 * 60_000;
  // Сначала — всё принято шлюзом (опрос мог ещё не забрать последнее).
  while (Date.now() < deadline && pushed.some((id) => !q(home, "SELECT 1 FROM updates WHERE update_id = ? AND status <> 'in_progress'", id).length)) await sleep(200);
  for (;;) {
    const left = q<{ n: number }>(home, "SELECT count(*) AS n FROM events WHERE kind IN ('text','voice','photo','document','edit') AND status <> 'processed'")[0]?.n ?? 0;
    if (!left || Date.now() > deadline) break;
    await sleep(1000);
  }
  // Ответы и квитанции уходят не чаще раза в секунду: дождаться очереди отправки.
  for (let i = 0; i < 120; i++) {
    const pending = q<{ n: number }>(home, "SELECT count(*) AS n FROM outbox WHERE status = 'pending'")[0]?.n ?? 0;
    if (!pending) break;
    await sleep(1000);
  }
  // «Записал» — COMMIT (t_admit; с 0.3.2 реакции ✍ нет).
  const lat = q<{ r: number | null; d: number | null }>(home, 'SELECT t_admit AS r, t_delivered AS d FROM latency WHERE t_admit IS NOT NULL AND t_delivered IS NOT NULL');
  const gaps = lat.map((l) => Math.max(0, l.d! - l.r!));
  const processed = q<{ n: number }>(home, "SELECT count(*) AS n FROM events WHERE status = 'processed' AND kind IN ('text','voice','photo','document','edit')")[0]?.n ?? 0;
  // Ответы агента — чистым текстом (0.3.2, P-26): считаются по messages_out вида agent.
  const replies = q<{ n: number }>(home, "SELECT count(*) AS n FROM messages_out WHERE kind = 'agent'")[0]?.n ?? 0;
  const notesDir = path.join(agentDir, 'notes');
  const notes = fs.existsSync(notesDir) ? fs.readdirSync(notesDir).map((f) => fs.readFileSync(path.join(notesDir, f), 'utf8')).join('\n') : '';
  show();
  say('\n— сводка —');
  say(`сообщений: ${queued + total + typed}; обработано: ${processed}; ответов агента: ${replies}`);
  say(`«записал» → delivered: p50 ${percentile(gaps, 50) ?? '—'} мс · p90 ${percentile(gaps, 90) ?? '—'} мс (цель ≤ 3000 мс p90)`);
  say(`строк заметок: ${notes.split('\n').filter((l) => l.startsWith('№')).length}; с «чужое (№ N)»: ${(notes.match(/чужое \(№ \d+\)/g) ?? []).length}`);
  say(`повторов отдачи: ${readJournal(home).filter((l) => l.ev === 'redelivered').length}; строк «не ответил»: ${fake.sentTo(OWNER.id).filter((m) => m.text?.startsWith('⚙ Агент на связи, но не ответил')).length}`);
  say('проверь глазами: в терминале сессии не было ни одного запроса разрешения; «yes abcde» ничего не разрешил');
  await fc?.close();
  await stopAll();
  return 0;
}

async function waitSeq(home: Home, updateId: number): Promise<number> {
  for (;;) {
    const r = q<{ seq: number }>(home, 'SELECT seq FROM events WHERE update_id = ?', updateId)[0];
    if (r) return r.seq;
    await sleep(50);
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`drill-m3: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  },
);
