// 0.3 · картинки для агента — media(seq) (P-6, P-14: агент видит картинки и скриншоты, кружки распознаются) на поддельных
// Telegram и переходнике:
// - A7.1 фото: размер ближе к 1600 px (из 90/320/800/1280/2560 — 1280), картинка — base64 этого файла; повтор — из raw/
//   без getFile; в событии — подсказка media; метки — как были (фото — чужое, подпись — его слово); реакции — как у
//   текста, 👀 → 👌 (0.3.2: ✍ нет), ответа шлюза нет;
// - A7.2 изображение файлом: png до 3,75 МБ ⟨предл.: 5 МБ в base64⟩ — сам файл, mime и размеры — по первым байтам;
//   больше предела по метаданным — «слишком большое для просмотра: N МБ» и уменьшенная копия Telegram (сам файл не
//   скачивается); размера в метаданных нет, а файл больше предела — то же после скачивания; копии нет — только текст;
// - A7.3 кадр кружка — обложка Telegram; кружка без обложки — «кадра нет»;
// - A7.4 доступ: проверенной аренде — и после переподключения (фото, на которое агент уже ответил, ⟨предл.⟩ R-21);
//   ещё не отданное (стоп) — «агенту ещё не отдавался»; текст — «нет картинки»; неизвестный № — unknown_seq;
// - A7.5 скачать не вышло — unavailable «повтори позже»; следующий запрос — картинка;
// - A7.6 хранение: картинка у сообщения владельца — по сроку чужого (90 дней): файл удалён, media_ref снят, media —
//   «содержимое удалено по сроку хранения»;
// - A7.14–A7.19 (по проверке) — повтор из raw/, когда файла нет или он битый; копия Telegram при «file is too big» и
//   у файла, который не открылся как картинка, — с той же пометкой при повторе; срок скачивания 60 с по часам шлюза;
//   два запроса одного № — одно скачивание; диск полон при сохранении; остановка шлюза посреди скачивания.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Update } from 'stg-core';
import type { FakeChannel } from 'stg-fake-channel';
import { STOPPED_TEXT } from 'stg-core';
import { reply } from 'stg-fake-telegram';
import { connectAdapter, pump, q1, readJournal, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, reactionsOf, setup, waitRecorded, type Setup } from './m1-common.js';
import { press, waitSent } from './m2-common.js';
import { MB, imageBytes, jpegBytes, mediaOf, pngBytes } from './m7-common.js';

