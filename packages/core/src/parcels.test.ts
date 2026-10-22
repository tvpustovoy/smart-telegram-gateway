import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DOCUMENT_MAX_TIMEOUTS,
  PARCEL_MAX_BYTES,
  documentTimeoutMs,
  hasHiddenSegment,
  hasUnsafeName,
  parcelContentType,
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
