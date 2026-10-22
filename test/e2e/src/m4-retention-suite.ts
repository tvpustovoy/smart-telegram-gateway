// A4.5 · хранение и чистка (TECH-SPEC 5.8) на поддельных часах: раз в сутки; звук владельца — через 30 дней (расшифровка
// остаётся); чужое — через 90 дней из raw/, базы и logs/ (остаются №, дата, метка; в файле базы удалённого текста нет);
// у смешанного — ссылки на чужое; raw/closed/ — через 30 дней; журнал — через 90 дней целиком. Отдельно — строки о чужом
// в журнале, который ещё хранится (срок чужого короче срока журнала), — без текста.
// Сценарии общие для провайдеров голоса: их запускают m4-retention-openai.test.ts и m4-retention-elevenlabs.test.ts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { Update } from 'stg-core';
import { filesContaining, pump, q1, readJournal, waitUntil, type GatewayProcess } from './harness.js';
import { OTHER, OWNER } from './m1-common.js';
import { pushVoice, sttText, voiceSetup, waitSttReply, type VoiceDialect, type VoiceSetup } from './m4-common.js';

const CLOSED_TOPIC = 77;

interface Ev {
  seq: number;
  trust: string;
  text: string | null;
  transcript: string | null;
  attachments_json: string | null;
  forward_json: string | null;
  raw_ref: string | null;
  created_at: number;
}

