// A1.7 (модульная часть): Markdown → HTML Telegram и нарезка по графемам ≤ 4096 единиц UTF-16 с меткой (1/N);
// ни графема, ни тег не разорваны; запасной путь без разметки укладывается в предел.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeHtml, htmlToPlain, markdownToTelegramHtml } from './markdown.js';
import { QUOTE_LINE_CHARS, QUOTE_OPEN_LINES, TELEGRAM_TEXT_LIMIT, cutGraphemes, graphemes, quoteLines, splitHtml, splitPlain, splitQuote } from './split.js';

/** Теги сбалансированы, неизвестных нет (как проверяет Telegram). */
function balanced(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    const name = m[2]!;
    if (!['b', 'i', 'code', 'pre', 'a', 'blockquote'].includes(name)) return false;
    if (m[1]) {
      if (stack.pop() !== name) return false;
    } else stack.push(name);
  }
  return stack.length === 0;
}

describe('Markdown → HTML Telegram', () => {
  it('жирный, курсив, код, блок кода, ссылка, цитата; остальное — текст, экранировано', () => {
    assert.equal(markdownToTelegramHtml('**жирно** и *курсив* и _тоже_'), '<b>жирно</b> и <i>курсив</i> и <i>тоже</i>');
    assert.equal(markdownToTelegramHtml('код `a < b && c`'), 'код <code>a &lt; b &amp;&amp; c</code>');
    assert.equal(markdownToTelegramHtml('```ts\nconst x = 1 < 2;\n```'), '<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>');
    assert.equal(markdownToTelegramHtml('```\nplain\n```'), '<pre>plain</pre>');
    assert.equal(markdownToTelegramHtml('[сайт](https://example.com/?a=1&b=2)'), '<a href="https://example.com/?a=1&amp;b=2">сайт</a>');
    // Кавычка в адресе — не ссылка: атрибут не разорвать.
    assert.equal(markdownToTelegramHtml('[x](https://e.com/"onclick)'), '[x](https://e.com/"onclick)');
    assert.equal(markdownToTelegramHtml('> цитата\n> вторая'), '<blockquote>цитата\nвторая</blockquote>');
    assert.equal(markdownToTelegramHtml('# заголовок <script>'), '# заголовок &lt;script&gt;');
    assert.equal(markdownToTelegramHtml('[плохая](javascript:alert(1))'), '[плохая](javascript:alert(1))');
  });

  it('незакрытое и внутрисловное — текстом: snake_case, 2*3, одиночная звёздочка', () => {
    assert.equal(markdownToTelegramHtml('snake_case_name'), 'snake_case_name');
    assert.equal(markdownToTelegramHtml('2 * 3 = 6'), '2 * 3 = 6');
    assert.equal(markdownToTelegramHtml('**не закрыто'), '**не закрыто');
    assert.equal(markdownToTelegramHtml('\\*не курсив\\*'), '*не курсив*');
  });

  it('вложенное: жирное со ссылкой и кодом', () => {
    const html = markdownToTelegramHtml('**см. [тут](https://x.io) и `y`**');
    assert.equal(html, '<b>см. <a href="https://x.io">тут</a> и <code>y</code></b>');
    assert.ok(balanced(html));
  });

  it('время разбора почти линейно: 64 тыс. знаков злого ввода — доли секунды (раньше «*a » × 6000 — 2 с)', () => {
    const inputs = ['*a '.repeat(21_000), '_a '.repeat(21_000), '**a '.repeat(16_000), '['.repeat(64_000), '[a]('.repeat(16_000), '`a '.repeat(21_000), '*a `b _c [d]( '.repeat(4500)];
    for (const md of inputs) {
      const t0 = performance.now();
      markdownToTelegramHtml(md);
      const ms = performance.now() - t0;
      assert.ok(ms < 1000, `${JSON.stringify(md.slice(0, 8))}… × ${md.length}: ${ms.toFixed(0)} мс`);
    }
    // Результат на злом вводе прежний: незакрытое — текстом.
    assert.equal(markdownToTelegramHtml('*a '.repeat(3)), '*a *a *a ');
  });

  it('htmlToPlain: теги прочь, сущности раскрыты', () => {
    assert.equal(htmlToPlain('<b>a &lt; b</b> &amp; <i>c</i>'), 'a < b & c');
  });
});

