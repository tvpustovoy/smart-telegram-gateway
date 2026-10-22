// M9 · реакции владельца на ответы агента (0.3.4; P-31, #34) на поддельных Telegram, провайдере голоса и переходнике:
// A9.1 👍 на ответ агента — событие агенту: кадр вида text с полем reaction (прежний канал читает текстом), в базе — вид
// reaction, метка owner; 👀/👌 и «печатает…» на нём нет; done закрывает · A9.2 смена 👍 → ❤ — новое событие «❤ (было 👍)»;
// ответ на реакцию уходит без реплая · A9.3 снятие — событие «снял ❤» ⟨предл.⟩ · A9.4 тот же update ещё раз — второго
// события нет · A9.5 на строку шлюза, на расшифровку, на своё сообщение — без события (updates ignored, reaction_skipped)
// · A9.6 не владелец (участник по правилам) — без события; незнакомый — как всегда, счётчик · A9.7 «стоп» — реакция
// ждёт, как прочие; в «ждут агента» не считается; после [продолжить] — отдана · A9.8 сообщение агента по своей
// инициативе — «на твоё сообщение».
// По проверке 0.3.4: A9.11 без изменений (no_change), неизвестное сообщение (unknown_message), строка «⚙ голос не
// получился» (вид service при origin agent — gateway_line: событие только при messages_out = agent И origin = agent) ·
// A9.12 пауза — реакция отдаётся, ответ на неё уходит · A9.13 группа из правил — событие; анонимная реакция от имени чата
// — незнакомый · A9.14 тема Telegram — событие в теме ответа, эпизод ответа · A9.15 падение на реакции — третье в
// отложенное, строка «⚙ Реакцию от ЧЧ:ММ отложил…» ⟨предл.⟩, `stg deferred list` называет реакцию.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FakeChannel } from 'stg-fake-channel';
import type { SentMessage } from 'stg-fake-telegram';
import { privateChatOf } from 'stg-fake-telegram';
import { VOICE_FAILED_TEXT, deferredNotice, ownerReactionText, type Chat, type OwnerReaction, type Update } from 'stg-core';
import { assertNoLoss, connectAdapter, count, meta, pump, q1, readJournal, runCli, shiftClockFile, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OTHER, OWNER, STRANGER, botTexts, reactionsOf, setup, type Setup } from './m1-common.js';
import { buttonsOf, press, waitSent } from './m2-common.js';
import { pushVoice, voiceSetup, waitSttReply, type VoiceSetup } from './m4-common.js';

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
  - chat: -1001234
    space: семья
    role: личный ассистент
