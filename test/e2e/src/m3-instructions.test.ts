// Правила канала продолженному разговору (0.3.5, issue #47). Claude Code передаёт instructions MCP-сервера разговору только
// при первом подключении канала к нему: продолженный (--resume) разговор новую версию не получает, а разговор, начатый без
// канала, не получает её вовсе. Канал называет в hello версию своих instructions (instructions_version); шлюз помнит, какую
// версию получил каждый разговор (conversations: ключ — сессия по строке состояния, а без неё — процесс канала), и
// разговору со старой или неизвестной версией отдаёт одно событие «правила канала» (вид instructions); done — версия
// записана.
// - новый разговор (сессия неизвестна): после пробы — событие правил раньше накопленного; done — записано за процессом;
//   тот же процесс после обрыва — без события; where() агента — «получил»;
// - продолженный со старой версией — событие новой; продолженный, начатый без канала (разговора нет в базе), — событие;
// - повтор: тот же процесс после обрыва — то же событие за ним (второго нет), done на него засчитан; срок К-5 — повтор с
//   redelivery; другой процесс того же разговора — то же событие снова (redelivery);
// - перезапуск шлюза между отдачей и done — второго события нет, done засчитан;
// - «стоп» — событие правил проходит, как проба; done принимается;
// - второй переходник (другой разговор) — своё событие; открытое событие прежнего закрыто (handled);
// - канал без версии (до 0.3.5) — событий правил нет; reply на событие правил — отказ; первая строка состояния живой
//   аренды — записанное за процессом переходит к сессии (второго события нет); живой /clear — новому разговору своё;
// - настоящий канал под поддельным Claude Code: в событии — instructions целиком и их версия; done — версия записана.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { INSTRUCTIONS, INSTRUCTIONS_VERSION } from 'stg-channel';
import { FakeChannel } from 'stg-fake-channel';
import { FakeClaude } from './fake-claude.js';
import { q1, readJournal, runCliInput, sleep, waitUntil, type GatewayProcess, type JournalLine } from './harness.js';
import { OWNER, setup, type Setup } from './m1-common.js';

const ID_A = 'procA_0123456789abcdef';
const ID_B = 'procB_0123456789abcdef';
const ID_C = 'procC_0123456789abcdef';
const V1 = 'aaaa11112222';
const V2 = 'bbbb33334444';

type Ev = Extract<Awaited<ReturnType<FakeChannel['waitEvent']>>, { type: 'event' }>;

const hash = (id: string): string => crypto.createHash('sha256').update(id).digest('hex');

/** Переходник: hello с версией правил (или без неё — канал до 0.3.5); probe — проба ожидается (ответ — сам). */
async function adapter(
  s: Setup,
  opts: { instanceId?: string; prevLease?: string; version?: string; probe: boolean },
): Promise<{ ch: FakeChannel; lease: string; turn: number }> {
  const ch = await FakeChannel.connect(s.home.paths.socket);
  const w = await ch.hello({
    ...(opts.instanceId ? { instanceId: opts.instanceId } : {}),
    ...(opts.prevLease ? { prevLease: opts.prevLease } : {}),
    ...(opts.version ? { instructionsVersion: opts.version } : {}),
  });
  if (w.type !== 'welcome') {
    ch.close();
    throw new Error(`hello: ${JSON.stringify(w)}`);
  }
  if (opts.probe) await ch.waitVerified();
  return { ch, lease: w.lease_id, turn: w.turn };
}

/** n-е событие правил, пришедшее переходнику. */
function waitInstructions(ch: FakeChannel, n = 1): Promise<Ev> {
  return waitUntil(() => ch.instructions()[n - 1], 10_000, `события «правила канала» № ${n}`);
}

