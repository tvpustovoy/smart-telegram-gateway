#!/usr/bin/env node
// Release check: scans the repository for data that must not be published.
//
//   STG_DENYLIST=/path/to/denylist.txt node scripts/release-check.mjs [--history]
//
// Two kinds of checks run on every line:
//   1. A private denylist (the file named by STG_DENYLIST; it lives outside the repository).
//      One JavaScript regular expression per line, compiled with the flags `iu`.
//      Lines starting with `#` are comments; blank lines are ignored; surrounding whitespace is trimmed.
//      In `u` mode `\#` is not a valid escape, so a pattern that starts with `#` is written as `[#]`.
//      Denylist patterns are also tried on a copy of the line with invisible characters removed and NFKC applied,
//      so a name split by a zero-width joiner is still found.
//   2. Built-in checks that need no list: home-directory paths, e-mail addresses, phone numbers,
//      Telegram bot tokens, API keys and private keys.
//
// What is scanned:
//   - default: every file git would commit (`git ls-files --cached --others --exclude-standard`) and its path;
//   - with --history: in addition, every object reachable from any ref (`git rev-list --all --objects`):
//     blob contents, their paths, commit and tag messages, and author/committer lines.
//
// Output: one finding per line, `file:line:match  [rule]`. Exit code 0 = clean, 1 = findings, 2 = usage or config error.
// No dependencies; Node >= 22.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const USAGE = `usage: STG_DENYLIST=<file> node scripts/release-check.mjs [--history]

  --history   also scan every object in the git history (blobs, paths, commit and tag messages)
  STG_ALLOWED_AUTHOR="Name <email>"  author/committer identity that is expected in commits and not reported
  --help      show this help

