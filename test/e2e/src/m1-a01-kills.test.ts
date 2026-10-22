// A1.1 (Ш-1, Оч-1) — 200 обновлений; 20 убийств: по разу в каждой точке сбоя, остальное — kill -9 в случайный момент
// (зерно записано); между убийствами ≥ 60 с поддельного времени. Ожидаемо: все 200 в events ровно по одному разу;
// offset = последний + 1; у каждого голосового — ответ с расшифровкой; второй — только после убийства посреди отправки.
// Точек семь: in_stt (M4) бьёт по голосовому вне закрытой темы — ответ распознавания получен, а не записан; после всего у
// каждого такого голосового есть расшифровка (распознаватель — поддельный ElevenLabs).
//
// Среди 200 — голосовые (каждое десятое) и сообщения закрытой темы: у текста нет файла содержимого, и точки
// before_files и after_files на нём ничем не отличались бы от in_handler. Эти две точки бьют по голосовому: цепочка
// «временный файл → fsync → переименование» проверяется под убийством — после всего у каждого голосового есть файл
// raw_ref, в raw/ нет брошенных временных файлов, звуковых файлов столько же, сколько голосовых.
//
// Квитанции (0.3.2, решение: ✍ не ставится; P-19): 👀 и 👌 — только когда агент увидел и ответил; агента
// здесь нет — реакций нет ни одной. У голосового вне закрытой темы — ответ с расшифровкой (с 0.3.4 — цитатой), ровно один записанный шлюзом
// (messages_out); текстовых квитанций «№ N» нет. Отправленное и отмеченное не уходит снова: каждая лишняя (неотмеченная)
// расшифровка пришла в окно убитого запуска, не больше одной на запуск; у запуска, убитого в in_send (точка бьёт по
// ответу с расшифровкой на голосовое), лишняя расшифровка на цели есть обязательно.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeOggOpus } from 'stg-fake-elevenlabs';
import { count, meta, pump, q, readJournal, shiftClockFile, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER } from './m1-common.js';
import { voiceSetup, type VoiceSetup } from './m4-common.js';

const POINTS = ['after_eyes', 'in_handler', 'before_files', 'after_files', 'after_commit', 'in_send', 'in_stt'] as const;
const FILE_POINTS = new Set<string>(['before_files', 'after_files']);
const TOTAL = 200;
const KILLS = 20;
const CLOSED_TOPIC = 77;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Run {
  slot: string;
  startedAt: number;
  endedAt: number;
  abrupt: boolean;
  /** update_id, по которому била точка сбоя. */
  target?: number;
}

