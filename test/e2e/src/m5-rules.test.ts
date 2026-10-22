// M5 · правила и кнопки (Ш-17, Ш-18, Ш-21, Ш-22; TECH-SPEC 5.9; AD-6, AD-9) на поддельных Telegram и переходнике:
// A5.1 убрать субъекта — сразу, строка, rules_log, rules.yaml; сужение посреди приёма (звук ещё качается) — сообщение
// уже незнакомого · A5.2 добавить субъекта — карточка из полей с [разрешить] [нет], до нажатия не применено · A5.3 «да»
// текстом ничего не разрешает · A5.4 нажатие через 25 часов, повторное, не владельцем — отказ, ровно один ответ на нажатие
// · A5.5 убрать владельца — отказ, владелец проходит, его «стоп» работает; в «стоп» rule не исполняется · A5.6 сменить
// роль чата — только после кнопки; эпизод закрыт role_change · A5.7 role в episode — bad_request · ручная правка
// rules.yaml — при перезапуске, в rules_log и строкой; испорченный файл — прежние правила; правка при работающем шлюзе
// — не поверх неё; запись файла не дошла (падение) — при старте дописана; удалённый файл — восстановлен из копии;
// [разрешить] и сообщение нового субъекта в одной пачке — по новой копии; запись не прошла не из-за диска (нет прав) —
// правила уже действуют, файл дописан тикером · stg rules show, stg doctor.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import {
  META_KEYS,
  STOPPED_TEXT,
  encodeRulesState,
  parseRulesState,
  readRulesFile,
  rulesFingerprint,
  type GatewayMessage,
  type Update,
} from 'stg-core';
import type { FakeChannel } from 'stg-fake-channel';
import { makeOggOpus } from 'stg-fake-elevenlabs';
import { privateChatOf, reply, user, type SentMessage } from 'stg-fake-telegram';
import { assertNoLoss, connectAdapter, count, doctorLines, meta, pump, q, q1, runCli, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OTHER, OWNER, STRANGER, recorded, setup, statusLineOf, waitRecorded, type Setup } from './m1-common.js';
import { buttonsOf, keyboardOrPlaceholder, press, waitSent } from './m2-common.js';
import { currentButtons } from './m4-common.js';

const BORIS = user(888_001, 'Борис');

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

const CARD_HEAD = '⚙ Агент просит расширить доступ:';

