// Отправка (Ш-9): A1.7 — ответ в 9 000 единиц UTF-16 уходит частями ≤ 4096 с меткой (1/N), ни графема, ни тег не
// разорваны, на 400 «can't parse entities» — та же часть без разметки; A1.8 — 429 с retry_after: 7 (поддельные
// часы): следующая попытка — после 7 с, не раньше; три 429 подряд — повтор по next_try_at. 429 проверяется на строках
// шлюза через очередь отправки: ответы /status и /help (запасной текстовой квитанции и строки с нижней клавиатурой, на
// которых это проверялось раньше, больше нет с 0.3.1).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { graphemes, htmlToPlain, markdownToTelegramHtml } from 'stg-core';
import { checkTelegramHtml, errors } from 'stg-fake-telegram';
import { assertNoLoss, connectAdapter, count, pump, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, setup, type Setup } from './m1-common.js';

function longReply(): string {
  const family = '👨‍👩‍👧‍👦';
  const flag = '🇺🇦';
  let md = '';
  while (md.length < 3500) md += `Кириллица и эмодзи ${family}${flag} — `;
  md += '\n```py\n' + 'print("<тег> & ещё")\n'.repeat(110) + '```\n';
  while (md.length < 9000) md += `**жирное ${family}** и _курсив_ ${flag} `;
  return md;
}

