// R-4 а (0.3.2; P-13): проверочное событие (ход модели) — только для новой
// сессии. Переходник 0.3.2 называет себя в hello: instance_id — ключ процесса (живёт, пока жив процесс), prev_lease —
// аренда до обрыва. Шлюз помнит последнюю проверенную аренду (meta.last_lease: аренда, хэш ключа, сессия Claude Code по
// строке состояния) — и после своего перезапуска тоже.
// - тот же процесс, та же аренда, сессия не сменилась — аренда проверена сразу (lease_verified reason same_instance),
//   пробы нет; отданное без ответа не возвращается в new и не отдаётся снова сразу, переходит к новой аренде ⟨предл.⟩;
//   meta.probes_saved +1; «статус» и stg status — сколько проверок обошлось без хода модели;
// - другой процесс (другой instance_id) или переходник до 0.3.2 (без instance_id) — проба, как раньше; отданное — снова
//   new и отдаётся после проверки;
// - сессия сменилась между подключениями (строка состояния с другим session_id: /clear, новый Claude Code) — проба и
//   повтор отданного;
// - сессия сменилась у живой аренды (/clear в том же процессе) — отданное прежнему разговору снова, с redelivery: да,
//   без пробы ⟨предл.⟩; вернулась уже виденная сессия (/resume) — ей повторяется только то, что ушло без неё
//   (по проверке 0.3.2: прежде возврат не давал повтора вовсе);
// - агент ушёл командой cd в подпапку — сессия узнаётся по каталогу проекта (project_dir), как у 🧠 (по проверке 0.3.2);
// - перезапуск шлюза — тот же процесс переходника переподключается без пробы; отданное остаётся за ним (kept_for_session);
//   процесс не вернулся — оставленное ждёт (📥 N, строка «не на связи»), другой процесс получает его после пробы;
// - полуоткрытая аренда (сон ноутбука: шлюз ещё держит прежнее соединение, а переходник уже переподключился) — тот же
//   процесс забирает свою аренду: прежнее соединение закрыто (replaced), busy нет.

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { META_KEYS } from 'stg-core';
import { FakeChannel } from 'stg-fake-channel';
import { meta, pump, q1, readJournal, runCli, runCliInput, sleep, waitUntil, type GatewayProcess, type JournalLine } from './harness.js';
import { OWNER, setup, statusLineOf, type Setup } from './m1-common.js';

const ID_A = 'procA_0123456789abcdef';
const ID_B = 'procB_0123456789abcdef';

/** Переходник: соединение и hello; probe — проба ожидается (ответ на неё — сам, как сессия с каналом). */
async function adapter(s: Setup, opts: { instanceId?: string; prevLease?: string; probe: boolean }): Promise<{ ch: FakeChannel; lease: string; turn: number }> {
  const ch = await FakeChannel.connect(s.home.paths.socket);
  const w = await ch.hello({ ...(opts.instanceId ? { instanceId: opts.instanceId } : {}), ...(opts.prevLease ? { prevLease: opts.prevLease } : {}) });
  if (w.type !== 'welcome') {
    ch.close();
    throw new Error(`hello: ${JSON.stringify(w)}`);
  }
  if (opts.probe) await ch.waitVerified();
  return { ch, lease: w.lease_id, turn: w.turn };
}

function line(s: Setup, ev: string, lease: string): JournalLine | undefined {
  return readJournal(s.home).find((l) => l.ev === ev && l.lease === lease);
}

function waitLine(s: Setup, ev: string, lease: string): Promise<JournalLine> {
  return waitUntil(() => line(s, ev, lease), 10_000, `${ev} аренды ${lease}`);
}

/** Сообщение владельца → его № в базе. */
async function says(s: Setup, text: string): Promise<number> {
  const u = s.fake.push(s.fake.builder.text(OWNER, text))[0]!;
  return waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
}

const statusOf = (s: Setup, seq: number): { status: string; lease_id: string | null } | undefined =>
  q1<{ status: string; lease_id: string | null }>(s.home, 'SELECT status, lease_id FROM events WHERE seq = ?', seq);