/** Строка состояния Claude Code (сессия) в каталоге аренды — каталоге теста. */
async function statusline(s: Setup, sessionId: string): Promise<void> {
  const r = await runCliInput(
    ['agent-state', 'statusline'],
    s.env,
    JSON.stringify({
      session_id: sessionId,
      cwd: process.cwd(),
      workspace: { current_dir: process.cwd(), project_dir: process.cwd() },
      model: { display_name: 'Opus' },
      context_window: { used_percentage: 12 },
      cost: { total_cost_usd: 0.1 },
    }),
  );
  assert.equal(r.code, 0, r.stderr);
}

const conv = (s: Setup, key: string): { instructions: string; seq: number | null } | undefined =>
  q1<{ instructions: string; seq: number | null }>(s.home, 'SELECT instructions, seq FROM conversations WHERE key = ?', key);
const statusOf = (s: Setup, seq: number): string | undefined => q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status;

function journal(s: Setup, ev: string, pred: (l: JournalLine) => boolean = () => true): JournalLine[] {
  return readJournal(s.home).filter((l) => l.ev === ev && pred(l));
}

async function settle(gw: GatewayProcess, n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await gw.advance('1s');
  await sleep(30);
}

/** Сообщение владельца → его № в базе. */
async function says(s: Setup, text: string): Promise<number> {
  const u = s.fake.push(s.fake.builder.text(OWNER, text))[0]!;
  return waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
}

async function doneOk(ch: FakeChannel, seq: number): Promise<void> {
  const r = await ch.done([seq]);
  assert.ok(r.type === 'ack', JSON.stringify(r));
}

