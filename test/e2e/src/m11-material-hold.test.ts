// M11 · окно для материала без слов владельца (0.3.6, issue #51) на поддельных Telegram, провайдере голоса и переходнике.
// Материал — сообщение владельца без его слов (пересылка, фото, файл, видео без подписи, инлайн-бот): шлюз держит его
// окном ui.material_hold_seconds (по умолчанию 60 с; здесь — без строки в config.yaml) и отдаёт агенту вместе со словами
// владельца, одним заходом: материал, затем слова. После окна — слова к материалу: реплай на него и первые слова после
// материала, ушедшего без слов (ui.material_followup_minutes, по умолчанию 10 мин).
// A11.1 материал + слова в окне — подряд, материал с пометкой «слова — следом, № M»; 👀 на материале — только после отдачи
// · A11.2 материал без слов — по окну, с пометкой «слов не было», сколько ждал · A11.3 несколько материалов подряд — одно
// окно от последнего; слова отпускают все · A11.4 слова раньше материала, в пределах окна, — материал сразу, без окна; за
// окном — в окно · A11.5 перезапуск в окне — остаток окна; слова после перезапуска отпускают · A11.6 окно 0 — сразу, как
// до 0.3.6 · A11.7 команда «где мы» и стикер окно не выпускают («где мы» — «Ждут слов владельца»); «стоп» — окно идёт,
// материал ждёт [продолжить] · A11.15 голосовое — слова с момента прихода: материал не уходит раньше расшифровки и не
// ждёт окна · A11.16 пересланное голосовое — материал: после расшифровки — в окно; слова — следом (и пока оно ещё
// распознаётся) · A11.17 правка удерживаемого материала (дописал подпись) — слова · A11.19 участник по правилам — окна
// нет · A11.20 правка удерживаемого материала без слов (живое место, фото заменено без подписи) — не слова: ждёт с
// исходным, окно не сдвигает · A11.21 «новая тема» в окне — материал агенту раньше «эпизод закрыт», с пометкой «слов не
// было» · A11.22 прежний сценарий картинки (media(seq), 👀 → 👌) с окном по умолчанию · A11.23 реплай на материал — «слова к
// материалу № N» (после окна, в окне, окно 0 — по классификации) · A11.24 слова после материала — первые слова владельца
// после материала без слов в пределах 10 мин (голосовое — по приходу; перезапуск; 0 — выключено) · A11.25 текст владельца
// из одних ссылок (поделился страницей из браузера) — материал без слов: окно, «следом», «не было», одно окно на
// несколько, не «слова после материала», правило «слова раньше», реплай на него; «посмотри https://…» — слова; окно 0 —
// сразу.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FakeChannel } from 'stg-fake-channel';
import type { Update } from 'stg-core';
import { connectAdapter, pump, q1, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OTHER, OWNER, reactionsOf, setup, type Setup } from './m1-common.js';
import { buttonsOf, press, waitSent } from './m2-common.js';
import { pushVoice, voiceSetup, waitSttReply, type VoiceSetup } from './m4-common.js';
import { imageBytes, jpegBytes, mediaOf } from './m7-common.js';

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
  const quiet = (): Promise<void> => advance(61);
  return { seqOf, row, given, push, forward, photo, says, advance, held, inOneGo, finish, journal, quiet };
}

async function start(b: Bench, materialHoldSeconds: number | null = null, extraConfig?: string): Promise<void> {
  b.s = await setup({ home: { materialHoldSeconds, rules: RULES, ...(extraConfig ? { extraConfig } : {}) } });
  b.gw = await b.s.start();
  ({ ch: b.ch, turn: b.turn } = await connectAdapter(b.s.home));
}

async function stop(b: Bench): Promise<void> {
  b.ch?.close();
  if (b.gw?.alive) await b.gw.stop();
  await b.s?.close();
}