/**
 * Строка состояния Claude Code в каталоге аренды (session_hint.cwd поддельного переходника — каталог теста); currentDir —
 * текущий каталог оболочки агента (cd в подпапку), каталог проекта — всегда каталог аренды.
 */
async function statusline(s: Setup, sessionId: string, currentDir = process.cwd()): Promise<void> {
  const r = await runCliInput(
    ['agent-state', 'statusline'],
    s.env,
    JSON.stringify({
      session_id: sessionId,
      cwd: currentDir,
      workspace: { current_dir: currentDir, project_dir: process.cwd() },
      model: { display_name: 'Opus' },
      context_window: { used_percentage: 12 },
      cost: { total_cost_usd: 0.1 },
    }),
  );
  assert.equal(r.code, 0, r.stderr);
}

async function settle(gw: GatewayProcess, n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await gw.advance('1s');
  await sleep(30);
}

describe('M3 · проба канала только для новой сессии (0.3.2, R-4 а)', () => {
  it('тот же процесс и та же аренда — без пробы и без повтора; отданное перешло к новой аренде; probes_saved; «статус» и stg status', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const a1 = await adapter(s, { instanceId: ID_A, probe: true });
      assert.equal((await waitLine(s, 'lease_granted', a1.lease)).probe_reason, 'new_instance', 'первое подключение процесса — проба');
      const seq = await says(s, 'подумай над планом');
      await a1.ch.waitEvent(seq);
      await a1.ch.delivered(seq);
      a1.ch.close();
      const rel = await waitLine(s, 'lease_released', a1.lease);
      assert.equal(rel.kept_for_session, 1, 'отданное остаётся за процессом');
      assert.deepEqual({ ...statusOf(s, seq) }, { status: 'delivered', lease_id: a1.lease });
      // Переподключение того же процесса (сон ноутбука, обрыв сокета).
      const a2 = await adapter(s, { instanceId: ID_A, prevLease: a1.lease, probe: false });
      try {
        const ver = await waitLine(s, 'lease_verified', a2.lease);
        assert.deepEqual([ver.reason, ver.after_ms], ['same_instance', 0]);
        const granted = line(s, 'lease_granted', a2.lease)!;
        assert.deepEqual([granted.same_session, granted.prev_lease, granted.adopted, granted.probe], [true, a1.lease, [seq], null]);
        await settle(gw);
        assert.equal(a2.ch.probes().length, 0, 'пробы нет — хода модели нет');
        assert.ok(!a2.ch.events().some((e) => e.seq === seq), 'отданное не отдано снова');
        assert.deepEqual({ ...statusOf(s, seq) }, { status: 'delivered', lease_id: a2.lease }, 'отданное — за новой арендой');
        // Новое сообщение идёт сразу; ответ на прежнее — принят.
        const seq2 = await says(s, 'и ещё одно');
        await a2.ch.waitEvent(seq2);
        assert.equal((await a2.ch.reply(seq, 'надумал', a2.turn)).type, 'ack');
        await pump(gw, () => s.fake.sentTo(OWNER.id).some((m) => m.text === 'надумал') || null, { what: 'ответа на прежнее' });
        const saved = JSON.parse(meta(s.home, META_KEYS.probesSaved) ?? '{}') as { n?: number };
        assert.equal(saved.n, 1, 'probes_saved');
        // «статус» в чате: та же сессия и сколько проверок обошлось без хода модели.
        s.fake.push(s.fake.builder.text(OWNER, 'статус'));
        const st = await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text?.startsWith('⚙ Статус')), { what: 'строки «Статус»' });
        assert.match(st.text!, /\nПереходник: на связи \(fake-channel, с \d\d:\d\d; та же сессия — без проверочного события\) · без хода модели проверок канала: 1 \(с [^)]+\)\n/);
        const cli = await runCli(['status'], s.env);
        assert.match(cli.stdout, /переходник: .* · без хода модели проверок канала: 1 \(с /);
      } finally {
        a2.ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('другой процесс (другой instance_id) и переходник до 0.3.2 (без instance_id) — проба, как раньше; отданное — снова и после проверки', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const a1 = await adapter(s, { instanceId: ID_A, probe: true });
      const seq = await says(s, 'первое');
      await a1.ch.waitEvent(seq);
      await a1.ch.delivered(seq);
      a1.ch.close();
      await waitLine(s, 'lease_released', a1.lease);
      // Другой процесс — даже с чужой prev_lease — проба; отданное прежнему — снова new и отдано после проверки.
      const b = await adapter(s, { instanceId: ID_B, prevLease: a1.lease, probe: true });
      const gb = line(s, 'lease_granted', b.lease)!;
      assert.deepEqual([gb.probe_reason, gb.returned], ['lease_unknown', 1]);
      assert.equal((await b.ch.waitEvent(seq)).seq, seq);
      assert.equal((await waitLine(s, 'lease_verified', b.lease)).reason, 'probe');
      await b.ch.delivered(seq);
      b.ch.close();
      await waitLine(s, 'lease_released', b.lease);
      // Переходник до 0.3.2 — без instance_id: проба на каждую аренду; отданное процессу B — снова.
      const old = await adapter(s, { probe: true });
      try {
        assert.deepEqual([line(s, 'lease_granted', old.lease)!.probe_reason, line(s, 'lease_granted', old.lease)!.returned], ['no_instance', 1]);
        await old.ch.waitEvent(seq);
      } finally {
        old.ch.close();
      }
      await waitLine(s, 'lease_released', old.lease);
      // Тот же процесс A после чужих аренд: его аренда уже не последняя — проба.
      const a2 = await adapter(s, { instanceId: ID_A, prevLease: a1.lease, probe: true });
      a2.ch.close();
      assert.equal(line(s, 'lease_granted', a2.lease)!.probe_reason, 'lease_unknown');
      assert.equal(meta(s.home, META_KEYS.probesSaved), null, 'без хода модели — ни одной');
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('сессия сменилась между подключениями (строка состояния с другим session_id) — проба и повтор отданного', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      await statusline(s, 'sess-one');
      const a1 = await adapter(s, { instanceId: ID_A, probe: true });
      assert.equal((await waitLine(s, 'lease_verified', a1.lease)).session, 'sess-one'.slice(0, 8));
      const seq = await says(s, 'запомни');
      await a1.ch.waitEvent(seq);
      await a1.ch.delivered(seq);
      a1.ch.close();
      await waitLine(s, 'lease_released', a1.lease);
      // /clear или новый Claude Code в том же каталоге — другая сессия.
      await statusline(s, 'sess-two');
      const a2 = await adapter(s, { instanceId: ID_A, prevLease: a1.lease, probe: true });
      try {
        const g = line(s, 'lease_granted', a2.lease)!;
        assert.deepEqual([g.probe_reason, g.session_from, g.session_to, g.returned], ['session_changed', 'sess-one'.slice(0, 8), 'sess-two'.slice(0, 8), 1]);
        const again = await a2.ch.waitEvent(seq);
        assert.equal(again.seq, seq, 'отданное прежней сессии — новой снова');
      } finally {
        a2.ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('живой /clear: session_id сменился у проверенной аренды — отданное прежнему разговору снова с redelivery, без пробы; /resume к прежней — повтор только того, что ушло без неё', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      await statusline(s, 'sess-one');
      const a = await adapter(s, { instanceId: ID_A, probe: true });
      try {
        const seq = await says(s, 'посчитай');
        await a.ch.waitEvent(seq);
        await a.ch.delivered(seq);
        await gw.advance('2s');
        await statusline(s, 'sess-two');
        const changed = await waitUntil(() => readJournal(s.home).find((l) => l.ev === 'agent_session_changed' && l.lease === a.lease), 10_000, 'agent_session_changed');
        assert.deepEqual(changed.resent, [seq]);
        const frames = await waitUntil(() => {
          const f = a.ch.events().filter((e) => e.seq === seq);
          return f.length >= 2 ? f : null;
        }, 5000, 'повторной отдачи');
        assert.deepEqual(frames.map((f) => f.redelivery), [false, true]);
        assert.equal(a.ch.probes().length, 1, 'проба — только при подключении');
        // Вернулась уже виденная сессия: то, что она видела, не повторяется.
        await gw.advance('2s');
        await statusline(s, 'sess-one');
        const back = await waitUntil(
          () => readJournal(s.home).find((l) => l.ev === 'agent_session_changed' && l.lease === a.lease && l.seen_before === true),
          10_000,
          'agent_session_changed seen_before',
        );
        assert.deepEqual([back.to, back.resent], ['sess-one', []]);
        await settle(gw);
        assert.equal(a.ch.events().filter((e) => e.seq === seq).length, 2, 'третьей отдачи нет');
        // /resume к разговору sess-two (по проверке 0.3.2): отданное, пока его не было, — ему снова; виденное обоими — нет.
        const seq2 = await says(s, 'новое');
        await a.ch.waitEvent(seq2);
        await a.ch.delivered(seq2);
        await gw.advance('2s');
        await statusline(s, 'sess-two');
        const resumed = await waitUntil(
          () => readJournal(s.home).find((l) => l.ev === 'agent_session_changed' && l.lease === a.lease && l.seen_before === true && l.to === 'sess-two'),
          10_000,
          '/resume к sess-two',
        );
        assert.deepEqual(resumed.resent, [seq2]);
        const frames2 = await waitUntil(() => {
          const f = a.ch.events().filter((e) => e.seq === seq2);
          return f.length >= 2 ? f : null;
        }, 5000, 'повтора для /resume');
        assert.deepEqual(frames2.map((f) => f.redelivery), [false, true]);
        await settle(gw);
        assert.equal(a.ch.events().filter((e) => e.seq === seq).length, 2, 'виденное обеими сессиями — не повторяется');
        assert.equal(a.ch.probes().length, 1, 'и без пробы');
        assert.equal((await a.ch.reply(seq, 'посчитал', a.turn)).type, 'ack');
      } finally {
        a.ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('перезапуск шлюза — тот же процесс переходника переподключается без пробы; отданное остаётся за ним', async () => {
    const s = await setup();
    try {
      const g1 = await s.start();
      const a1 = await adapter(s, { instanceId: ID_A, probe: true });
      const seq = await says(s, 'перед перезапуском');
      await a1.ch.waitEvent(seq);
      await a1.ch.delivered(seq);
      await g1.stop();
      a1.ch.close();
      assert.equal(statusOf(s, seq)?.status, 'delivered');
      const g2 = await s.start();
      const start = await g2.waitForJournal((l) => l.ev === 'start' && Number(l.pid) === g2.pid);
      assert.deepEqual([start.returned_to_new, start.kept_for_session], [0, 1]);
      const a2 = await adapter(s, { instanceId: ID_A, prevLease: a1.lease, probe: false });
      try {
        assert.equal((await waitLine(s, 'lease_verified', a2.lease)).reason, 'same_instance');
        await settle(g2);
        assert.equal(a2.ch.probes().length, 0, 'после перезапуска шлюза — без пробы');
        assert.ok(!a2.ch.events().some((e) => e.seq === seq), 'и без повтора сразу');
        assert.deepEqual({ ...statusOf(s, seq) }, { status: 'delivered', lease_id: a2.lease });
        // Повтор К-5 — по сроку, как всегда: ответа нет 10 минут — событие снова, с redelivery.
        await g2.advance('11m');
        const again = await a2.ch.waitEvent(seq, 10_000);
        assert.equal(again.redelivery, true);
      } finally {
        a2.ch.close();
      }
      await g2.stop();
    } finally {
      await s.close();
    }
  });

  it('по проверке 0.3.2: перезапуск шлюза, а процесс переходника не вернулся — оставленное за ним ждёт (⚪ · 📥 1, строка «не на связи»); другой процесс получает его после пробы', async () => {
    const s = await setup();
    try {
      const g1 = await s.start();
      const a1 = await adapter(s, { instanceId: ID_A, probe: true });
      const seq = await says(s, 'перед перезапуском');
      await a1.ch.waitEvent(seq);
      await a1.ch.delivered(seq);
      await g1.stop();
      a1.ch.close();
      const g2 = await s.start();
      const start = await g2.waitForJournal((l) => l.ev === 'start' && Number(l.pid) === g2.pid);
      assert.equal(start.kept_for_session, 1);
      // Процесс A не вернулся: событие за ним, но агента нет — оно ждёт, как любое другое.
      await pump(g2, () => statusLineOf(s.fake)?.text.endsWith('\n⚪ · 📥 1') || null, { what: '«⚪ · 📥 1»' });
      await g2.advance('11m');
      await pump(g2, () => s.fake.sentTo(OWNER.id).find((m) => m.text === '⚙ Агент сейчас не на связи. Сохраняю сообщения: 1'), { what: 'строки «не на связи»' });
      assert.deepEqual({ ...statusOf(s, seq) }, { status: 'delivered', lease_id: a1.lease });
      // Пришёл другой процесс — проба; оставленное возвращено в new и отдано ему.
      const b = await adapter(s, { instanceId: ID_B, probe: true });
      try {
        const g = line(s, 'lease_granted', b.lease)!;
        assert.deepEqual([g.probe_reason, g.returned], ['new_instance', 1]);
        assert.equal((await b.ch.waitEvent(seq)).seq, seq);
      } finally {
        b.ch.close();
      }
      await g2.stop();
    } finally {
      await s.close();
    }
  });

  it('по проверке 0.3.2: агент ушёл командой cd в подпапку — сессия узнаётся по каталогу проекта: живой /clear замечен, /clear между подключениями — проба', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const sub = path.join(process.cwd(), 'agent-cd-subfolder');
      await statusline(s, 'sess-one', sub);
      const a1 = await adapter(s, { instanceId: ID_A, probe: true });
      assert.equal((await waitLine(s, 'lease_verified', a1.lease)).session, 'sess-one');
      const seq = await says(s, 'посчитай в подпапке');
      await a1.ch.waitEvent(seq);
      await a1.ch.delivered(seq);
      await gw.advance('2s');
      // Живой /clear — строка состояния из подпапки, каталог проекта тот же.
      await statusline(s, 'sess-two', sub);
      const changed = await waitUntil(() => readJournal(s.home).find((l) => l.ev === 'agent_session_changed' && l.lease === a1.lease), 10_000, 'agent_session_changed');
      assert.deepEqual([changed.from, changed.to, changed.resent], ['sess-one', 'sess-two', [seq]]);
      a1.ch.close();
      await waitLine(s, 'lease_released', a1.lease);
      // /clear между подключениями — новая сессия: проба, а не «та же сессия».
      await statusline(s, 'sess-three', sub);
      const a2 = await adapter(s, { instanceId: ID_A, prevLease: a1.lease, probe: true });
      try {
        const g = line(s, 'lease_granted', a2.lease)!;
        assert.deepEqual([g.probe_reason, g.session_from, g.session_to], ['session_changed', 'sess-two', 'sess-thr']);
        assert.equal((await a2.ch.waitEvent(seq)).seq, seq, 'отданное прежней сессии — новой снова');
      } finally {
        a2.ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });

  it('полуоткрытая аренда: тот же процесс переподключился, а шлюз ещё держит прежнее соединение — прежнее закрыто (replaced), busy нет, без пробы', async () => {
    const s = await setup();
    try {
      const gw = await s.start();
      const a1 = await adapter(s, { instanceId: ID_A, probe: true });
      const a2 = await adapter(s, { instanceId: ID_A, prevLease: a1.lease, probe: false });
      try {
        assert.equal((await waitLine(s, 'lease_released', a1.lease)).reason, 'replaced');
        assert.equal((await waitLine(s, 'lease_verified', a2.lease)).reason, 'same_instance');
        await waitUntil(() => a1.ch.isClosed || null, 5000, 'закрытия прежнего соединения');
        // Чужой процесс при живой проверенной аренде — по-прежнему busy.
        const other = await FakeChannel.connect(s.home.paths.socket);
        const w = await other.hello({ instanceId: ID_B, prevLease: a2.lease });
        other.close();
        assert.ok(w.type === 'error' && w.code === 'busy', JSON.stringify(w));
      } finally {
        a1.ch.close();
        a2.ch.close();
      }
      await gw.stop();
    } finally {
      await s.close();
    }
  });
});
