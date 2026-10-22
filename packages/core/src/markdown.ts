// Разметка ответа агента (TECH-SPEC 5.5) ⟨предл. принято⟩: агент пишет Markdown, шлюз своим кодом переводит его в
// HTML Telegram — `b`, `i`, `code`, `pre`, `a`, `blockquote`; остальное — как текст. Шлюз шлёт с parse_mode = HTML.
// Незакрытые знаки остаются текстом; HTML от агента не проходит — всё экранируется.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

const ENTITY: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"' };

/** HTML Telegram → простой текст: теги прочь, сущности раскрыты. Для запасного пути «без разметки». */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, name: string) => {
      if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
      if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
      return ENTITY[name] ?? whole;
    });
}

const SAFE_URL = /^(https?:\/\/|tg:\/\/|mailto:)[^\s<>"]+$/i;
const ESCAPABLE = /[\\`*_[\]()~>#+\-.!|{}]/;
/** Пределы ссылки: длиннее — текстом (и разбор не уходит в квадратичный перебор). */
const LINK_TEXT_MAX = 2000;
const LINK_URL_MAX = 2048;

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Разбор одной строки (абзаца) с запоминанием: каждый поиск вперёд делается один раз. Прежний разбор искал закрывающий
 * знак заново от каждой звёздочки и заново искал обратную кавычку на каждом шаге — на «*a » × 6000 это секунды
 * синхронной работы в одном потоке с приёмом. Результат разбора тот же (сверено на случайных строках), время — почти
 * линейное от длины.
 */
class Scan {
  /** Позиции обратных кавычек по возрастанию. */
  private readonly ticks: number[] = [];
  private readonly matchEnd = new Map<number, number>();
  /** S(j) по знаку выделения: -2 — ещё не считано. */
  private readonly memo = new Map<string, Int32Array>();
  private readonly nextCache = new Map<string, { from: number; pos: number }>();

  constructor(readonly s: string) {
    for (let i = s.indexOf('`'); i >= 0; i = s.indexOf('`', i + 1)) this.ticks.push(i);
  }

  /** Первое вхождение строки ch не раньше j (кэш монотонный: запросы идут вперёд). */
  next(ch: string, j: number): number {
    const c = this.nextCache.get(ch);
    if (c && c.from <= j && (c.pos >= j || c.pos === -1)) return c.pos;
    const pos = this.s.indexOf(ch, j);
    this.nextCache.set(ch, { from: j, pos });
    return pos;
  }

  /** Первая обратная кавычка не раньше j; -1 — нет. */
  tickFrom(j: number): number {
    const t = this.ticks;
    let lo = 0;
    let hi = t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid]! < j) lo = mid + 1;
      else hi = mid;
    }
    return lo < t.length ? t[lo]! : -1;
  }

  /** Длина серии обратных кавычек с позиции t. */
  runLen(t: number): number {
    let n = 0;
    while (this.s.charCodeAt(t + n) === 96) n++;
    return n;
  }

  /** Где та же серия встречается снова (конец кода); -1 — нигде. */
  spanEnd(t: number): number {
    let e = this.matchEnd.get(t);
    if (e === undefined) {
      const n = this.runLen(t);
      e = this.s.indexOf('`'.repeat(n), t + n);
      this.matchEnd.set(t, e);
    }
    return e;
  }

  private staticClose(k: number, delim: string): boolean {
    const s = this.s;
    const before = s[k - 1];
    const after = s[k + delim.length];
    const single = delim.length === 1;
    // Одиночный знак не должен быть частью двойного.
    const partOfDouble = single && (after === delim || before === delim);
    const underscoreOk = delim[0] !== '_' || !isWordChar(after);
    return !isSpace(before) && underscoreOk && !partOfDouble;
  }

  /**
   * S(j): первый закрывающий delim не раньше j. Код внутри выделения пропускается целиком: если до ближайшего знака
   * стоит обратная кавычка и её серия где-то закрывается — прыжок за код. Итеративно, с запоминанием на всём пути.
   */
  private closeFrom(j0: number, delim: string): number {
    let m = this.memo.get(delim);
    if (!m) {
      m = new Int32Array(this.s.length + 2).fill(-2);
      this.memo.set(delim, m);
    }
    const path: number[] = [];
    let j = j0;
    let result = -1;
    for (;;) {
      if (j >= this.s.length) break;
      const known = m[j]!;
      if (known !== -2) {
        result = known;
        break;
      }
      path.push(j);
      const k = this.next(delim, j);
      if (k < 0) break;
      const tick = this.tickFrom(j);
      if (tick >= 0 && tick < k) {
        const end = this.spanEnd(tick);
        if (end >= 0) {
          j = end + this.runLen(tick);
          continue;
        }
      }
      if (this.staticClose(k, delim)) {
        result = k;
        break;
      }
      j = k + 1;
    }
    for (const p of path) m[p] = result;
    return result;
  }

  /** Где закрывается выделение delim, начатое до from; -1 — не закрыто. Закрывающий знак не может стоять ровно на from. */
  findClose(from: number, delim: string): number {
    const k = this.next(delim, from);
    if (k === from) return this.closeFrom(from + 1, delim);
    return this.closeFrom(from, delim);
  }

  /** Ссылка `[текст](адрес)` с позиции i (s[i] = «[»): длина целиком, текст и адрес; null — не ссылка. */
  link(i: number): { len: number; text: string; url: string } | null {
    const s = this.s;
    const close = this.next(']', i + 1);
    if (close < 0 || close === i + 1 || close - i - 1 > LINK_TEXT_MAX) return null;
    const nl = this.next('\n', i + 1);
    if (nl >= 0 && nl < close) return null;
    if (s[close + 1] !== '(') return null;
    const end = this.next(')', close + 2);
    if (end < 0 || end === close + 2 || end - close - 2 > LINK_URL_MAX) return null;
    const url = s.slice(close + 2, end);
    if (/\s/.test(url)) return null;
    return { len: end + 1 - i, text: s.slice(i + 1, close), url };
  }
}

