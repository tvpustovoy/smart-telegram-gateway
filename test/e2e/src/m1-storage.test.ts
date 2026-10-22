// Хранилище: A1.14 (Оч-5) — stg backup во время приёма (подделка держит скачивание голосового посреди пачки — копия
// гарантированно снимается посреди приёма); stg restore на чистой папке: integrity_check = ok, числа строк сходятся;
// шлюз стартует, дублей нет; restore не идёт, пока замок gateway.lock занят. A1.15 — обрезанный файл базы: опрос не
// начат, строка владельцу, код выхода ≠ 0 (и без повтора строки при перезапусках). A1.16 — диск полон: ENOSPC посреди
// записи звука; настоящий SQLITE_FULL в главной транзакции (in_progress и файл уже записаны); SQLITE_FULL на всех
// записях — приём, сокет переходника (delivered, reply), тикер (закрытие эпизода): offset не сдвинут, crash_count не
// вырос, процесс жив, одна строка на эпизод; после освобождения места всё принято, без дублей событий и файлов. Пробная
// запись тикера при полном диске пишет и файл в raw/ — места нет только для файлов, и проба это видит.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { DB_FAILURE_NOTICE, DISK_FULL_NOTICE, SCHEMA_TABLES, acquireInstanceLock } from 'stg-core';
import { makeOggOpus } from 'stg-fake-elevenlabs';
import { reply } from 'stg-fake-telegram';
import {
  GatewayProcess,
  TEST_TOKEN,
  assertNoLoss,
  assertNoToken,
  connectAdapter,
  count,
  makeHome,
  meta,
  pump,
  q,
  q1,
  readJournal,
  runCli,
  sleep,
  storeProblems,
  testEnv,
  waitUntil,
} from './harness.js';
import { OWNER, botTexts, setup, type Setup } from './m1-common.js';

function counts(file: string): Record<string, number> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(SCHEMA_TABLES.map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]));
  } finally {
    db.close();
  }
}

