// M2 модульно: строки команд и эпизодов (5.6, 5.7), строка состояния ≤ 64 знаков (A2.8), «где мы» по базе (A2.11),
// задержки p50/p90 (A2.14), метка инлайн-бота (5.4 по Ш-20).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { Message } from '@grammyjs/types';
import { DEFAULT_ROLE, ownerRoleName, parseConfig, shownRole } from './config.js';
import { openForGateway, setMeta } from './db.js';
import {
  AGENT_MARK,
  PICK_EPISODE_TEXT,
  STOPPED_TEXT,
  STOP_NEEDS_BUTTON_TEXT,
  UNNAMED_TOPIC,
  episodeAnnounceText,
  episodeConfirmedText,
  episodeLabel,
  episodeRejectedText,
  episodeReturnedText,
  formatElapsed,
  helpText,
  formatMs,
  newTopicNoteText,
  roleLabel,
  seqList,
  statusLineText,
  stopLiftedText,
} from './strings.js';
import { labelMessage } from './trust.js';
import { latencyStats, percentile, readMode, readTurn, whereData, whereText } from './where.js';

/** Временные каталоги этого файла тестов — удаляются после него. */
const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

describe('M2 · строки команд и эпизодов', () => {
  it('тексты 5.6 и 5.7 дословно; все — служебные (⚙), ни одна не начинается с 💬 (П-4)', () => {
    assert.equal(STOPPED_TEXT, '⚙ Остановлен, сообщения сохраняю');
    assert.equal(STOP_NEEDS_BUTTON_TEXT, '⚙ Стоп снимается кнопкой [продолжить]');
    assert.equal(episodeAnnounceText(43, 'Задачи на завтра', shownRole('личный ассистент')), '⚙ ↪ #43 · Задачи на завтра');
    const all = [
      STOPPED_TEXT,
      STOP_NEEDS_BUTTON_TEXT,
      PICK_EPISODE_TEXT,
      stopLiftedText(0),
      stopLiftedText(3),
      episodeAnnounceText(1, 'т', 'р'),
      episodeReturnedText(1, 'т', 'р'),
      episodeConfirmedText(1, 'т', 'р'),
      episodeRejectedText(1, 'т', 'р'),
      helpText({ whereTtlMinutes: 5, audioMaxMinutes: 15 }),
    ];
    for (const l of all) {
      assert.ok(l.startsWith('⚙ '), l);
      assert.ok(!l.startsWith(AGENT_MARK), l);
    }
    assert.equal(stopLiftedText(3), '⚙ Стоп снят, отдаю агенту накопленное: 3');
    assert.equal(roleLabel('личный ассистент'), 'Личный ассистент');
    // После нажатия объявление — одна строка без кнопок (0.2.0, J-4).
    assert.equal(episodeConfirmedText(43, 'Задачи на завтра', ''), '⚙ ↪ #43 · Задачи на завтра — верно');
    assert.equal(episodeRejectedText(43, 'Задачи на завтра', ''), '⚙ ↪ #43 · Задачи на завтра — не то');
    assert.equal(episodeReturnedText(43, 'Задачи на завтра', ''), '⚙ ↩ #43 · Задачи на завтра');
    // Тема, не названная агентом, — «тема не названа», а не «Новая тема»: «Новая тема» владельцу непонятна.
    assert.equal(episodeLabel(2, 'Новая тема', ''), `#2 · ${UNNAMED_TOPIC}`);
    assert.equal(newTopicNoteText(44), '⚙ 🆕 #44 · тема не названа');
  });

  it('роль по умолчанию владельцу не показывается, другая — видна; эпизод — «#N»', () => {
    // Пока роль одна, её не выводят: «личный ассистент» не пишется.
    assert.equal(shownRole(DEFAULT_ROLE), '');
    assert.equal(shownRole('  Личный\n ассистент '), '', 'без учёта регистра и пробелов');
    assert.equal(shownRole('секретарь'), 'секретарь');
    const config = parseConfig({ bot: 'b', owner_id: 1, timezone: 'UTC' }, { test: false });
    assert.equal(ownerRoleName(config, 'личный ассистент'), '');
    assert.equal(ownerRoleName(config, 'секретарь'), 'Секретарь');
    // Своё имя роли по умолчанию в ui.role_short её не возвращает; у другой роли — берётся.
    const short = parseConfig({ bot: 'b', owner_id: 1, timezone: 'UTC', ui: { role_short: { 'личный ассистент': 'Личный', секретарь: 'Секр.' } } }, { test: false });
    assert.equal(ownerRoleName(short, 'личный ассистент'), '');
    assert.equal(ownerRoleName(short, 'секретарь'), 'Секр.');
    // Закреплённая строка, объявление — роль по умолчанию скрыта, другая — последней.
    const ep = { id: 7, topic: 'Задачи на неделю' };
    assert.equal(statusLineText({ episode: ep, role: ownerRoleName(config, 'личный ассистент'), agent: 'free', waiting: 0, mode: 'running' }), '📍 #7 · Задачи на неделю\n🟢');
    assert.equal(statusLineText({ episode: ep, role: ownerRoleName(config, 'секретарь'), agent: 'free', waiting: 0, mode: 'running' }), '📍 #7 · Задачи на неделю · Секретарь\n🟢');
    assert.equal(statusLineText({ episode: { ...ep, closed: true }, role: '', agent: 'free', waiting: 0, mode: 'running' }), '📍 #7 · Задачи на неделю · закрыт\n🟢');
    assert.equal(episodeAnnounceText(43, 'Задачи на завтра', shownRole('личный ассистент')), '⚙ ↪ #43 · Задачи на завтра');
    assert.equal(episodeAnnounceText(43, 'Задачи на завтра', shownRole('секретарь')), '⚙ ↪ #43 · Задачи на завтра · Секретарь');
    assert.equal(episodeReturnedText(43, 'Задачи на завтра', shownRole('секретарь')), '⚙ ↩ #43 · Задачи на завтра · Секретарь');
    // В /help нет ни «Эп.», ни роли в поле ввода.
    const help = helpText({ whereTtlMinutes: 5, audioMaxMinutes: 15 });
    assert.ok(!/Эп\.|эп\.|Роль|роль/.test(help), help);
    assert.ok(help.includes('номер эпизода (#7)'), help);
  });

  it('закреплённая строка: #N и тема (роль по умолчанию скрыта); закрытый — «закрыт»; эпизодов не было — «Тем ещё не было»; значками — режим, агент (кружок), ждут; с 📍, не с 💬', () => {
    const ep = { id: 2, topic: 'Новая тема' };
    const base = { episode: ep, role: '' };
    assert.equal(statusLineText({ ...base, agent: 'offline', waiting: 4, mode: 'running' }), '📍 #2 · тема не названа\n⚪ · 📥 4');
    assert.equal(statusLineText({ ...base, episode: { ...ep, topic: 'Задачи' }, agent: 'free', waiting: 0, mode: 'running' }), '📍 #2 · Задачи\n🟢');
    assert.equal(statusLineText({ ...base, agent: 'busy', waiting: 1, mode: 'paused' }), '📍 #2 · тема не названа\n⏸ пауза · 🟡 · 📥 1');
    // Открытого эпизода нет — последний с пометкой (проверка на реальном боте: «Эпизода нет» рядом с «Эп. 5» в чате — противоречие).
    assert.equal(
      statusLineText({ ...base, episode: { id: 5, topic: 'Отпуск в мае', closed: true }, agent: 'free', waiting: 0, mode: 'running' }),
      '📍 #5 · Отпуск в мае · закрыт\n🟢',
    );
    assert.equal(statusLineText({ episode: null, role: '', agent: 'offline', waiting: 0, mode: 'stopped' }), '📍 Тем ещё не было\n⛔ стоп · ⚪');
    // Другая роль — последней, и у закрытого, и когда эпизодов не было.
    assert.equal(
      statusLineText({ episode: { id: 5, topic: 'Отпуск в мае', closed: true }, role: 'Секретарь', agent: 'free', waiting: 0, mode: 'running' }),
      '📍 #5 · Отпуск в мае · закрыт · Секретарь\n🟢',
    );
    assert.equal(statusLineText({ episode: null, role: 'Секретарь', agent: 'offline', waiting: 0, mode: 'running' }), '📍 Тем ещё не было · Секретарь\n⚪');
    // Тема — в одну строку, без управляющих знаков; ни одна строка не начинается с 💬.
    const odd = statusLineText({ ...base, episode: { id: 3, topic: '💬 a\nb' }, agent: 'free', waiting: 0, mode: 'running' });
    assert.ok(odd.startsWith('📍 #3 · '), odd);
    assert.equal(odd.split('\n').length, 2, odd);
  });

  it('мелочи: длительность эпизода, задержки, список №', () => {
    assert.equal(formatElapsed(30_000), 'меньше минуты');
    assert.equal(formatElapsed(12 * 60_000), '12 мин');
    assert.equal(formatElapsed(65 * 60_000), '1 ч 05 мин');
    assert.equal(formatMs(55), '55 мс');
    assert.equal(formatMs(1050), '1,1 с');
    assert.equal(formatMs(null), '—');
    assert.equal(seqList([1, 2, 3]), '№ 1, 2, 3');
    assert.equal(seqList([1, 2, 3], 2), '№ 1, 2, …');
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
    assert.equal(percentile([], 90), null);
  });
});

