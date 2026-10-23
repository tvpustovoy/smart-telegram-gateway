// M13 · адаптер Codex stg-codex (#55): настоящий шлюз (дочерний процесс, поддельные часы), поддельный Telegram,
// поддельный `codex app-server` (stg-fake-codex: JSON-RPC по stdio, «модель» по сценарию в тексте). Настоящий codex не
// запускается. Папка агента — временный каталог с AGENTS.md: адаптер в неё не пишет.
// Подъём: initialize с experimentalApi, тред с правилами Codex (developer instructions), песочница workspace-write без
// сети, папка посылок — writable root вне папки агента, 8 инструментов; проба закрыта адаптером без хода модели ·
// слово владельца → ход → delivered → reply в Telegram · два сообщения во время хода — один ход · промежуточный ответ,
// а ход идёт → «печатает…», 🟡 и 👀 до turn/completed (working; 👀 — #52), «стоп» снимает сразу · стоп → turn/interrupt,
// поздний вызов отклонён, [продолжить] → строки режима первыми · ход без ответа → одно напоминание · картинка — data URL ·
// send_file из папки посылок · лимит → строка владельцу и повтор · падение app-server → resume того же треда, повтор с
// пометкой · перезапуск адаптера → тот же тред, проба без хода · Codex лежит дольше минуты → аренда снята; поднялся →
// новая аренда, событие упавшего хода уходит в Codex без нового сообщения и один раз.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { STOPPED_TEXT, type Update } from 'stg-core';
import { FAKE_CODEX_ENTRY, inputOf, readFakeCodexLog, requestsOf } from 'stg-fake-codex';
import { CodexAdapter } from './codex-adapter.js';
import { makeTempDir, pump, q1, readJournal, sleep, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, reactionOf, receiptCleared, setup, statusLineOf, type Setup } from './m1-common.js';
import { press, waitSent } from './m2-common.js';
import { jpegBytes } from './m7-common.js';

