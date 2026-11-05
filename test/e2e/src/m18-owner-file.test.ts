// M18 · документы файлом (5.15): агент получает документ из сообщения владельца — file(seq) — на поддельных Telegram и
// переходнике:
// - A18.1 PDF с подписью: в событии — поле file (имя, mime, размер); file кладёт его в incoming.dir под именем
//   <дата>_<№>_<имя>, байт в байт; повтор — «уже лежал», без getFile;
// - A18.2 отказы: текст — «нет файла»; неизвестный № — unknown_seq; больше 20 МБ по метаданным — без скачивания;
// - A18.3 имя из чужих рук: путь в имени отрезается — файл остаётся в папке входящих;
// - A18.4 incoming.dir нет — папка <каталог сессии агента>/incoming, шлюз создаёт её сам.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FileResult, GatewayMessage, Update } from 'stg-core';
import { FakeChannel } from 'stg-fake-channel';
import { connectAdapter, makeTempDir, q1, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, setup, waitRecorded, type Setup } from './m1-common.js';

const MB = 1024 * 1024;

function fileOf(m: GatewayMessage): FileResult {
  if (m.type !== 'ack') throw new Error(`file: ждал ack, пришло ${JSON.stringify(m)}`);
  return m.result as FileResult;
}

describe('M18 · документы файлом: file(seq) (5.15)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  const incoming = path.join(makeTempDir('stg-in-'), 'in');
  const seqOf = (u: Update): Promise<number> =>
    waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, `приёма ${u.update_id}`);
  const getFileCalls = (fileId: string): number => s.fake.callsOf('getFile').filter((c) => c.params.file_id === fileId).length;

  before(async () => {
    s = await setup({ home: { extraConfig: `incoming: { dir: "${incoming}" }\n` } });
    gw = await s.start();
    ({ ch } = await connectAdapter(s.home));
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s?.close();
  });

  it('A18.1 PDF с подписью: поле file в событии; файл в incoming.dir байт в байт; повтор — «уже лежал», без getFile', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(40_000, 7)]);
    s.fake.addFile(pdf, { fileId: 'pdf1', path: 'documents/file_148.pdf' });
    const u = s.fake.push(s.fake.builder.document(OWNER, { fileId: 'pdf1', fileName: 'The Model.pdf', mimeType: 'application/pdf', fileSize: pdf.length }, 'В коллекцию наших флоу'))[0]!;
    const seq = await seqOf(u);
    await waitRecorded(s, gw, u);
    const ev = await ch.waitEvent(seq);
    assert.deepEqual(ev.file, { name: 'The Model.pdf', mime: 'application/pdf', bytes: pdf.length });
    assert.equal(ev.media, undefined, 'PDF не картинка');

    const r = fileOf(await ch.request('file', { seq }, 30_000));
    assert.equal(path.dirname(r.path), incoming);
    assert.match(path.basename(r.path), new RegExp(`^\\d{4}-\\d{2}-\\d{2}_${seq}_The Model\\.pdf$`));
    assert.deepEqual({ name: r.name, mime: r.mime, bytes: r.bytes, reused: r.reused }, { name: 'The Model.pdf', mime: 'application/pdf', bytes: pdf.length, reused: false });
    assert.deepEqual(fs.readFileSync(r.path), pdf);
    assert.equal(getFileCalls('pdf1'), 1);

    const again = fileOf(await ch.request('file', { seq }, 30_000));
    assert.deepEqual({ path: again.path, reused: again.reused }, { path: r.path, reused: true });
    assert.equal(getFileCalls('pdf1'), 1, 'повтор — из папки входящих, Telegram не спрашивается');
  });

  it('A18.2 отказы: текст — «нет файла»; неизвестный № — unknown_seq; больше 20 МБ — без скачивания', async () => {
    const t = s.fake.push(s.fake.builder.text(OWNER, 'просто текст'))[0]!;
    const tseq = await seqOf(t);
    await waitRecorded(s, gw, t);
    await ch.waitEvent(tseq);
    const none = await ch.request('file', { seq: tseq });
    assert.equal(none.type, 'error');
    assert.match(none.type === 'error' ? none.text : '', /нет файла/);

    const unknown = await ch.request('file', { seq: 99_999 });
    assert.deepEqual(unknown.type === 'error' ? unknown.code : unknown.type, 'unknown_seq');

    const u = s.fake.push(s.fake.builder.document(OWNER, { fileId: 'huge', fileName: 'архив.zip', mimeType: 'application/zip', fileSize: 25 * MB }, null))[0]!;
    const seq = await seqOf(u);
    await waitRecorded(s, gw, u);
    await ch.waitEvent(seq);
    const big = await ch.request('file', { seq });
    assert.equal(big.type, 'error');
    assert.match(big.type === 'error' ? big.text : '', /больше 20,0 МБ бот Telegram не скачивает/);
    assert.equal(getFileCalls('huge'), 0);
  });

  it('A18.3 имя из чужих рук: путь в имени отрезается — файл остаётся в папке входящих', async () => {
    s.fake.addFile(Buffer.from('#!/bin/sh\necho hi\n'), { fileId: 'evil', path: 'documents/evil.sh' });
    const u = s.fake.push(s.fake.builder.document(OWNER, { fileId: 'evil', fileName: '../../.ssh/evil.sh', mimeType: 'text/x-sh', fileSize: 18 }, null))[0]!;
    const seq = await seqOf(u);
    await waitRecorded(s, gw, u);
    await ch.waitEvent(seq);
    const r = fileOf(await ch.request('file', { seq }, 30_000));
    assert.equal(path.dirname(r.path), incoming);
    assert.match(path.basename(r.path), new RegExp(`_${seq}_evil\\.sh$`));
  });
});

describe('M18 · документы файлом: папка по умолчанию (A18.4)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel | null = null;
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s?.close();
  });

  it('incoming.dir нет — <каталог сессии агента>/incoming; шлюз создаёт папку сам', async () => {
    s = await setup();
    gw = await s.start();
    const cwd = makeTempDir('stg-agent-');
    ch = await FakeChannel.connect(s.home.paths.socket);
    const w = await ch.hello({ cwd });
    assert.equal(w.type, 'welcome');
    await ch.waitVerified();
    const data = Buffer.from('a,b\n1,2\n');
    s.fake.addFile(data, { fileId: 'csv', path: 'documents/t.csv' });
    const u = s.fake.push(s.fake.builder.document(OWNER, { fileId: 'csv', fileName: 'table.csv', mimeType: 'text/csv', fileSize: data.length }, 'таблица'))[0]!;
    const seq = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
    await waitRecorded(s, gw, u);
    await ch.waitEvent(seq);
    const r = fileOf(await ch.request('file', { seq }, 30_000));
    assert.equal(path.dirname(r.path), path.join(cwd, 'incoming'));
    assert.deepEqual(fs.readFileSync(r.path), data);
  });
});
