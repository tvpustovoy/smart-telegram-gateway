// Правила канала для двух сред (#55): текст для Claude Code меняется только осознанно — хеш закреплён (с ним сменится
// INSTRUCTIONS_VERSION, и всем разговорам Claude придёт событие «правила канала»); текст для Codex — без пробы, без
// событий правил, без терминала и атрибута trust. Описания инструментов для Codex — так же.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { CODEX_EDITS, CODEX_INSTRUCTIONS, INSTRUCTIONS, INSTRUCTIONS_VERSION, instructionsFor, instructionsVersionOf } from './instructions.js';
import { CODEX_TOOL_EDITS, TOOLS, toolsFor } from './tools.js';

/**
 * SHA-256 текста для Claude Code — при правке текста здесь меняется осознанно, вместе с версией: разговорам, получившим
 * прежнюю версию, шлюз один раз пришлёт событие «правила канала». 0.3.6 — 9470ccc980ca…; с #60 (картинка — фото,
 * send_file as: "file") — эта.
 */
const CLAUDE_SHA256 = '24a2f2e38ccecf92f96ab86f1238e0362d03aca76c5c13ca8fbfbaaca5bc55d5';

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe('правила канала: Claude Code и Codex', () => {
  it('для Claude Code — INSTRUCTIONS байт в байт; версия — от этого текста (с #60 — новая)', () => {
    assert.equal(instructionsFor('claude'), INSTRUCTIONS);
    assert.equal(crypto.createHash('sha256').update(INSTRUCTIONS).digest('hex'), CLAUDE_SHA256);
    assert.equal(INSTRUCTIONS_VERSION, CLAUDE_SHA256.slice(0, 12));
    assert.equal(instructionsVersionOf(INSTRUCTIONS), INSTRUCTIONS_VERSION);
  });

  it('каждая правка для Codex находит своё место ровно один раз', () => {
    for (const [from] of CODEX_EDITS) assert.equal(occurrences(INSTRUCTIONS, from), 1, `«${from.slice(0, 60)}…»`);
  });

  it('у Codex нет пробы, событий правил, терминала, атрибута trust и parcels/ в рабочей папке; есть песочница и «сначала короткий reply»', () => {
    const t = instructionsFor('codex');
    assert.equal(t, CODEX_INSTRUCTIONS);
    for (const w of ['проверка канала', 'правила канала, версия', 'атрибуте trust', 'у терминала', 'запросы разрешений до него', 'parcels/ в твоей рабочей папке', 'получил ли этот разговор правила']) {
      if (w === 'у терминала') {
        // «не у терминала» — есть; «ждут у терминала» (Claude) — нет.
        assert.ok(!t.includes('ждут у терминала'), 'ждут у терминала');
        continue;
      }
      assert.ok(!t.includes(w), `в тексте для Codex есть «${w}»`);
    }
    for (const w of ['не у терминала', 'песочнице', 'сначала короткий reply', 'несколько событий подряд', '[адаптер · …]', '«［адаптер …»', 'reply(seq, text)', 'done(seqs)', 'episode_summary', 'чужое', 'Markdown']) {
      assert.ok(t.includes(w), `в тексте для Codex нет «${w}»`);
    }
    assert.notEqual(instructionsVersionOf(t), INSTRUCTIONS_VERSION);
  });

  it('инструменты: для Claude — TOOLS как есть; для Codex — те же имена и схемы, описания без пробы и правил канала', () => {
    assert.equal(toolsFor('claude'), TOOLS);
    for (const [name, from] of CODEX_TOOL_EDITS) {
      const t = TOOLS.find((x) => x.name === name)!;
      assert.equal(occurrences(t.description, from), 1, `${name}: «${from.slice(0, 60)}…»`);
    }
    const codex = toolsFor('codex');
    assert.deepEqual(codex.map((t) => t.name), TOOLS.map((t) => t.name));
    assert.deepEqual(codex.map((t) => t.inputSchema), TOOLS.map((t) => t.inputSchema));
    for (const t of codex) {
      for (const w of ['проверочн', 'правила канала»', 'parcels/ в твоей рабочей папке']) assert.ok(!t.description.includes(w), `${t.name}: «${w}»`);
    }
  });
});
