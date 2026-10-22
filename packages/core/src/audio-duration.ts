// Длительность аудиофайла по самому файлу, своим кодом (J-2; TECH-SPEC 5.8; находка проверки 0.2.0: у Telegram document
// нет поля duration — аудиофайл, присланный файлом, приходил без длительности, и предел 15 минут на него не действовал).
// Контейнер узнаётся по первым байтам, а не по расширению (расширение бывает чужим): MP4/M4A — атом mvhd; WAV —
// байт в секунду из fmt и размер data; Ogg (Opus, Vorbis) — granule последней страницы; FLAC — STREAMINFO; MP3 —
// заголовок Xing/Info/VBRI (число кадров) или постоянный битрейт первого кадра; AAC ADTS — счёт кадров; WebM/Matroska —
// Duration в Segment/Info. Не вышло (другой формат, битый файл, WebM без Duration) — null: тогда шлюз оценивает
// длительность по размеру только для срока попытки распознавания, а не для предела (voice.ts).

/** Правдоподобная длительность: больше нуля и не больше суток. */
function plausible(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 24 * 3600 ? seconds : null;
}

function buf(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Длина тега ID3v2 в начале (0 — нет). */
function id3v2Length(b: Buffer, at = 0): number {
  if (b.length < at + 10 || b.toString('latin1', at, at + 3) !== 'ID3') return 0;
  const size = ((b[at + 6]! & 0x7f) << 21) | ((b[at + 7]! & 0x7f) << 14) | ((b[at + 8]! & 0x7f) << 7) | (b[at + 9]! & 0x7f);
  const footer = (b[at + 5]! & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

// ——— MP4 / M4A ———

/** Атомы на отрезке [from, to): тип и границы содержимого. */
function* mp4Boxes(b: Buffer, from: number, to: number): Generator<{ type: string; start: number; end: number }> {
  let pos = from;
  while (pos + 8 <= to) {
    let size = b.readUInt32BE(pos);
    const type = b.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > to) return;
      size = Number(b.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = to - pos;
    }
    if (size < header) return;
    yield { type, start: pos + header, end: Math.min(pos + size, to) };
    pos += size;
  }
}

function mp4Duration(b: Buffer): number | null {
  for (const box of mp4Boxes(b, 0, b.length)) {
    if (box.type !== 'moov') continue;
    for (const inner of mp4Boxes(b, box.start, box.end)) {
      if (inner.type !== 'mvhd') continue;
      const p = inner.start;
      const version = b[p];
      if (version === 1) {
        if (p + 32 > inner.end) return null;
        const scale = b.readUInt32BE(p + 20);
        const dur = Number(b.readBigUInt64BE(p + 24));
        return scale ? plausible(dur / scale) : null;
      }
      if (p + 20 > inner.end) return null;
      const scale = b.readUInt32BE(p + 12);
      const dur = b.readUInt32BE(p + 16);
      return scale && dur !== 0xffffffff ? plausible(dur / scale) : null;
    }
    return null;
  }
  return null;
}

// ——— WAV ———

function wavDuration(b: Buffer): number | null {
  let pos = 12;
  let byteRate = 0;
  while (pos + 8 <= b.length) {
    const id = b.toString('latin1', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (id === 'fmt ' && start + 12 <= b.length) byteRate = b.readUInt32LE(start + 8);
    if (id === 'data') {
      if (!byteRate) return null;
      // Запись «на лету»: размер data не проставлен (0 или 0xFFFFFFFF) или больше файла — до конца файла.
      const left = b.length - start;
      const data = size === 0 || size === 0xffffffff || size > left ? left : size;
      return plausible(data / byteRate);
    }
    pos = start + size + (size % 2);
  }
  return null;
}

// ——— Ogg (Opus, Vorbis) ———

function oggDuration(b: Buffer): number | null {
  if (b.length < 28) return null;
  const segs = b[26]!;
  const dataStart = 27 + segs;
  if (dataStart + 19 > b.length) return null;
  let rate: number;
  let preSkip = 0;
  if (b.toString('latin1', dataStart, dataStart + 8) === 'OpusHead') {
    rate = 48_000;
    preSkip = b.readUInt16LE(dataStart + 10);
  } else if (b[dataStart] === 1 && b.toString('latin1', dataStart + 1, dataStart + 7) === 'vorbis') {
    rate = b.readUInt32LE(dataStart + 12);
  } else {
    return null;
  }
  if (!rate) return null;
  // Последняя страница с granule ≥ 0 — ищем захват «OggS» с конца (страница не длиннее 65 307 байт).
  const floor = Math.max(0, b.length - 4 * 65_307);
  for (let pos = b.length - 27; pos >= floor; pos--) {
    if (b[pos] !== 0x4f || b.toString('latin1', pos, pos + 4) !== 'OggS' || b[pos + 4] !== 0) continue;
    const granule = b.readBigInt64LE(pos + 6);
    if (granule < 0n) continue;
    return plausible((Number(granule) - preSkip) / rate);
  }
  return null;
}

// ——— FLAC ———

function flacDuration(b: Buffer, at: number): number | null {
  // fLaC, затем первый блок метаданных — STREAMINFO (34 байта).
  const p = at + 8;
  if (p + 18 > b.length || (b[at + 4]! & 0x7f) !== 0) return null;
  const rate = (b[p + 10]! << 12) | (b[p + 11]! << 4) | (b[p + 12]! >> 4);
  const total = (b[p + 13]! & 0x0f) * 2 ** 32 + b.readUInt32BE(p + 14);
  return rate && total ? plausible(total / rate) : null;
}

// ——— MP3 ———

const MP3_BITRATES: Record<string, readonly number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES: Record<number, readonly number[]> = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] };

interface Mp3Frame {
  /** 3 — MPEG-1, 2 — MPEG-2, 0 — MPEG-2.5. */
  version: number;
  /** 1, 2, 3 — Layer I, II, III. */
  layer: number;
  bitrate: number;
  rate: number;
  length: number;
  samples: number;
  mono: boolean;
}

function mp3Frame(b: Buffer, i: number): Mp3Frame | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1]! >> 3) & 3;
  const layerBits = (b[i + 1]! >> 1) & 3;
  const brIndex = b[i + 2]! >> 4;
  const rateIndex = (b[i + 2]! >> 2) & 3;
  if (version === 1 || layerBits === 0 || brIndex === 0 || brIndex === 15 || rateIndex === 3) return null;
  const layer = 4 - layerBits;
  const bitrate = MP3_BITRATES[`${version === 3 ? 1 : 2}-${layer}`]![brIndex]! * 1000;
  const rate = MP3_RATES[version]![rateIndex]!;
  const pad = (b[i + 2]! >> 1) & 1;
  const length =
    layer === 1 ? Math.floor((12 * bitrate) / rate + pad) * 4 : Math.floor(((layer === 3 && version !== 3 ? 72 : 144) * bitrate) / rate) + pad;
  const samples = layer === 1 ? 384 : layer === 2 ? 1152 : version === 3 ? 1152 : 576;
  return { version, layer, bitrate, rate, length, samples, mono: b[i + 3]! >> 6 === 3 };
}

