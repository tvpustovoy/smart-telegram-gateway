// N-3 — зависимости: `npm ls --omit=dev` — только список TECH-SPEC §6 (плюс свои пакеты), SDK MCP закреплён на 1.x;
// дополнительно — то же по package.json (dev-зависимости — только в корне, версии закреплены точно).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ALLOWED = new Set(['@modelcontextprotocol/sdk', 'yaml', 'zod', '@grammyjs/types']);
const ALLOWED_DEV = new Set(['typescript', '@types/node']);

interface Pkg {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[];
}

function readPkg(dir: string): Pkg {
  return JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8')) as Pkg;
}

describe('N-3 · зависимости', () => {
  const root = readPkg('.');
  const workspaces = root.workspaces ?? [];
  const internal = new Set(workspaces.map((w) => readPkg(w).name));

  it('рабочие пространства зависят только от списка TECH-SPEC §6 и друг от друга', () => {
    for (const w of workspaces) {
      const p = readPkg(w);
      for (const dep of Object.keys(p.dependencies ?? {})) {
        assert.ok(ALLOWED.has(dep) || internal.has(dep), `${p.name}: лишняя зависимость ${dep}`);
      }
      assert.deepEqual(Object.keys(p.devDependencies ?? {}), [], `${p.name}: dev-зависимости — только в корне`);
    }
    assert.deepEqual(Object.keys(root.dependencies ?? {}), []);
    for (const dep of Object.keys(root.devDependencies ?? {})) assert.ok(ALLOWED_DEV.has(dep), `корень: лишняя dev-зависимость ${dep}`);
  });

  it('npm ls --omit=dev: прямые зависимости рабочих пространств — только список TECH-SPEC §6; SDK — 1.x', () => {
    interface Node {
      version?: string;
      resolved?: string;
      dependencies?: Record<string, Node>;
    }
    const out = execFileSync('npm', ['ls', '--omit=dev', '--json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const tree = JSON.parse(out) as Node;
    const top = tree.dependencies ?? {};
    const seen = new Map<string, string>();
    for (const [name, node] of Object.entries(top)) {
      if (!internal.has(name)) {
        assert.fail(`корень: прямая зависимость ${name} — не рабочее пространство`);
      }
      for (const [dep, sub] of Object.entries(node.dependencies ?? {})) {
        if (internal.has(dep)) continue;
        assert.ok(ALLOWED.has(dep), `${name}: лишняя зависимость ${dep} (npm ls)`);
        seen.set(dep, sub.version ?? '?');
      }
    }
    assert.deepEqual([...seen.keys()].sort(), [...ALLOWED].sort(), 'все четыре — на месте');
    assert.match(seen.get('@modelcontextprotocol/sdk') ?? '', /^1\.\d+\.\d+$/);
  });

  it('версии закреплены точно; @modelcontextprotocol/sdk — 1.x', () => {
    for (const w of ['.', ...workspaces]) {
      const p = readPkg(w);
      for (const [dep, ver] of Object.entries({ ...p.dependencies, ...p.devDependencies })) {
        if (internal.has(dep)) continue;
        assert.match(ver, /^\d+\.\d+\.\d+$/, `${p.name}: ${dep}@${ver} не закреплена`);
      }
    }
    const sdk = readPkg('packages/channel').dependencies?.['@modelcontextprotocol/sdk'];
    assert.match(sdk ?? '', /^1\.\d+\.\d+$/);
    assert.ok(fs.existsSync(path.join(ROOT, 'package-lock.json')), 'есть package-lock.json');
  });
});
