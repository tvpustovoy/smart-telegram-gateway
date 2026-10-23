// M13 · скрипт запуска адаптера Codex (#55): scripts/codex-agent-start.sh --print — команда для окна: тот же скрипт с
// --here, папка агента, каталог бота, codex и node — каждый одним словом оболочки (пробелы и кавычки в путях не ломают
// команду). Окна, tmux и сам адаптер в тесте не запускаются.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { FAKE_CODEX_ENTRY } from 'stg-fake-codex';
import { makeTempDir } from './harness.js';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(require.resolve('stg-codex/package.json')), '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'codex-agent-start.sh');

function run(args: string[], env: Record<string, string> = {}): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: makeTempDir('stg-cxh-'), ...env }, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Слова команды так, как их увидит оболочка. */
function words(cmd: string): string[] {
  const r = spawnSync('sh', ['-c', 'eval "set -- $1"; printf "%s\\n" "$@"', '_', cmd], { encoding: 'utf8' });
  return r.stdout.split('\n').slice(0, -1);
}

describe('M13 · scripts/codex-agent-start.sh', () => {
  it('--print: команда окна — этот же скрипт с --here и полными путями; пути с пробелом и кавычкой — одним словом', () => {
    const root = makeTempDir('stg-cxs-');
    const agent = path.join(root, "агент it's mine");
    const home = path.join(root, 'bot home');
    fs.mkdirSync(agent);
    fs.mkdirSync(home);
    const r = run(['--print', '--agent-dir', agent, '--stg-home', home, '--codex', FAKE_CODEX_ENTRY, '--node', process.execPath]);
    assert.equal(r.code, 0, r.stderr);
    const w = words(r.stdout.trim());
    assert.deepEqual(w, [
      fs.realpathSync(SCRIPT),
      '--here',
      '--agent-dir',
      fs.realpathSync(agent),
      '--stg-home',
      fs.realpathSync(home),
      '--codex',
      FAKE_CODEX_ENTRY,
      '--node',
      process.execPath,
    ]);
    assert.deepEqual(fs.readdirSync(agent), [], 'в папку агента скрипт не пишет');
  });

  it('каталог бота по умолчанию — STG_HOME; без него — единственный в ~/.smart-telegram-gateway; двух — отказ', () => {
    const root = makeTempDir('stg-cxs-');
    const agent = path.join(root, 'agent');
    fs.mkdirSync(agent);
    const viaEnv = run(['--print', '--agent-dir', agent, '--codex', FAKE_CODEX_ENTRY, '--node', process.execPath], { STG_HOME: root });
    assert.equal(viaEnv.code, 0, viaEnv.stderr);
    assert.ok(words(viaEnv.stdout.trim()).includes(fs.realpathSync(root)));
    const userHome = makeTempDir('stg-cxu-');
    fs.mkdirSync(path.join(userHome, '.smart-telegram-gateway', 'only_bot'), { recursive: true });
    const one = spawnSync('bash', [SCRIPT, '--print', '--agent-dir', agent, '--codex', FAKE_CODEX_ENTRY, '--node', process.execPath], { env: { PATH: process.env.PATH ?? '', HOME: userHome }, encoding: 'utf8' });
    assert.equal(one.status, 0, one.stderr);
    assert.ok(words(one.stdout.trim()).includes(fs.realpathSync(path.join(userHome, '.smart-telegram-gateway', 'only_bot'))));
    fs.mkdirSync(path.join(userHome, '.smart-telegram-gateway', 'second_bot'));
    const two = spawnSync('bash', [SCRIPT, '--print', '--agent-dir', agent, '--codex', FAKE_CODEX_ENTRY, '--node', process.execPath], { env: { PATH: process.env.PATH ?? '', HOME: userHome }, encoding: 'utf8' });
    assert.equal(two.status, 1);
    assert.match(two.stderr, /каталогов ботов: 2 — задай --stg-home/);
  });

  it('нет папки агента, нет --agent-dir, нет codex, неизвестный ключ — отказ с причиной', () => {
    const root = makeTempDir('stg-cxs-');
    assert.match(run(['--print', '--stg-home', root]).stderr, /нужна --agent-dir/);
    assert.match(run(['--print', '--agent-dir', path.join(root, 'nope'), '--stg-home', root]).stderr, /нет папки агента/);
    assert.match(run(['--print', '--agent-dir', root, '--stg-home', root, '--node', process.execPath], { PATH: '/usr/bin:/bin' }).stderr, /нет codex в PATH/);
    assert.match(run(['--bogus']).stderr, /не знаю ключ --bogus/);
  });
});
