// M8 · посылки (0.3.3; P-23, #29; TECH-SPEC 5.16): агент отвечает файлами из промежуточной папки — владелец просит файл,
// агент присылает его в чат; файлы в папке агент обновляет, позже из неё можно будет публиковать в веб-сервис.
// A8.1 send_file(seq) — документ ответом, 👌, доставка sent с message_id, копия в raw/parcels · A8.2 без seq — в личку
// владельца; полный путь внутри папки · A8.3 новая версия — «⚙ обновлено»; та же — снова, «уже отправлял» · A8.4 подпись
// длиннее 1024 — документ без неё и следом текст · A8.5 отказы: > 50 МБ, папка, скрытое, «..», чужой полный путь,
// симлинк и жёсткая ссылка наружу, нет файла, пустой, прямо в папке посылок — ничего не ушло · A8.6 другой чат — только
// с parcels: true в rules.yaml · A8.7 сбой Telegram: 5xx и обрыв — повтор той же копией, 429 — ждать, 400 — failed ·
// A8.8 перезапуск шлюза: исходник удалён — уходит копия; убит в in_send — документ ещё раз, доставка одна · A8.9 дубль
// после обрыва канала (тот же idem) — второй доставки нет · A8.10 чистка копий: старше срока — удалена, строка доставки
// осталась; без ссылки — удалена; ждущая доставка копию держит · A8.11 «стоп» — ждущая доставка dropped; в стопе —
// dropped_stopped, старый ход — dropped_stale_turn · A8.12 папка по умолчанию — <каталог сессии агента>/parcels; нет её
// — отказ «создай»; цель не из списка (web) и выключенная (parcels.targets) — отказ.
// A8.14 диск полон при записи копии и нет прав на raw/parcels — unavailable, ничего не принято, шлюз не падает.
// По проверке: A8.5 — ещё FIFO и невидимый знак в имени; A8.7 — строка владельцу о неотправленном файле; A8.15
// чужой файл (from) помечен и без подписи; A8.16 пауза — held_paused, после «продолжить» уходит; A8.17 медленная сеть —
// три таймаута загрузки, доставка failed; A8.18 «стоп» прерывает документ в пути, «⚙ Остановлен» его не ждёт; повтор с
// тем же ключом — «брошен стопом»; A8.19 документ дошёл, а текст подписи следом — нет (400, «стоп»): доставка sent.
// Сведение 0.3.4 поверх 0.3.3 (раздел M9 — реакции): A9.16 реакция владельца на документ посылки — событие реакции, как
// на текстовый ответ (с 0.3.4 — через окно отмены 3 с); на строку шлюза о неотправленном файле — нет. A8.21 (проверка
// сведения) — подпись документа целиком цитатой — «💬 » впереди; цитата и свой текст — без пометки.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AGENT_MARK, PARCEL_NOTE_STOP_UPLOAD, STOPPED_TEXT, ownerReactionText, type GatewayMessage, type OwnerReaction, type SendFileResult } from 'stg-core';
import { FakeChannel } from 'stg-fake-channel';
import { errors, reply, type SentMessage } from 'stg-fake-telegram';
import { connectAdapter, count, makeTempDir, meta, pump, q, q1, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OTHER, OWNER, reactionOf, setup, type Setup } from './m1-common.js';
import { press } from './m2-common.js';

const RULES = `subjects:
  - id: owner
    who: owner
    transports: [{ network: telegram, address: "${OWNER.id}" }]
  - id: anya
    who: Аня
    transports: [{ network: telegram, address: "${OTHER.id}" }]
chats:
  - chat: private
    space: личное
    role: личный ассистент
`;

interface DeliveryRow {
  id: number;
  parcel: string;
  file: string;
  bytes: number;
  sha256: string;
  copy_ref: string | null;
  target: string;
  chat_id: number;
  event_seq: number | null;
  outbox_id: number | null;
  status: string;
  tg_message_id: number | null;
  url: string | null;
  updated: number;
  note: string | null;
  timeouts: number;
}

const sha = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

function result(r: GatewayMessage): SendFileResult {
  assert.equal(r.type, 'ack', JSON.stringify(r));
  return (r as Extract<GatewayMessage, { type: 'ack' }>).result as SendFileResult;
}

function refusal(r: GatewayMessage): string {
  assert.ok(r.type === 'error' && r.code === 'bad_request', JSON.stringify(r));
  return (r as Extract<GatewayMessage, { type: 'error' }>).text;
}