describe('5.4 по Ш-20 · инлайн-бот — чужое целиком', () => {
  const owner = { id: 111, is_bot: false, first_name: 'Анна' };
  const base = { message_id: 1, date: 1, chat: { id: 111, type: 'private', first_name: 'Анна' }, from: owner, via_bot: { id: 9, is_bot: true, first_name: 'gif', username: 'gif' } };
  it('текст и голос через инлайн-бота — untrusted, mixed = нет, вложение via_bot; командой не бывает', () => {
    const t = labelMessage({ ...base, text: 'стоп' } as unknown as Message, { ownerId: 111, fromOwner: true });
    assert.deepEqual({ trust: t.trust, mixed: t.mixed, plain: t.plainOwnerText }, { trust: 'untrusted', mixed: false, plain: false });
    assert.deepEqual(t.attachments.map((a) => `${a.kind}:${a.trust}`), ['via_bot:untrusted']);
    const v = labelMessage({ ...base, voice: { file_id: 'v', file_unique_id: 'uv', duration: 3 } } as unknown as Message, { ownerId: 111, fromOwner: true });
    assert.equal(v.trust, 'untrusted');
    assert.deepEqual(v.attachments.map((a) => `${a.kind}:${a.trust}`), ['via_bot:untrusted', 'voice:untrusted']);
  });
});

