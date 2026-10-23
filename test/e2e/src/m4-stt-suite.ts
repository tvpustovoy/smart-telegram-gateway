// M4 · голос внутрь (Ш-7, Ш-11, Ш-26; TECH-SPEC 5.5, 5.8) на поддельных Telegram, провайдере голоса и переходнике.
// Сценарии общие для провайдеров (OpenAI-совместимый и ElevenLabs): их запускают m4-stt-openai.test.ts и
// m4-stt-elevenlabs.test.ts — файлы идут параллельно.
// 0.3.1 (P-19; образец — бот Voice Messages): A4.1 распознанное голосовое — ответом на него
// расшифровка целиком, только текст (без номера, кавычек и «→ ответил»); пока распознаётся — строки нет и на голосовом
// ничего (0.3.2: ✍ нет);
// звук в raw/, расшифровка в events.transcript, запрос с языком и словарём; агент увидел — 👀, ответ агента его снимает
// (0.3.6, #52), расшифровка не
// правится; A4.10 длинная — несколькими сообщениями подряд, все ответом на то же голосовое, без меток (i/N); [расшифровка]
// на квитанции прежней версии — та же расшифровка ответом, агенту ничего, чужое нажатие — отказ; A4.2 ошибка провайдера —
// ответом «Не смог распознать — звук сохранён. Срочное — текстом», событие «не распознано»; A4.3 закрытая тема и
// слово-метка — мимо провайдера, реакций нет, ответа нет; A4.9 голосовое и сразу текст — агенту по порядку.
// Исправления по проверке 0.3.1: пересланное (чужое) голосовое — владельцу ответом расшифровка так же, только текст;
// агенту — голосовое с расшифровкой, меткой «чужое» и пересылкой; голосовое в «стоп» — ответ с расшифровкой уходит
// (строка шлюза), реакций нет и агенту не уходит, пока владелец не скажет «продолжить». 0.3.4 (R-23 а,
// #44): расшифровка — цитатой (<blockquote>; длиннее 4 строк — свёрнутой), знаки HTML экранированы; начатая с 💬 или
// ↪ — без ⚙ (цитата сама отличает её от ответа агента); Telegram не разобрал разметку — та же часть простым текстом, и
// тогда с ⚙ (Ш-23); отказы — простым текстом, как раньше.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeOggOpus } from 'stg-fake-elevenlabs';
import { errors, privateChatOf } from 'stg-fake-telegram';
import type { FakeChannel } from 'stg-fake-channel';
import { STOPPED_TEXT, type Update } from 'stg-core';
import { connectAdapter, count, meta, pump, q1, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OTHER, OWNER, STRANGER, reactionsOf, receiptCleared, waitRecorded } from './m1-common.js';
import { DIALECT, currentButtons, currentText, isQuote, pressCurrent, pushVoice, replyTo, sttRepliesOf, sttText, voiceSetup, waitSttReply, type VoiceDialect, type VoiceSetup } from './m4-common.js';

const CLOSED_TOPIC = 77;
const RULES = `subjects:
  - id: owner
    who: owner
    transports: [{ network: telegram, address: "${OWNER.id}" }]
  - id: anya
    who: subject
    transports: [{ network: telegram, address: "${OTHER.id}" }]
chats:
  - chat: private
    space: личное
    role: личный ассистент
`;
const FULL = 'завтра первым делом позвонить юристу и потом в банк насчёт счёта, а вечером спортзал';

