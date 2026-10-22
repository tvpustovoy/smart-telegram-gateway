// Нарезка длинного сообщения (TECH-SPEC 5.5, Ш-9): по готовому HTML; разрез не внутри тега и не внутри графемы
// (Intl.Segmenter); каждая часть вместе с меткой (1/N) ≤ 4096 единиц UTF-16. Элемент, через который прошёл разрез,
// закрывается в конце части и открывается снова в начале следующей — каждая часть сама по себе правильный HTML.
// Меряется то, что уходит в Telegram (строка HTML), — это строже, чем видимый текст, и запасной путь «без разметки»
// тоже укладывается в предел.

import { escapeHtml } from './markdown.js';

export const TELEGRAM_TEXT_LIMIT = 4096;

const segmenter = new Intl.Segmenter('ru', { granularity: 'grapheme' });

export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

/** Начало текста не длиннее max единиц UTF-16, по границе графемы. */
export function cutGraphemes(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max) return { text: s, cut: false };
  let out = '';
  for (const g of graphemes(s)) {
    if (out.length + g.length > max) break;
    out += g;
  }
  return { text: out, cut: true };
}

type Token =
  | { t: 'open'; name: string; raw: string }
  | { t: 'close'; name: string; raw: string }
  | { t: 'text'; raw: string; breakAfter: 0 | 1 | 2 };

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"' };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
    return ENT[name] ?? whole;
  });
}

function tokenize(html: string): Token[] {
  const out: Token[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;
  let last = 0;
  const pushText = (raw: string): void => {
    for (const g of graphemes(decode(raw))) {
      out.push({ t: 'text', raw: escapeHtml(g), breakAfter: g === '\n' ? 2 : /^\s$/.test(g) ? 1 : 0 });
    }
  };
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m.index > last) pushText(html.slice(last, m.index));
    const name = m[1]!.toLowerCase();
    out.push(m[0].startsWith('</') ? { t: 'close', name, raw: m[0] } : { t: 'open', name, raw: m[0] });
    last = re.lastIndex;
  }
  if (last < html.length) pushText(html.slice(last));
  return out;
}

const closeTag = (name: string): string => `</${name}>`;

function closeLen(stack: Array<{ name: string; raw: string }>): number {
  return stack.reduce((n, s) => n + closeTag(s.name).length, 0);
}

function closeAll(stack: Array<{ name: string; raw: string }>): string {
  return [...stack].reverse().map((s) => closeTag(s.name)).join('');
}

/** Разложить токены на части с бюджетом budget (без префикса и метки). */
function pack(tokens: Token[], budget: number): string[] {
  const parts: string[] = [];
  let stack: Array<{ name: string; raw: string }> = [];
  let body = '';
  let start = '';
  // Лучшее место разреза в текущей части: после перевода строки, иначе после пробела.
  let mark: { i: number; body: string; stack: Array<{ name: string; raw: string }>; weight: number } | null = null;
  let hasText = false;
  let i = 0;
  const finish = (b: string, st: Array<{ name: string; raw: string }>): void => {
    // Хвостовые открывающие теги без текста переносятся в следующую часть.
    let trimmed = b;
    const tail = [...st];
    while (tail.length) {
      const top = tail[tail.length - 1]!;
      if (trimmed.endsWith(top.raw)) {
        trimmed = trimmed.slice(0, -top.raw.length);
        tail.pop();
      } else break;
    }
    parts.push(start + trimmed + closeAll(tail));
  };
  while (i < tokens.length) {
    const tok = tokens[i]!;
    const len = start.length + body.length;
    let fits: boolean;
    if (tok.t === 'text') fits = len + tok.raw.length + closeLen(stack) <= budget;
    else if (tok.t === 'open') fits = len + tok.raw.length + closeLen(stack) + closeTag(tok.name).length + 1 <= budget;
    else fits = true;
    if (!fits && hasText) {
      let cutBody = body;
      let cutStack = stack;
      let next = i;
      if (mark && start.length + mark.body.length >= budget * 0.5) {
        cutBody = mark.body;
        cutStack = mark.stack;
        next = mark.i;
      }
      finish(cutBody, cutStack);
      stack = cutStack.map((s) => ({ ...s }));
      start = stack.map((s) => s.raw).join('');
      body = '';
      mark = null;
      hasText = false;
      i = next;
      continue;
    }
    body += tok.raw;
    if (tok.t === 'open') stack.push({ name: tok.name, raw: tok.raw });
    else if (tok.t === 'close') {
      const idx = stack.map((s) => s.name).lastIndexOf(tok.name);
      if (idx >= 0) stack.splice(idx, 1);
    } else {
      hasText = true;
      if (tok.breakAfter && (!mark || tok.breakAfter >= mark.weight || start.length + body.length - mark.body.length > budget * 0.2)) {
        mark = { i: i + 1, body, stack: stack.map((s) => ({ ...s })), weight: tok.breakAfter };
      }
    }
    i++;
  }
  if (body !== '' || parts.length === 0) finish(body, stack);
  return parts.filter((p) => p !== '');
}

