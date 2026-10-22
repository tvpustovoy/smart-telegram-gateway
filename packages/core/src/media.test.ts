// Картинки для агента (0.3, P-6, P-14): что показать по вложениям события, какой размер фото, формат и размеры по
// первым байтам.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '@grammyjs/types';
import { MEDIA_VIEW_MAX_BYTES, formatBytes, imageExt, imageInfo, pickPhotoSize, viewableOf, type FileRef } from './media.js';
import { labelMessage } from './trust.js';

const owner = { id: 111, is_bot: false, first_name: 'Анна' };
const base = { message_id: 1, date: 1, chat: { id: 111, type: 'private', first_name: 'Анна' }, from: owner };

function label(extra: Record<string, unknown>) {
  return labelMessage({ ...base, ...extra } as unknown as Message, { ownerId: 111, fromOwner: true });
}

const size = (fileId: string, width: number, height: number, fileSize: number | null): FileRef => ({ fileId, width, height, size: fileSize });

/** Минимальные заголовки картинок: только то, что читает imageInfo. */
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = 6;
  return b;
}

function jpegHeader(w: number, h: number): Buffer {
  // SOI, APP0 (JFIF, длина 16), DQT-заглушка (длина 4), SOF0 с размерами, EOI.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const dqt = Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dqt, sof, Buffer.from([0xff, 0xd9])]);
}