/** Файлы каталога (рекурсивно). */
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe('A1.14 · копия и восстановление', () => {
  let s: Setup;
  after(() => s?.close());

  it('stg backup во время приёма; stg restore на чистой папке (и не под чужим замком); шлюз стартует без дублей', async () => {
    s = await setup();
    // Подделка общая для двух папок — сверка П-1 здесь своя, по номерам каждой папки.
    s.checks.noLoss = false;
    s.fake.addFile(makeOggOpus(2), { fileId: 'v1', path: 'voice/v1.oga' });
    s.fake.addFile(makeOggOpus(2), { fileId: 'v2', path: 'voice/v2.oga' });
    // Второе скачивание (голосовое посреди второй пачки) подделка держит 5 с: приём стоит на нём, копия снимается
    // посреди приёма.
    s.fake.scenario({ method: 'getFile', nth: 2, reply: reply.delay(5000) });
    const gw = await s.start();
    const first = [s.fake.builder.voice(OWNER, { duration: 2, fileId: 'v1' }), ...Array.from({ length: 9 }, (_, i) => s.fake.builder.text(OWNER, `до копии ${i}`))];
    s.fake.push(...first);
    const admittedNow = (): number => count(s.home, "SELECT count(*) AS n FROM updates WHERE status = 'admitted'");
    await waitUntil(() => admittedNow() === 10, 5000, 'приёма');
    const during = [
      ...Array.from({ length: 15 }, (_, i) => s.fake.builder.text(OWNER, `во время копии ${i}`)),
      s.fake.builder.voice(OWNER, { duration: 2, fileId: 'v2' }),
      ...Array.from({ length: 14 }, (_, i) => s.fake.builder.text(OWNER, `после голосового ${i}`)),
    ];
    s.fake.push(...during);
    await waitUntil(() => admittedNow() === 25 && q1(s.home, "SELECT 1 FROM updates WHERE update_id = ? AND status = 'in_progress'", during[15]!.update_id), 5000, 'приёма до голосового');
    const r = await runCli(['backup'], s.env);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const file = /копия базы: (\S+)/.exec(r.stdout)![1]!;
    assert.match(path.basename(file), /^gateway-\d{8}-\d{6}\.db$/);
    assert.match(r.stdout, /integrity_check: ok/);
    assert.ok(admittedNow() < 40, 'копия снята, пока приём ещё шёл');
    await waitUntil(() => admittedNow() === 40, 10_000, 'приёма всех');
    // Восстановление при работающей службе — отказ.
    const refused = await runCli(['restore', file], s.env);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stdout, /останови службу/);
    await gw.stop();
    const handedBefore = [...s.fake.handedOut.keys()];
    assertNoLoss(s.fake, s.home, { ids: handedBefore });

    // Снимок цел и снят посреди приёма: у каждой admitted — ровно одно событие, raw/ скопирован.
    const db = new DatabaseSync(file, { readOnly: true });
    const ok = (db.prepare('PRAGMA integrity_check').get() as Record<string, string>)['integrity_check'];
    const admitted = (db.prepare("SELECT count(*) AS n FROM updates WHERE status = 'admitted'").get() as { n: number }).n;
    const withEvent = (db.prepare('SELECT count(DISTINCT update_id) AS n FROM events WHERE update_id IS NOT NULL').get() as { n: number }).n;
    db.close();
    assert.equal(ok, 'ok');
    assert.equal(admitted, withEvent);
    assert.ok(admitted > 10 && admitted < 40, `в копии принятых ${admitted}: копия не посреди приёма`);
    const backupCounts = counts(file);
    // Голосовое, на котором приём стоял, в копии — in_progress с raw_json. Telegram его уже не вернёт (принял прежний
    // шлюз) — в восстановленной папке оно через сутки уйдёт в отложенное со строкой владельцу.
    const dbb = new DatabaseSync(file, { readOnly: true });
    const inProgress = (dbb.prepare("SELECT update_id FROM updates WHERE status = 'in_progress' AND raw_json IS NOT NULL").all() as Array<{ update_id: number }>).map(
      (r) => r.update_id,
    );
    dbb.close();
    assert.deepEqual(inProgress, [during[15]!.update_id]);

    // Чистая папка: только config.yaml. Замок занят (шлюз стартует) — restore отказывает и ничего не трогает.
    const fresh = makeHome({ apiBase: s.fake.apiBase, ownerId: OWNER.id });
    const env2 = testEnv(fresh, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN });
    const held = acquireInstanceLock(fresh.paths.lock)!;
    assert.ok(held, 'замок взят тестом');
    const busy = await runCli(['restore', file], env2);
    held.release();
    assert.notEqual(busy.code, 0);
    assert.match(busy.stdout, /каталог занят/);
    assert.ok(!fs.existsSync(fresh.paths.db), 'под чужим замком база не тронута');
    const rr = await runCli(['restore', file], env2);
    assert.equal(rr.code, 0, rr.stdout + rr.stderr);
    assert.deepEqual(counts(fresh.paths.db), backupCounts, 'числа строк сходятся');
    const voiceRef = q1<{ raw_ref: string }>(fresh, "SELECT raw_ref FROM events WHERE kind = 'voice'")!.raw_ref;
    assert.ok(fs.existsSync(path.join(fresh.dir, voiceRef)), 'звук восстановлен в raw/');

    // Шлюз стартует; Telegram повторяет то, что есть в копии, — дублей нет; новое принимается.
    const g2 = await GatewayProcess.start(fresh, env2);
    const again = q<{ update_id: number }>(fresh, "SELECT update_id FROM updates WHERE status = 'admitted' ORDER BY update_id LIMIT 3");
    for (const a of again) s.fake.redeliver(a.update_id);
    const [fresh1] = s.fake.push(s.fake.builder.text(OWNER, 'после восстановления'));
    await waitUntil(() => count(fresh, 'SELECT count(*) AS n FROM events WHERE update_id = ?', fresh1!.update_id) === 1, 5000, 'приёма нового');
    await g2.waitForJournal((l) => l.ev === 'update_repeat');
    const dup = q<{ update_id: number; n: number }>(fresh, 'SELECT update_id, count(*) AS n FROM events WHERE update_id IS NOT NULL GROUP BY update_id HAVING n > 1');
    assert.deepEqual(dup, [], 'дублей нет');
    assert.deepEqual(storeProblems(fresh, { allowInProgress: inProgress }), []);
    // Сутки спустя висящее in_progress — отложенное с содержимым и строкой владельцу (Telegram его не вернёт).
    await g2.jump('25h');
    await waitUntil(() => q1(fresh, "SELECT 1 FROM updates WHERE update_id = ? AND status = 'deferred' AND raw_json IS NOT NULL", inProgress[0]!), 5000, 'отложенного');
    await pump(g2, () => botTexts(s.fake).some((t) => /отложил: за сутки не удалось его записать/.test(t)), { what: 'строки об отложенном' });
    await g2.stop();
    // Сверка восстановленной папки: хранилище цело, новое — на месте; токена нет.
    assert.deepEqual(storeProblems(fresh), []);
    assert.equal(count(fresh, 'SELECT count(*) AS n FROM events WHERE update_id = ?', fresh1!.update_id), 1);
    assertNoToken(fresh);
  });
});