export interface SplitOptions {
  /** Предел на часть вместе с префиксом и меткой. */
  limit?: number;
  /** Префикс каждой части (пометка «💬 » у ответа агента). */
  prefix?: string;
  /**
   * Метка (i/N) в начале каждой части, когда частей несколько (по умолчанию — да). Без метки — расшифровка голосового
   * ответом на него (5.5; P-19: в начале — без номера сообщения): части — подряд.
   */
  labels?: boolean;
}

/**
 * Нарезать HTML на части. Одна часть — без метки; несколько — `префикс + (i/N) + часть` (без меток — `префикс + часть`).
 * Пустой текст — одна часть из префикса.
 */
export function splitHtml(html: string, opts: SplitOptions = {}): string[] {
  const limit = opts.limit ?? TELEGRAM_TEXT_LIMIT;
  const prefix = opts.prefix ?? '';
  if (prefix.length + html.length <= limit) return [prefix + html];
  const tokens = tokenize(html);
  if (opts.labels === false) return pack(tokens, limit - prefix.length).map((p) => prefix + p);
  for (let digits = 1; digits <= 6; digits++) {
    const labelLen = `(${'9'.repeat(digits)}/${'9'.repeat(digits)}) `.length;
    const parts = pack(tokens, limit - prefix.length - labelLen);
    if (String(parts.length).length <= digits) {
      return parts.map((p, k) => `${prefix}(${k + 1}/${parts.length}) ${p}`);
    }
  }
  throw new Error('splitHtml: слишком длинный текст');
}

/** Нарезать простой текст (служебные строки) по графемам. */
export function splitPlain(text: string, opts: SplitOptions = {}): string[] {
  return splitHtml(escapeHtml(text), opts).map((p) => decode(p));
}

// ——— расшифровка цитатой (0.3.4; R-23 а) ———

/** Цитата длиннее стольких строк на экране телефона — свёрнутой, `<blockquote expandable>` ⟨предл.⟩. */
export const QUOTE_OPEN_LINES = 4;
/** Знаков в строке цитаты на экране телефона — для оценки строк ⟨предл.⟩. */
export const QUOTE_LINE_CHARS = 40;

const QUOTE_OPEN = '<blockquote>';
const QUOTE_OPEN_EXPANDABLE = '<blockquote expandable>';
const QUOTE_CLOSE = '</blockquote>';

/** Сколько строк займёт текст в цитате на телефоне: каждый абзац — по QUOTE_LINE_CHARS графем в строке, не меньше одной. */
export function quoteLines(text: string): number {
  return text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(graphemes(line).length / QUOTE_LINE_CHARS)), 0);
}

/**
 * Простой текст → части-цитаты HTML Telegram (0.3.4, R-23 а: расшифровка — цитатой, тогда видно, что это не слова
 * агента): текст экранирован (`& < >`), каждая часть — `<blockquote>`, а часть длиннее QUOTE_OPEN_LINES строк —
 * `<blockquote expandable>` (свёрнута, раскрывается касанием; Bot API, HTML style — сверено по @grammyjs/types 5.0.0,
 * message.d.ts) ⟨предл.⟩. Части — без меток (i/N) (P-19: в начале — без номера сообщения), каждая вместе с
 * разметкой ≤ limit (мерится строка HTML: строже видимого текста, и запасной путь без разметки тоже укладывается).
 */
export function splitQuote(text: string, opts: { limit?: number } = {}): string[] {
  const limit = opts.limit ?? TELEGRAM_TEXT_LIMIT;
  const budget = limit - QUOTE_OPEN_EXPANDABLE.length - QUOTE_CLOSE.length;
  return splitHtml(escapeHtml(text), { labels: false, limit: budget }).map((p) => {
    const open = quoteLines(decode(p)) > QUOTE_OPEN_LINES ? QUOTE_OPEN_EXPANDABLE : QUOTE_OPEN;
    return `${open}${p}${QUOTE_CLOSE}`;
  });
}