describe('M7 · картинки для агента: media(seq) (0.3)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  const seqOf = (u: Update): Promise<number> =>
    waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, `приёма ${u.update_id}`);
  const getFileCalls = (fileId: string): number => s.fake.callsOf('getFile').filter((c) => c.params.file_id === fileId).length;
  /** Закрыть переходник и дождаться, пока шлюз снимет аренду (иначе следующий hello — «занято»). */
  const reconnectGap = async (close: () => void): Promise<void> => {
    const released = (): number => readJournal(s.home).filter((l) => l.ev === 'lease_released').length;
    const n = released();
    close();
    await waitUntil(() => released() > n || null, 10_000, 'снятия аренды');
  };
  const mediaRef = (seq: number): string | null => q1<{ media_ref: string | null }>(s.home, 'SELECT media_ref FROM events WHERE seq = ?', seq)?.media_ref ?? null;

  before(async () => {
    s = await setup();
    gw = await s.start();
    ({ ch } = await connectAdapter(s.home));
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s?.close();
  });

  it('A7.1 фото: размер ближе к 1600 px (1280 из 90…2560); картинка — base64 файла; повтор — из raw/ без getFile; подсказка в событии; метки — как были', async () => {
    const sizes = [
      { fileId: 'ph90', width: 90, height: 68 },
      { fileId: 'ph320', width: 320, height: 240 },
      { fileId: 'ph800', width: 800, height: 600 },
      { fileId: 'ph1280', width: 1280, height: 960 },
      { fileId: 'ph2560', width: 2560, height: 1920 },
    ].map((x) => {
      const data = jpegBytes(x.width, x.height, 2000 + x.width, x.width & 0xff);
      s.fake.addFile(data, { fileId: x.fileId, path: `photos/${x.fileId}.jpg` });
      return { ...x, fileSize: data.length, data };
    });
    const u = s.fake.push(s.fake.builder.photo(OWNER, 'чек из магазина', { sizes }))[0]!;
    const seq = await seqOf(u);
    // Записано; агент ещё не отметил delivered — на фото ничего (0.3.2: ✍ нет).
    await waitRecorded(s, gw, u);
    const n = await ch.waitEvent(seq);
    assert.deepEqual(
      { kind: n.kind, trust: n.trust, mixed: n.mixed, attachments: n.attachments, media: n.media, text: n.text },
      { kind: 'photo', trust: 'owner', mixed: true, attachments: [{ kind: 'photo', trust: 'untrusted' }], media: { what: 'photo' }, text: 'чек из магазина' },
    );
    assert.ok(!JSON.stringify(n).includes('ph1280'), 'file_id переходнику не уходит');
    assert.equal(getFileCalls('ph1280'), 0, 'при приёме фото не скачивается');
    const m = await mediaOf(ch, seq);
    assert.ok(m.ok, JSON.stringify(m));
    const want = sizes.find((x) => x.fileId === 'ph1280')!;
    assert.deepEqual(
      { what: m.r.what, mime: m.r.image?.mime, width: m.r.image?.width, height: m.r.image?.height, bytes: m.r.image?.bytes, shown: m.r.image?.shown, note: m.r.note },
      { what: 'photo', mime: 'image/jpeg', width: 1280, height: 960, bytes: want.data.length, shown: 'original', note: null },
    );
    assert.deepEqual(imageBytes(m.r), want.data);
    for (const x of sizes) assert.equal(getFileCalls(x.fileId), x.fileId === 'ph1280' ? 1 : 0, x.fileId);
    // Файл — в raw/<дата>/<update_id>.media.jpg; путь — в событии.
    const ref = mediaRef(seq);
    assert.match(ref ?? '', new RegExp(`^raw/\\d{4}-\\d{2}-\\d{2}/${u.update_id}\\.media\\.jpg$`));
    assert.deepEqual(fs.readFileSync(path.join(s.home.dir, ref!)), want.data);
    // Повтор — из raw/, без Telegram.
    const again = await mediaOf(ch, seq);
    assert.ok(again.ok);
    assert.deepEqual(imageBytes(again.r), want.data);
    assert.equal(getFileCalls('ph1280'), 1, 'повтор — из raw/');
    const j = readJournal(s.home).filter((l) => l.ev === 'media' && l.seq === seq);
    assert.deepEqual(j.map((l) => l.from), ['telegram', 'raw']);
    // Реакции — как у текста (0.3.2): 👀 — агент увидел, 👌 — done; ответа шлюза на фото нет.
    await ch.delivered(seq);
    await pump(gw, () => reactionsOf(s.fake, u).at(-1) === '👀' || null, { what: '👀 на фото' });
    await ch.done([seq]);
    await pump(gw, () => reactionsOf(s.fake, u).at(-1) === '👌' || null, { what: '👌 на фото' });
    assert.deepEqual(reactionsOf(s.fake, u), ['👀', '👌']);
    assert.ok(!s.fake.sentTo(OWNER.id).some((x) => (x.reply_parameters as { message_id?: number } | null)?.message_id === u.message!.message_id), 'ответа шлюза на фото нет');
  });

  it('A7.2 изображение файлом: png до 3,75 МБ — сам файл (mime по байтам); больше — «слишком большое для просмотра» и копия Telegram; копии нет — только текст', async () => {
    // Скриншот файлом 2880×1800, 2,4 МБ; Telegram назвал mime image/jpeg — шлюз верит первым байтам (png).
    const png = pngBytes(2880, 1800, Math.round(2.4 * MB), 7);
    s.fake.addFile(png, { fileId: 'shot', path: 'documents/shot.png' });
    const u1 = s.fake.push(s.fake.builder.document(OWNER, { fileId: 'shot', fileName: 'Снимок экрана.png', mimeType: 'image/jpeg', fileSize: png.length }, null))[0]!;
    const seq1 = await seqOf(u1);
    await waitRecorded(s, gw, u1);
    const n1 = await ch.waitEvent(seq1);
    assert.deepEqual({ kind: n1.kind, media: n1.media, attachments: n1.attachments, mixed: n1.mixed }, { kind: 'document', media: { what: 'image' }, attachments: [{ kind: 'document', trust: 'untrusted' }], mixed: true });
    const m1 = await mediaOf(ch, seq1);
    assert.ok(m1.ok);
    assert.deepEqual({ what: m1.r.what, mime: m1.r.image?.mime, w: m1.r.image?.width, h: m1.r.image?.height, shown: m1.r.image?.shown }, { what: 'image', mime: 'image/png', w: 2880, h: 1800, shown: 'original' });
    assert.deepEqual(imageBytes(m1.r), png);
    assert.match(mediaRef(seq1) ?? '', /\.media\.png$/);

    // Больше предела по метаданным: сам файл не скачивается, показана уменьшенная копия Telegram.
    const thumb = jpegBytes(320, 200, 6000, 3);
    s.fake.addFile(thumb, { fileId: 'bigthumb', path: 'thumbnails/big.jpg' });
    const u2 = s.fake.push(
      s.fake.builder.document(OWNER, { fileId: 'bigphoto', fileName: 'IMG_0001.jpg', mimeType: 'image/jpeg', fileSize: Math.round(7.2 * MB), thumbnail: { fileId: 'bigthumb', width: 320, height: 200, fileSize: thumb.length } }, 'вот')
    )[0]!;
    const seq2 = await seqOf(u2);
    await ch.waitEvent(seq2);
    const m2 = await mediaOf(ch, seq2);
    assert.ok(m2.ok);
    assert.equal(m2.r.image?.shown, 'telegram_thumbnail');
    assert.deepEqual(imageBytes(m2.r), thumb);
    assert.match(m2.r.note ?? '', /^слишком большое для просмотра: 7,2 МБ — показываю уменьшенную копию Telegram/);
    assert.equal(getFileCalls('bigphoto'), 0, 'файл больше предела не скачивался');
    assert.match(mediaRef(seq2) ?? '', /\.thumb\.jpg$/);
    // Повтор из raw/ — та же пометка с размером (вид копии — в имени файла).
    const m2again = await mediaOf(ch, seq2);
    assert.ok(m2again.ok);
    assert.equal(m2again.r.note, m2.r.note);

    // 4,5 МБ по метаданным — тоже больше предела (3,75 МБ: в base64 — 5 МБ, предел API модели ⟨предл.⟩); копии нет.
    const u4 = s.fake.push(s.fake.builder.document(OWNER, { fileId: 'mid', fileName: 'shot.png', mimeType: 'image/png', fileSize: Math.round(4.5 * MB) }, null))[0]!;
    const seq4 = await seqOf(u4);
    await ch.waitEvent(seq4);
    const m4 = await mediaOf(ch, seq4);
    assert.ok(m4.ok);
    assert.deepEqual({ image: m4.r.image, note: m4.r.note }, { image: null, note: 'слишком большое для просмотра: 4,5 МБ' });
    assert.equal(getFileCalls('mid'), 0);

    // Размера в метаданных нет, а файл больше предела: скачан, не показан; копии нет — только текст.
    const big = jpegBytes(4000, 3000, Math.round(5.5 * MB), 9);
    s.fake.addFile(big, { fileId: 'nosize', path: 'documents/nosize.jpg' });
    const u3 = s.fake.push(s.fake.builder.document(OWNER, { fileId: 'nosize', fileName: 'scan.jpg', mimeType: 'image/jpeg', fileSize: null }, null))[0]!;
    const seq3 = await seqOf(u3);
    await ch.waitEvent(seq3);
    const m3 = await mediaOf(ch, seq3);
    assert.ok(m3.ok);
    assert.deepEqual({ image: m3.r.image, note: m3.r.note }, { image: null, note: 'слишком большое для просмотра: 5,5 МБ' });
    assert.equal(mediaRef(seq3), null);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'media_too_big' && l.seq === seq3 && l.thumbnail === false));
    await ch.done([seq1, seq2, seq3, seq4]);
  });

  it('A7.3 кадр кружка — обложка Telegram; кружок без обложки — «кадра нет»', async () => {
    const frame = jpegBytes(320, 320, 9000, 5);
    s.fake.addFile(frame, { fileId: 'vnthumb', path: 'thumbnails/vn.jpg' });
    const u = s.fake.push(s.fake.builder.videoNote(OWNER, { fileId: 'vnote1', duration: 12, thumbnail: { fileId: 'vnthumb', width: 320, height: 320, fileSize: frame.length } }))[0]!;
    const seq = await seqOf(u);
    const n = await ch.waitEvent(seq, 15_000);
    assert.deepEqual(n.media, { what: 'video_note', frame: true });
    const m = await mediaOf(ch, seq);
    assert.ok(m.ok);
    assert.deepEqual({ what: m.r.what, shown: m.r.image?.shown, w: m.r.image?.width }, { what: 'video_note', shown: 'frame', w: 320 });
    assert.deepEqual(imageBytes(m.r), frame);
    assert.match(m.r.note ?? '', /кадр-обложка Telegram: один кадр кружка/);
    assert.match(mediaRef(seq) ?? '', /\.frame\.jpg$/);
    assert.equal(getFileCalls('vnote1') <= 1, true, 'кружок — звук, его качает распознаватель, не media');

    const u2 = s.fake.push(s.fake.builder.videoNote(OWNER, { fileId: 'vnote2', duration: 5 }))[0]!;
    const seq2 = await seqOf(u2);
    const n2 = await ch.waitEvent(seq2, 15_000);
    assert.deepEqual(n2.media, { what: 'video_note', frame: false });
    const m2 = await mediaOf(ch, seq2);
    assert.ok(m2.ok);
    assert.deepEqual({ image: m2.r.image, note: m2.r.note }, { image: null, note: 'кадра нет: Telegram не прислал обложку' });
    await ch.done([seq, seq2]);
  });

  it('A7.5 скачать не вышло — unavailable «повтори позже»; следующий запрос — картинка', async () => {
    const data = jpegBytes(1280, 720, 30_000, 1);
    s.fake.addFile(data, { fileId: 'flaky', path: 'photos/flaky.jpg' });
    s.fake.scenario({ method: 'getFile', times: 1, when: (p) => p.file_id === 'flaky', reply: reply.error(500, 'Internal Server Error') });
    const u = s.fake.push(s.fake.builder.photo(OWNER, null, { sizes: [{ fileId: 'flaky', width: 1280, height: 720, fileSize: data.length }] }))[0]!;
    const seq = await seqOf(u);
    await ch.waitEvent(seq);
    const m1 = await mediaOf(ch, seq);
    assert.ok(!m1.ok);
    assert.equal(m1.code, 'unavailable');
    assert.match(m1.text, /картинка не скачалась .* — повтори позже/);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'media_failed' && l.seq === seq));
    const m2 = await mediaOf(ch, seq);
    assert.ok(m2.ok);
    assert.deepEqual(imageBytes(m2.r), data);
    await ch.done([seq]);
  });

  it('A7.4 доступ: проверенной аренде — и после переподключения (R-21 ⟨предл.⟩); ещё не отданное (стоп) — нет; текст — «нет картинки»; неизвестный № — unknown_seq; до проверки аренды — unverified', async () => {
    const data = jpegBytes(800, 600, 5000, 2);
    s.fake.addFile(data, { fileId: 'old', path: 'photos/old.jpg' });
    const u = s.fake.push(s.fake.builder.photo(OWNER, 'старое', { sizes: [{ fileId: 'old', width: 800, height: 600, fileSize: data.length }] }))[0]!;
    const seq = await seqOf(u);
    await ch.waitEvent(seq);
    const first = await mediaOf(ch, seq);
    assert.ok(first.ok && first.r.image, JSON.stringify(first));
    const t = s.fake.push(s.fake.builder.text(OWNER, 'просто текст'))[0]!;
    const tseq = await seqOf(t);
    await ch.waitEvent(tseq);
    const noPic = await mediaOf(ch, tseq);
    assert.deepEqual(noPic.ok ? null : { code: noPic.code, text: noPic.text }, { code: 'bad_request', text: `в № ${tseq} нет картинки: смотреть можно фото, изображение файлом, кадр кружка или видео` });
    const unknown = await mediaOf(ch, 999_999);
    assert.deepEqual(unknown.ok ? null : unknown.code, 'unknown_seq');
    await ch.done([seq, tseq]);
    // Сессия сменилась (сон ноутбука, перезапуск): аренда новая, а фото, на которое агент уже ответил, открывается —
    // из raw/, без Telegram (по проверке на реальном боте: вопрос о том же скриншоте через час).
    await reconnectGap(() => ch.close());
    const next = await connectAdapter(s.home);
    ch = next.ch;
    const again = await mediaOf(ch, seq);
    assert.ok(again.ok, JSON.stringify(again));
    assert.deepEqual(imageBytes(again.r), data);
    assert.equal(getFileCalls('old'), 1, 'повтор в новой сессии — из raw/');

    // Ещё не отданное агенту (владелец сказал «стоп» — событие ждёт в очереди) — нет: агент не заглядывает в очередь.
    const modes = ch.modes().length;
    s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
    await waitUntil(() => ch.modes().slice(modes).find((m) => m.state === 'stopped'), 5000, 'кадра mode stopped');
    const held = jpegBytes(640, 480, 4000, 8);
    s.fake.addFile(held, { fileId: 'held', path: 'photos/held.jpg' });
    const u2 = s.fake.push(s.fake.builder.photo(OWNER, 'после стопа', { sizes: [{ fileId: 'held', width: 640, height: 480, fileSize: held.length }] }))[0]!;
    const seq2 = await seqOf(u2);
    const refused = await mediaOf(ch, seq2);
    assert.deepEqual(refused.ok ? null : { code: refused.code, text: refused.text }, { code: 'not_your_lease', text: `№ ${seq2} агенту ещё не отдавался` });
    assert.ok(readJournal(s.home).some((l) => l.ev === 'media_refused' && l.seq === seq2 && l.reason === 'not_delivered'));
    assert.equal(getFileCalls('held'), 0);
    // [продолжить] — событие отдано, картинка открывается.
    const stopLine = await waitSent(s, gw, (m) => m.text === STOPPED_TEXT, 'строки «Остановлен»');
    assert.equal(await press(s, stopLine, 'продолжить'), null);
    await ch.waitEvent(seq2);
    const shown = await mediaOf(ch, seq2);
    assert.ok(shown.ok);
    assert.deepEqual(imageBytes(shown.r), held);
    await ch.done([seq2]);

    // До проверки аренды — unverified (проба без ответа).
    await reconnectGap(() => ch.close());
    const raw = await connectAdapter(s.home, { autoProbeDone: false });
    const early = await mediaOf(raw.ch, seq);
    assert.deepEqual(early.ok ? null : early.code, 'unverified');
    await reconnectGap(() => raw.ch.close());
    ch = (await connectAdapter(s.home)).ch;
  });
});