describe('M13 · адаптер Codex (stg-codex) против поддельного app-server', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let agentDir: string;
  let fakeDir: string;
  let adapter: CodexAdapter;
  const agentFiles = (): string[] => fs.readdirSync(agentDir).sort();
  const seqOf = (u: Update): Promise<number> =>
    waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
  const say = async (text: string): Promise<number> => seqOf(s.fake.push(s.fake.builder.text(OWNER, text))[0]!);
  /** То же, с обновлением: реакция на сообщении. */
  const sayU = async (text: string): Promise<{ u: Update; seq: number }> => {
    const u = s.fake.push(s.fake.builder.text(OWNER, text))[0]!;
    return { u, seq: await seqOf(u) };
  };
  const feeds: string[] = [];
  const startAdapter = (): CodexAdapter => {
    if (adapter) feeds.push(adapter.feed);
    return CodexAdapter.start({ home: s.home.dir, agentDir, codex: FAKE_CODEX_ENTRY, env: { FAKE_CODEX_DIR: fakeDir } });
  };
  const turnStarts = (): string[] => requestsOf(fakeDir, 'turn/start').map(inputOf);
  const waitReply = (text: string, what = `ответа «${text}»`) => waitSent(s, gw, (m) => m.text === text, what);
  const statusOf = (seq: number): string | undefined => q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status;
  const typing = (): number => s.fake.chatActions.filter((a) => a.chat_id === OWNER.id && a.action === 'typing').length;
  /** Сдвинуть часы шлюза шагами по 4 с; сколько «печатает…» ушло за это время. */
  const typedDuring = async (steps: number): Promise<number> => {
    const n = typing();
    for (let i = 0; i < steps; i++) {
      await gw.advance('4s');
      await sleep(20);
    }
    await sleep(250);
    return typing() - n;
  };
  const waitStatus = (pred: (text: string) => boolean, what: string): Promise<string> =>
    pump(gw, () => {
      const st = statusLineOf(s.fake);
      return st && pred(st.text) ? st.text : null;
    }, { what });
  /** Строки журнала шлюза working (#55): включён (с этим № в наборе хода) или выключен. */
  const working = (on: boolean, seq?: number): Array<Record<string, unknown>> =>
    readJournal(s.home).filter((l) => l.ev === 'working' && l.on === on && (seq === undefined || (l.seqs as number[]).includes(seq)));

  before(async () => {
    s = await setup();
    gw = await s.start();
    agentDir = fs.realpathSync(makeTempDir('stg-agent-'));
    fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), '# Агент для теста\n');
    fakeDir = makeTempDir('stg-fcx-');
  });
  after(async () => {
    // STG_TEST_CODEX_FEED=1 — показать ленту адаптера (как в окне терминала) после прогона.
    if (process.env.STG_TEST_CODEX_FEED === '1') process.stderr.write(`\n— лента stg-codex —\n${feeds.join('')}${adapter?.feed ?? ''}\n`);
    if (adapter?.alive) await adapter.kill9();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('подъём: initialize с experimentalApi; тред: папка агента, workspace-write, never, правила Codex, посылки — writable root вне папки агента, 8 инструментов; проба закрыта адаптером, хода нет', async () => {
    adapter = startAdapter();
    await adapter.waitFeed((l) => /проверка канала № \d+ — закрыта адаптером/.test(l), 15_000, 'закрытия пробы');
    await waitUntil(() => readJournal(s.home).find((l) => l.ev === 'lease_verified' && l.adapter === 'stg-codex'), 5000, 'проверенной аренды stg-codex');
    const init = requestsOf(fakeDir, 'initialize')[0]!;
    assert.deepEqual(init.params?.capabilities, { experimentalApi: true });
    assert.equal((init.params?.clientInfo as { name: string }).name, 'stg-codex');
    const ts = requestsOf(fakeDir, 'thread/start');
    assert.equal(ts.length, 1);
    const p = ts[0]!.params!;
    const parcels = fs.realpathSync(path.join(s.home.dir, 'parcels'));
    assert.equal(p.cwd, agentDir);
    assert.equal(p.sandbox, 'workspace-write');
    assert.equal(p.approvalPolicy, 'never');
    assert.deepEqual(p.config, { 'sandbox_workspace_write.writable_roots': [parcels], 'sandbox_workspace_write.network_access': false });
    assert.deepEqual((p.dynamicTools as Array<{ type: string; name: string }>).map((t) => `${t.type}:${t.name}`), [
      'function:reply',
      'function:done',
      'function:episode',
      'function:episode_summary',
      'function:where',
      'function:rule',
      'function:media',
      'function:send_file',
    ]);
    const di = String(p.developerInstructions);
    for (const w of ['не у терминала', 'песочнице', 'reply(seq, text)', `папка посылок: ${parcels}`, `твоя папка (рабочий каталог команд): ${agentDir}`, 'AGENTS.md']) assert.ok(di.includes(w), `developer instructions без «${w}»`);
    for (const w of ['проверка канала', 'правила канала, версия', 'атрибуте trust']) assert.ok(!di.includes(w), `developer instructions с «${w}»`);
    assert.equal(requestsOf(fakeDir, 'thread/name/set').length, 1);
    assert.deepEqual(turnStarts(), [], 'на пробу хода модели нет');
    const state = JSON.parse(fs.readFileSync(path.join(s.home.dir, 'codex', 'state.json'), 'utf8')) as { threadId: string; agentDir: string };
    assert.equal(state.threadId, (requestsOf(fakeDir, 'thread/name/set')[0]!.params as { threadId: string }).threadId);
    assert.equal(state.agentDir, agentDir);
    assert.ok(fs.statSync(parcels).isDirectory(), 'папка посылок заведена');
    assert.deepEqual(agentFiles(), ['AGENTS.md'], 'в папку агента адаптер не пишет');
    assert.ok(adapter.lines().some((l) => l.includes(`инструкции Codex: ${path.join(agentDir, 'AGENTS.md')}`)), 'роль агента (AGENTS.md) — в ленте');
  });

  it('слово владельца → turn/start с заголовком канала → delivered только после ответа Codex → reply доходит до Telegram; событие обработано', async () => {
    const seq = await say('привет, медленно ответь');
    await waitUntil(() => turnStarts().find((t) => t.includes(`слово владельца] привет, медленно ответь`)), 5000, 'turn/start');
    // Codex ещё не ответил на turn/start (подделка ждёт 0,8 с): 👀 «агент увидел» рано — событие ещё не delivered.
    assert.equal(statusOf(seq), 'new');
    const start = requestsOf(fakeDir, 'turn/start').at(-1)!;
    assert.match(inputOf(start), new RegExp(`^\\[№ ${seq} · эп\\. \\d+ \\(новый\\) · слово владельца\\] привет, медленно ответь$`));
    assert.equal(start.params?.clientUserMessageId, `stg-${seq}`);
    await waitUntil(() => readJournal(s.home).find((l) => l.ev === 'delivered' && l.seq === seq), 5000, 'delivered');
    await waitReply(`ответ на № ${seq}`);
    await waitUntil(() => statusOf(seq) === 'processed', 5000, 'processed');
    await adapter.waitFeed((l) => l.includes(`reply № ${seq}: «ответ на № ${seq}» → ✓ отправлено`), 5000, 'строки ленты о reply');
    assert.ok(adapter.lines().some((l) => l.includes(`📩 [№ ${seq}`) && l.includes('привет, медленно ответь')), 'входящее — в ленте');
  });

  it('второе сообщение во время хода — ввод в тот же ход (тот же turn.id), ответы на оба', async () => {
    const before = readFakeCodexLog(fakeDir).filter((l) => l.dir === 'turn-start-result').length;
    const a = await say('долго думай над первым');
    await waitUntil(() => turnStarts().find((t) => t.includes('долго думай над первым')), 5000, 'turn/start первого');
    const b = await say('и вот второе');
    await waitReply(`ответ на № ${a}`);
    await waitReply(`ответ на № ${b}`);
    const results = readFakeCodexLog(fakeDir).filter((l) => l.dir === 'turn-start-result').slice(before);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.steered), [false, true]);
    assert.equal(results[0]!.turnId, results[1]!.turnId);
    await adapter.waitFeed((l) => l.includes(`ввод добавлен в идущий ход: № ${b}`), 5000, 'строки «ввод добавлен»');
  });

  it('промежуточный ответ, а ход идёт (#55): «печатает…» и 👀 держатся до turn/completed, дольше 2 минут, в строке 🟡; ход кончился — тишина, 🟢, 👀 снят', async () => {
    const { u, seq } = await sayU('промежуточно: что у нас записано?');
    await waitReply(`смотрю, № ${seq}`);
    await waitUntil(() => working(true, seq)[0], 5000, 'working от адаптера');
    assert.equal(statusOf(seq), 'processed', 'промежуточный ответ — обработано');
    // Ход Codex идёт молча (подделка ждёт go-N): 160 с по часам шлюза — «печатает…» каждые 4 с.
    const during = await typedDuring(40);
    assert.ok(during >= 35, `typing за 160 с хода: ${during}`);
    await waitStatus((t) => /\n🟡($| · )/u.test(t), '🟡 — ход идёт');
    // #52 × #55: промежуточный ответ ушёл, а 👀 на сообщении — агент над ним ещё работает.
    assert.equal(reactionOf(s.fake, u), '👀', '👀 держится, пока ход идёт');
    assert.ok(readJournal(s.home).some((l) => l.ev === 'out' && (l.event_seqs as number[] | undefined)?.includes(seq) && l.receipt_held === true), 'out — receipt_held');
    const offBefore = working(false).length;
    fs.writeFileSync(path.join(fakeDir, `go-${seq}`), '1');
    await waitReply(`ответ на № ${seq}`);
    await waitUntil(() => working(false).length > offBefore || null, 5000, 'working off по turn/completed');
    await pump(gw, () => receiptCleared(s.fake, u) || null, { what: '👀 снят по turn/completed' });
    assert.equal(await typedDuring(5), 0, 'ход кончился — тишина');
    await waitStatus((t) => /\n🟢($| · )/u.test(t), '🟢 — ход кончился');
  });

  it('стоп во время хода → turn/interrupt; поздний вызов из прерванного хода отклонён адаптером; [продолжить] → «стоп» и «стоп снят» первыми в следующем вводе', async () => {
    const seq = await say('жди меня');
    await waitUntil(() => turnStarts().find((t) => t.includes('жди меня')), 5000, 'turn/start');
    s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
    const stopLine = await waitSent(s, gw, (m) => m.text === STOPPED_TEXT, 'строки «остановлен»');
    await waitUntil(() => requestsOf(fakeDir, 'turn/interrupt').length > 0, 5000, 'turn/interrupt');
    const late = await waitUntil(() => readFakeCodexLog(fakeDir).find((l) => l.dir === 'tool-result' && l.args?.text === `поздно: ответ на № ${seq}`), 5000, 'позднего вызова');
    assert.equal(late.result?.success, false);
    assert.equal(late.result?.contentItems?.[0]?.text, 'Владелец сказал стоп — ответ не отправлен. Прекрати текущее дело');
    await waitUntil(() => readFakeCodexLog(fakeDir).find((l) => l.dir === 'turn-completed' && l.status === 'interrupted'), 5000, 'хода interrupted');
    assert.ok(!s.fake.sentTo(OWNER.id).some((m) => m.text?.startsWith('поздно')), 'поздний ответ в Telegram не ушёл');
    assert.equal(await press(s, stopLine, 'продолжить'), null);
    const next = await say('после стопа');
    await waitReply(`ответ на № ${next}`);
    const input = turnStarts().find((t) => t.includes('после стопа'))!;
    assert.match(input, /^\[шлюз · стоп\] [^\n]+\n\n\[шлюз · стоп снят\] [^\n]+\n\n\[№ \d+/);
    // Прерванное событие адаптер заново не отдаёт: решает повтор шлюза. Закрыть его — повтором по сроку.
    assert.equal(turnStarts().filter((t) => t.includes('жди меня')).length, 1);
    await pump(gw, () => s.fake.sentTo(OWNER.id).some((m) => m.text === `ответ на № ${seq}`) || null, { step: '30s', timeoutMs: 30_000, what: 'ответа на повтор шлюза' });
  });

  it('«стоп» во время хода после промежуточного ответа (#55): «печатает…» и 👀 сняты сразу и не возвращаются; адаптер — working off', async () => {
    const { u, seq } = await sayU('промежуточно и не спеши');
    await waitReply(`смотрю, № ${seq}`);
    await waitUntil(() => working(true, seq)[0], 5000, 'working от адаптера');
    assert.ok((await typedDuring(3)) >= 2);
    assert.equal(reactionOf(s.fake, u), '👀');
    const offBefore = working(false).length;
    const interruptedBefore = readFakeCodexLog(fakeDir).filter((l) => l.dir === 'turn-completed' && l.status === 'interrupted').length;
    // Строка «остановлен» прежнего теста — уже нажата: ждать новую.
    const oldStops = new Set(s.fake.sentTo(OWNER.id).filter((m) => m.text === STOPPED_TEXT).map((m) => m.message_id));
    s.fake.push(s.fake.builder.text(OWNER, 'стоп'));
    const stopLine = await waitSent(s, gw, (m) => m.text === STOPPED_TEXT && !oldStops.has(m.message_id), 'строки «остановлен»');
    await waitUntil(() => working(false).length > offBefore || null, 5000, 'working off от адаптера');
    await waitUntil(() => readFakeCodexLog(fakeDir).filter((l) => l.dir === 'turn-completed' && l.status === 'interrupted').length > interruptedBefore || null, 5000, 'хода interrupted');
    assert.equal(await typedDuring(5), 0, '«стоп» — тишина');
    await pump(gw, () => receiptCleared(s.fake, u) || null, { what: '👀 снят «стопом»' });
    assert.equal(await press(s, stopLine, 'продолжить'), null);
    await sleep(300);
    assert.equal(await typedDuring(3), 0, 'хода нет — и после «продолжить» тишина');
    assert.ok(receiptCleared(s.fake, u), '👀 не вернулся');
  });

  it('ход без ответа → одно напоминание тем же тредом → ответ доходит', async () => {
    const seq = await say('молчи пока');
    await waitReply(`ответ после напоминания на № ${seq}`);
    const reminders = turnStarts().filter((t) => t.startsWith('[адаптер · напоминание]'));
    assert.equal(reminders.length, 1);
    assert.match(reminders[0]!, new RegExp(`на № ${seq} нет ни reply, ни done`));
    await adapter.waitFeed((l) => l.includes(`на № ${seq} нет ни reply, ни done — напоминаю агенту (один раз)`), 5000, 'строки ленты о напоминании');
  });

  it('картинка: media → inputImage с data URL', async () => {
    const data = jpegBytes(800, 600, 3000, 7);
    s.fake.addFile(data, { fileId: 'cx800', path: 'photos/cx800.jpg' });
    const u = s.fake.push(s.fake.builder.photo(OWNER, 'картинка: что тут?', { sizes: [{ fileId: 'cx800', width: 800, height: 600, fileSize: data.length }] }))[0]!;
    const seq = await seqOf(u);
    await waitReply(`вижу: inputText, inputImage:data:image/jpeg;base64`, 'ответа с картинкой');
    assert.equal(statusOf(seq), 'processed');
  });

  it('send_file из папки посылок (вне папки агента) — файл у владельца', async () => {
    const seq = await say('пришли файл');
    const doc = await waitSent(s, gw, (m) => m.method === 'sendDocument' && m.document?.filename === 'report.txt', 'файла');
    assert.equal(doc.document?.data.toString(), `отчёт для № ${seq}\n`);
    assert.ok(fs.existsSync(path.join(s.home.dir, 'parcels', 'p1', 'report.txt')));
    assert.deepEqual(agentFiles(), ['AGENTS.md']);
  });

  it('лимит тарифа: ход failed → строка владельцу без № → повтор позже → ответ', async () => {
    const seq = await say('лимит проверь');
    await waitSent(s, gw, (m) => m.text?.startsWith('⚠ Codex: кончился лимит тарифа ChatGPT') === true, 'строки о лимите');
    await waitReply(`ответ на № ${seq}`);
    const tries = turnStarts().filter((t) => t.includes('лимит проверь'));
    assert.equal(tries.length, 2);
    assert.match(tries[1]!, /^\[адаптер · повтор после сбоя Codex: № \d+ — проверь, не сделано ли уже\]/);
  });

  it('падение app-server посреди хода → перезапуск, thread/resume того же треда с правилами, повтор с пометкой → ответ', async () => {
    const threadId = (requestsOf(fakeDir, 'thread/name/set')[0]!.params as { threadId: string }).threadId;
    const pidsBefore = new Set(readFakeCodexLog(fakeDir).map((l) => l.pid));
    const seq = await say('упади, пожалуйста');
    await waitReply(`ответ на № ${seq}`);
    assert.ok(readFakeCodexLog(fakeDir).some((l) => l.dir === 'crash' && l.seq === seq), 'подделка упала');
    const resume = requestsOf(fakeDir, 'thread/resume').find((l) => !pidsBefore.has(l.pid))!;
    assert.ok(resume, 'thread/resume новым процессом');
    assert.equal(resume.params?.threadId, threadId);
    assert.equal(resume.params?.excludeTurns, true);
    assert.ok(String(resume.params?.developerInstructions).includes('не у терминала'), 'правила — и при resume');
    assert.equal(resume.params?.dynamicTools, undefined, 'инструменты — из треда');
    const again = turnStarts().filter((t) => t.includes('упади, пожалуйста'));
    assert.equal(again.length, 2);
    assert.match(again[1]!, new RegExp(`^\\[адаптер · повтор после сбоя Codex: № ${seq} — проверь, не сделано ли уже\\]\\n\\n\\[№ ${seq} `));
    assert.equal(requestsOf(fakeDir, 'thread/start').length, 1, 'новый тред не заводился');
    await adapter.waitFeed((l) => l.includes('codex app-server вышел (код 3)'), 1000, 'строки о падении');
  });

  it('перезапуск адаптера: SIGTERM — аренда снята, app-server вышел; новый адаптер — тот же тред, проба закрыта без хода; ответ', async () => {
    const threadId = (requestsOf(fakeDir, 'thread/name/set')[0]!.params as { threadId: string }).threadId;
    const r = await adapter.stop();
    assert.equal(r.code, 0);
    await waitUntil(() => readJournal(s.home).filter((l) => l.ev === 'lease_released').length > 0, 5000, 'снятия аренды');
    await waitUntil(() => readFakeCodexLog(fakeDir).filter((l) => l.dir === 'exit').length > 0, 5000, 'выхода app-server');
    const startsBefore = turnStarts().length;
    adapter = startAdapter();
    await adapter.waitFeed((l) => /проверка канала № \d+ — закрыта адаптером/.test(l), 15_000, 'закрытия пробы');
    const resumes = requestsOf(fakeDir, 'thread/resume');
    assert.equal(resumes.at(-1)!.params?.threadId, threadId);
    assert.equal(requestsOf(fakeDir, 'thread/start').length, 1);
    assert.equal(turnStarts().length, startsBefore, 'на пробу хода нет');
    const seq = await say('снова на связи?');
    await waitReply(`ответ на № ${seq}`);
    assert.deepEqual(agentFiles(), ['AGENTS.md'], 'в папку агента адаптер не писал');
  });

  it('тред пропал (resume: «no rollout found») → новый тред с инструментами; state.json — его id', async () => {
    await adapter.stop();
    fs.rmSync(path.join(fakeDir, 'threads.json'));
    adapter = startAdapter();
    await adapter.waitFeed((l) => l.includes('не найден (no rollout found'), 10_000, 'строки «тред не найден»');
    await adapter.waitFeed((l) => /проверка канала № \d+ — закрыта адаптером/.test(l), 10_000, 'закрытия пробы');
    await waitUntil(() => requestsOf(fakeDir, 'thread/start').length === 2, 5000, 'нового thread/start');
    const id = (requestsOf(fakeDir, 'thread/name/set').at(-1)!.params as { threadId: string }).threadId;
    await waitUntil(() => (JSON.parse(fs.readFileSync(path.join(s.home.dir, 'codex', 'state.json'), 'utf8')) as { threadId: string }).threadId === id, 5000, 'state.json');
    const seq = await say('ты тут?');
    await waitReply(`ответ на № ${seq}`);
  });
});

