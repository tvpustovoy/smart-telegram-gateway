// M7 · кружки, видео и своя надиктовка файлом (0.3; P-14, P-15: кружки распознаются; R-2 а: непересланный аудиофайл
// владельца — его слово, пересланный — чужое) на поддельных Telegram, провайдере голоса и переходнике. Сценарии общие
// для провайдеров: их запускают m7-sound-openai.test.ts и m7-sound-elevenlabs.test.ts.
// Сведение 0.3 и 0.3.1: владельцу кружок и видео — в виде тихого чата, как голосовое и аудиофайл (P-11, P-19;
// 0.3.2 — без ✍): на приёме ничего (строки «распознаю…» нет), распознано — ответом на кружок (видео) сама расшифровка,
// только текст; нет расшифровки — ответом короткая причина; агент увидел — 👀, ответил — 👀 снят (0.3.6, #52), done —
// 👌; ответ на
// кружок не правится, «→ ответил» нет.
// - A7.7 свой кружок 0:42: ответ-расшифровка реплаем на кружок → 👀 → ответ агента его снимает; провайдеру —
//   <update_id>.mp4,
//   video/mp4; в raw/ — .mp4; агенту — слово владельца (метка owner), расшифровка, кадр (media); голосовая очередь;
// - A7.8 пересланный кружок — «чужое» (метка вложения и события), итог эпизода — «чужое»; ответ-расшифровка — так же;
// - A7.9 свой аудиофайл без пересылки — слово владельца, итог эпизода — своё; пересланный — чужое, итог — «чужое»;
// - A7.10 видео mp4 — звук распознаётся (провайдеру — имя .mp4, video/mp4), ответом — расшифровка; метка — «чужое»
//   ⟨предл.⟩; видео .mov — не распознаётся: ответом «Видео не в mp4 — звук не распознаю» ⟨предл., сведение⟩;
// - A7.11 отказ распознавания кружка — ответом «Не смог распознать — кружок сохранён. Срочное — текстом»; агенту — «не
//   распознан»;
// - A7.20 свой пересланный кружок — «своё пересланное» (owner_forward): ответ — тот же, расшифровка — материал, итог
//   эпизода — «чужое» (Ш-25);
// - A7.21 кружок больше 20 МБ — ответом «Слишком большой для бота… скачать не могу», не скачивается; длиннее предела —
//   «Длиннее 15 минут — не распознаю, кружок сохранён»: скачан, провайдеру не ушёл;
// - A7.24 (исправления по проверке сведения) видео файлом — `message.document` с mime video/* (iPhone .mov «файлом», без
//   сжатия) — обычный файл, как в 0.3: 👀 → 👌, ответа шлюза нет, не скачивается, провайдеру не уходит (развилка
//   R-22, #43, ещё не решена); видео без mime и имени — пробуем как mp4 ⟨предл.⟩: ответом расшифровка.
// Свой кружок — слово владельца: распознаётся, метка — как у своего аудиофайла (R-20 а).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Update } from 'stg-core';
import type { FakeChannel } from 'stg-fake-channel';
import type { SentMessage } from 'stg-fake-telegram';
import { connectAdapter, pump, q1, readJournal, waitUntil, type GatewayProcess } from './harness.js';
import { OTHER, OWNER, reactionsOf, receiptCleared, waitRecorded } from './m1-common.js';
import { isQuote, replyTo, sttRepliesOf, sttText, voiceSetup, waitSttReply, type VoiceDialect, type VoiceSetup } from './m4-common.js';
import { imageBytes, jpegBytes, mediaOf } from './m7-common.js';

const SAID = 'проверка кружка: звук распознаётся и уходит агенту';