function mp3Duration(b: Buffer, from: number): number | null {
  // Первый кадр, за которым сразу идёт ещё один (так случайные 0xFF в теге не принимаются за кадр).
  const limit = Math.min(b.length, from + 256 * 1024);
  for (let i = from; i < limit; i++) {
    const f = mp3Frame(b, i);
    if (!f || f.length < 24) continue;
    const next = i + f.length;
    if (next + 4 <= b.length && !mp3Frame(b, next)) continue;
    // Xing / Info (VBR и CBR от LAME): число кадров.
    const side = f.version === 3 ? (f.mono ? 17 : 32) : f.mono ? 9 : 17;
    const x = i + 4 + side;
    const tag = x + 8 <= b.length ? b.toString('latin1', x, x + 4) : '';
    if ((tag === 'Xing' || tag === 'Info') && (b.readUInt32BE(x + 4) & 1) && x + 12 <= b.length) {
      return plausible((b.readUInt32BE(x + 8) * f.samples) / f.rate);
    }
    // VBRI (Fraunhofer): всегда через 32 байта после заголовка.
    const v = i + 36;
    if (v + 18 <= b.length && b.toString('latin1', v, v + 4) === 'VBRI') return plausible((b.readUInt32BE(v + 14) * f.samples) / f.rate);
    // Постоянный битрейт: байты звука (без тега ID3v1 в конце) ÷ битрейт.
    const tail = b.length >= 128 && b.toString('latin1', b.length - 128, b.length - 125) === 'TAG' ? 128 : 0;
    return plausible(((b.length - tail - i) * 8) / f.bitrate);
  }
  return null;
}

// ——— AAC ADTS ———

const ADTS_RATES = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350];

