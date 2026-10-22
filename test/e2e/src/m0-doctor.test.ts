// A0.2 — stg doctor без токена; с токеном; с испорченной базой: каждая проверка — строка «да / нет / что сделать»;
// при «нет» код выхода ≠ 0; getUpdates не вызван.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { SCHEMA_VERSION, launchdLabel, vocabularyPromptTerms } from 'stg-core';
import { FakeTelegram } from 'stg-fake-telegram';
import {
  GatewayProcess,
  TEST_TOKEN,
  doctorLines,
  fakeLaunchctl,
  makeHome,
  runCli,
  servicePlist,
  testEnv,
  type DoctorLine,
  type TestHome,
} from './harness.js';

function line(lines: DoctorLine[], name: string): DoctorLine {
  const l = lines.find((x) => x.name === name);
  assert.ok(l, `нет строки «${name}»: ${lines.map((x) => x.raw).join('\n')}`);
  return l;
}

function assertFormat(stdout: string, code: number | null): DoctorLine[] {
  const lines = doctorLines(stdout);
  assert.ok(lines.length >= 12, `мало строк проверок:\n${stdout}`);
  for (const l of lines) {
    if (l.ok) assert.match(l.raw, /^да\s+· [^·]+ · .+/, l.raw);
    else assert.match(l.raw, /^нет · [^·]+ · .+ · что сделать: .+/, l.raw);
  }
  const anyNo = lines.some((l) => !l.ok);
  assert.equal(code === 0, !anyNo, `код ${code} не сходится со строками:\n${stdout}`);
  if (anyNo) assert.notEqual(code, 0);
  return lines;
}