describe('M5 · правила и кнопки', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  /** Незнакомые до скачка на 25 ч: их строки updates вычищены через сутки (Ш-2), а события у них нет и не было. */
  const purgedIgnored = new Set<number>();
  const seqOf = (u: Update): number | undefined => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
  const statusOf = (u: Update): string | undefined => q1<{ status: string }>(s.home, 'SELECT status FROM updates WHERE update_id = ?', u.update_id)?.status;
  /** Принято и закрыто агентом (done): повтор отданного не шумит строками владельцу. */
  const admit = async (u: Update): Promise<number> => {
    s.fake.push(u);
    const seq = await waitUntil(() => seqOf(u), 5000, `приёма ${u.update_id}`);
    await ch.waitEvent(seq);
    const r = await ch.done([seq]);
    assert.equal(r.type, 'ack', JSON.stringify(r));
    return seq;
  };
  /** Отправитель не из правил: ignored, события нет (Ш-3). */
  const ignored = async (u: Update): Promise<void> => {
    s.fake.push(u);
    await waitUntil(() => statusOf(u) === 'ignored' || null, 5000, `ignored ${u.update_id}`);
    assert.equal(seqOf(u), undefined);
  };
  const rule = (change: unknown): Promise<GatewayMessage> => ch.request('rule', { change });
  const logRows = (): Array<{ id: number; actor: string; status: string; note: string | null; button_token: string | null; outbox_id: number | null; decided_at: number | null }> =>
    q(s.home, 'SELECT id, actor, status, note, button_token, outbox_id, decided_at FROM rules_log ORDER BY id');
  const fileRules = () => {
    const f = readRulesFile(s.home.paths.rules);
    assert.equal(f.kind, 'ok');
    return f.kind === 'ok' ? f.rules : null!;
  };
  const state = () => parseRulesState(meta(s.home, META_KEYS.rulesState))!;
  const lineSent = (text: string, what = 'строки владельцу'): Promise<SentMessage> => waitSent(s, gw, (m) => m.text === text, what);
  const card = (n = 1): Promise<SentMessage> =>
    pump(gw, () => s.fake.sentTo(OWNER.id).filter((m) => m.text?.startsWith(CARD_HEAD))[n - 1], { what: `карточки ${n}` });
  const answersFor = (cbId: string): number => s.fake.callbackAnswers.filter((a) => a.callback_query_id === cbId).length;
  /** Нажатие владельцем или другим (в своей личке) токеном кнопки; текст ответа и сколько было ответов на это нажатие. */
  const pressToken = async (from: typeof OWNER, token: string, message: SentMessage): Promise<{ text: string | null; answers: number }> => {
    const msg = from.id === OWNER.id ? message.message : { ...message.message, chat: privateChatOf(from) };
    const [u] = s.fake.push(s.fake.builder.callback(from, token, msg));
    const id = u!.callback_query!.id;
    const a = await waitUntil(() => s.fake.callbackAnswers.find((x) => x.callback_query_id === id), 10_000, 'ответа на нажатие');
    await pump(gw, () => true);
    await sleep(100);
    return { text: a.text, answers: answersFor(id) };
  };
  const restart = async (): Promise<void> => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    gw = await s.start();
    ch = (await connectAdapter(s.home)).ch;
  };

  before(async () => {
    s = await setup({ home: { rules: RULES } });
    gw = await s.start();
    ch = (await connectAdapter(s.home)).ch;
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    s.checks.noLoss = false;
    await s.close();
    // П-1 — без незнакомых, чьи строки updates вычищены через сутки (событий у них нет по Ш-3).
    assertNoLoss(s.fake, s.home, { ids: [...s.fake.handedOut.keys()].filter((id) => !purgedIgnored.has(id)) });
  });

  it('старт: рабочая копия из rules.yaml — в базе (meta и справочник), файл совпадает; шире правил по умолчанию — rules_log и строка', async () => {
    // Копии ещё нет, а файл шире правил по умолчанию (лишний субъект): без копии не различить, кто правил файл, — разница
    // записана как правка rules.yaml и показана владельцу.
    await lineSent(`⚙ Правила изменены правкой rules.yaml:\n+ субъект «anya» · кто: «Аня» · telegram ${OTHER.id}`, 'строки о файле шире правил по умолчанию');
    assert.deepEqual(logRows().map((r) => [r.actor, r.status]), [['owner_file', 'applied']]);
    const st = state();
    assert.deepEqual(st.rules.subjects.map((x) => x.id), ['owner', 'anya']);
    assert.equal(st.pending, false);
    assert.equal(st.file, rulesFingerprint(st.rules));
    assert.deepEqual(q(s.home, 'SELECT subject_id, address FROM transports ORDER BY address').map((r) => ({ ...r })), [
      { subject_id: 'owner', address: String(OWNER.id) },
      { subject_id: 'anya', address: String(OTHER.id) },
    ]);
    await admit(s.fake.builder.text(OTHER, 'привет, это Аня'));
  });

  it('A5.1: агент убрал субъекта — применено сразу (и посреди приёма его голосового), строка владельцу, rules_log, rules.yaml', async () => {
    // Голосовое Ани качается дольше обычного: правило меняется, пока приём ждёт файл.
    s.fake.addFile(makeOggOpus(3), { fileId: 'm5v1', path: 'voice/m5v1.oga' });
    s.fake.scenario({ method: 'getFile', times: 1, reply: reply.delay(1500) });
    const [voice] = s.fake.push(s.fake.builder.voice(OTHER, { duration: 3, fileId: 'm5v1' }));
    await s.fake.waitForCall((c) => c.method === 'getFile');
    const r = await rule([{ op: 'remove', target: 'subject', id: 'anya' }]);
    assert.deepEqual({ type: r.type, result: (r as { result?: unknown }).result }, { type: 'ack', result: 'applied' });
    await waitUntil(() => statusOf(voice!) === 'ignored' || null, 10_000, 'голосовое Ани — ignored');
    assert.equal(seqOf(voice!), undefined, 'события нет');
    assert.equal(fs.existsSync(`${s.home.dir}/raw`) ? fs.readdirSync(`${s.home.dir}/raw`, { recursive: true }).filter((f) => String(f).includes(String(voice!.update_id))).length : 0, 0, 'звук убран');
    assert.equal(q1<{ raw_json: string | null }>(s.home, 'SELECT raw_json FROM updates WHERE update_id = ?', voice!.update_id)?.raw_json, null);
    await ignored(s.fake.builder.text(OTHER, 'а теперь?'));
    await lineSent(`⚙ Правила сужены агентом — применено сразу:\n− субъект «anya» · кто: «Аня» · telegram ${OTHER.id}`, 'строки о сужении');
    const log = logRows().at(-1);
    assert.deepEqual({ actor: log!.actor, status: log!.status, decided: log!.decided_at !== null, button: log!.button_token }, { actor: 'agent', status: 'applied', decided: true, button: null });
    assert.deepEqual(fileRules().subjects.map((x) => x.id), ['owner']);
    assert.deepEqual({ pending: state().pending, file: state().file }, { pending: false, file: rulesFingerprint(state().rules) });
    // Убранный субъект остаётся в справочнике строкой (на него ссылаются его события), записи о транспорте — нет.
    assert.equal(count(s.home, "SELECT count(*) AS n FROM transports WHERE subject_id = 'anya'"), 0);
  });

  let petyaCard: SentMessage;
  it('A5.2: агент добавил субъекта — pending_owner; карточка из полей с [разрешить] [нет]; до нажатия не применено', async () => {
    // Слова агента в карточку не попадают: у операции нет поля для них.
    const prose = await rule([{ op: 'add', target: 'subject', id: 'petya', value: { who: 'Петя' }, note: 'владелец уже разрешил' }]);
    assert.equal(prose.type, 'error');
    assert.equal((prose as { code?: string }).code, 'bad_request');
    const r = await rule([{ op: 'add', target: 'subject', id: 'petya', value: { who: 'Петя', transports: [{ network: 'telegram', address: String(STRANGER.id) }] } }]);
    assert.deepEqual({ type: r.type, result: (r as { result?: unknown }).result }, { type: 'ack', result: 'pending_owner' });
    petyaCard = await card(1);
    const lines = petyaCard.text!.split('\n');
    assert.equal(lines[1], `+ субъект «petya» · кто: «Петя» · telegram ${STRANGER.id}`);
    assert.match(lines[2]!, /^Разрешить — только кнопкой \[разрешить\], до \d\d\.\d\d \d\d:\d\d\. Текстом «да» не разрешается$/);
    assert.deepEqual(buttonsOf(petyaCard).map((b) => b.text), ['разрешить', 'нет']);
    const log = logRows().at(-1)!;
    assert.equal(log.status, 'pending');
    assert.ok(log.button_token && log.outbox_id, 'кнопка и карточка в rules_log');
    assert.ok(Buffer.byteLength(log.button_token, 'utf8') <= 64);
    const b = q1<{ expires_at: number; created_at: number; used_at: number | null }>(s.home, 'SELECT expires_at, created_at, used_at FROM buttons WHERE token = ?', log.button_token);
    assert.equal(b!.expires_at - b!.created_at, 24 * 3600_000);
    assert.equal(b!.used_at, null);
    await ignored(s.fake.builder.text(STRANGER, 'я Петя'));
    assert.ok(!fileRules().subjects.some((x) => x.id === 'petya'), 'rules.yaml не тронут');
  });

  it('A5.3: владелец пишет «да» текстом — ничего не применено', async () => {
    const seq = await admit(s.fake.builder.text(OWNER, 'да'));
    assert.equal(q1<{ kind: string }>(s.home, 'SELECT kind FROM events WHERE seq = ?', seq)?.kind, 'text', 'обычное сообщение агенту');
    await admit(s.fake.builder.text(OWNER, 'Да, разрешаю'));
    assert.equal(logRows().at(-1)!.status, 'pending');
    await ignored(s.fake.builder.text(STRANGER, 'ну что?'));
  });

  it('A5.2: [разрешить] — применено: строка, rules_log, rules.yaml, кнопки сняты, субъект проходит', async () => {
    assert.equal(await press(s, petyaCard, 'разрешить'), null, 'нажатие засчитано — ответ без текста');
    await lineSent(`⚙ Правила изменены — ты разрешил:\n+ субъект «petya» · кто: «Петя» · telegram ${STRANGER.id}`, 'строки «ты разрешил»');
    const log = logRows().at(-1)!;
    assert.deepEqual({ status: log.status, note: log.note }, { status: 'applied', note: 'кнопка владельца [разрешить]' });
    assert.ok(fileRules().subjects.some((x) => x.id === 'petya' && x.transports[0]?.address === String(STRANGER.id)));
    await pump(gw, () => currentButtons(petyaCard).length === 0 || null, { what: 'кнопки сняты' });
    await admit(s.fake.builder.text(STRANGER, 'теперь пустили'));
  });

  it('A5.4: повторное нажатие, [нет] той же карточки, нажатие не владельцем, нажатие через 25 часов — отказ; на каждое ровно один ответ', async () => {
    const [ok, no] = buttonsOf(petyaCard);
    assert.deepEqual(await pressToken(OWNER, ok!.data, petyaCard), { text: 'уже использовано', answers: 1 });
    assert.deepEqual(await pressToken(OWNER, no!.data, petyaCard), { text: 'уже использовано', answers: 1 });
    // Новая карточка — расширение: сменить пространство лички.
    const r = await rule([{ op: 'set', target: 'chat', id: 'private', field: 'space', value: 'работа' }]);
    assert.equal((r as { result?: unknown }).result, 'pending_owner');
    const c2 = await card(2);
    assert.equal(c2.text!.split('\n')[1], 'чат «личка» · пространство: «личное» → «работа»');
    const [ok2] = buttonsOf(c2);
    // Петя теперь субъект из правил, но не владелец — «не ваша кнопка»; изменение по-прежнему ждёт.
    assert.deepEqual(await pressToken(STRANGER, ok2!.data, c2), { text: 'не ваша кнопка', answers: 1 });
    assert.equal(logRows().at(-1)!.status, 'pending');
    for (const r of q<{ update_id: number }>(s.home, "SELECT update_id FROM updates WHERE status = 'ignored'")) purgedIgnored.add(r.update_id);
    await gw.jump('25h');
    await waitUntil(() => logRows().at(-1)!.status === 'expired' || null, 10_000, 'expired тикером');
    await pump(gw, () => currentButtons(c2).length === 0 || null, { what: 'кнопки сняты по сроку' });
    assert.deepEqual(await pressToken(OWNER, ok2!.data, c2), { text: 'истёк срок', answers: 1 });
    assert.equal(fileRules().chats[0]!.space, 'личное', 'не применено');
    assert.equal(state().rules.chats[0]!.space, 'личное');
  });

  it('A5.5: агент просит убрать владельца — отказ, rules_log rejected, строка; владелец проходит, его «стоп» работает; в «стоп» rule не исполняется', async () => {
    const r = await rule([{ op: 'remove', target: 'subject', id: 'owner' }]);
    assert.equal(r.type, 'error');
    assert.equal((r as { code?: string }).code, 'bad_request');
    assert.match((r as { text?: string }).text ?? '', /^отказано: владельца правилом не убрать/);
    await lineSent(
      `⚙ Агент просил изменить правила — отказано: владельца правилом не убрать и не поменять: он задан в config.yaml\n− субъект «owner» · кто: «owner» · telegram ${OWNER.id}`,
      'строки об отказе',
    );
    assert.deepEqual(
      (({ actor, status }) => ({ actor, status }))(logRows().at(-1)!),
      { actor: 'agent', status: 'rejected' },
    );
    const priv = await rule([{ op: 'remove', target: 'chat', id: 'private' }]);
    assert.match((priv as { text?: string }).text ?? '', /отказано: личку правилом не убрать/);
    const steal = await rule([{ op: 'set', target: 'subject', id: 'petya', field: 'transports', value: [{ network: 'telegram', address: String(OWNER.id) }] }]);
    assert.match((steal as { text?: string }).text ?? '', /отказано: номер владельца/);
    assert.equal(fileRules().subjects[0]!.id, 'owner');
    await admit(s.fake.builder.text(OWNER, 'я на месте'));
    const before = logRows().length;
    s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
    await waitUntil(() => meta(s.home, 'mode') === 'stopped' || null, 5000, 'stopped');
    const dropped = await rule([{ op: 'remove', target: 'subject', id: 'petya' }]);
    assert.equal((dropped as { result?: unknown }).result, 'dropped_stopped');
    assert.equal(logRows().length, before, 'в «стоп» ничего не записано');
    assert.ok(state().rules.subjects.some((x) => x.id === 'petya'));
    const stopLine = await lineSent(STOPPED_TEXT, 'строки «Остановлен»');
    assert.equal(await press(s, stopLine, 'продолжить'), null);
    await waitUntil(() => meta(s.home, 'mode') === 'running' || null, 5000, 'running');
  });

  it('A5.6: смена роли чата — расширение: только после кнопки; эпизод закрыт role_change, новый — с новой ролью', async () => {
    await admit(s.fake.builder.text(OWNER, 'про задачи'));
    const ep = q1<{ id: number; role: string }>(s.home, `SELECT id, role FROM episodes WHERE chat_id = ${OWNER.id} AND closed_at IS NULL`)!;
    assert.equal(ep.role, 'личный ассистент');
    // Роль по умолчанию владельцу не показывается: в строке — «📍 #N · тема», без роли.
    const lineDefault = await pump(gw, () => {
      const t = statusLineOf(s.fake)?.text;
      return t?.startsWith(`📍 #${ep.id} · `) ? t : null;
    }, { what: 'эпизода в закреплённой строке' });
    assert.ok(!lineDefault.split('\n')[0]!.includes('ассистент'), lineDefault);
    const r = await rule([{ op: 'set', target: 'chat', id: 'private', field: 'role', value: 'секретарь' }]);
    assert.equal((r as { result?: unknown }).result, 'pending_owner');
    const c3 = await card(3);
    assert.equal(c3.text!.split('\n')[1], 'чат «личка» · роль: «личный ассистент» → «секретарь»');
    const mid = await admit(s.fake.builder.text(OWNER, 'ещё до кнопки'));
    assert.equal(q1<{ episode_id: number }>(s.home, 'SELECT episode_id FROM events WHERE seq = ?', mid)?.episode_id, ep.id, 'до кнопки — тот же эпизод');
    assert.equal(state().rules.chats[0]!.role, 'личный ассистент');
    assert.equal(await press(s, c3, 'разрешить'), null);
    await lineSent('⚙ Правила изменены — ты разрешил:\nчат «личка» · роль: «личный ассистент» → «секретарь»', 'строки о смене роли');
    const closed = q1<{ close_reason: string | null }>(s.home, 'SELECT close_reason FROM episodes WHERE id = ?', ep.id);
    assert.equal(closed?.close_reason, 'role_change');
    const ce = q1<{ seq: number }>(s.home, "SELECT seq FROM events WHERE kind = 'episode_closed' AND episode_id = ?", ep.id);
    assert.ok(ce, 'episode_closed в очереди');
    const n = await ch.waitEvent(ce.seq);
    assert.equal(n.episode?.close_reason, 'role_change');
    await ch.done([ce.seq]);
    const u = s.fake.builder.text(OWNER, 'после смены роли');
    const sq = await admit(u);
    const ep2 = q1<{ id: number; role: string }>(s.home, 'SELECT ep.id, ep.role FROM events e JOIN episodes ep ON ep.id = e.episode_id WHERE e.seq = ?', sq)!;
    assert.notEqual(ep2.id, ep.id);
    assert.equal(ep2.role, 'секретарь');
    // Другая роль — видна: последней в закреплённой строке (J-4); подсказки поля ввода нет (0.3.1).
    await waitRecorded(s, gw, u);
    await pump(gw, () => statusLineOf(s.fake)?.text.startsWith(`📍 #${ep2.id} · тема не названа · Секретарь\n`) || null, { what: 'роли в закреплённой строке' });
    await ch.waitEvent(sq);
    const a = await ch.reply(sq, 'принято', ch.currentTurn()!);
    assert.ok(a.type === 'ack' && a.result === 'queued', JSON.stringify(a));
    const rec = await waitSent(s, gw, (m) => m.text === 'принято', 'ответа агента');
    assert.equal(keyboardOrPlaceholder(rec), false, 'клавиатуры и подсказки нет (0.3.1)');
    assert.equal(fileRules().chats[0]!.role, 'секретарь');
  });

  it('A5.7: агент передал role в episode — bad_request, эпизод прежний', async () => {
    const before = q1(s.home, `SELECT id, topic, role FROM episodes WHERE chat_id = ${OWNER.id} AND closed_at IS NULL`);
    const r = await ch.request('episode', { action: 'new', topic: 'Юрист', role: 'юрист' });
    assert.equal(r.type, 'error');
    assert.equal((r as { code?: string }).code, 'bad_request');
    assert.deepEqual(q1(s.home, `SELECT id, topic, role FROM episodes WHERE chat_id = ${OWNER.id} AND closed_at IS NULL`), before);
  });

  it('ничего не меняющее, неверное и неизвестное — bad_request без записи и строк', async () => {
    const before = logRows().length;
    const same = await rule([{ op: 'set', target: 'chat', id: 'private', field: 'role', value: 'секретарь' }]);
    assert.match((same as { text?: string }).text ?? '', /ничего не меняет/);
    const nobody = await rule([{ op: 'remove', target: 'subject', id: 'nobody' }]);
    assert.match((nobody as { text?: string }).text ?? '', /операция 1: субъекта «nobody» нет/);
    const bad = await rule([{ op: 'set', target: 'subject', id: 'petya', field: 'world_ref', value: 'x' }]);
    assert.equal((bad as { code?: string }).code, 'bad_request');
    assert.equal(logRows().length, before);
  });

  it('stg rules show — рабочая копия, rules.yaml, изменения', async () => {
    const r = await runCli(['rules', 'show'], s.env);
    assert.equal(r.code, 0, r.stderr);
    const out = r.stdout;
    assert.match(out, /^Правила доступа — рабочая копия шлюза:/);
    assert.match(out, new RegExp(`owner — владелец \\(config\\.yaml\\) · telegram ${OWNER.id}`));
    assert.match(out, new RegExp(`petya — кто: «Петя» · telegram ${STRANGER.id}`));
    assert.match(out, /«личка» — пространство «личное» · роль «секретарь»/);
    assert.match(out, /rules\.yaml: совпадает с рабочей копией/);
    assert.match(out, /Ждут кнопки владельца: нет/);
    assert.match(out, /агент · срок кнопки истёк/);
    assert.match(out, /агент · применено \(кнопка владельца \[разрешить\]\)/);
    assert.match(out, /агент · не применено \(отказ шлюза: владельца правилом не убрать/);
  });

  it('ручная правка rules.yaml — при перезапуске: rules_log owner_file, строка владельцу; тот же файл второй раз — без записи', async () => {
    ch.close();
    await gw.stop();
    const before = logRows().length;
    const text = fs.readFileSync(s.home.paths.rules, 'utf8').replace(
      'chats:',
      `  - id: boris\n    who: Борис\n    transports:\n      - network: telegram\n        address: "${BORIS.id}"\n    world_ref: people/boris\nchats:`,
    );
    fs.writeFileSync(s.home.paths.rules, `# правлю руками\n${text}`);
    gw = await s.start();
    ch = (await connectAdapter(s.home)).ch;
    await lineSent(`⚙ Правила изменены правкой rules.yaml:\n+ субъект «boris» · кто: «Борис» · telegram ${BORIS.id}`, 'строки о правке файла');
    const log = logRows().at(-1)!;
    assert.equal(logRows().length, before + 1);
    assert.deepEqual({ actor: log.actor, status: log.status }, { actor: 'owner_file', status: 'applied' });
    assert.equal(q1<{ world_ref: string | null }>(s.home, "SELECT world_ref FROM subjects WHERE id = 'boris'")?.world_ref, 'people/boris');
    await admit(s.fake.builder.text(BORIS, 'я Борис'));
    // Комментарий владельца остаётся: файл совпадает с копией по смыслу — шлюз его не переписывал.
    assert.ok(fs.readFileSync(s.home.paths.rules, 'utf8').startsWith('# правлю руками'));
    await restart();
    assert.equal(logRows().length, before + 1, 'второй перезапуск — без новой записи');
  });

  it('правка при работающем шлюзе — поверх неё шлюз не пишет: rule и [разрешить] — «правлен вручную»; doctor и rules show это видят', async () => {
    const r = await rule([{ op: 'add', target: 'chat', id: '-100700', value: { space: 'семья', role: 'личный ассистент' } }]);
    assert.equal((r as { result?: unknown }).result, 'pending_owner');
    const c4 = await card(4);
    const edited = fs.readFileSync(s.home.paths.rules, 'utf8').replace(/  - id: boris[\s\S]*?world_ref: people\/boris\n/, '');
    assert.notEqual(edited, fs.readFileSync(s.home.paths.rules, 'utf8'));
    fs.writeFileSync(s.home.paths.rules, edited);
    const refused = await rule([{ op: 'remove', target: 'subject', id: 'petya' }]);
    assert.equal((refused as { code?: string }).code, 'unavailable');
    assert.match((refused as { text?: string }).text ?? '', /правлен вручную после старта шлюза/);
    assert.equal(await press(s, c4, 'разрешить'), null);
    await lineSent(
      '⚙ Изменение правил не применено: rules.yaml правлен вручную после старта шлюза — правка прочитается при перезапуске, до него правила не меняю',
      'строки «не применено»',
    );
    assert.equal(logRows().at(-1)!.status, 'rejected');
    assert.equal(fs.readFileSync(s.home.paths.rules, 'utf8'), edited, 'файл владельца не тронут');
    await admit(s.fake.builder.text(BORIS, 'пока пускают'));
    const show = await runCli(['rules', 'show'], s.env);
    assert.match(show.stdout, /rules\.yaml: правлен вручную — правка прочитается при перезапуске шлюза/);
    const doc = doctorLines((await runCli(['doctor'], s.env)).stdout).find((l) => l.name === 'правила');
    assert.match(doc?.detail ?? '', /правлен вручную/);
    await restart();
    await lineSent(`⚙ Правила изменены правкой rules.yaml:\n− субъект «boris» · кто: «Борис» · telegram ${BORIS.id}`, 'строки о правке файла');
    await ignored(s.fake.builder.text(BORIS, 'а теперь?'));
  });

  it('испорченный rules.yaml — действуют прежние правила, одна строка владельцу; rule — «не читается»', async () => {
    ch.close();
    await gw.stop();
    fs.writeFileSync(s.home.paths.rules, 'subjects: [\n');
    gw = await s.start();
    ch = (await connectAdapter(s.home)).ch;
    const line = await waitSent(s, gw, (m) => m.text?.startsWith('⚙ rules.yaml не прочитан (') ?? false, 'строки о поломке');
    assert.match(line.text!, /— действуют прежние правила\. Подробности — stg doctor$/);
    await admit(s.fake.builder.text(STRANGER, 'Петя всё ещё здесь'));
    const r = await rule([{ op: 'remove', target: 'subject', id: 'petya' }]);
    assert.match((r as { text?: string }).text ?? '', /rules\.yaml не читается/);
    await restart();
    const check = s.fake.builder.text(OWNER, 'проверка');
    await admit(check);
    // Записано (COMMIT) и очередь отправки пуста — строки старта, если были, ушли.
    await pump(gw, () => (recorded(s, check) && count(s.home, "SELECT count(*) AS n FROM outbox WHERE status = 'pending'") === 0) || null, { what: 'записи и очереди' });
    assert.equal(s.fake.sentTo(OWNER.id).filter((m) => m.text?.startsWith('⚙ rules.yaml не прочитан (')).length, 1, 'та же поломка — строка одна');
    assert.equal(fs.readFileSync(s.home.paths.rules, 'utf8'), 'subjects: [\n', 'файл владельца не тронут');
  });

  it('запись rules.yaml не дошла (падение между транзакцией и файлом) — при старте файл дописан, это не правка владельцем', async () => {
    ch.close();
    await gw.stop();
    // Владелец исправил файл (это правка); затем — как будто сужение агента записано в базу, а файл записать не успели.
    fs.writeFileSync(s.home.paths.rules, RULES.replace(/  - id: anya[\s\S]*?\n(?=chats:)/, `  - id: petya\n    who: Петя\n    transports: [{ network: telegram, address: "${STRANGER.id}" }]\n`));
    gw = await s.start();
    await waitSent(s, gw, (m) => !!m.text?.startsWith('⚙ Правила изменены правкой rules.yaml:') && m.text.includes('роль: «секретарь» → «личный ассистент»'), 'строки о правке');
    await gw.stop();
    const logsBefore = logRows().length;
    const db = new DatabaseSync(s.home.paths.db);
    const st = parseRulesState(db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEYS.rulesState)!.value as string)!;
    const narrowed = { ...st.rules, subjects: st.rules.subjects.filter((x) => x.id !== 'petya') };
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(encodeRulesState({ v: 1, rules: narrowed, hash: '', file: st.file, pending: true }), META_KEYS.rulesState);
    db.close();
    gw = await s.start();
    ch = (await connectAdapter(s.home)).ch;
    await gw.waitForJournal((l) => l.ev === 'rules_written');
    assert.deepEqual(fileRules().subjects.map((x) => x.id), ['owner']);
    assert.equal(logRows().length, logsBefore, 'не правка владельцем');
    assert.equal(state().pending, false);
    await ignored(s.fake.builder.text(STRANGER, 'меня убрали?'));
  });

  it('удалённый rules.yaml — при старте восстановлен из рабочей копии; это не правка владельцем', async () => {
    ch.close();
    await gw.stop();
    const before = logRows().length;
    fs.unlinkSync(s.home.paths.rules);
    gw = await s.start();
    ch = (await connectAdapter(s.home)).ch;
    await gw.waitForJournal((l) => l.ev === 'rules_file_missing');
    await gw.waitForJournal((l) => l.ev === 'rules_written');
    assert.deepEqual(fileRules().subjects.map((x) => x.id), state().rules.subjects.map((x) => x.id));
    assert.equal(rulesFingerprint(fileRules()), rulesFingerprint(state().rules));
    assert.equal(logRows().length, before, 'не правка владельцем');
  });

  const VERA = user(999_001, 'Вера');
  it('[разрешить] и сообщение нового субъекта в одной пачке обновлений — сообщение решается по новой копии', async () => {
    const r = await rule([{ op: 'add', target: 'subject', id: 'vera', value: { who: 'Вера', transports: [{ network: 'telegram', address: String(VERA.id) }] } }]);
    assert.equal((r as { result?: unknown }).result, 'pending_owner');
    const c = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text?.startsWith(CARD_HEAD) && m.text.includes('«vera»')), { what: 'карточки Веры' });
    const ok = buttonsOf(c).find((b) => b.text === 'разрешить')!;
    // Одной выдачей getUpdates: нажатие выше, сообщение Веры ниже.
    const [cb, msg] = s.fake.push(s.fake.builder.callback(OWNER, ok.data, c.message), s.fake.builder.text(VERA, 'я Вера'));
    await waitUntil(() => s.fake.callbackAnswers.find((a) => a.callback_query_id === cb!.callback_query!.id), 10_000, 'ответа на нажатие');
    const seq = await waitUntil(() => seqOf(msg!) ?? (statusOf(msg!) === 'ignored' ? -1 : undefined), 10_000, 'решения о сообщении Веры');
    assert.ok(seq > 0, 'сообщение Веры отброшено по старой копии');
    await ch.waitEvent(seq);
    await ch.done([seq]);
    assert.equal(logRows().at(-1)!.status, 'applied');
  });

  it('запись rules.yaml не прошла не из-за диска (нет прав на каталог) — правила уже действуют; файл дописан тикером, когда запись проходит', async () => {
    const fileBefore = fs.readFileSync(s.home.paths.rules, 'utf8');
    assert.ok(fileBefore.includes('vera'));
    fs.chmodSync(s.home.dir, 0o500);
    let r: GatewayMessage;
    try {
      r = await rule([{ op: 'remove', target: 'subject', id: 'vera' }]);
    } finally {
      fs.chmodSync(s.home.dir, 0o700);
    }
    assert.equal((r as { result?: unknown }).result, 'applied');
    const fail = await gw.waitForJournal((l) => l.ev === 'rules_write_failed');
    assert.match(String(fail.error), /EACCES|permission/i);
    assert.equal(fs.readFileSync(s.home.paths.rules, 'utf8'), fileBefore, 'файл ещё прежний');
    assert.equal(state().pending, true);
    await ignored(s.fake.builder.text(VERA, 'а теперь?'));
    // Запись снова проходит — файл дописан при следующей сверке (тикер раз в минуту или следующее обновление).
    await gw.advance('61s');
    const failIdx = gw.journal().indexOf(gw.journal().find((l) => l.ev === 'rules_write_failed')!);
    await waitUntil(() => gw.journal().slice(failIdx + 1).some((l) => l.ev === 'rules_written') || null, 10_000, 'rules_written после отказа');
    assert.ok(!fs.readFileSync(s.home.paths.rules, 'utf8').includes('vera'));
    assert.equal(state().pending, false);
  });
});
