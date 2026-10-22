// 0.3 · хранение своего звука файлом (TECH-SPEC 5.8; R-2 а: непересланный аудиофайл владельца — его слово): свой
// аудиофайл и свой кружок (кружок — R-20) — как голос владельца: файл через 30 дней (у кружка —
// и его кадр, который агент смотрел через media), расшифровка остаётся; media после срока — «содержимое удалено по сроку
// хранения», Telegram заново не спрашивается (по проверке); пересланный аудиофайл — чужое целиком: через 90 дней
// файл, расшифровка и текст (A7.13).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { Update } from 'stg-core';
import { connectAdapter, q1, readJournal, waitUntil } from './harness.js';
import { OTHER, OWNER } from './m1-common.js';
import { voiceSetup, type VoiceSetup } from './m4-common.js';
import { jpegBytes, mediaOf } from './m7-common.js';

describe('M7 · хранение своего звука файлом (0.3)', () => {
  let s: VoiceSetup;
  after(() => s?.close());

  it('свой аудиофайл и свой кружок — файл (и кадр кружка) через 30 дней, расшифровка остаётся, media — «удалено»; пересланный аудиофайл — чужое: через 90 дней файл, расшифровка и подпись', async () => {
    const said = ['моя надиктовка файлом', 'мой кружок', 'чужая лекция'];
    let k = 0;
    s = await voiceSetup({ fake: { transcript: () => said[k++] ?? 'ещё' } });
    const gw = await s.start();
    const { ch } = await connectAdapter(s.home);
    try {
      const seqOf = (u: Update): Promise<number> =>
        waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, `приёма ${u.update_id}`);
      const ev = (seq: number) => q1<{ raw_ref: string | null; transcript: string | null; text: string | null }>(s.home, 'SELECT raw_ref, transcript, text FROM events WHERE seq = ?', seq)!;
      const exists = (rel: string | null): boolean => rel !== null && fs.existsSync(path.join(s.home.dir, rel));
      const b = s.fake.builder;
      s.fake.addFile(Buffer.from('ftypM4A own '.repeat(30)), { fileId: 'own1', path: 'music/own1.m4a' });
      const a1 = await seqOf(s.fake.push(b.audio(OWNER, { fileId: 'own1', fileName: 'мысль.m4a', mimeType: 'audio/mp4', duration: 20, fileSize: 360 }))[0]!);
      await waitUntil(() => ev(a1).transcript, 10_000, 'расшифровки своего файла');
      s.fake.addFile(Buffer.from('ftypmp42 own note '.repeat(30)), { fileId: 'vn1', path: 'video/vn1.mp4' });
      const frame = jpegBytes(320, 320, 6000, 9);
      s.fake.addFile(frame, { fileId: 'vn1th', path: 'thumbnails/vn1.jpg' });
      const v1 = await seqOf(s.fake.push(b.videoNote(OWNER, { fileId: 'vn1', duration: 8, thumbnail: { fileId: 'vn1th', width: 320, height: 320, fileSize: frame.length } }))[0]!);
      await waitUntil(() => ev(v1).transcript, 10_000, 'расшифровки кружка');
      // Агент посмотрел кадр кружка — он в raw/, путь в media_ref.
      await ch.waitEvent(v1, 15_000);
      const seen = await mediaOf(ch, v1);
      assert.ok(seen.ok && seen.r.image, JSON.stringify(seen));
      const frameRef = q1<{ media_ref: string | null }>(s.home, 'SELECT media_ref FROM events WHERE seq = ?', v1)!.media_ref;
      assert.ok(exists(frameRef), 'кадр сохранён');
      const thumbCalls = (): number => s.fake.callsOf('getFile').filter((c) => c.params.file_id === 'vn1th').length;
      assert.equal(thumbCalls(), 1);
      s.fake.addFile(Buffer.from('ID3 lecture '.repeat(30)), { fileId: 'fw1', path: 'music/fw1.mp3' });
      const f1 = await seqOf(s.fake.push(b.document(OWNER, { fileId: 'fw1', fileName: 'лекция.mp3', mimeType: 'audio/mpeg', fileSize: 360 }, 'послушай', { forwardFrom: { type: 'user', user: OTHER } }))[0]!);
      await waitUntil(() => ev(f1).transcript, 10_000, 'расшифровки пересланного');
      const before = { a1: ev(a1), v1: ev(v1), f1: ev(f1) };
      assert.ok(exists(before.a1.raw_ref) && exists(before.v1.raw_ref) && exists(before.f1.raw_ref));

      // 31 день: свой звук файлом — файл удалён, расшифровка осталась; пересланный — на месте.
      const n0 = readJournal(s.home).filter((l) => l.ev === 'retention').length;
      await gw.jump('31d');
      await waitUntil(() => readJournal(s.home).filter((l) => l.ev === 'retention').length > n0 || null, 10_000, 'чистки через 31 день');
      for (const [seq, b0, text] of [[a1, before.a1, 'моя надиктовка файлом'], [v1, before.v1, 'мой кружок']] as const) {
        assert.ok(!exists(b0.raw_ref), `№ ${seq}: файл удалён`);
        assert.deepEqual({ raw: ev(seq).raw_ref, transcript: ev(seq).transcript }, { raw: null, transcript: text }, `№ ${seq}`);
      }
      assert.ok(exists(before.f1.raw_ref), 'пересланный аудиофайл ещё хранится');
      assert.equal(ev(f1).transcript, 'чужая лекция');
      // Кадр своего кружка ушёл вместе со звуком; media — «удалено по сроку», обложка у Telegram заново не берётся.
      assert.ok(!exists(frameRef), 'кадр кружка удалён');
      assert.equal(q1<{ media_ref: string | null }>(s.home, 'SELECT media_ref FROM events WHERE seq = ?', v1)!.media_ref, null);
      const gone = await mediaOf(ch, v1);
      assert.ok(gone.ok);
      assert.deepEqual({ what: gone.r.what, image: gone.r.image, note: gone.r.note }, { what: 'video_note', image: null, note: 'содержимое удалено по сроку хранения' });
      assert.equal(thumbCalls(), 1, 'Telegram заново не спрашивался');

      // 91 день: пересланный — файл и расшифровка удалены (событие — чужое целиком); свои расшифровки — на месте.
      await gw.jump('60d');
      await waitUntil(() => ev(f1).transcript === null || null, 10_000, 'чистки пересланного');
      assert.ok(!exists(before.f1.raw_ref));
      assert.deepEqual({ text: ev(f1).text, raw: ev(f1).raw_ref }, { text: null, raw: null }, 'чужое — целиком');
      assert.equal(ev(a1).transcript, 'моя надиктовка файлом');
      assert.equal(ev(v1).transcript, 'мой кружок');
    } finally {
      ch.close();
      await gw.stop();
    }
  });
});