function tmpDb(): string {
  const dir = tmpDir('stg-where-');
  return path.join(dir, 'gateway.db');
}

describe('A2.11 · «где мы» по базе (модульно)', () => {
  const T = Date.parse('2026-10-18T16:00:00.000Z');
  const input = { now: T + 12 * 60_000, timezone: 'America/Los_Angeles', chatId: 111, subjectId: 'owner', defaultRole: 'личный ассистент', agentOnline: false };

  it('#N и тема (роль по умолчанию скрыта), длительность, ждущие ответа, на связи ли агент, режим, отложенное, закрытое без ответа, итог не получен', () => {
    const { db } = openForGateway(tmpDb());
    try {
      db.exec("INSERT INTO subjects(id, who) VALUES ('owner', 'owner')");
      const ins = db.prepare(
        `INSERT INTO episodes(chat_id, subject_id, topic, role, space, opened_by, opened_at, last_activity_at, closed_at, close_reason, summary)
         VALUES (111, 'owner', ?, 'личный ассистент', 'личное', 'first_event', ?, ?, ?, ?, ?)`,
      );
      ins.run('Старое', T - 3 * 86_400_000, T - 3 * 86_400_000, T - 3 * 86_400_000 + 1, 'idle', null);
      ins.run('Задачи на завтра', T, T, null, null, null);
      const ev = db.prepare(
        `INSERT INTO events(update_id, chat_id, subject_id, trust, kind, text, episode_id, status, created_at, processed_silent, processed_at, delivered_at)
         VALUES (?, 111, 'owner', 'owner', ?, 'x', ?, ?, ?, ?, ?, ?)`,
      );
      ev.run(1, 'text', 2, 'new', T, 0, null, null);
      ev.run(2, 'text', 2, 'delivered', T, 0, null, T);
      ev.run(3, 'text', 2, 'processed', T, 1, T + 60_000, T);
      ev.run(null, 'episode_closed', 1, 'delivered', T - 3 * 86_400_000, 0, null, T - 2 * 86_400_000);
      db.prepare("INSERT INTO updates(update_id, received_at, status, raw_json) VALUES (500, ?, 'deferred', ?)").run(T, JSON.stringify({ update_id: 500, message: { date: T / 1000 } }));
      setMeta(db, 'mode', 'paused');
      const d = whereData(db, input);
      assert.equal(d.episode?.topic, 'Задачи на завтра');
      assert.deepEqual(d.waiting, [1, 2]);
      assert.equal(d.mode, 'paused');
      assert.deepEqual(d.closed_silent, [3]);
      assert.deepEqual(d.summary_missing, [1]);
      assert.deepEqual(d.deferred, [{ update_id: 500, message_at: T }]);
      const text = whereText(d, input);
      assert.equal(
        text,
        [
          '⚙ Где мы',
          '#2 · Задачи на завтра — идёт 12 мин (с 09:00)',
          'Ждут ответа агента: 2 (№ 1, 2)',
          'Агент: не на связи',
          'Режим: пауза — агент отвечает на твои сообщения, сам не пишет',
          'Отложено: 1 (сообщения от 09:00; stg deferred list)',
          'Закрыто без ответа за сутки: 1 (№ 3)',
          'Итог #1 не получен',
        ].join('\n'),
      );
      assert.equal(readMode(db), 'paused');
      assert.equal(readTurn(db), 0);
      // Открытого нет — последний закрытый, как в закреплённой строке «… · закрыт» (проверка 0.2.0: «Эпизода сейчас нет»
      // рядом со строкой — то же противоречие); агент неизвестно (CLI без шлюза).
      db.prepare("UPDATE episodes SET closed_at = ?, close_reason = 'idle' WHERE id = 2").run(T + 2 * 60_000);
      const off = { ...input, agentOnline: null };
      const d2 = whereData(db, off);
      assert.equal(d2.episode, null);
      assert.deepEqual(d2.last_closed, { id: 2, topic: 'Задачи на завтра', role: 'личный ассистент', closed_at: T + 2 * 60_000 });
      const t2 = whereText(d2, off);
      assert.match(t2, /^⚙ Где мы\n#2 · Задачи на завтра — закрыт 10 мин назад; следующее сообщение откроет новый\n/);
      assert.match(t2, /Агент: неизвестно — шлюз не отвечает/);
      // Последний — по времени закрытия, а не по номеру: эп. 1 открыт снова ([не то]) и закрыт позже эп. 2.
      db.prepare('UPDATE episodes SET closed_at = ? WHERE id = 1').run(T + 5 * 60_000);
      assert.equal(whereData(db, off).last_closed?.id, 1);
      // Роль нового — если она другая (и не по умолчанию).
      const sec = { ...off, defaultRole: 'секретарь' };
      assert.match(whereText(whereData(db, sec), sec), /^⚙ Где мы\n#1 · Старое — закрыт 7 мин назад; следующее сообщение откроет новый \(Секретарь\)\n/);
      // Эпизод с другой ролью — роль видна; следующий — с ролью по умолчанию, её не называют.
      db.prepare("UPDATE episodes SET role = 'секретарь' WHERE id = 1").run();
      assert.match(whereText(whereData(db, off), off), /^⚙ Где мы\n#1 · Старое · Секретарь — закрыт 7 мин назад; следующее сообщение откроет новый\n/);
      // Несколько итогов не получено — каждый «#N».
      assert.equal(whereText({ ...d2, summary_missing: [4, 3] }, off).split('\n').at(-1), 'Итог #4, #3 не получен');
    } finally {
      db.close();
    }
  });

  it('эпизодов не было — «Тем ещё не было», как в закреплённой строке; роль по умолчанию не называется, другая — в скобках', () => {
    const { db } = openForGateway(tmpDb());
    try {
      const d = whereData(db, input);
      assert.equal(d.episode, null);
      assert.equal(d.last_closed, null);
      assert.match(whereText(d, input), /^⚙ Где мы\nТем ещё не было — первое сообщение откроет эпизод\n/);
      const sec = { ...input, defaultRole: 'секретарь' };
      assert.match(whereText(d, sec), /^⚙ Где мы\nТем ещё не было — первое сообщение откроет эпизод \(Секретарь\)\n/);
    } finally {
      db.close();
    }
  });

  it('A2.14, L-2: задержки за сутки — «записал» по записи (COMMIT, 0.3.2: ✍ нет), 👀 от отдачи агенту; p50/p90', () => {
    const { db } = openForGateway(tmpDb());
    try {
      db.exec("INSERT INTO events(kind, status, created_at) VALUES ('text', 'new', 0)");
      db.exec("INSERT INTO events(kind, status, created_at) VALUES ('text', 'new', 0)");
      const seq = Number((db.prepare('SELECT max(seq) AS s FROM events').get() as { s: number }).s);
      // Первое — агент на связи: записано через 40 мс, отдано через 2 с, 👀 через 300 мс после отдачи. Второе (через 5 с)
      // — агента нет: записано через 60 мс, реакции нет (и «записал» от неё не зависит).
      db.prepare('INSERT INTO latency(event_seq, t_update, t_admit, t_receipt, t_delivered, t_eyes) VALUES (?, ?, ?, ?, ?, ?)').run(seq - 1, T, T + 40, T + 2300, T + 2000, T + 2300);
      db.prepare('INSERT INTO latency(event_seq, t_update, t_admit) VALUES (?, ?, ?)').run(seq, T + 5000, T + 5060);
      // Строка прежней схемы (ранние сборки): 👀 — при приёме, раньше отдачи. В 👀 «после отдачи» не идёт: с обрезкой до нуля
      // она занижала бы p50 до 0 мс (проверка 0.2.0). Запись у неё есть — «записал» 50 мс.
      db.exec("INSERT INTO events(kind, status, created_at) VALUES ('text', 'new', 0)");
      db.prepare('INSERT INTO latency(event_seq, t_update, t_eyes, t_admit, t_delivered) VALUES (?, ?, ?, ?, ?)').run(seq + 1, T, T + 10, T + 50, T + 5000);
      const st = latencyStats(db, T + 1000);
      assert.deepEqual(st, { admitted: { p50: 50, p90: 60, n: 3 }, eyes: { p50: 300, p90: 300, n: 1 } });
      assert.deepEqual(latencyStats(db, T + 2 * 86_400_000).eyes, { p50: null, p90: null, n: 0 });
    } finally {
      db.close();
    }
  });

  it('L-2: пачка — в 👀 только первое сообщение (по отдаче, разрыв < 1 с); «записал» — каждое по своей записи (0.3.2)', () => {
    const { db } = openForGateway(tmpDb());
    try {
      const ins = db.prepare('INSERT INTO latency(event_seq, t_update, t_admit, t_receipt, t_delivered, t_eyes) VALUES (?, ?, ?, ?, ?, ?)');
      const ev = (): number => Number(db.prepare("INSERT INTO events(kind, status, created_at) VALUES ('text', 'new', 0)").run().lastInsertRowid);
      // Одиночное: записано через 40 мс.
      const single = ev();
      ins.run(single, T + 1000, T + 1040, null, null, null);
      // Пачка из 4 пересланных одним опросом (t_update один): каждое — своей короткой транзакцией, 10…13 мс.
      const pack: number[] = [];
      for (let k = 0; k < 4; k++) {
        pack.push(ev());
        ins.run(pack[k]!, T + 10_000, T + 10_010 + k, null, null, null);
      }
      // Агент пришёл: отдано три события подряд за 20 мс — 👀 шагом полосы 200, 450, 700; потом одиночное через 5 с.
      const deliver = db.prepare('UPDATE latency SET t_delivered = ?, t_eyes = ? WHERE event_seq = ?');
      for (let k = 0; k < 3; k++) deliver.run(T + 20_000 + 10 * k, T + 20_200 + 250 * k, pack[k]!);
      deliver.run(T + 25_000, T + 25_300, single);
      const st = latencyStats(db, T + 30_000);
      assert.deepEqual(st.admitted, { p50: 12, p90: 40, n: 5 }, 'запись — каждое');
      assert.deepEqual(st.eyes, { p50: 200, p90: 300, n: 2 }, 'первое из пачки отдачи и одиночное');
    } finally {
      db.close();
    }
  });
});