describe('картинки для агента: что показать (media.ts)', () => {
  it('предел просмотра — 3,75 МБ: в base64 ровно 5 МБ (предел API модели на картинку) ⟨предл.⟩', () => {
    assert.equal(MEDIA_VIEW_MAX_BYTES, 3_932_160);
    assert.equal(Buffer.alloc(MEDIA_VIEW_MAX_BYTES).toString('base64').length, 5 * 1024 * 1024);
  });

  it('размер фото — длинная сторона ближе к 1600 px, не больше предела; все больше — самый лёгкий', () => {
    const tg = [size('s', 90, 67, 1500), size('m', 320, 240, 12_000), size('x', 800, 600, 60_000), size('y', 1280, 960, 150_000), size('w', 2560, 1920, 600_000)];
    assert.equal(pickPhotoSize(tg)?.fileId, 'y', 'из размеров Telegram — 1280: ближе к 1600, чем 2560');
    assert.equal(pickPhotoSize([size('a', 1200, 900, 100), size('b', 2000, 1500, 100)])?.fileId, 'a', 'равно далеко — меньший');
    assert.equal(pickPhotoSize([size('x', 800, 600, 60_000), size('y', 1600, 1200, MEDIA_VIEW_MAX_BYTES + 1)])?.fileId, 'x', 'больше предела — не берётся');
    assert.equal(pickPhotoSize([size('y', 1600, 1200, 9_000_000), size('z', 3000, 2000, 7_000_000)])?.fileId, 'z', 'все больше предела — самый лёгкий');
    assert.equal(pickPhotoSize([size('n', 1600, 1200, null)])?.fileId, 'n', 'размер неизвестен — не мешает');
    assert.equal(pickPhotoSize([]), null);
  });

  it('фото, изображение файлом, кружок, видео — что показать; pdf, текст, голосовое, аудиофайл — нечего', () => {
    const photo = label({
      photo: [
        { file_id: 'p90', file_unique_id: 'u1', width: 90, height: 67, file_size: 1500 },
        { file_id: 'p1280', file_unique_id: 'u2', width: 1280, height: 960, file_size: 150_000 },
        { file_id: 'p2560', file_unique_id: 'u3', width: 2560, height: 1920, file_size: 600_000 },
      ],
      caption: 'чек',
    });
    // Метки не меняются: фото — чужое, подпись — его слово.
    assert.deepEqual({ trust: photo.trust, mixed: photo.mixed, att: photo.attachments[0]?.trust }, { trust: 'owner', mixed: true, att: 'untrusted' });
    assert.deepEqual(viewableOf(photo.attachments), { what: 'photo', pick: size('p1280', 1280, 960, 150_000) });
    // Событие до 0.3: только самый большой размер — он и показывается.
    assert.deepEqual(viewableOf([{ kind: 'photo', trust: 'untrusted', ref: { file_id: 'old', file_unique_id: 'u', width: 720, height: 1280 } }]), {
      what: 'photo',
      pick: size('old', 720, 1280, null),
    });
    const thumb = { file_id: 'th', file_unique_id: 'uth', width: 320, height: 200, file_size: 8000 };
    const png = label({ document: { file_id: 'd1', file_unique_id: 'u', file_name: 'Снимок экрана.png', mime_type: 'image/png', file_size: 2_400_000, thumbnail: thumb } });
    assert.deepEqual(viewableOf(png.attachments), {
      what: 'image',
      file: { ...size('d1', 0, 0, 2_400_000), width: null, height: null, mime: 'image/png', name: 'Снимок экрана.png' },
      thumb: size('th', 320, 200, 8000),
    });
    for (const mime of ['image/jpeg', 'image/webp', 'image/gif']) {
      assert.equal(viewableOf(label({ document: { file_id: 'd', file_unique_id: 'u', mime_type: mime } }).attachments)?.what, 'image', mime);
    }
    const vn = label({ video_note: { file_id: 'vn', file_unique_id: 'u', length: 384, duration: 12, thumbnail: thumb } });
    assert.deepEqual(viewableOf(vn.attachments), { what: 'video_note', thumb: size('th', 320, 200, 8000) });
    assert.deepEqual(viewableOf(label({ video_note: { file_id: 'vn', file_unique_id: 'u', length: 384, duration: 12 } }).attachments), { what: 'video_note', thumb: null });
    assert.equal(viewableOf(label({ video: { file_id: 'v', file_unique_id: 'u', width: 1, height: 1, duration: 3, thumbnail: thumb } }).attachments)?.what, 'video');
    assert.equal(viewableOf(label({ document: { file_id: 'p', file_unique_id: 'u', file_name: 'a.pdf', mime_type: 'application/pdf' } }).attachments), null);
    assert.equal(viewableOf(label({ document: { file_id: 'h', file_unique_id: 'u', file_name: 'IMG.HEIC', mime_type: 'image/heic' } }).attachments), null, 'HEIC модель не читает');
    assert.equal(viewableOf(label({ text: 'x' }).attachments), null);
    assert.equal(viewableOf(label({ voice: { file_id: 'v', file_unique_id: 'u', duration: 3 } }).attachments), null);
    assert.equal(viewableOf(label({ audio: { file_id: 'a', file_unique_id: 'u', duration: 3 } }).attachments), null);
    // Содержимое снято по сроку хранения — ссылки нет: показать нечего.
    assert.equal(viewableOf([{ kind: 'photo', trust: 'untrusted', ref: {} }]), null);
  });

  it('формат и размеры по первым байтам: PNG, JPEG, GIF, WebP (VP8, VP8L, VP8X); прочее — null', () => {
    assert.deepEqual(imageInfo(pngHeader(2880, 1800)), { format: 'png', mime: 'image/png', width: 2880, height: 1800 });
    assert.deepEqual(imageInfo(jpegHeader(1280, 960)), { format: 'jpeg', mime: 'image/jpeg', width: 1280, height: 960 });
    const gif = Buffer.alloc(13);
    gif.write('GIF89a', 0, 'latin1');
    gif.writeUInt16LE(400, 6);
    gif.writeUInt16LE(300, 8);
    assert.deepEqual(imageInfo(gif), { format: 'gif', mime: 'image/gif', width: 400, height: 300 });
    const riff = (chunk: string, body: Buffer): Buffer => {
      const head = Buffer.alloc(20);
      head.write('RIFF', 0, 'latin1');
      head.writeUInt32LE(12 + body.length, 4);
      head.write('WEBP', 8, 'latin1');
      head.write(chunk, 12, 'latin1');
      head.writeUInt32LE(body.length, 16);
      return Buffer.concat([head, body]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x.writeUIntLE(1919, 4, 3);
    vp8x.writeUIntLE(1079, 7, 3);
    assert.deepEqual(imageInfo(riff('VP8X', vp8x)), { format: 'webp', mime: 'image/webp', width: 1920, height: 1080 });
    const vp8l = Buffer.alloc(10);
    vp8l[0] = 0x2f;
    vp8l.writeUInt32LE((640 - 1) | ((480 - 1) << 14), 1);
    assert.deepEqual(imageInfo(riff('VP8L', vp8l)), { format: 'webp', mime: 'image/webp', width: 640, height: 480 });
    const vp8 = Buffer.alloc(10);
    vp8[3] = 0x9d;
    vp8[4] = 0x01;
    vp8[5] = 0x2a;
    vp8.writeUInt16LE(800, 6);
    vp8.writeUInt16LE(600, 8);
    assert.deepEqual(imageInfo(riff('VP8 ', vp8)), { format: 'webp', mime: 'image/webp', width: 800, height: 600 });
    assert.equal(imageInfo(Buffer.from('%PDF-1.7 not an image')), null);
    assert.equal(imageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null, 'JPEG без SOF');
    assert.equal(imageInfo(Buffer.alloc(0)), null);
    assert.equal(imageExt({ format: 'jpeg' }), 'jpg');
    assert.equal(imageExt({ format: 'png' }), 'png');
    assert.equal(formatBytes(7_549_747), '7,2 МБ');
    assert.equal(formatBytes(860_000), '840 КБ');
  });
});