function adtsDuration(b: Buffer, from: number): number | null {
  let i = from;
  let samples = 0;
  let rate = 0;
  let frames = 0;
  while (i + 7 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1]! & 0xf6) !== 0xf0) break;
    const r = ADTS_RATES[(b[i + 2]! >> 2) & 0x0f];
    const len = ((b[i + 3]! & 3) << 11) | (b[i + 4]! << 3) | (b[i + 5]! >> 5);
    if (!r || len < 7) break;
    rate ||= r;
    samples += ((b[i + 6]! & 3) + 1) * 1024;
    frames++;
    i += len;
  }
  return frames >= 2 && rate ? plausible(samples / rate) : null;
}

// ——— WebM / Matroska ———

/** Число переменной длины EBML: значение (для id — с маркером длины) и сколько байт. */
function vint(b: Buffer, i: number, keepMarker: boolean): { value: number; len: number } | null {
  const first = b[i];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || i + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let unknown = value === (0xff >> len);
  for (let k = 1; k < len; k++) {
    value = value * 256 + b[i + k]!;
    if (b[i + k] !== 0xff) unknown = false;
  }
  return { value: !keepMarker && unknown ? -1 : value, len };
}

function mkvDuration(b: Buffer): number | null {
  const SEGMENT = 0x18538067;
  const INFO = 0x1549a966;
  const SCALE = 0x2ad7b1;
  const DURATION = 0x4489;
  /** Дочерние элементы на отрезке: id, начало и конец содержимого (размер «неизвестен» — до конца отрезка). */
  const children = function* (from: number, to: number): Generator<{ id: number; start: number; end: number }> {
    let pos = from;
    while (pos < to) {
      const id = vint(b, pos, true);
      if (!id) return;
      const size = vint(b, pos + id.len, false);
      if (!size) return;
      const start = pos + id.len + size.len;
      const end = size.value < 0 ? to : Math.min(start + size.value, to);
      yield { id: id.value, start, end };
      if (size.value < 0) return;
      pos = end;
    }
  };
  for (const top of children(0, b.length)) {
    if (top.id !== SEGMENT) continue;
    for (const el of children(top.start, top.end)) {
      if (el.id !== INFO) continue;
      let scale = 1_000_000;
      let duration: number | null = null;
      for (const f of children(el.start, el.end)) {
        const n = f.end - f.start;
        if (f.id === SCALE && n >= 1 && n <= 6) scale = b.readUIntBE(f.start, n);
        if (f.id === DURATION) duration = n === 4 ? b.readFloatBE(f.start) : n === 8 ? b.readDoubleBE(f.start) : null;
      }
      return duration === null ? null : plausible((duration * scale) / 1e9);
    }
    return null;
  }
  return null;
}

/**
 * Длительность аудиофайла, секунды (дробная); null — не определить. Формат — по содержимому: MP4/M4A, WAV, Ogg (Opus,
 * Vorbis), FLAC, MP3, AAC ADTS, WebM/Matroska.
 */
export function audioDurationOf(data: Uint8Array): number | null {
  const b = buf(data);
  if (b.length < 12) return null;
  try {
    if (b.toString('latin1', 4, 8) === 'ftyp') return mp4Duration(b);
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return wavDuration(b);
    if (b.toString('latin1', 0, 4) === 'OggS') return oggDuration(b);
    if (b.readUInt32BE(0) === 0x1a45dfa3) return mkvDuration(b);
    const skip = id3v2Length(b);
    if (b.length >= skip + 8 && b.toString('latin1', skip, skip + 4) === 'fLaC') return flacDuration(b, skip);
    // Кадр AAC ADTS: синхрослово 0xFFF и слой 00; иначе — MP3 (слой I–III).
    if (b[skip] === 0xff && b[skip + 1] !== undefined && (b[skip + 1]! & 0xf6) === 0xf0) return adtsDuration(b, skip);
    return mp3Duration(b, skip);
  } catch {
    // Битый файл (чтение за концом буфера) — не определить.
    return null;
  }
}

/**
 * Оценка длительности по размеру — только для срока попытки распознавания, когда по файлу не вышло: как если бы звук
 * шёл 32 кбит/с (речь в mp3, opus, aac — обычно не меньше), то есть оценка скорее длиннее настоящей ⟨предл.⟩.
 */
export const AUDIO_ESTIMATE_BYTES_PER_SECOND = 4000;
export function audioDurationEstimate(bytes: number): number {
  return Math.max(0, bytes) / AUDIO_ESTIMATE_BYTES_PER_SECOND;
}