/** Все файлы каталога (рекурсивно), пути относительно него. */
function listFiles(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

describe('A1.1 · 200 обновлений, 20 убийств', () => {
  let s: VoiceSetup;
  const ids: number[] = [];
  const voiceIds = new Set<number>();
  /** Голосовые вне закрытой темы — их распознают. */
  const sttIds = new Set<number>();
  const runs: Run[] = [];
  const seed = Number(process.env.STG_SEED ?? String(Date.now() % 1_000_000));

  before(async () => {
    s = await voiceSetup({ fake: { transcript: 'расшифровка голосового' }, extraConfig: `closed_topics: [${CLOSED_TOPIC}]\n` });
  });
  after(() => s.close());

  /** Подавать по 10 перед каждым убийством: иначе пачка в 100 принимается быстрее, чем убийство успевает. */
  function feed(n: number): void {
    const b = s.fake.builder;
    for (let k = 0; k < n && ids.length < TOTAL; k++) {
      const i = ids.length + 1;
      let u;
      if (i % 100 === 47) {
        // Голосовое в закрытой теме: звук — в raw/closed/.
        s.fake.addFile(makeOggOpus(2), { fileId: `a1c${i}`, path: `voice/a1c${i}.oga` });
        u = b.voice(OWNER, { duration: 2, fileId: `a1c${i}` }, { thread: { id: CLOSED_TOPIC, isTopic: true } });
        voiceIds.add(u.update_id);
      } else if (i % 10 === 5) {
        s.fake.addFile(makeOggOpus(2), { fileId: `a1v${i}`, path: `voice/a1v${i}.oga` });
        u = b.voice(OWNER, { duration: 2, fileId: `a1v${i}` });
        voiceIds.add(u.update_id);
        sttIds.add(u.update_id);
      } else if (i % 50 === 13) {
        u = b.text(OWNER, `закрытое ${i}`, { thread: { id: CLOSED_TOPIC, isTopic: true } });
      } else {
        u = b.text(OWNER, `мысль ${i}: ${'слово '.repeat(i % 7)}`);
      }
      ids.push(s.fake.push(u)[0]!.update_id);
    }
  }

  const admitted = (): number => count(s.home, "SELECT count(*) AS n FROM updates WHERE status = 'admitted'");

  /**
   * Ждать выхода, двигая часы: отправителю нужно время (точка in_send). Не вышел — в ошибке состояние цели и хвост
   * журнала (где встало), процесс остановить.
   */
  async function untilExit(g: GatewayProcess, what: string, target: number | null = null): Promise<{ code: number | null }> {
    const deadline = Date.now() + 30_000;
    while (g.alive) {
      if (Date.now() > deadline) {
        const upd = target !== null ? q(s.home, 'SELECT status, crash_count FROM updates WHERE update_id = ?', target) : [];
        const ev = target !== null ? q(s.home, 'SELECT seq, kind, status, raw_ref FROM events WHERE update_id = ?', target) : [];
        const busy = q(s.home, "SELECT seq, update_id, status FROM events WHERE status = 'transcribing' ORDER BY seq");
        const tail = readJournal(s.home).slice(-12).map((l) => `${l.ev}${l.seq !== undefined ? ` №${String(l.seq)}` : ''}${l.update_id !== undefined ? ` u${String(l.update_id)}` : ''}${l.reason !== undefined ? ` ${String(l.reason)}` : ''}`);
        if (g.alive) await g.kill9().catch(() => undefined);
        throw new Error(`не вышел: ${what}; update ${JSON.stringify(upd)}; event ${JSON.stringify(ev)}; transcribing ${JSON.stringify(busy)}; журнал: ${tail.join(' | ')}`);
      }
      await g.advance('1s').catch(() => undefined);
      await sleep(15);
    }
    return g.waitForExit();
  }

  it(`все ${TOTAL} — ровно по одному событию, offset = последний + 1, файлы целы, квитанции у всех (зерно в диагностике)`, async (t) => {
    t.diagnostic(`зерно STG_SEED=${seed}`);
    const rnd = mulberry32(seed);
    const slots: string[] = [...POINTS, ...Array.from({ length: KILLS - POINTS.length }, () => 'random')];
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [slots[i], slots[j]] = [slots[j]!, slots[i]!];
    }
    for (const slot of slots) {
      feed(TOTAL / KILLS);
      const startedAt = Date.now();
      let target: number | undefined;
      if (slot !== 'random') {
        // Цель — обновление без падений: ещё не принималось или принималось без сбоя. Под нагрузкой всего набора одно и то
        // же обновление из первых трёх непринятых иначе набирает падения (цель точки + задето соседним убийством) и на
        // третьем уходит в отложенное — тогда точку на нём не достать (A1.10: так и должно быть), и тест ждал бы зря.
        const notAdmitted = ids.filter(
          (id) => count(s.home, "SELECT count(*) AS n FROM updates WHERE update_id = ? AND (status IN ('admitted', 'in_progress', 'deferred') OR crash_count > 0)", id) === 0,
        );
        // Точки файлов — на голосовом: у текста файла нет; in_stt — на голосовом, которое распознаётся; in_send — тоже на
        // нём: в чат уходит ответ с расшифровкой (реакций без агента с 0.3.2 нет).
        const pool = FILE_POINTS.has(slot)
          ? notAdmitted.filter((id) => voiceIds.has(id))
          : slot === 'in_stt' || slot === 'in_send'
            ? notAdmitted.filter((id) => sttIds.has(id))
            : notAdmitted;
        target = pool[Math.min(pool.length - 1, Math.floor(rnd() * 3))]!;
        const g = s.spawn({ STG_FAULT: `${slot}:${target}` });
        const ex = await untilExit(g, `${slot}:${target}`, target);
        assert.equal(ex.code, 137, `${slot}:${target} — выход 137; stderr: ${g.stderr}`);
        assert.match(g.stderr, new RegExp(`точка сбоя ${slot}:${target}`));
      } else {
        const g = s.spawn();
        await g.waitForJournal((l) => l.ev === 'ready', 15_000);
        const goal = Math.min(TOTAL, admitted() + 1 + Math.floor(rnd() * 8));
        const delay = Math.floor(rnd() * 40);
        await pump(g, () => admitted() >= goal || null, { what: 'приёма перед убийством', timeoutMs: 30_000 }).catch(async (e: unknown) => {
          if (g.alive) throw e;
        });
        await sleep(delay);
        await g.kill9();
      }
      runs.push({ slot, startedAt, endedAt: Date.now(), abrupt: true, ...(target !== undefined ? { target } : {}) });
      if (process.env.STG_DEBUG) t.diagnostic(`${slot}: ${Date.now() - startedAt} мс`);
      shiftClockFile(s.home, 61_000);
    }

    // Последний запуск: дождаться всего и остановить чисто.
    feed(TOTAL);
    const startedAt = Date.now();
    const g = await s.start();
    await waitUntil(() => admitted() >= TOTAL, 30_000, 'приёма всех');
    await pump(
      g,
      () =>
        count(s.home, "SELECT count(*) AS n FROM outbox WHERE kind = 'receipt' AND status <> 'sent'") === 0 &&
        count(s.home, "SELECT count(*) AS n FROM events WHERE status = 'transcribing'") === 0 &&
        count(s.home, "SELECT count(*) AS n FROM reactions WHERE status <> 'done'") === 0 &&
        count(s.home, "SELECT count(*) AS n FROM edits WHERE status = 'pending'") === 0,
      {
      what: 'всех квитанций и расшифровок',
      timeoutMs: 60_000,
    });
    await g.stop();
    runs.push({ slot: 'final', startedAt, endedAt: Date.now(), abrupt: false });

    // Все 200 — ровно по одному разу.
    const ev = q<{ update_id: number; n: number }>(s.home, 'SELECT update_id, count(*) AS n FROM events WHERE update_id IS NOT NULL GROUP BY update_id');
    assert.equal(ev.length, TOTAL);
    assert.ok(ev.every((e) => e.n === 1));
    assert.deepEqual(ev.map((e) => e.update_id).sort((a, b) => a - b), ids);
    assert.equal(Number(meta(s.home, 'offset')), ids[ids.length - 1]! + 1);
    assert.equal(count(s.home, "SELECT count(*) AS n FROM updates WHERE status = 'deferred'"), 0, 'ни одно не отложено');

    // Файлы содержимого: у каждого голосового — файл raw_ref; брошенных временных файлов нет; звуков — сколько голосовых.
    const voices = q<{ update_id: number; kind: string; raw_ref: string | null }>(
      s.home,
      `SELECT update_id, kind, raw_ref FROM events WHERE update_id IN (${[...voiceIds].join(',')})`,
    );
    assert.equal(voices.length, voiceIds.size);
    for (const v of voices) {
      assert.ok(v.raw_ref, `голосовое ${v.update_id}: нет raw_ref`);
      assert.match(v.raw_ref, /\.oga$/);
      assert.ok(fs.existsSync(path.join(s.home.dir, v.raw_ref)), `голосовое ${v.update_id}: нет файла ${v.raw_ref}`);
      assert.ok(fs.statSync(path.join(s.home.dir, v.raw_ref)).size > 0, `голосовое ${v.update_id}: пустой файл`);
    }
    const raw = listFiles(s.home.paths.raw);
    const tmp = [...raw, ...listFiles(s.home.dir).filter((f) => !f.startsWith('raw/'))].filter((f) => /\.tmp$/.test(f));
    assert.deepEqual(tmp, [], 'брошенных временных файлов нет');
    assert.equal(raw.filter((f) => f.endsWith('.oga')).length, voiceIds.size, 'звуковых файлов — сколько голосовых');
    // Распознавание (in_stt): у каждого голосового вне закрытой темы — расшифровка, ни одно не осталось ждать.
    const stt = q<{ update_id: number; status: string; transcript: string | null }>(
      s.home,
      `SELECT update_id, status, transcript FROM events WHERE update_id IN (${[...sttIds].join(',')})`,
    );
    assert.equal(stt.length, sttIds.size);
    for (const v of stt) assert.equal(v.transcript, 'расшифровка голосового', `голосовое ${v.update_id}: ${v.status}`);
    const closed = q<{ update_id: number; raw_ref: string | null }>(s.home, "SELECT update_id, raw_ref FROM events WHERE kind = 'closed_topic'");
    assert.ok(closed.length >= 4);
    for (const c of closed) {
      assert.ok(c.raw_ref && fs.existsSync(path.join(s.home.dir, c.raw_ref)), `закрытая тема ${c.update_id}: нет файла`);
      assert.ok(raw.some((f) => f.startsWith('closed/') && f.endsWith(`/${c.update_id}.json`)), `закрытая тема ${c.update_id}: нет .json`);
    }

    // Квитанции.
    const events = q<{ seq: number; kind: string; message_id: number }>(s.home, "SELECT seq, kind, message_id FROM events WHERE kind IN ('text', 'voice', 'closed_topic') ORDER BY seq");
    const seqs = events.map((r) => r.seq);
    assert.equal(seqs.length, TOTAL);
    const voiceSeqs = new Set(events.filter((e) => e.kind === 'voice').map((e) => e.seq));
    assert.equal(voiceSeqs.size, sttIds.size);
    const runOf = (at: number): Run | undefined => runs.find((r) => at >= r.startedAt && at <= r.endedAt + 50);
    /** Лишние отправки — только от убитого запуска, не больше одной на запуск. */
    const extrasByRun = (extras: Array<{ at: number; what: string }>, lane: string): Map<Run, number> => {
      const perRun = new Map<Run, number>();
      for (const x of extras) {
        const run = runOf(x.at);
        assert.ok(run?.abrupt, `${lane}: лишняя «${x.what}» не от убитого процесса`);
        perRun.set(run, (perRun.get(run) ?? 0) + 1);
      }
      for (const [run, n] of perRun) assert.ok(n <= 1, `${lane}: запуск ${run.slot} — лишних ${n}`);
      return perRun;
    };
    // Агента нет — реакций нет ни одной (0.3.2: ✍ нет; 👀 и 👌 — только у агента).
    assert.equal(s.fake.reactions.length, 0, 'без агента — реакций нет');
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM reactions'), 0, 'строк реакций нет');
    // Ответ с расшифровкой — у каждого голосового вне закрытой темы, ровно один записанный шлюзом; текстовых квитанций нет.
    assert.ok(!s.fake.sentTo(OWNER.id).some((m) => /^№ \d/.test(m.text ?? '')), 'текстовых квитанций «№ N» нет');
    const voiceByMsg = new Map(events.filter((e) => e.kind === 'voice').map((e) => [e.message_id, e.seq]));
    const replies = s.fake.sentTo(OWNER.id).filter((m) => voiceByMsg.has((m.reply_parameters as { message_id?: number } | null)?.message_id ?? -1));
    assert.ok(replies.every((m) => m.text === '<blockquote>расшифровка голосового</blockquote>' && m.parse_mode === 'HTML'), 'ответ — только текст расшифровки, цитатой (0.3.4, R-23 а)');
    const recordedIds = new Set(q<{ tg_message_id: number }>(s.home, "SELECT tg_message_id FROM messages_out WHERE kind = 'receipt'").map((r) => r.tg_message_id));
    for (const [mid, sq] of voiceByMsg) {
      const mine = replies.filter((m) => (m.reply_parameters as { message_id: number }).message_id === mid);
      assert.equal(mine.filter((m) => recordedIds.has(m.message_id)).length, 1, `№ ${sq}: записанных ответов с расшифровкой`);
    }
    assert.equal(count(s.home, 'SELECT count(DISTINCT event_seq) AS n FROM receipts'), voiceSeqs.size, 'receipts — у каждого голосового');
    const unrecorded = replies.filter((m) => !recordedIds.has(m.message_id));
    const repliesPerRun = extrasByRun(unrecorded.map((m) => ({ at: m.at, what: `расшифровка ответом на ${String((m.reply_parameters as { message_id: number }).message_id)}` })), 'расшифровка');
    // Убийство в точке in_send (после ответа Telegram, до отметки) бьёт по ответу с расшифровкой на голосовое: лишняя
    // отправка на цели есть обязательно.
    const inSend = runs.find((r) => r.slot === 'in_send')!;
    const inSendMsg = s.fake.history.get(inSend.target!)!.message!.message_id;
    assert.ok((repliesPerRun.get(inSend) ?? 0) >= 1, 'убийство в точке in_send дало вторую отправку');
    assert.ok(replies.filter((m) => (m.reply_parameters as { message_id: number }).message_id === inSendMsg).length >= 2, 'вторая отправка — на цели in_send');
    // Диагностика — одной строкой.
    t.diagnostic(`запусков ${runs.length}; лишних расшифровок: ${unrecorded.length} (${unrecorded.map((m) => runOf(m.at)?.slot).join(', ')})`);
  });
});
