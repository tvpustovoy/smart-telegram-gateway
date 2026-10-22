// M2 · «не на связи», «где мы», «статус», меню (Ш-6, Ш-14, Оч-6; TECH-SPEC 5.6, 5.7, 5.13):
// меню setMyCommands · A2.10 «не на связи» — одна строка, после подключения и нового простоя — снова одна · A2.11 «где
// мы» владельцу, переходнику (where) и stg where (через шлюз и по базе без шлюза), с отложенным и закрытым без ответа ·
// A2.14 «статус» и /status · «итог #N не получен» через сутки после отдачи episode_closed. Интерфейс (J-4): ответ
// «где мы» — без клавиатуры, удаляется через 5 минут (ui.where_ttl_minutes) или при следующем «где мы»; сообщение
// владельца с командой удаляется.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { COMMAND_WORDS, MENU_COMMANDS, offlineNotice, type Update } from 'stg-core';
import type { SentMessage } from 'stg-fake-telegram';
import { connectAdapter, count, pump, q1, runCli, shiftClockFile, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, botTexts, setup, type Setup } from './m1-common.js';
import { waitSent } from './m2-common.js';

describe('M2 · «не на связи», «где мы», «статус», меню', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let seq1 = 0;
  let seq2 = 0;
  const seqOf = (u: Update): number | undefined => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq;
  const admitted = (u: Update): Promise<number> => waitUntil(() => seqOf(u), 5000, `приёма ${u.update_id}`);
  const offlineLines = (): string[] => botTexts(s.fake).filter((t) => t.startsWith('⚙ Агент сейчас не на связи'));
  /** Ответ на «где мы» / «статус»: следующая строка с этим началом после уже полученных. */
  const nextMessage = async (prefix: string): Promise<SentMessage> => {
    const seen = botTexts(s.fake).filter((t) => t.startsWith(prefix)).length;
    return pump(gw, () => s.fake.sentTo(OWNER.id).filter((x) => x.text?.startsWith(prefix))[seen], { what: `строки «${prefix}»` });
  };
  const nextLine = async (prefix: string): Promise<string> => (await nextMessage(prefix)).text!;
  const deleted = (m: { message_id: number }): boolean => s.fake.wasDeleted(OWNER.id, m.message_id);

  before(async () => {
    s = await setup();
    gw = await s.start();
  });
  after(async () => {
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('меню команд: setMyCommands с русскими подписями и эмодзи — в личке владельца', async () => {
    await waitUntil(() => s.fake.commands.length > 0 || null, 5000, 'setMyCommands');
    const c = s.fake.commands[0] as { commands: Array<{ command: string; description: string }>; scope: unknown };
    assert.deepEqual(
      c.commands,
      MENU_COMMANDS.map((k) => ({ command: COMMAND_WORDS[k].slash.slice(1), description: COMMAND_WORDS[k].menu })),
    );
    assert.deepEqual(
      c.commands.map((x) => `/${x.command} ${x.description}`),
      ['/where 📍 Где мы', '/new 🆕 Новая тема', '/pause ⏸ Пауза', '/stop ⛔ Стоп', '/status 📊 Статус', '/help ❓ Помощь'],
    );
    assert.deepEqual(c.scope, { type: 'chat', chat_id: OWNER.id });
  });

  it('A2.10: переходника нет, событие ждёт 11 минут; затем подключение и новый простой — ровно одна строка «не на связи»; после — снова одна', async () => {
    const m1 = s.fake.builder.text(OWNER, 'агент закрыт');
    s.fake.push(m1);
    seq1 = await admitted(m1);
    // Срок и снизу: до 10 минут строки нет — ни в Telegram, ни в очереди отправки.
    for (let i = 0; i < 9; i++) await gw.advance('1m');
    await sleep(150);
    assert.equal(offlineLines().length, 0, 'строка раньше 10 минут');
    assert.equal(count(s.home, "SELECT count(*) AS n FROM outbox WHERE text LIKE '⚙ Агент сейчас не на связи%'"), 0);
    await pump(gw, () => offlineLines().length === 1 || null, { step: '1m', what: 'строки «не на связи»' });
    assert.equal(offlineLines()[0], offlineNotice(1));
    for (let i = 0; i < 15; i++) await gw.advance('1m');
    assert.equal(offlineLines().length, 1, 'без повторов');
    // Агент побывал на связи: получил и закрыл материал без ответа.
    const { ch } = await connectAdapter(s.home);
    await ch.waitEvent(seq1);
    await ch.done([seq1]);
    ch.close();
    await gw.waitForJournal((l) => l.ev === 'lease_released');
    const m2 = s.fake.builder.text(OWNER, 'снова агент закрыт');
    s.fake.push(m2);
    seq2 = await admitted(m2);
    await pump(gw, () => offlineLines().length === 2 || null, { step: '1m', what: 'второй строки «не на связи»' });
    for (let i = 0; i < 15; i++) await gw.advance('1m');
    assert.deepEqual(offlineLines(), [offlineNotice(1), offlineNotice(1)]);
  });

  it('A2.11: «где мы» — тема, роль, длительность, ждущие ответа, на связи ли агент, отложенное; переходнику (where) и stg where — то же', async () => {
    // Отложенное: три старта за 60 с на обновлении, на котором шлюз падает (как A1.11).
    await gw.stop();
    const bad = s.fake.push(s.fake.builder.text(OWNER, 'на этом шлюз падает'))[0]!.update_id;
    for (let run = 1; ; run++) {
      const g = s.spawn({ STG_FAULT: `in_handler:${bad}` });
      const r = await Promise.race([
        g.exited.then(() => 'exit' as const),
        waitUntil(() => q1(s.home, "SELECT 1 FROM updates WHERE update_id = ? AND status = 'deferred'", bad), 20_000, 'отложенного').then(() => 'deferred' as const),
      ]);
      if (r === 'deferred') {
        await g.stop();
        break;
      }
      if (run >= 5) throw new Error('не отложил за 5 запусков');
      shiftClockFile(s.home, 1000);
    }
    gw = await s.start();
    // Текст кнопки прежней нижней клавиатуры «📍 Где мы» (до 0.3.1) — та же команда.
    const cmd = s.fake.builder.text(OWNER, '📍 Где мы');
    s.fake.push(cmd);
    const answer = await nextMessage('⚙ Где мы');
    const text = answer.text!;
    assert.equal(answer.reply_markup, null, 'ответ «где мы» — без разметки');
    await pump(gw, () => deleted(cmd.message!) || null, { what: 'удаления команды «где мы»' });
    const lines = text.split('\n');
    assert.match(lines[1]!, /^#\d+ · тема не названа — идёт (\d+ мин|меньше минуты|\d+ ч \d\d мин) \(с \d\d:\d\d\)$/, lines[1]);
    assert.equal(lines[2], `Ждут ответа агента: 1 (№ ${seq2})`);
    assert.equal(lines[3], 'Агент: не на связи');
    assert.equal(lines[4], 'Режим: работает');
    assert.match(lines[5]!, /^Отложено: 1 \(сообщения от \d\d:\d\d; stg deferred list\)$/);
    assert.equal(lines[6], `Закрыто без ответа за сутки: 1 (№ ${seq1})`);
    // Ответ «где мы» исчезает через 5 минут (ui.where_ttl_minutes), не раньше.
    await gw.advance('4m');
    await sleep(200);
    assert.equal(deleted(answer), false, 'удалён раньше 5 минут');
    await pump(gw, () => deleted(answer) || null, { step: '20s', what: 'удаления ответа «где мы» через 5 минут' });
    // Переходнику — то же словами и полями; агент теперь на связи.
    const { ch } = await connectAdapter(s.home);
    try {
      const w = await ch.where();
      assert.ok(w.type === 'where_result', JSON.stringify(w));
      assert.match(w.text, /\nАгент: на связи\n/);
      assert.deepEqual(w.data?.waiting, [seq2]);
      assert.equal(w.data?.deferred.length, 1);
      assert.deepEqual(w.data?.closed_silent, [seq1]);
      assert.equal(w.data?.agent_online, true);
      // stg where — через сокет шлюза (role cli: аренду не берёт).
      const cli = await runCli(['where'], s.env);
      assert.equal(cli.code, 0, cli.stderr);
      assert.match(cli.stdout, /^⚙ Где мы\n/);
      assert.match(cli.stdout, /\nАгент: на связи\n/);
      assert.equal(ch.isClosed, false, 'CLI не отнял аренду');
    } finally {
      ch.close();
    }
    // Шлюз не отвечает — stg where по базе, только чтением.
    await gw.stop();
    const ro = await runCli(['where'], s.env);
    assert.equal(ro.code, 1);
    assert.match(ro.stdout, /^шлюз не отвечает — по базе:\n⚙ Где мы\n/);
    assert.match(ro.stdout, /\nАгент: неизвестно — шлюз не отвечает\n/);
    assert.match(ro.stdout, /\nОтложено: 1 /);
    gw = await s.start();
  });

  it('A2.14: «статус» и /status — опрос, база, переходник, агент (5.14), распознавание, p50/p90 за сутки', async () => {
    await pump(gw, () => q1(s.home, "SELECT 1 FROM outbox WHERE status = 'pending'") === undefined || null, { what: 'отправки' });
    const { ch } = await connectAdapter(s.home);
    let text: string;
    try {
      s.fake.push(s.fake.builder.text(OWNER, 'статус'));
      text = await nextLine('⚙ Статус');
    } finally {
      ch.close();
    }
    const lines = text.split('\n');
    assert.match(lines[1]!, /^Опрос: идёт, последний ответ Telegram в \d\d:\d\d/);
    assert.match(lines[2]!, /^База: в порядке · событий \d+ · ждёт отправки \d+ · отложено 1$/);
    assert.match(lines[3]!, /^Переходник: на связи \(fake-channel, с \d\d:\d\d\)$/);
    // Строка состояния и перехватчики агента не подключены (agent-state.json нет) — так и сказано (5.14).
    assert.equal(lines[4], 'Агент: данных нет — строка состояния и перехватчики Claude Code не подключены (stg agent-state, README папки агента)');
    assert.equal(lines[5], 'Режим: работает');
    // Голос по умолчанию — OpenAI; ключа в этом тесте нет: строки говорят, что сделать (M4, 5.8).
    // Модель по умолчанию — gpt-4o-mini-transcribe (P-20).
    assert.equal(lines[6], 'Распознавание: OpenAI gpt-4o-mini-transcribe, язык ru, словарь 0 · нет ключа openai — stg doctor · за сутки распознано 0, не распознано 0');
    assert.equal(lines[7], 'Синтез: OpenAI gpt-4o-mini-tts, голос alloy · нет ключа openai — stg doctor');
    const v = '(\\d+ мс|\\d+,\\d с)';
    // «Записал» — по записи (COMMIT; L-2, 0.3.2: ✍ нет) — измерен и без агента; 👀 — от отдачи агенту, «—», если 👀 за
    // сутки не ставился.
    const e = `(${v}|—)`;
    assert.match(lines[8]!, new RegExp(`^Задержки за сутки: записал p50 ${v} · p90 ${v}; 👀 после отдачи агенту p50 ${e} · p90 ${e}$`));
    await gw.waitForJournal((l) => l.ev === 'lease_released');
    s.fake.push(s.fake.builder.command(OWNER, '/status'));
    const t2 = await nextLine('⚙ Статус');
    assert.match(t2, /\nПереходник: не на связи\n/);
  });

  it('A2.19: /help — короткая справка: 👀 → 👌 (0.3.2, без ✍), кто пишет (P-26), закреплённая строка и её значки, команды в меню, голос и аудио; сообщение-команда удалено', async () => {
    const cmd = s.fake.builder.command(OWNER, '/help');
    s.fake.push(cmd);
    const help = await nextMessage('⚙ Как устроен чат');
    const t = help.text!;
    for (const w of ['👀 агент увидел · 👌 агент ответил', 'Агент не на связи — на сообщении ничего', 'ответ агента — обычным текстом', '⚙ — строка шлюза', '«↪ Имя:»', '💬 — ответ агента, который сам начинается со знака шлюза', 'номер эпизода (#7)', 'закрыт', '🟢 агент свободен · 🟡 думает · ⚪ не на связи', '📥 N', 'в меню ☰', '📍 Где мы', '🆕 Новая тема', '⏸ Пауза', '⛔ Стоп', 'аудиофайл', 'до 15 мин', 'ответом на него, целиком', '/status']) {
      assert.ok(t.includes(w), `в справке нет «${w}»:\n${t}`);
    }
    // Роль по умолчанию не показывается — и в справке о ней ни слова; эпизод — «#N», не «Эп. N».
    assert.ok(!/[Рр]оль|Эп\./.test(t), t);
    // О кнопках внизу, галочках и [расшифровка] — ни слова (0.3.1); справка остаётся в чате, без разметки.
    assert.doesNotMatch(t, /кнопками внизу|галочк|\[расшифровка\]|✍/);
    assert.equal(help.reply_markup, null, 'справка — без нижней клавиатуры');
    await pump(gw, () => deleted(cmd.message!) || null, { what: 'удаления /help' });
    assert.equal(deleted(help), false);
  });

  it('«где мы»: «итог #N не получен» — через сутки после отдачи episode_closed без итога; итог пришёл — строки нет', async () => {
    const ep = q1<{ episode_id: number }>(s.home, 'SELECT episode_id FROM events WHERE seq = ?', seq2)!.episode_id;
    s.fake.push(s.fake.builder.text(OWNER, 'новая тема'));
    const closed = await waitUntil(() => q1<{ seq: number }>(s.home, "SELECT seq FROM events WHERE kind = 'episode_closed' AND episode_id = ?", ep), 5000, 'episode_closed');
    const { ch } = await connectAdapter(s.home);
    try {
      await ch.waitEvent(closed.seq);
      await ch.delivered(closed.seq);
      await gw.jump('25h');
      s.fake.push(s.fake.builder.text(OWNER, 'где мы'));
      const m1 = await nextMessage('⚙ Где мы');
      const t1 = m1.text!;
      assert.match(t1, new RegExp(`\\nИтог #${ep} не получен$`), t1);
      const r = await ch.episodeSummary(ep, 'итог: агент был закрыт');
      assert.ok(r.type === 'ack');
      s.fake.push(s.fake.builder.text(OWNER, 'где мы'));
      const t2 = await nextLine('⚙ Где мы');
      assert.ok(!t2.includes('не получен'), t2);
      // Следующее «где мы» убирает прежний ответ сразу, не дожидаясь 5 минут.
      await pump(gw, () => deleted(m1) || null, { step: '1s', timeoutMs: 10_000, what: 'удаления прежнего «где мы»' });
    } finally {
      ch.close();
    }
  });
});
