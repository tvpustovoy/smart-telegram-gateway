// Ogg/Opus своим кодом (TECH-SPEC 5.8): голос наружу — sendVoice принимает только Ogg/Opus, а длительность шлюз
// считает сам и передаёт в `duration` (Ш-8: настоящее голосовое с верной длительностью). Здесь — разбор контейнера:
// страницы Ogg (захват «OggS», версия 0, контрольная сумма), заголовок OpusHead, длительность по granule_position
// последней страницы минус pre-skip, при 48 кГц (RFC 7845). Ничего не перекодируем: ffmpeg шлюзу не нужен.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

/** Контрольная сумма страницы Ogg (поле суммы — нулями). */
export function oggPageCrc(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ b) & 0xff] ?? 0)) >>> 0;
  return crc >>> 0;
}

export interface OggOpusInfo {
  /** Длительность, секунды (дробная). */
  seconds: number;
  /** Каналов по OpusHead. */
  channels: number;
  pages: number;
  preSkip: number;
}

export type OggOpusCheck = { ok: true; info: OggOpusInfo } | { ok: false; reason: string };

/** Первые байты — для журнала: что пришло вместо Ogg. */
export function magicOf(buf: Uint8Array, n = 8): string {
  return Buffer.from(buf.subarray(0, n)).toString('hex');
}

/**
 * Разобрать Ogg/Opus: каждая страница цела (захват, версия, длина, контрольная сумма), первая несёт OpusHead,
 * длительность — по последней granule_position. Не Ogg/Opus или битый — причина словами.
 */
export function inspectOggOpus(input: Uint8Array): OggOpusCheck {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 27 || buf.toString('latin1', 0, 4) !== 'OggS') return { ok: false, reason: `не Ogg (начало ${magicOf(buf)})` };
  let pos = 0;
  let pages = 0;
  let preSkip: number | null = null;
  let channels = 0;
  let lastGranule: bigint | null = null;
  let serial: number | null = null;
  while (pos < buf.length) {
    if (pos + 27 > buf.length) return { ok: false, reason: `обрезанная страница на байте ${pos}` };
    if (buf.toString('latin1', pos, pos + 4) !== 'OggS') return { ok: false, reason: `нет захвата OggS на байте ${pos}` };
    if (buf[pos + 4] !== 0) return { ok: false, reason: `версия Ogg ${buf[pos + 4]} на байте ${pos}` };
    const segs = buf[pos + 26] ?? 0;
    if (pos + 27 + segs > buf.length) return { ok: false, reason: `обрезанная таблица сегментов на байте ${pos}` };
    let size = 0;
    for (let i = 0; i < segs; i++) size += buf[pos + 27 + i] ?? 0;
    const end = pos + 27 + segs + size;
    if (end > buf.length) return { ok: false, reason: `обрезанная страница на байте ${pos}` };
    const page = Buffer.from(buf.subarray(pos, end));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    if (oggPageCrc(page) !== crc) return { ok: false, reason: `контрольная сумма страницы ${pages} не сходится` };
    const pageSerial = buf.readUInt32LE(pos + 14);
    serial ??= pageSerial;
    if (pageSerial !== serial) return { ok: false, reason: 'несколько потоков в одном файле' };
    const dataStart = pos + 27 + segs;
    if (pages === 0) {
      if (buf.toString('latin1', dataStart, dataStart + 8) !== 'OpusHead' || size < 19) return { ok: false, reason: 'первая страница — не OpusHead: это не Opus' };
      channels = buf[dataStart + 9] ?? 0;
      preSkip = buf.readUInt16LE(dataStart + 10);
    }
    const granule = buf.readBigInt64LE(pos + 6);
    // -1 — «на странице не кончается ни один пакет»: длительность по ней не считается.
    if (granule >= 0n) lastGranule = granule;
    pages++;
    pos = end;
  }
  if (preSkip === null || lastGranule === null) return { ok: false, reason: 'нет OpusHead или длительности' };
  const samples = Number(lastGranule) - preSkip;
  if (samples <= 0 || pages < 3) return { ok: false, reason: 'в файле нет звука' };
  return { ok: true, info: { seconds: samples / 48_000, channels, pages, preSkip } };
}

/** Длительность для sendVoice — целые секунды, не меньше 1. */
export function voiceDurationSeconds(seconds: number): number {
  return Math.max(1, Math.round(seconds));
}