describe('M8 · посылки: агент отвечает файлами (0.3.3, P-23)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  let turn: number;
  let root: string;
  let parcels: string;
  let outside: string;
  const delivery = (id: number): DeliveryRow => q1<DeliveryRow>(s.home, 'SELECT * FROM deliveries WHERE id = ?', id)!;
  const docs = (chatId = OWNER.id): SentMessage[] => s.fake.sentTo(chatId).filter((m) => m.method === 'sendDocument');
  const put = (rel: string, content: string | Buffer): string => {
    const f = path.join(parcels, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    return f;
  };
  const says = async (text: string, from = OWNER): Promise<{ seq: number; update: number }> => {
    const u = s.fake.push(s.fake.builder.text(from, text))[0]!;
    const seq = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
    await ch.waitEvent(seq);
    await ch.delivered(seq);
    return { seq, update: u.update_id };
  };
  const sent = (id: number): Promise<DeliveryRow> => pump(gw, () => (delivery(id).status === 'sent' ? delivery(id) : null), { what: `доставки ${id}` });
  const docOf = (d: DeliveryRow): SentMessage => s.fake.sentTo(d.chat_id).find((m) => m.message_id === d.tg_message_id && m.method === 'sendDocument')!;
  const reconnect = async (): Promise<void> => {
    ({ ch, turn } = await connectAdapter(s.home));
  };
  const restart = async (env: Record<string, string> = {}): Promise<void> => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    gw = await s.start(env);
    await reconnect();
  };

  before(async () => {
    root = makeTempDir('parcels-');
    parcels = path.join(root, 'parcels');
    fs.mkdirSync(parcels);
    outside = makeTempDir('outside-');
    s = await setup({ home: { rules: RULES, extraConfig: `parcels: { dir: "${parcels}" }\n` } });
    gw = await s.start();
    await reconnect();
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('A8.1: send_file(seq) — документ ответом на просьбу, подпись, 👌; доставка sent с message_id; копия в raw/parcels; журнал send_file', async () => {
    const html = '<!doctype html><title>Отчёт</title><h1>Итоги недели</h1>';
    put('отчёт/report.html', html);
    const msg = s.fake.push(s.fake.builder.text(OWNER, 'пришли этот файл'))[0]!;
    const seq = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', msg.update_id)?.seq, 5000, 'приёма');
    await ch.waitEvent(seq);
    await ch.delivered(seq);
    const r = result(await ch.sendFile('отчёт/report.html', seq, turn, { caption: '**Отчёт** за неделю' }));
    assert.equal(r.status, 'queued');
    assert.deepEqual(
      { parcel: r.parcel, file: r.file, bytes: r.bytes, version: r.version, sent_before: r.sent_before, updated: r.updated, target: r.target, where: r.where },
      { parcel: 'отчёт', file: 'report.html', bytes: Buffer.byteLength(html), version: sha(html).slice(0, 8), sent_before: 0, updated: false, target: 'telegram', where: 'в чате Telegram' },
    );
    const d = await sent(r.delivery!);
    const m = docOf(d);
    assert.equal(m.document?.filename, 'report.html');
    assert.equal(m.document?.contentType, 'text/html');
    assert.equal(m.document?.data.toString('utf8'), html);
    assert.equal(m.caption, '<b>Отчёт</b> за неделю');
    assert.equal(m.parse_mode, 'HTML');
    assert.deepEqual(
      { target: d.target, chat: d.chat_id, seq: d.event_seq, sha: d.sha256, copy: d.copy_ref, url: d.url, updated: d.updated },
      { target: 'telegram', chat: OWNER.id, seq, sha: sha(html), copy: `raw/parcels/${sha(html)}`, url: null, updated: 0 },
    );
    assert.equal(fs.readFileSync(path.join(s.home.dir, d.copy_ref!), 'utf8'), html, 'копия в хранилище шлюза');
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status, 'processed');
    await pump(gw, () => reactionOf(s.fake, msg) === '👌' || null, { what: '👌' });
    assert.equal(q1<{ kind: string }>(s.home, 'SELECT kind FROM messages_out WHERE tg_message_id = ?', m.message_id)?.kind, 'agent');
    // Владелец ответил реплаем на документ — агенту видно, на какой файл (⟨предл.⟩).
    const re = s.fake.push(s.fake.builder.replyTo(OWNER, 'спасибо, гляну', m.message))[0]!;
    const reSeq = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', re.update_id)?.seq, 5000, 'реплая');
    const ev = await ch.waitEvent(reSeq);
    assert.deepEqual([ev.reply_to?.kind, ev.reply_to?.event_seq, ev.reply_to?.excerpt], ['agent', seq, 'файл отчёт/report.html: **Отчёт** за неделю']);
    await ch.done([reSeq]);
    const line = readJournal(s.home).find((l) => l.ev === 'send_file' && l.delivery === r.delivery)!;
    assert.deepEqual([line.parcel, line.file, line.sha256, line.chat], ['отчёт', 'report.html', sha(html), OWNER.id]);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'out' && l.delivery === r.delivery), 'out с доставкой');
  });

  it('A8.2: без seq — по своей инициативе в личку владельца, без подписи; полный путь внутри папки (и через realpath) тоже годится', async () => {
    const f = put('заметки/plan.md', '# План\n- раз\n- два\n');
    const r = result(await ch.sendFile(f, null, turn));
    const d = await sent(r.delivery!);
    assert.deepEqual([d.chat_id, d.event_seq, d.parcel, d.file], [OWNER.id, null, 'заметки', 'plan.md']);
    const m = docOf(d);
    assert.equal(m.caption, null);
    assert.equal(m.document?.contentType, 'text/markdown');
    // Тот же файл по настоящему пути (на macOS /var → /private/var) — та же посылка и файл.
    const r2 = result(await ch.sendFile(path.join(fs.realpathSync(parcels), 'заметки', 'plan.md'), null, turn));
    assert.deepEqual([r2.parcel, r2.file, r2.sent_before], ['заметки', 'plan.md', 1]);
    await sent(r2.delivery!);
  });

  it('A8.21 (проверка сведения 0.3.4, Ш-23): подпись документа целиком цитатой — «💬 » впереди (так выглядит расшифровка); цитата и свой текст — без пометки', async () => {
    put('цитата/a.txt', 'a');
    const whole = docOf(await sent(result(await ch.sendFile('цитата/a.txt', null, turn, { caption: '> купи хлеба и молока' })).delivery!));
    assert.equal(whole.caption, `${AGENT_MARK} <blockquote>купи хлеба и молока</blockquote>`);
    assert.ok(whole.caption!.startsWith('💬 <blockquote>'));
    assert.equal(whole.parse_mode, 'HTML');
    put('цитата/b.txt', 'b');
    const mixed = docOf(await sent(result(await ch.sendFile('цитата/b.txt', null, turn, { caption: '> купи хлеба\n\nЗаписал в заметки' })).delivery!));
    assert.ok(!mixed.caption!.startsWith(AGENT_MARK), `цитата и свой текст — на расшифровку не похоже: ${mixed.caption}`);
    assert.ok(mixed.caption!.startsWith('<blockquote>купи хлеба</blockquote>') && mixed.caption!.includes('Записал в заметки'), mixed.caption!);
  });

  it('A8.3: новая версия того же файла — «⚙ обновлено» последней строкой подписи; та же версия повторно — уходит снова, «уже отправлял»', async () => {
    const v2 = '<!doctype html><title>Отчёт</title><h1>Итоги недели</h1><p>поправки</p>';
    put('отчёт/report.html', v2);
    const r = result(await ch.sendFile('отчёт/report.html', null, turn, { caption: 'вторая версия' }));
    assert.deepEqual([r.updated, r.sent_before], [true, 0]);
    const m = docOf(await sent(r.delivery!));
    // multipart/form-data переводит строки полей в CRLF (так и у подписи голосового) — сверяем по строкам.
    assert.equal(m.caption?.replace(/\r\n/g, '\n'), 'вторая версия\n\n⚙ обновлено');
    assert.equal(m.document?.data.toString('utf8'), v2);
    // Та же версия ещё раз — не «обновлено»; агенту — сколько раз уже отправлял.
    const again = result(await ch.sendFile('отчёт/report.html', null, turn));
    assert.deepEqual([again.updated, again.sent_before], [false, 1]);
    const m2 = docOf(await sent(again.delivery!));
    assert.equal(m2.caption, null);
    // Одна версия — одна копия.
    assert.equal(delivery(again.delivery!).copy_ref, delivery(r.delivery!).copy_ref);
    assert.equal(count(s.home, "SELECT count(DISTINCT copy_ref) AS n FROM deliveries WHERE parcel = 'отчёт'"), 2);
  });

  it('A8.4: подпись длиннее 1024 знаков — документ без подписи, следом текст ответа; доставка sent', async () => {
    put('отчёт/data.csv', 'a,b\n1,2\n');
    const { seq } = await says('пришли таблицу с пояснением');
    const long = Array.from({ length: 220 }, (_, i) => `пункт${i}`).join(' ');
    assert.ok(long.length > 1024 && long.length < 4096);
    const r = result(await ch.sendFile('отчёт/data.csv', seq, turn, { caption: long }));
    const d = await sent(r.delivery!);
    const m = docOf(d);
    assert.equal(m.caption, null);
    const text = await pump(gw, () => s.fake.sentTo(OWNER.id).find((x) => x.text === long), { what: 'текста подписи' });
    assert.ok(text.message_id > m.message_id, 'текст — следом за документом');
    // Текст подписи подделка записывает до ответа шлюзу, а строку messages_out шлюз пишет после ответа — ждём её, а не
    // смотрим сразу (под нагрузкой полного прогона сразу видна одна строка из двух; найдено при сведении с 0.3.2).
    await pump(gw, () => count(s.home, 'SELECT count(*) AS n FROM messages_out WHERE outbox_id = ?', d.outbox_id!) === 2, {
      what: 'обеих частей в messages_out',
    });
  });

  it('A8.5: отказы словами — > 50 МБ, папка, скрытое, «..», чужой путь, симлинк и жёсткая ссылка наружу, нет файла, пустой, прямо в папке посылок; ничего не ушло', async () => {
    const { seq } = await says('скинь всё, что есть');
    const docsBefore = s.fake.callsOf('sendDocument').length;
    const rowsBefore = count(s.home, 'SELECT count(*) AS n FROM deliveries');
    fs.truncateSync(put('большой/архив.zip', ''), 50 * 1024 * 1024 + 1);
    put('.secret/key.txt', 'ключ');
    put('отчёт/.env', 'TOKEN=1');
    fs.writeFileSync(path.join(root, 'рядом.txt'), 'не посылка');
    fs.writeFileSync(path.join(outside, 'чужое.txt'), 'чужой файл');
    fs.symlinkSync(path.join(outside, 'чужое.txt'), path.join(parcels, 'отчёт', 'ссылка.txt'));
    fs.symlinkSync(outside, path.join(parcels, 'наружу'));
    fs.linkSync(path.join(outside, 'чужое.txt'), path.join(parcels, 'отчёт', 'жёсткая.txt'));
    put('отчёт/пустой.txt', '');
    put('россыпь.txt', 'без посылки');
    execFileSync('mkfifo', [path.join(parcels, 'отчёт', 'труба')]);
    put('отчёт/a\u200Bb.txt', 'невидимый знак в имени');
    const cases: Array<[string, RegExp]> = [
      ['большой/архив.zip', /50,0 МБ|больше 50 МБ/],
      ['отчёт', /папка: укажи файл в ней/],
      ['.secret/key.txt', /скрытые файлы/],
      ['отчёт/.env', /скрытые файлы/],
      ['../рядом.txt', /вне папки посылок/],
      ['отчёт/../../рядом.txt', /вне папки посылок/],
      [path.join(outside, 'чужое.txt'), /вне папки посылок/],
      ['/etc/hosts', /вне папки посылок/],
      ['отчёт/ссылка.txt', /ссылка за пределы папки посылок/],
      ['наружу/чужое.txt', /ссылка за пределы папки посылок/],
      ['отчёт/жёсткая.txt', /жёсткая ссылка/],
      ['отчёт/нет-такого.html', /нет файла/],
      ['отчёт/пустой.txt', /пустой файл/],
      ['россыпь.txt', /положи его в папку посылки/],
      ['отчёт/труба', /не обычный файл/],
      ['отчёт/a\u200Bb.txt', /управляющие или невидимые знаки/],
    ];
    for (const [p, why] of cases) assert.match(refusal(await ch.sendFile(p, seq, turn)), why, p);
    for (let i = 0; i < 3; i++) await gw.advance('1s');
    await sleep(50);
    assert.equal(s.fake.callsOf('sendDocument').length, docsBefore, 'в Telegram ничего не ушло');
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM deliveries'), rowsBefore, 'доставок нет');
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status, 'delivered', 'событие ждёт ответа');
    assert.equal(readJournal(s.home).filter((l) => l.ev === 'send_file_refused' && l.seq === seq).length, cases.length);
    assert.equal(fs.readdirSync(path.join(s.home.paths.raw, 'parcels')).filter((f) => f.endsWith('.tmp')).length, 0, 'временных копий нет');
    await ch.done([seq]);
  });

  it('A8.14: диск полон при записи копии — «диск шлюза полон», ничего не принято; иная ошибка записи (нет прав на raw/parcels) — unavailable, шлюз не падает', async () => {
    put('диск/a.txt', 'копия не запишется');
    const rows = count(s.home, 'SELECT count(*) AS n FROM deliveries');
    const flag = path.join(s.home.dir, 'test-disk-full');
    fs.writeFileSync(flag, 'files\n');
    const r = await ch.sendFile('диск/a.txt', null, turn);
    assert.ok(r.type === 'error' && r.code === 'unavailable' && /диск шлюза полон/.test(r.text), JSON.stringify(r));
    assert.ok(readJournal(s.home).some((l) => l.ev === 'disk_full' && l.where === 'send_file'));
    fs.rmSync(flag);
    // Место есть: принятое обновление кончает эпизод «диск полон» (disk.ts).
    const { seq } = await says('место освободилось');
    await ch.done([seq]);
    const store = path.join(s.home.paths.raw, 'parcels');
    fs.chmodSync(store, 0o500);
    try {
      const r2 = await ch.sendFile('диск/a.txt', null, turn);
      assert.ok(r2.type === 'error' && r2.code === 'unavailable' && /файл не принят: ошибка шлюза \(EACCES\)/.test(r2.text), JSON.stringify(r2));
      assert.ok(readJournal(s.home).some((l) => l.ev === 'send_file_failed'));
      assert.ok(gw.alive, 'шлюз не упал');
    } finally {
      fs.chmodSync(store, 0o700);
    }
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM deliveries'), rows, 'доставок нет');
    assert.deepEqual(fs.readdirSync(store).filter((f) => f.endsWith('.tmp')), [], 'временных копий нет');
    const ok = result(await ch.sendFile('диск/a.txt', null, turn));
    assert.equal(docOf(await sent(ok.delivery!)).document?.data.toString('utf8'), 'копия не запишется');
  });

  it('A8.6: другой чат — без разрешения отказ; parcels: true у правила чата в rules.yaml — уходит в тот чат; правка — строкой владельцу', async () => {
    put('отчёт/для-ани.txt', 'привет, Аня');
    const { seq } = await says('пришли мне отчёт', OTHER);
    assert.match(refusal(await ch.sendFile('отчёт/для-ани.txt', seq, turn)), /только в личку владельца.*parcels: true/);
    assert.equal(docs(OTHER.id).length, 0);
    // Владелец разрешает файлы в личках (правило private) — правкой rules.yaml; читается при перезапуске.
    fs.writeFileSync(s.home.paths.rules, fs.readFileSync(s.home.paths.rules, 'utf8').replace(/(role: личный ассистент)/, '$1\n    parcels: true'));
    await restart();
    await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text?.includes('файлы от агента в лички всех участников: нет → да')), { what: 'строки о правке правил' });
    const r = result(await ch.sendFile('отчёт/для-ани.txt', seq, turn));
    const d = await sent(r.delivery!);
    assert.equal(d.chat_id, OTHER.id);
    assert.equal(docOf(d).document?.data.toString('utf8'), 'привет, Аня');
  });

  it('A8.7: сбой Telegram — 5xx и обрыв: повтор той же копией; 429 — ждать; 400 — доставка failed с причиной', async () => {
    put('сбои/a.txt', 'первый');
    let n = s.fake.callsOf('sendDocument').length;
    s.fake.scenario({ method: 'sendDocument', nth: n + 1, reply: errors.serverError(502) });
    s.fake.scenario({ method: 'sendDocument', nth: n + 2, reply: reply.drop() });
    s.fake.scenario({ method: 'sendDocument', nth: n + 3, reply: errors.tooManyRequests(2) });
    const r = result(await ch.sendFile('сбои/a.txt', null, turn));
    const d = await sent(r.delivery!);
    assert.equal(s.fake.callsOf('sendDocument').length, n + 4, '502, обрыв, 429 — и четвёртая попытка');
    assert.equal(docOf(d).document?.data.toString('utf8'), 'первый');
    assert.equal(docs().filter((m) => m.document?.data.toString('utf8') === 'первый').length, 1, 'дошёл один раз');
    // 400 — Telegram не примет и при повторе: доставка не удалась, причина записана.
    put('сбои/b.txt', 'второй');
    n = s.fake.callsOf('sendDocument').length;
    s.fake.scenario({ method: 'sendDocument', nth: n + 1, reply: reply.error(400, 'Bad Request: wrong file identifier/HTTP URL specified') });
    const r2 = result(await ch.sendFile('сбои/b.txt', null, turn));
    const d2 = await pump(gw, () => (delivery(r2.delivery!).status === 'failed' ? delivery(r2.delivery!) : null), { what: 'failed' });
    assert.match(d2.note ?? '', /wrong file identifier/);
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM outbox WHERE id = ?', d2.outbox_id!)?.status, 'dropped');
    // Владелец узнаёт, что файла не будет (⟨предл.⟩; находка проверки: прежде — только журнал).
    await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text?.startsWith('⚙ файл сбои/b.txt не отправлен: Telegram не принял: 400 Bad Request: wrong file identifier')), {
      what: 'строки владельцу о неотправленном файле',
    });
    assert.ok(readJournal(s.home).some((l) => l.ev === 'parcel_failed' && (l.deliveries as number[]).includes(r2.delivery!)));
    s.fake.clearScenario();
  });

  it('A8.8: перезапуск шлюза — исходник удалён, уходит копия; убит в точке in_send — документ ещё раз, доставка одна', async () => {
    const f = put('перезапуск/итог.html', '<p>итог до правки</p>');
    const n = s.fake.callsOf('sendDocument').length;
    s.fake.scenario({ method: 'sendDocument', nth: n + 1, reply: errors.serverError(503) });
    const r = result(await ch.sendFile('перезапуск/итог.html', null, turn));
    await pump(gw, () => s.fake.callsOf('sendDocument').length > n || null, { what: 'первой попытки', step: '100ms' });
    await pump(gw, () => readJournal(s.home).some((l) => l.ev === 'send_deferred' && (l.outbox_ids as number[]).includes(delivery(r.delivery!).outbox_id!)) || null, { what: 'отложенной отправки', step: '100ms' });
    fs.rmSync(f);
    s.fake.clearScenario();
    await restart();
    const d = await sent(r.delivery!);
    assert.equal(docOf(d).document?.data.toString('utf8'), '<p>итог до правки</p>', 'ушла копия, а не файл агента');

    // Убит между отправкой и отметкой (точка in_send — по № обновления события): после старта документ уходит ещё раз.
    put('перезапуск/дважды.txt', 'как минимум один раз');
    const { seq, update } = await says('пришли ещё раз');
    result(await ch.reply(seq, 'сейчас пришлю', turn));
    await pump(gw, () => count(s.home, "SELECT count(*) AS n FROM outbox WHERE status = 'pending'") === 0 || null, { what: 'ответа' });
    await pump(gw, () => count(s.home, "SELECT count(*) AS n FROM reactions WHERE status = 'pending'") === 0 || null, { what: 'реакций' });
    await restart({ STG_FAULT: `in_send:${update}` });
    const before = s.fake.callsOf('sendDocument').length;
    const r2 = result(await ch.sendFile('перезапуск/дважды.txt', seq, turn));
    while (gw.alive) {
      await gw.advance('1s').catch(() => undefined);
      await sleep(15);
    }
    assert.equal((await gw.waitForExit()).code, 137);
    assert.equal(s.fake.callsOf('sendDocument').length, before + 1);
    assert.equal(delivery(r2.delivery!).status, 'pending');
    ch.close();
    gw = await s.start();
    await reconnect();
    const d2 = await sent(r2.delivery!);
    const both = docs().filter((m) => m.document?.data.toString('utf8') === 'как минимум один раз');
    assert.equal(both.length, 2, 'как минимум один раз: второй документ после падения');
    assert.equal(d2.tg_message_id, both[1]!.message_id);
    assert.equal(count(s.home, "SELECT count(*) AS n FROM deliveries WHERE file = 'дважды.txt'"), 1, 'доставка одна');
  });

  it('A8.9: дубль после обрыва канала — тот же ключ повтора (idem): второй доставки нет, исход тот же', async () => {
    put('дубль/a.txt', 'один раз');
    const r = result(await ch.sendFile('дубль/a.txt', null, turn, { idem: 'dup_key_1' }));
    ch.destroy();
    await reconnect();
    const again = result(await ch.sendFile('дубль/a.txt', null, turn, { idem: 'dup_key_1' }));
    assert.equal(again.delivery, r.delivery);
    await sent(r.delivery!);
    for (let i = 0; i < 3; i++) await gw.advance('1s');
    await sleep(50);
    assert.equal(docs().filter((m) => m.document?.data.toString('utf8') === 'один раз').length, 1);
    assert.equal(count(s.home, "SELECT count(*) AS n FROM deliveries WHERE idem = 'dup_key_1'"), 1);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'send_file_repeated' && l.delivery === r.delivery));
  });

  it('A8.10: чистка копий — старше срока удалена, строка доставки осталась; без ссылки — удалена; ждущая доставка копию держит', async () => {
    const store = path.join(s.home.paths.raw, 'parcels');
    const first = q1<DeliveryRow>(s.home, "SELECT * FROM deliveries WHERE parcel = 'отчёт' AND file = 'report.html' ORDER BY id LIMIT 1")!;
    assert.ok(fs.existsSync(path.join(s.home.dir, first.copy_ref!)));
    fs.writeFileSync(path.join(store, '0'.repeat(64)), 'без ссылки');
    fs.writeFileSync(path.join(store, '.copy.1.2.tmp'), 'недописанная');
    // Ждущая доставка: Telegram отвечает 502 на всё.
    put('держит/a.txt', 'ждёт отправки');
    const n = s.fake.callsOf('sendDocument').length;
    s.fake.scenario({ method: 'sendDocument', from: n + 1, times: 10_000, reply: errors.serverError(502) });
    const pending = result(await ch.sendFile('держит/a.txt', null, turn));
    await pump(gw, () => s.fake.callsOf('sendDocument').length > n || null, { what: 'попытки' });
    const pendingCopy = delivery(pending.delivery!).copy_ref!;
    const n0 = readJournal(s.home).filter((l) => l.ev === 'retention').length;
    await gw.jump('91d');
    const rep = await waitUntil(() => readJournal(s.home).filter((l) => l.ev === 'retention')[n0], 10_000, 'чистки');
    assert.ok(Number(rep.parcelCopies) >= 3, JSON.stringify(rep));
    const after = delivery(first.id);
    assert.equal(after.copy_ref, null, 'ссылка снята');
    assert.deepEqual([after.status, after.sha256, after.file], ['sent', first.sha256, 'report.html'], 'строка доставки осталась');
    assert.ok(!fs.existsSync(path.join(s.home.dir, first.copy_ref!)), 'копия удалена');
    assert.ok(!fs.existsSync(path.join(store, '0'.repeat(64))), 'без ссылки — удалена');
    assert.ok(!fs.existsSync(path.join(store, '.copy.1.2.tmp')), 'временная — удалена');
    assert.equal(delivery(pending.delivery!).copy_ref, pendingCopy);
    assert.ok(fs.existsSync(path.join(s.home.dir, pendingCopy)), 'ждущая доставка копию держит');
    s.fake.clearScenario();
    const d = await sent(pending.delivery!);
    assert.equal(docOf(d).document?.data.toString('utf8'), 'ждёт отправки');
  });

  it('A8.15: чужой файл (from) — «↪ Имя» на документе всегда: с подписью, без подписи и с подписью длиннее 1024 (находка проверки)', async () => {
    put('чужое/researcher.md', '# от Исследователя');
    const r1 = result(await ch.sendFile('чужое/researcher.md', null, turn, { caption: 'итоги', from: 'Исследователь' }));
    const m1 = docOf(await sent(r1.delivery!));
    assert.deepEqual([m1.caption, m1.parse_mode], ['↪ Исследователь: итоги', 'HTML']);
    // Без подписи — подпись «↪ Исследователь»: иначе чужой файл пришёл бы как собственный файл агента.
    const r2 = result(await ch.sendFile('чужое/researcher.md', null, turn, { from: 'Исследователь' }));
    assert.equal(docOf(await sent(r2.delivery!)).caption, '↪ Исследователь');
    // Подпись длиннее 1024 — на документе «↪ Исследователь», следом текст с «↪ Исследователь: ».
    const long = Array.from({ length: 220 }, (_, i) => `строка${i}`).join(' ');
    const r3 = result(await ch.sendFile('чужое/researcher.md', null, turn, { caption: long, from: 'Исследователь' }));
    const d3 = await sent(r3.delivery!);
    assert.equal(docOf(d3).caption, '↪ Исследователь');
    const text = await pump(gw, () => s.fake.sentTo(OWNER.id).find((x) => x.text === `↪ Исследователь: ${long}`), { what: 'текста подписи с пометкой' });
    assert.ok(text.message_id > d3.tg_message_id!);
    // Новая версия чужого файла без подписи — и имя, и «обновлено».
    put('чужое/researcher.md', '# от Исследователя, вторая версия');
    const r4 = result(await ch.sendFile('чужое/researcher.md', null, turn, { from: 'Исследователь' }));
    assert.equal(docOf(await sent(r4.delivery!)).caption?.replace(/\r\n/g, '\n'), '↪ Исследователь\n\n⚙ обновлено');
  });

  it('A8.16: пауза — файл без seq придержан (held_paused), доставка ждёт; «продолжить» — документ уходит', async () => {
    put('пауза/a.txt', 'после паузы');
    s.fake.push(s.fake.builder.text(OWNER, 'пауза'));
    await waitUntil(() => meta(s.home, 'mode') === 'paused' || null, 5000, 'паузы');
    const r = result(await ch.sendFile('пауза/a.txt', null, turn));
    assert.equal(r.status, 'held_paused');
    for (let i = 0; i < 3; i++) await gw.advance('1s');
    await sleep(50);
    const d = delivery(r.delivery!);
    assert.equal(d.status, 'pending');
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM outbox WHERE id = ?', d.outbox_id!)?.status, 'held');
    assert.equal(docs().filter((m) => m.document?.data.toString('utf8') === 'после паузы').length, 0, 'в паузе не ушло');
    s.fake.push(s.fake.builder.text(OWNER, 'продолжить'));
    await waitUntil(() => meta(s.home, 'mode') === 'running' || null, 5000, 'снятия паузы');
    assert.equal(docOf(await sent(r.delivery!)).document?.data.toString('utf8'), 'после паузы');
  });

  it('A8.17: медленная сеть — загрузка трижды не успела за предел: доставка failed «не успел загрузить», строка владельцу, больше попыток нет', async () => {
    // Предел запроса документа под тестом — 300 мс настоящего времени (у шлюза — минута + время на 1 Мбит/с).
    await restart({ STG_TEST_DOCUMENT_TIMEOUT_MS: '300' });
    put('медленно/big.bin', 'x'.repeat(4096));
    const n = s.fake.callsOf('sendDocument').length;
    s.fake.scenario({ method: 'sendDocument', from: n + 1, times: 3, reply: reply.hang() });
    const r = result(await ch.sendFile('медленно/big.bin', null, turn));
    const d = await pump(gw, () => (delivery(r.delivery!).status === 'failed' ? delivery(r.delivery!) : null), { what: 'failed', settleMs: 50 });
    assert.match(d.note ?? '', /не успел загрузить: 3 попытки кончились таймаутом — медленная сеть/);
    assert.equal(d.timeouts, 3);
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM outbox WHERE id = ?', d.outbox_id!)?.status, 'dropped');
    await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text?.startsWith('⚙ файл медленно/big.bin не отправлен: не успел загрузить')), { what: 'строки владельцу' });
    s.fake.clearScenario();
    for (let i = 0; i < 40; i++) await gw.advance('1s');
    await sleep(50);
    assert.equal(s.fake.callsOf('sendDocument').length, n + 3, 'три попытки — и всё: очередь не занята без конца');
    await restart();
  });

  it('A9.16 (сведение 0.3.4 поверх 0.3.3): реакция владельца на документ посылки — событие реакции, как на текстовый ответ (с seq — «к № M», без seq — «на твоё сообщение»; начало — «файл …: подпись»); на строку «⚙ файл … не отправлен» — нет', async () => {
    put('реакции/итог.md', '# Итог\n');
    const { seq } = await says('скинь итог файлом');
    const r = result(await ch.sendFile('реакции/итог.md', seq, turn, { caption: 'Вот итог недели' }));
    const doc = docOf(await sent(r.delivery!));
    const outboxId = delivery(r.delivery!).outbox_id!;
    assert.deepEqual(
      { ...q1<{ kind: string; origin: string }>(s.home, 'SELECT m.kind, o.origin FROM messages_out m JOIN outbox o ON o.id = m.outbox_id WHERE m.chat_id = ? AND m.tg_message_id = ?', OWNER.id, doc.message_id) },
      { kind: 'agent', origin: 'agent' },
      'документ посылки — сообщение агента',
    );
    const u = s.fake.push(s.fake.builder.reaction(OWNER, doc.message.chat, doc.message_id, ['👍']))[0]!;
    const rSeq = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'события реакции');
    // Окно отмены реакции (0.3.4, issue #46): агенту — через 3 с.
    await gw.advance('3s');
    const e = await ch.waitEvent(rSeq);
    const reaction = { to_seq: seq, emoji: ['👍'], old: [], excerpt: 'файл реакции/итог.md: Вот итог недели' };
    assert.deepEqual({ kind: e.kind, trust: e.trust, reaction: e.reaction, text: e.text }, { kind: 'text', trust: 'owner', reaction, text: ownerReactionText(reaction) });
    const row = q1<{ kind: string; reaction_json: string }>(s.home, 'SELECT kind, reaction_json FROM events WHERE seq = ?', rSeq)!;
    assert.equal(row.kind, 'reaction');
    assert.deepEqual(JSON.parse(row.reaction_json) as OwnerReaction, { message_id: doc.message_id, outbox_id: outboxId, ...reaction });
    await ch.done([rSeq]);
    // Документ по своей инициативе, без подписи: «на твоё сообщение», начало — имя файла.
    put('реакции/план.txt', 'план');
    const r2 = result(await ch.sendFile('реакции/план.txt', null, turn));
    const doc2 = docOf(await sent(r2.delivery!));
    const u2 = s.fake.push(s.fake.builder.reaction(OWNER, doc2.message.chat, doc2.message_id, ['🙏']))[0]!;
    const rSeq2 = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u2.update_id)?.seq, 5000, 'события реакции');
    await gw.advance('3s');
    const e2 = await ch.waitEvent(rSeq2);
    assert.deepEqual(e2.reaction, { to_seq: null, emoji: ['🙏'], old: [], excerpt: 'файл реакции/план.txt' });
    assert.equal(e2.text, 'Реакция на твоё сообщение: 🙏 — твой ответ: «файл реакции/план.txt»');
    await ch.done([rSeq2]);
    // Строка шлюза о неотправленном файле (A8.7) — не ответ агента: без события.
    const failed = s.fake.sentTo(OWNER.id).find((m) => m.text?.startsWith('⚙ файл сбои/b.txt не отправлен'))!;
    const u3 = s.fake.push(s.fake.builder.reaction(OWNER, failed.message.chat, failed.message_id, ['👎']))[0]!;
    await waitUntil(() => q1<{ status: string }>(s.home, 'SELECT status FROM updates WHERE update_id = ?', u3.update_id)?.status === 'ignored' || null, 5000, 'ignored');
    const j = await waitUntil(() => readJournal(s.home).find((l) => l.ev === 'reaction_skipped' && l.update_id === u3.update_id), 5000, 'reaction_skipped');
    assert.equal(j.reason, 'gateway_line');
  });

  it('A8.11: «стоп» — ждущая доставка dropped, документ не уходит; в стопе — dropped_stopped без копии и доставки; старый ход — dropped_stale_turn', async () => {
    put('стоп/a.txt', 'не уйдёт');
    const n = s.fake.callsOf('sendDocument').length;
    // Telegram не принимает документ, пока не придёт «стоп»: доставка ждёт повтора.
    s.fake.scenario({ method: 'sendDocument', from: n + 1, times: 10_000, reply: errors.serverError(502) });
    const r = result(await ch.sendFile('стоп/a.txt', null, turn));
    await pump(gw, () => s.fake.callsOf('sendDocument').length > n || null, { what: 'первой попытки' });
    s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
    await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text === STOPPED_TEXT), { what: '«Остановлен»' });
    const d = delivery(r.delivery!);
    assert.deepEqual([d.status, d.note], ['dropped', 'стоп']);
    await sleep(50);
    const calls = s.fake.callsOf('sendDocument').length;
    s.fake.clearScenario();
    for (let i = 0; i < 40; i++) await gw.advance('1s');
    await sleep(50);
    assert.equal(s.fake.callsOf('sendDocument').length, calls, 'после стопа документ не уходит');
    assert.equal(docs().filter((m) => m.document?.data.toString('utf8') === 'не уйдёт').length, 0);
    assert.ok(readJournal(s.home).some((l) => l.ev === 'replies_dropped' && l.deliveries === 1));
    const rows = count(s.home, 'SELECT count(*) AS n FROM deliveries');
    const newTurn = await waitUntil(() => ch.currentTurn() !== turn && ch.currentTurn(), 5000, 'нового хода');
    assert.equal(result(await ch.sendFile('стоп/a.txt', null, turn)).status, 'dropped_stale_turn');
    assert.equal(result(await ch.sendFile('стоп/a.txt', null, newTurn)).status, 'dropped_stopped');
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM deliveries'), rows, 'ни доставки, ни копии');
    assert.deepEqual(
      readJournal(s.home).filter((l) => l.ev === 'send_file_dropped').map((l) => l.reason),
      ['stale_turn', 'stopped'],
    );
    // Сверка: у каждой доставки — своя строка outbox агента в том же чате.
    for (const row of q<DeliveryRow>(s.home, 'SELECT * FROM deliveries')) {
      assert.equal(q1<{ chat_id: number }>(s.home, "SELECT chat_id FROM outbox WHERE id = ? AND origin = 'agent'", row.outbox_id!)?.chat_id, row.chat_id);
    }
  });
});

