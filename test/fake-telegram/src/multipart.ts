// Разбор тела запроса: JSON, x-www-form-urlencoded, multipart/form-data (sendVoice). Без зависимостей.

export interface UploadedFile {
  filename: string | null;
  contentType: string | null;
  data: Buffer;
}

export type Params = Record<string, unknown>;

/** Поля, которые в форме приходят строкой JSON. */
const JSON_FIELDS = new Set([
  'allowed_updates',
  'reply_markup',
  'reply_parameters',
  'link_preview_options',
  'reaction',
  'commands',
  'scope',
  'entities',
  'caption_entities',
]);

function decodeField(name: string, value: string): unknown {
  if (JSON_FIELDS.has(name)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function parseUrlEncoded(text: string): Params {
  const out: Params = {};
  for (const [k, v] of new URLSearchParams(text)) out[k] = decodeField(k, v);
  return out;
}

export function parseMultipart(body: Buffer, contentType: string): Params {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) throw new Error('multipart без boundary');
  const delim = Buffer.from(`--${boundary}`);
  const out: Params = {};
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    let start = pos + delim.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    const next = body.indexOf(delim, start);
    if (next < 0) break;
    let part = body.subarray(start, next);
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) part = part.subarray(0, part.length - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const data = part.subarray(headerEnd + 4);
      const name = /name="([^"]*)"/i.exec(headers)?.[1];
      const filename = /filename="([^"]*)"/i.exec(headers)?.[1] ?? null;
      const ctype = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? null;
      if (name !== undefined) {
        out[name] =
          filename !== null || (ctype && !ctype.startsWith('text/plain'))
            ? ({ filename, contentType: ctype, data: Buffer.from(data) } satisfies UploadedFile)
            : decodeField(name, data.toString('utf8'));
      }
    }
    pos = next;
  }
  return out;
}

export function parseBody(body: Buffer, contentType: string | undefined): Params {
  const ct = (contentType ?? '').toLowerCase();
  if (body.length === 0) return {};
  if (ct.startsWith('application/json')) {
    const v: unknown = JSON.parse(body.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Params) : {};
  }
  if (ct.startsWith('application/x-www-form-urlencoded')) return parseUrlEncoded(body.toString('utf8'));
  if (ct.startsWith('multipart/form-data')) return parseMultipart(body, contentType ?? '');
  // Без типа — пробуем JSON, затем форму.
  try {
    const v: unknown = JSON.parse(body.toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Params;
  } catch {
    // не JSON
  }
  return parseUrlEncoded(body.toString('utf8'));
}

export function isUploadedFile(v: unknown): v is UploadedFile {
  return !!v && typeof v === 'object' && Buffer.isBuffer((v as UploadedFile).data);
}