describe('M13 · адаптер Codex: Codex лежит дольше минуты — аренда снята и взята снова', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let adapter: CodexAdapter;
  after(async () => {
    if (process.env.STG_TEST_CODEX_FEED === '1') process.stderr.write(`\n— лента stg-codex —\n${adapter?.feed ?? ''}\n`);
    if (adapter?.alive) await adapter.kill9();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('событие упавшего хода ждёт в очереди; новая аренда — шлюз отдаёт его снова, и оно уходит в Codex без нового сообщения, один раз', async () => {
    s = await setup();
    gw = await s.start();
    const agentDir = fs.realpathSync(makeTempDir('stg-agent-'));
    fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), '# Агент для теста\n');
    const fakeDir = makeTempDir('stg-fcx-');
    const down = path.join(fakeDir, 'DOWN');
    adapter = CodexAdapter.start({ home: s.home.dir, agentDir, codex: FAKE_CODEX_ENTRY, env: { FAKE_CODEX_DIR: fakeDir, FAKE_CODEX_DOWN_FLAG: down } });
    await adapter.waitFeed((l) => /проверка канала № \d+ — закрыта адаптером/.test(l), 15_000, 'закрытия пробы');
    const say = (text: string): Promise<number> => {
      const u = s.fake.push(s.fake.builder.text(OWNER, text))[0]!;
      return waitUntil(() => q1<{ seq: number }>(s.home, 'SELECT seq FROM events WHERE update_id = ?', u.update_id)?.seq, 5000, 'приёма');
    };
    const tries = (): string[] => requestsOf(fakeDir, 'turn/start').map(inputOf).filter((t) => t.includes('упади, пожалуйста'));
    const statusOf = (seq: number): string | undefined => q1<{ status: string }>(s.home, 'SELECT status FROM events WHERE seq = ?', seq)?.status;
    const verified = (): Array<Record<string, unknown>> => readJournal(s.home).filter((l) => l.ev === 'lease_verified' && l.adapter === 'stg-codex');
    const a = await say('привет');
    await waitSent(s, gw, (m) => m.text === `ответ на № ${a}`, 'первого ответа');

    // Codex падает посреди хода и не поднимается: событие хода — в очередь адаптера, через минуту аренда снята.
    fs.writeFileSync(down, '1');
    const b = await say('упади, пожалуйста');
    await adapter.waitFeed((l) => l.includes('аренда у шлюза снята'), 15_000, 'снятия аренды');
    assert.equal(tries().length, 1);
    fs.rmSync(down);

    // Поднялся — новая аренда с пробой; шлюз отдаёт событие снова. Часы шлюза стоят: это не повтор по сроку.
    await waitUntil(() => verified().length >= 2, 15_000, 'второй проверенной аренды');
    await waitUntil(() => tries().length >= 2, 5000, 'события упавшего хода в Codex без нового сообщения');
    assert.match(tries()[1]!, new RegExp(`^\\[адаптер · повтор после сбоя Codex: № ${b} — проверь, не сделано ли уже\\]\\n\\n\\[№ ${b} `));
    await waitSent(s, gw, (m) => m.text === `ответ на № ${b}`, 'ответа на событие упавшего хода');
    await waitUntil(() => statusOf(b) === 'processed', 5000, 'processed');
    assert.equal(tries().length, 2, 'в Codex — один раз после сбоя');
    assert.equal(s.fake.sentTo(OWNER.id).filter((m) => m.text === `ответ на № ${b}`).length, 1, 'ответ — один');
    assert.ok(adapter.log.includes(`№ ${b} уже ждёт в очереди — повтор шлюза не дублирую; отдан новой аренде`), 'повтор шлюза перевесил событие на новую аренду');
    const lease2 = verified()[1]!.lease;
    assert.ok(readJournal(s.home).some((l) => l.ev === 'delivered' && l.seq === b && l.lease === lease2), 'delivered — от новой аренды');
  });
});