describe('M7 · картинки: хранение (A7.6)', () => {
  let s: Setup;
  after(() => s?.close());

  it('картинка у сообщения владельца — по сроку чужого (90 дней): файл удалён, media_ref снят; media — «содержимое удалено по сроку хранения»', async () => {
    s = await setup();
    const gw = await s.start();
    try {
      const { ch } = await connectAdapter(s.home);
      const data = jpegBytes(1280, 960, 40_000, 4);
      s.fake.addFile(data, { fileId: 'keep', path: 'photos/keep.jpg' });
      const u = s.fake.push(s.fake.builder.photo(OWNER, 'моя подпись остаётся', { sizes: [{ fileId: 'keep', width: 1280, height: 960, fileSize: data.length }] }))[0]!;
      const seq = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
      await ch.waitEvent(seq);
      const m = await mediaOf(ch, seq);
      assert.ok(m.ok && m.r.image);
      const ref = q1<{ media_ref: string }>(s.home, 'SELECT media_ref FROM events WHERE seq = ?', seq)!.media_ref;
      assert.ok(fs.existsSync(path.join(s.home.dir, ref)));
      // 31 день — ещё на месте (картинка — не звук владельца).
      await gw.jump('31d');
      await waitUntil(() => readJournal(s.home).some((l) => l.ev === 'retention') || null, 10_000, 'первой чистки');
      assert.ok(fs.existsSync(path.join(s.home.dir, ref)), 'через 31 день картинка ещё хранится');
      await gw.jump('60d');
      await waitUntil(() => q1<{ media_ref: string | null }>(s.home, 'SELECT media_ref FROM events WHERE seq = ?', seq)?.media_ref === null || null, 10_000, 'чистки картинки');
      assert.ok(!fs.existsSync(path.join(s.home.dir, ref)), 'файл удалён');
      assert.equal(q1<{ text: string }>(s.home, 'SELECT text FROM events WHERE seq = ?', seq)?.text, 'моя подпись остаётся');
      const gone = await mediaOf(ch, seq);
      assert.ok(gone.ok);
      assert.deepEqual({ image: gone.r.image, note: gone.r.note }, { image: null, note: 'содержимое удалено по сроку хранения' });
      ch.close();
    } finally {
      await gw.stop();
    }
  });
});