export function retentionSuite(dialect: VoiceDialect): void {
  describe(`A4.5 · хранение и чистка · ${dialect}`, () => {
    let s: VoiceSetup;
    let gw: GatewayProcess;
    after(async () => {
      if (gw?.alive) await gw.stop();
      await s?.close();
    });
    const ev = (seq: number): Ev => q1<Ev>(s.home, 'SELECT * FROM events WHERE seq = ?', seq)!;
    const seqOf = (u: Update): Promise<number> =>
      waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, `приёма ${u.update_id}`);
    const retentions = (): Array<Record<string, unknown>> => readJournal(s.home).filter((l) => l.ev === 'retention');
    const exists = (rel: string | null): boolean => rel !== null && fs.existsSync(path.join(s.home.dir, rel));

    it('звук владельца — через 30 дней (расшифровка осталась); чужое — через 90 дней из raw/, базы и logs/', async () => {
      const said = ['моё голосовое про завтра', 'чужой секрет звонка'];
      let k = 0;
      s = await voiceSetup({ dialect, fake: { transcript: () => said[k++] ?? 'ещё' }, extraConfig: `closed_topics: [${CLOSED_TOPIC}]\n` });
      gw = await s.start();
      const b = s.fake.builder;
      const v1 = await seqOf(pushVoice(s, 5));
      await waitUntil(() => ev(v1).transcript, 5000, 'расшифровки своего');
      const u2 = pushVoice(s, 6, { forwardFrom: { type: 'user', user: OTHER } });
      const v2 = await seqOf(u2);
      await waitUntil(() => ev(v2).transcript, 5000, 'расшифровки чужого');
      const t1 = await seqOf(s.fake.push(b.text(OWNER, 'моя заметка остаётся'))[0]!);
      const f1 = await seqOf(s.fake.push(b.forward(OWNER, { type: 'user', user: OTHER }, 'чужой текст пересылки'))[0]!);
      const m1 = await seqOf(s.fake.push(b.quoteExternal(OWNER, 'моё слово к цитате', 'чужая цитата внутри', { type: 'user', user: OTHER }))[0]!);
      const c1u = pushVoice(s, 3, { thread: { id: CLOSED_TOPIC, isTopic: true } });
      await seqOf(c1u);
      // Расшифровка чужого голосового ушла ответом на него — строкой шлюза (в ней чужой текст, 0.3.1).
      const [r2] = await waitSttReply(s, gw, u2, 1, 'расшифровки чужого');
      assert.equal(sttText(r2!), 'чужой секрет звонка');
      await pump(gw, () => (q1<{ n: number }>(s.home, "SELECT (SELECT count(*) FROM outbox WHERE status = 'pending') + (SELECT count(*) FROM edits WHERE status = 'pending') AS n")?.n === 0) || null, {
        what: 'всей отправки',
      });
      const before = { v1: ev(v1), v2: ev(v2) };
      assert.ok(exists(before.v1.raw_ref) && exists(before.v2.raw_ref));
      const closedDir = fs.readdirSync(s.home.paths.rawClosed);
      assert.equal(closedDir.length, 1, 'raw/closed/<дата>/');
      const firstLog = path.join(s.home.paths.logs, `${closedDir[0]}.jsonl`);
      assert.ok(fs.readFileSync(firstLog, 'utf8').includes('чужой текст пересылки'), 'чужое в журнале дословно (Ш-16) — до срока');

      // 31 день: звук владельца и закрытая тема — удалены; чужое — ещё нет.
      const n0 = retentions().length;
      await gw.jump('31d');
      await waitUntil(() => retentions().length > n0 || null, 10_000, 'чистки через 31 день');
      const r31 = retentions().at(-1)!;
      assert.ok(Number(r31.ownerVoiceFiles) >= 1 && Number(r31.closedDirs) === 1, JSON.stringify(r31));
      assert.ok(!exists(before.v1.raw_ref), 'звук владельца удалён');
      assert.equal(ev(v1).raw_ref, null);
      assert.equal(ev(v1).transcript, 'моё голосовое про завтра', 'расшифровка осталась');
      assert.ok(exists(before.v2.raw_ref), 'чужой звук ещё хранится (90 дней)');
      assert.equal(ev(f1).text, 'чужой текст пересылки');
      assert.ok(!fs.existsSync(path.join(s.home.paths.rawClosed, closedDir[0]!)), 'raw/closed/<дата> — через 30 дней');
      // Раз в сутки: через час — ещё нет.
      await gw.jump('1h');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(retentions().length, n0 + 1, 'чистка — раз в сутки');

      // 91 день: чужое удалено из raw/, базы и logs/; остаются №, дата, метка.
      await gw.jump('60d');
      await waitUntil(() => retentions().some((l) => Number(l.untrustedEvents) >= 2) || null, 10_000, 'чистки чужого');
      for (const seq of [v2, f1]) {
        const e = ev(seq);
        assert.deepEqual(
          { trust: e.trust, text: e.text, transcript: e.transcript, attachments: e.attachments_json, forward: e.forward_json, raw: e.raw_ref },
          { trust: 'untrusted', text: null, transcript: null, attachments: null, forward: null, raw: null },
          `№ ${seq}`,
        );
        assert.ok(e.created_at > 0);
      }
      assert.ok(!exists(before.v2.raw_ref), 'чужой звук удалён');
      // Своё — на месте; у смешанного — ссылки на чужое сняты.
      assert.equal(ev(t1).text, 'моя заметка остаётся');
      assert.equal(ev(v1).transcript, 'моё голосовое про завтра');
      const mixed = ev(m1);
      assert.equal(mixed.text, 'моё слово к цитате');
      assert.ok(!(mixed.attachments_json ?? '').includes('чужая цитата'), mixed.attachments_json ?? '');
      assert.ok((mixed.attachments_json ?? '').includes('"quote"'), 'вид и метка вложения остались');
      // Строки шлюза о чужом — без текста.
      assert.equal(q1<{ n: number }>(s.home, "SELECT count(*) AS n FROM outbox WHERE event_seq IN (?, ?) AND origin = 'gateway' AND text IS NOT NULL", v2, f1)?.n, 0);
      // Журнал старше 90 дней — удалён целиком; чужого текста нет ни в logs/, ни в файлах базы.
      assert.ok(!fs.existsSync(firstLog), 'журнал первого дня удалён');
      for (const needle of ['чужой текст пересылки', 'чужой секрет звонка', 'чужая цитата внутри']) {
        assert.deepEqual(filesContaining(s.home.paths.logs, needle), [], `logs/: ${needle}`);
        const inDb = ['gateway.db', 'gateway.db-wal'].filter((f) => fs.existsSync(path.join(s.home.dir, f)) && fs.readFileSync(path.join(s.home.dir, f)).includes(Buffer.from(needle)));
        assert.deepEqual(inDb, [], `база: ${needle}`);
        assert.deepEqual(filesContaining(s.home.paths.raw, needle), [], `raw/: ${needle}`);
      }
      // Ответ-расшифровка чужого — тоже строка шлюза: её текст в базе стёрт (проверено выше); [расшифровка] со старой
      // квитанции после срока — «истёк срок» (m4-stt-suite).
    });
  });

  describe(`5.8 · журнал хранится дольше чужого · ${dialect}`, () => {
    let s: VoiceSetup;
    after(() => s?.close());

    it('чужое старше срока — строки журнала о нём без текста; свои строки и слова агента — как были', async () => {
      s = await voiceSetup({ dialect, extraConfig: 'retention: { untrusted_days: 2, logs_days: 90 }\n' });
      const gw = await s.start();
      try {
        const b = s.fake.builder;
        const u1 = s.fake.push(b.forward(OWNER, { type: 'user', user: OTHER }, 'чужая строка для журнала'))[0]!;
        const u2 = s.fake.push(b.text(OWNER, 'своя строка для журнала'))[0]!;
        await waitUntil(() => q1(s.home, 'SELECT 1 FROM events WHERE update_id = ?', u2.update_id), 5000, 'приёма');
        await pump(gw, () => q1<{ n: number }>(s.home, "SELECT count(*) AS n FROM outbox WHERE status = 'pending'")?.n === 0 || null, { what: 'квитанций' });
        const logs = (): string => fs.readdirSync(s.home.paths.logs).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(s.home.paths.logs, f), 'utf8')).join('');
        assert.ok(logs().includes('чужая строка для журнала'));
        await gw.jump('3d');
        await waitUntil(() => readJournal(s.home).some((l) => l.ev === 'retention' && Number(l.untrustedEvents) >= 1) || null, 10_000, 'чистки');
        assert.ok(!logs().includes('чужая строка для журнала'), 'чужого текста в журнале нет');
        assert.ok(logs().includes('своя строка для журнала'), 'своё осталось');
        assert.ok(readJournal(s.home).some((l) => l.scrubbed === true && l.label === 'untrusted'), 'строка осталась, без текста');
        void u1;
      } finally {
        await gw.stop();
      }
    });
  });
}
