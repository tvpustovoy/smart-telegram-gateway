// M19 · без распознавания (5.8 «Без распознавания», /stt): владелец на время выключает распознавание пересланного и
// аудиофайлов — на поддельных Telegram, провайдере голоса и переходнике:
// - A19.1 /stt off 30m — строка со сроком, в закреплённой строке 🔇; пересланное голосовое и пересланный аудиофайл
//   провайдеру не уходят (аудиофайл и не скачивается), ответа на них нет; агенту — без расшифровки, с пометкой stt_off и
//   полем file; большой пересланный аудиофайл — тоже без ответа; своё голосовое распознаётся как всегда;
// - A19.2 file(seq) отдаёт звук: аудиофайл — скачав из Telegram, голосовое — из raw/, без нового getFile;
// - A19.3 срок вышел — строка «снова распознаю», 🔇 из закреплённой строки уходит, пересланное снова распознаётся;
// - A19.4 /stt переключает: выключено — включает; срок не понят — строка с образцом.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FileResult, GatewayMessage, Update } from 'stg-core';
import type { FakeChannel } from 'stg-fake-channel';
import { connectAdapter, makeTempDir, pump, q1, waitUntil, type GatewayProcess } from './harness.js';
import { OTHER, OWNER, waitRecorded } from './m1-common.js';
import { pushVoice, sttRepliesOf, voiceSetup, type VoiceSetup } from './m4-common.js';

const HEARD = 'раз два три';

function fileOf(m: GatewayMessage): FileResult {
  if (m.type !== 'ack') throw new Error(`file: ждал ack, пришло ${JSON.stringify(m)}`);
  return m.result as FileResult;
}

