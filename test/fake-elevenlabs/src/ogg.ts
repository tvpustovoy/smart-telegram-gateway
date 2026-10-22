// Ogg/Opus-образец заданной длительности для поддельного синтеза (ACCEPTANCE §1): OpusHead, OpusTags и кадры
// тишины по 20 мс; длительность — по granule_position последней страницы (минус pre-skip).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ b) & 0xff] ?? 0)) >>> 0;
  return crc >>> 0;
}

const SERIAL = 0x5354_4721;
export const OPUS_PRE_SKIP = 312;
const FRAME_SAMPLES = 960; // 20 мс при 48 кГц
/** Кадр тишины CELT, 20 мс. */
const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);

function page(packets: Buffer[], granule: bigint, seq: number, flags: number): Buffer {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  if (lacing.length > 255) throw new Error('ogg: слишком много сегментов на странице');
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'ascii');
  header[4] = 0;
  header[5] = flags;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(SERIAL, 14);
  header.writeUInt32LE(seq, 18);
  header.writeUInt32LE(0, 22);
  header[26] = lacing.length;
  lacing.forEach((v, i) => (header[27 + i] = v));
  const buf = Buffer.concat([header, ...packets]);
  buf.writeUInt32LE(oggCrc(buf), 22);
  return buf;
}

/** Ogg/Opus моно 48 кГц длительностью seconds (кратно 20 мс). */
export function makeOggOpus(seconds: number): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(OPUS_PRE_SKIP, 10);
  head.writeUInt32LE(48_000, 12);
  head.writeInt16LE(0, 16);
  head[18] = 0;
  const vendor = Buffer.from('stg-fake-elevenlabs', 'utf8');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'ascii');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);

  const pages: Buffer[] = [page([head], 0n, 0, 0x02), page([tags], 0n, 1, 0)];
  const frames = Math.max(1, Math.round((seconds * 1000) / 20));
  const perPage = 50;
  let seq = 2;
  let done = 0;
  while (done < frames) {
    const n = Math.min(perPage, frames - done);
    done += n;
    const granule = BigInt(OPUS_PRE_SKIP + done * FRAME_SAMPLES);
    pages.push(page(Array.from({ length: n }, () => SILENCE), granule, seq++, done === frames ? 0x04 : 0));
  }
  return Buffer.concat(pages);
}

/** Длительность Ogg/Opus по последней странице, секунды; null — не Ogg/Opus. */
export function oggOpusDuration(buf: Buffer): number | null {
  if (buf.subarray(0, 4).toString('ascii') !== 'OggS') return null;
  let pos = 0;
  let lastGranule: bigint | null = null;
  let preSkip: number | null = null;
  while (pos + 27 <= buf.length && buf.subarray(pos, pos + 4).toString('ascii') === 'OggS') {
    const segs = buf[pos + 26] ?? 0;
    let size = 0;
    for (let i = 0; i < segs; i++) size += buf[pos + 27 + i] ?? 0;
    const dataStart = pos + 27 + segs;
    if (preSkip === null && buf.subarray(dataStart, dataStart + 8).toString('ascii') === 'OpusHead') {
      preSkip = buf.readUInt16LE(dataStart + 10);
    }
    lastGranule = buf.readBigInt64LE(pos + 6);
    pos = dataStart + size;
  }
  if (preSkip === null || lastGranule === null) return null;
  return Number(lastGranule - BigInt(preSkip)) / 48_000;
}
