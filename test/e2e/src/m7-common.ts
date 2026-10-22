// Общее для интеграционных тестов 0.3 (картинки, кружки, своя надиктовка файлом): картинки, которые шлюз узнаёт по
// первым байтам (PNG, JPEG), и запрос media у поддельного переходника.

import type { FakeChannel } from 'stg-fake-channel';
import type { MediaResult } from 'stg-core';

/** JPEG: SOI, SOF0 с размерами, EOI; size — добить до этого размера (байты после EOI картинку не портят). */
export function jpegBytes(width: number, height: number, size = 0, fill = 0): Buffer {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  const head = Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
  return size > head.length ? Buffer.concat([head, Buffer.alloc(size - head.length, fill)]) : head;
}

/** PNG: подпись и IHDR с размерами; size — добить до этого размера. */
export function pngBytes(width: number, height: number, size = 0, fill = 0): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 6;
  return size > b.length ? Buffer.concat([b, Buffer.alloc(size - b.length, fill)]) : b;
}

export const MB = 1024 * 1024;

/** media(seq) у шлюза: ответ — MediaResult (ack) или ошибка (код и текст). */
export async function mediaOf(ch: FakeChannel, seq: number): Promise<{ ok: true; r: MediaResult } | { ok: false; code: string; text: string }> {
  const m = await ch.media(seq);
  if (m.type === 'ack') return { ok: true, r: m.result as MediaResult };
  if (m.type === 'error') return { ok: false, code: m.code, text: m.text };
  throw new Error(`media: неожиданный ответ ${m.type}`);
}

/** Картинка из ответа — байтами. */
export function imageBytes(r: MediaResult): Buffer {
  if (!r.image) throw new Error(`media: картинки нет (${r.note ?? ''})`);
  return Buffer.from(r.image.data, 'base64');
}