describe('A1.15 · обрезанный файл базы', () => {
  let s: Setup;
  after(() => s?.close());

  it('опрос не начат, строка владельцу, код выхода ≠ 0; перезапуск — без второй строки', async () => {
    s = await setup();
    // База обрезана нарочно — сверка П-1 по ней не идёт (П-2 — идёт).
    s.checks.noLoss = false;
    const g = await s.start();
    s.fake.push(...Array.from({ length: 50 }, (_, i) => s.fake.builder.text(OWNER, `строка ${i} ${'x'.repeat(200)}`)));
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events') >= 50, 10_000, 'приёма');
    await g.stop();
    const size = fs.statSync(s.home.paths.db).size;
    fs.truncateSync(s.home.paths.db, Math.floor(size / 2));
    const polls = s.fake.callsOf('getUpdates').length;
    const g1 = s.spawn();
    const ex = await g1.waitForExit();
    assert.equal(ex.code, 4);
    assert.match(g1.stderr, /база не открылась/);
    assert.equal(s.fake.callsOf('getUpdates').length, polls, 'опрос не начат');
    await waitUntil(() => botTexts(s.fake).includes(DB_FAILURE_NOTICE), 5000, 'строки владельцу');
    // launchd перезапустит — строка не повторяется.
    const g2 = s.spawn();
    assert.equal((await g2.waitForExit()).code, 4);
    await sleep(200);
    assert.equal(botTexts(s.fake).filter((t) => t === DB_FAILURE_NOTICE).length, 1);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'db_failure_notice_skipped'));
    assert.equal(s.fake.callsOf('getUpdates').length, polls);
  });
});

