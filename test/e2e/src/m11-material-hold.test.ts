// M11 · окно для материала без слов владельца (0.3.6, issue #51) на поддельных Telegram, провайдере голоса и переходнике.
// Материал — сообщение владельца без его слов (пересылка, фото, файл, видео без подписи, инлайн-бот): шлюз держит его
// окном ui.material_hold_seconds (по умолчанию 120 с; здесь — без строки в config.yaml) и отдаёт агенту вместе со словами
// владельца, одним заходом: материал, затем слова.
// A11.1 материал + слова в окне — подряд, материал с пометкой «слова — следом, № M»; 👀 на материале — только после отдачи
// · A11.2 материал без слов — по окну, с пометкой «слов не было», сколько ждал · A11.3 несколько материалов подряд — одно
// окно от последнего; слова отпускают все · A11.4 слова раньше материала, в пределах окна, — материал сразу, без окна; за
// окном — в окно · A11.5 перезапуск в окне — остаток окна; слова после перезапуска отпускают · A11.6 окно 0 — сразу, как
// до 0.3.6 · A11.7 команда «где мы» и стикер окно не выпускают («где мы» — «Ждут слов владельца»); «стоп» — окно идёт,
// материал ждёт [продолжить] · A11.15 голосовое — слова с момента прихода: материал не уходит раньше расшифровки и не
// ждёт окна · A11.16 пересланное голосовое — материал: после расшифровки — в окно; слова — следом (и пока оно ещё
// распознаётся) · A11.17 правка удерживаемого материала (дописал подпись) — слова · A11.19 участник по правилам — окна
// нет.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FakeChannel } from 'stg-fake-channel';
import type { Update } from 'stg-core';
import { connectAdapter, pump, q1, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OTHER, OWNER, reactionsOf, setup, type Setup } from './m1-common.js';
import { buttonsOf, press, waitSent } from './m2-common.js';
import { pushVoice, voiceSetup, waitSttReply, type VoiceSetup } from './m4-common.js';

type Ev = Awaited<ReturnType<FakeChannel['waitEvent']>>;

interface Bench {
  s: Setup;
  gw: GatewayProcess;
  ch: FakeChannel;
  turn: number;
}

const FROM_CHANNEL = { type: 'channel', chat: { id: -100_500, title: 'Наука' } } as const;

/** Владелец и участник по правилам: у участника окна нет. */
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