export function sttSuite(dialect: VoiceDialect): void {
  describe(`M4 · распознавание голосовых · ${dialect}`, () => {
    let s: VoiceSetup;
    let gw: GatewayProcess;
    let ch: FakeChannel;
    let turn: number;
    const seqOf = (u: Update): number | undefined => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
    const admitted = (u: Update): Promise<number> => waitUntil(() => seqOf(u), 5000, `приёма ${u.update_id}`);
    const episodeOf = (seq: number): number => q1<{ episode_id: number }>(s.home, 'SELECT episode_id FROM events WHERE seq = ?', seq)!.episode_id;

    before(async () => {
      s = await voiceSetup({ dialect, fake: { transcript: FULL }, rules: RULES, extraConfig: `closed_topics: [${CLOSED_TOPIC}]\nclosed_marker: тайна\n` });
      gw = await s.start();
      ({ ch, turn } = await connectAdapter(s.home));
    });
    after(async () => {
      ch?.close();
      if (gw?.alive) await gw.stop();
      await s.close();
    });

    let first: { u: Update; seq: number } | null = null;

    it('A4.1: распознанное голосовое — ответом на него расшифровка целиком, цитатой (0.3.4, R-23 а); пока распознаётся — строки нет, на голосовом ничего (0.3.2); звук в raw/, расшифровка в events.transcript; язык и словарь — в запросе', async () => {
      const u = pushVoice(s, 20);
      const seq = await admitted(u);
      first = { u, seq };
      // На самом голосовом ничего, пока агент не увидел (0.3.2: ✍ нет); 👀 — когда увидел (ниже).
      await waitRecorded(s, gw, u);
      const [r, ...more] = await waitSttReply(s, gw, u);
      assert.equal(more.length, 0, 'одно сообщение');
      assert.equal(r!.text, `<blockquote>${FULL}</blockquote>`, 'цитатой (R-23 а): только текст расшифровки — без номера, кавычек и вводных');
      assert.equal(r!.parse_mode, 'HTML');
      assert.equal(sttText(r!), FULL, 'владелец видит расшифровку целиком');
      assert.deepEqual(r!.reply_parameters, replyTo(u), 'ответом на само голосовое');
      assert.equal(r!.reply_markup, null, 'кнопок под расшифровкой нет — место оставлено');
      assert.equal(r!.edits.length, 0, 'не правится');
      // Ни «распознаю…», ни «№ N голосовое …» — пока распознаётся, строки нет (только реакции).
      assert.ok(!s.fake.sentTo(OWNER.id).some((m) => /^№ \d|распознаю/.test(m.text ?? '')), 'строки «распознаю…» нет');
      assert.deepEqual(reactionsOf(s.fake, u), [], 'агент ещё не видел — ничего');
      // Ответ на голосовое — сообщение события: реплай владельца на него — к этому событию (5.5а). Отметка — после ответа
      // Telegram: дождаться её.
      await waitUntil(() => q1<{ tg_message_id: number }>(s.home, 'SELECT tg_message_id FROM receipts WHERE event_seq = ?', seq)?.tg_message_id === r!.message_id || null, 5000, 'отметки receipts');
      const ev = q1<{ raw_ref: string; transcript: string; status: string; trust: string }>(s.home, 'SELECT raw_ref, transcript, status, trust FROM events WHERE seq = ?', seq)!;
      assert.match(ev.raw_ref, new RegExp(`^raw/\\d{4}-\\d{2}-\\d{2}/${u.update_id}\\.oga$`));
      assert.deepEqual(fs.readFileSync(path.join(s.home.dir, ev.raw_ref)), makeOggOpus(20), 'звук в raw/ целиком');
      assert.equal(ev.transcript, FULL);
      const req = s.voice.stt.at(-1)!;
      assert.deepEqual(
        { model: req.model, language: req.language, vocabulary: req.vocabulary, bytes: req.file?.bytes, name: req.file?.filename, ...DIALECT[dialect].sttExtra(req) },
        {
          model: DIALECT[dialect].sttModel,
          language: 'ru',
          vocabulary: ['Acme', 'Борис', 'Kubernetes'],
          bytes: makeOggOpus(20).length,
          name: `${u.update_id}.ogg`,
          ...DIALECT[dialect].sttExtraExpected,
        },
      );
      assert.ok(s.voice.calls.length > 0 && s.voice.calls.every((c) => c.authorized), 'ключ — как положено провайдеру');
      const j = readJournal(s.home).find((l) => l.ev === 'transcribed' && l.seq === seq);
      assert.equal(j?.text, FULL, 'расшифровка в журнале дословно (Ш-16)');
      assert.equal(j?.label, 'owner');
      // Длительность, слова и токены ответа (подделка OpenAI отдаёт usage.output_tokens; ElevenLabs — нет): по ним видна
      // обрезанная длинная надиктовка.
      assert.deepEqual(
        [j?.seconds, j?.words, j?.output_tokens],
        [20, FULL.split(' ').length, dialect === 'openai' ? FULL.length : undefined],
      );
      const e = await ch.waitEvent(seq);
      assert.deepEqual({ kind: e.kind, transcript: e.transcript, trust: e.trust }, { kind: 'voice', transcript: FULL, trust: 'owner' }, 'агенту — как прежде');
    });

    it('5.5: агент увидел — 👀, ответил — 👀 снят (0.3.6, #52); расшифровка не правится, «→ ответил» нет', async () => {
      const { u, seq } = first!;
      await ch.delivered(seq);
      await pump(gw, () => reactionsOf(s.fake, u).at(-1) === '👀' || null, { what: '👀' });
      const a = await ch.reply(seq, 'Записал на завтра', turn);
      assert.ok(a.type === 'ack' && a.result === 'queued', JSON.stringify(a));
      await pump(gw, () => (receiptCleared(s.fake, u) && s.fake.sentTo(OWNER.id).some((m) => m.text === 'Записал на завтра')) || null, { what: 'снятия 👀 и ответа агента' });
      assert.deepEqual(reactionsOf(s.fake, u), ['👀', '']);
      for (let i = 0; i < 3; i++) await gw.advance('1s');
      const [r] = sttRepliesOf(s, u);
      assert.equal(r!.edits.length, 0, 'расшифровка не правится');
      assert.ok(!s.fake.sentTo(OWNER.id).some((m) => currentText(m).includes('→ ответил')), '«→ ответил» нет');
      assert.equal(sttRepliesOf(s, u).length, 1);
    });

    it('A4.10: длинная расшифровка — несколькими цитатами подряд (свёрнутыми, 0.3.4), все ответом на то же голосовое, без меток (i/N) и номера', async () => {
      const before = ch.events().length;
      const long = Array.from({ length: 700 }, (_, i) => `слово${i}`).join(' ');
      s.voice.transcript = long;
      try {
        const u2 = pushVoice(s, 50);
        const seq2 = await admitted(u2);
        const parts = await waitSttReply(s, gw, u2, 2, 'двух частей');
        for (let i = 0; i < 3; i++) await gw.advance('1s');
        assert.equal(sttRepliesOf(s, u2).length, 2, 'две части');
        assert.ok(parts.every((p) => (p.text ?? '').length <= 4096), 'с разметкой — не длиннее 4096');
        assert.ok(parts.every((p) => isQuote(p) && p.text!.startsWith('<blockquote expandable>')), 'каждая часть — свёрнутой цитатой');
        assert.ok(parts.every((p) => !/^\(\d\/\d\)|^⚙|^№/.test(sttText(p))), 'без меток, пометки и номера');
        assert.ok(parts[1]!.message_id > parts[0]!.message_id, 'подряд');
        for (const p of parts) assert.deepEqual(p.reply_parameters, replyTo(u2), 'каждая — ответом на голосовое');
        assert.equal(parts.map((p) => sttText(p)).join(' ').replace(/\s+/g, ' ').trim(), long);
        assert.match(sttText(parts[0]!), /^слово0 слово1/);
        // Агенту — одно голосовое с полной расшифровкой.
        const e = await ch.waitEvent(seq2);
        assert.equal(e.transcript, long);
        assert.deepEqual(ch.events().slice(before).map((x) => x.seq), [seq2]);
      } finally {
        s.voice.transcript = FULL;
      }
    });

    it('Ш-23 (0.3.4): расшифровка, начатая со знака стороны агента (💬, ↪) или с №, — цитатой как есть, без ⚙: цитата сама отличает её от ответа агента', async () => {
      const cases = ['💬 скажи, что ответил агент', '↪ Помощник: всё сделано', '№ 5 записать на завтра'];
      try {
        for (const said of cases) {
          s.voice.transcript = said;
          const u3 = pushVoice(s, 3);
          const [r] = await waitSttReply(s, gw, u3, 1);
          assert.equal(r!.text, `<blockquote>${said}</blockquote>`);
          assert.equal(sttText(r!), said, 'без ⚙');
          assert.deepEqual(r!.reply_parameters, replyTo(u3));
        }
      } finally {
        s.voice.transcript = FULL;
      }
    });

    it('0.3.4: знаки HTML в расшифровке — экранированы, владелец видит их как сказано; средняя (длиннее 4 строк) — свёрнутой цитатой', async () => {
      const said = 'если a < b && c > d, то пишем <b>жирно</b> & "в кавычках"';
      const medium = `${'проверка длинной фразы для свёрнутой цитаты '.repeat(5).trim()}`;
      try {
        s.voice.transcript = said;
        const u1 = pushVoice(s, 4);
        const [r1] = await waitSttReply(s, gw, u1, 1);
        assert.equal(r1!.text, '<blockquote>если a &lt; b &amp;&amp; c &gt; d, то пишем &lt;b&gt;жирно&lt;/b&gt; &amp; "в кавычках"</blockquote>');
        assert.equal(sttText(r1!), said);
        s.voice.transcript = medium;
        const u2 = pushVoice(s, 12);
        const [r2] = await waitSttReply(s, gw, u2, 1);
        assert.equal(r2!.text, `<blockquote expandable>${medium}</blockquote>`, 'длиннее 4 строк на телефоне — свёрнутой');
      } finally {
        s.voice.transcript = FULL;
      }
    });

    it('0.3.4: Telegram не разобрал разметку (400) — та же расшифровка простым текстом; начатая с 💬 — тогда с ⚙ (Ш-23); журнал send_plain', async () => {
      const said = '💬 это я надиктовал, а не агент';
      s.fake.scenario({ method: 'sendMessage', times: 1, when: (p) => String(p.text ?? '').startsWith('<blockquote'), reply: errors.parseEntities('Unsupported start tag "blockquote" at byte offset 0') });
      try {
        s.voice.transcript = said;
        const u = pushVoice(s, 3);
        const [r] = await waitSttReply(s, gw, u, 1, 'расшифровки без разметки');
        assert.equal(r!.parse_mode, null, 'простым текстом');
        assert.equal(r!.text, `⚙ ${said}`, 'без цитаты — с пометкой ⚙ (Ш-23)');
        assert.deepEqual(r!.reply_parameters, replyTo(u));
        assert.ok(readJournal(s.home).some((l) => l.ev === 'send_plain'));
      } finally {
        s.fake.clearScenario();
        s.voice.transcript = FULL;
      }
    });

    it('0.3.4 (по проверке): длинная расшифровка, 400 разбора на каждой части — все части простым текстом, каждая ответом на голосовое и ≤ 4096; ⚙ — только у части, начатой с 💬; текст целиком', async () => {
      const long = `💬 ${Array.from({ length: 700 }, (_, i) => `слово${i}`).join(' ')}`;
      const plainBefore = readJournal(s.home).filter((l) => l.ev === 'send_plain').length;
      s.fake.scenario({ method: 'sendMessage', times: 2, when: (p) => String(p.text ?? '').startsWith('<blockquote'), reply: errors.parseEntities('Unsupported start tag "blockquote" at byte offset 0') });
      try {
        s.voice.transcript = long;
        const u = pushVoice(s, 50);
        const parts = await waitSttReply(s, gw, u, 2, 'двух частей без разметки');
        for (let i = 0; i < 3; i++) await gw.advance('1s');
        assert.equal(sttRepliesOf(s, u).length, 2, 'две части — ни одна не потерялась и не ушла дважды');
        for (const p of parts) {
          assert.equal(p.parse_mode, null, 'простым текстом');
          assert.ok((p.text ?? '').length <= 4096, `часть ${(p.text ?? '').length}`);
          assert.deepEqual(p.reply_parameters, replyTo(u), 'каждая — ответом на голосовое');
        }
        assert.ok(parts[0]!.text!.startsWith('⚙ 💬 слово0'), 'первая начата с 💬 — с ⚙ (Ш-23)');
        assert.ok(!parts[1]!.text!.startsWith('⚙'), 'вторая начата со слова — без ⚙');
        assert.equal(parts.map((p) => p.text).join(' ').replace(/^⚙ /, '').replace(/\s+/g, ' ').trim(), long, 'текст целиком');
        assert.equal(readJournal(s.home).filter((l) => l.ev === 'send_plain').length - plainBefore, 2, 'send_plain — на каждой части');
      } finally {
        s.fake.clearScenario();
        s.voice.transcript = FULL;
      }
    });

    it('A4.2: провайдер отвечает ошибкой — ответом «Не смог распознать — звук сохранён. Срочное — текстом», звук сохранён, событие отдано «не распознано»', async () => {
      s.voice.sttMode = 'error';
      const calls = s.voice.stt.length;
      try {
        const u = pushVoice(s, 7);
        const seq = await admitted(u);
        const [r] = await waitSttReply(s, gw, u, 1, 'ответа «не смог»');
        assert.equal(r!.text, 'Не смог распознать — звук сохранён. Срочное — текстом');
        assert.equal(r!.parse_mode, null, 'отказ — простым текстом, не цитатой (0.3.4)');
        assert.deepEqual(r!.reply_parameters, replyTo(u));
        assert.equal(r!.reply_markup, null, 'без кнопок');
        assert.equal(s.voice.stt.length - calls, 3, 'попытка и два повтора');
        const ev = q1<{ raw_ref: string; transcript: string | null }>(s.home, 'SELECT raw_ref, transcript FROM events WHERE seq = ?', seq)!;
        assert.ok(fs.existsSync(path.join(s.home.dir, ev.raw_ref)), 'звук сохранён');
        assert.equal(ev.transcript, null);
        const e = await ch.waitEvent(seq);
        assert.deepEqual({ kind: e.kind, transcript: e.transcript }, { kind: 'voice', transcript: null }, 'отдано с пометкой «не распознано»');
        const j = readJournal(s.home).find((l) => l.ev === 'stt_failed' && l.seq === seq);
        assert.deepEqual({ reason: j?.reason, attempts: j?.attempts }, { reason: s.voice.codes.server, attempts: 3 });
        assert.equal(sttRepliesOf(s, u).length, 1, 'одно сообщение');
      } finally {
        s.voice.sttMode = 'ok';
      }
    });

    it('A4.3: голосовое в закрытой теме и со словом-меткой в подписи — провайдеру 0 вызовов; в журнале только №, дата, длительность', async () => {
      const calls = s.voice.stt.length;
      const u1 = pushVoice(s, 4, { thread: { id: CLOSED_TOPIC, isTopic: true } });
      const u2 = pushVoice(s, 5, { caption: 'тайна: про это не надо' });
      const seq1 = await admitted(u1);
      const seq2 = await admitted(u2);
      for (const seq of [seq1, seq2]) {
        const ev = q1<{ kind: string; status: string; text: string | null; transcript: string | null }>(s.home, 'SELECT kind, status, text, transcript FROM events WHERE seq = ?', seq)!;
        assert.deepEqual({ ...ev }, { kind: 'closed_topic', status: 'closed_topic', text: null, transcript: null });
        const lines = readJournal(s.home).filter((l) => l.seq === seq);
        assert.ok(lines.length >= 1);
        for (const l of lines.filter((x) => x.ev === 'in')) assert.deepEqual(Object.keys(l).sort(), ['at', 'date', 'duration', 'ev', 'kind', 'seq']);
      }
      assert.ok(fs.readdirSync(s.home.paths.rawClosed, { recursive: true }).some((f) => String(f).endsWith(`/${u1.update_id}.oga`)), 'звук — в raw/closed/');
      // Дать распознавателю время: вызовов всё равно нет.
      for (let i = 0; i < 5; i++) {
        await gw.advance('1s');
        await sleep(20);
      }
      assert.equal(s.voice.stt.length, calls, 'провайдеру — ни одного вызова');
      assert.ok(!readJournal(s.home).some((l) => l.ev === 'transcribed' && (l.seq === seq1 || l.seq === seq2)));
      assert.ok(!ch.events().some((e) => e.seq === seq1 || e.seq === seq2), 'агенту — ничего (П-3)');
      // Записано; агент не увидит — реакций нет (0.3.2: ✍ нет); ответа-расшифровки нет.
      await waitRecorded(s, gw, [u1, u2]);
      assert.deepEqual([reactionsOf(s.fake, u1), reactionsOf(s.fake, u2)], [[], []]);
      assert.deepEqual([sttRepliesOf(s, u1).length, sttRepliesOf(s, u2).length], [0, 0]);
    });

    it('A4.9: голосовое № N и сразу текст № N+1 — агенту по порядку: голосовое (после расшифровки), затем текст; запись текста не ждёт', async () => {
      s.voice.latencyMs = 3000;
      try {
        const v = pushVoice(s, 9);
        const t = s.fake.push(s.fake.builder.text(OWNER, 'и ещё текстом'))[0]!;
        const sv = await admitted(v);
        const st = await admitted(t);
        assert.equal(st, sv + 1);
        // Текст записан, пока голосовое ещё распознаётся.
        await waitRecorded(s, gw, [v, t], 'записи текста');
        assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', sv)?.status, 'transcribing');
        assert.ok(!ch.events().some((e) => e.seq === st), 'текст не обогнал голосовое');
        const ev = await ch.waitEvent(st, 15_000);
        const order = ch.events().map((e) => e.seq).filter((x) => x === sv || x === st);
        assert.deepEqual(order, [sv, st]);
        assert.equal(ch.events().find((e) => e.seq === sv)?.transcript, FULL, 'голосовое — уже с расшифровкой');
        assert.equal(ev.kind, 'text');
      } finally {
        s.voice.latencyMs = 0;
      }
    });

    it('правка сообщений бота (хвост M2): после нажатия [продолжить] кнопки снимаются; повторное нажатие — «уже использовано»', async () => {
      s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
      const line = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text === STOPPED_TEXT), { what: 'строки «Остановлен»' });
      assert.deepEqual(currentButtons(line).map((b) => b.text), ['продолжить']);
      const token = currentButtons(line)[0]!.data;
      assert.equal(await pressCurrent(s, line, 'продолжить'), null);
      // Строка правится в одну строку без кнопок (J-4): правка текста заменяет снятие кнопок.
      await pump(gw, () => (line.edits.length && currentButtons(line).length === 0) || null, { what: 'снятия кнопок' });
      assert.match(currentText(line), /^⚙ Стоп снят/);
      assert.ok(s.fake.callsOf('editMessageText').some((c) => Number(c.params.message_id) === line.message_id && c.params.reply_markup === undefined));
      const [again] = s.fake.push(s.fake.builder.callback(OWNER, token, line.message));
      const a = await waitUntil(() => s.fake.callbackAnswers.find((x) => x.callback_query_id === again!.callback_query!.id), 5000, 'ответа');
      assert.equal(a.text, 'уже использовано');
    });

    it('пересланное (чужое) голосовое — владельцу ответом на него расшифровка, только текст, реакций до 👀 нет; агенту — голосовое с расшифровкой, «чужое», с пересылкой', async () => {
      s.voice.transcript = 'чужие слова из пересланного';
      try {
        const u = pushVoice(s, 6, { forwardFrom: { type: 'user', user: OTHER } });
        const seq = await admitted(u);
        await waitRecorded(s, gw, u);
        const [r, ...more] = await waitSttReply(s, gw, u);
        assert.equal(more.length, 0);
        assert.equal(sttText(r!), 'чужие слова из пересланного', 'как у своего: только текст, без пометки «чужое»');
        assert.ok(isQuote(r!), 'цитатой');
        assert.deepEqual(r!.reply_parameters, replyTo(u), 'ответом на пересланное');
        const e = await ch.waitEvent(seq);
        assert.deepEqual(
          { kind: e.kind, transcript: e.transcript, trust: e.trust, forward: e.forward?.origin_type },
          { kind: 'voice', transcript: 'чужие слова из пересланного', trust: 'untrusted', forward: 'user' },
          'агенту — как прежде: расшифровка в событии, чужое помечено',
        );
        assert.deepEqual(reactionsOf(s.fake, u), [], 'агент ещё не отметил delivered — ничего');
      } finally {
        s.voice.transcript = FULL;
      }
    });

    it('голосовое в «стоп» — ответ с расшифровкой уходит (строка шлюза), реакций нет, агенту не уходит; [продолжить] — отдано', async () => {
      const stops = s.fake.sentTo(OWNER.id).filter((m) => m.text === STOPPED_TEXT).length;
      s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
      await waitUntil(() => meta(s.home, 'mode') === 'stopped' || null, 5000, 'режима «стоп»');
      const line = await pump(gw, () => s.fake.sentTo(OWNER.id).filter((m) => m.text === STOPPED_TEXT)[stops], { what: 'строки «Остановлен»' });
      const before = ch.events().length;
      const u = pushVoice(s, 5);
      const seq = await admitted(u);
      const [r] = await waitSttReply(s, gw, u);
      assert.equal(sttText(r!), FULL);
      assert.deepEqual(r!.reply_parameters, replyTo(u));
      for (let i = 0; i < 3; i++) await gw.advance('1s');
      await sleep(30);
      assert.deepEqual(reactionsOf(s.fake, u), [], 'агент не видел — ничего');
      assert.ok(!ch.events().slice(before).some((e) => e.seq === seq), 'в «стоп» агенту не уходит');
      assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status, 'new');
      // «Стоп» снимается только кнопкой [продолжить] под строкой «Остановлен».
      assert.equal(await pressCurrent(s, line, 'продолжить'), null);
      await waitUntil(() => meta(s.home, 'mode') === 'running' || null, 5000, 'снятия стопа');
      const e = await ch.waitEvent(seq, 15_000);
      assert.equal(e.transcript, FULL, 'после [продолжить] — голосовое с расшифровкой');
      assert.equal(sttRepliesOf(s, u).length, 1, 'ответ с расшифровкой — один');
    });
  });

  describe(`M4 · [расшифровка] на квитанции прежней версии (до 0.3.1) · ${dialect}`, () => {
    let s: VoiceSetup;
    let gw: GatewayProcess;
    let ch: FakeChannel;

    before(async () => {
      s = await voiceSetup({ dialect, fake: { transcript: FULL }, rules: RULES });
      gw = await s.start();
      ({ ch } = await connectAdapter(s.home));
    });
    after(async () => {
      ch?.close();
      if (gw?.alive) await gw.stop();
      await s.close();
    });

    it('A4.10: нажатие — та же расшифровка ответом на голосовое (только текст), многоразово; агенту ничего; не владельцу — отказ; расшифровки нет — «истёк срок»', async () => {
      const u = pushVoice(s, 20);
      const seq = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
      const [r] = await waitSttReply(s, gw, u);
      await ch.waitEvent(seq);
      const before = ch.events().length;
      // Кнопка, оставшаяся в чате от прежней версии (квитанция «№ N голосовое … записал: «…»» с [расшифровка]).
      const db = new DatabaseSync(s.home.paths.db);
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        const ins = db.prepare("INSERT INTO buttons(token, kind, payload_json, created_at, expires_at) VALUES (?, 'transcript', ?, 0, ?)");
        ins.run('legacy-transcript', JSON.stringify({ group: 'g-legacy', event_seq: seq }), Number.MAX_SAFE_INTEGER);
        ins.run('legacy-gone', JSON.stringify({ group: 'g-gone', event_seq: 999_999 }), Number.MAX_SAFE_INTEGER);
      } finally {
        db.close();
      }
      const old = { ...r!.message, text: `№ ${seq} голосовое 0:20 записал: «завтра первым делом позвонить юристу и потом в…»` };
      const press = async (token: string, from = OWNER, message = old): Promise<string | null> => {
        const [cb] = s.fake.push(s.fake.builder.callback(from, token, message));
        const a = await waitUntil(() => s.fake.callbackAnswers.find((x) => x.callback_query_id === cb!.callback_query!.id), 10_000, 'ответа на нажатие');
        return a.text;
      };
      assert.equal(await press('legacy-transcript'), null, 'нажатие засчитано — ответ без текста');
      const two = await waitSttReply(s, gw, u, 2, 'расшифровки по кнопке');
      assert.equal(two[1]!.text, `<blockquote>${FULL}</blockquote>`, 'как теперь приходит сама: цитатой (0.3.4)');
      assert.deepEqual(two[1]!.reply_parameters, replyTo(u));
      // Многоразовая.
      assert.equal(await press('legacy-transcript'), null);
      await waitSttReply(s, gw, u, 3, 'второй расшифровки по кнопке');
      // Не владелец: субъект из правил — «не ваша кнопка»; незнакомому — молчание (Ш-3). Расшифровка не уходит.
      const n = sttRepliesOf(s, u).length;
      assert.equal(await press('legacy-transcript', OTHER, { ...old, chat: privateChatOf(OTHER) }), 'не ваша кнопка');
      const [cs] = s.fake.push(s.fake.builder.callback(STRANGER, 'legacy-transcript', old));
      await waitUntil(() => q1<{ status: string }>(s.home, 'SELECT status FROM updates WHERE update_id = ?', cs!.update_id)?.status === 'ignored' || null, 5000, 'ignored');
      for (let i = 0; i < 5; i++) {
        await gw.advance('1s');
        await sleep(20);
      }
      assert.equal(s.fake.callbackAnswers.some((x) => x.callback_query_id === cs!.callback_query!.id), false, 'незнакомому — молчание');
      assert.equal(sttRepliesOf(s, u).length, n, 'расшифровка не ушла');
      // Расшифровки нет (событие удалено сроком хранения) — «истёк срок».
      assert.equal(await press('legacy-gone'), 'истёк срок');
      // Агенту нажатия не уходят.
      assert.deepEqual(ch.events().slice(before), []);
      assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'callback' AND status <> 'handled'"), 0);
    });
  });
}
