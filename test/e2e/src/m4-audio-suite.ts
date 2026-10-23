// M4 · аудиофайлы (J-2; TECH-SPEC 5.5, 5.8; файлы до 15 минут распознаются сразу, без нарезки) на поддельных Telegram,
// провайдере голоса и переходнике. Сценарии общие для провайдеров: их запускают
// m4-audio-openai.test.ts и m4-audio-elevenlabs.test.ts.
// 0.3.1 (P-19): аудиофайл — как голосовое: распознан — ответом на него расшифровка целиком,
// только текст; длиннее предела, больше 20 МБ или не распознан — ответом короткая причина, без номера и имени файла;
// пока распознаётся — строки нет и на файле ничего (0.3.2: ✍ нет).
// - m4a 12:34 (message.audio; Telegram отдал mime audio/mpeg) — ответом расшифровка; файл в raw/ с расширением из
//   имени; провайдеру — имя .m4a и audio/mp4; агенту — свой аудиофайл без пересылки — слово владельца (0.3, R-2 а;
//   до 0.3 — «чужое»), подпись — тоже его; агент увидел 👀 → ответил — 👀 снят (0.3.2: ✍ нет; 0.3.6, #52: 👌 нет), ответ
//   на файл не правится;
// - документ .opus без длительности — распознаётся, провайдеру — .ogg; следующий текст агенту — после аудио;
// - длиннее 15 минут — файл скачан и сохранён, провайдеру ни одного вызова, ответом «Длиннее 15 минут — не распознаю,
//   файл сохранён», агенту — «не распознан: длиннее»;
// - больше 20 МБ по метаданным — getFile не вызывается; размера нет, а getFile — «file is too big» — тот же ответ;
// Исправления по проверке:
// - ровно 15:00 — распознаётся (предел — «длиннее 15 минут»);
// - WAV документом (у document длительности нет): по самому файлу 16:40 — не распознаётся, агенту — с длительностью по
//   файлу; 0:30 — распознаётся;
// - отказ провайдера по аудиофайлу — «Не смог распознать — файл сохранён»; предохранитель голосовых не включается;
// - голосовое не ждёт аудиофайл, который распознаётся долго (две очереди).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Update } from 'stg-core';
import type { FakeChannel } from 'stg-fake-channel';
import type { SentMessage } from 'stg-fake-telegram';
import { connectAdapter, pump, q1, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, reactionsOf, receiptCleared, waitRecorded } from './m1-common.js';
import { isQuote, pushVoice, replyTo, sttRepliesOf, sttText, voiceSetup, waitSttReply, type VoiceDialect, type VoiceSetup } from './m4-common.js';

const FULL = 'итак коллеги начнём с итогов квартала по продажам затем обсудим найм и планы на осень';
const MB = 1024 * 1024;

/** WAV: заголовок fmt с заданным числом байт в секунду и data такого размера — длительность dataBytes / byteRate. */
function wavFile(byteRate: number, dataBytes: number): Buffer {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(byteRate, 12);
  fmt.writeUInt32LE(byteRate, 16);
  fmt.writeUInt16LE(1, 20);
  fmt.writeUInt16LE(8, 22);
  const data = Buffer.alloc(8 + dataBytes, 0x80);
  data.write('data', 0, 'latin1');
  data.writeUInt32LE(dataBytes, 4);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + fmt.length + data.length, 4);
  head.write('WAVE', 8, 'latin1');
  return Buffer.concat([head, fmt, data]);
}

