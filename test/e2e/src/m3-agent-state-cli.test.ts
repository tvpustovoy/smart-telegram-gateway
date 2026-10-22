// Состояние агента · подкоманды stg agent-state и шаблон папки агента (TECH-SPEC 5.14; J-4; P-1, D-6):
// - statusline: пишет agent-state.json атомарно, 0600, слиянием; --then — прежняя строка: тот же stdin, её вывод как
//   есть; без --then — своя короткая строка; кривой JSON, нет STG_HOME, нет каталога — выход 0, ничего не записано;
// - hook: PreCompact / PostCompact / StopFailure — сжатие и отказ модели в тот же файл; stdout пустой, выход 0 всегда;
// - одновременные записи строки и перехватчика не теряют друг друга (замок);
// - StopFailure в настоящем виде Claude Code 2.1.306 (error, last_assistant_message, error_details не всегда);
// - --then зависла или глуха к SIGTERM — снята вся группа процессов (и внуки), по пределу и по отмене сигналом; её
//   stderr — в наш; сигнал до записи — выход 0 без замка;
// - шаблон: .claude/agent-state.settings.json с подстановками (каждая — в кавычках sh), start.sh подключает его флагом
//   --settings; прежняя строка состояния папки находится сама — в порядке старшинства Claude Code (local → проект →
//   пользователь), и вывод говорит, какая и откуда (или что не найдена); команды из файла работают через sh, как их
//   запустит Claude Code.

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AGENT_STATE_FILE, readAgentStateFile } from 'stg-core';
import { T0, makeHome, makeTempDir, runCli, runCliInput, testEnv, waitUntil, type TestHome } from './harness.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(require.resolve('stg-cli/package.json')), '..', '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');

const H = 3600_000;

function statusline(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 's1',
    cwd: '/agents/assistant',
    workspace: { current_dir: '/agents/assistant', project_dir: '/agents/assistant' },
    model: { display_name: 'Opus' },
    context_window: { used_percentage: 16.4 },
    cost: { total_cost_usd: 0.5 },
    rate_limits: {
      five_hour: { used_percentage: 31.2, resets_at: Math.round((T0 + 3 * H) / 1000) },
      seven_day: { used_percentage: 64, resets_at: new Date(T0 + 4 * 24 * H).toISOString() },
    },
    ...over,
  };
}

function stateFile(home: TestHome): string {
  return path.join(home.dir, AGENT_STATE_FILE);
}

/** Жив ли процесс (зомби у launchd — недолго: ждём, пока его уберут). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Текст отказа доступа, как его шлёт Claude Code 2.1.306 в last_assistant_message. */
const ORG_DISABLED = 'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';