function helpers(b: Bench) {
  const seqOf = (u: Update): Promise<number> =>
    waitUntil(() => q1<{ seq: number }>(b.s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, `приёма ${u.update_id}`);
  const row = (seq: number): { status: string; hold_until: number | null; created_at: number; material: Record<string, unknown> | null } => {
    const r = q1<{ status: string; hold_until: number | null; created_at: number; material_json: string | null }>(
      b.s.home,
      'SELECT status, hold_until, created_at, material_json FROM events WHERE seq = ?',
      seq,
    )!;
    return { status: r.status, hold_until: r.hold_until, created_at: r.created_at, material: r.material_json ? (JSON.parse(r.material_json) as Record<string, unknown>) : null };
  };
  const given = (seq: number): boolean => b.ch.events().some((x) => x.seq === seq);
  const push = (u: Update): Update => b.s.fake.push(u)[0]!;
  const forward = (text: string): Update => push(b.s.fake.builder.forward(OWNER, FROM_CHANNEL, text));
  const photo = (caption: string | null = null): Update => push(b.s.fake.builder.photo(OWNER, caption));
  const says = (text: string): Update => push(b.s.fake.builder.text(OWNER, text));
  /** Часы вперёд шагами (аренда отвечает на ping между шагами). */
  async function advance(seconds: number, step = 15): Promise<void> {
    for (let left = seconds; left > 0; left -= step) {
      await b.gw.advance(`${Math.min(step, left)}s`);
      await sleep(15);
    }
    await sleep(100);
  }
  /** Событие в окне: held, агенту не отдано. */
  function held(seq: number, what = 'в окне'): void {
    assert.equal(row(seq).status, 'held', `${what}: held`);
    assert.ok(!given(seq), `${what}: агенту не отдано`);
  }
  /** События пришли агенту подряд, в этом порядке, — одним заходом. */
  function inOneGo(seqs: number[]): void {
    const order = b.ch.events().map((e) => e.seq);
    const at = order.indexOf(seqs[0]!);
    assert.ok(at >= 0, `№ ${seqs[0]} не отдан: ${order.join(', ')}`);
    assert.deepEqual(order.slice(at, at + seqs.length), seqs, `подряд: ${order.join(', ')}`);
  }
  async function finish(seqs: number[]): Promise<void> {
    for (const seq of seqs) await b.ch.delivered(seq);
    const r = await b.ch.done(seqs);
    assert.ok(r.type === 'ack', JSON.stringify(r));
  }
  const journal = (ev: string, seq: number): Record<string, unknown> | undefined => readJournal(b.s.home).find((l) => l.ev === ev && l.seq === seq);
  /** Слова владельца из прошлого теста старше окна: следующий материал — снова в окно (правило «слова раньше»). */
  const quiet = (): Promise<void> => advance(121);
  return { seqOf, row, given, push, forward, photo, says, advance, held, inOneGo, finish, journal, quiet };
}

async function start(b: Bench, materialHoldSeconds: number | null = null): Promise<void> {
  b.s = await setup({ home: { materialHoldSeconds, rules: RULES } });
  b.gw = await b.s.start();
  ({ ch: b.ch, turn: b.turn } = await connectAdapter(b.s.home));
}

async function stop(b: Bench): Promise<void> {
  b.ch?.close();
  if (b.gw?.alive) await b.gw.stop();
  await b.s?.close();
}

describe('M11 · окно для материала без слов владельца (0.3.6, #51): по умолчанию 120 с', () => {
  const b = {} as Bench;
  const h = helpers(b);
  before(() => start(b));
  after(() => stop(b));

  it('A11.1: фото без подписи — в окне (held, hold_until = запись + 120 с, 👀 нет); слова владельца через 30 с — фото и слова агенту подряд, фото с пометкой «слова — следом, № M»; 👀 — после отдачи', async () => {
    const pu = h.photo();
    const p = await h.seqOf(pu);
    const r = h.row(p);
    assert.equal(r.hold_until! - r.created_at, 120_000);
    assert.deepEqual(r.material, { state: 'waiting', window_ms: 120_000 });
    const inJ = h.journal('in', p);
    assert.deepEqual([inJ?.material, inJ?.hold_ms], ['held', 120_000]);
    await h.advance(30);
    h.held(p, 'через 30 с');
    assert.deepEqual(reactionsOf(b.s.fake, pu), [], '👀 нет: агент материал ещё не видел');
    const wu = h.says('что тут написано?');
    const w = await h.seqOf(wu);
    const words: Ev = await b.ch.waitEvent(w);
    const mat = b.ch.events().find((e) => e.seq === p)!;
    h.inOneGo([p, w]);
    assert.deepEqual(mat.material, { words: 'after', words_seq: w, waited_ms: null });
    assert.equal(words.material, undefined, 'у слов пометки нет');
    assert.deepEqual(h.row(p).material, { state: 'after', window_ms: 120_000, words_seq: w });
    const rel = h.journal('material_released', p);
    assert.deepEqual([rel?.words, rel?.words_seq, rel?.held_ms], ['after', w, 30_000]);
    // 👀 — когда агент увидел: на фото — только теперь, после окна.
    for (const x of [p, w]) await b.ch.delivered(x);
    await pump(b.gw, () => (reactionsOf(b.s.fake, pu).at(-1) === '👀' && reactionsOf(b.s.fake, wu).at(-1) === '👀') || null, { what: '👀 на фото и словах' });
    await b.ch.done([p, w]);
  });

  it('A11.2: пересылка без слов — 119 с ещё в окне; 120 с — агенту с пометкой «слов владельца не было» и сколько ждала', async () => {
    await h.quiet();
    const f = await h.seqOf(h.forward('Исследование: сон и память'));
    await h.advance(119, 17);
    h.held(f, 'через 119 с');
    await h.advance(1);
    const e = await b.ch.waitEvent(f);
    assert.deepEqual(e.material, { words: 'none', words_seq: null, waited_ms: 120_000 });
    assert.equal(e.trust, 'untrusted');
    assert.deepEqual([h.journal('material_released', f)?.words, h.journal('material_released', f)?.held_ms], ['none', 120_000]);
    assert.deepEqual(h.row(f).material, { state: 'none', window_ms: 120_000, waited_ms: 120_000 });
    await h.finish([f]);
  });

  it('A11.3: несколько материалов подряд — одно окно от последнего; без слов — выходят вместе; затем три материала и слова — все со словами', async () => {
    await h.quiet();
    const a = await h.seqOf(h.forward('первая ссылка'));
    await h.advance(60);
    const c = await h.seqOf(h.photo());
    assert.equal(h.row(a).hold_until, h.row(c).hold_until, 'окно первого — от последнего материала');
    assert.deepEqual(h.journal('in', c)?.extended, [a]);
    await h.advance(90);
    h.held(a, 'через 150 с от первого');
    await h.advance(30);
    await b.ch.waitEvent(c);
    h.inOneGo([a, c]);
    const ea = b.ch.events().find((e) => e.seq === a)!;
    assert.deepEqual(ea.material, { words: 'none', words_seq: null, waited_ms: 180_000 }, 'первый ждал 3 минуты');
    await h.finish([a, c]);
    // Три материала и слова: все — со словами, по порядку.
    const m1 = await h.seqOf(h.forward('раз'));
    const m2 = await h.seqOf(h.forward('два'));
    await h.advance(20);
    const m3 = await h.seqOf(h.photo());
    await h.advance(20);
    const w = await h.seqOf(h.says('сравни эти три'));
    await b.ch.waitEvent(w);
    h.inOneGo([m1, m2, m3, w]);
    for (const m of [m1, m2, m3]) assert.deepEqual(b.ch.events().find((e) => e.seq === m)?.material, { words: 'after', words_seq: w, waited_ms: null });
    await h.finish([m1, m2, m3, w]);
  });

  it('A11.4: слова раньше материала, в пределах окна, — материал сразу (пометка «слова — раньше, № K»); слова старше окна — материал в окно', async () => {
    await h.quiet();
    const w = await h.seqOf(h.says('сейчас пришлю статью — перескажи'));
    await b.ch.waitEvent(w);
    await h.advance(40);
    const f = await h.seqOf(h.forward('Статья'));
    const e = await b.ch.waitEvent(f);
    assert.deepEqual(e.material, { words: 'before', words_seq: w, waited_ms: null });
    assert.equal(h.row(f).hold_until, null, 'окна нет');
    assert.deepEqual([h.journal('in', f)?.material, h.journal('in', f)?.words_seq], ['words_before', w]);
    await h.finish([w, f]);
    await h.advance(121);
    const g = await h.seqOf(h.forward('Ещё статья'));
    h.held(g, 'слова были 121 с назад');
    await h.advance(120);
    await b.ch.waitEvent(g);
    await h.finish([g]);
  });

  it('A11.5: перезапуск в окне — остаток окна; слова после перезапуска отпускают удерживаемое', async () => {
    const restart = async (): Promise<void> => {
      b.ch.close();
      await b.gw.stop();
      b.gw = await b.s.start();
      ({ ch: b.ch, turn: b.turn } = await connectAdapter(b.s.home));
    };
    await h.quiet();
    const f = await h.seqOf(h.forward('до перезапуска'));
    await h.advance(60);
    await restart();
    h.held(f, 'после перезапуска');
    await h.advance(59);
    h.held(f, 'через 119 с');
    await h.advance(1);
    const e = await b.ch.waitEvent(f);
    assert.equal(e.material?.words, 'none');
    assert.equal(h.journal('material_released', f)?.held_ms, 120_000);
    await h.finish([f]);
    const g = await h.seqOf(h.photo());
    await h.advance(10);
    await restart();
    h.held(g, 'после перезапуска');
    const w = await h.seqOf(h.says('это из отчёта'));
    await b.ch.waitEvent(w);
    h.inOneGo([g, w]);
    assert.equal(b.ch.events().find((x) => x.seq === g)?.material?.words_seq, w);
    await h.finish([g, w]);
  });

  it('A11.7: «где мы» и стикер окно не выпускают («где мы» — «Ждут слов владельца: 1 (№ N)»); «стоп» — окно идёт, материал ждёт [продолжить] и уходит с пометкой «слов не было»', async () => {
    await h.quiet();
    const f = await h.seqOf(h.forward('пока думаю'));
    h.push(b.s.fake.builder.text(OWNER, 'где мы'));
    const where = await waitSent(b.s, b.gw, (m) => (m.text ?? '').startsWith('⚙ Где мы'), 'ответа «где мы»');
    assert.ok((where.text ?? '').includes(`Ждут слов владельца: 1 (№ ${f})`), where.text ?? '');
    const w = await b.ch.where();
    assert.ok(w.type === 'where_result' && w.data?.held_material?.includes(f) && !w.data.waiting.includes(f), JSON.stringify(w));
    const sticker = await h.seqOf(h.push(b.s.fake.builder.sticker(OWNER)));
    await b.ch.waitEvent(sticker);
    h.held(f, 'после «где мы» и стикера');
    await h.finish([sticker]);
    h.push(b.s.fake.builder.text(OWNER, 'стоп'));
    const line = await waitSent(b.s, b.gw, (m) => m.text === '⚙ Остановлен, сообщения сохраняю' && buttonsOf(m).some((x) => x.text === 'продолжить'), 'строки «стоп»');
    await b.ch.waitMode('stopped');
    h.held(f, 'команда «стоп» — не слова');
    await h.advance(120);
    assert.equal(h.row(f).status, 'new', 'окно прошло и в «стоп»');
    assert.ok(!h.given(f), 'в «стоп» не отдан');
    assert.equal(await press(b.s, line, 'продолжить'), null);
    await b.ch.waitMode('running');
    b.turn = b.ch.currentTurn()!;
    const e = await b.ch.waitEvent(f);
    assert.equal(e.material?.words, 'none');
    await h.finish([f]);
  });

  it('A11.17: правка удерживаемого фото (владелец дописал подпись) — слова: фото и правка подряд', async () => {
    await h.quiet();
    const pu = h.photo();
    const p = await h.seqOf(pu);
    await h.advance(10);
    const eu = h.push(b.s.fake.builder.edited(pu, 'вот это сократи'));
    const e = await h.seqOf(eu);
    const ev = await b.ch.waitEvent(e);
    assert.equal(ev.edit_of, p);
    h.inOneGo([p, e]);
    assert.deepEqual(b.ch.events().find((x) => x.seq === p)?.material, { words: 'after', words_seq: e, waited_ms: null });
    await h.finish([p, e]);
  });

  it('A11.19: участник по правилам: его пересылка и фото без подписи — агенту сразу, без окна и пометки (окно — только у владельца)', async () => {
    await h.quiet();
    const f = await h.seqOf(h.push(b.s.fake.builder.forward(OTHER, FROM_CHANNEL, 'пересылка участника')));
    const p = await h.seqOf(h.push(b.s.fake.builder.photo(OTHER, null)));
    const ef = await b.ch.waitEvent(f);
    const ep = await b.ch.waitEvent(p);
    assert.deepEqual([ef.material, ep.material, h.row(f).material, h.row(p).hold_until], [undefined, undefined, null, null]);
    assert.equal(ef.subject?.id, 'anya');
    await h.finish([f, p]);
  });
});

describe('M11 · окно выключено: ui.material_hold_seconds: 0 (0.3.6, #51)', () => {
  const b = {} as Bench;
  const h = helpers(b);
  before(() => start(b, 0));
  after(() => stop(b));

  it('A11.6: окно 0 — пересылка и фото без подписи агенту сразу, без пометки, как до 0.3.6', async () => {
    const f = await h.seqOf(h.forward('сразу'));
    const p = await h.seqOf(h.photo());
    const ef = await b.ch.waitEvent(f);
    const ep = await b.ch.waitEvent(p);
    assert.equal(ef.material, undefined);
    assert.equal(ep.material, undefined);
    assert.deepEqual([h.row(f).hold_until, h.row(f).material], [null, null]);
    assert.equal(readJournal(b.s.home).filter((l) => String(l.ev).startsWith('material_')).length, 0);
    await h.finish([f, p]);
  });
});

describe('M11 · голосовое владельца — слова с момента прихода (0.3.6, #51)', () => {
  let s: VoiceSetup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  const seqOf = (u: Update): Promise<number> => waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
  const status = (seq: number): string | undefined => q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status;
  before(async () => {
    s = await voiceSetup({ fake: { transcript: 'перескажи это коротко' }, materialHoldSeconds: null });
    gw = await s.start();
    ({ ch } = await connectAdapter(s.home));
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('A11.15: фото в окне, затем голосовое: фото не уходит раньше расшифровки и не ждёт окна — фото и голосовое подряд, фото «слова — следом, № голосового»', async () => {
    const p = await seqOf(s.fake.push(s.fake.builder.photo(OWNER, null))[0]!);
    assert.equal(status(p), 'held');
    s.voice.latencyMs = 1500;
    const vu = pushVoice(s, 4);
    const v = await seqOf(vu);
    const linked = await waitUntil(() => readJournal(s.home).find((l) => l.ev === 'material_linked' && l.seq === p), 5000, 'material_linked');
    assert.equal(linked.words_seq, v);
    await sleep(300);
    assert.equal(status(v), 'transcribing', 'голосовое ещё распознаётся');
    assert.equal(status(p), 'held', 'фото ждёт расшифровки слов');
    assert.ok(!ch.events().some((e) => e.seq === p), 'фото не обгоняет голосовое');
    const ev = await ch.waitEvent(v, 15_000);
    assert.equal(ev.transcript, 'перескажи это коротко');
    const order = ch.events().map((e) => e.seq);
    assert.deepEqual(order.slice(order.indexOf(p), order.indexOf(p) + 2), [p, v], 'подряд: фото, голосовое');
    assert.deepEqual(ch.events().find((e) => e.seq === p)?.material, { words: 'after', words_seq: v, waited_ms: null });
    assert.equal(readJournal(s.home).find((l) => l.ev === 'material_released' && l.seq === p)?.words_seq, v);
    s.voice.latencyMs = 0;
    await waitSttReply(s, gw, vu);
    for (const x of [p, v]) await ch.delivered(x);
    await ch.done([p, v]);
  });

  it('A11.16: пересланное голосовое — материал: распознано и снова в окне; слова владельца — следом, подряд; слова, пока оно распознаётся, — тоже подряд после расшифровки', async () => {
    // Голосовое владельца из A11.15 — его слова; следующий материал в пределах окна ушёл бы сразу (правило «слова раньше»).
    for (let i = 0; i < 9; i++) await gw.advance('15s');
    const fu = pushVoice(s, 3, { forwardFrom: { type: 'user', user: OTHER } });
    const f = await seqOf(fu);
    await waitUntil(() => readJournal(s.home).find((l) => l.ev === 'material_held' && l.seq === f), 10_000, 'material_held после расшифровки');
    assert.equal(status(f), 'held');
    assert.ok(!ch.events().some((e) => e.seq === f));
    const w = await seqOf(s.fake.push(s.fake.builder.text(OWNER, 'ответь ей вежливо'))[0]!);
    await ch.waitEvent(w);
    const order = ch.events().map((e) => e.seq);
    assert.deepEqual(order.slice(order.indexOf(f), order.indexOf(f) + 2), [f, w]);
    const ef = ch.events().find((e) => e.seq === f)!;
    assert.equal(ef.trust, 'untrusted');
    assert.deepEqual(ef.material, { words: 'after', words_seq: w, waited_ms: null });
    for (const x of [f, w]) await ch.delivered(x);
    await ch.done([f, w]);
    // Слова пришли, пока пересланное голосовое ещё распознаётся: оно уходит, когда распознано, — и сразу слова.
    for (let i = 0; i < 9; i++) await gw.advance('15s');
    s.voice.latencyMs = 1200;
    const f2 = await seqOf(pushVoice(s, 3, { forwardFrom: { type: 'user', user: OTHER } }));
    const w2 = await seqOf(s.fake.push(s.fake.builder.text(OWNER, 'и на это тоже'))[0]!);
    const linked = await waitUntil(() => readJournal(s.home).find((l) => l.ev === 'material_linked' && l.seq === f2), 5000, 'material_linked');
    assert.equal(linked.words_seq, w2);
    assert.equal(status(f2), 'transcribing');
    await ch.waitEvent(w2, 15_000);
    const order2 = ch.events().map((e) => e.seq);
    assert.deepEqual(order2.slice(order2.indexOf(f2), order2.indexOf(f2) + 2), [f2, w2]);
    assert.deepEqual(ch.events().find((e) => e.seq === f2)?.material, { words: 'after', words_seq: w2, waited_ms: null });
    s.voice.latencyMs = 0;
    for (const x of [f2, w2]) await ch.delivered(x);
    await ch.done([f2, w2]);
  });
});