function inline(s: string): string {
  const sc = new Scan(s);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1]!)) {
      out += escapeHtml(s[i + 1]!);
      i += 2;
      continue;
    }
    if (c === '`') {
      const n = sc.runLen(i);
      const end = sc.spanEnd(i);
      if (end >= 0) {
        let code = s.slice(i + n, end);
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        if (code.length > 0) {
          out += `<code>${escapeHtml(code)}</code>`;
          i = end + n;
          continue;
        }
      }
      out += escapeHtml('`'.repeat(n));
      i += n;
      continue;
    }
    if (c === '[') {
      const m = sc.link(i);
      if (m && SAFE_URL.test(m.url)) {
        out += `<a href="${escapeAttr(m.url)}">${inline(m.text)}</a>`;
        i += m.len;
        continue;
      }
    }
    if ((c === '*' || c === '_') && s[i + 1] === c) {
      const d = c + c;
      const opens = !isSpace(s[i + 2]) && (c !== '_' || !isWordChar(s[i - 1]));
      if (opens) {
        const end = sc.findClose(i + 2, d);
        if (end > i + 2) {
          out += `<b>${inline(s.slice(i + 2, end))}</b>`;
          i = end + 2;
          continue;
        }
      }
      out += escapeHtml(d);
      i += 2;
      continue;
    }
    if (c === '*' || c === '_') {
      const opens = !isSpace(s[i + 1]) && (c !== '_' || !isWordChar(s[i - 1]));
      if (opens) {
        const end = sc.findClose(i + 1, c);
        if (end > i + 1) {
          out += `<i>${inline(s.slice(i + 1, end))}</i>`;
          i = end + 1;
          continue;
        }
      }
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;

/** Markdown агента → HTML Telegram. */
export function markdownToTelegramHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length) blocks.push(inline(para.join('\n')));
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1]!;
      const lang = fence[2] ?? '';
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j]!;
        if (l.trim().startsWith(marker[0]!.repeat(marker.length)) && l.trim().replace(/[`~]/g, '') === '') break;
        body.push(l);
      }
      const code = escapeHtml(body.join('\n'));
      blocks.push(lang ? `<pre><code class="language-${escapeAttr(lang)}">${code}</code></pre>` : `<pre>${code}</pre>`);
      i = j;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      flushPara();
      const quote: string[] = [];
      let j = i;
      for (; j < lines.length && /^ {0,3}>/.test(lines[j]!); j++) quote.push(lines[j]!.replace(/^ {0,3}> ?/, ''));
      blocks.push(`<blockquote>${inline(quote.join('\n'))}</blockquote>`);
      i = j - 1;
      continue;
    }
    para.push(line);
  }
  flushPara();
  // Между блоками — перевод строки, как в исходном тексте.
  return blocks.join('\n');
}