export function soundSuite(dialect: VoiceDialect): void {
  describe(`M7 · кружки, видео, своя надиктовка файлом · ${dialect}`, () => {
    let s: VoiceSetup;
    let gw: GatewayProcess;
    let ch: FakeChannel;
    let turn: number;
    let fileSeq = 0;
    const admitted = (u: Update): Promise<number> =>
      waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, `приёма ${u.update_id}`);
    const ev = (seq: number) =>
      q1<{ kind: string; status: string; raw_ref: string | null; transcript: string | null; trust: string; mixed: number; attachments_json: string }>(
        s.home,
        'SELECT kind, status, raw_ref, transcript, trust, mixed, attachments_json FROM events WHERE seq = ?',
        seq,
      )!;
    const file = (data: Buffer, ext: string): string => {
      const fileId = `m7${dialect}${++fileSeq}`;
      s.fake.addFile(data, { fileId, path: `video/${fileId}.${ext}` });
      return fileId;
    };
    /**
     * Ответ шлюза на кружок, видео или аудиофайл (сведение 0.3 и 0.3.1, P-19) — одно сообщение реплаем на само
     * сообщение владельца, без разметки, без номера и квитанционных пометок.
     */
    const answer = async (u: Update): Promise<SentMessage> => {
      const [r] = await waitSttReply(s, gw, u, 1, 'ответа на кружок (видео, файл)');
      assert.deepEqual(r!.reply_parameters, replyTo(u), 'ответом на само сообщение');
      assert.equal(r!.reply_markup, null, 'без кнопок');
      assert.doesNotMatch(sttText(r!), /^(🎬|🎵|№|⚙)|распознаю…|записал/, 'без номера и квитанционных пометок');
      return r!;
    };

    before(async () => {
      s = await voiceSetup({ dialect, fake: { transcript: SAID } });
      gw = await s.start();
      ({ ch, turn } = await connectAdapter(s.home));
    });
    after(async () => {
      ch?.close();
      if (gw?.alive) await gw.stop();
      await s.close();
    });

    it('A7.7 свой кружок 0:42: ответ-расшифровка на кружок → 👀, ответ агента его снимает (#52); провайдеру — .mp4 video/mp4; агенту — слово владельца (owner) и кадр', async () => {
      const mp4 = Buffer.from('\x00\x00\x00\x18ftypmp42 fake video note '.repeat(40), 'latin1');
      const frame = jpegBytes(320, 320, 7000, 6);
      const fileId = file(mp4, 'mp4');
      s.fake.addFile(frame, { fileId: `${fileId}_th`, path: `thumbnails/${fileId}.jpg` });
      const u = s.fake.push(s.fake.builder.videoNote(OWNER, { fileId, duration: 42, fileSize: mp4.length, thumbnail: { fileId: `${fileId}_th`, width: 320, height: 320, fileSize: frame.length } }))[0]!;
      const seq = await admitted(u);
      // Агент ещё не отметил delivered — на кружке ничего (0.3.2: ✍ нет).
      await waitRecorded(s, gw, u);
      const r = await answer(u);
      assert.equal(sttText(r), SAID, 'только текст расшифровки');
      assert.ok(isQuote(r), 'цитатой (0.3.4, R-23 а)');
      assert.deepEqual(reactionsOf(s.fake, u), []);
      assert.ok(!s.fake.sentTo(OWNER.id).some((m) => /распознаю|кружок 0:42/.test(m.text ?? '')), 'квитанции «№ N (#M) кружок 0:42 записал, распознаю…» нет');
      // Провайдеру — mp4 как есть: имя <update_id>.mp4, video/mp4.
      const req = s.voice.stt.at(-1)!;
      assert.deepEqual({ name: req.file?.filename, type: req.file?.type, bytes: req.file?.bytes }, { name: `${u.update_id}.mp4`, type: 'video/mp4', bytes: mp4.length });
      // В raw/ — .mp4; событие — document, слово владельца без чужого.
      const e = ev(seq);
      assert.deepEqual({ kind: e.kind, trust: e.trust, mixed: e.mixed, transcript: e.transcript }, { kind: 'document', trust: 'owner', mixed: 0, transcript: SAID });
      assert.match(e.raw_ref ?? '', /\.mp4$/);
      assert.deepEqual(fs.readFileSync(path.join(s.home.dir, e.raw_ref!)), mp4);
      const j = readJournal(s.home).find((l) => l.ev === 'transcribed' && l.seq === seq);
      assert.deepEqual([j?.label, j?.source, j?.lane], ['owner', 'video_note', 'voice']);
      // Агенту — расшифровка, слово владельца, кадр.
      const n = await ch.waitEvent(seq);
      assert.deepEqual(
        { kind: n.kind, trust: n.trust, mixed: n.mixed, transcript: n.transcript, attachments: n.attachments, audio: n.audio, media: n.media },
        {
          kind: 'document',
          trust: 'owner',
          mixed: false,
          transcript: SAID,
          attachments: [{ kind: 'document', trust: 'owner' }],
          audio: { name: 'кружок', seconds: 42, state: 'transcribed', max_minutes: 15, source: 'video_note' },
          media: { what: 'video_note', frame: true },
        },
      );
      const m = await mediaOf(ch, seq);
      assert.ok(m.ok);
      assert.deepEqual(imageBytes(m.r), frame);
      // Агент увидел — 👀; ответил — 👀 снят, когда ответ ушёл (0.3.6, #52). Ответ на кружок не правится, «→ ответил» нет.
      await ch.delivered(seq);
      await pump(gw, () => reactionsOf(s.fake, u).at(-1) === '👀' || null, { what: '👀' });
      const a = await ch.reply(seq, 'Понял про кружки', turn);
      assert.ok(a.type === 'ack', JSON.stringify(a));
      await pump(gw, () => receiptCleared(s.fake, u) || null, { what: 'снятия 👀' });
      assert.deepEqual(reactionsOf(s.fake, u), ['👀', '']);
      assert.equal(r.edits.length, 0, 'ответ на кружок не правится');
      assert.equal(sttRepliesOf(s, u).length, 1, 'ответ один');
    });

    it('A7.8 пересланный кружок — «чужое»; ответ-расшифровка — так же; итог эпизода — с меткой «чужое»', async () => {
      const ep = await ch.episode('new', 'пересланный кружок');
      assert.ok(ep.type === 'ack', JSON.stringify(ep));
      const epId = (ep.result as { episode_id: number }).episode_id;
      const fileId = file(Buffer.from('ftypmp42 forwarded note '.repeat(30)), 'mp4');
      const u = s.fake.push(s.fake.builder.videoNote(OWNER, { fileId, duration: 9 }, { forwardFrom: { type: 'user', user: OTHER } }))[0]!;
      const seq = await admitted(u);
      assert.equal(sttText(await answer(u)), SAID);
      const n = await ch.waitEvent(seq, 15_000);
      assert.deepEqual(
        { trust: n.trust, attachments: n.attachments, transcript: n.transcript, source: n.audio?.source, media: n.media, episode: n.episode?.id },
        { trust: 'untrusted', attachments: [{ kind: 'document', trust: 'untrusted' }], transcript: SAID, source: 'video_note', media: { what: 'video_note', frame: false }, episode: epId },
      );
      assert.equal(readJournal(s.home).find((l) => l.ev === 'transcribed' && l.seq === seq)?.label, 'untrusted');
      const sum = await ch.episodeSummary(epId, 'итог про чужой кружок');
      assert.ok(sum.type === 'ack');
      assert.equal((sum.result as { summary_trust: string }).summary_trust, 'untrusted');
      await ch.done([seq]);
      await pump(gw, () => reactionsOf(s.fake, u).at(-1) === '👌' || null, { what: '👌 после done' });
    });

    it('A7.9 свой аудиофайл без пересылки — слово владельца (итог — своё); пересланный — чужое (итог — «чужое»); ответом — только расшифровка, подпись в ответ не идёт', async () => {
      const ep = await ch.episode('new', 'надиктовка файлом');
      assert.ok(ep.type === 'ack');
      const epId = (ep.result as { episode_id: number }).episode_id;
      const own = Buffer.from('ftypM4A own dictation '.repeat(30));
      const ownId = file(own, 'm4a');
      const u1 = s.fake.push(s.fake.builder.audio(OWNER, { fileId: ownId, fileName: 'Новая запись.m4a', mimeType: 'audio/x-m4a', duration: 95, fileSize: own.length }, 'это для заметок'))[0]!;
      const seq1 = await admitted(u1);
      assert.equal(sttText(await answer(u1)), SAID, 'только расшифровка: ни имени файла, ни подписи');
      const n1 = await ch.waitEvent(seq1, 15_000);
      assert.deepEqual(
        { trust: n1.trust, mixed: n1.mixed, attachments: n1.attachments, text: n1.text, transcript: n1.transcript, source: n1.audio?.source, episode: n1.episode?.id },
        { trust: 'owner', mixed: false, attachments: [{ kind: 'document', trust: 'owner' }], text: 'это для заметок', transcript: SAID, source: 'audio', episode: epId },
      );
      const s1 = await ch.episodeSummary(epId, 'итог своей надиктовки');
      assert.ok(s1.type === 'ack');
      assert.equal((s1.result as { summary_trust: string }).summary_trust, 'owner', 'своя надиктовка файлом — итог своим словом');
      // Пересланный — чужое; итог того же эпизода — уже «чужое».
      const fwdId = file(Buffer.from('ID3 forwarded lecture '.repeat(30)), 'mp3');
      const u2 = s.fake.push(s.fake.builder.document(OWNER, { fileId: fwdId, fileName: 'лекция.mp3', mimeType: 'audio/mpeg', fileSize: 600 }, null, { forwardFrom: { type: 'user', user: OTHER } }))[0]!;
      const seq2 = await admitted(u2);
      assert.equal(sttText(await answer(u2)), SAID);
      const n2 = await ch.waitEvent(seq2, 15_000);
      assert.deepEqual({ trust: n2.trust, attachments: n2.attachments, transcript: n2.transcript }, { trust: 'untrusted', attachments: [{ kind: 'document', trust: 'untrusted' }], transcript: SAID });
      assert.equal(readJournal(s.home).find((l) => l.ev === 'transcribed' && l.seq === seq2)?.label, 'untrusted');
      const s2 = await ch.episodeSummary(epId, 'итог с чужой лекцией');
      assert.ok(s2.type === 'ack');
      assert.equal((s2.result as { summary_trust: string }).summary_trust, 'untrusted');
      await ch.done([seq1, seq2]);
    });

    it('A7.10 видео mp4 — звук распознаётся (провайдеру — .mp4, video/mp4), ответом — расшифровка; метка — «чужое», подпись — слово владельца; видео .mov — ответом отказ «не в mp4»', async () => {
      const mp4 = Buffer.from('\x00\x00\x00\x18ftypisom fake video '.repeat(40), 'latin1');
      const fileId = file(mp4, 'mp4');
      const u = s.fake.push(s.fake.builder.video(OWNER, { fileId, duration: 75, fileName: 'IMG_0042.MOV', mimeType: 'video/mp4', fileSize: mp4.length }, 'что тут говорят'))[0]!;
      const seq = await admitted(u);
      await waitRecorded(s, gw, u);
      assert.equal(sttText(await answer(u)), SAID);
      const n = await ch.waitEvent(seq, 15_000);
      assert.deepEqual(
        { trust: n.trust, mixed: n.mixed, attachments: n.attachments, text: n.text, transcript: n.transcript, source: n.audio?.source },
        { trust: 'owner', mixed: true, attachments: [{ kind: 'document', trust: 'untrusted' }], text: 'что тут говорят', transcript: SAID, source: 'video' },
      );
      const req = s.voice.stt.at(-1)!;
      assert.deepEqual({ name: req.file?.filename, type: req.file?.type }, { name: 'IMG_0042.mp4', type: 'video/mp4' });
      assert.match(ev(seq).raw_ref ?? '', /\.mp4$/);
      // Видео не в mp4 (.mov) — не распознаётся: сразу короткий ответ-отказ; провайдеру и getFile — ничего.
      const sttBefore = s.voice.stt.length;
      const movId = file(Buffer.from('moov'), 'mov');
      const u2 = s.fake.push(s.fake.builder.video(OWNER, { fileId: movId, duration: 5, mimeType: 'video/quicktime', fileName: 'IMG_0043.MOV' }))[0]!;
      const seq2 = await admitted(u2);
      await waitRecorded(s, gw, u2);
      assert.equal((await answer(u2)).text, 'Видео не в mp4 — звук не распознаю');
      const n2 = await ch.waitEvent(seq2, 15_000);
      assert.deepEqual({ audio: n2.audio, transcript: n2.transcript, media: n2.media }, { audio: undefined, transcript: null, media: { what: 'video', frame: false } });
      assert.equal(s.voice.stt.length, sttBefore, 'провайдеру не ушло');
      assert.equal(s.fake.callsOf('getFile').filter((c) => c.params.file_id === movId).length, 0, '.mov не скачивается');
      await ch.done([seq, seq2]);
      await pump(gw, () => reactionsOf(s.fake, u2).at(-1) === '👌' || null, { what: '👌 на .mov' });
      assert.equal(sttRepliesOf(s, u2).length, 1, 'ответ-отказ один');
    });

    it('A7.24 видео файлом (document video/quicktime и video/mp4) — обычный файл: 👀 → 👌, ответа шлюза нет, не скачивается (R-22); видео без mime и имени — пробуем как mp4 ⟨предл.⟩', async () => {
      const sttBefore = s.voice.stt.length;
      const movDoc = `${dialect}movdoc`;
      const mp4Doc = `${dialect}mp4doc`;
      const docs = [
        s.fake.push(s.fake.builder.document(OWNER, { fileId: movDoc, fileName: 'IMG_0044.MOV', mimeType: 'video/quicktime', fileSize: 9_000_000 }, null))[0]!,
        s.fake.push(s.fake.builder.document(OWNER, { fileId: mp4Doc, fileName: 'clip.mp4', mimeType: 'video/mp4', fileSize: 4_000_000 }, 'посмотри'))[0]!,
      ];
      const seqs: number[] = [];
      for (const u of docs) {
        const seq = await admitted(u);
        seqs.push(seq);
        await waitRecorded(s, gw, u);
        const n = await ch.waitEvent(seq, 15_000);
        assert.deepEqual(
          { kind: n.kind, audio: n.audio, transcript: n.transcript, media: n.media, attachments: n.attachments },
          { kind: 'document', audio: undefined, transcript: null, media: undefined, attachments: [{ kind: 'document', trust: 'untrusted' }] },
        );
        assert.equal(ev(seq).raw_ref, null, 'видео файлом не скачивается');
      }
      await ch.done(seqs);
      for (const u of docs) {
        await pump(gw, () => reactionsOf(s.fake, u).at(-1) === '👌' || null, { what: '👌 на видео файлом' });
        assert.deepEqual(sttRepliesOf(s, u), [], 'ответа шлюза на видео файлом нет');
      }
      assert.equal(s.voice.stt.length, sttBefore, 'провайдеру не ушло');
      assert.equal(s.fake.callsOf('getFile').filter((c) => c.params.file_id === movDoc || c.params.file_id === mp4Doc).length, 0, 'getFile не вызывался');
      // Видео без mime и имени (Bot API: оба поля необязательные) — не «не в mp4»: пробуем как mp4 ⟨предл.⟩.
      const bare = Buffer.from('\x00\x00\x00\x18ftypisom bare video '.repeat(30), 'latin1');
      const bareId = file(bare, 'mp4');
      const u3 = s.fake.push(s.fake.builder.video(OWNER, { fileId: bareId, duration: 12, mimeType: null, fileSize: bare.length }))[0]!;
      const seq3 = await admitted(u3);
      await waitRecorded(s, gw, u3);
      assert.equal(sttText(await answer(u3)), SAID);
      const req = s.voice.stt.at(-1)!;
      assert.deepEqual({ name: req.file?.filename, type: req.file?.type }, { name: `${u3.update_id}.mp4`, type: 'video/mp4' });
      const n3 = await ch.waitEvent(seq3, 15_000);
      assert.deepEqual({ transcript: n3.transcript, source: n3.audio?.source, name: n3.audio?.name }, { transcript: SAID, source: 'video', name: 'видео' });
      await ch.done([seq3]);
    });

    it('A7.20 свой пересланный кружок — «своё пересланное»: ответ-расшифровка тот же, расшифровка — материал, итог эпизода — «чужое»', async () => {
      const ep = await ch.episode('new', 'свой пересланный кружок');
      assert.ok(ep.type === 'ack', JSON.stringify(ep));
      const epId = (ep.result as { episode_id: number }).episode_id;
      const fileId = file(Buffer.from('ftypmp42 own forwarded note '.repeat(30)), 'mp4');
      const u = s.fake.push(s.fake.builder.videoNote(OWNER, { fileId, duration: 5 }, { forwardFrom: { type: 'user', user: OWNER } }))[0]!;
      const seq = await admitted(u);
      assert.equal(sttText(await answer(u)), SAID);
      const n = await ch.waitEvent(seq, 15_000);
      assert.deepEqual(
        { trust: n.trust, mixed: n.mixed, attachments: n.attachments, transcript: n.transcript, source: n.audio?.source, forward: n.forward?.origin_type },
        { trust: 'owner_forward', mixed: false, attachments: [{ kind: 'document', trust: 'owner_forward' }], transcript: SAID, source: 'video_note', forward: 'user' },
      );
      assert.equal(readJournal(s.home).find((l) => l.ev === 'transcribed' && l.seq === seq)?.label, 'owner_forward');
      const sum = await ch.episodeSummary(epId, 'итог по своему пересланному кружку');
      assert.ok(sum.type === 'ack');
      assert.equal((sum.result as { summary_trust: string }).summary_trust, 'untrusted');
      await ch.done([seq]);
    });

    it('A7.21 кружок больше 20 МБ — ответом «слишком большой для бота», не скачивается; длиннее предела — «не распознаю, кружок сохранён», провайдеру не уходит', async () => {
      const bigId = file(Buffer.from('ftypmp42 too big note'), 'mp4');
      const u1 = s.fake.push(s.fake.builder.videoNote(OWNER, { fileId: bigId, duration: 50, fileSize: 21 * 1024 * 1024 }))[0]!;
      const seq1 = await admitted(u1);
      assert.equal((await answer(u1)).text, 'Слишком большой для бота (больше 20 МБ) — скачать не могу');
      const n1 = await ch.waitEvent(seq1, 15_000);
      assert.deepEqual({ transcript: n1.transcript, state: n1.audio?.state, source: n1.audio?.source }, { transcript: null, state: 'too_big', source: 'video_note' });
      assert.equal(s.fake.callsOf('getFile').filter((c) => c.params.file_id === bigId).length, 0, 'больше 20 МБ — не скачивается');
      const sttBefore = s.voice.stt.length;
      const longId = file(Buffer.from('ftypmp42 too long note '.repeat(20)), 'mp4');
      const u2 = s.fake.push(s.fake.builder.videoNote(OWNER, { fileId: longId, duration: 16 * 60 }))[0]!;
      const seq2 = await admitted(u2);
      assert.equal((await answer(u2)).text, 'Длиннее 15 минут — не распознаю, кружок сохранён');
      const n2 = await ch.waitEvent(seq2, 15_000);
      assert.deepEqual({ transcript: n2.transcript, state: n2.audio?.state }, { transcript: null, state: 'too_long' });
      await waitUntil(() => ev(seq2).raw_ref, 10_000, 'звук сохранён');
      assert.equal(s.voice.stt.length, sttBefore, 'провайдеру не ушло');
      await ch.done([seq1, seq2]);
    });

    it('A7.11 отказ распознавания кружка — ответом «Не смог распознать — кружок сохранён. Срочное — текстом»; агенту — «не распознан»', async () => {
      s.voice.sttScript = ['error', 'error', 'error'];
      try {
        const fileId = file(Buffer.from('ftypmp42 failing note '.repeat(20)), 'mp4');
        const u = s.fake.push(s.fake.builder.videoNote(OWNER, { fileId, duration: 12 }))[0]!;
        const seq = await admitted(u);
        assert.equal((await answer(u)).text, 'Не смог распознать — кружок сохранён. Срочное — текстом');
        const n = await ch.waitEvent(seq, 15_000);
        assert.deepEqual({ trust: n.trust, transcript: n.transcript, state: n.audio?.state, source: n.audio?.source }, { trust: 'owner', transcript: null, state: 'failed', source: 'video_note' });
        assert.ok(readJournal(s.home).some((l) => l.ev === 'stt_failed' && l.seq === seq));
        assert.ok(ev(seq).raw_ref, 'звук сохранён');
        await ch.done([seq]);
      } finally {
        s.voice.sttScript = [];
      }
    });
  });
}