describe('A1.16 · диск полон', () => {
  let s: Setup;
  after(() => s?.close());

  const notices = (): number => botTexts(s.fake).filter((t) => t === DISK_FULL_NOTICE).length;
  const tmpFiles = (): string[] => walk(s.home.paths.raw).filter((f) => f.endsWith('.tmp'));

  it('ENOSPC посреди записи звука; SQLITE_FULL в главной транзакции; SQLITE_FULL везде (приём, сокет, тикер): не падение, одна строка на эпизод; после — всё принято', async () => {
    s = await setup();
    const flag = path.join(s.home.dir, 'test-disk-full');
    s.fake.addFile(makeOggOpus(3), { fileId: 'vfull', path: 'voice/full.oga' });
    s.fake.addFile(makeOggOpus(3), { fileId: 'vcommit', path: 'voice/commit.oga' });
    const gw = await s.start();
    const [warm] = s.fake.push(s.fake.builder.text(OWNER, 'до'));
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', warm!.update_id) === 1, 5000, 'приёма');
    const offset0 = meta(s.home, 'offset');

    // 1. ENOSPC посреди записи звука: временный файл создан, половина записана — затем ENOSPC.
    fs.writeFileSync(flag, 'files');
    const [v] = s.fake.push(s.fake.builder.voice(OWNER, { duration: 3, fileId: 'vfull' }));
    await gw.waitForJournal((l) => l.ev === 'disk_full' && l.update_id === v!.update_id && l.step === 'files');
    await waitUntil(() => notices() === 1 || null, 5000, 'строки «диск полон»');
    assert.equal(meta(s.home, 'offset'), offset0, 'offset не сдвинут');
    let row = q1<{ status: string; crash_count: number }>(s.home, 'SELECT status, crash_count FROM updates WHERE update_id = ?', v!.update_id);
    assert.deepEqual({ ...row }, { status: 'in_progress', crash_count: 0 });
    assert.deepEqual(tmpFiles(), [], 'недописанный временный файл убран');
    // Раз в минуту пробует снова; строка — одна.
    const failures = (): number => readJournal(s.home).filter((l) => l.ev === 'disk_full' && l.update_id === v!.update_id).length;
    await gw.advance('60s');
    await waitUntil(() => failures() >= 2 || null, 5000, 'второй попытки');
    assert.equal(notices(), 1);
    assert.ok(gw.alive, 'не падение');
    assert.deepEqual(tmpFiles(), []);
    // Пробная запись тикера пишет и файл в raw/: пока места для файлов нет, она не проходит (хвост M1, сделан в M2).
    await waitUntil(
      () => readJournal(s.home).some((l) => l.ev === 'disk_full' && l.where === 'ticker' && /ENOSPC/.test(String(l.error))) || null,
      5000,
      'пробы файла тикером',
    );
    assert.ok(!fs.existsSync(path.join(s.home.paths.raw, '.disk-probe')), 'пробный файл не остаётся');
    fs.rmSync(flag);
    await gw.advance('60s');
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', v!.update_id) === 1, 5000, 'приёма после освобождения');
    const ref = q1<{ raw_ref: string }>(s.home, 'SELECT raw_ref FROM events WHERE update_id = ?', v!.update_id)!.raw_ref;
    assert.ok(fs.existsSync(path.join(s.home.dir, ref)));
    assert.equal(fs.statSync(path.join(s.home.dir, ref)).size, makeOggOpus(3).length, 'звук записан целиком');
    assert.equal(Number(meta(s.home, 'offset')), v!.update_id + 1);
    assert.equal(q1<{ crash_count: number }>(s.home, 'SELECT crash_count FROM updates WHERE update_id = ?', v!.update_id)?.crash_count, 0);

    // 2. Настоящий SQLITE_FULL в главной транзакции: строка in_progress и файл уже записаны.
    fs.writeFileSync(flag, 'commit');
    const offset1 = meta(s.home, 'offset');
    const [c] = s.fake.push(s.fake.builder.voice(OWNER, { duration: 3, fileId: 'vcommit' }));
    await gw.waitForJournal((l) => l.ev === 'disk_full' && l.update_id === c!.update_id && l.step === 'commit');
    await waitUntil(() => notices() === 2 || null, 5000, 'строки «диск полон» нового эпизода');
    assert.ok(/database or disk is full/.test(String(readJournal(s.home).find((l) => l.ev === 'disk_full' && l.update_id === c!.update_id)?.error)));
    row = q1(s.home, 'SELECT status, crash_count FROM updates WHERE update_id = ?', c!.update_id);
    assert.deepEqual({ ...row }, { status: 'in_progress', crash_count: 0 }, 'in_progress остался, crash_count 0');
    assert.equal(meta(s.home, 'offset'), offset1, 'offset прежний');
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', c!.update_id), 0, 'события нет — транзакция откатилась');
    await gw.advance('60s');
    await waitUntil(() => readJournal(s.home).filter((l) => l.ev === 'disk_full' && l.update_id === c!.update_id).length >= 2 || null, 5000, 'второй попытки');
    assert.equal(notices(), 2, 'в эпизоде — одна строка');
    fs.rmSync(flag);
    await gw.advance('60s');
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', c!.update_id) === 1, 5000, 'приёма после освобождения');
    row = q1(s.home, 'SELECT status, crash_count FROM updates WHERE update_id = ?', c!.update_id);
    assert.deepEqual({ ...row }, { status: 'admitted', crash_count: 0 });
    assert.equal(Number(meta(s.home, 'offset')), c!.update_id + 1);
    const oga = walk(s.home.paths.raw).filter((f) => f.endsWith(`/${c!.update_id}.oga`));
    assert.equal(oga.length, 1, 'файл один — повтор его переписал, а не задвоил');

    // 3. SQLITE_FULL на всех записях шлюза: приём, сокет переходника, тикер.
    const { ch, turn } = await connectAdapter(s.home);
    const last = q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', c!.update_id)!.seq;
    await ch.waitEvent(last);
    fs.writeFileSync(flag, 'db');
    const offset2 = meta(s.home, 'offset');
    const [t3] = s.fake.push(s.fake.builder.text(OWNER, 'когда база полна'));
    await gw.waitForJournal((l) => l.ev === 'disk_full' && l.update_id === t3!.update_id);
    await waitUntil(() => notices() === 3 || null, 5000, 'строки «диск полон» третьего эпизода');
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM updates WHERE update_id = ?', t3!.update_id), 0, 'ничего не записано');
    const d = await ch.delivered(last);
    assert.ok(d.type === 'error' && d.code === 'unavailable', `delivered при полном диске: ${JSON.stringify(d)}`);
    const rp = await ch.reply(last, 'ответ при полном диске', turn);
    assert.ok(rp.type === 'error' && rp.code === 'unavailable', `reply при полном диске: ${JSON.stringify(rp)}`);
    // Тишина 34 минуты: тикер пытается закрыть эпизод — запись не проходит, процесс жив.
    for (let i = 0; i < 34; i++) await gw.advance('1m');
    await waitUntil(() => readJournal(s.home).some((l) => l.ev === 'disk_full' && l.where === 'ticker') || null, 5000, 'сбоя записи у тикера');
    assert.ok(gw.alive, 'шлюз жив: сокет и тикер не роняют процесс');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM episodes WHERE closed_at IS NOT NULL"), 0, 'закрытие не записано');
    assert.equal(notices(), 3, 'в эпизоде — одна строка, сколько бы записей ни упало');
    assert.equal(meta(s.home, 'offset'), offset2);
    assert.equal(readJournal(s.home).filter((l) => l.ev === 'crash').length, 0);
    fs.rmSync(flag);
    await gw.advance('60s');
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', t3!.update_id) === 1, 5000, 'приёма после освобождения');
    const rp2 = await ch.reply(last, 'ответ после освобождения', turn);
    assert.ok(rp2.type === 'ack' && rp2.result === 'queued', JSON.stringify(rp2));
    await pump(gw, () => botTexts(s.fake).some((t) => t === 'ответ после освобождения'), { what: 'ответа агента' });
    await pump(gw, () => count(s.home, "SELECT count(*) AS n FROM episodes WHERE close_reason = 'idle'") === 1, { what: 'закрытия эпизода по тишине', step: '30s' });
    ch.close();
    await gw.stop();
    assert.equal(notices(), 3);
    assert.deepEqual(tmpFiles(), []);
    assertNoLoss(s.fake, s.home);
  });
});
