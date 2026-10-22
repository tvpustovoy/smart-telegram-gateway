// Длительность аудиофайла по самому файлу (J-2, 5.8; находка проверки 0.2.0): у document нет поля duration, поэтому
// предел 15 минут и срок попытки распознавания — по содержимому. Образцы собраны здесь байт за байтом: MP4/M4A (mvhd v0
// и v1, moov после mdat), WAV (и запись «на лету»), Ogg Opus и Vorbis, FLAC, MP3 (постоянный битрейт, с тегом ID3,
// Xing), AAC ADTS, WebM; чужое и битое — null.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { audioDurationEstimate, audioDurationOf } from './audio-duration.js';
import { oggPageCrc } from './ogg.js';

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function mvhd0(scale: number, duration: number): Buffer {
  const b = Buffer.alloc(100);
  b[0] = 0;
  b.writeUInt32BE(scale, 12);
  b.writeUInt32BE(duration, 16);
  return box('mvhd', b);
}

function mvhd1(scale: number, duration: bigint): Buffer {
  const b = Buffer.alloc(112);
  b[0] = 1;
  b.writeUInt32BE(scale, 20);
  b.writeBigUInt64BE(duration, 24);
  return box('mvhd', b);
}

const ftyp = box('ftyp', Buffer.from('M4A \0\0\0\0isomM4A ', 'latin1'));

function wav(byteRate: number, dataBytes: number, declared?: number): Buffer {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(byteRate, 4);
  fmt.writeUInt32LE(byteRate, 8);
  fmt.writeUInt16LE(1, 12);
  fmt.writeUInt16LE(8, 14);
  const chunk = (id: string, data: Buffer, size = data.length): Buffer => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'latin1');
    h.writeUInt32LE(size, 4);
    return Buffer.concat([h, data]);
  };
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), chunk('fmt ', fmt), chunk('LIST', Buffer.alloc(5)), Buffer.alloc(1), chunk('data', Buffer.alloc(dataBytes), declared)]);
  const h = Buffer.alloc(8);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body]);
}

function oggPage(seq: number, granule: bigint, data: Buffer): Buffer {
  const segs: number[] = [];
  let left = data.length;
  while (left >= 255) {
    segs.push(255);
    left -= 255;
  }
  segs.push(left);
  const head = Buffer.alloc(27);
  head.write('OggS', 0, 'latin1');
  head.writeBigInt64LE(granule, 6);
  head.writeUInt32LE(0x1234, 14);
  head.writeUInt32LE(seq, 18);
  head[26] = segs.length;
  const p = Buffer.concat([head, Buffer.from(segs), data]);
  p.writeUInt32LE(oggPageCrc(p), 22);
  return p;
}

function opusFile(seconds: number, preSkip = 312): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(48_000, 12);
  const audio = Buffer.alloc(300, 3);
  return Buffer.concat([
    oggPage(0, 0n, head),
    oggPage(1, 0n, Buffer.from('OpusTags\0\0\0\0\0\0\0\0', 'latin1')),
    oggPage(2, BigInt(seconds * 24_000 + preSkip), audio),
    oggPage(3, BigInt(seconds * 48_000 + preSkip), audio),
    // Последняя страница без конца пакета (granule −1) — пропускается.
    oggPage(4, -1n, audio),
  ]);
}

function vorbisFile(seconds: number, rate: number): Buffer {
  const id = Buffer.alloc(30);
  id[0] = 1;
  id.write('vorbis', 1, 'latin1');
  id[11] = 2;
  id.writeUInt32LE(rate, 12);
  return Buffer.concat([oggPage(0, 0n, id), oggPage(1, BigInt(seconds * rate), Buffer.alloc(100, 1))]);
}

function flacFile(rate: number, samples: number): Buffer {
  const info = Buffer.alloc(34);
  info[10] = (rate >> 12) & 0xff;
  info[11] = (rate >> 4) & 0xff;
  info[12] = ((rate & 0x0f) << 4) | (1 << 1);
  info[13] = 0x70 | Math.floor(samples / 2 ** 32);
  info.writeUInt32BE(samples % 2 ** 32, 14);
  return Buffer.concat([Buffer.from('fLaC', 'latin1'), Buffer.from([0x80, 0, 0, 34]), info, Buffer.alloc(200)]);
}

/** Кадры MPEG-1 Layer III 128 кбит/с 44,1 кГц стерео: 417 байт. */
function mp3Frames(n: number, first?: (f: Buffer) => void): Buffer {
  const frames: Buffer[] = [];
  for (let k = 0; k < n; k++) {
    const f = Buffer.alloc(417);
    f.set([0xff, 0xfb, 0x90, 0x00]);
    if (k === 0) first?.(f);
    frames.push(f);
  }
  return Buffer.concat(frames);
}

function id3(size: number): Buffer {
  const h = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  // Внутри тега — байты 0xFF: их не принять за кадр.
  return Buffer.concat([h, Buffer.alloc(size, 0xff)]);
}

/** Кадры AAC ADTS 44,1 кГц, по 1024 отсчёта. */
function adts(n: number, len = 200): Buffer {
  const frames: Buffer[] = [];
  for (let k = 0; k < n; k++) {
    const f = Buffer.alloc(len);
    f.set([0xff, 0xf1, 0x50, 0x80 | ((len >> 11) & 3), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc]);
    frames.push(f);
  }
  return Buffer.concat(frames);
}

