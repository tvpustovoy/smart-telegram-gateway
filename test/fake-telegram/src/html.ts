// Проверка разметки parse_mode=HTML так, как её проверяет Telegram: допустимые теги, парность, сущности.
// Длина текста — в единицах UTF-16 после разбора сущностей.

const ALLOWED = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'span',
  'tg-spoiler',
  'a',
  'tg-emoji',
  'code',
  'pre',
  'blockquote',
]);

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"' };

export interface HtmlCheck {
  /** null — разметка в порядке; иначе — описание как у Telegram после «can't parse entities: ». */
  error: string | null;
  /** Видимый текст (без тегов, сущности раскрыты). */
  plain: string;
}

export function checkTelegramHtml(html: string): HtmlCheck {
  const stack: string[] = [];
  let plain = '';
  let i = 0;
  const byteOffset = (idx: number): number => Buffer.byteLength(html.slice(0, idx), 'utf8');
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') {
      const close = html.indexOf('>', i);
      if (close < 0) return { error: `Unclosed start tag at byte offset ${byteOffset(i)}`, plain };
      const inner = html.slice(i + 1, close);
      if (inner.startsWith('/')) {
        const name = inner.slice(1).trim().toLowerCase();
        const top = stack.pop();
        if (top === undefined) return { error: `Unexpected end tag at byte offset ${byteOffset(i)}`, plain };
        if (top !== name) {
          return { error: `Unmatched end tag at byte offset ${byteOffset(i)}, expected "</${top}>", found "</${name}>"`, plain };
        }
      } else {
        const name = (/^([a-zA-Z][a-zA-Z0-9-]*)/.exec(inner)?.[1] ?? '').toLowerCase();
        if (!ALLOWED.has(name)) return { error: `Unsupported start tag "${name}" at byte offset ${byteOffset(i)}`, plain };
        if (name === 'span' && !/class\s*=\s*"tg-spoiler"/.test(inner)) {
          return { error: `Tag "span" must have class "tg-spoiler" at byte offset ${byteOffset(i)}`, plain };
        }
        stack.push(name);
      }
      i = close + 1;
      continue;
    }
    if (ch === '>') return { error: `Unexpected end of tag at byte offset ${byteOffset(i)}`, plain };
    if (ch === '&') {
      const semi = html.indexOf(';', i);
      const name = semi > i ? html.slice(i + 1, semi) : '';
      if (/^#\d+$/.test(name)) {
        plain += String.fromCodePoint(Number(name.slice(1)));
        i = semi + 1;
        continue;
      }
      if (/^#x[0-9a-fA-F]+$/.test(name)) {
        plain += String.fromCodePoint(parseInt(name.slice(2), 16));
        i = semi + 1;
        continue;
      }
      const named = NAMED_ENTITIES[name];
      if (named !== undefined) {
        plain += named;
        i = semi + 1;
        continue;
      }
      if (/^[a-zA-Z]+$/.test(name)) return { error: `Unsupported HTML entity "&${name};" at byte offset ${byteOffset(i)}`, plain };
      plain += '&';
      i++;
      continue;
    }
    plain += ch;
    i++;
  }
  if (stack.length) return { error: `Can't find end tag corresponding to start tag "${stack[stack.length - 1]}"`, plain };
  return { error: null, plain };
}
