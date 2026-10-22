// Разбор Ogg/Opus своим кодом (5.8): длительность для sendVoice — по granule_position последней страницы минус pre_skip;
// не Ogg, битая контрольная сумма, обрезанный файл, не Opus — причина словами. Если на машине есть ffmpeg — сверка
// с настоящим кодировщиком (без ffmpeg тест пропускается; шлюзу ffmpeg не нужен).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { inspectOggOpus, oggPageCrc, voiceDurationSeconds } from './ogg.js';

/** Временные каталоги этого файла тестов — удаляются после него. */
const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Страница Ogg с верной контрольной суммой. */
function page(seq: number, granule: bigint, data: Buffer, flags = 0): Buffer {
  const segs: number[] = [];
  let left = data.length;
  while (left >= 255) {
    segs.push(255);
    left -= 255;
  }
  segs.push(left);
  const head = Buffer.alloc(27);
  head.write('OggS', 0, 'latin1');
  head[5] = flags;
  head.writeBigInt64LE(granule, 6);
  head.writeUInt32LE(0x5e7a, 14);
  head.writeUInt32LE(seq, 18);
  head[26] = segs.length;
  const p = Buffer.concat([head, Buffer.from(segs), data]);
  p.writeUInt32LE(oggPageCrc(p), 22);
  return p;
}

function opusHead(preSkip: number, channels = 1): Buffer {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'latin1');
  b[8] = 1;
  b[9] = channels;
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(48_000, 12);
  return b;
}

function sample(seconds: number, preSkip = 312): Buffer {
  const tags = Buffer.concat([Buffer.from('OpusTags', 'latin1'), Buffer.alloc(8)]);
  const audio = Buffer.alloc(600, 7);
  return Buffer.concat([
    page(0, 0n, opusHead(preSkip), 2),
    page(1, 0n, tags),
    page(2, -1n, audio),
    page(3, BigInt(Math.round(seconds * 48_000) + preSkip), audio, 4),
  ]);
}

describe('Ogg/Opus', () => {
  it('длительность — по последней granule_position минус pre_skip; −1 пропускается', () => {
    const r = inspectOggOpus(sample(4.2));
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.info.seconds, 4.2);
    assert.deepEqual({ ch: r.info.channels, pages: r.info.pages, pre: r.info.preSkip }, { ch: 1, pages: 4, pre: 312 });
  });

  it('не Ogg, битая сумма, обрезанный файл, не Opus, без звука — отказ с причиной', () => {
    const ok = sample(2);
    assert.match((inspectOggOpus(Buffer.from('ID3\x04 mp3 here')) as { reason: string }).reason, /^не Ogg \(начало /);
    const bad = Buffer.from(ok);
    bad.writeUInt8(bad.readUInt8(bad.length - 1) ^ 0xff, bad.length - 1);
    assert.match((inspectOggOpus(bad) as { reason: string }).reason, /контрольная сумма страницы 3/);
    assert.match((inspectOggOpus(ok.subarray(0, ok.length - 10)) as { reason: string }).reason, /обрезанная страница/);
    const vorbis = Buffer.concat([page(0, 0n, Buffer.concat([Buffer.from('\x01vorbis', 'latin1'), Buffer.alloc(23)]), 2), ok.subarray(ok.indexOf('OggS', 1, 'latin1'))]);
    assert.match((inspectOggOpus(vorbis) as { reason: string }).reason, /не Opus/);
    assert.match((inspectOggOpus(sample(2).subarray(0, sample(2).indexOf('OggS', 60, 'latin1'))) as { reason: string }).reason, /нет звука|длительности/);
  });

  it('duration для sendVoice — целые секунды, не меньше 1', () => {
    assert.deepEqual([0.2, 1.49, 1.5, 4.2, 59.6].map(voiceDurationSeconds), [1, 1, 2, 4, 60]);
  });

  it('сверка с настоящим кодировщиком (ffmpeg, если есть)', (t) => {
    const probe = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-encoders'], { encoding: 'utf8' });
    if (probe.status !== 0 || !probe.stdout.includes('libopus')) {
      t.skip('ffmpeg с libopus не найден');
      return;
    }
    const file = path.join(tmpDir('stg-ogg-'), 's.ogg');
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.5', '-c:a', 'libopus', '-b:a', '32k', '-y', file]);
    assert.equal(r.status, 0, String(r.stderr));
    const info = inspectOggOpus(fs.readFileSync(file));
    assert.ok(info.ok, JSON.stringify(info));
    assert.ok(Math.abs(info.info.seconds - 2.5) < 0.03, String(info.info.seconds));
  });
});
