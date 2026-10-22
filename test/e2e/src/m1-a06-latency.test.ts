// A1.6 (Ш-5) — 100 сообщений по одному в секунду; подделка отвечает за 50 мс; настоящее время; агент на связи (отвечает
// delivered и done, как сессия): «записал» — запись (COMMIT) ≤ 2 с (p90) от выдачи обновления (L-2; с 0.3.2 ✍ нет,
// мерка по COMMIT ⟨предл.⟩); 👀 «агент увидел» — ≤ 1 с (p90) от отдачи агенту (delivered; 👌
// вместо 👀, если агент успел отметить done раньше) ⟨предл.⟩. Реакции на каждом — по порядку 👀 → 👌 (могут слиться),
// последней — 👌; ✍ нет ни на одном. Подделка ещё и держит предел
// «1 сообщение в секунду в чат» — 429 не было (закреплённая строка правится не чаще раза в 3 с).
// A1.12 (Ш-16) — после A1.6: в журнале каждое входящее и исходящее с меткой (реакции — тоже); в latency у каждого события
// t_update ≤ t_admit ≤ t_receipt и t_admit ≤ t_delivered ≤ t_eyes.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertNoLoss, assertNoToken, count, q, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, chatMessages, seeingAgent, setup, type SeeingAgent, type Setup } from './m1-common.js';

const N = Number(process.env.STG_A16_COUNT ?? '100');

function p90(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1]!;
}

describe(`A1.6 · задержки на настоящем времени (${N} сообщений, 1 в секунду)`, () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ag: SeeingAgent | null = null;
  const ids: number[] = [];

  before(async () => {
    s = await setup({ fake: { now: Date.now, latencyMs: 50, chatRateLimit: { perSecond: 1, retryAfter: 1 } }, env: { STG_CLOCK: 'real' } });
    gw = await s.start();
    ag = await seeingAgent(s, { done: true });
  });
  after(async () => {
    ag?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('«записал» (COMMIT) ≤ 2 с от выдачи обновления, 👀 ≤ 1 с от отдачи агенту (p90); порядок 👀 → 👌, ✍ нет; 429 не было', async (t) => {
    for (let i = 1; i <= N; i++) {
      ids.push(s.fake.push(s.fake.builder.text(OWNER, `мысль номер ${i}`))[0]!.update_id);
      await sleep(1000);
    }
    await waitUntil(() => count(s.home, "SELECT count(*) AS n FROM reactions WHERE shown = '👌' AND status = 'done'") >= N, 15_000, 'реакций 👌');
    const evs = q<{ seq: number; update_id: number; message_id: number }>(s.home, "SELECT seq, update_id, message_id FROM events WHERE kind = 'text' ORDER BY seq");
    assert.equal(evs.length, N);
    const j = readJournal(s.home);
    const committedAt = new Map(j.filter((l) => l.ev === 'in').map((l) => [l.seq as number, Date.parse(String(l.at))]));
    const deliveredAt = new Map<number, number>();
    for (const l of j) if (l.ev === 'delivered' && !deliveredAt.has(l.seq as number)) deliveredAt.set(l.seq as number, Date.parse(String(l.at)));
    const commitMs: number[] = [];
    const eyes: number[] = [];
    const ORDER = ['👀', '👌'];
    const emoji = (r: { reaction: unknown }): string => (r.reaction as Array<{ emoji: string }>)[0]?.emoji ?? '';
    for (const e of evs) {
      const out = s.fake.handedOut.get(e.update_id)!;
      // COMMIT — запись `in` в журнале идёт сразу после него.
      commitMs.push(committedAt.get(e.seq)! - out);
      const mine = s.fake.reactions.filter((x) => x.message_id === e.message_id);
      const seen = mine.map(emoji);
      assert.ok(mine.length >= 1 && mine.length <= 2, `№ ${e.seq}: реакций ${mine.length}`);
      assert.ok(seen.every((x, i) => ORDER.includes(x) && (i === 0 || ORDER.indexOf(x) > ORDER.indexOf(seen[i - 1]!))), `№ ${e.seq}: порядок ${seen.join(' ')}`);
      assert.equal(seen.at(-1), '👌', `№ ${e.seq}: последней — 👌`);
      // 👀 — первая вставшая реакция (слилась — 👌).
      eyes.push(mine[0]!.at - deliveredAt.get(e.seq)!);
    }
    t.diagnostic(`«записал» (COMMIT) p90 ${p90(commitMs)} мс, max ${Math.max(...commitMs)} мс; 👀 после отдачи p90 ${p90(eyes)} мс, max ${Math.max(...eyes)} мс`);
    assert.ok(p90(commitMs) <= 2000, `«записал» p90 ${p90(commitMs)} мс`);
    assert.equal(s.fake.reactions.filter((r) => emoji(r) === '✍').length, 0, '✍ нет');
    assert.ok(p90(eyes) <= 1000, `👀 p90 ${p90(eyes)} мс`);
    assert.equal(s.fake.calls.filter((c) => c.status === 429).length, 0, '429 не было');
    assert.ok(!chatMessages(s.fake).some((m) => /^№ \d/.test(m.text ?? '')), 'текстовых квитанций нет');
  });

  it('A1.12: журнал — каждое входящее и исходящее с меткой; latency — t_update ≤ t_admit ≤ t_delivered ≤ t_eyes у каждого', async () => {
    const j = readJournal(s.home);
    const ins = j.filter((l) => l.ev === 'in');
    assert.equal(ins.length, N);
    for (const l of ins) {
      assert.equal(l.label, 'owner');
      assert.match(String(l.text), /^мысль номер \d+$/);
    }
    // Исходящее шлюза — с меткой: реакции у каждого №, строка состояния, удаления.
    const reactions = j.filter((l) => l.ev === 'reaction');
    const covered = new Set(reactions.map((l) => l.seq as number));
    const seqs = q<{ seq: number }>(s.home, "SELECT seq FROM events WHERE kind = 'text'").map((r) => r.seq);
    for (const sq of seqs) assert.ok(covered.has(sq), `№ ${sq}: реакции в журнале нет`);
    for (const l of [...reactions, ...j.filter((x) => x.ev === 'out' || x.ev === 'status_line' || x.ev === 'deleted')]) {
      assert.equal(l.label, 'gateway', `${l.ev}: метка`);
    }
    const lat = q<{ event_seq: number; t_update: number | null; t_admit: number | null; t_receipt: number | null; t_delivered: number | null; t_eyes: number | null }>(
      s.home,
      "SELECT l.* FROM latency l JOIN events e ON e.seq = l.event_seq WHERE e.kind = 'text'",
    );
    assert.equal(lat.length, N);
    for (const l of lat) {
      assert.ok(l.t_update && l.t_admit && l.t_receipt && l.t_delivered && l.t_eyes, `№ ${l.event_seq}: ${JSON.stringify(l)}`);
      assert.ok(l.t_update <= l.t_admit && l.t_admit <= l.t_receipt && l.t_admit <= l.t_delivered && l.t_delivered <= l.t_eyes, `№ ${l.event_seq}: порядок времён`);
    }
    ag?.close();
    ag = null;
    await gw.stop();
    assertNoLoss(s.fake, s.home);
    assertNoToken(s.home);
  });
});