describe('M19 · без распознавания: /stt (5.8)', () => {
  let s: VoiceSetup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  const incoming = path.join(makeTempDir('stg-in-'), 'in');
  const seqOf = (u: Update): Promise<number> =>
    waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, `приёма ${u.update_id}`);
  const getFileCalls = (fileId: string): number => s.fake.callsOf('getFile').filter((c) => c.params.file_id === fileId).length;
  const ownerLine = (prefix: string): Promise<string> =>
    pump(gw, () => s.fake.sentTo(OWNER.id).map((m) => m.text ?? '').find((t) => t.startsWith(prefix)) ?? null, { what: `строки «${prefix}»` });
  const pinned = (): string => {
    const v = q1<{ value: string | null }>(s.home, "SELECT value FROM meta WHERE key = 'status_line'")?.value;
    return v ? ((JSON.parse(v) as { text?: string }).text ?? '') : '';
  };
  const say = async (text: string): Promise<void> => {
    const u = s.fake.push(s.fake.builder.text(OWNER, text))[0]!;
    await waitRecorded(s, gw, u);
  };
  const forwardedAudio = (fileId: string, data: Buffer): Update => {
    s.fake.addFile(data, { fileId, path: `music/${fileId}.mp3` });
    return s.fake.push(
      s.fake.builder.audio(OWNER, { fileId, fileName: '1-Mantra.mp3', mimeType: 'audio/mpeg', duration: 268, fileSize: data.length }, null, {
        forwardFrom: { type: 'user', user: OTHER },
      }),
    )[0]!;
  };

  before(async () => {
    s = await voiceSetup({ fake: { transcript: HEARD }, extraConfig: `incoming: { dir: "${incoming}" }\n` });
    gw = await s.start();
    ({ ch } = await connectAdapter(s.home));
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s?.close();
  });

  let fvSeq = 0;
  let faSeq = 0;
  const mp3 = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(30_000, 5)]);

  it('A19.1 /stt off 30m: пересланное голосовое и аудиофайл — без распознавания и без ответа, агенту с пометкой; своё голосовое распознаётся', async () => {
    await say('/stt off 30m');
    const off = await ownerLine('⚙ 🔇 До ');
    assert.match(off, /^⚙ 🔇 До \d\d:\d\d не распознаю пересланное и аудиофайлы/);
    await pump(gw, () => (pinned().includes('🔇 до ') ? true : null), { what: '🔇 в закреплённой строке' });
    const sttBefore = s.voice.stt.length;

    const fv = pushVoice(s, 3, { forwardFrom: { type: 'user', user: OTHER } });
    fvSeq = await seqOf(fv);
    const evV = await ch.waitEvent(fvSeq);
    assert.equal(evV.transcript, null);
    assert.equal(evV.stt_off, true);
    assert.deepEqual(evV.file, { name: null, mime: 'audio/ogg', bytes: null });

    const fa = forwardedAudio('fa1', mp3);
    faSeq = await seqOf(fa);
    const evA = await ch.waitEvent(faSeq);
    assert.equal(evA.transcript, null);
    assert.equal(evA.stt_off, true);
    assert.deepEqual(evA.file, { name: '1-Mantra.mp3', mime: 'audio/mpeg', bytes: mp3.length });
    assert.equal(getFileCalls('fa1'), 0, 'аудиофайл не скачивался');

    const own = pushVoice(s, 2);
    const ownSeq = await seqOf(own);
    const evO = await ch.waitEvent(ownSeq);
    assert.equal(evO.transcript, HEARD, 'своё голосовое — его слова, распознаётся');
    assert.equal(evO.stt_off, undefined);
    assert.equal(s.voice.stt.length, sttBefore + 1, 'провайдеру — только своё голосовое');
    assert.equal(sttRepliesOf(s, fv).length, 0, 'на пересланное ответа нет');
    assert.equal(sttRepliesOf(s, fa).length, 0, 'на аудиофайл ответа нет');
    assert.equal(q1<{ n: number }>(s.home, 'SELECT count(*) AS n FROM events WHERE stt_off = 1')?.n, 2);

    // Больше 20 МБ по метаданным: обычно сразу ответ «слишком большой» — пока выключено, и его нет.
    const big = s.fake.push(
      s.fake.builder.audio(OWNER, { fileId: 'fa-big', fileName: 'big.mp3', duration: 600, fileSize: 25 * 1024 * 1024 }, null, { forwardFrom: { type: 'user', user: OTHER } }),
    )[0]!;
    await ch.waitEvent(await seqOf(big));
    assert.equal(sttRepliesOf(s, big).length, 0, 'на большой пересланный аудиофайл ответа нет');
  });

  it('A19.2 file(seq) отдаёт звук: аудиофайл — из Telegram, голосовое — из raw/, без нового getFile', async () => {
    const a = fileOf(await ch.request('file', { seq: faSeq }, 30_000));
    assert.equal(path.dirname(a.path), incoming);
    assert.match(path.basename(a.path), new RegExp(`_${faSeq}_1-Mantra\\.mp3$`));
    assert.deepEqual(fs.readFileSync(a.path), mp3);
    assert.equal(getFileCalls('fa1'), 1);

    const voiceFileId = (JSON.parse(q1<{ a: string }>(s.home, 'SELECT attachments_json AS a FROM events WHERE seq = ?', fvSeq)!.a) as Array<{ ref: { file_id: string } }>)[0]!.ref.file_id;
    const calls = getFileCalls(voiceFileId);
    const v = fileOf(await ch.request('file', { seq: fvSeq }, 30_000));
    assert.match(path.basename(v.path), new RegExp(`_${fvSeq}_голосовое-${fvSeq}\\.ogg$`));
    assert.equal(v.mime, 'audio/ogg');
    const raw = q1<{ raw_ref: string }>(s.home, 'SELECT raw_ref FROM events WHERE seq = ?', fvSeq)!.raw_ref;
    assert.deepEqual(fs.readFileSync(v.path), fs.readFileSync(path.join(s.home.paths.home, raw)));
    assert.equal(getFileCalls(voiceFileId), calls, 'голосовое — из raw/');
  });

  it('A19.3 срок вышел: строка «снова распознаю», 🔇 уходит, пересланное снова распознаётся', async () => {
    await gw.advance('31m');
    await ownerLine('⚙ 🔊 Срок вышел');
    await pump(gw, () => (pinned().includes('🔇') ? null : true), { what: '🔇 ушёл из закреплённой строки' });
    const fv = pushVoice(s, 3, { forwardFrom: { type: 'user', user: OTHER } });
    const ev = await ch.waitEvent(await seqOf(fv));
    assert.equal(ev.transcript, HEARD);
    assert.equal(ev.stt_off, undefined);
  });

  it('A19.4 /stt переключает: выключено — включает; срок не понят — строка с образцом', async () => {
    const offLines = (): number => s.fake.sentTo(OWNER.id).filter((m) => (m.text ?? '').startsWith('⚙ 🔇 До ')).length;
    const before = offLines();
    await say('/stt');
    await pump(gw, () => (offLines() > before ? true : null), { what: 'строки «выключено»' });
    await say('/stt');
    await ownerLine('⚙ 🔊 Пересланное и аудиофайлы снова распознаю');
    assert.equal(q1<{ value: string | null }>(s.home, "SELECT value FROM meta WHERE key = 'stt_off_until'")?.value ?? null, null);
    await say('/stt 25h');
    await ownerLine('⚙ Не понял срок «25h»');
  });
});