STG_DENYLIST  path to the denylist: one JavaScript regular expression per line (flags iu), # comments.
              Without it only the built-in checks run.`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = args.filter((a) => a !== '--history');
if (unknown.length > 0) {
  console.error(`release-check: unknown argument ${unknown[0]}\n\n${USAGE}`);
  process.exit(2);
}
const withHistory = args.includes('--history');
const allowedAuthor = process.env.STG_ALLOWED_AUTHOR?.trim() || '';

// ---------- rules ----------

/** @typedef {{ label: string, re: RegExp, accept?: (match: string, line: string, index: number) => boolean }} Rule */

/** @returns {Rule[]} */
function loadDenylist() {
  const file = process.env.STG_DENYLIST;
  if (!file) {
    console.error('release-check: STG_DENYLIST is not set; running the built-in checks only');
    return [];
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`release-check: cannot read STG_DENYLIST (${err.code ?? err.message})`);
    process.exit(2);
  }
  const rules = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const src = lines[i].trim();
    if (src === '' || src.startsWith('#')) continue;
    try {
      // The pattern itself is never printed: the denylist is private.
      rules.push({ label: `denylist:${i + 1}`, re: new RegExp(src, 'giu') });
    } catch (err) {
      console.error(`release-check: denylist line ${i + 1}: invalid regular expression (${err.message.replace(/\/.*\/[a-z]*: /, '')})`);
      process.exit(2);
    }
  }
  if (rules.length === 0) console.error('release-check: the denylist has no patterns');
  return rules;
}

// A secret with a long run of one character (sk-ant-…-ZZZZZZZZZZZZ) is a test placeholder: real secrets are random.
const notPlaceholder = (m) => !/(.)\1{11}/.test(m);

const EXAMPLE_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost|local)$/i;

/** @type {Rule[]} */
const BUILTIN = [
  // A real home directory. Placeholders such as <name> or $USER do not match.
  { label: 'home-path', re: /\/Users\/(?!Shared\/)[A-Za-z0-9][A-Za-z0-9._-]*\//g },
  {
    label: 'email',
    re: /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g,
    accept: (m, line, index) => {
      const [local, domain] = [m.slice(0, m.indexOf('@')), m.slice(m.indexOf('@') + 1)];
      if (EXAMPLE_DOMAIN.test(domain)) return false;
      if (/^no-?reply$/i.test(local) || /(?:^|\.)users\.noreply\.github\.com$/i.test(domain)) return false;
      if (local === 'git') return false; // git@github.com:…
      const before = line.slice(0, index);
      if (/:\/\/[^\s/@]*:?$/.test(before) || (before.endsWith(':') && !/mailto:$/i.test(before))) return false; // URL userinfo
      return true;
    },
  },
  {
    label: 'phone',
    re: /(?<![\w+])\+\d[\d ().-]{7,20}\d(?![\w])|(?<!\d)8 ?\(\d{3}\) ?\d{3}[ -]?\d{2}[ -]?\d{2}(?!\d)|(?<![\d)])\(\d{3}\) ?\d{3}-\d{4}(?!\d)/g,
    accept: (m) => {
      const digits = m.replace(/\D/g, '').length;
      return digits >= 10 && digits <= 15;
    },
  },
  { label: 'telegram-token', re: /(?<![\w:])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, accept: notPlaceholder },
  { label: 'api-key', re: /(?<![\w-])sk-[A-Za-z0-9_-]{32,}|(?<!\w)sk_[A-Za-z0-9]{32,}/g, accept: notPlaceholder },
  { label: 'github-token', re: /(?<!\w)(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g, accept: notPlaceholder },
  { label: 'aws-key', re: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g, accept: notPlaceholder },
  { label: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

const DENYLIST = loadDenylist();

// Characters that render as nothing (or as blank) and can hide a name: format characters (zero-width joiner,
// bidi controls, tag characters…), the combining grapheme joiner, Hangul fillers, the braille blank,
// variation selectors.
const INVISIBLE = /[\p{Cf}͏ᅟᅠㅤﾠ⠀︀-️\u{E0100}-\u{E01EF}]/gu;

/** Shows a match on one line: invisible and control characters as \u{…}, long matches cut. */
function show(text) {
  let s = text.replace(/[\p{Cf}\p{Cc}͏ᅟᅠㅤﾠ⠀︀-️]/gu, (c) => `\\u{${c.codePointAt(0).toString(16).toUpperCase()}}`);
  if (s.length > 160) s = `${s.slice(0, 157)}...`;
  return s;
}

/**
 * Scans one text. Returns findings as { line, match, label }.
 * @param {string} text
 */
function scanText(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (line === '') continue;
    const seen = new Set();
    for (const rule of [...DENYLIST, ...BUILTIN]) {
      for (const m of line.matchAll(rule.re)) {
        if (m[0] === '') continue;
        if (rule.accept && !rule.accept(m[0], line, m.index)) continue;
        seen.add(rule.label);
        out.push({ line: n + 1, match: m[0], label: rule.label });
      }
    }
    // Denylist on the visible form of the line (invisible characters removed, compatibility forms folded).
    const visible = line.normalize('NFKC').replace(INVISIBLE, '');
    if (visible !== line) {
      for (const rule of DENYLIST) {
        if (seen.has(rule.label)) continue;
        for (const m of visible.matchAll(rule.re)) {
          if (m[0] === '') continue;
          out.push({ line: n + 1, match: m[0], label: `${rule.label}, hidden characters` });
        }
      }
    }
  }
  return out;
}

const findings = [];
function report(where, list) {
  for (const f of list) findings.push(`${where}:${f.line}:${show(f.match)}  [${f.label}]`);
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

const decoder = new TextDecoder('utf-8');

// ---------- the tree ----------

function git(argv, input) {
  return execFileSync('git', argv, { encoding: 'buffer', maxBuffer: 1 << 30, input, stdio: ['pipe', 'pipe', 'inherit'] });
}

let root;
try {
  root = git(['rev-parse', '--show-toplevel']).toString('utf8').trim();
} catch {
  console.error('release-check: not inside a git repository');
  process.exit(2);
}

const files = [...new Set(git(['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf8').split('\0'))].filter(Boolean);
let scannedFiles = 0;
for (const rel of files) {
  const abs = path.join(root, rel);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    continue; // deleted in the working tree: it will not be committed
  }
  report('(path)', scanText(rel).map((f) => ({ ...f, line: rel })));
  if (!st.isFile()) continue;
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) continue;
  scannedFiles++;
  report(rel, scanText(decoder.decode(buf)));
}

// ---------- the history ----------

let scannedObjects = 0;
if (withHistory) {
  const pathOf = new Map();
  for (const row of git(['-C', root, 'rev-list', '--all', '--objects']).toString('utf8').split('\n')) {
    if (!row) continue;
    const sp = row.indexOf(' ');
    const sha = sp < 0 ? row : row.slice(0, sp);
    if (!pathOf.has(sha)) pathOf.set(sha, sp < 0 ? '' : row.slice(sp + 1));
  }
  const shas = [...pathOf.keys()];
  if (shas.length > 0) {
    const r = spawnSync('git', ['-C', root, 'cat-file', '--batch'], { input: `${shas.join('\n')}\n`, maxBuffer: 2 ** 31 });
    if (r.status !== 0) {
      console.error(`release-check: git cat-file failed (${r.stderr?.toString().trim() ?? r.error?.message})`);
      process.exit(2);
    }
    const out = r.stdout;
    let pos = 0;
    while (pos < out.length) {
      const nl = out.indexOf(10, pos);
      if (nl < 0) break;
      const [sha, type, sizeText] = out.subarray(pos, nl).toString('utf8').split(' ');
      if (type === 'missing' || sizeText === undefined) {
        pos = nl + 1;
        continue;
      }
      const size = Number(sizeText);
      const body = out.subarray(nl + 1, nl + 1 + size);
      pos = nl + 1 + size + 1;
      const short = sha.slice(0, 10);
      if (type === 'blob') {
        const p = pathOf.get(sha) ?? '';
        if (p) report(`(path)@${short}`, scanText(p).map((f) => ({ ...f, line: p })));
        if (isBinary(body)) continue;
        scannedObjects++;
        report(`${p || '(no path)'}@${short}`, scanText(decoder.decode(body)));
      } else if (type === 'commit' || type === 'tag') {
        scannedObjects++;
        // Object ids in tree/parent/object lines are not text; everything else (author, committer, message) is.
        const text = decoder
          .decode(body)
          .split('\n')
          .map((l) => (/^(?:tree|parent|object|type) [0-9a-f]{40,64}$|^type \w+$/.test(l) ? '' : l))
          // The project's own commit identity (STG_ALLOWED_AUTHOR="Name <email>") is expected in author/committer lines.
          .map((l) => (allowedAuthor && (l.startsWith(`author ${allowedAuthor} `) || l.startsWith(`committer ${allowedAuthor} `)) ? '' : l))
          .join('\n');
        report(`${type} ${short}`, scanText(text));
      }
      // Trees: their paths are checked together with the blobs.
    }
  }
}

for (const f of findings) console.log(f);
const scope = withHistory ? `${scannedFiles} files, ${scannedObjects} history objects` : `${scannedFiles} files`;
const rules = `${DENYLIST.length} denylist patterns + ${BUILTIN.length} built-in checks`;
// exitCode, not exit(): a piped stdout must be flushed in full.
if (findings.length > 0) {
  console.error(`release-check: ${findings.length} finding(s) (${scope}; ${rules})`);
  process.exitCode = 1;
} else {
  console.error(`release-check: clean (${scope}; ${rules})`);
}
