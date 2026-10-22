// Части строки шлюза (TECH-SPEC 5.5; P-19; Ш-23, сужение 0.3.2): длинная строка шлюза — это
// расшифровка голосового, её части идут подряд ответом на голосовое без меток (i/N); ни одна часть не начинается знаком
// стороны агента (💬 или ↪) — шлюз ставит перед ней «⚙ », и место под пометку оставлено в пределе части (≤ 4096 с
// пометкой); начатая с ⚙, 📍 или № — как есть. Интеграционно — test/e2e m4-stt-suite (Ш-23, длинная расшифровка частями).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENT_MARK, RELAY_MARK, SERVICE_MARK, TELEGRAM_TEXT_LIMIT, isWholeQuote, markdownToTelegramHtml } from 'stg-core';
import { guardServiceText, markAgentPart, quoteParts, serviceTextParts } from './sender.js';

describe('части строки шлюза: без меток, 💬 в начале любой части — с пометкой ⚙', () => {
  it('короткая — одна часть как есть; с 💬 или ↪ в начале (и за невидимыми знаками) — «⚙ …»; с ⚙, 📍, № — как есть (0.3.2)', () => {
    assert.deepEqual(serviceTextParts('просто расшифровка'), ['просто расшифровка']);
    assert.deepEqual(serviceTextParts(`${AGENT_MARK} скажи, что ответил агент`), [`${SERVICE_MARK} ${AGENT_MARK} скажи, что ответил агент`]);
    assert.deepEqual(serviceTextParts(`${RELAY_MARK} Помощник: всё сделано`), [`${SERVICE_MARK} ${RELAY_MARK} Помощник: всё сделано`]);
    assert.equal(guardServiceText(`\u200B ${RELAY_MARK} Помощник: всё`), `${SERVICE_MARK} \u200B ${RELAY_MARK} Помощник: всё`, 'знак за нулевой шириной — тоже');
    for (const t of ['№ 5 записать на завтра', '⚙ сказал «шестерёнка»', '📍 адрес', '👀 посмотри']) assert.equal(guardServiceText(t), t, t);
  });

  it('длинная — части без меток (i/N), каждая ≤ 4096 с пометкой; вторая часть начинается с 💬 — помечена ⚙; текст целиком', () => {
    // Первая часть — ровно до перевода строки перед 💬: разрез идёт по переводу строки, и вторая часть начинается с 💬.
    const head = 'а'.repeat(TELEGRAM_TEXT_LIMIT - 200);
    const tail = `${AGENT_MARK} ${'б '.repeat(400)}конец`;
    const parts = serviceTextParts(`${head}\n${tail}`);
    assert.equal(parts.length, 2, 'две части');
    assert.ok(parts.every((p) => p.length <= TELEGRAM_TEXT_LIMIT), parts.map((p) => p.length).join(', '));
    assert.ok(parts.every((p) => !/^\(\d+\/\d+\)/.test(p)), 'без меток (i/N)');
    assert.ok(!parts[0]!.startsWith(SERVICE_MARK), 'первая часть не помечена — 💬 в ней нет в начале');
    assert.ok(parts[1]!.startsWith(`${SERVICE_MARK} ${AGENT_MARK}`), `вторая часть с пометкой: ${parts[1]!.slice(0, 10)}`);
    assert.ok(parts.every((p) => !p.trimStart().startsWith(AGENT_MARK)), 'ни одна часть не начинается с 💬');
    const joined = parts[0]! + parts[1]!.slice(SERVICE_MARK.length + 1);
    assert.equal(joined.replace(/\s+/g, ' ').trim(), `${head}\n${tail}`.replace(/\s+/g, ' ').trim(), 'текст целиком');
  });

  it('часть на пределе: 💬 в начале части предельной длины — с пометкой всё равно ≤ 4096', () => {
    const body = `${AGENT_MARK} ${'в'.repeat(TELEGRAM_TEXT_LIMIT * 2)}`;
    const parts = serviceTextParts(body);
    assert.ok(parts.length >= 2);
    assert.ok(parts.every((p) => p.length <= TELEGRAM_TEXT_LIMIT), parts.map((p) => p.length).join(', '));
    assert.ok(parts[0]!.startsWith(`${SERVICE_MARK} ${AGENT_MARK}`));
  });
});