describe('нарезка', () => {
  it('короткое — одна часть без метки, с префиксом', () => {
    assert.deepEqual(splitHtml('<b>привет</b>', { prefix: '💬 ' }), ['💬 <b>привет</b>']);
  });

  it('A1.7: 9 000 единиц UTF-16 — эмодзи с ZWJ, флаги, кириллица, блок кода на границах частей', () => {
    const family = '👨‍👩‍👧‍👦';
    const flag = '🇷🇺';
    const chunk = `Кириллица и эмодзи ${family}${flag} — `;
    let md = '';
    while (md.length < 3000) md += chunk;
    md += '\n```js\n' + 'const a = "<тег>";\n'.repeat(120) + '```\n';
    while (md.length < 9000) md += `**жирно ${family}** ${flag} текст `;
    assert.ok(md.length >= 9000);
    const html = markdownToTelegramHtml(md);
    const parts = splitHtml(html, { prefix: '💬 ' });
    assert.ok(parts.length >= 3, `частей ${parts.length}`);
    const n = parts.length;
    parts.forEach((p, i) => {
      assert.ok(p.length <= TELEGRAM_TEXT_LIMIT, `часть ${i + 1}: ${p.length}`);
      assert.ok(p.startsWith(`💬 (${i + 1}/${n}) `), p.slice(0, 20));
      assert.ok(balanced(p.slice(`💬 (${i + 1}/${n}) `.length)), `часть ${i + 1} — теги не сбалансированы`);
      // Ни одна графема не разорвана: на стыке нет одиночных суррогатов и обрывков ZWJ-последовательности.
      assert.ok(!/[\uD800-\uDBFF]$/.test(p), `часть ${i + 1} кончается половиной суррогатной пары`);
      assert.ok(!/^[\uDC00-\uDFFF‍️]/.test(p.slice(`💬 (${i + 1}/${n}) `.length)), `часть ${i + 1} начинается обрывком графемы`);
      assert.ok(!/<[^>]*$/.test(p), `часть ${i + 1}: разрез внутри тега`);
      assert.ok(htmlToPlain(p).length <= TELEGRAM_TEXT_LIMIT);
    });
    // Склейка видимого текста частей без меток = исходный видимый текст: ничего не потеряно и не повторено.
    const glued = parts.map((p, i) => htmlToPlain(p).slice(`💬 (${i + 1}/${n}) `.length)).join('');
    assert.equal(glued, htmlToPlain(html));
    // Семьи и флаги — целыми: число графем «семья» в склейке то же.
    assert.equal(glued.split(family).length, htmlToPlain(html).split(family).length);
    // Блок кода, разрезанный по границе, открыт снова в следующей части.
    const withPre = parts.filter((p) => p.includes('<pre>') || p.includes('<pre><code'));
    assert.ok(withPre.length >= 2, `блок кода только в ${withPre.length} части`);
    // Графемы склейки — те же, что у исходника (Intl.Segmenter), и в каждой части — только целые графемы исходника:
    // разорванный флаг или ZWJ-семья дали бы в части обрывок, которого в исходнике нет.
    const sourceSet = new Set(graphemes(htmlToPlain(html)));
    assert.deepEqual(graphemes(glued), graphemes(htmlToPlain(html)));
    parts.forEach((p, i) => {
      for (const g of graphemes(htmlToPlain(p).slice(`💬 (${i + 1}/${n}) `.length))) assert.ok(sourceSet.has(g), `часть ${i + 1}: обрывок графемы «${g}»`);
    });
  });

  it('A1.7: разрез приходится внутрь сплошных флагов и ZWJ-семей (пробелов нет) — графемы целы', () => {
    const cases: Array<[string, string]> = [
      ['флаги', '🇺🇦'.repeat(2100)],
      ['семьи', '👨‍👩‍👧‍👦'.repeat(800)],
      ['флаги и семьи вперемешку', '🇺🇦👨‍👩‍👧‍👦🇷🇺'.repeat(500)],
      ['эмодзи с модификатором и вариантом', '👍🏽❤️'.repeat(1500)],
    ];
    for (const [name, text] of cases) {
      const source = graphemes(text);
      for (const prefix of ['💬 ', '']) {
        const parts = splitHtml(escapeHtml(text), { prefix });
        assert.ok(parts.length >= 2, `${name}: частей ${parts.length}`);
        const n = parts.length;
        const bodies = parts.map((p, i) => {
          assert.ok(p.length <= TELEGRAM_TEXT_LIMIT, `${name}: часть ${i + 1} — ${p.length}`);
          const label = `${prefix}(${i + 1}/${n}) `;
          assert.ok(p.startsWith(label), `${name}: метка части ${i + 1}`);
          return htmlToPlain(p.slice(label.length));
        });
        // Каждая часть — целые графемы исходника, склейка — ровно исходник.
        const set = new Set(source);
        for (const b of bodies) for (const g of graphemes(b)) assert.ok(set.has(g), `${name}: обрывок графемы «${g}»`);
        assert.deepEqual(graphemes(bodies.join('')), source, `${name}: графемы склейки ≠ исходнику`);
      }
    }
  });

  it('метка двузначная, когда частей ≥ 10', () => {
    const parts = splitHtml(escapeHtml('слово '.repeat(8000)), { prefix: '💬 ' });
    assert.ok(parts.length >= 10);
    assert.ok(parts[9]!.startsWith(`💬 (10/${parts.length}) `));
    for (const p of parts) assert.ok(p.length <= TELEGRAM_TEXT_LIMIT);
  });

  it('простой текст служебной строки режется так же, без сущностей', () => {
    const parts = splitPlain('a & b < c '.repeat(1000), { prefix: '' });
    for (const p of parts) {
      assert.ok(p.length <= TELEGRAM_TEXT_LIMIT);
      assert.ok(!p.includes('&amp;'));
    }
  });

  it('без меток (labels: false; расшифровка ответом на голосовое, P-19): части подряд без (i/N), каждая ≤ предела, текст целиком; 💬 в начале второй части остаётся — пометку ставит отправитель', () => {
    const limit = TELEGRAM_TEXT_LIMIT - 2;
    const head = 'а'.repeat(limit - 100);
    const tail = `💬 ${'б '.repeat(300)}конец`;
    const parts = splitPlain(`${head}\n${tail}`, { labels: false, limit });
    assert.equal(parts.length, 2);
    assert.ok(parts.every((p) => p.length <= limit && !/^\(\d+\/\d+\)/.test(p)));
    assert.ok(parts[1]!.startsWith('💬 '), 'разрез по переводу строки: вторая часть начинается с 💬 (sender.ts serviceTextParts помечает её ⚙)');
    assert.equal(parts.join(''), `${head}\n${tail}`);
    // С метками — те же части, но с (i/N).
    assert.ok(splitPlain(`${head}\n${tail}`, { limit }).every((p, i, all) => p.startsWith(`(${i + 1}/${all.length}) `)));
  });

  it('префикс простого текста — в HTML (по проверке 0.3.2: «↪ Имя: » ответа через агента в запасном пути): сущности в имени не раскрываются', () => {
    const relay = '↪ A&amp;B &#9881; <x>: ';
    const one = splitPlain('ответ & ещё', { prefix: escapeHtml(relay) });
    assert.deepEqual(one, [`${relay}ответ & ещё`]);
    const many = splitPlain('слово '.repeat(1500), { prefix: escapeHtml(relay) });
    assert.ok(many.length >= 2);
    many.forEach((p, i) => {
      assert.ok(p.startsWith(`${relay}(${i + 1}/${many.length}) `), p.slice(0, 40));
      assert.ok(p.length <= TELEGRAM_TEXT_LIMIT);
    });
  });

  it('graphemes и cutGraphemes не рвут графему', () => {
    assert.deepEqual(graphemes('a👨‍👩‍👧🇷🇺'), ['a', '👨‍👩‍👧', '🇷🇺']);
    assert.deepEqual(cutGraphemes('ab👨‍👩‍👧', 4), { text: 'ab', cut: true });
  });
});