describe('A1.7 · длинный ответ агента: нарезка и запасной путь без разметки', () => {
  let s: Setup;
  let gw: GatewayProcess;
  before(async () => {
    s = await setup();
    gw = await s.start();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('части ≤ 4096 с меткой (1/N)…(N/N); HTML каждой части цел; 400 на второй части — она же без разметки', async () => {
    s.fake.scenario({
      method: 'sendMessage',
      times: 1,
      when: (p) => p.parse_mode === 'HTML' && String(p.text).startsWith('(2/'),
      reply: errors.parseEntities('Unsupported start tag "x" at byte offset 12'),
    });
    const [u] = s.fake.push(s.fake.builder.text(OWNER, 'расскажи подробно'));
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', u!.update_id) === 1, 5000, 'приёма');
    const { ch, turn } = await connectAdapter(s.home);
    const md = longReply();
    assert.ok(md.length >= 9000);
    try {
      const ev = await ch.waitEvent(1);
      await ch.delivered(ev.seq);
      const r = await ch.reply(ev.seq, md, turn);
      assert.ok(r.type === 'ack' && r.result === 'queued');
      await pump(gw, () => count(s.home, "SELECT count(*) AS n FROM outbox WHERE kind = 'agent' AND status = 'sent'") === 1, { what: 'всех частей' });
    } finally {
      ch.close();
    }
    // Ответ агента — чистым текстом (0.3.2, P-26): части начинаются с метки (i/N), без 💬.
    const parts = s.fake.sentTo(OWNER.id).filter((m) => /^\(\d+\/\d+\) /.test(m.text ?? ''));
    const n = parts.length;
    assert.ok(n >= 3, `частей ${n}`);
    parts.forEach((p, i) => {
      assert.ok(p.text!.startsWith(`(${i + 1}/${n}) `), p.text!.slice(0, 16));
      assert.ok(p.text!.length <= 4096, `часть ${i + 1}: ${p.text!.length}`);
      if (i === 1) {
        assert.equal(p.parse_mode, null, 'вторая часть — без разметки после 400');
        assert.ok(!/<\/?(b|i|pre|code)>/.test(p.text!), 'в простом тексте нет тегов');
      } else {
        assert.equal(p.parse_mode, 'HTML');
        assert.equal(checkTelegramHtml(p.text!).error, null, `часть ${i + 1}: ${checkTelegramHtml(p.text!).error}`);
      }
      assert.ok(!/[\uD800-\uDBFF]$/.test(p.text!), `часть ${i + 1} кончается обрывком графемы`);
    });
    // Графемы (Intl.Segmenter): в каждой части — только целые графемы исходника (разорванный флаг или ZWJ-семья дали бы
    // обрывок, которого в исходнике нет); склейка частей — ровно видимый текст исходника.
    const sourcePlain = htmlToPlain(markdownToTelegramHtml(md));
    const sourceSet = new Set(graphemes(sourcePlain));
    const bodies = parts.map((p, i) => {
      const visible = i === 1 ? p.text! : htmlToPlain(p.text!);
      return visible.slice(`(${i + 1}/${n}) `.length);
    });
    bodies.forEach((b, i) => {
      for (const g of graphemes(b)) assert.ok(sourceSet.has(g), `часть ${i + 1}: обрывок графемы «${g}»`);
    });
    assert.equal(bodies.join(''), sourcePlain, 'склейка частей = исходный текст');
    // Вторую часть сначала пробовали с разметкой — Telegram ответил 400.
    const tries = s.fake.callsOf('sendMessage').filter((c) => String(c.params.text).includes(`(2/${n})`));
    assert.equal(tries.length, 2);
    assert.equal(tries[0]!.status, 400);
    assert.equal(String(tries[1]!.params.text), htmlToPlain(String(tries[0]!.params.text)));
    // Ответ на последнее сообщение владельца — обычным сообщением (5.5а); реплаем — только первая часть, и не здесь.
    assert.ok(parts.every((p) => p.reply_parameters === null));
    assert.ok(readJournal(s.home).some((l) => l.ev === 'send_plain'));
    assertNoLoss(s.fake, s.home);
  });

  it('сплошные флаги без пробелов (разрез внутри эмодзи-ряда) — части ≤ 4096, ни один флаг не разорван', async () => {
    const [u] = s.fake.push(s.fake.builder.text(OWNER, 'флаги'));
    await waitUntil(() => count(s.home, 'SELECT count(*) AS n FROM events WHERE update_id = ?', u!.update_id) === 1, 5000, 'приёма');
    const before = s.fake.sentTo(OWNER.id).length;
    const { ch, turn } = await connectAdapter(s.home);
    try {
      const seq = count(s.home, 'SELECT seq AS n FROM events WHERE update_id = ?', u!.update_id);
      await ch.waitEvent(seq);
      await ch.delivered(seq);
      const r = await ch.reply(seq, '🇺🇦'.repeat(2300), turn);
      assert.ok(r.type === 'ack' && r.result === 'queued');
      await pump(gw, () => count(s.home, "SELECT count(*) AS n FROM outbox WHERE kind = 'agent' AND status = 'sent'") === 2, { what: 'частей' });
    } finally {
      ch.close();
    }
    const parts = s.fake.sentTo(OWNER.id).slice(before).filter((m) => /^\(\d+\/\d+\) /.test(m.text ?? ''));
    assert.ok(parts.length >= 3, `частей ${parts.length}`);
    let flags = 0;
    parts.forEach((p, i) => {
      assert.ok(p.text!.length <= 4096);
      const body = htmlToPlain(p.text!).slice(`(${i + 1}/${parts.length}) `.length);
      for (const g of graphemes(body)) {
        assert.equal(g, '🇺🇦', `часть ${i + 1}: обрывок «${g}»`);
        flags++;
      }
    });
    assert.equal(flags, 2300);
  });
});

describe('A1.8 · 429 с retry_after (поддельные часы)', () => {
  let s: Setup;
  let gw: GatewayProcess;
  before(async () => {
    s = await setup();
    gw = await s.start();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  const HELP = '⚙ Как устроен чат';
  const isNote = (p: Record<string, unknown>): boolean => String(p.text).startsWith('⚙ Статус');
  const isHelp = (p: Record<string, unknown>): boolean => String(p.text).startsWith(HELP);
  const noteCalls = () => s.fake.callsOf('sendMessage').filter((c) => isNote(c.params));

  it('retry_after: 7 — следующая попытка через 7 с, не раньше', async () => {
    s.fake.scenario({ method: 'sendMessage', when: isNote, times: 1, reply: errors.tooManyRequests(7) });
    s.fake.push(s.fake.builder.command(OWNER, '/status'));
    // Перед ответом /status в чат уходит закреплённая строка (шаг 1 с в чат) — часы двигаются мелко, отсчёт — от 429.
    const retry = await pump(gw, () => readJournal(s.home).find((l) => l.ev === 'send_retry' && l.retry_after_ms === 7000), { step: '100ms', what: 'паузы после 429' });
    assert.equal(noteCalls().length, 1);
    const now = await gw.advance('1ms');
    await gw.advance(`${Date.parse(retry.at) + 6_700 - now}ms`);
    await sleep(300);
    assert.equal(noteCalls().length, 1, 'раньше 7 с — ни одной попытки');
    await gw.advance('300ms');
    await waitUntil(() => noteCalls()[1], 5000, 'второй попытки');
    assert.equal(noteCalls()[1]!.status, 200);
  });

  it('три 429 подряд — запись next_try_at и повтор по таймеру; строка уходит одна', async () => {
    s.fake.scenario({ method: 'sendMessage', when: isHelp, times: 3, reply: errors.tooManyRequests(5) });
    s.fake.push(s.fake.builder.command(OWNER, '/help'));
    await pump(gw, () => readJournal(s.home).find((l) => l.ev === 'send_deferred'), { step: '1s', what: 'отложенной отправки' });
    const def = readJournal(s.home).find((l) => l.ev === 'send_deferred')!;
    assert.ok(typeof def.next_try_at === 'number');
    await pump(gw, () => s.fake.sentTo(OWNER.id).find((m) => m.text?.startsWith(HELP)), { step: '1s', what: 'ответа /help после 429' });
    const retries = readJournal(s.home).filter((l) => l.ev === 'send_retry' && l.retry_after_ms === 5000);
    assert.equal(retries.length, 2, 'две паузы по retry_after, третья 429 — next_try_at');
    const out = await gw.waitForJournal((l) => l.ev === 'out' && String(l.text).startsWith(HELP));
    const outAt = Date.parse(out.at);
    assert.ok(outAt - Date.parse(retries[0]!.at) >= 15_000, 'три паузы по 5 с поддельного времени');
    assert.equal(s.fake.sentTo(OWNER.id).filter((m) => m.text?.startsWith(HELP)).length, 1);
    await gw.stop();
    assertNoLoss(s.fake, s.home);
  });
});