describe('M7 · картинки: сбои и края (A7.14–A7.19, по проверке)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  const seqOf = (u: Update): Promise<number> =>
    waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, `приёма ${u.update_id}`);
  const getFileCalls = (fileId: string): number => s.fake.callsOf('getFile').filter((c) => c.params.file_id === fileId).length;
  const mediaRef = (seq: number): string | null => q1<{ media_ref: string | null }>(s.home, 'SELECT media_ref FROM events WHERE seq = ?', seq)?.media_ref ?? null;
  /** Фото владельца одним размером; вернуть № после отдачи агенту. */
  const photo = async (fileId: string, data: Buffer): Promise<number> => {
    s.fake.addFile(data, { fileId, path: `photos/${fileId}.jpg` });
    const u = s.fake.push(s.fake.builder.photo(OWNER, null, { sizes: [{ fileId, width: 1280, height: 960, fileSize: data.length }] }))[0]!;
    const seq = await seqOf(u);
    await ch.waitEvent(seq);
    return seq;
  };

  before(async () => {
    s = await setup();
    gw = await s.start();
    ({ ch } = await connectAdapter(s.home));
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s?.close();
  });

  it('A7.14 повтор из raw/: файла нет — скачивается заново (media_cache_missing); файл битый — тоже (media_cache_bad)', async () => {
    const data = jpegBytes(1280, 960, 12_000, 11);
    const seq = await photo('cache1', data);
    const m1 = await mediaOf(ch, seq);
    assert.ok(m1.ok);
    const ref = mediaRef(seq)!;
    // Файл пропал — getFile снова, картинка та же, файл на месте.
    fs.rmSync(path.join(s.home.dir, ref));
    const m2 = await mediaOf(ch, seq);
    assert.ok(m2.ok);
    assert.deepEqual(imageBytes(m2.r), data);
    assert.equal(getFileCalls('cache1'), 2);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'media_cache_missing' && l.seq === seq));
    assert.deepEqual(fs.readFileSync(path.join(s.home.dir, mediaRef(seq)!)), data);
    // Файл подменён мусором — по первым байтам не картинка: скачан заново.
    fs.writeFileSync(path.join(s.home.dir, mediaRef(seq)!), Buffer.from('это не картинка'));
    const m3 = await mediaOf(ch, seq);
    assert.ok(m3.ok);
    assert.deepEqual(imageBytes(m3.r), data);
    assert.equal(getFileCalls('cache1'), 3);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'media_cache_bad' && l.seq === seq));
    // Следующий — снова из raw/.
    assert.ok((await mediaOf(ch, seq)).ok);
    assert.equal(getFileCalls('cache1'), 3);
    await ch.done([seq]);
  });

  it('A7.15 копия Telegram: «file is too big» у файла без размера — «больше 20 МБ»; файл не открылся как картинка — «формат не распознан»; повтор из raw/ — та же пометка', async () => {
    // getFile отвечает «file is too big» (размера в метаданных нет): сам файл не скачать, показана копия Telegram.
    const thumb = jpegBytes(320, 240, 5000, 12);
    s.fake.addFile(thumb, { fileId: 'hugethumb', path: 'thumbnails/huge.jpg' });
    s.fake.scenario({ method: 'getFile', when: (p) => p.file_id === 'huge', reply: reply.error(400, 'Bad Request: file is too big') });
    const u1 = s.fake.push(
      s.fake.builder.document(OWNER, { fileId: 'huge', fileName: 'скан.jpg', mimeType: 'image/jpeg', fileSize: null, thumbnail: { fileId: 'hugethumb', width: 320, height: 240, fileSize: thumb.length } }, null),
    )[0]!;
    const seq1 = await seqOf(u1);
    await ch.waitEvent(seq1);
    const m1 = await mediaOf(ch, seq1);
    assert.ok(m1.ok);
    assert.deepEqual({ shown: m1.r.image?.shown, note: m1.r.note }, {
      shown: 'telegram_thumbnail',
      note: 'слишком большое для просмотра: больше 20 МБ — показываю уменьшенную копию Telegram: мелкое не разглядеть; можно попросить прислать фото, а не файлом',
    });
    assert.deepEqual(imageBytes(m1.r), thumb);
    assert.match(mediaRef(seq1) ?? '', /\.thumb-huge\.jpg$/);
    const again1 = await mediaOf(ch, seq1);
    assert.ok(again1.ok);
    assert.equal(again1.r.note, m1.r.note, 'повтор из raw/ — та же пометка');
    assert.equal(getFileCalls('huge'), 1);
    assert.equal(getFileCalls('hugethumb'), 1);

    // mime у Telegram — jpeg, а по байтам не картинка (HEIC): копия Telegram с пометкой «формат не распознан».
    const thumb2 = jpegBytes(320, 240, 5000, 13);
    s.fake.addFile(Buffer.from('....ftypheic fake heic photo'), { fileId: 'heic', path: 'documents/heic.jpg' });
    s.fake.addFile(thumb2, { fileId: 'heicthumb', path: 'thumbnails/heic.jpg' });
    const u2 = s.fake.push(
      s.fake.builder.document(OWNER, { fileId: 'heic', fileName: 'IMG_0007.jpg', mimeType: 'image/jpeg', fileSize: 28, thumbnail: { fileId: 'heicthumb', width: 320, height: 240, fileSize: thumb2.length } }, null),
    )[0]!;
    const seq2 = await seqOf(u2);
    await ch.waitEvent(seq2);
    const m2 = await mediaOf(ch, seq2);
    assert.ok(m2.ok);
    assert.deepEqual({ shown: m2.r.image?.shown, note: m2.r.note }, { shown: 'telegram_thumbnail', note: 'файл не открылся как картинка (формат не распознан) — показываю уменьшенную копию Telegram' });
    assert.match(mediaRef(seq2) ?? '', /\.thumb-format\.jpg$/);
    const again2 = await mediaOf(ch, seq2);
    assert.ok(again2.ok);
    assert.equal(again2.r.note, m2.r.note, 'повтор из raw/ — «формат не распознан», а не «слишком большое»');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'media_not_image' && l.seq === seq2));
    await ch.done([seq1, seq2]);
  });

  it('A7.16 срок скачивания — 60 с по часам шлюза: Telegram молчит — unavailable «не уложилось в 60 с»; следующий запрос — картинка', async () => {
    const data = jpegBytes(1280, 960, 9000, 14);
    s.fake.scenario({ method: 'getFile', times: 1, when: (p) => p.file_id === 'slow', reply: reply.hang() });
    const seq = await photo('slow', data);
    const pending = mediaOf(ch, seq);
    await waitUntil(() => getFileCalls('slow') === 1 || null, 5000, 'getFile');
    await gw.advance('61s');
    const m1 = await pending;
    assert.deepEqual(m1.ok ? null : { code: m1.code, text: m1.text }, { code: 'unavailable', text: 'картинка не скачалась (не уложилось в 60 с) — повтори позже' });
    assert.ok(readJournal(s.home).some((l) => l.ev === 'media_failed' && l.seq === seq && l.error === 'не уложилось в 60 с'));
    const m2 = await mediaOf(ch, seq);
    assert.ok(m2.ok);
    assert.deepEqual(imageBytes(m2.r), data);
    await ch.done([seq]);
  });

  it('A7.17 два запроса одного № сразу — одно скачивание, оба получают картинку', async () => {
    const data = jpegBytes(1280, 960, 15_000, 15);
    s.fake.scenario({ method: 'getFile', times: 1, when: (p) => p.file_id === 'twice', reply: reply.delay(400) });
    const seq = await photo('twice', data);
    const [a, b] = await Promise.all([mediaOf(ch, seq), mediaOf(ch, seq)]);
    assert.ok(a.ok && b.ok);
    assert.deepEqual(imageBytes(a.r), data);
    assert.deepEqual(imageBytes(b.r), data);
    assert.equal(getFileCalls('twice'), 1);
    assert.equal(readJournal(s.home).filter((l) => l.ev === 'media' && l.seq === seq).length, 1, 'одна строка журнала — одно скачивание');
    await ch.done([seq]);
  });

  it('A7.18 диск полон при сохранении — картинка всё равно уходит агенту, в журнале disk_full (where: media); место есть — сохраняется', async () => {
    const data = jpegBytes(1280, 960, 11_000, 16);
    const seq = await photo('full', data);
    const flag = path.join(s.home.dir, 'test-disk-full');
    fs.writeFileSync(flag, 'files');
    try {
      const m1 = await mediaOf(ch, seq);
      assert.ok(m1.ok);
      assert.deepEqual(imageBytes(m1.r), data);
      assert.equal(mediaRef(seq), null, 'путь не записан');
      assert.ok(readJournal(s.home).some((l) => l.ev === 'disk_full' && l.where === 'media' && l.seq === seq));
      assert.ok(readJournal(s.home).some((l) => l.ev === 'media' && l.seq === seq && l.saved === false));
    } finally {
      fs.rmSync(flag, { force: true });
    }
    const m2 = await mediaOf(ch, seq);
    assert.ok(m2.ok);
    assert.match(mediaRef(seq) ?? '', /\.media\.jpg$/);
    assert.deepEqual(fs.readFileSync(path.join(s.home.dir, mediaRef(seq)!)), data);
    await ch.done([seq]);
    // «Диск полон» кончается приёмом следующего обновления.
    const t = s.fake.push(s.fake.builder.text(OWNER, 'место есть'))[0]!;
    const tseq = await seqOf(t);
    await ch.waitEvent(tseq);
    await ch.done([tseq]);
  });

  it('A7.19 остановка шлюза посреди скачивания — ответ «шлюз останавливается — повтори позже» уходит до закрытия сокета', async () => {
    const data = jpegBytes(1280, 960, 7000, 17);
    s.fake.scenario({ method: 'getFile', when: (p) => p.file_id === 'stopping', reply: reply.hang() });
    const seq = await photo('stopping', data);
    await ch.done([seq]);
    const pending = mediaOf(ch, seq);
    await waitUntil(() => getFileCalls('stopping') === 1 || null, 5000, 'getFile');
    await gw.stop();
    const m = await pending;
    assert.deepEqual(m.ok ? null : { code: m.code, text: m.text }, { code: 'unavailable', text: 'шлюз останавливается — повтори позже' });
  });
});