export function audioSuite(dialect: VoiceDialect): void {
  describe(`M4 · аудиофайлы · ${dialect}`, () => {
    let s: VoiceSetup;
    let gw: GatewayProcess;
    let ch: FakeChannel;
    let turn: number;
    let fileSeq = 0;
    const seqOf = (u: Update): number | undefined => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
    const admitted = (u: Update): Promise<number> => waitUntil(() => seqOf(u), 5000, `приёма ${u.update_id}`);
    const ev = (seq: number) =>
      q1<{ kind: string; status: string; raw_ref: string | null; transcript: string | null; stt_note: string | null; trust: string; mixed: number }>(
        s.home,
        'SELECT kind, status, raw_ref, transcript, stt_note, trust, mixed FROM events WHERE seq = ?',
        seq,
      )!;
    /** Ответ шлюза на аудиофайл — одно сообщение реплаем на него (расшифровка или причина), без разметки. */
    const answer = async (u: Update): Promise<SentMessage> => {
      const [r] = await waitSttReply(s, gw, u, 1, 'ответа на аудиофайл');
      assert.deepEqual(r!.reply_parameters, replyTo(u), 'ответом на сам файл');
      assert.equal(r!.reply_markup, null, 'без кнопок');
      assert.doesNotMatch(sttText(r!), /^🎵|№|«/, 'без номера и имени файла');
      return r!;
    };
    const TOO_LONG = 'Длиннее 15 минут — не распознаю, файл сохранён';
    const TOO_BIG = 'Слишком большой для бота (больше 20 МБ) — скачать не могу';
    /** Файл в подделке Telegram. */
    const file = (data: Buffer, opts: { tooBig?: boolean } = {}): string => {
      const fileId = `au${dialect}${++fileSeq}`;
      s.fake.addFile(data, { fileId, path: `music/${fileId}.bin`, ...opts });
      return fileId;
    };
    const getFileCalls = (fileId: string): number => s.fake.callsOf('getFile').filter((c) => c.params.file_id === fileId).length;

    before(async () => {
      s = await voiceSetup({ dialect, fake: { transcript: FULL } });
      gw = await s.start();
      ({ ch, turn } = await connectAdapter(s.home));
    });
    after(async () => {
      ch?.close();
      if (gw?.alive) await gw.stop();
      await s.close();
    });

    it('m4a 12:34 (mime от Telegram — audio/mpeg): ответом — расшифровка целиком; 👀, ответ его снимает (#52); провайдеру — .m4a; агенту — слово владельца и подпись', async () => {
      const data = Buffer.from('ftypM4A fake m4a audio '.repeat(50));
      const fileId = file(data);
      const u = s.fake.push(
        s.fake.builder.audio(OWNER, { fileId, fileName: 'встреча.m4a', mimeType: 'audio/mpeg', duration: 754, fileSize: data.length }, 'запиши итоги'),
      )[0]!;
      const seq = await admitted(u);
      const r = await answer(u);
      assert.equal(sttText(r), FULL, 'только текст расшифровки');
      assert.ok(isQuote(r), 'цитатой (0.3.4, R-23 а)');
      // Пока агент не отметил delivered — на файле ничего (0.3.2: ✍ нет).
      await waitRecorded(s, gw, u);
      assert.deepEqual(reactionsOf(s.fake, u), []);
      assert.ok(!s.fake.sentTo(OWNER.id).some((m) => /распознаю/.test(m.text ?? '')), 'строки «распознаю…» нет');
      // Файл — в raw/ с расширением из имени файла, целиком; событие — document; свой аудиофайл без пересылки — слово
      // владельца (0.3, R-2 а): чужого в сообщении нет.
      const e = ev(seq);
      assert.deepEqual({ kind: e.kind, trust: e.trust, mixed: e.mixed, stt_note: e.stt_note, transcript: e.transcript }, { kind: 'document', trust: 'owner', mixed: 0, stt_note: null, transcript: FULL });
      assert.match(e.raw_ref ?? '', new RegExp(`^raw/\\d{4}-\\d{2}-\\d{2}/${u.update_id}\\.m4a$`));
      assert.deepEqual(fs.readFileSync(path.join(s.home.dir, e.raw_ref!)), data);
      // Провайдеру — имя .m4a и mime по расширению (не audio/mpeg от Telegram), язык и словарь — как у голосового.
      const req = s.voice.stt.at(-1)!;
      assert.deepEqual(
        { name: req.file?.filename, type: req.file?.type, bytes: req.file?.bytes, language: req.language },
        { name: 'встреча.m4a', type: 'audio/mp4', bytes: data.length, language: 'ru' },
      );
      const j = readJournal(s.home).find((l) => l.ev === 'transcribed' && l.seq === seq);
      assert.deepEqual([j?.label, j?.audio_file, j?.seconds, j?.source], ['owner', true, 754, 'audio'], 'своя надиктовка файлом в журнале — с меткой owner');
      // Агенту — расшифровка (слово владельца) и подпись; сведения об аудио.
      const n = await ch.waitEvent(seq);
      assert.deepEqual(
        { kind: n.kind, trust: n.trust, mixed: n.mixed, text: n.text, transcript: n.transcript, audio: n.audio },
        { kind: 'document', trust: 'owner', mixed: false, text: 'запиши итоги', transcript: FULL, audio: { name: 'встреча.m4a', seconds: 754, state: 'transcribed', max_minutes: 15, source: 'audio' } },
      );
      assert.deepEqual(n.attachments, [{ kind: 'document', trust: 'owner' }]);
      // Агент увидел — 👀; ответил — 👀 снят, когда ответ ушёл (0.3.6, #52). Ответ на файл не правится, «→ ответил» нет.
      await ch.delivered(seq);
      await pump(gw, () => reactionsOf(s.fake, u).at(-1) === '👀' || null, { what: '👀' });
      const a = await ch.reply(seq, 'Записал итоги встречи', turn);
      assert.ok(a.type === 'ack' && a.result === 'queued', JSON.stringify(a));
      await pump(gw, () => receiptCleared(s.fake, u) || null, { what: 'снятия 👀' });
      assert.deepEqual(reactionsOf(s.fake, u), ['👀', '']);
      assert.equal(r.edits.length, 0, 'ответ на файл не правится');
      assert.equal(sttRepliesOf(s, u).length, 1);
    });

    it('документ .opus без длительности — распознаётся (провайдеру — .ogg); текст следом — агенту после аудио', async () => {
      const data = Buffer.from('OggS fake opus '.repeat(40));
      const fileId = file(data);
      s.voice.latencyMs = 1500;
      try {
        const u = s.fake.push(s.fake.builder.document(OWNER, { fileId, fileName: 'заметка.opus', mimeType: 'application/octet-stream', fileSize: data.length }, null))[0]!;
        const t = s.fake.push(s.fake.builder.text(OWNER, 'и ещё текстом'))[0]!;
        const seq = await admitted(u);
        const st = await admitted(t);
        await waitRecorded(s, gw, [u, t]);
        await waitRecorded(s, gw, [u, t]);
        const n = await ch.waitEvent(st, 15_000);
        assert.equal(n.kind, 'text');
        const order = ch.events().map((x) => x.seq).filter((x) => x === seq || x === st);
        assert.deepEqual(order, [seq, st], 'текст не обогнал аудиофайл');
        assert.equal(ch.events().find((x) => x.seq === seq)?.transcript, FULL);
        assert.match(ev(seq).raw_ref ?? '', /\.opus$/);
        const req = s.voice.stt.at(-1)!;
        assert.deepEqual({ name: req.file?.filename, type: req.file?.type }, { name: 'заметка.ogg', type: 'audio/ogg' });
        assert.equal(sttText(await answer(u)), FULL);
        await ch.done([seq, st]);
      } finally {
        s.voice.latencyMs = 0;
      }
    });

    it('длиннее 15 минут — не распознаётся: ответом «Длиннее 15 минут…»; файл скачан; провайдеру 0 вызовов; агенту — почему', async () => {
      const data = Buffer.from('ID3 fake mp3 '.repeat(40));
      const fileId = file(data);
      const calls = s.voice.stt.length;
      const u = s.fake.push(s.fake.builder.audio(OWNER, { fileId, fileName: 'лекция.mp3', mimeType: 'audio/mpeg', duration: 16 * 60 + 5, fileSize: data.length }))[0]!;
      const seq = await admitted(u);
      await waitRecorded(s, gw, u);
      await waitUntil(() => ev(seq).status !== 'transcribing' || null, 10_000, 'скачивания');
      const r = await answer(u);
      assert.equal(r.text, TOO_LONG);
      const e = ev(seq);
      assert.deepEqual({ status: e.status, stt_note: e.stt_note, transcript: e.transcript }, { status: 'new', stt_note: 'too_long', transcript: null });
      assert.match(e.raw_ref ?? '', /\.mp3$/);
      assert.deepEqual(fs.readFileSync(path.join(s.home.dir, e.raw_ref!)), data, 'файл сохранён');
      assert.equal(getFileCalls(fileId), 1);
      const n = await ch.waitEvent(seq);
      assert.deepEqual({ transcript: n.transcript, audio: n.audio }, { transcript: null, audio: { name: 'лекция.mp3', seconds: 965, state: 'too_long', max_minutes: 15, source: 'audio' } });
      assert.ok(readJournal(s.home).some((l) => l.ev === 'stt_skipped' && l.seq === seq && l.reason === 'too_long' && l.saved === true));
      for (let i = 0; i < 3; i++) {
        await gw.advance('1s');
        await sleep(20);
      }
      assert.equal(s.voice.stt.length, calls, 'провайдеру — ни одного вызова');
      assert.equal(sttRepliesOf(s, u).length, 1, 'ответ один');
      await ch.done([seq]);
    });

    it('больше 20 МБ по метаданным — не скачивается: ответом «Слишком большой для бота (больше 20 МБ)»; getFile не вызывался', async () => {
      const calls = s.voice.stt.length;
      const fileId = `au${dialect}big`;
      const u = s.fake.push(s.fake.builder.audio(OWNER, { fileId, fileName: 'запись.m4a', mimeType: 'audio/mp4', duration: 1800, fileSize: 25 * MB }))[0]!;
      const seq = await admitted(u);
      const r = await answer(u);
      assert.equal(r.text, TOO_BIG);
      const e = ev(seq);
      assert.deepEqual({ status: e.status, stt_note: e.stt_note, raw_ref: e.raw_ref }, { status: 'new', stt_note: 'too_big', raw_ref: null });
      const n = await ch.waitEvent(seq);
      assert.equal(n.audio?.state, 'too_big');
      await waitRecorded(s, gw, u);
      assert.equal(getFileCalls(fileId), 0, 'getFile не вызывался');
      assert.equal(s.voice.stt.length, calls);
      await ch.done([seq]);
    });

    it('ровно 15:00 — распознаётся: предел — «длиннее 15 минут»', async () => {
      const data = Buffer.from('ID3 fake mp3 ровно '.repeat(40));
      const fileId = file(data);
      const u = s.fake.push(s.fake.builder.audio(OWNER, { fileId, fileName: 'ровно.mp3', mimeType: 'audio/mpeg', duration: 900, fileSize: data.length }))[0]!;
      const seq = await admitted(u);
      assert.equal(sttText(await answer(u)), FULL);
      const n = await ch.waitEvent(seq);
      assert.deepEqual(n.audio, { name: 'ровно.mp3', seconds: 900, state: 'transcribed', max_minutes: 15, source: 'audio' });
      await ch.done([seq]);
    });

    it('WAV документом без длительности: по файлу 16:40 — не распознаётся (ответом — причина, агенту — с длительностью); 0:30 — распознаётся', async () => {
      const calls = s.voice.stt.length;
      const long = wavFile(100, 100_000);
      const longId = file(long);
      const u = s.fake.push(s.fake.builder.document(OWNER, { fileId: longId, fileName: 'созвон.wav', mimeType: 'audio/x-wav', fileSize: long.length }, null))[0]!;
      const seq = await admitted(u);
      assert.equal((await answer(u)).text, TOO_LONG, 'после скачивания: длительность — по файлу');
      const e = q1<{ status: string; stt_note: string | null; audio_seconds: number | null; raw_ref: string | null }>(
        s.home,
        'SELECT status, stt_note, audio_seconds, raw_ref FROM events WHERE seq = ?',
        seq,
      )!;
      assert.deepEqual({ status: e.status, stt_note: e.stt_note, audio_seconds: e.audio_seconds }, { status: 'new', stt_note: 'too_long', audio_seconds: 1000 });
      assert.deepEqual(fs.readFileSync(path.join(s.home.dir, e.raw_ref!)), long, 'файл сохранён');
      assert.equal(s.voice.stt.length, calls, 'провайдеру — ни одного вызова');
      const j = readJournal(s.home);
      assert.ok(j.some((l) => l.ev === 'audio_duration' && l.seq === seq && l.how === 'file' && l.seconds === 1000));
      assert.ok(j.some((l) => l.ev === 'stt_skipped' && l.seq === seq && l.reason === 'too_long' && l.seconds === 1000));
      const n = await ch.waitEvent(seq);
      assert.deepEqual(n.audio, { name: 'созвон.wav', seconds: 1000, state: 'too_long', max_minutes: 15, source: 'audio' });
      await ch.done([seq]);

      const short = wavFile(1000, 30_000);
      const shortId = file(short);
      const u2 = s.fake.push(s.fake.builder.document(OWNER, { fileId: shortId, fileName: 'заметка.wav', mimeType: 'audio/wav', fileSize: short.length }, null))[0]!;
      const seq2 = await admitted(u2);
      assert.equal(sttText(await answer(u2)), FULL);
      const n2 = await ch.waitEvent(seq2);
      assert.deepEqual(n2.audio, { name: 'заметка.wav', seconds: 30, state: 'transcribed', max_minutes: 15, source: 'audio' });
      await ch.done([seq2]);
    });

    it('отказ провайдера по аудиофайлу — ответом «Не смог распознать — файл сохранён»; предохранитель голосовых не включается', async () => {
      const data = Buffer.from('ftypM4A fake m4a audio '.repeat(30));
      const fileId = file(data);
      s.voice.sttScript = ['error', 'error', 'error'];
      try {
        const u = s.fake.push(s.fake.builder.audio(OWNER, { fileId, fileName: 'сбой.m4a', mimeType: 'audio/mp4', duration: 120, fileSize: data.length }))[0]!;
        const seq = await admitted(u);
        assert.equal((await answer(u)).text, 'Не смог распознать — файл сохранён');
        const j = readJournal(s.home);
        assert.ok(j.some((l) => l.ev === 'stt_failed' && l.seq === seq && l.audio_file === true && l.attempts === 3));
        assert.ok(!j.some((l) => l.ev === 'stt_degraded'), 'предохранитель голосовых не включён');
        const n = await ch.waitEvent(seq);
        assert.equal(n.audio?.state, 'failed');
        await ch.done([seq]);
      } finally {
        s.voice.sttScript = [];
      }
    });

    it('голосовое не ждёт аудиофайл, который распознаётся долго: распознано, пока файл ещё в работе', async () => {
      const data = Buffer.from('ftypM4A fake m4a long '.repeat(30));
      const fileId = file(data);
      const calls = s.voice.stt.length;
      s.voice.sttScript = ['hang'];
      try {
        const ua = s.fake.push(s.fake.builder.audio(OWNER, { fileId, fileName: 'долгий.m4a', mimeType: 'audio/mp4', duration: 120, fileSize: data.length }))[0]!;
        const seqA = await admitted(ua);
        await waitUntil(() => s.voice.stt.length > calls || null, 10_000, 'запроса распознавания файла');
        const uv = pushVoice(s, 3);
        const seqV = await admitted(uv);
        await pump(gw, () => q1<{ transcript: string | null }>(s.home, 'SELECT transcript FROM events WHERE seq = ?', seqV)?.transcript || null, {
          step: '200ms',
          what: 'расшифровки голосового',
        });
        assert.equal(ev(seqA).status, 'transcribing', 'файл ещё распознаётся');
        // Срок попытки файла (60 с) — вторая попытка удачна.
        await pump(gw, () => ev(seqA).transcript || null, { step: '5s', what: 'расшифровки файла' });
        assert.ok(!readJournal(s.home).some((l) => l.ev === 'stt_degraded'), 'срок на файле — не предохранитель');
        await ch.waitEvent(seqV, 15_000);
        await ch.done([seqA, seqV]);
      } finally {
        s.voice.sttScript = [];
      }
    });

    it('размера в метаданных нет, а getFile — «file is too big»: ответом «Слишком большой…», событие отдано', async () => {
      const fileId = file(Buffer.from('x'), { tooBig: true });
      const u = s.fake.push(s.fake.builder.document(OWNER, { fileId, fileName: 'диктофон.wav', mimeType: 'audio/x-wav', fileSize: null }, 'созвон'))[0]!;
      const seq = await admitted(u);
      assert.equal((await answer(u)).text, TOO_BIG);
      const e = ev(seq);
      assert.deepEqual({ status: e.status, stt_note: e.stt_note, raw_ref: e.raw_ref }, { status: 'new', stt_note: 'too_big', raw_ref: null });
      const n = await ch.waitEvent(seq);
      assert.deepEqual({ text: n.text, state: n.audio?.state }, { text: 'созвон', state: 'too_big' });
      assert.ok(readJournal(s.home).some((l) => l.ev === 'stt_audio_too_big' && l.seq === seq));
      await ch.done([seq]);
    });
  });
}