describe('M13 · адаптер Codex: нет входа в ChatGPT', () => {
  let s: Setup;
  let gw: GatewayProcess;
  let adapter: CodexAdapter;
  after(async () => {
    if (adapter?.alive) await adapter.kill9();
    if (gw?.alive) await gw.stop();
    await s.close();
  });

  it('account/read без входа — аренды нет, тред не заводится; в ленте и state.json — причина', async () => {
    s = await setup();
    gw = await s.start();
    const agentDir = fs.realpathSync(makeTempDir('stg-agent-'));
    const fakeDir = makeTempDir('stg-fcx-');
    adapter = CodexAdapter.start({ home: s.home.dir, agentDir, codex: FAKE_CODEX_ENTRY, env: { FAKE_CODEX_DIR: fakeDir, FAKE_CODEX_NO_ACCOUNT: '1' } });
    await adapter.waitFeed((l) => l.includes('нет входа в ChatGPT у Codex'), 10_000, 'строки о входе');
    await waitUntil(() => {
      try {
        return (JSON.parse(fs.readFileSync(path.join(s.home.dir, 'codex', 'state.json'), 'utf8')) as { problem: string | null }).problem === 'no_login';
      } catch {
        return false;
      }
    }, 5000, 'state.json с причиной');
    assert.equal(requestsOf(fakeDir, 'thread/start').length, 0);
    assert.ok(!readJournal(s.home).some((l) => l.ev === 'lease_granted'), 'аренды нет');
  });
});
