// A1.6а (Ш-5, Ш-9) — 20 пересланных одной выдачей; подделка отвечает 429, если в чат больше 1 сообщения в секунду
// (закрепление строки состояния и удаление «бот закрепил» — в том же счёте): 429 не было; агент на
// связи — на каждом 👀 «агент увидел» (0.3.2: ✍ нет); текстовых квитанций и нижней клавиатуры
// нет; все 20 в events. Короткий прогон на настоящем времени
// (ACCEPTANCE §1).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertNoLoss, count, waitUntil, type GatewayProcess } from './harness.js';
import { OTHER, OWNER, chatMessages, hasReplyKeyboard, reactionsOf, seeingAgent, setup, type SeeingAgent, type Setup } from './m1-common.js';

describe('A1.6а · 20 пересланных одной выдачей, предел 1 сообщение/с в чат', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ag: SeeingAgent | null = null;

  before(async () => {
    s = await setup({ fake: { now: Date.now, chatRateLimit: { perSecond: 1, retryAfter: 3 }, rateLimitServiceCalls: true }, env: { STG_CLOCK: 'real' } });
    gw = await s.start();
    ag = await seeingAgent(s);
  });
  after(async () => {
    ag?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('429 не было; 👀 на каждом (✍ нет), текстовых квитанций и клавиатуры нет; все 20 в events', async () => {
    const ups = Array.from({ length: 20 }, (_, i) => s.fake.builder.forward(OWNER, { type: 'user', user: OTHER }, `чужое ${i + 1}`));
    s.fake.push(...ups);
    await waitUntil(() => count(s.home, "SELECT count(*) AS n FROM events WHERE kind = 'text'") === 20, 10_000, 'приёма 20');
    await waitUntil(() => ups.every((u) => reactionsOf(s.fake, u).at(-1) === '👀') || null, 10_000, '👀 на каждом');
    await waitUntil(() => count(s.home, "SELECT count(*) AS n FROM outbox WHERE status <> 'sent'") === 0, 10_000, 'отправки');
    // Строка состояния закреплена, «бот закрепил» удалено — тоже без 429 (шаг 1 с общий).
    await waitUntil(() => (s.fake.pinNotices[0] && s.fake.wasDeleted(OWNER.id, s.fake.pinNotices[0].message_id)) || null, 15_000, 'удаления «бот закрепил»');
    assert.equal(s.fake.calls.filter((c) => c.status === 429).length, 0, '429 не было');
    // На каждом — одна 👀, ✍ нет (0.3.2).
    for (const u of ups) assert.deepEqual(reactionsOf(s.fake, u), ['👀'], `${u.update_id}: ${reactionsOf(s.fake, u).join(' ')}`);
    assert.ok(!s.fake.sentTo(OWNER.id).some(hasReplyKeyboard), 'нижней клавиатуры нет (0.3.1)');
    assert.ok(!chatMessages(s.fake).some((m) => /^№ \d/.test(m.text ?? '')), 'текстовая квитанция');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM events WHERE trust = 'untrusted'"), 20);
    ag?.close();
    ag = null;
    await gw.stop();
    assertNoLoss(s.fake, s.home);
  });
});