`;

/** Группа из правил (A9.13): реакции в ней Telegram присылает, только если бот — администратор (5.17). */
const GROUP = { id: -1001234, type: 'supergroup', title: 'Семья' } as Chat;

describe('M9 · реакции владельца на ответы агента (0.3.4)', () => {
  let s: VoiceSetup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  let turn: number;
  const seqOfUpdate = (u: Update): number | undefined => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
  const updateStatus = (u: Update): string | undefined => q1<{ status: string }>(s.home, 'SELECT status FROM updates WHERE update_id = ?', u.update_id)?.status;

  /** Сообщение владельца → событие агенту → ответ агента; вернуть № события и сообщение бота с ответом. */
  async function answered(
    text: string,
    answer: string,
    from = OWNER,
    opts: { chat?: Chat; thread?: { id: number; isTopic: boolean } } = {},
  ): Promise<{ seq: number; msg: SentMessage }> {
    const chatId = opts.chat?.id ?? from.id;
    const [u] = s.fake.push(s.fake.builder.text(from, text, opts));
    const seq = await waitUntil(() => seqOfUpdate(u!), 5000, 'приёма');
    await ch.waitEvent(seq);
    await ch.delivered(seq);
    const a = await ch.reply(seq, answer, turn);
    assert.ok(a.type === 'ack' && a.result === 'queued', JSON.stringify(a));
    const msg = await pump(gw, () => s.fake.sentTo(chatId).find((m) => m.text === answer && m.parse_mode === 'HTML'), { what: 'ответа агента' });
    await waitUntil(() => q1(s.home, 'SELECT 1 FROM messages_out WHERE tg_message_id = ? AND chat_id = ?', msg.message_id, chatId), 5000, 'messages_out');
    // 👌 шлюза на сообщении владельца уже встал — дальше реакций шлюза по этому ответу не будет.
    await pump(gw, () => reactionsOf(s.fake, u!).at(-1) === '👌' || null, { what: '👌 на сообщении' });
    return { seq, msg };
  }

  /** Владелец (или другой) поменял реакцию на сообщении. */
  function react(msg: SentMessage, now: string[], old: string[] = [], from = OWNER): Update {
    return s.fake.push(s.fake.builder.reaction(from, msg.message.chat, msg.message_id, now, old))[0]!;
  }

  /**
   * Окно отмены реакции (0.3.4, issue #46; по умолчанию 3 с): событие записано сразу, но held — агенту оно уходит, когда
   * окно прошло.
   */
  async function afterHold(seq: number): Promise<void> {
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status, 'held', 'в окне отмены — held');
    assert.ok(!ch.events().some((x) => x.seq === seq), 'в окне агенту не отдана');
    await gw.advance('3s');
  }

  /** Обновление реакции принято без события: updates ignored, журнал reaction_skipped с причиной. */
  async function skipped(u: Update, reason: string): Promise<void> {
    await waitUntil(() => updateStatus(u) === 'ignored' || null, 5000, `ignored ${u.update_id}`);
    assert.equal(seqOfUpdate(u), undefined, 'события нет');
    assert.equal(q1<{ raw_json: string | null }>(s.home, 'SELECT raw_json FROM updates WHERE update_id = ?', u.update_id)?.raw_json, null, 'у ignored содержимого нет');
    const j = await waitUntil(() => readJournal(s.home).find((l) => l.ev === 'reaction_skipped' && l.update_id === u.update_id), 5000, 'reaction_skipped');
    assert.equal(j.reason, reason);
  }

  before(async () => {
    s = await voiceSetup({ rules: RULES, fake: { transcript: 'расшифровка голосового' } });
    gw = await s.start();
    ({ ch, turn } = await connectAdapter(s.home));
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  let first: { seq: number; msg: SentMessage } | null = null;
  let firstReaction: { u: Update; seq: number } | null = null;

  it('A9.1: 👍 на ответ агента — событие агенту: вид text + поле reaction {to_seq, emoji, old, excerpt}; в базе — reaction, метка owner; 👀/👌 и «печатает…» нет; done закрывает', async () => {
    first = await answered('Что у нас на завтра?', 'Завтра — созвон в 10:00 и отчёт');
    const actionsBefore = s.fake.chatActions.length;
    const reactionsBefore = s.fake.reactions.length;
    const u = react(first.msg, ['👍']);
    const seq = await waitUntil(() => seqOfUpdate(u), 5000, 'события реакции');
    firstReaction = { u, seq };
    await afterHold(seq);
    const e = await ch.waitEvent(seq);
    const reaction = { to_seq: first.seq, emoji: ['👍'], old: [], excerpt: 'Завтра — созвон в 10:00 и отчёт' };
    assert.deepEqual(
      { kind: e.kind, trust: e.trust, reaction: e.reaction, text: e.text, reply_to: e.reply_to, attachments: e.attachments },
      { kind: 'text', trust: 'owner', reaction, text: ownerReactionText(reaction), reply_to: null, attachments: [] },
      'кадр вида text: прежний канал читает событие текстом',
    );
    assert.equal(e.text, `Реакция на твой ответ к № ${first.seq}: 👍 — твой ответ: «Завтра — созвон в 10:00 и отчёт»`);
    const row = q1<{ kind: string; trust: string; message_id: number | null; status: string; reaction_json: string; episode_id: number | null }>(
      s.home,
      'SELECT kind, trust, message_id, status, reaction_json, episode_id FROM events WHERE seq = ?',
      seq,
    )!;
    assert.deepEqual({ kind: row.kind, trust: row.trust, message_id: row.message_id }, { kind: 'reaction', trust: 'owner', message_id: null });
    const outboxId = q1<{ outbox_id: number }>(s.home, 'SELECT outbox_id FROM messages_out WHERE chat_id = ? AND tg_message_id = ?', OWNER.id, first.msg.message_id)!.outbox_id;
    assert.deepEqual(JSON.parse(row.reaction_json) as OwnerReaction, { message_id: first.msg.message_id, outbox_id: outboxId, ...reaction });
    assert.equal(row.episode_id, q1<{ episode_id: number }>(s.home, 'SELECT episode_id FROM events WHERE seq = ?', first.seq)!.episode_id, 'эпизод — открытый, тот же');
    assert.equal(updateStatus(u), 'admitted');
    assert.equal(q1<{ raw_json: string | null }>(s.home, 'SELECT raw_json FROM updates WHERE update_id = ?', u.update_id)?.raw_json, null, 'in_progress снят: raw_json пуст');
    const j = readJournal(s.home).find((l) => l.ev === 'in' && l.seq === seq);
    assert.deepEqual({ kind: j?.kind, label: j?.label, emoji: j?.emoji, to_seq: j?.to_seq }, { kind: 'reaction', label: 'owner', emoji: ['👍'], to_seq: first.seq });
    await ch.delivered(seq);
    for (let i = 0; i < 3; i++) await gw.advance('1s');
    await sleep(100);
    assert.equal(s.fake.reactions.length, reactionsBefore, 'на реакции 👀 и 👌 нет: это не сообщение владельца');
    assert.equal(s.fake.chatActions.length, actionsBefore, '«печатает…» нет: ответ не обязателен');
    const d = await ch.done([seq]);
    assert.ok(d.type === 'ack', JSON.stringify(d));
    assert.equal(q1<{ status: string; processed_silent: number }>(s.home, 'SELECT status, processed_silent FROM events WHERE seq = ?', seq)?.status, 'processed');
  });

  it('A9.2: смена 👍 → ❤ — новое событие «❤ (было 👍)»; ответ агента на реакцию уходит, без реплая', async () => {
    const u = react(first!.msg, ['❤'], ['👍']);
    const seq = await waitUntil(() => seqOfUpdate(u), 5000, 'второй реакции');
    assert.ok(seq > firstReaction!.seq);
    await afterHold(seq);
    const e = await ch.waitEvent(seq);
    assert.deepEqual(e.reaction, { to_seq: first!.seq, emoji: ['❤'], old: ['👍'], excerpt: 'Завтра — созвон в 10:00 и отчёт' });
    assert.match(e.text ?? '', /: ❤ \(было 👍\) — твой ответ:/);
    await ch.delivered(seq);
    const a = await ch.reply(seq, 'Вижу ❤ — спасибо!', turn);
    assert.ok(a.type === 'ack' && a.result === 'queued', JSON.stringify(a));
    const m = await pump(gw, () => s.fake.sentTo(OWNER.id).find((x) => x.text === 'Вижу ❤ — спасибо!'), { what: 'ответа на реакцию' });
    assert.equal(m.reply_parameters, null, 'у реакции нет своего сообщения — ответ без реплая');
  });

  it('A9.3: снятие реакции — событие «снял ❤» ⟨предл.: агент мог уже действовать по ней⟩', async () => {
    const u = react(first!.msg, [], ['❤']);
    const seq = await waitUntil(() => seqOfUpdate(u), 5000, 'снятия');
    await afterHold(seq);
    const e = await ch.waitEvent(seq);
    assert.deepEqual(e.reaction?.emoji, []);
    assert.deepEqual(e.reaction?.old, ['❤']);
    assert.match(e.text ?? '', new RegExp(`^Реакция на твой ответ к № ${first!.seq}: снял ❤ — `));
    await ch.done([seq]);
  });

  it('A9.4: тот же update ещё раз (Telegram повторил) — второго события нет, журнал update_repeat', async () => {
    const { u, seq } = firstReaction!;
    const before = count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'reaction'");
    s.fake.redeliver(u.update_id);
    await waitUntil(() => readJournal(s.home).some((l) => l.ev === 'update_repeat' && l.update_id === u.update_id) || null, 5000, 'update_repeat');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'reaction'"), before);
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', u.update_id), 1);
    assert.equal(seqOfUpdate(u), seq);
  });

  it('A9.5: на строку шлюза, на расшифровку и на своё сообщение — без события: updates ignored, reaction_skipped с причиной; агенту ничего', async () => {
    const eventsBefore = ch.events().length;
    // Строка шлюза: ответ на «статус».
    s.fake.push(s.fake.builder.text(OWNER, 'статус'));
    const status = await waitSent(s, gw, (m) => (m.text ?? '').startsWith('⚙ Статус'), '«статуса»');
    await waitUntil(() => q1(s.home, 'SELECT 1 FROM messages_out WHERE tg_message_id = ?', status.message_id), 5000, 'messages_out');
    await skipped(react(status, ['👍']), 'gateway_line');
    // Расшифровка голосового (цитата шлюза).
    const v = pushVoice(s, 4);
    const [tr] = await waitSttReply(s, gw, v, 1, 'расшифровки');
    await waitUntil(() => q1(s.home, 'SELECT 1 FROM messages_out WHERE tg_message_id = ?', tr!.message_id), 5000, 'messages_out');
    await skipped(react(tr!, ['👍']), 'transcript');
    // Своё сообщение владельца (на нём 👀 и 👌 шлюза — их Telegram боту не присылает).
    const [own] = s.fake.push(s.fake.builder.text(OWNER, 'просто запиши'));
    const ownSeq = await waitUntil(() => seqOfUpdate(own!), 5000, 'приёма');
    await skipped(s.fake.push(s.fake.builder.reaction(OWNER, own!.message!.chat, own!.message!.message_id, ['🔥']))[0]!, 'own_message');
    // Агенту — только голосовое и «просто запиши», реакций нет.
    const voiceSeq = await waitUntil(() => seqOfUpdate(v), 5000, 'голосового');
    await ch.waitEvent(ownSeq);
    const got = ch.events().slice(eventsBefore).map((x) => x.seq);
    assert.deepEqual(got.sort((a, b) => a - b), [voiceSeq, ownSeq].sort((a, b) => a - b));
    await ch.delivered(voiceSeq);
    await ch.delivered(ownSeq);
    await ch.done([voiceSeq, ownSeq]);
  });

  it('A9.6: не владелец — без события: участник по правилам (reaction_skipped not_owner), незнакомый — как всегда (update_ignored, счётчик)', async () => {
    const anya = await answered('привет, это Аня', 'Привет, Аня', OTHER);
    await skipped(react(anya.msg, ['👍'], [], OTHER), 'not_owner');
    const ignoredBefore = Number(meta(s.home, 'ignored_count') ?? '0');
    const u = s.fake.push(s.fake.builder.reaction(STRANGER, first!.msg.message.chat, first!.msg.message_id, ['💩']))[0]!;
    await waitUntil(() => updateStatus(u) === 'ignored' || null, 5000, 'ignored');
    assert.equal(seqOfUpdate(u), undefined);
    assert.equal(Number(meta(s.home, 'ignored_count')), ignoredBefore + 1, 'незнакомый — счётчик');
    assert.ok(!readJournal(s.home).some((l) => l.ev === 'reaction_skipped' && l.update_id === u.update_id), 'о незнакомом — только счётчик');
  });

  it('A9.7: «стоп» — реакция ждёт, как прочие; «ждут агента» её не считают; после [продолжить] — отдана', async () => {
    const target = await answered('как дела?', 'Всё идёт по плану');
    s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
    const line = await waitSent(s, gw, (m) => m.text === '⚙ Остановлен, сообщения сохраняю' && buttonsOf(m).some((b) => b.text === 'продолжить'), 'строки «стоп»');
    await ch.waitMode('stopped');
    const u = react(target.msg, ['👍']);
    const seq = await waitUntil(() => seqOfUpdate(u), 5000, 'реакции в «стоп»');
    // Окно отмены (0.3.4, issue #46) идёт и в «стоп»: через 3 с реакция new и ждёт [продолжить], как прочие.
    for (let i = 0; i < 3; i++) await gw.advance('1s');
    await sleep(200);
    assert.ok(!ch.events().some((x) => x.seq === seq), 'в «стоп» не отдана');
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status, 'new');
    const w = await ch.where();
    assert.ok(w.type === 'where_result' && !w.data?.waiting.includes(seq), 'в «ждут агента» реакции нет');
    assert.equal(await press(s, line, 'продолжить'), null);
    await ch.waitMode('running');
    turn = ch.currentTurn()!;
    const e = await ch.waitEvent(seq);
    assert.equal(e.reaction?.to_seq, target.seq);
    await ch.delivered(seq);
    await ch.done([seq]);
  });

  it('A9.8: сообщение агента по своей инициативе (reply без seq) — «Реакция на твоё сообщение: 🙏», to_seq null', async () => {
    const a = await ch.reply(null, 'Напоминаю: созвон в 15:00', turn);
    assert.ok(a.type === 'ack' && a.result === 'queued', JSON.stringify(a));
    const msg = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text === 'Напоминаю: созвон в 15:00'), { what: 'сообщения по своей инициативе' });
    await waitUntil(() => q1(s.home, 'SELECT 1 FROM messages_out WHERE tg_message_id = ?', msg.message_id), 5000, 'messages_out');
    const u = react(msg, ['🙏']);
    const seq = await waitUntil(() => seqOfUpdate(u), 5000, 'реакции');
    await afterHold(seq);
    const e = await ch.waitEvent(seq);
    assert.deepEqual(e.reaction, { to_seq: null, emoji: ['🙏'], old: [], excerpt: 'Напоминаю: созвон в 15:00' });
    assert.equal(e.text, 'Реакция на твоё сообщение: 🙏 — твой ответ: «Напоминаю: созвон в 15:00»');
    await ch.delivered(seq);
    await ch.done([seq]);
  });

  it('A9.11 (по проверке 0.3.4): без изменений — no_change; на неизвестное сообщение — unknown_message; на «⚙ голос не получился» (service при origin agent) — gateway_line; на текст того же ответа — событие', async () => {
    await skipped(react(first!.msg, ['👍'], ['👍']), 'no_change');
    await skipped(s.fake.push(s.fake.builder.reaction(OWNER, first!.msg.message.chat, 987_654, ['👍']))[0]!, 'unknown_message');
    // Ответ голосом, синтез не удался: строка «⚙ голос не получился» (messages_out service, outbox.origin agent) и текст.
    s.synth.ttsMode = 'error';
    try {
      const [u] = s.fake.push(s.fake.builder.text(OWNER, 'ответь голосом'));
      const seq = await waitUntil(() => seqOfUpdate(u!), 5000, 'приёма');
      await ch.waitEvent(seq);
      await ch.delivered(seq);
      const a = await ch.reply(seq, 'Ответ, который не озвучился', turn, true);
      assert.ok(a.type === 'ack' && a.result === 'queued', JSON.stringify(a));
      const text = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text === 'Ответ, который не озвучился'), { what: 'ответа текстом' });
      const failed = s.fake.sentTo(OWNER.id).filter((m) => m.text === VOICE_FAILED_TEXT).at(-1)!;
      assert.ok(failed, 'строка «голос не получился»');
      const kindOf = (id: number): { kind: string; origin: string } | undefined =>
        q1<{ kind: string; origin: string }>(s.home, 'SELECT m.kind, o.origin FROM messages_out m JOIN outbox o ON o.id = m.outbox_id WHERE m.chat_id = ? AND m.tg_message_id = ?', OWNER.id, id);
      await waitUntil(() => (kindOf(failed.message_id) && kindOf(text.message_id)) || null, 5000, 'messages_out');
      assert.deepEqual({ ...kindOf(failed.message_id) }, { kind: 'service', origin: 'agent' }, 'строка шлюза в строке outbox ответа агента');
      await skipped(react(failed, ['👍']), 'gateway_line');
      const uT = react(text, ['👍']);
      const seqT = await waitUntil(() => seqOfUpdate(uT), 5000, 'реакции на текст ответа');
      await afterHold(seqT);
      const e = await ch.waitEvent(seqT);
      assert.equal(e.reaction?.to_seq, seq);
      await ch.delivered(seqT);
      await ch.done([seqT]);
    } finally {
      s.synth.ttsMode = 'ok';
    }
  });

  it('A9.12 (по проверке 0.3.4): пауза — реакция отдаётся (держит только «стоп»), ответ агента на неё уходит, как ответ на событие этой аренды', async () => {
    const target = await answered('что нового?', 'Пока тихо');
    const n = ch.modes().length;
    s.fake.push(s.fake.builder.text(OWNER, 'пауза'));
    await waitUntil(() => ch.modes().slice(n).some((m) => m.state === 'paused') || null, 5000, 'паузы');
    const u = react(target.msg, ['👍']);
    const seq = await waitUntil(() => seqOfUpdate(u), 5000, 'реакции в паузе');
    await afterHold(seq);
    const e = await ch.waitEvent(seq);
    assert.equal(e.reaction?.to_seq, target.seq);
    await ch.delivered(seq);
    const a = await ch.reply(seq, 'Принял 👍', turn);
    assert.ok(a.type === 'ack' && a.result === 'queued', `в паузе ответ на реакцию — не held: ${JSON.stringify(a)}`);
    await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text === 'Принял 👍'), { what: 'ответа на реакцию в паузе' });
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status, 'processed');
    const m = ch.modes().length;
    s.fake.push(s.fake.builder.text(OWNER, 'продолжить'));
    await waitUntil(() => ch.modes().slice(m).some((x) => x.state === 'running') || null, 5000, 'снятия паузы');
  });

  it('A9.13 (по проверке 0.3.4): группа из правил — реакция владельца на ответ агента там — событие (чат group); анонимная реакция от имени чата (actor_chat без user) — незнакомый: ignored, счётчик', async () => {
    const g = await answered('что по плану на выходные?', 'В субботу — дача', OWNER, { chat: GROUP });
    const u = react(g.msg, ['🔥']);
    const seq = await waitUntil(() => seqOfUpdate(u), 5000, 'реакции в группе');
    await afterHold(seq);
    const e = await ch.waitEvent(seq);
    assert.deepEqual({ chat: e.chat, trust: e.trust, to_seq: e.reaction?.to_seq }, { chat: { id: GROUP.id, kind: 'group' }, trust: 'owner', to_seq: g.seq });
    await ch.delivered(seq);
    await ch.done([seq]);
    const ignoredBefore = Number(meta(s.home, 'ignored_count') ?? '0');
    const anon = s.fake.push(s.fake.builder.reaction(null, GROUP, g.msg.message_id, ['👍'], [], { actorChat: GROUP }))[0]!;
    await waitUntil(() => updateStatus(anon) === 'ignored' || null, 5000, 'ignored');
    assert.equal(seqOfUpdate(anon), undefined, 'события нет');
    assert.equal(Number(meta(s.home, 'ignored_count')), ignoredBefore + 1, 'незнакомый — счётчик');
    assert.ok(!readJournal(s.home).some((l) => l.ev === 'reaction_skipped' && l.update_id === anon.update_id), 'о незнакомом — только счётчик и update_ignored');
  });

  it('A9.14 (по проверке 0.3.4): реакция на ответ в теме Telegram — событие в теме ответа (ответ агента на реакцию уходит туда), эпизод — эпизод ответа, если открытый — в другой теме', async () => {
    const t = await answered('в теме про отпуск', 'Отпуск — в июле', OWNER, { thread: { id: 700, isTopic: true } });
    const epTopic = q1<{ episode_id: number }>(s.home, 'SELECT episode_id FROM events WHERE seq = ?', t.seq)!.episode_id;
    assert.equal(s.fake.callsOf('sendMessage').find((c) => c.params.text === 'Отпуск — в июле')?.params.message_thread_id, 700, 'ответ — в теме');
    // Назад в основной поток: открыт другой эпизод (telegram_topic).
    const [m] = s.fake.push(s.fake.builder.text(OWNER, 'а теперь в основном потоке'));
    const mSeq = await waitUntil(() => seqOfUpdate(m!), 5000, 'приёма');
    await ch.waitEvent(mSeq);
    await ch.delivered(mSeq);
    await ch.done([mSeq]);
    const epMain = q1<{ episode_id: number }>(s.home, 'SELECT episode_id FROM events WHERE seq = ?', mSeq)!.episode_id;
    assert.notEqual(epMain, epTopic);
    const u = react(t.msg, ['👍']);
    const seq = await waitUntil(() => seqOfUpdate(u), 5000, 'реакции в теме');
    assert.deepEqual({ ...q1<{ thread_id: number | null; episode_id: number | null }>(s.home, 'SELECT thread_id, episode_id FROM events WHERE seq = ?', seq) }, { thread_id: 700, episode_id: epTopic });
    await afterHold(seq);
    const e = await ch.waitEvent(seq);
    assert.equal(e.episode?.id, epTopic);
    await ch.delivered(seq);
    const a = await ch.reply(seq, 'Вижу 👍 про отпуск', turn);
    assert.ok(a.type === 'ack' && a.result === 'queued', JSON.stringify(a));
    const call = await pump(gw, () => s.fake.callsOf('sendMessage').find((c) => c.params.text === 'Вижу 👍 про отпуск') ?? null, { what: 'ответа на реакцию' });
    assert.equal(call.params.message_thread_id, 700, 'ответ на реакцию — в теме ответа, а не в основном потоке');
  });
});

describe('M9 · падение на реакции (по проверке 0.3.4; Ш-15)', () => {
  let s: Setup;
  after(() => s?.close());

  it('A9.15: шлюз падает на реакции (точка in_handler) — падения считаются, третье — в отложенное; строка «⚙ Реакцию от 09:00 отложил…»; stg deferred list называет реакцию; следующее принято', async () => {
    s = await setup();
    const bad = s.fake.push(s.fake.builder.reaction(OWNER, privateChatOf(OWNER), 4242, ['👍']))[0]!.update_id;
    const good = s.fake.push(s.fake.builder.text(OWNER, 'следующее'))[0]!.update_id;
    let runs = 0;
    for (;;) {
      const g = s.spawn({ STG_FAULT: `in_handler:${bad}` });
      runs++;
      const done = await Promise.race([
        g.exited.then(() => 'exit' as const),
        waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', good) === 1, 20_000, 'приёма следующего').then(() => 'admitted' as const),
      ]);
      if (done === 'admitted') {
        await pump(g, () => botTexts(s.fake).some((t) => t === deferredNotice('09:00', 'reaction')), { what: 'строки владельцу' });
        await g.stop();
        break;
      }
      const ex = await g.waitForExit();
      assert.equal(ex.code, 137, g.stderr);
      if (runs > 6) throw new Error('не отложил за 6 запусков');
      shiftClockFile(s.home, 61_000);
    }
    assert.equal(runs, 4, 'три падения, на четвёртом старте — отложено');
    const row = q1<{ status: string; crash_count: number; raw_json: string | null }>(s.home, 'SELECT status, crash_count, raw_json FROM updates WHERE update_id = ?', bad);
    assert.deepEqual({ status: row?.status, crash_count: row?.crash_count }, { status: 'deferred', crash_count: 3 });
    assert.ok(row?.raw_json?.includes('message_reaction'), 'содержимое сохранено');
    assert.equal(count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', bad), 0);
    assert.equal(Number(meta(s.home, 'offset')), good + 1);
    assert.ok(!botTexts(s.fake).some((t) => t.startsWith('⚙ Сообщение от')), 'реакцию сообщением не называет');
    const dl = await runCli(['deferred', 'list'], s.env);
    assert.equal(dl.code, 0);
    assert.match(dl.stdout, new RegExp(`^${bad} · \\d{4}-\\d{2}-\\d{2} 09:00 · падений 3 · реакция 👍 на сообщение 4242`, 'm'));
    assertNoLoss(s.fake, s.home);
  });
});

// ——— Окно отмены реакции (0.3.4; GitHub issue #46) ———
// Реакция отдаётся агенту не сразу, а после короткого окна: поставил не ту и сразу убрал — отмена, агенту ничего. Окно —
// не больше 3 с, чтобы не мешать разговору; по умолчанию — 3 с.
// A9.18 отдача — через окно (3 с, не такт 15 с); сообщение в окне уходит сразу, реакция — следом вне очереди ·
// A9.19 поставил → снял за 1 с — отмена, агенту ничего; 👍 → ❤ → 👍 при исходном 👍 — отмена · A9.20 поставил → сменил
// за 1 с — одно событие с итогом и «было» до окна, окно — заново от последнего изменения; смена после окна — новое
// событие · A9.21 тот же update ещё раз в окне — update_repeat, окно не сдвигается · A9.22 перезапуск в окне — остаток;
// снятие после перезапуска в окне — отмена; окно прошло, пока шлюз стоял, — сразу · A9.23 hold_seconds: 0 — сразу.

/** Стенд окна отмены: шлюз, переходник, ответ агента и реакция на него. */
interface HoldBench {
  s: Setup;
  gw: GatewayProcess;
  ch: FakeChannel;
  turn: number;
}

function holdHelpers(b: HoldBench) {
  const seqOfUpdate = (u: Update): number | undefined => q1<{ seq: number }>(b.s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
  const updateStatus = (u: Update): string | undefined => q1<{ status: string }>(b.s.home, 'SELECT status FROM updates WHERE update_id = ?', u.update_id)?.status;
  const ev = (seq: number): { status: string; reaction: OwnerReaction; hold_until: number | null; created_at: number } => {
    const r = q1<{ status: string; reaction_json: string; hold_until: number | null; created_at: number }>(
      b.s.home,
      'SELECT status, reaction_json, hold_until, created_at FROM events WHERE seq = ?',
      seq,
    )!;
    return { status: r.status, reaction: JSON.parse(r.reaction_json) as OwnerReaction, hold_until: r.hold_until, created_at: r.created_at };
  };
  const given = (seq: number): boolean => b.ch.events().some((x) => x.seq === seq);
  /** Сообщение владельца → событие агенту → ответ агента; № события и сообщение бота. */
  async function answered(text: string, answer: string): Promise<{ seq: number; msg: SentMessage }> {
    const [u] = b.s.fake.push(b.s.fake.builder.text(OWNER, text));
    const seq = await waitUntil(() => seqOfUpdate(u!), 5000, 'приёма');
    await b.ch.waitEvent(seq);
    await b.ch.delivered(seq);
    const a = await b.ch.reply(seq, answer, b.turn);
    assert.ok(a.type === 'ack' && a.result === 'queued', JSON.stringify(a));
    const msg = await pump(b.gw, () => b.s.fake.sentTo(OWNER.id).find((m) => m.text === answer), { what: 'ответа агента' });
    await waitUntil(() => q1(b.s.home, 'SELECT 1 FROM messages_out WHERE tg_message_id = ? AND chat_id = ?', msg.message_id, OWNER.id), 5000, 'messages_out');
    await pump(b.gw, () => reactionsOf(b.s.fake, u!).at(-1) === '👌' || null, { what: '👌 на сообщении' });
    return { seq, msg };
  }
  function react(msg: SentMessage, now: string[], old: string[] = []): Update {
    return b.s.fake.push(b.s.fake.builder.reaction(OWNER, msg.message.chat, msg.message_id, now, old))[0]!;
  }
  /** Обновление реакции записано новым событием — его №. */
  const admitted = (u: Update): Promise<number> => waitUntil(() => seqOfUpdate(u), 5000, `события реакции ${u.update_id}`);
  /** Обновление склеено с удерживаемым событием или отменило его: своего события нет (ignored), строка журнала. */
  async function folded(u: Update, what: 'reaction_merged' | 'reaction_cancelled'): Promise<Record<string, unknown>> {
    const j = await waitUntil(() => readJournal(b.s.home).find((l) => l.ev === what && l.update_id === u.update_id), 5000, what);
    assert.equal(updateStatus(u), 'ignored', 'своего события у обновления нет (П-1)');
    assert.equal(seqOfUpdate(u), undefined);
    assert.equal(q1<{ raw_json: string | null }>(b.s.home, 'SELECT raw_json FROM updates WHERE update_id = ?', u.update_id)?.raw_json, null);
    return j;
  }
  /** Прогнать окно до конца и забрать событие у переходника. */
  async function release(seq: number): Promise<Awaited<ReturnType<FakeChannel['waitEvent']>>> {
    await b.gw.advance('3s');
    const e = await b.ch.waitEvent(seq);
    await b.ch.delivered(seq);
    await b.ch.done([seq]);
    return e;
  }
  return { seqOfUpdate, updateStatus, ev, given, answered, react, admitted, folded, release };
}

describe('M9 · окно отмены реакции 3 с (0.3.4, issue #46)', () => {
  const b = {} as HoldBench;
  const h = holdHelpers(b);
  before(async () => {
    b.s = await setup();
    b.gw = await b.s.start();
    ({ ch: b.ch, turn: b.turn } = await connectAdapter(b.s.home));
  });
  after(async () => {
    b.ch?.close();
    if (b.gw?.alive) await b.gw.stop();
    await b.s.close();
  });

  it('A9.18: реакция записана сразу (held), агенту — ровно через окно 3 с, а не тактом 15 с; сообщение в окне уходит сразу, реакция — следом', async () => {
    const a = await h.answered('проверим окно', 'Окно на месте');
    const u = h.react(a.msg, ['👍']);
    const seq = await h.admitted(u);
    const e0 = h.ev(seq);
    assert.equal(e0.status, 'held');
    assert.equal(e0.hold_until! - e0.created_at, 3000, 'hold_until = запись + 3 с');
    assert.equal(h.updateStatus(u), 'admitted', 'обновление записано сразу — offset за ним');
    const inLine = readJournal(b.s.home).find((l) => l.ev === 'in' && l.seq === seq);
    assert.equal(inLine?.hold_ms, 3000);
    // Окно не держит остальное: сообщение владельца, пришедшее в окне, уходит агенту сразу.
    const [m] = b.s.fake.push(b.s.fake.builder.text(OWNER, 'а это — сразу'));
    const mSeq = await waitUntil(() => h.seqOfUpdate(m!), 5000, 'приёма');
    assert.ok(mSeq > seq);
    await b.ch.waitEvent(mSeq);
    assert.ok(!h.given(seq), 'реакция ещё в окне');
    await b.gw.advance('2s');
    await sleep(100);
    assert.equal(h.ev(seq).status, 'held', 'через 2 с — ещё в окне');
    assert.ok(!h.given(seq));
    await b.gw.advance('1s');
    const e = await b.ch.waitEvent(seq);
    assert.deepEqual(e.reaction, { to_seq: a.seq, emoji: ['👍'], old: [], excerpt: 'Окно на месте' });
    const rel = readJournal(b.s.home).find((l) => l.ev === 'reaction_released' && l.seq === seq);
    assert.equal(rel?.held_ms, 3000, 'отдача — через окно (3 с), а не через такт тикера (15 с)');
    await b.ch.delivered(mSeq);
    await b.ch.delivered(seq);
    await b.ch.done([mSeq, seq]);
  });

  it('A9.19: поставил → снял за 1 с — агенту ничего, событие cancelled, reaction_cancelled с причиной; 👍 → ❤ → 👍 при исходном 👍 — тоже отмена', async () => {
    const a = await h.answered('поставлю и сниму', 'Ответ под отмену');
    const before = b.ch.events().length;
    const u1 = h.react(a.msg, ['👍']);
    const seq = await h.admitted(u1);
    await b.gw.advance('1s');
    const u2 = h.react(a.msg, [], ['👍']);
    const j = await h.folded(u2, 'reaction_cancelled');
    assert.deepEqual(
      { seq: j.seq, reason: j.reason, emoji: j.emoji, old: j.old, held_ms: j.held_ms },
      { seq, reason: 'same_as_before', emoji: [], old: [], held_ms: 1000 },
    );
    assert.equal(h.ev(seq).status, 'cancelled');
    for (let i = 0; i < 5; i++) await b.gw.advance('1s');
    await sleep(100);
    assert.equal(b.ch.events().length, before, 'агенту ничего');
    assert.ok(!readJournal(b.s.home).some((l) => l.ev === 'reaction_released' && l.seq === seq));
    // Исходно стоит 👍 (отдана агенту); в новом окне 👍 → ❤ → 👍 — итог совпал с «было».
    const u3 = h.react(a.msg, ['👍']);
    const s3 = await h.admitted(u3);
    await h.release(s3);
    const u4 = h.react(a.msg, ['❤'], ['👍']);
    const s4 = await h.admitted(u4);
    assert.notEqual(s4, s3, 'после окна — новое событие');
    await b.gw.advance('1s');
    const u5 = h.react(a.msg, ['👍'], ['❤']);
    const j5 = await h.folded(u5, 'reaction_cancelled');
    assert.deepEqual({ seq: j5.seq, emoji: j5.emoji, old: j5.old }, { seq: s4, emoji: ['👍'], old: ['👍'] });
    assert.equal(h.ev(s4).status, 'cancelled');
    for (let i = 0; i < 4; i++) await b.gw.advance('1s');
    await sleep(100);
    assert.ok(!h.given(s4), 'агенту ничего');
  });

  it('A9.25 (по проверке окна): несколько реакций (Premium) — сняли одну и вернули, Telegram прислал другой порядок — отмена, а не пустое событие', async () => {
    const a = await h.answered('две реакции', 'Ответ под две реакции');
    const u1 = h.react(a.msg, ['👍', '❤']);
    const s1 = await h.admitted(u1);
    await h.release(s1);
    const u2 = h.react(a.msg, ['❤'], ['👍', '❤']);
    const s2 = await h.admitted(u2);
    await b.gw.advance('1s');
    const u3 = h.react(a.msg, ['❤', '👍'], ['❤']);
    const j = await h.folded(u3, 'reaction_cancelled');
    assert.equal(j.seq, s2);
    assert.equal(h.ev(s2).status, 'cancelled');
    for (let i = 0; i < 4; i++) await b.gw.advance('1s');
    await sleep(100);
    assert.ok(!h.given(s2), 'агенту ничего');
  });

  it('A9.20: поставил → сменил за 1 с — одно событие с итогом и «было» до окна, окно — заново от последнего изменения; смена после окна — новое событие', async () => {
    const a = await h.answered('поставлю и сменю', 'Ответ под смену');
    const u1 = h.react(a.msg, ['👍']);
    const seq = await h.admitted(u1);
    const first = h.ev(seq).hold_until!;
    await b.gw.advance('1s');
    const u2 = h.react(a.msg, ['❤'], ['👍']);
    const j = await h.folded(u2, 'reaction_merged');
    assert.deepEqual({ seq: j.seq, emoji: j.emoji, old: j.old }, { seq, emoji: ['❤'], old: [] });
    assert.equal(h.ev(seq).hold_until, first + 1000, 'окно — заново от последнего изменения');
    await b.gw.advance('2s');
    await sleep(100);
    assert.ok(!h.given(seq) && h.ev(seq).status === 'held', 'через 3 с от первого — ещё в окне');
    const e = await h.release(seq);
    assert.deepEqual(e.reaction, { to_seq: a.seq, emoji: ['❤'], old: [], excerpt: 'Ответ под смену' });
    assert.equal(e.text, ownerReactionText({ to_seq: a.seq, emoji: ['❤'], old: [], excerpt: 'Ответ под смену' }));
    assert.equal(count(b.s.home, "SELECT count(*) AS n FROM events WHERE kind = 'reaction' AND json_extract(reaction_json, '$.message_id') = ?", a.msg.message_id), 1, 'одно событие');
    // Смена после окна (❤ отдана): новое событие; в его окне ❤ → 🔥 → 👍 — одно событие «👍 (было ❤)».
    const u3 = h.react(a.msg, ['🔥'], ['❤']);
    const s3 = await h.admitted(u3);
    assert.notEqual(s3, seq, 'после окна — новое событие');
    await b.gw.advance('1s');
    await h.folded(h.react(a.msg, ['👍'], ['🔥']), 'reaction_merged');
    const e3 = await h.release(s3);
    assert.deepEqual({ emoji: e3.reaction?.emoji, old: e3.reaction?.old }, { emoji: ['👍'], old: ['❤'] });
    assert.match(e3.text ?? '', /: 👍 \(было ❤\) — твой ответ:/);
  });

  it('A9.21: тот же update ещё раз в окне (Telegram повторил) — update_repeat, второго события нет, окно не сдвигается', async () => {
    const a = await h.answered('повтор в окне', 'Ответ под повтор');
    const u = h.react(a.msg, ['🙏']);
    const seq = await h.admitted(u);
    const until = h.ev(seq).hold_until;
    await b.gw.advance('1s');
    b.s.fake.redeliver(u.update_id);
    await waitUntil(() => readJournal(b.s.home).some((l) => l.ev === 'update_repeat' && l.update_id === u.update_id) || null, 5000, 'update_repeat');
    assert.equal(count(b.s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', u.update_id), 1);
    assert.deepEqual({ status: h.ev(seq).status, until: h.ev(seq).hold_until }, { status: 'held', until });
    await b.gw.advance('2s');
    const e = await b.ch.waitEvent(seq);
    assert.deepEqual(e.reaction?.emoji, ['🙏']);
    await b.ch.delivered(seq);
    await b.ch.done([seq]);
  });

  it('A9.22: перезапуск в окне — остаток окна; снятие после перезапуска в окне — отмена; окно прошло, пока шлюз стоял, — сразу', async () => {
    const restart = async (shiftMs = 0): Promise<void> => {
      b.ch.close();
      await b.gw.stop();
      if (shiftMs) shiftClockFile(b.s.home, shiftMs);
      b.gw = await b.s.start();
      ({ ch: b.ch, turn: b.turn } = await connectAdapter(b.s.home));
    };
    // Остаток: 1 с прошла до остановки — после старта ещё 2 с.
    const a = await h.answered('перезапуск в окне', 'Ответ под перезапуск');
    const seq = await h.admitted(h.react(a.msg, ['👍']));
    await b.gw.advance('1s');
    await restart();
    assert.equal(h.ev(seq).status, 'held');
    await b.gw.advance('1s');
    await sleep(100);
    assert.ok(!h.given(seq), 'через 2 с от записи — ещё в окне');
    await b.gw.advance('1s');
    await b.ch.waitEvent(seq);
    assert.equal(readJournal(b.s.home).find((l) => l.ev === 'reaction_released' && l.seq === seq)?.held_ms, 3000);
    await b.ch.delivered(seq);
    await b.ch.done([seq]);
    // Поставил, шлюз перезапустился, снял — всё в окне: отмена.
    const c = await h.answered('сниму после перезапуска', 'Ответ под снятие');
    const s2 = await h.admitted(h.react(c.msg, ['🔥']));
    await b.gw.advance('1s');
    await restart();
    const j = await h.folded(h.react(c.msg, [], ['🔥']), 'reaction_cancelled');
    assert.equal(j.seq, s2);
    assert.equal(h.ev(s2).status, 'cancelled');
    for (let i = 0; i < 4; i++) await b.gw.advance('1s');
    await sleep(100);
    assert.ok(!h.given(s2), 'агенту ничего');
    // Окно прошло, пока шлюз стоял (часы ушли на 10 с) — отдаётся сразу после старта.
    const d = await h.answered('окно прошло без шлюза', 'Ответ под простой');
    const s3 = await h.admitted(h.react(d.msg, ['👏']));
    await restart(10_000);
    const e = await b.ch.waitEvent(s3);
    assert.deepEqual(e.reaction?.emoji, ['👏']);
    assert.ok(Number(readJournal(b.s.home).find((l) => l.ev === 'reaction_released' && l.seq === s3)?.held_ms) >= 10_000);
    await b.ch.delivered(s3);
    await b.ch.done([s3]);
  });
});

describe('M9 · окно отмены выключено: reactions.hold_seconds: 0 (0.3.4, issue #46)', () => {
  const b = {} as HoldBench;
  const h = holdHelpers(b);
  after(async () => {
    b.ch?.close();
    if (b.gw?.alive) await b.gw.stop();
    await b.s?.close();
  });

  it('A9.23: hold_seconds: 0 — реакция агенту сразу (new, без hold_until), поставил и снял — два события, как до окна', async () => {
    b.s = await setup({ home: { extraConfig: 'reactions:\n  hold_seconds: 0\n' } });
    b.gw = await b.s.start();
    ({ ch: b.ch, turn: b.turn } = await connectAdapter(b.s.home));
    const a = await h.answered('без окна', 'Ответ без окна');
    const seq = await h.admitted(h.react(a.msg, ['👍']));
    assert.notEqual(h.ev(seq).status, 'held', 'окна нет — сразу new (и тут же отдана)');
    assert.equal(h.ev(seq).hold_until, null);
    const e = await b.ch.waitEvent(seq);
    assert.deepEqual(e.reaction?.emoji, ['👍']);
    assert.equal(readJournal(b.s.home).find((l) => l.ev === 'in' && l.seq === seq)?.hold_ms, undefined);
    await b.ch.delivered(seq);
    await b.ch.done([seq]);
    const s2 = await h.admitted(h.react(a.msg, [], ['👍']));
    const e2 = await b.ch.waitEvent(s2);
    assert.deepEqual({ emoji: e2.reaction?.emoji, old: e2.reaction?.old }, { emoji: [], old: ['👍'] });
    await b.ch.delivered(s2);
    await b.ch.done([s2]);
    assert.ok(!readJournal(b.s.home).some((l) => l.ev === 'reaction_released' || l.ev === 'reaction_merged' || l.ev === 'reaction_cancelled'));
  });
});
