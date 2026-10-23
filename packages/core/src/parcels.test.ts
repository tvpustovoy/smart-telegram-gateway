import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DOCUMENT_MAX_TIMEOUTS,
  PARCEL_MAX_BYTES,
  PHOTO_MAX_BYTES,
  documentTimeoutMs,
  hasHiddenSegment,
  hasUnsafeName,
  isPhotoName,
  parcelContentType,
  photoProblem,
  parcelPartsOf,
  parcelVersion,
  pathSegments,
  relativeInside,
} from './parcels.js';

describe('посылки (0.3.3): пути без файловой системы', () => {
  it('предел — 50 МБ (Bot API, общий сервер)', () => {
    assert.equal(PARCEL_MAX_BYTES, 52_428_800);
  });

  it('relativeInside: внутри — путь от корня; сам корень, «..» и соседняя папка с тем же началом — null', () => {
    assert.equal(relativeInside('/a/parcels', '/a/parcels/r/x.html'), 'r/x.html');
    assert.equal(relativeInside('/a/parcels', '/a/parcels'), null);
    assert.equal(relativeInside('/a/parcels', '/a/parcels/../secret'), null);
    assert.equal(relativeInside('/a/parcels', '/a/parcels-old/x'), null);
    assert.equal(relativeInside('/a/parcels', '/etc/passwd'), null);
  });

  it('скрытые сегменты и плохие имена', () => {
    assert.ok(hasHiddenSegment('r/.env'));
    assert.ok(hasHiddenSegment('.git/config'));
    assert.ok(!hasHiddenSegment('r/report.v2.html'));
    assert.ok(!hasHiddenSegment('./r/x'));
    assert.ok(hasUnsafeName('r/a\nb.txt'));
    assert.ok(hasUnsafeName('r/gpj.‮exe'));
    assert.ok(!hasUnsafeName('отчёт/итог 01.05.html'));
    // Невидимые знаки (находка проверки 0.3.3): нулевой ширины, BOM, мягкий перенос, WORD JOINER, монгольский разделитель,
    // знаки направления письма, разделители строк.
    for (const c of ['\u200B', '\u200C', '\u200D', '\uFEFF', '\u00AD', '\u2060', '\u180E', '\u061C', '\u200E', '\u2066', '\u2028', '\u2029']) {
      assert.ok(hasUnsafeName(`r/a${c}b.txt`), `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
    }
    assert.deepEqual(pathSegments('a//b/./c'), ['a', 'b', 'c']);
  });

  it('посылка и файл: первый сегмент — посылка; файл прямо в папке посылок — null', () => {
    assert.deepEqual(parcelPartsOf('отчёт/report.html'), { parcel: 'отчёт', file: 'report.html', name: 'report.html' });
    assert.deepEqual(parcelPartsOf('r/img/a.png'), { parcel: 'r', file: 'img/a.png', name: 'a.png' });
    assert.equal(parcelPartsOf('loose.txt'), null);
  });

  it('предел загрузки документа — минута + время на 1 Мбит/с: 50 МБ — около 8 минут; после трёх таймаутов — не повторять', () => {
    assert.equal(documentTimeoutMs(0), 60_000);
    assert.equal(documentTimeoutMs(125_000), 61_000);
    assert.equal(documentTimeoutMs(PARCEL_MAX_BYTES), 60_000 + 419_431);
    assert.equal(DOCUMENT_MAX_TIMEOUTS, 3);
  });

  it('тип по расширению; версия — 8 знаков SHA-256', () => {
    assert.equal(parcelContentType('report.HTML'), 'text/html');
    assert.equal(parcelContentType('data.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(parcelContentType('noext'), 'application/octet-stream');
    assert.equal(parcelVersion('0123456789abcdef'), '01234567');
  });
});

/** Заголовок PNG — только то, что читает imageInfo (IHDR с размерами). */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** Заголовок JPEG: SOI, APP1 (EXIF) на n байт — размеры в SOF дальше, — SOF0, EOI. */
function jpeg(w: number, h: number, exif = 0): Buffer {
  const app1 = Buffer.alloc(4 + exif);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(2 + exif, 2);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.from([0xff, 0xd9])]);
}

describe('посылки (#60): картинка — фото в пределах фото Telegram', () => {
  it('годится: jpg, jpeg, png, webp до 10 МБ, стороны вместе до 10 000, не вытянутее 1:20 — размеры из заголовка', () => {
    assert.equal(PHOTO_MAX_BYTES, 10 * 1024 * 1024);
    for (const n of ['a.png', 'a.PNG', 'b.jpg', 'c.jpeg', 'd.webp']) assert.ok(isPhotoName(n), n);
    for (const n of ['a.gif', 'a.pdf', 'a.svg', 'a.heic', 'png', 'a.png.txt']) assert.ok(!isPhotoName(n), n);
    assert.equal(photoProblem('a.png', 2048, png(1280, 720)), null);
    assert.equal(photoProblem('a.jpg', 2048, jpeg(4000, 3000, 30_000)), null, 'SOF после большого EXIF');
    assert.equal(photoProblem('a.jpg', PHOTO_MAX_BYTES, jpeg(5000, 5000)), null, 'ровно 10 МБ и 10 000 — годится');
    assert.equal(photoProblem('a.png', 100, png(2000, 100)), null, 'ровно 1:20');
    // Расширение — картинка, содержимое — тоже другой картинкой: Telegram решает по содержимому.
    assert.equal(photoProblem('a.jpg', 100, png(640, 480)), null);
  });

  it('не годится — почему словами: не картинка, больше 10 МБ, стороны вместе больше 10 000, вытянутая, не читается, GIF', () => {
    assert.match(photoProblem('a.pdf', 100, null)!, /только картинка jpg, png или webp/);
    assert.match(photoProblem('a.png', PHOTO_MAX_BYTES + 1, png(100, 100))!, /10,0 МБ — фото в Telegram до 10 МБ/);
    assert.match(photoProblem('a.png', 100, png(6000, 4001))!, /^6000×4001 — у фото в Telegram ширина и высота вместе до 10 000$/);
    assert.match(photoProblem('a.png', 100, png(2001, 100))!, /^2001×100 — фото в Telegram не вытянутее 1:20$/);
    assert.match(photoProblem('a.png', 100, png(100, 2001))!, /не вытянутее 1:20/);
    assert.match(photoProblem('a.png', 100, Buffer.from('<html>не картинка</html>'))!, /размеры картинки не прочитать/);
    assert.match(photoProblem('a.png', 100, null)!, /размеры картинки не прочитать/);
    const gif = Buffer.alloc(13);
    gif.write('GIF89a', 0, 'latin1');
    gif.writeUInt16LE(400, 6);
    gif.writeUInt16LE(300, 8);
    assert.match(photoProblem('a.png', 100, gif)!, /не jpg, png или webp/);
    assert.match(photoProblem('a.png', 100, png(0, 100))!, /0×100/);
    assert.match(photoProblem('a.jpg', 100, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))!, /не прочитать/, 'JPEG без SOF');
  });
});