describe('A0.2 · stg doctor', () => {
  let fake: FakeTelegram;
  let home: TestHome;

  before(async () => {
    fake = await FakeTelegram.start({ token: TEST_TOKEN });
    home = makeHome({ apiBase: fake.apiBase, ownerId: 111 });
    // База появляется при первом старте шлюза (без токена шлюз ждёт его и Telegram не трогает).
    const g = await GatewayProcess.start(home, testEnv(home));
    await g.stop();
    await servicePlist(home, launchdLabel('test_assistant_bot'));
  });

  after(() => fake.stop());

  it('без токена: «нет» с командой для связки ключей, код ≠ 0, Telegram не вызван', async () => {
    const calls = fake.calls.length;
    const r = await runCli(['doctor'], testEnv(home, { STG_LAUNCHCTL: fakeLaunchctl(home) }));
    const lines = assertFormat(r.stdout, r.code);
    assert.notEqual(r.code, 0);
    const tok = line(lines, 'токен бота');
    assert.equal(tok.ok, false);
    assert.match(tok.raw, /STG_TEST_TELEGRAM_TOKEN/);
    assert.equal(line(lines, 'вебхук').ok, false);
    assert.equal(fake.calls.length, calls, 'без токена doctor в Telegram не ходит');
    assert.equal(fake.callsOf('getUpdates').length, 0);
  });

  it('с токеном: getMe и getWebhookInfo — «да»; база, схема, quick_check, служба — «да»; getUpdates не вызван', async () => {
    const dbBefore = fs.readFileSync(home.paths.db);
    const r = await runCli(['doctor'], testEnv(home, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN, STG_LAUNCHCTL: fakeLaunchctl(home) }));
    const lines = assertFormat(r.stdout, r.code);
    for (const name of ['каталог бота', 'права каталога', 'настройки', 'правила', 'владелец', 'токен бота', 'вебхук', 'база', 'версия схемы', 'quick_check', 'Node', 'MCP SDK канала', 'плист службы', 'Node службы', 'служба']) {
      assert.equal(line(lines, name).ok, true, line(lines, name).raw);
    }
    assert.match(line(lines, 'токен бота').detail, /@test_assistant_bot/);
    assert.match(line(lines, 'версия схемы').detail, new RegExp(`v${SCHEMA_VERSION}`));
    assert.match(line(lines, 'MCP SDK канала').detail, /^1\./);
    assert.ok(!r.stdout.includes(TEST_TOKEN), 'токен не печатается');
    assert.equal(fake.callsOf('getMe').length >= 1, true);
    assert.equal(fake.callsOf('getWebhookInfo').length >= 1, true);
    assert.equal(fake.callsOf('getUpdates').length, 0);
    assert.deepEqual(fs.readFileSync(home.paths.db), dbBefore, 'doctor базу не меняет');
  });

  it('вебхук стоит: «нет», deleteWebhook не вызван', async () => {
    fake.setWebhook('https://hooks.example.com/secret-path');
    try {
      const r = await runCli(['doctor'], testEnv(home, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN, STG_LAUNCHCTL: fakeLaunchctl(home) }));
      const lines = assertFormat(r.stdout, r.code);
      const w = line(lines, 'вебхук');
      assert.equal(w.ok, false);
      assert.match(w.raw, /hooks\.example\.com/);
      assert.ok(!w.raw.includes('secret-path'), 'путь вебхука не печатается');
      assert.notEqual(r.code, 0);
      assert.equal(fake.callsOf('deleteWebhook').length, 0);
    } finally {
      fake.webhookUrl = '';
    }
  });

  it('голос (5.8): распознавание и синтез — провайдер, адрес, модель, есть ли ключ под именем из config.yaml; ключ не печатается; провайдер не вызывается', async () => {
    // По умолчанию — OpenAI, ключ openai.
    const r0 = await runCli(['doctor'], testEnv(home, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN }));
    const no = assertFormat(r0.stdout, r0.code);
    const s0 = line(no, 'распознавание');
    assert.equal(s0.ok, false);
    assert.match(s0.detail, /^OpenAI \(openai\), https:\/\/api\.openai\.com\/v1, модель gpt-4o-mini-transcribe, язык ru, словарь 0; ключа openai нет: переменная STG_TEST_VOICE_KEY_OPENAI \(STG_TEST=1\) — голосовые не распознаются/);
    assert.match(s0.raw, /что сделать: задай STG_TEST_VOICE_KEY_OPENAI$/);
    const t0 = line(no, 'синтез');
    assert.equal(t0.ok, false);
    assert.match(t0.detail, /^OpenAI \(openai\), https:\/\/api\.openai\.com\/v1, модель gpt-4o-mini-tts, голос alloy; ключа openai нет: .* — ответы голосом уходят текстом/);
    const key = 'sk-doctor-OPENAI-0000';
    const r = await runCli(['doctor'], testEnv(home, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN, STG_TEST_VOICE_KEY_OPENAI: key }));
    const yes = assertFormat(r.stdout, r.code);
    for (const name of ['распознавание', 'синтез']) {
      const l = line(yes, name);
      assert.equal(l.ok, true, l.raw);
      assert.match(l.detail, /; ключ openai — есть \(переменная теста\)$/);
    }
    assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key), 'ключ не печатается');

    // ElevenLabs с ключом под своим именем; голос синтеза не задан — что сделать. OpenRouter — тот же провайдер openai,
    // с оговоркой «не проверены на настоящем ключе». Словарь длиннее предела prompt — doctor говорит, сколько терминов уходит.
    const longVocabulary = Array.from({ length: 60 }, (_, i) => `ДлинныйТерминСловаря${String(i).padStart(2, '0')}`);
    const h2 = makeHome({
      apiBase: fake.apiBase,
      ownerId: 111,
      extraConfig:
        `stt: { provider: openai, base_url: https://openrouter.ai/api/v1, model: openai/gpt-4o-transcribe, key: openrouter, vocabulary: [${longVocabulary.join(', ')}] }\n` +
        'tts: { provider: elevenlabs, key: el-key }\n',
    });
    const r2 = await runCli(['doctor'], testEnv(h2, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN, STG_TEST_VOICE_KEY_OPENROUTER: 'sk-or-doctor-0000' }));
    const l2 = assertFormat(r2.stdout, r2.code);
    const s2 = line(l2, 'распознавание');
    assert.equal(s2.ok, true, s2.raw);
    const sent = vocabularyPromptTerms(longVocabulary).length;
    assert.ok(sent > 0 && sent < longVocabulary.length, String(sent));
    assert.match(
      s2.detail,
      new RegExp(
        `^OpenRouter \\(openai\\), https://openrouter\\.ai/api/v1, модель openai/gpt-4o-transcribe, язык ru, словарь 60 \\(в prompt уходит ${sent} из 60 терминов: предел 1000 знаков\\) ` +
          '⟨путь /audio/transcriptions у OpenRouter есть; голосовое Ogg и имя модели не проверены на настоящем ключе⟩; ключ openrouter — есть',
      ),
    );
    const t2 = line(l2, 'синтез');
    assert.equal(t2.ok, false);
    assert.match(t2.detail, /^ElevenLabs \(elevenlabs\), https:\/\/api\.elevenlabs\.io, модель eleven_multilingual_v2; ключа el-key нет: .*; tts\.voice_id не задан/);
    assert.match(t2.raw, /что сделать: задай STG_TEST_VOICE_KEY_EL_KEY; впиши tts\.voice_id/);
    assert.ok(!r2.stdout.includes('sk-or-doctor-0000'));
  });

  it('токен не принят Telegram: «нет» с подсказкой про BotFather', async () => {
    const r = await runCli(['doctor'], testEnv(home, { STG_TEST_TELEGRAM_TOKEN: '1:wrong', STG_LAUNCHCTL: fakeLaunchctl(home) }));
    const lines = assertFormat(r.stdout, r.code);
    const tok = line(lines, 'токен бота');
    assert.equal(tok.ok, false);
    assert.match(tok.raw, /не принял токен/);
    assert.match(tok.raw, /BotFather/);
  });

  it('служба не установлена или не загружена: «нет»', async () => {
    const r = await runCli(['doctor'], testEnv(home, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN, STG_LAUNCHCTL: '/usr/bin/false' }));
    const lines = assertFormat(r.stdout, r.code);
    assert.equal(line(lines, 'служба').ok, false);
    assert.notEqual(r.code, 0);
  });

  it('испорченная база: «база», «версия схемы», «quick_check» — «нет», код ≠ 0; getUpdates не вызван', async () => {
    const broken = makeHome({ apiBase: fake.apiBase, ownerId: 111 });
    fs.writeFileSync(broken.paths.db, 'это не база SQLite\n'.repeat(500));
    const r = await runCli(['doctor'], testEnv(broken, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN }));
    const lines = assertFormat(r.stdout, r.code);
    assert.notEqual(r.code, 0);
    for (const name of ['база', 'версия схемы', 'quick_check']) assert.equal(line(lines, name).ok, false, line(lines, name).raw);
    assert.match(line(lines, 'база').detail, /не открывается/);
    assert.equal(fake.callsOf('getUpdates').length, 0);
  });

  it('обрезанная база: «нет» и код ≠ 0', async () => {
    const cut = makeHome({ apiBase: fake.apiBase, ownerId: 111 });
    const g = await GatewayProcess.start(cut, testEnv(cut));
    await g.stop();
    // Нарастить базу, чтобы обрезка задела страницы данных.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(cut.paths.db);
    db.exec('BEGIN');
    const ins = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    for (let i = 0; i < 3000; i++) ins.run(`fill${i}`, 'x'.repeat(300));
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    fs.truncateSync(cut.paths.db, Math.floor(fs.statSync(cut.paths.db).size / 2));
    const r = await runCli(['doctor'], testEnv(cut, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN }));
    const lines = assertFormat(r.stdout, r.code);
    assert.notEqual(r.code, 0);
    assert.ok(['база', 'quick_check'].some((n) => !line(lines, n).ok));
  });

  it('нет базы: «нет — запусти шлюз»', async () => {
    const fresh = makeHome({ apiBase: fake.apiBase, ownerId: 111 });
    const r = await runCli(['doctor'], testEnv(fresh, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN }));
    const lines = assertFormat(r.stdout, r.code);
    assert.match(line(lines, 'база').raw, /запусти шлюз/);
    assert.equal(fs.existsSync(fresh.paths.db), false, 'doctor базу не создаёт');
  });

  it('испорченные настройки: «нет» с полем', async () => {
    const bad = makeHome({ apiBase: fake.apiBase, ownerId: 111, extraConfig: 'episode_idle_minutes: ноль\n' });
    const r = await runCli(['doctor'], testEnv(bad, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN }));
    const lines = doctorLines(r.stdout);
    const cfg = line(lines, 'настройки');
    assert.equal(cfg.ok, false);
    assert.match(cfg.raw, /episode_idle_minutes/);
    assert.notEqual(r.code, 0);
  });
});