describe('stg agent-state statusline · hook', () => {
  it('statusline: файл 0600 со временем, сессией, каталогом, контекстом, лимитами (resets_at — секунды и ISO); своя короткая строка', async () => {
    const home = makeHome({ apiBase: 'http://127.0.0.1:9' });
    const r = await runCliInput(['agent-state', 'statusline'], testEnv(home), JSON.stringify(statusline()));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'Opus · 🧠 16% · 🕐 31% · 📅 64%\n');
    assert.equal(fs.statSync(stateFile(home)).mode & 0o777, 0o600);
    const s = readAgentStateFile(home.dir)!;
    // Время — по поддельным часам каталога (под тестом): сроки файла и шлюза идут по одним часам.
    assert.deepEqual(s.statusline, { at: T0, session_id: 's1', cwd: '/agents/assistant', project_dir: '/agents/assistant', model: 'Opus', context_pct: 16.4, cost_usd: 0.5 });
    assert.deepEqual(s.limits.five_hour, { pct: 31.2, resets_at: T0 + 3 * H, at: T0 });
    assert.deepEqual(s.limits.seven_day, { pct: 64, resets_at: T0 + 4 * 24 * H, at: T0 });
    assert.deepEqual(fs.readdirSync(home.dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock')), [], 'ни временных файлов, ни замка');
  });

  it('--then: прежняя строка получает тот же stdin, её вывод — как есть (цвета, строки); пустой вывод или пустая --then — своя строка', async () => {
    const home = makeHome({ apiBase: 'http://127.0.0.1:9' });
    const seen = path.join(home.aux, 'stdin.json');
    const json = JSON.stringify(statusline());
    const r = await runCliInput(['agent-state', 'statusline', '--then', `cat > '${seen}'; printf '\\033[32mHUD\\033[0m 42%%\\nвторая строка'`], testEnv(home), json);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '\x1b[32mHUD\x1b[0m 42%\nвторая строка');
    assert.equal(fs.readFileSync(seen, 'utf8'), json, 'stdin прежней строки — тот же');
    assert.equal(readAgentStateFile(home.dir)?.statusline?.context_pct, 16.4, 'и состояние записано');
    const silent = await runCliInput(['agent-state', 'statusline', '--then', 'exit 3'], testEnv(home), json);
    assert.equal(silent.code, 0);
    assert.equal(silent.stdout, 'Opus · 🧠 16% · 🕐 31% · 📅 64%\n');
    const empty = await runCliInput(['agent-state', 'statusline', '--then', ''], testEnv(home), json);
    assert.equal(empty.stdout, 'Opus · 🧠 16% · 🕐 31% · 📅 64%\n');
  });

  it('hook: PreCompact и PostCompact — сжатие с временем; StopFailure — тип и текст без секретов, обрезан; слияние со строкой; stdout пустой', async () => {
    const home = makeHome({ apiBase: 'http://127.0.0.1:9' });
    const env = testEnv(home);
    await runCliInput(['agent-state', 'statusline'], env, JSON.stringify(statusline()));
    const pre = await runCliInput(['agent-state', 'hook'], env, JSON.stringify({ session_id: 's1', hook_event_name: 'PreCompact', trigger: 'auto' }));
    assert.equal(pre.code, 0, pre.stderr);
    assert.equal(pre.stdout, '', 'stdout перехватчика пустой');
    assert.deepEqual(readAgentStateFile(home.dir)?.compact, { since: T0, session_id: 's1', trigger: 'auto' });
    // Перерисовка строки посреди сжатия флаг не снимает.
    await runCliInput(['agent-state', 'statusline'], env, JSON.stringify(statusline({ context_window: { used_percentage: 97 } })));
    assert.ok(readAgentStateFile(home.dir)?.compact);
    await runCliInput(['agent-state', 'hook'], env, JSON.stringify({ session_id: 's1', hook_event_name: 'PostCompact', trigger: 'auto' }));
    const s = readAgentStateFile(home.dir)!;
    assert.equal(s.compact, null);
    assert.deepEqual(s.compacted, { at: T0, session_id: 's1', trigger: 'auto' });
    const secret = 'sk-ant-oat01-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    const msg = `API Error: Your organization has disabled Claude subscription access for Claude Code. Token ${secret}. ${'подробности '.repeat(40)}`;
    // Настоящий вид StopFailure (Claude Code 2.1.306): error — тип, last_assistant_message — текст.
    const fail = await runCliInput(['agent-state', 'hook'], env, JSON.stringify({ session_id: 's1', transcript_path: '/t.jsonl', cwd: '/agents/assistant', hook_event_name: 'StopFailure', error: 'oauth_org_not_allowed', last_assistant_message: msg }));
    assert.equal(fail.code, 0);
    assert.equal(fail.stdout, '');
    const f = readAgentStateFile(home.dir)!.failure!;
    assert.equal(f.type, 'oauth_org_not_allowed');
    assert.ok(f.text.startsWith('Your organization has disabled Claude subscription access for Claude Code. Token …'), f.text);
    assert.ok(!fs.readFileSync(stateFile(home), 'utf8').includes('ZZZZZZZZ'), 'ключа в файле нет');
    assert.ok(f.text.length <= 201 && f.text.endsWith('…'), `${f.text.length}`);
    assert.deepEqual(f.marks, [{ session_id: 's1', cost_usd: 0.5 }]);
    assert.equal(readAgentStateFile(home.dir)?.statusline?.context_pct, 97, 'строка состояния не потеряна');
    // Неизвестное событие — файл тот же.
    const ino = fs.statSync(stateFile(home)).ino;
    const other = await runCliInput(['agent-state', 'hook'], env, JSON.stringify({ hook_event_name: 'Notification' }));
    assert.equal(other.code, 0);
    assert.equal(fs.statSync(stateFile(home)).ino, ino);
  });

  it('никогда не ломает строку агента: кривой JSON, пустой stdin, нет STG_HOME (и угадывать каталог не стал), нет каталога — выход 0, ничего не записано', async () => {
    const home = makeHome({ apiBase: 'http://127.0.0.1:9' });
    for (const sub of ['statusline', 'hook']) {
      for (const input of ['{не json', '', 'null']) {
        const r = await runCliInput(['agent-state', sub], testEnv(home), input);
        assert.equal(r.code, 0, `${sub} «${input}»: ${r.stderr}`);
        if (sub === 'hook') assert.equal(r.stdout, '');
        else assert.ok(r.stdout.length > 0, 'строка агента не пустая');
      }
    }
    assert.equal(fs.existsSync(stateFile(home)), false, 'кривое не записано');
    // Нет STG_HOME и --home; в HOME — ровно один каталог бота: CLI его не угадывает (тест не должен задеть настоящий).
    const fakeHome = makeTempDir('hm-');
    const bot = path.join(fakeHome, '.smart-telegram-gateway', 'only_bot');
    fs.mkdirSync(bot, { recursive: true });
    const env = { ...testEnv(home), HOME: fakeHome, STG_HOME: undefined };
    delete env.STG_HOME;
    const r = await runCliInput(['agent-state', 'statusline'], env, JSON.stringify(statusline()));
    assert.equal(r.code, 0);
    assert.match(r.stderr, /нет --home и STG_HOME/);
    assert.deepEqual(fs.readdirSync(bot), []);
    const h = await runCliInput(['agent-state', 'hook', '--home', path.join(fakeHome, 'нет-такого')], env, JSON.stringify({ hook_event_name: 'PreCompact' }));
    assert.equal(h.code, 0);
    assert.match(h.stderr, /нет каталога бота/);
    assert.equal(fs.existsSync(path.join(fakeHome, 'нет-такого')), false, 'каталог не создан');
    // Лишний аргумент — не повод ломать строку.
    const odd = await runCliInput(['agent-state', 'statusline', '--что-то'], testEnv(home), JSON.stringify(statusline()));
    assert.equal(odd.code, 0);
    assert.equal(odd.stdout, 'Opus · 🧠 16% · 🕐 31% · 📅 64%\n');
  });

  it('строка состояния и перехватчик одновременно: ни одна запись не потеряна (замок)', async () => {
    const home = makeHome({ apiBase: 'http://127.0.0.1:9' });
    const env = testEnv(home);
    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => runCliInput(['agent-state', 'statusline'], env, JSON.stringify(statusline({ context_window: { used_percentage: 10 + i } })))),
      // Отказ — другой сессии: StopFailure своей сессии снял бы её сжатие (по правилу), а здесь проверяется только замок.
      runCliInput(['agent-state', 'hook'], env, JSON.stringify({ session_id: 's2', hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'Rate limit exceeded' })),
      runCliInput(['agent-state', 'hook'], env, JSON.stringify({ session_id: 's1', hook_event_name: 'PreCompact', trigger: 'manual' })),
    ]);
    const s = readAgentStateFile(home.dir)!;
    assert.ok(s.statusline && s.statusline.context_pct! >= 10, 'строка');
    assert.equal(s.failure?.text, 'Rate limit exceeded', 'отказ');
    assert.equal(s.compact?.trigger, 'manual', 'сжатие');
    assert.ok(!fs.existsSync(path.join(home.dir, 'agent-state.lock')), 'замок снят');
  });

  it('StopFailure в настоящем виде: без last_assistant_message — error_details; только тип — тип; владелец видит текст, а не код', async () => {
    const home = makeHome({ apiBase: 'http://127.0.0.1:9' });
    const env = testEnv(home);
    const hook = async (o: Record<string, unknown>): Promise<void> => {
      const r = await runCliInput(['agent-state', 'hook'], env, JSON.stringify({ session_id: 's1', hook_event_name: 'StopFailure', ...o }));
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '');
    };
    await hook({ error: 'oauth_org_not_allowed', last_assistant_message: ORG_DISABLED });
    assert.deepEqual([readAgentStateFile(home.dir)!.failure!.type, readAgentStateFile(home.dir)!.failure!.text], ['oauth_org_not_allowed', ORG_DISABLED]);
    await hook({ error: 'rate_limit', error_details: '429 rate limited', last_assistant_message: 'API Error: Request rejected (429) · this may be a temporary capacity issue.' });
    const r = readAgentStateFile(home.dir)!.failure!;
    assert.deepEqual([r.type, r.text, r.details], ['rate_limit', 'Request rejected (429) · this may be a temporary capacity issue.', '429 rate limited']);
    await hook({ error: 'invalid_request', error_details: 'prompt is too long: 210000 tokens > 200000 maximum' });
    assert.equal(readAgentStateFile(home.dir)!.failure!.text, 'prompt is too long: 210000 tokens > 200000 maximum');
    await hook({ error: 'server_error' });
    assert.equal(readAgentStateFile(home.dir)!.failure!.text, 'server_error');
  });

  it('--then зависла и глуха к SIGTERM: по пределу снята вся группа (и внук), напечатано, что успела; её stderr — в наш', async () => {
    const home = makeHome({ apiBase: 'http://127.0.0.1:9' });
    const pidFile = path.join(home.aux, 'grandchild.pid');
    // Составная команда: внук в фоне глух к SIGTERM (и sh тоже) — без группы процессов оба остались бы сиротами.
    const then = `printf 'partial'; echo 'hud: warn' >&2; (trap '' TERM; exec sleep 30) & echo $! > '${pidFile}'; trap '' TERM; sleep 25`;
    const t0 = Date.now();
    const r = await runCliInput(['agent-state', 'statusline', '--then', then], testEnv(home, { STG_THEN_TIMEOUT_MS: '800' }), JSON.stringify(statusline()));
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - t0 < 5_000, `ждали ${Date.now() - t0} мс`);
    assert.equal(r.stdout, 'partial', 'что успела напечатать прежняя строка — как есть');
    assert.match(r.stderr, /hud: warn/);
    assert.match(r.stderr, /--then не ответила за 0\.8 с — снята/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await waitUntil(() => !alive(pid), 3_000, `снятия внука ${pid}`);
    assert.equal(readAgentStateFile(home.dir)?.statusline?.context_pct, 16.4, 'состояние записано');
  });

  it('отмена сигналом (Claude Code начал новую перерисовку): stg выходит с 0 и снимает группу прежней строки; сигнал до записи — выход 0, замка нет', async () => {
    const home = makeHome({ apiBase: 'http://127.0.0.1:9' });
    const pidFile = path.join(home.aux, 'grandchild.pid');
    const run = (args: string[], stdinEnd: string | null): { child: ReturnType<typeof spawn>; done: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } => {
      const child = spawn(process.execPath, [CLI, ...args], { env: testEnv(home), stdio: ['pipe', 'pipe', 'pipe'] });
      const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
      child.stdin!.on('error', () => undefined);
      if (stdinEnd !== null) child.stdin!.end(stdinEnd);
      return { child, done };
    };
    const a = run(['agent-state', 'statusline', '--then', `(trap '' TERM; exec sleep 30) & echo $! > '${pidFile}'; wait`], JSON.stringify(statusline()));
    await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 5_000, 'запуска прежней строки');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    a.child.kill('SIGTERM');
    assert.deepEqual(await a.done, { code: 0, signal: null });
    await waitUntil(() => !alive(pid), 3_000, `снятия внука ${pid}`);
    // Перехватчик получил сигнал, пока ждал stdin (до записи): выход 0, ни замка, ни временных файлов.
    const b = run(['agent-state', 'hook'], null);
    await new Promise((r) => setTimeout(r, 300));
    b.child.kill('SIGTERM');
    assert.deepEqual(await b.done, { code: 0, signal: null });
    assert.deepEqual(fs.readdirSync(home.dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock')), []);
  });
});