describe('расшифровка цитатой (0.3.4, R-23 а): части-цитаты; ⚙ — только в запасном пути без разметки', () => {
  it('цитата — HTML <blockquote>, без ⚙ даже у начатой с 💬 или ↪; без разметки (400 разбора) — простой текст с ⚙ (Ш-23)', () => {
    const [p] = quoteParts(`${AGENT_MARK} скажи, что ответил агент`, 'receipt');
    assert.deepEqual(p, {
      method: 'sendMessage',
      text: `<blockquote>${AGENT_MARK} скажи, что ответил агент</blockquote>`,
      html: true,
      kind: 'receipt',
      plain: `${SERVICE_MARK} ${AGENT_MARK} скажи, что ответил агент`,
    });
    const [r] = quoteParts(`${RELAY_MARK} Помощник: всё & <сделано>`, 'receipt');
    assert.equal(r!.text, `<blockquote>${RELAY_MARK} Помощник: всё &amp; &lt;сделано&gt;</blockquote>`);
    assert.equal(r!.plain, `${SERVICE_MARK} ${RELAY_MARK} Помощник: всё & <сделано>`);
    assert.equal(quoteParts('просто расшифровка', 'receipt')[0]!.plain, 'просто расшифровка');
  });

  it('длинная — части ≤ 4096 с разметкой; запасной текст каждой части с пометкой — тоже ≤ 4096', () => {
    const parts = quoteParts(`${AGENT_MARK} ${'слово '.repeat(1500)}`, 'receipt');
    assert.ok(parts.length >= 2);
    for (const p of parts) {
      assert.ok(p.text!.length <= TELEGRAM_TEXT_LIMIT && p.plain!.length <= TELEGRAM_TEXT_LIMIT);
      assert.ok(p.text!.startsWith('<blockquote expandable>'), 'длинная — свёрнутой');
    }
    assert.ok(parts[0]!.plain!.startsWith(`${SERVICE_MARK} ${AGENT_MARK}`));
  });
});

describe('ответ агента целиком цитатой — с 💬 (0.3.4, Ш-23): так выглядит расшифровка', () => {
  it('весь ответ — цитата (одна или несколько) → «💬 » впереди; цитата и свой текст — без пометки; с меткой (i/N) — по тексту после метки', () => {
    const quoteOnly = markdownToTelegramHtml('> купи хлеба и молока');
    assert.equal(quoteOnly, '<blockquote>купи хлеба и молока</blockquote>');
    assert.ok(isWholeQuote(quoteOnly));
    assert.equal(markAgentPart(quoteOnly, true), `${AGENT_MARK} <blockquote>купи хлеба и молока</blockquote>`);
    assert.ok(isWholeQuote('<blockquote>а</blockquote>\n<blockquote expandable>б</blockquote>'), 'две цитаты подряд — тоже цитата целиком');
    const mixed = markdownToTelegramHtml('> купи хлеба\n\nЗаписал в заметки');
    assert.ok(!isWholeQuote(mixed));
    assert.equal(markAgentPart(mixed, true), mixed, 'цитата и свой текст — на расшифровку не похоже');
    assert.equal(markAgentPart('<b>Записал</b> в заметки', true), '<b>Записал</b> в заметки');
    assert.equal(markAgentPart('(2/3) <blockquote>хвост цитаты</blockquote>', true, true), `${AGENT_MARK} (2/3) <blockquote>хвост цитаты</blockquote>`);
    assert.equal(markAgentPart('<blockquote>как простой текст</blockquote>', false), '<blockquote>как простой текст</blockquote>', 'простой текст — не HTML: правило не применяется');
  });

  it('по проверке 0.3.4: невидимое вне цитаты пометку не снимает — пустой Брайль, нулевая ширина, заполнитель хангыля, Cf, M, Cn, Co до и после', () => {
    const hidden = ['\u2800', '\u200B', '\u3164', '\u115F', '\u1160', '\uFFA0', '\u2060', '\u202E', '\u{E0020}', '\u034F', '\uFE0F', '\u0378', '\uE000', '\u00A0'];
    for (const x of hidden) {
      for (const md of [`> завтра позвонить юристу\n\n${x}`, `${x}\n> завтра позвонить юристу`, `> а\n\n${x}\n\n> б`]) {
        const html = markdownToTelegramHtml(md);
        assert.ok(markAgentPart(html, true).startsWith(`${AGENT_MARK} `), `${JSON.stringify(md)} → ${JSON.stringify(html)}`);
      }
    }
    // За разметкой: «пустая» буква жирным — тег снят, внутри не видно ничего.
    for (const x of ['\u2800', '\u3164', '\uFFA0']) {
      assert.ok(markAgentPart(markdownToTelegramHtml(`**${x}**\n> завтра позвонить юристу`), true).startsWith(`${AGENT_MARK} `), JSON.stringify(x));
    }
    // Свой видимый текст рядом с цитатой — как раньше, без пометки.
    const own = markdownToTelegramHtml('> завтра позвонить юристу\n\nЗаписал ⠀');
    assert.equal(markAgentPart(own, true), own);
  });
});