describe('M3 · правила канала продолженному разговору (0.3.5, #47)', () => {
  it('новый разговор: после пробы — событие правил раньше накопленного; done — версия записана; тот же процесс после обрыва — без события; where() — «получил»', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const waiting = await says(s, 'пока агента нет');
      const a1 = await adapter(s, { instanceId: ID_A, version: V1, probe: true });
      const ins = await waitInstructions(a1.ch);
      assert.deepEqual(
        { kind: ins.kind, version: ins.instructions?.version, trust: ins.trust, redelivery: ins.redelivery, episode: ins.episode, text: ins.text },
        { kind: 'instructions', version: V1, trust: null, redelivery: false, episode: null, text: null },
      );
      await a1.ch.waitEvent(waiting);
      const order = a1.ch.received.filter((r) => r.message?.type === 'event' && r.message.kind !== 'probe').map((r) => (r.message as Ev).seq);
      assert.deepEqual(order, [ins.seq, waiting], 'правила — раньше накопленного (хотя их № больше)');
      assert.ok(ins.seq > waiting);
      const offered = journal(s, 'instructions_offered', (l) => l.seq === ins.seq)[0]!;
      assert.deepEqual([offered.version, offered.conversation, offered.had, offered.trigger], [V1, `instance:${hash(ID_A).slice(0, 8)}`, null, 'verified']);
      assert.equal(conv(s, `instance:${hash(ID_A)}`), undefined, 'до done не записано');
      // where() агента до done: событие отдано и ждёт done; второго события нет.
      const w0 = await a1.ch.where();
      assert.ok(w0.type === 'where_result');
      assert.ok(w0.text.endsWith(`\nПравила канала: версия ${V1} — событие № ${ins.seq} «правила канала» отдано и ждёт твоего done.`), w0.text);
      await a1.ch.delivered(ins.seq);
      await doneOk(a1.ch, ins.seq);
      assert.deepEqual({ ...conv(s, `instance:${hash(ID_A)}`) }, { instructions: V1, seq: ins.seq });
      assert.equal(statusOf(s, ins.seq), 'processed');
      assert.equal(journal(s, 'instructions_received', (l) => l.seq === ins.seq)[0]?.version, V1);
      const w1 = await a1.ch.where();
      assert.ok(w1.type === 'where_result' && w1.text.endsWith(`\nПравила канала: версия ${V1} — этот разговор их получил (№ ${ins.seq}).`), JSON.stringify(w1));
      // Владельцу «где мы» — без строки о правилах.
      const cli = await FakeChannel.connect(s.home.paths.socket);
      try {
        const wc = await cli.where();
        assert.ok(wc.type === 'where_result' && !wc.text.includes('Правила канала'), 'не агенту — без строки правил');
      } finally {
        cli.close();
      }
      a1.ch.close();
      await waitUntil(() => journal(s, 'lease_released', (l) => l.lease === a1.lease)[0], 5000, 'снятия аренды');
      const a2 = await adapter(s, { instanceId: ID_A, prevLease: a1.lease, version: V1, probe: false });
      try {
        await settle(gw);
        assert.equal(a2.ch.instructions().length, 0, 'тот же разговор — правила уже есть');
      } finally {
        a2.ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('продолженный разговор со старой версией — событие новой; разговор, начатый без канала (его нет в базе), — событие; та же версия — без события', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      await statusline(s, 'sess-one');
      const a1 = await adapter(s, { instanceId: ID_A, version: V1, probe: true });
      const i1 = await waitInstructions(a1.ch);
      await doneOk(a1.ch, i1.seq);
      assert.equal(conv(s, 'session:sess-one')?.instructions, V1);
      a1.ch.close();
      await waitUntil(() => journal(s, 'lease_released', (l) => l.lease === a1.lease)[0], 5000, 'снятия аренды');
      // Шлюз и канал обновлены; Claude Code продолжил тот же разговор (--resume): процесс канала новый, сессия та же.
      const b = await adapter(s, { instanceId: ID_B, version: V2, probe: true });
      const i2 = await waitInstructions(b.ch);
      assert.equal(i2.instructions?.version, V2);
      const offered = journal(s, 'instructions_offered', (l) => l.seq === i2.seq)[0]!;
      assert.deepEqual([offered.conversation, offered.had], ['session:sess-one', V1]);
      await doneOk(b.ch, i2.seq);
      assert.deepEqual({ ...conv(s, 'session:sess-one') }, { instructions: V2, seq: i2.seq });
      b.ch.close();
      await waitUntil(() => journal(s, 'lease_released', (l) => l.lease === b.lease)[0], 5000, 'снятия аренды');
      // Ещё раз продолжили — версия та же: события нет.
      const c = await adapter(s, { instanceId: ID_C, version: V2, probe: true });
      await settle(gw);
      assert.equal(c.ch.instructions().length, 0, 'версия та же — без события');
      c.ch.close();
      await waitUntil(() => journal(s, 'lease_released', (l) => l.lease === c.lease)[0], 5000, 'снятия аренды');
      // Разговор, начатый без канала, продолжен уже с каналом (установщик): его в базе нет — событие.
      await statusline(s, 'sess-old');
      const d = await adapter(s, { instanceId: ID_A, version: V2, probe: true });
      try {
        const i3 = await waitInstructions(d.ch);
        assert.deepEqual([journal(s, 'instructions_offered', (l) => l.seq === i3.seq)[0]?.conversation, journal(s, 'instructions_offered', (l) => l.seq === i3.seq)[0]?.had], ['session:sess-old', null]);
        await doneOk(d.ch, i3.seq);
        assert.equal(conv(s, 'session:sess-old')?.instructions, V2);
      } finally {
        d.ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('повтор: тот же процесс после обрыва — событие за ним, второго нет, done засчитан; без ответа 10 минут — снова с redelivery; другой процесс того же разговора — то же событие снова', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      await statusline(s, 'sess-r');
      const a1 = await adapter(s, { instanceId: ID_A, version: V1, probe: true });
      const i1 = await waitInstructions(a1.ch);
      await a1.ch.delivered(i1.seq);
      a1.ch.close();
      await waitUntil(() => journal(s, 'lease_released', (l) => l.lease === a1.lease)[0], 5000, 'снятия аренды');
      // Тот же процесс (сон ноутбука, обрыв): событие переходит к новой аренде, второго нет.
      const a2 = await adapter(s, { instanceId: ID_A, prevLease: a1.lease, version: V1, probe: false });
      await settle(gw);
      assert.equal(a2.ch.instructions().length, 0, 'второго события нет');
      // Без ответа срок К-5 — снова, с redelivery.
      await gw.advance('11m');
      const again = await waitInstructions(a2.ch);
      assert.deepEqual([again.seq, again.redelivery], [i1.seq, true]);
      a2.ch.close();
      await waitUntil(() => journal(s, 'lease_released', (l) => l.lease === a2.lease)[0], 5000, 'снятия аренды');
      // Другой процесс того же разговора (--resume после закрытия Claude Code): то же событие снова.
      const b = await adapter(s, { instanceId: ID_B, version: V1, probe: true });
      try {
        const i2 = await waitInstructions(b.ch);
        assert.deepEqual([i2.seq, i2.redelivery], [i1.seq, true], 'то же событие, повтором');
        assert.equal(journal(s, 'instructions_offered', (l) => l.lease === b.lease)[0]?.again, true);
        await doneOk(b.ch, i1.seq);
        assert.deepEqual({ ...conv(s, 'session:sess-r') }, { instructions: V1, seq: i1.seq });
        assert.equal(q1<{ n: number }>(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'instructions'")!.n, 1, 'событие правил одно');
      } finally {
        b.ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('перезапуск шлюза между отдачей и done — тот же процесс без второго события, done на прежнее засчитан', async () => {
    const s = await setup();
    try {
      const g1 = await s.start();
      const a1 = await adapter(s, { instanceId: ID_A, version: V1, probe: true });
      const i1 = await waitInstructions(a1.ch);
      await a1.ch.delivered(i1.seq);
      await g1.stop();
      a1.ch.close();
      const g2 = await s.start();
      const a2 = await adapter(s, { instanceId: ID_A, prevLease: a1.lease, version: V1, probe: false });
      try {
        await settle(g2);
        assert.equal(a2.ch.instructions().length, 0, 'второго события нет');
        await doneOk(a2.ch, i1.seq);
        assert.deepEqual({ ...conv(s, `instance:${hash(ID_A)}`) }, { instructions: V1, seq: i1.seq });
      } finally {
        a2.ch.close();
      }
      await g2.stop();
    } finally {
      await s.close();
    }
  });

  it('«стоп»: событие правил проходит, как проба; накопленное ждёт [продолжить]; done принимается', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const waiting = await says(s, 'сделай отчёт');
      await says(s, 'стоп');
      await waitUntil(() => q1<{ value: string }>(s.home, "SELECT value FROM meta WHERE key = 'mode'")?.value === 'stopped' || null, 5000, 'режима «стоп»');
      const a = await adapter(s, { instanceId: ID_A, version: V1, probe: true });
      try {
        const ins = await waitInstructions(a.ch);
        await settle(gw);
        assert.ok(!a.ch.events().some((e) => e.seq === waiting), 'в «стоп» накопленное не отдаётся');
        await doneOk(a.ch, ins.seq);
        assert.equal(conv(s, `instance:${hash(ID_A)}`)?.instructions, V1);
      } finally {
        a.ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('второй переходник — другой разговор: своё событие; открытое событие прежнего закрыто', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      await statusline(s, 'sess-a');
      const a = await adapter(s, { instanceId: ID_A, version: V1, probe: true });
      const ia = await waitInstructions(a.ch);
      a.ch.close();
      await waitUntil(() => journal(s, 'lease_released', (l) => l.lease === a.lease)[0], 5000, 'снятия аренды');
      await statusline(s, 'sess-b');
      const b = await adapter(s, { instanceId: ID_B, version: V1, probe: true });
      try {
        const ib = await waitInstructions(b.ch);
        assert.notEqual(ib.seq, ia.seq);
        assert.equal(statusOf(s, ia.seq), 'handled', 'событие прежнего разговора закрыто');
        assert.ok(journal(s, 'instructions_closed', (l) => l.lease === b.lease && (l.seqs as number[]).includes(ia.seq)).length);
        const r = await b.ch.done([ia.seq]);
        assert.ok(r.type === 'error' && r.code === 'not_your_lease', 'чужое событие правил — не этой сессии');
        await doneOk(b.ch, ib.seq);
        assert.equal(conv(s, 'session:sess-b')?.instructions, V1);
        assert.equal(conv(s, 'session:sess-a'), undefined, 'прежний разговор правил не подтверждал');
      } finally {
        b.ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('канал без версии (до 0.3.5) — событий правил нет; reply на событие правил — отказ; первая строка состояния — записанное за процессом переходит к сессии; живой /clear — новому разговору своё', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const old = await adapter(s, { instanceId: ID_C, probe: true });
      await settle(gw);
      assert.equal(old.ch.instructions().length, 0, 'канал до 0.3.5 — без событий правил');
      const w = await old.ch.where();
      assert.ok(w.type === 'where_result' && !w.text.includes('Правила канала'));
      old.ch.close();
      await waitUntil(() => journal(s, 'lease_released', (l) => l.lease === old.lease)[0], 5000, 'снятия аренды');
      const a = await adapter(s, { instanceId: ID_A, version: V1, probe: true });
      try {
        const i1 = await waitInstructions(a.ch);
        const r = await a.ch.reply(i1.seq, 'прочитал', a.turn);
        assert.ok(r.type === 'error' && r.code === 'bad_request' && r.text.includes('на них отвечают done'), JSON.stringify(r));
        await doneOk(a.ch, i1.seq);
        // Строка состояния пришла уже после (сессия стала известна): правила, записанные за процессом, — за ней.
        await gw.advance('2s');
        await statusline(s, 'sess-x');
        await waitUntil(() => journal(s, 'agent_session', (l) => l.lease === a.lease)[0], 10_000, 'agent_session');
        await settle(gw);
        assert.equal(conv(s, 'session:sess-x')?.instructions, V1);
        assert.equal(a.ch.instructions().length, 1, 'второго события нет');
        // Живой /clear: другой разговор в том же процессе — своё событие.
        await gw.advance('2s');
        await statusline(s, 'sess-y');
        const i2 = await waitInstructions(a.ch, 2);
        assert.notEqual(i2.seq, i1.seq);
        assert.equal(journal(s, 'instructions_offered', (l) => l.seq === i2.seq)[0]?.trigger, 'session_changed');
        await doneOk(a.ch, i2.seq);
        assert.equal(conv(s, 'session:sess-y')?.instructions, V1);
      } finally {
        a.ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('настоящий канал под поддельным Claude Code: событие правил — instructions целиком и их версия; done — версия записана за разговором', async () => {
    const s = await setup();
    let fc: FakeClaude | null = null;
    try {
      await s.start();
      fc = await FakeClaude.start(s.home, { autoInstructions: false });
      await fc.waitVerified();
      const n = await fc.waitNotice((x) => x.meta.kind === 'instructions', 10_000, 'события правил');
      assert.equal(n.meta.version, INSTRUCTIONS_VERSION);
      assert.ok(n.content.startsWith(`[№ ${n.meta.seq} · правила канала, версия ${INSTRUCTIONS_VERSION}] `), n.content.slice(0, 120));
      assert.ok(n.content.endsWith(INSTRUCTIONS), 'текст правил — целиком');
      assert.equal(fc.client.getInstructions(), INSTRUCTIONS, 'тот же текст, что в инструкциях сервера');
      const d = await fc.call('done', { seqs: [Number(n.meta.seq)] });
      assert.equal(d.isError, false, d.text);
      const rec = q1<{ key: string; instructions: string; seq: number }>(s.home, 'SELECT key, instructions, seq FROM conversations');
      assert.deepEqual([rec?.key.startsWith('instance:'), rec?.instructions, rec?.seq], [true, INSTRUCTIONS_VERSION, Number(n.meta.seq)]);
      const w = await fc.call('where');
      assert.ok(w.text.endsWith(`Правила канала: версия ${INSTRUCTIONS_VERSION} — этот разговор их получил (№ ${n.meta.seq}).`), w.text);
    } finally {
      await fc?.close();
      await s.close();
    }
  });
});