describe('шаблон папки агента: строка состояния и перехватчики (5.12, 5.14)', () => {
  it('stg agent-folder: .claude/agent-state.settings.json — statusLine и PreCompact, PostCompact, StopFailure; подстановки в кавычках; прежняя строка найдена; start.sh — --settings', async () => {
    const home = makeHome({ apiBase: 'http://127.0.0.1:9' });
    const dest = path.join(makeTempDir('agent-'), 'assistant');
    // Прежняя строка состояния — в своём каталоге настроек Claude Code папки агента (claude-hud и т. п.).
    fs.mkdirSync(path.join(dest, '.claude-config'), { recursive: true });
    const prev = `printf 'HUD it'"'"'s ok'`;
    fs.writeFileSync(path.join(dest, '.claude-config', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: prev } }));
    const r = await runCli(['agent-folder', dest, '--node', process.execPath], testEnv(home));
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /записан {2}\.claude\/agent-state\.settings\.json/);
    assert.ok(r.stdout.includes(`прежняя строка состояния: ${prev} (из .claude-config/settings.json)`), r.stdout);
    const file = path.join(dest, '.claude', 'agent-state.settings.json');
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      statusLine: { type: string; command: string };
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
    };
    assert.equal(v.statusLine.type, 'command');
    const q = (x: string): string => `'${x.replace(/'/g, `'\\''`)}'`;
    assert.equal(v.statusLine.command, `${q(process.execPath)} ${q(CLI)} agent-state statusline --home ${q(home.dir)} --then ${q(prev)}`);
    assert.deepEqual(Object.keys(v.hooks).sort(), ['PostCompact', 'PreCompact', 'StopFailure']);
    for (const k of Object.keys(v.hooks)) assert.equal(v.hooks[k]![0]!.hooks[0]!.command, `${q(process.execPath)} ${q(CLI)} agent-state hook --home ${q(home.dir)}`);
    const start = fs.readFileSync(path.join(dest, 'start.sh'), 'utf8');
    assert.match(start, /set -- --settings "\$PWD\/\.claude\/agent-state\.settings\.json" "\$@"/);
    assert.match(start, /exec claude --dangerously-load-development-channels server:smart-telegram-gateway "\$@"/);
    assert.equal(spawnSync('sh', ['-n', path.join(dest, 'start.sh')]).status, 0);

    // Команды из файла — через sh, как их запустит Claude Code: без окружения канала.
    const bare = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' };
    const out = execFileSync('/bin/sh', ['-c', v.statusLine.command], { input: JSON.stringify(statusline()), env: bare, encoding: 'utf8' });
    assert.equal(out, "HUD it's ok", 'прежняя строка агента — как была');
    assert.equal(readAgentStateFile(home.dir)?.statusline?.context_pct, 16.4);
    const hookOut = execFileSync('/bin/sh', ['-c', v.hooks.PreCompact![0]!.hooks[0]!.command], { input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 's1' }), env: bare, encoding: 'utf8' });
    assert.equal(hookOut, '');
    assert.ok(readAgentStateFile(home.dir)?.compact);

    // Повторное развёртывание с --statusline-then '' — своя строка; файл переписан (он наш, как .mcp.json).
    const r2 = await runCli(['agent-folder', dest, '--node', process.execPath, '--statusline-then', ''], testEnv(home));
    assert.equal(r2.code, 0, r2.stderr);
    assert.match(r2.stdout, /прежняя строка состояния: нет \(--statusline-then ''\)/);
    const v2 = JSON.parse(fs.readFileSync(file, 'utf8')) as { statusLine: { command: string } };
    assert.ok(v2.statusLine.command.endsWith("--then ''"), v2.statusLine.command);
  });

  it('прежняя строка — по старшинству Claude Code: .claude/settings.local.json → .claude/settings.json → пользователь; не нашлась — из прежнего файла настроек; нигде — так и сказано', async () => {
    const home = makeHome({ apiBase: 'http://127.0.0.1:9' });
    const dest = path.join(makeTempDir('agent-'), 'assistant');
    const put = (rel: string, command: string): void => {
      fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
      fs.writeFileSync(path.join(dest, rel), JSON.stringify({ statusLine: { type: 'command', command } }));
    };
    const deploy = async (...extra: string[]): Promise<{ out: string; then: string }> => {
      const r = await runCli(['agent-folder', dest, '--node', process.execPath, ...extra], testEnv(home));
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const v = JSON.parse(fs.readFileSync(path.join(dest, '.claude', 'agent-state.settings.json'), 'utf8')) as { statusLine: { command: string } };
      return { out: r.stdout, then: /--then ('.*')$/.exec(v.statusLine.command)![1]! };
    };
    put(path.join('.claude-config', 'settings.json'), 'hud-user');
    put(path.join('.claude', 'settings.json'), 'hud-project');
    put(path.join('.claude', 'settings.local.json'), 'hud-local');
    let d = await deploy();
    assert.equal(d.then, "'hud-local'");
    assert.match(d.out, /прежняя строка состояния: hud-local \(из \.claude\/settings\.local\.json\)/);
    fs.rmSync(path.join(dest, '.claude', 'settings.local.json'));
    d = await deploy();
    assert.equal(d.then, "'hud-project'", 'проект старше пользователя');
    // В настройках её больше нет — сохраняется та, что была в нашем прежнем файле (её задали раньше).
    fs.rmSync(path.join(dest, '.claude', 'settings.json'));
    fs.rmSync(path.join(dest, '.claude-config', 'settings.json'));
    d = await deploy();
    assert.equal(d.then, "'hud-project'");
    assert.match(d.out, /прежняя строка состояния: hud-project \(из \.claude\/agent-state\.settings\.json\)/);
    await deploy('--statusline-then', '');
    d = await deploy();
    assert.equal(d.then, "''");
    assert.match(d.out, /прежняя строка состояния: не найдена \(смотрел \.claude\/settings\.local\.json, \.claude\/settings\.json, \.claude-config\/settings\.json, \.claude\/agent-state\.settings\.json\) — внизу экрана агента будет своя строка/);
  });

  it('stg agent-state settings — тот же файл на stdout (для сессии, развёрнутой не этим шаблоном: claude --resume … --settings)', async () => {
    const home = makeHome({ apiBase: 'http://127.0.0.1:9' });
    const r = await runCli(['agent-state', 'settings', '--node', '/opt/homebrew/bin/node', '--statusline-then', 'npx claude-hud'], testEnv(home));
    assert.equal(r.code, 0, r.stderr);
    const v = JSON.parse(r.stdout) as { statusLine: { command: string }; hooks: Record<string, unknown> };
    assert.equal(v.statusLine.command, `'/opt/homebrew/bin/node' '${CLI}' agent-state statusline --home '${home.dir}' --then 'npx claude-hud'`);
    assert.deepEqual(Object.keys(v.hooks).sort(), ['PostCompact', 'PreCompact', 'StopFailure']);
    assert.match(r.stderr, /прежняя строка состояния: npx claude-hud \(задана флагом\)/);
    const bad = await runCli(['agent-state', 'settings', '--лишнее'], testEnv(home));
    assert.equal(bad.code, 2);
    // Без прежней строки — stdout только файл, в stderr — что строка будет своя и как сохранить прежнюю.
    const none = await runCli(['agent-state', 'settings', '--node', '/opt/homebrew/bin/node'], testEnv(home));
    assert.equal(none.code, 0);
    assert.ok((JSON.parse(none.stdout) as { statusLine: { command: string } }).statusLine.command.endsWith("--then ''"));
    assert.match(none.stderr, /прежняя строка состояния: не задана — внизу экрана агента будет своя строка; сохранить прежнюю \(claude-hud и т\. п\.\): --statusline-then '<команда>' или --agent-dir/);
    // --agent-dir: поиск в папке сессии и в настройках пользователя сессии (--claude-config).
    const dir = makeTempDir('sess-');
    const user = makeTempDir('cfg-');
    fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/.claude/hud.sh' } }));
    const found = await runCli(['agent-state', 'settings', '--node', '/opt/homebrew/bin/node', '--agent-dir', dir, '--claude-config', user], testEnv(home));
    assert.equal(found.code, 0, found.stderr);
    assert.ok((JSON.parse(found.stdout) as { statusLine: { command: string } }).statusLine.command.endsWith(`--then 'bash ~/.claude/hud.sh'`));
    assert.ok(found.stderr.includes(`прежняя строка состояния: bash ~/.claude/hud.sh (из ${path.join(user, 'settings.json')})`), found.stderr);
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'hud-project' } }));
    const project = await runCli(['agent-state', 'settings', '--agent-dir', dir, '--claude-config', user], testEnv(home));
    assert.ok((JSON.parse(project.stdout) as { statusLine: { command: string } }).statusLine.command.endsWith(`--then 'hud-project'`), 'проект старше пользователя');
  });
});
