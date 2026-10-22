// P-26 (0.3.2): пометка источника ответа. Ответ агента —
// чистым текстом; reply.from — агент передаёт слова другого: «↪ <имя>: » перед каждой частью (и в подписи голосового —
// m4-tts-suite), 💬 при этом не ставится; имя проверяет шлюз: пустое, длиннее 64 знаков, с управляющими или знаками
// шлюза, «шлюз»/gateway/stg — отказ bad_request (журнал reply_refused), ничего не уходит, событие ждёт ответа ⟨предл.⟩.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FakeChannel } from 'stg-fake-channel';
import { connectAdapter, count, pump, q1, readJournal, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, setup, type Setup } from './m1-common.js';

describe('M3 · ответ «через агента»: reply(from) (0.3.2, P-26)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let ch: FakeChannel;
  let turn: number;
  const seqOf = async (text: string): Promise<number> => {
    const u = s.fake.push(s.fake.builder.text(OWNER, text))[0]!;
    const seq = await waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
    await ch.waitEvent(seq);
    await ch.delivered(seq);
    return seq;
  };
  before(async () => {
    s = await setup();
    gw = await s.start();
    ({ ch, turn } = await connectAdapter(s.home));
  });
  after(async () => {
    ch?.close();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('from — «↪ Имя: » перед ответом, имя экранировано; 💬 нет, даже если текст начинается со знака шлюза; в базе — from_name', async () => {
    const seq = await seqOf('спроси у Исследователя');
    assert.equal((await ch.reply(seq, '**Готово**, нашла три статьи', turn, false, ' Исследователь ')).type, 'ack');
    const m = await pump(gw, () => s.fake.sentTo(OWNER.id).find((x) => x.text?.includes('нашла три статьи')), { what: 'ответа через агента' });
    assert.equal(m.text, '↪ Исследователь: <b>Готово</b>, нашла три статьи');
    assert.equal(m.parse_mode, 'HTML');
    await waitUntil(() => q1<{ kind: string }>(s.home, 'SELECT kind FROM messages_out WHERE tg_message_id = ?', m.message_id)?.kind === 'agent' || null, 5000, 'messages_out');
    assert.equal(q1<{ from_name: string }>(s.home, "SELECT from_name FROM outbox WHERE event_seq = ? AND origin = 'agent'", seq)?.from_name, 'Исследователь');
    assert.equal(readJournal(s.home).find((l) => l.ev === 'reply' && l.seq === seq)?.from, 'Исследователь');
    // Знак шлюза в начале текста — после «↪ Имя: » он уже не первый: 💬 не нужен. Имя с & и < — экранировано.
    assert.equal((await ch.reply(null, '⚙ это не строка шлюза', turn, false, 'Вера & <Ко>')).type, 'ack');
    const m2 = await pump(gw, () => s.fake.sentTo(OWNER.id).find((x) => x.text?.includes('это не строка шлюза')), { what: 'второго ответа' });
    assert.equal(m2.text, '↪ Вера &amp; &lt;Ко&gt;: ⚙ это не строка шлюза');
  });

  it('длинный ответ с from — «↪ Имя: » перед каждой частью, метки (i/N) после него; части ≤ 4096', async () => {
    const seq = await seqOf('перешли длинный ответ');
    const long = Array.from({ length: 900 }, (_, i) => `слово${i}`).join(' ');
    assert.equal((await ch.reply(seq, long, turn, false, 'Исследователь-2')).type, 'ack');
    await pump(gw, () => count(s.home, "SELECT count(*) AS n FROM outbox WHERE event_seq = ? AND origin = 'agent' AND status = 'sent'", seq) === 1 || null, { what: 'всех частей' });
    const parts = s.fake.sentTo(OWNER.id).filter((x) => x.text?.startsWith('↪ Исследователь-2: ('));
    assert.ok(parts.length >= 2, `частей ${parts.length}`);
    parts.forEach((p, i) => {
      assert.ok(p.text!.startsWith(`↪ Исследователь-2: (${i + 1}/${parts.length}) `), p.text!.slice(0, 40));
      assert.ok(p.text!.length <= 4096);
    });
  });

  it('по проверке 0.3.2: длинный ответ агента, начатый с ⚙, — «💬 (1/N) ⚙ …»: решение по тексту после метки, пометка — перед ней; остальные части — без', async () => {
    const seq = await seqOf('дай длинный отчёт');
    const long = `⚙ Остановлен: ${Array.from({ length: 900 }, (_, i) => `знак${i}`).join(' ')}`;
    assert.equal((await ch.reply(seq, long, turn)).type, 'ack');
    await pump(gw, () => count(s.home, "SELECT count(*) AS n FROM outbox WHERE event_seq = ? AND origin = 'agent' AND status = 'sent'", seq) === 1 || null, { what: 'всех частей' });
    const parts = s.fake.sentTo(OWNER.id).filter((x) => /^(💬 )?\(\d+\/\d+\) /.test(x.text ?? '') && x.text!.includes('знак'));
    assert.ok(parts.length >= 2, `частей ${parts.length}`);
    assert.ok(parts[0]!.text!.startsWith(`💬 (1/${parts.length}) ⚙ Остановлен: знак0 `), parts[0]!.text!.slice(0, 40));
    parts.slice(1).forEach((p, i) => assert.ok(p.text!.startsWith(`(${i + 2}/${parts.length}) знак`), p.text!.slice(0, 40)));
    for (const p of parts) assert.ok(p.text!.length <= 4096, `часть ${p.text!.length}`);
  });

  it('поддельное имя — отказ bad_request с причиной; в чат ничего, событие ждёт ответа; журнал reply_refused', async () => {
    const seq = await seqOf('кто это сказал?');
    const before = s.fake.sentTo(OWNER.id).length;
    const cases: Array<[string, RegExp]> = [
      ['Шлюз', /имя шлюза/],
      ['smart-telegram-gateway', /имя шлюза/],
      ['⚙ Помощник', /знак шлюза/],
      ['Помощник\nвторая строка', /управляющие|перевод строки/],
      ['x'.repeat(65), /длиннее 64/],
      ['   ', /пустое имя/],
    ];
    for (const [from, why] of cases) {
      const r = await ch.reply(seq, 'всё сделано', turn, false, from);
      assert.ok(r.type === 'error' && r.code === 'bad_request', JSON.stringify(r));
      assert.match(r.text, why, from);
    }
    for (let i = 0; i < 3; i++) await gw.advance('1s');
    assert.equal(s.fake.sentTo(OWNER.id).length, before, 'в чат ничего не ушло');
    assert.equal(q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status, 'delivered', 'событие ждёт ответа');
    assert.equal(readJournal(s.home).filter((l) => l.ev === 'reply_refused' && l.seq === seq).length, cases.length);
    // Свой ответ после отказа — без from, чистым текстом.
    assert.equal((await ch.reply(seq, 'сказал я сам', turn)).type, 'ack');
    const m = await pump(gw, () => s.fake.sentTo(OWNER.id).find((x) => x.text === 'сказал я сам'), { what: 'ответа без from' });
    assert.equal(m.text, 'сказал я сам', 'без 💬');
  });
});