describe('M8 · папка посылок по умолчанию и цели доставки (0.3.3)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  let turn: number;
  let agentDir: string;
  const connect = async (): Promise<void> => {
    ch = await FakeChannel.connect(s.home.paths.socket);
    const w = await ch.hello({ cwd: agentDir });
    assert.equal(w.type, 'welcome', JSON.stringify(w));
    turn = (w as Extract<GatewayMessage, { type: 'welcome' }>).turn;
    await ch.waitVerified();
  };
  before(async () => {
    agentDir = makeTempDir('agent-');
    s = await setup();
    gw = await s.start();
    await connect();
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('A8.12: по умолчанию — <каталог сессии агента>/parcels; нет её — отказ «создай»; есть — уходит', async () => {
    const parcels = path.join(agentDir, 'parcels');
    assert.match(refusal(await ch.sendFile('итог/a.txt', null, turn)), new RegExp(`папки посылок нет: ${parcels.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — создай её`));
    fs.mkdirSync(path.join(parcels, 'итог'), { recursive: true });
    fs.writeFileSync(path.join(parcels, 'итог', 'a.txt'), 'из папки агента');
    const r = result(await ch.sendFile('итог/a.txt', null, turn));
    const d = await pump(gw, () => q1<{ status: string; tg_message_id: number }>(s.home, "SELECT status, tg_message_id FROM deliveries WHERE id = ? AND status = 'sent'", r.delivery!), { what: 'доставки' });
    assert.equal(s.fake.sentTo(OWNER.id).find((m) => m.message_id === d.tg_message_id)?.document?.data.toString('utf8'), 'из папки агента');
  });

  it('A8.12: цель не подключена в этой версии (web) — отказ; цель выключена в parcels.targets — отказ', async () => {
    assert.match(refusal(await ch.sendFile('итог/a.txt', null, turn, { target: 'web' })), /цель «web» не подключена в этой версии шлюза: есть telegram/);
    ch.close();
    await gw.stop();
    fs.appendFileSync(path.join(s.home.dir, 'config.yaml'), 'parcels: { targets: [] }\n');
    gw = await s.start();
    await connect();
    assert.match(refusal(await ch.sendFile('итог/a.txt', null, turn)), /цель «telegram» выключена: её нет в parcels\.targets/);
  });
});

describe('M8 · «стоп» и документ в пути (0.3.3; находка проверки)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  let turn: number;
  let parcels: string;
  const delivery = (id: number): DeliveryRow => q1<DeliveryRow>(s.home, 'SELECT * FROM deliveries WHERE id = ?', id)!;
  const put = (rel: string, content: string): void => {
    const f = path.join(parcels, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  };
  const stopLines = (): SentMessage[] => s.fake.sentTo(OWNER.id).filter((m) => m.text === STOPPED_TEXT);
  /** «стоп» владельца → строка «⚙ Остановлен»; [продолжить] — снова running, новый ход у канала. */
  const stop = async (): Promise<SentMessage> => {
    const before = stopLines().length;
    s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
    return pump(gw, () => stopLines()[before], { what: '«Остановлен»' });
  };
  const resume = async (line: SentMessage): Promise<void> => {
    assert.equal(await press(s, line, 'продолжить'), null);
    await waitUntil(() => meta(s.home, 'mode') === 'running' || null, 5000, 'снятия стопа');
    const t = Number(meta(s.home, 'turn'));
    turn = await waitUntil(() => (ch.currentTurn() === t ? t : null), 5000, 'нового хода у канала');
  };

  before(async () => {
    const root = makeTempDir('parcels-stop-');
    parcels = path.join(root, 'parcels');
    fs.mkdirSync(parcels);
    s = await setup({ home: { rules: RULES, extraConfig: `parcels: { dir: "${parcels}" }\n` } });
    gw = await s.start();
    ({ ch, turn } = await connectAdapter(s.home));
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('A8.18: «стоп», пока документ загружается, — загрузка прервана, «⚙ Остановлен» её не ждёт; доставка dropped «мог уйти», повтора нет; тот же ключ — «брошен стопом»', async () => {
    put('стоп/big.bin', 'y'.repeat(4096));
    const n = s.fake.callsOf('sendDocument').length;
    // Telegram «принимает» документ без конца (медленная сеть): без прерывания очередь стояла бы до предела запроса.
    s.fake.scenario({ method: 'sendDocument', nth: n + 1, reply: reply.hang() });
    const r = result(await ch.sendFile('стоп/big.bin', null, turn, { idem: 'stop_upload_1' }));
    await pump(gw, () => s.fake.callsOf('sendDocument').length > n || null, { what: 'начала загрузки', step: '100ms' });
    const t0 = Date.now();
    const line = await stop();
    assert.ok(Date.now() - t0 < 15_000, `«Остановлен» пришёл через ${Date.now() - t0} мс`);
    const d = await waitUntil(() => (delivery(r.delivery!).note === PARCEL_NOTE_STOP_UPLOAD ? delivery(r.delivery!) : null), 5000, 'пометки «мог уйти»');
    assert.equal(d.status, 'dropped');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'send_cancelled' && l.during === 'upload' && l.outbox_id === d.outbox_id));
    s.fake.clearScenario();
    for (let i = 0; i < 40; i++) await gw.advance('1s');
    await sleep(50);
    assert.equal(s.fake.callsOf('sendDocument').length, n + 1, 'прерванный документ не повторяется');
    // Повтор того же вызова с тем же ключом (обрыв канала) — исход первого: брошен «стопом», второй доставки нет.
    const again = result(await ch.sendFile('стоп/big.bin', null, turn, { idem: 'stop_upload_1' }));
    assert.deepEqual([again.repeated, again.status, again.delivery, again.version], [true, 'dropped_stopped', r.delivery, r.version]);
    await resume(line);
  });

  it('A8.19: документ дошёл, а текст подписи следом — нет (400 · «стоп» между частями): доставка sent с номером документа, строки «не отправлен» нет', async () => {
    const long = (tag: string): string => Array.from({ length: 220 }, (_, i) => `${tag}${i}`).join(' ');
    // 400 на текст подписи: строка outbox брошена, но документ уже у владельца.
    put('подпись/a.csv', 'a,b\n1,2\n');
    const t400 = long('четыреста');
    s.fake.scenario({ method: 'sendMessage', when: (p) => p.text === t400, reply: reply.error(400, 'Bad Request: message is too long') });
    const r1 = result(await ch.sendFile('подпись/a.csv', null, turn, { caption: t400 }));
    const o1 = delivery(r1.delivery!).outbox_id!;
    await pump(gw, () => q1<{ status: string }>(s.home, 'SELECT status FROM outbox WHERE id = ?', o1)?.status === 'dropped' || null, { what: 'брошенного текста' });
    const d1 = delivery(r1.delivery!);
    assert.equal(d1.status, 'sent');
    assert.equal(s.fake.sentTo(OWNER.id).find((m) => m.message_id === d1.tg_message_id)?.method, 'sendDocument');
    // «стоп», пока текст подписи ждёт повтора (502): документ у владельца — доставка sent, не dropped.
    put('подпись/b.csv', 'c,d\n3,4\n');
    const t502 = long('пятьсотдва');
    s.fake.scenario({ method: 'sendMessage', when: (p) => p.text === t502, times: 10_000, reply: errors.serverError(502) });
    const r2 = result(await ch.sendFile('подпись/b.csv', null, turn, { caption: t502 }));
    const d2 = await pump(gw, () => (delivery(r2.delivery!).status === 'sent' ? delivery(r2.delivery!) : null), { what: 'документа' });
    await pump(gw, () => s.fake.calls.some((c) => c.method === 'sendMessage' && c.params.text === t502) || null, { what: 'попытки текста' });
    const line = await stop();
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM outbox WHERE id = ?', d2.outbox_id!)?.status, 'dropped');
    assert.deepEqual([delivery(r2.delivery!).status, delivery(r2.delivery!).tg_message_id], ['sent', d2.tg_message_id], 'документ дошёл — доставка sent');
    s.fake.clearScenario();
    for (let i = 0; i < 40; i++) await gw.advance('1s');
    await sleep(50);
    assert.ok(!s.fake.sentTo(OWNER.id).some((m) => m.text === t502), 'текст после стопа не ушёл');
    assert.ok(!s.fake.sentTo(OWNER.id).some((m) => m.text?.startsWith('⚙ файл подпись/')), 'строки «не отправлен» нет: документ дошёл');
    await resume(line);
  });
});