describe('M11 · окно для материала без слов владельца (0.3.6, #51): по умолчанию 60 с', () => {
  const b = {} as Bench;
  const h = helpers(b);
  before(() => start(b));
  after(() => stop(b));

  it('A11.1: фото без подписи — в окне (held, hold_until = запись + 60 с, 👀 нет); слова владельца через 30 с — фото и слова агенту подряд, фото с пометкой «слова — следом, № M»; 👀 — после отдачи', async () => {
    const pu = h.photo();
    const p = await h.seqOf(pu);
    const r = h.row(p);
    assert.equal(r.hold_until! - r.created_at, 60_000);
    assert.deepEqual(r.material, { state: 'waiting', window_ms: 60_000 });
    const inJ = h.journal('in', p);
    assert.deepEqual([inJ?.material, inJ?.hold_ms], ['held', 60_000]);
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
    assert.deepEqual(h.row(p).material, { state: 'after', window_ms: 60_000, words_seq: w });
    const rel = h.journal('material_released', p);
    assert.deepEqual([rel?.words, rel?.words_seq, rel?.held_ms], ['after', w, 30_000]);
    // 👀 — когда агент увидел: на фото — только теперь, после окна.
    for (const x of [p, w]) await b.ch.delivered(x);
    await pump(b.gw, () => (reactionsOf(b.s.fake, pu).at(-1) === '👀' && reactionsOf(b.s.fake, wu).at(-1) === '👀') || null, { what: '👀 на фото и словах' });
    await b.ch.done([p, w]);
  });

  it('A11.2: пересылка без слов — 59 с ещё в окне; 60 с — агенту с пометкой «слов владельца не было» и сколько ждала', async () => {
    await h.quiet();
    const f = await h.seqOf(h.forward('Исследование: сон и память'));
    await h.advance(59, 17);
    h.held(f, 'через 59 с');
    await h.advance(1);
    const e = await b.ch.waitEvent(f);
    assert.deepEqual(e.material, { words: 'none', words_seq: null, waited_ms: 60_000 });
    assert.equal(e.trust, 'untrusted');
    assert.deepEqual([h.journal('material_released', f)?.words, h.journal('material_released', f)?.held_ms], ['none', 60_000]);
    assert.deepEqual(h.row(f).material, { state: 'none', window_ms: 60_000, waited_ms: 60_000 });
    await h.finish([f]);
  });

  it('A11.3: несколько материалов подряд — одно окно от последнего; без слов — выходят вместе; затем три материала и слова — все со словами', async () => {
    await h.quiet();
    const a = await h.seqOf(h.forward('первая ссылка'));
    await h.advance(30);
    const c = await h.seqOf(h.photo());
    assert.equal(h.row(a).hold_until, h.row(c).hold_until, 'окно первого — от последнего материала');
    assert.deepEqual(h.journal('in', c)?.extended, [a]);
    await h.advance(45);
    h.held(a, 'через 75 с от первого');
    await h.advance(15);
    await b.ch.waitEvent(c);
    h.inOneGo([a, c]);
    const ea = b.ch.events().find((e) => e.seq === a)!;
    assert.deepEqual(ea.material, { words: 'none', words_seq: null, waited_ms: 90_000 }, 'первый ждал полторы минуты');
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

  it('A11.4: слова раньше материала, в пределах окна (через 40 с), — материал сразу (пометка «слова — раньше, № K»); слова старше окна — материал в окно', async () => {
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
    await h.advance(61);
    const g = await h.seqOf(h.forward('Ещё статья'));
    h.held(g, 'слова были 61 с назад');
    await h.advance(60);
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
    await h.advance(30);
    await restart();
    h.held(f, 'после перезапуска');
    await h.advance(29);
    h.held(f, 'через 59 с');
    await h.advance(1);
    const e = await b.ch.waitEvent(f);
    assert.equal(e.material?.words, 'none');
    assert.equal(h.journal('material_released', f)?.held_ms, 60_000);
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
    await h.advance(60);
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

  it('A11.20: правка удерживаемого материала без слов — не слова: живое место шлёт координаты правками — окно не отпускают и не сдвигают, правки ждут с местом; слова — место, правки, слова подряд; фото заменено без подписи — по окну вместе', async () => {
    await h.quiet();
    const lu = h.push(b.s.fake.builder.location(OWNER, { latitude: 12.34, longitude: 56.78, livePeriod: 900 }));
    const l = await h.seqOf(lu);
    h.held(l, 'место');
    const until = h.row(l).hold_until;
    await h.advance(20);
    const e1 = await h.seqOf(h.push(b.s.fake.builder.editedLocation(lu, { latitude: 12.35, longitude: 56.79 })));
    await h.advance(20);
    const e2 = await h.seqOf(h.push(b.s.fake.builder.editedLocation(lu, { latitude: 12.36, longitude: 56.8 })));
    h.held(l, 'место после правок без слов');
    h.held(e1, 'правка без слов — ждёт с местом');
    h.held(e2, 'вторая правка — тоже');
    assert.deepEqual([h.row(l).hold_until, h.row(e1).hold_until, h.row(e2).hold_until], [until, until, until], 'окно не сдвинуто');
    assert.deepEqual([h.journal('in', e1)?.material, h.journal('in', e1)?.joined, h.journal('in', e1)?.extended], ['held', l, undefined]);
    assert.equal(h.journal('material_released', l), undefined, 'правка без слов окно не отпустила');
    const w = await b.ch.where();
    assert.ok(w.type === 'where_result' && w.data?.held_material?.join() === String(l) && w.data.held_material_count === 1, JSON.stringify(w));
    const words = await h.seqOf(h.says('я тут, подъезжай'));
    await b.ch.waitEvent(words);
    h.inOneGo([l, e1, e2, words]);
    for (const x of [l, e1, e2]) assert.deepEqual(b.ch.events().find((e) => e.seq === x)?.material, { words: 'after', words_seq: words, waited_ms: null });
    assert.deepEqual([b.ch.events().find((e) => e.seq === e1)?.edit_of, b.ch.events().find((e) => e.seq === e2)?.edit_of], [l, l]);
    await h.finish([l, e1, e2, words]);
    // Фото заменено без подписи: правка ждёт с фото; окно кончилось — оба с пометкой «слов не было», по порядку.
    await h.quiet();
    const pu = h.photo();
    const p = await h.seqOf(pu);
    await h.advance(30);
    const pe = await h.seqOf(h.push(b.s.fake.builder.edited(pu, '')));
    h.held(pe, 'правка фото без подписи');
    await h.advance(29);
    h.held(p, 'через 59 с');
    await h.advance(1);
    await b.ch.waitEvent(pe);
    h.inOneGo([p, pe]);
    assert.deepEqual(
      [b.ch.events().find((e) => e.seq === p)?.material, b.ch.events().find((e) => e.seq === pe)?.material],
      [
        { words: 'none', words_seq: null, waited_ms: 60_000 },
        { words: 'none', words_seq: null, waited_ms: 30_000 },
      ],
    );
    await h.finish([p, pe]);
  });

  it('A11.21: «новая тема» в окне — материал эпизода агенту раньше события «эпизод закрыт», с пометкой «слов владельца не было»; слова после — в новом эпизоде, отпускать нечего', async () => {
    await h.quiet();
    const w0 = await h.seqOf(h.says('собираю отпуск'));
    await b.ch.waitEvent(w0);
    await h.finish([w0]);
    await h.quiet();
    const f = await h.seqOf(h.forward('Билеты подешевели'));
    h.held(f, 'пересылка');
    const ep = q1<{ episode_id: number }>(b.s.home, 'SELECT episode_id FROM events WHERE seq = ?', f)!.episode_id;
    assert.equal(q1<{ episode_id: number }>(b.s.home, 'SELECT episode_id FROM events WHERE seq = ?', w0)!.episode_id, ep, 'материал — в эпизоде разговора');
    await h.advance(15);
    h.push(b.s.fake.builder.text(OWNER, 'новая тема'));
    const closed = await waitUntil(() => q1<{ seq: number }>(b.s.home, "SELECT seq FROM events WHERE kind = 'episode_closed' AND episode_id = ?", ep)?.seq, 5000, 'события «эпизод закрыт»');
    await b.ch.waitEvent(closed);
    const order = b.ch.events().map((e) => e.seq);
    assert.ok(order.indexOf(f) >= 0 && order.indexOf(f) < order.indexOf(closed), `материал раньше «эпизод закрыт»: ${order.join(', ')}`);
    const ef = b.ch.events().find((e) => e.seq === f)!;
    assert.deepEqual(ef.material, { words: 'none', words_seq: null, waited_ms: 15_000 });
    assert.equal(ef.episode?.id, ep);
    const rel = h.journal('material_released', f);
    assert.deepEqual([rel?.words, rel?.episode_closed, rel?.held_ms], ['none', ep, 15_000]);
    assert.ok(f < closed);
    await h.finish([f]);
    assert.equal((await b.ch.episodeSummary(ep, 'Собирали отпуск; пришла пересылка о билетах.')).type, 'ack');
    const w = await h.seqOf(h.says('глянь, что там с ценами'));
    const ew = await b.ch.waitEvent(w);
    assert.notEqual(ew.episode?.id, ep, 'слова — в новом эпизоде');
    // Слова после материала — только в том же эпизоде (A11.24): материал остался в прежнем — пометки нет.
    assert.equal(ew.after_material, undefined);
    assert.equal(h.row(f).material?.followup_seq, undefined);
    assert.equal(readJournal(b.s.home).filter((l) => l.ev === 'material_released' && l.seq === f).length, 1, 'материал отдан один раз');
    await h.finish([w]);
  });

  it('A11.22: прежний сценарий картинки (A7.1, A7.4) с окном по умолчанию — фото без подписи в окне: media(seq) «агенту ещё не отдавался», 👀 нет; слова — фото и слова подряд; media(seq) — картинка; 👀, затем 👌 на фото и словах', async () => {
    await h.quiet();
    const data = jpegBytes(800, 600, 5000, 3);
    b.s.fake.addFile(data, { fileId: 'm11ph', path: 'photos/m11ph.jpg' });
    const pu = h.push(b.s.fake.builder.photo(OWNER, null, { sizes: [{ fileId: 'm11ph', width: 800, height: 600, fileSize: data.length }] }));
    const p = await h.seqOf(pu);
    h.held(p, 'фото');
    const refused = await mediaOf(b.ch, p);
    assert.deepEqual(refused.ok ? null : { code: refused.code, text: refused.text }, { code: 'not_your_lease', text: `№ ${p} агенту ещё не отдавался` });
    assert.deepEqual(reactionsOf(b.s.fake, pu), [], '👀 нет');
    await h.advance(25);
    const wu = h.says('что на фото?');
    const w = await h.seqOf(wu);
    await b.ch.waitEvent(w);
    h.inOneGo([p, w]);
    const ep = b.ch.events().find((e) => e.seq === p)!;
    assert.deepEqual([ep.trust, ep.mixed, ep.media, ep.material], ['owner', true, { what: 'photo' }, { words: 'after', words_seq: w, waited_ms: null }]);
    const shown = await mediaOf(b.ch, p);
    assert.ok(shown.ok, JSON.stringify(shown));
    assert.deepEqual(imageBytes(shown.r), data);
    for (const x of [p, w]) await b.ch.delivered(x);
    await pump(b.gw, () => (reactionsOf(b.s.fake, pu).at(-1) === '👀' && reactionsOf(b.s.fake, wu).at(-1) === '👀') || null, { what: '👀 на фото и словах' });
    assert.equal((await b.ch.done([p])).type, 'ack');
    assert.equal((await b.ch.reply(w, 'На фото — чек из магазина.', b.ch.currentTurn() ?? b.turn)).type, 'ack');
    await pump(b.gw, () => (reactionsOf(b.s.fake, pu).at(-1) === '👌' && reactionsOf(b.s.fake, wu).at(-1) === '👌') || null, { what: '👌 на фото и словах' });
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

  it('A11.23 (окно 0): реплай на пересылку — материал по классификации (material_json нет): reply_to.material; реплай на своё слово — без признака; слов после материала нет — окна не было', async () => {
    const fu = h.forward('Статья');
    const f = await h.seqOf(fu);
    await b.ch.waitEvent(f);
    await h.finish([f]);
    const r = await h.seqOf(h.push(b.s.fake.builder.replyTo(OWNER, 'перескажи', fu.message!)));
    const er = await b.ch.waitEvent(r);
    assert.deepEqual(er.reply_to, { kind: 'owner', event_seq: f, episode_topic: er.episode?.topic, material: true });
    assert.equal(h.journal('in', r)?.reply_to_material, true);
    const wu = h.says('купить хлеба');
    const w = await h.seqOf(wu);
    await b.ch.waitEvent(w);
    const r2 = await h.seqOf(h.push(b.s.fake.builder.replyTo(OWNER, 'и молока', wu.message!)));
    const er2 = await b.ch.waitEvent(r2);
    assert.equal(er2.reply_to?.material, undefined, 'своё слово — не материал');
    assert.deepEqual([er.after_material, er2.after_material], [undefined, undefined]);
    await h.finish([r, w, r2]);
  });

  it('A11.25 (окно 0): текст владельца из одной ссылки — агенту сразу, без пометки, метка owner, как до 0.3.6; реплай на него — материал по классификации (reply_to.material)', async () => {
    const lu = h.says('https://example.com/now');
    const l = await h.seqOf(lu);
    const el = await b.ch.waitEvent(l);
    assert.deepEqual([el.trust, el.material], ['owner', undefined]);
    assert.deepEqual([h.row(l).hold_until, h.row(l).material], [null, null]);
    await h.finish([l]);
    const r = await b.ch.waitEvent(await h.seqOf(h.push(b.s.fake.builder.replyTo(OWNER, 'перескажи', lu.message!))));
    assert.deepEqual([r.reply_to?.event_seq, r.reply_to?.material], [l, true]);
    await h.finish([r.seq]);
  });
});

describe('M11 · слова владельца к материалу после окна (0.3.6, #51): реплай на материал, слова после материала', () => {
  const b = {} as Bench;
  const h = helpers(b);
  before(() => start(b));
  after(() => stop(b));

  /** Материал без слов: окно (60 с) прошло — отдан с «слов не было»; агент отметил. */
  async function wordless(u: Update): Promise<number> {
    const seq = await h.seqOf(u);
    await h.advance(60);
    const e = await b.ch.waitEvent(seq);
    assert.equal(e.material?.words, 'none');
    await h.finish([seq]);
    return seq;
  }
  /** Слова владельца — событие у агента. */
  async function words(u: Update): Promise<Ev> {
    return b.ch.waitEvent(await h.seqOf(u));
  }

  it('A11.23: реплай на материал после окна — reply_to.material, «слова к материалу № N»: и через 20 мин, и не первыми словами; в окне — реплай отпускает материал («следом, № M»), у слов — «к материалу № N»; на своё слово — как раньше', async () => {
    const fu = h.forward('Исследование: сон и память');
    const f = await wordless(fu);
    const wu0 = h.says('где ты был вчера');
    const w0 = await words(wu0);
    await h.finish([w0.seq]);
    await h.advance(1200);
    const r = await words(h.push(b.s.fake.builder.replyTo(OWNER, 'сохрани это в заметки', fu.message!)));
    assert.deepEqual([r.reply_to?.kind, r.reply_to?.event_seq, r.reply_to?.material], ['owner', f, true]);
    assert.deepEqual([h.journal('in', r.seq)?.reply_to, h.journal('in', r.seq)?.reply_to_seq, h.journal('in', r.seq)?.reply_to_material], ['owner', f, true]);
    assert.equal(r.after_material, undefined);
    await h.finish([r.seq]);
    // В окне: реплай на удерживаемое фото — его слова: фото и реплай подряд, пометки не спорят.
    await h.quiet();
    const pu = h.photo();
    const p = await h.seqOf(pu);
    h.held(p, 'фото');
    await h.advance(20);
    const r2 = await words(h.push(b.s.fake.builder.replyTo(OWNER, 'вот это сократи', pu.message!)));
    h.inOneGo([p, r2.seq]);
    assert.deepEqual(b.ch.events().find((e) => e.seq === p)?.material, { words: 'after', words_seq: r2.seq, waited_ms: null });
    assert.deepEqual([r2.reply_to?.event_seq, r2.reply_to?.material, r2.material], [p, true, undefined]);
    // Реплай на своё слово — не материал: «ответ на своё сообщение», как раньше.
    const r3 = await words(h.push(b.s.fake.builder.replyTo(OWNER, 'и ещё', wu0.message!)));
    assert.deepEqual([r3.reply_to?.kind, r3.reply_to?.event_seq, r3.reply_to?.material], ['owner', w0.seq, undefined]);
    await h.finish([p, r2.seq, r3.seq]);
  });

  it('A11.24: слова после материала — первые слова владельца после материала без слов, в том же чате и эпизоде, не позже 10 мин: after_material [N] («слова после материала № N»), followup_seq у материала, in.after_material; вторые — без пометки; два материала — оба; 10 мин — да, 10 мин 1 с — нет; реплай на материал — приоритет, и следующие слова — без пометки', async () => {
    await h.quiet();
    const f = await wordless(h.forward('Статья о сне'));
    await h.advance(300);
    const w = await words(h.says('сохрани в заметки'));
    assert.deepEqual(w.after_material, [f]);
    assert.equal(w.material, undefined);
    assert.equal(h.row(f).material?.followup_seq, w.seq);
    assert.deepEqual(h.journal('in', w.seq)?.after_material, [f]);
    const w2 = await words(h.says('и напомни завтра'));
    assert.equal(w2.after_material, undefined, 'только первые слова');
    await h.finish([w.seq, w2.seq]);
    // Два материала, ушедшие без слов в разное время, — оба; ровно 10 мин после выпуска первого (второй вышел на 90 с
    // позже) — ещё да.
    await h.quiet();
    const a = await wordless(h.forward('первая'));
    await h.advance(30);
    const c = await wordless(h.photo());
    await h.advance(510);
    const wc = await words(h.says('сравни их'));
    assert.deepEqual(wc.after_material, [a, c]);
    await h.finish([wc.seq]);
    // 10 мин 1 с — уже нет; и следующие слова — тоже нет.
    await h.quiet();
    const g = await wordless(h.forward('поздняя'));
    await h.advance(601);
    const wg = await words(h.says('это про что?'));
    assert.equal(wg.after_material, undefined);
    assert.equal(h.row(g).material?.followup_seq, undefined);
    await h.finish([wg.seq]);
    // Реплай на материал первыми словами — «к материалу», без «после»; следующие слова — без пометки.
    await h.quiet();
    const mu = h.forward('ещё ссылка');
    const m = await wordless(mu);
    const rm = await words(h.push(b.s.fake.builder.replyTo(OWNER, 'это в архив', mu.message!)));
    assert.deepEqual([rm.reply_to?.material, rm.after_material], [true, undefined]);
    const wm = await words(h.says('и закрой задачу'));
    assert.equal(wm.after_material, undefined, 'реплай на материал — уже первые слова');
    assert.equal(h.row(m).material?.followup_seq, undefined);
    await h.finish([rm.seq, wm.seq]);
  });

  it('A11.24: перезапуск — связь в базе: слова, отданные до перезапуска без done, приходят снова с той же пометкой', async () => {
    await h.quiet();
    const f = await wordless(h.forward('до перезапуска'));
    const w = await words(h.says('отложи на вечер'));
    assert.deepEqual(w.after_material, [f]);
    await b.ch.delivered(w.seq);
    b.ch.close();
    await b.gw.stop();
    b.gw = await b.s.start();
    ({ ch: b.ch, turn: b.turn } = await connectAdapter(b.s.home));
    const again = await b.ch.waitEvent(w.seq);
    assert.deepEqual([again.redelivery, again.after_material], [true, [f]]);
    await h.finish([w.seq]);
  });
});

describe('M11 · текст владельца из одних ссылок — материал без слов (0.3.6, #51): поделился страницей из браузера', () => {
  const b = {} as Bench;
  const h = helpers(b);
  before(() => start(b));
  after(() => stop(b));

  it('A11.25: текст из одной ссылки — в окне (held); слова через 20 с — ссылка и слова подряд, ссылка «слова владельца — следом, № M», метка в кадре — owner; без слов — по окну, «слов владельца не было за 1 мин»; следующие слова — «слова после материала»', async () => {
    const l = await h.seqOf(h.says('https://example.com/article'));
    h.held(l, 'ссылка');
    assert.deepEqual(h.row(l).material, { state: 'waiting', window_ms: 60_000 });
    assert.equal(h.journal('in', l)?.material, 'held');
    await h.advance(20);
    h.held(l, 'через 20 с');
    const w = await h.seqOf(h.says('сохрани, прочитаю вечером'));
    const ew = await b.ch.waitEvent(w);
    h.inOneGo([l, w]);
    const el = b.ch.events().find((e) => e.seq === l)!;
    assert.deepEqual([el.trust, el.text, el.material], ['owner', 'https://example.com/article', { words: 'after', words_seq: w, waited_ms: null }]);
    assert.deepEqual([ew.material, ew.after_material], [undefined, undefined]);
    await h.finish([l, w]);
    // Без слов — по окну.
    await h.quiet();
    const l2 = await h.seqOf(h.says('https://example.com/other'));
    await h.advance(59, 17);
    h.held(l2, 'через 59 с');
    await h.advance(1);
    const e2 = await b.ch.waitEvent(l2);
    assert.deepEqual(e2.material, { words: 'none', words_seq: null, waited_ms: 60_000 });
    assert.equal(h.journal('material_released', l2)?.words, 'none');
    await h.finish([l2]);
    const w2 = await b.ch.waitEvent(await h.seqOf(h.says('это на потом')));
    assert.deepEqual(w2.after_material, [l2]);
    await h.finish([w2.seq]);
  });

  it('A11.25: несколько ссылок подряд — одно окно (и с фото): ссылка окно не выпускает, а сдвигает; без слов — выходят вместе по окну; следующие слова — «слова после материала» ко всем', async () => {
    await h.quiet();
    const p = await h.seqOf(h.photo());
    await h.advance(20);
    const l1 = await h.seqOf(h.says('https://a.example/1'));
    h.held(p, 'ссылка — не слова: фото держится');
    assert.deepEqual(h.journal('in', l1)?.extended, [p]);
    await h.advance(20);
    const l2 = await h.seqOf(h.says('www.b.example/2\nt.me/c/3'));
    assert.deepEqual(h.journal('in', l2)?.extended, [p, l1]);
    const until = h.row(l2).hold_until;
    assert.deepEqual([h.row(p).hold_until, h.row(l1).hold_until], [until, until], 'одно окно — от последней ссылки');
    await h.advance(59, 17);
    for (const x of [p, l1, l2]) h.held(x, 'через 59 с от последней ссылки');
    await h.advance(1);
    await b.ch.waitEvent(l2);
    h.inOneGo([p, l1, l2]);
    assert.deepEqual(
      [p, l1, l2].map((x) => b.ch.events().find((e) => e.seq === x)?.material),
      [
        { words: 'none', words_seq: null, waited_ms: 100_000 },
        { words: 'none', words_seq: null, waited_ms: 80_000 },
        { words: 'none', words_seq: null, waited_ms: 60_000 },
      ],
    );
    await h.finish([p, l1, l2]);
    const w = await b.ch.waitEvent(await h.seqOf(h.says('выбери лучшее')));
    assert.deepEqual(w.after_material, [p, l1, l2]);
    await h.finish([w.seq]);
  });

  it('A11.25: ссылка после материала, ушедшего без слов, — не «слова после материала»: сама ждёт окна; первые слова после неё — «после материала» к прежнему, ссылка — «следом»', async () => {
    await h.quiet();
    const f = await h.seqOf(h.forward('Исследование: сон и память'));
    await h.advance(60);
    assert.equal((await b.ch.waitEvent(f)).material?.words, 'none');
    await h.finish([f]);
    await h.advance(60);
    const l = await h.seqOf(h.says('https://example.com/sleep'));
    h.held(l, 'ссылка после материала');
    assert.equal(h.row(f).material?.followup_seq, undefined, 'ссылка — не слова после материала');
    assert.equal(h.journal('in', l)?.after_material, undefined);
    await h.advance(30);
    const w = await h.seqOf(h.says('сравни с исследованием'));
    const ew = await b.ch.waitEvent(w);
    h.inOneGo([l, w]);
    assert.deepEqual(ew.after_material, [f]);
    assert.equal(h.row(f).material?.followup_seq, w);
    const el = b.ch.events().find((e) => e.seq === l)!;
    assert.deepEqual([el.material, el.after_material], [{ words: 'after', words_seq: w, waited_ms: null }, undefined]);
    await h.finish([l, w]);
  });

  it('A11.25: слова раньше ссылки, в пределах окна, — ссылка сразу, «слова владельца — раньше, № K»; «посмотри https://…» — слова: сразу, без окна, и отпускают удерживаемое фото', async () => {
    await h.quiet();
    const w = await h.seqOf(h.says('сейчас скину статью — перескажи'));
    await b.ch.waitEvent(w);
    await h.advance(30);
    const l = await h.seqOf(h.says('https://example.com/news'));
    const el = await b.ch.waitEvent(l);
    assert.deepEqual(el.material, { words: 'before', words_seq: w, waited_ms: null });
    assert.equal(h.row(l).hold_until, null);
    assert.equal(h.journal('in', l)?.material, 'words_before');
    await h.finish([w, l]);
    await h.quiet();
    const p = await h.seqOf(h.photo());
    h.held(p, 'фото');
    await h.advance(10);
    const s = await h.seqOf(h.says('посмотри https://example.com/related — то же, что на фото?'));
    const es = await b.ch.waitEvent(s);
    h.inOneGo([p, s]);
    assert.deepEqual([h.row(s).hold_until, h.row(s).material, es.material], [null, null, undefined]);
    assert.deepEqual(b.ch.events().find((e) => e.seq === p)?.material, { words: 'after', words_seq: s, waited_ms: null });
    await h.finish([p, s]);
  });

  it('A11.25: реплай владельца на ссылку — «слова к материалу № N»: после окна (через 2 мин) и в окне (реплай отпускает ссылку, подряд)', async () => {
    await h.quiet();
    const lu = h.says('https://example.com/recipe');
    const l = await h.seqOf(lu);
    await h.advance(60);
    assert.equal((await b.ch.waitEvent(l)).material?.words, 'none');
    await h.finish([l]);
    await h.advance(120);
    const r = await b.ch.waitEvent(await h.seqOf(h.push(b.s.fake.builder.replyTo(OWNER, 'сохрани в рецепты', lu.message!))));
    assert.deepEqual([r.reply_to?.kind, r.reply_to?.event_seq, r.reply_to?.material, r.after_material], ['owner', l, true, undefined]);
    assert.equal(h.journal('in', r.seq)?.reply_to_material, true);
    await h.finish([r.seq]);
    await h.quiet();
    const l2u = h.says('t.me/somechannel/7');
    const l2 = await h.seqOf(l2u);
    h.held(l2, 'ссылка в окне');
    await h.advance(10);
    const r2 = await b.ch.waitEvent(await h.seqOf(h.push(b.s.fake.builder.replyTo(OWNER, 'перескажи', l2u.message!))));
    h.inOneGo([l2, r2.seq]);
    assert.deepEqual([r2.reply_to?.event_seq, r2.reply_to?.material], [l2, true]);
    assert.deepEqual(b.ch.events().find((e) => e.seq === l2)?.material, { words: 'after', words_seq: r2.seq, waited_ms: null });
    await h.finish([l2, r2.seq]);
  });
});

describe('M11 · слова после материала выключены: ui.material_followup_minutes: 0 (0.3.6, #51)', () => {
  const b = {} as Bench;
  const h = helpers(b);
  before(() => start(b, null, 'ui: { material_followup_minutes: 0 }\n'));
  after(() => stop(b));

  it('A11.24 (0): окно — по умолчанию (60 с); материал без слов, слова через минуту — без пометки «после», followup_seq нет; реплай на материал — «к материалу», как всегда', async () => {
    const fu = h.forward('Статья');
    const f = await h.seqOf(fu);
    assert.equal(h.row(f).hold_until! - h.row(f).created_at, 60_000);
    await h.advance(60);
    await b.ch.waitEvent(f);
    await h.finish([f]);
    await h.advance(60);
    const w = await b.ch.waitEvent(await h.seqOf(h.says('сохрани')));
    assert.equal(w.after_material, undefined);
    assert.equal(h.row(f).material?.followup_seq, undefined);
    const r = await b.ch.waitEvent(await h.seqOf(h.push(b.s.fake.builder.replyTo(OWNER, 'и это', fu.message!))));
    assert.equal(r.reply_to?.material, true);
    await h.finish([w.seq, r.seq]);
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

  it('A11.15: фото в окне, затем голосовое: фото не уходит раньше расшифровки и не ждёт окна (60 с) — фото и голосовое подряд, фото «слова — следом, № голосового»', async () => {
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

  it('A11.24: голосовое после материала без слов — «слова после материала» по времени прихода: пришло за 1 с до конца 10 мин, распознано позже — пометка есть', async () => {
    for (let i = 0; i < 5; i++) await gw.advance('15s');
    const p = await seqOf(s.fake.push(s.fake.builder.photo(OWNER, null))[0]!);
    for (let i = 0; i < 4; i++) await gw.advance('15s');
    const ep = await ch.waitEvent(p);
    assert.deepEqual(ep.material, { words: 'none', words_seq: null, waited_ms: 60_000 });
    await ch.delivered(p);
    await ch.done([p]);
    for (let i = 0; i < 39; i++) await gw.advance('15s');
    await gw.advance('14s');
    s.voice.latencyMs = 1500;
    const vu = pushVoice(s, 4);
    const v = await seqOf(vu);
    const followup = (): unknown => {
      const r = q1<{ material_json: string }>(s.home, 'SELECT material_json FROM events WHERE seq = ?', p)!;
      return (JSON.parse(r.material_json) as { followup_seq?: number }).followup_seq;
    };
    assert.equal(followup(), v, 'связь — при записи голосового');
    assert.equal(status(v), 'transcribing');
    await gw.advance('15s');
    const ev = await ch.waitEvent(v, 15_000);
    assert.deepEqual(ev.after_material, [p]);
    s.voice.latencyMs = 0;
    await waitSttReply(s, gw, vu);
    await ch.delivered(v);
    await ch.done([v]);
  });
});