/** Элемент EBML: размер — 4 байта (маркер 0x10) или «неизвестен» (8 байт, все единицы). */
function ebml(id: number[], body: Buffer, unknownSize = false): Buffer {
  const n = body.length;
  const size = unknownSize
    ? Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    : Buffer.from([0x10 | ((n >>> 24) & 0x0f), (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  return Buffer.concat([Buffer.from(id), size, body]);
}

function webm(durationTicks: number | null, scale = 1_000_000): Buffer {
  const scaleEl = Buffer.from([0x2a, 0xd7, 0xb1, 0x83, (scale >> 16) & 0xff, (scale >> 8) & 0xff, scale & 0xff]);
  const dur = Buffer.alloc(11);
  dur.set([0x44, 0x89, 0x88]);
  dur.writeDoubleBE(durationTicks ?? 0, 3);
  const info = ebml([0x15, 0x49, 0xa9, 0x66], Buffer.concat([scaleEl, ...(durationTicks === null ? [] : [dur])]));
  const head = ebml([0x1a, 0x45, 0xdf, 0xa3], Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]));
  return Buffer.concat([head, ebml([0x18, 0x53, 0x80, 0x67], Buffer.concat([info, ebml([0x1f, 0x43, 0xb6, 0x75], Buffer.alloc(50), true)]), true)]);
}

const near = (actual: number | null, expected: number, eps = 0.01): void => {
  assert.ok(actual !== null && Math.abs(actual - expected) < eps, `${actual} ≠ ${expected}`);
};

describe('длительность аудиофайла по содержимому', () => {
  it('MP4/M4A: mvhd версии 0 и 1; moov после mdat; без moov — null', () => {
    near(audioDurationOf(Buffer.concat([ftyp, box('moov', mvhd0(1000, 754_000), box('trak', Buffer.alloc(20)))])), 754);
    near(audioDurationOf(Buffer.concat([ftyp, box('mdat', Buffer.alloc(5000, 1)), box('moov', box('udta', Buffer.alloc(4)), mvhd1(44_100, BigInt(900 * 44_100)))])), 900);
    assert.equal(audioDurationOf(Buffer.concat([ftyp, box('mdat', Buffer.alloc(100))])), null);
    assert.equal(audioDurationOf(Buffer.concat([ftyp, box('moov', mvhd0(0, 100))])), null, 'timescale 0');
  });

  it('WAV: data ÷ байт в секунду; размер data не проставлен — до конца файла', () => {
    near(audioDurationOf(wav(100, 100_000)), 1000);
    near(audioDurationOf(wav(16_000, 48_000)), 3);
    near(audioDurationOf(wav(1000, 5000, 0xffffffff)), 5);
  });

  it('Ogg: Opus — granule последней страницы минус pre-skip при 48 кГц; Vorbis — по частоте из заголовка', () => {
    near(audioDurationOf(opusFile(7)), 7);
    near(audioDurationOf(vorbisFile(12, 44_100)), 12);
  });

  it('FLAC: STREAMINFO; перед ним бывает тег ID3', () => {
    near(audioDurationOf(flacFile(44_100, 44_100 * 125)), 125);
    near(audioDurationOf(Buffer.concat([id3(30), flacFile(48_000, 48_000 * 61)])), 61);
  });

  it('MP3: постоянный битрейт (с тегом ID3 и без); Xing — по числу кадров', () => {
    const cbr = mp3Frames(200);
    near(audioDurationOf(cbr), (cbr.length * 8) / 128_000);
    near(audioDurationOf(Buffer.concat([id3(64), cbr])), (cbr.length * 8) / 128_000);
    const xing = mp3Frames(10, (f) => {
      f.write('Xing', 36, 'latin1');
      f.writeUInt32BE(1, 40);
      f.writeUInt32BE(1000, 44);
    });
    near(audioDurationOf(xing), (1000 * 1152) / 44_100);
  });

  it('AAC ADTS: число кадров × 1024 ÷ частота', () => {
    near(audioDurationOf(adts(431)), (431 * 1024) / 44_100);
  });

  it('WebM: Duration × TimecodeScale; без Duration (запись браузера) — null', () => {
    near(audioDurationOf(webm(5000)), 5);
    near(audioDurationOf(webm(2500, 2_000_000)), 5);
    assert.equal(audioDurationOf(webm(null)), null);
  });

  it('чужое и битое — null; оценка по размеру — как 32 кбит/с', () => {
    assert.equal(audioDurationOf(Buffer.from('ftypM4A fake m4a audio '.repeat(50))), null);
    assert.equal(audioDurationOf(Buffer.from('OggS fake opus '.repeat(40))), null);
    assert.equal(audioDurationOf(Buffer.from('ID3 fake mp3 '.repeat(40))), null);
    assert.equal(audioDurationOf(Buffer.alloc(3)), null);
    assert.equal(audioDurationOf(opusFile(7).subarray(0, 40)), null);
    assert.equal(audioDurationOf(Buffer.concat([ftyp, Buffer.from([0, 0, 0, 3])])), null);
    assert.equal(audioDurationEstimate(4_000_000), 1000);
  });
});