describe('расшифровка цитатой (0.3.4; R-23 а)', () => {
  const OPEN = '<blockquote>';
  const OPEN_X = '<blockquote expandable>';
  const CLOSE = '</blockquote>';
  const inner = (p: string): string => p.replace(/^<blockquote( expandable)?>/, '').replace(/<\/blockquote>$/, '');

  it('короткая — одна цитата целиком, без меток и пометок; знаки HTML экранированы', () => {
    assert.deepEqual(splitQuote('завтра позвонить юристу'), [`${OPEN}завтра позвонить юристу${CLOSE}`]);
    assert.deepEqual(splitQuote('a < b & c > d "кавычки"'), [`${OPEN}a &lt; b &amp; c &gt; d "кавычки"${CLOSE}`]);
    assert.deepEqual(splitQuote('<b>не тег</b> &amp;'), [`${OPEN}&lt;b&gt;не тег&lt;/b&gt; &amp;amp;${CLOSE}`]);
    assert.equal(htmlToPlain(splitQuote('<b>не тег</b> &amp;')[0]!), '<b>не тег</b> &amp;', 'видимый текст — как сказано');
    assert.deepEqual(splitQuote('💬 скажи, что ответил агент'), [`${OPEN}💬 скажи, что ответил агент${CLOSE}`], 'без ⚙: цитата и так не ответ агента');
  });

  it(`свёрнутая (expandable) — когда длиннее ${QUOTE_OPEN_LINES} строк на телефоне (${QUOTE_LINE_CHARS} знаков в строке)`, () => {
    assert.equal(quoteLines('а'.repeat(QUOTE_LINE_CHARS * QUOTE_OPEN_LINES)), QUOTE_OPEN_LINES);
    assert.ok(splitQuote('а'.repeat(QUOTE_LINE_CHARS * QUOTE_OPEN_LINES))[0]!.startsWith(OPEN));
    assert.ok(splitQuote('а'.repeat(QUOTE_LINE_CHARS * QUOTE_OPEN_LINES + 1))[0]!.startsWith(OPEN_X));
    assert.ok(splitQuote('1\n2\n3\n4')[0]!.startsWith(OPEN), 'четыре короткие строки — открытой');
    assert.ok(splitQuote('1\n2\n3\n4\n5')[0]!.startsWith(OPEN_X), 'пять — свёрнутой');
  });

  it('длинная — части-цитаты подряд, каждая вместе с разметкой ≤ 4096, без меток (i/N); текст целиком; знаки HTML на границах не рвутся', () => {
    const long = Array.from({ length: 1500 }, (_, i) => `слово${i} <&>`).join(' ');
    const parts = splitQuote(long);
    assert.ok(parts.length >= 2, `частей ${parts.length}`);
    for (const p of parts) {
      assert.ok(p.length <= TELEGRAM_TEXT_LIMIT, `часть ${p.length}`);
      assert.ok(balanced(p), p.slice(0, 60));
      assert.ok(p.startsWith(OPEN_X) && p.endsWith(CLOSE), 'длинная часть — свёрнутой цитатой');
      assert.ok(!/^\(\d+\/\d+\)/.test(inner(p)), 'без меток');
      assert.ok(!/&(?!amp;|lt;|gt;)/.test(inner(p)), 'сущности целы');
    }
    assert.equal(parts.map((p) => htmlToPlain(p)).join(''), long, 'текст целиком');
    // Запасной путь без разметки (400 разбора) с пометкой «⚙ » тоже ≤ 4096.
    assert.ok(parts.every((p) => htmlToPlain(p).length + 2 <= TELEGRAM_TEXT_LIMIT));
  });
});
