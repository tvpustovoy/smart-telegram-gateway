import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  ConfigError,
  DEFAULT_ROLE,
  defaultRules,
  effectiveRules,
  loadConfig,
  loadRules,
  parseConfig,
  parseRules,
  writeRules,
} from './config.js';

/** Временные каталоги этого файла тестов — удаляются после него. */
const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const SPEC_CONFIG = `bot: my_assistant_bot
owner_id: 123456789            # числовой номер владельца; пусто — режим первой настройки (5.3)
timezone: Europe/Berlin
telegram: { api_base: https://api.telegram.org }        # файлы: <api_base>/file/bot<token>/<file_path>
episode_idle_minutes: 33
agent_offline_notice_minutes: 10
redeliver_after_minutes: 10
stt: { provider: openai, base_url: https://api.openai.com/v1, model: gpt-4o-mini-transcribe, key: openai, language: ru, vocabulary: [Acme, Борис, Kubernetes] }
tts: { provider: openai, base_url: https://api.openai.com/v1, model: gpt-4o-mini-tts, key: openai, voice: alloy }
# OpenRouter ⟨не проверено; возможно, путей /audio/* нет⟩ — тот же провайдер openai: свой адрес, модель с префиксом, свой ключ:
# tts: { provider: openai, base_url: https://openrouter.ai/api/v1, model: openai/gpt-4o-mini-tts, key: openrouter, voice: alloy }
# ElevenLabs:
# stt: { provider: elevenlabs, base_url: https://api.elevenlabs.io, model: scribe_v2, key: elevenlabs, language: ru, vocabulary: [Acme, Борис, Kubernetes] }
# tts: { provider: elevenlabs, base_url: https://api.elevenlabs.io, model: eleven_multilingual_v2, key: elevenlabs, voice_id: "<id>", output_format: opus_48000_64 }
closed_topics: []              # message_thread_id тем, которые идут мимо агента и распознавания
closed_marker: null            # слово-метка в тексте или подписи — то же действие
retention: { owner_voice_days: 30, untrusted_days: 90, logs_days: 90, closed_days: 30 }
`;

const SPEC_RULES = `subjects:
  - id: owner
    who: owner                 # владельца правилом не убрать: он задан в config.yaml
    transports: [{ network: telegram, address: "123456789" }]
chats:
  - chat: private              # личка с любым субъектом из subjects
    space: личное
    role: личный ассистент
`;

function tmpFile(name: string, text: string): string {
  const dir = tmpDir('stg-cfg-');
  const f = path.join(dir, name);
  fs.writeFileSync(f, text);
  return f;
}

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigError, `ожидалась ConfigError, а не ${String(err)}`);
    return err.problems;
  }
  assert.fail('ожидалась ошибка настроек');
}

describe('config.yaml', () => {
  it('пример из TECH-SPEC 5.1 читается как есть', () => {
    const c = loadConfig(tmpFile('config.yaml', SPEC_CONFIG), { test: false });
    assert.equal(c.bot, 'my_assistant_bot');
    assert.equal(c.owner_id, 123456789);
    assert.equal(c.timezone, 'Europe/Berlin');
    assert.equal(c.telegram.api_base, 'https://api.telegram.org');
    assert.deepEqual(c.stt, {
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-transcribe',
      key: 'openai',
      language: 'ru',
      vocabulary: ['Acme', 'Борис', 'Kubernetes'],
      audio_max_minutes: 15,
    });
    assert.deepEqual(c.tts, { provider: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', key: 'openai', voice: 'alloy', instructions: null });
    assert.equal(c.retention.untrusted_days, 90);
    // Варианты из примера (в комментариях) — тоже читаются.
    const variants = SPEC_CONFIG.split('\n')
      .filter((l) => /^# (stt|tts): /.test(l))
      .map((l) => l.slice(2));
    assert.equal(variants.length, 3);
    for (const v of variants) {
      const [field, rest] = [v.slice(0, 3), v.slice(5)];
      const c2 = loadConfig(tmpFile('config.yaml', `bot: b_bot\ntimezone: UTC\n${field}: ${rest}\n`), { test: false });
      assert.ok(c2[field as 'stt' | 'tts'].provider, v);
    }
  });

  it('пустой owner_id — первая настройка (null); остальное — по умолчанию из 5.1', () => {
    const c = loadConfig(tmpFile('config.yaml', 'bot: b_bot\nowner_id:\ntimezone: UTC\n'), { test: false });
    assert.equal(c.owner_id, null);
    assert.equal(c.episode_idle_minutes, 33);
    assert.equal(c.agent_offline_notice_minutes, 10);
    assert.equal(c.redeliver_after_minutes, 10);
    assert.equal(c.telegram.api_base, 'https://api.telegram.org');
    assert.equal(c.stt.language, 'ru');
    // Голос по умолчанию — openai; модель распознавания — gpt-4o-mini-transcribe
    // (P-20: gpt-4o-transcribe терял текст на реальных записях).
    assert.deepEqual(
      [c.stt.provider, c.stt.base_url, c.stt.model, c.stt.key],
      ['openai', 'https://api.openai.com/v1', 'gpt-4o-mini-transcribe', 'openai'],
    );
    assert.deepEqual([c.tts.provider, c.tts.model, c.tts.key], ['openai', 'gpt-4o-mini-tts', 'openai']);
    assert.equal(c.tts.provider === 'openai' ? c.tts.voice : null, 'alloy');
    assert.deepEqual(c.closed_topics, []);
    assert.equal(c.closed_marker, null);
    assert.deepEqual(c.retention, { owner_voice_days: 30, untrusted_days: 90, logs_days: 90, closed_days: 30 });
    // Посылки (0.3.3): папка — по умолчанию <каталог сессии агента>/parcels; цель — telegram.
    assert.deepEqual(c.parcels, { dir: null, targets: ['telegram'] });
    // Окно отмены реакции (0.3.4, issue #46) — 3 с.
    assert.deepEqual(c.reactions, { hold_seconds: 3 });
  });

  it('посылки (0.3.3): parcels.dir — полный путь или с «~/»; имя цели — латиница; лишнее поле — ошибка', () => {
    const c = loadConfig(tmpFile('config.yaml', 'bot: b_bot\ntimezone: UTC\nparcels: { dir: "~/Agents/assistant/parcels", targets: [telegram, web] }\n'), { test: false });
    assert.deepEqual(c.parcels, { dir: '~/Agents/assistant/parcels', targets: ['telegram', 'web'] });
    assert.match(problems(() => parseConfig({ bot: 'b', timezone: 'UTC', parcels: { dir: 'parcels' } }, { test: false })).join(), /parcels\.dir — папка посылок — полный путь/);
    assert.match(problems(() => parseConfig({ bot: 'b', timezone: 'UTC', parcels: { targets: ['Web Site'] } }, { test: false })).join(), /имя цели/);
    assert.match(problems(() => parseConfig({ bot: 'b', timezone: 'UTC', parcels: { url: 'x' } }, { test: false })).join(), /url/);
  });

  it('окно отмены реакции (0.3.4, issue #46): по умолчанию 3 с; 0 — без окна; дробное — можно; больше 3 и меньше 0 — ошибка словами', () => {
    assert.deepEqual(parseConfig({ bot: 'b_bot', timezone: 'UTC' }, { test: false }).reactions, { hold_seconds: 3 });
    const c = loadConfig(tmpFile('config.yaml', 'bot: b_bot\ntimezone: UTC\nreactions: { hold_seconds: 0 }\n'), { test: false });
    assert.equal(c.reactions.hold_seconds, 0);
    assert.equal(parseConfig({ bot: 'b_bot', timezone: 'UTC', reactions: { hold_seconds: 2.5 } }, { test: false }).reactions.hold_seconds, 2.5);
    // Больше 3 с — ошибка: окно не должно мешать переписке.
    const four = problems(() => loadConfig(tmpFile('config.yaml', 'bot: b_bot\ntimezone: UTC\nreactions: { hold_seconds: 4 }\n'), { test: false }));
    assert.deepEqual(four, ['reactions.hold_seconds — окно отмены реакции — не больше 3 с; 0 — без окна']);
    assert.match(problems(() => parseConfig({ bot: 'b', timezone: 'UTC', reactions: { hold_seconds: -1 } }, { test: false })).join(), /reactions\.hold_seconds — окно отмены реакции — не меньше 0/);
    assert.match(problems(() => parseConfig({ bot: 'b', timezone: 'UTC', reactions: { hold_seconds: 'три' } }, { test: false })).join(), /reactions\.hold_seconds — окно отмены реакции — число секунд/);
    assert.match(problems(() => parseConfig({ bot: 'b', timezone: 'UTC', reactions: { hold: 3 } }, { test: false })).join(), /hold/);
  });

  it('ошибки — по-русски, с полем', () => {
    const p = problems(() =>
      parseConfig({ bot: 'b', owner_id: 'abc', timezone: 'Mars/Base', episode_idle_minutes: 0, extra: 1 }, { test: false }),
    );
    const text = p.join('\n');
    assert.match(text, /owner_id — /);
    assert.match(text, /timezone — неизвестный часовой пояс/);
    assert.match(text, /episode_idle_minutes — /);
    assert.match(text, /extra/);
  });

  it('нет файла и битый YAML — понятная ошибка', () => {
    assert.match(problems(() => loadConfig('/нет/такого/config.yaml', { test: false })).join(), /нет файла/);
    assert.match(problems(() => loadConfig(tmpFile('config.yaml', 'bot: [\n'), { test: false })).join(), /разбор YAML/);
    assert.match(
      problems(() => loadConfig(tmpFile('config.yaml', 'bot: a\nbot: b\ntimezone: UTC\n'), { test: false })).join(),
      /разбор YAML/,
    );
  });

  it('http:// — только к 127.0.0.1 и только под тестом: токен не уходит в открытую сеть', () => {
    const base = { bot: 'b_bot', timezone: 'UTC' };
    const local = { ...base, telegram: { api_base: 'http://127.0.0.1:8081' } };
    assert.equal(parseConfig(local, { test: true }).telegram.api_base, 'http://127.0.0.1:8081');
    assert.match(problems(() => parseConfig(local, { test: false })).join(), /нужен https/);
    const remote = { ...base, telegram: { api_base: 'http://example.com' } };
    assert.match(problems(() => parseConfig(remote, { test: true })).join(), /нужен https/);
  });

  it('словарь распознавания: термин короче 50 знаков и не длиннее 5 слов — у обоих провайдеров', () => {
    for (const stt of [
      { vocabulary: ['один два три четыре пять шесть', 'x'.repeat(50)] },
      { provider: 'elevenlabs', keyterms: ['один два три четыре пять шесть', 'x'.repeat(50)] },
    ]) {
      const text = problems(() => parseConfig({ bot: 'b_bot', timezone: 'UTC', stt }, { test: false })).join('\n');
      assert.match(text, /stt\.vocabulary\.0 — термин словаря — не больше 5 слов/);
      assert.match(text, /stt\.vocabulary\.1 — термин словаря — меньше 50 знаков/);
    }
  });
});

describe('config.yaml · голос: провайдеры (5.8)', () => {
  const base = { bot: 'b_bot', timezone: 'UTC' };

  it('прежний config с provider elevenlabs, model_id и keyterms читается — те же значения под новыми именами', () => {
    const c = loadConfig(
      tmpFile(
        'config.yaml',
        'bot: b_bot\ntimezone: UTC\n' +
          'stt: { provider: elevenlabs, base_url: https://api.elevenlabs.io, model_id: scribe_v2, language: ru, keyterms: [Acme, Борис] }\n' +
          'tts: { provider: elevenlabs, base_url: https://api.elevenlabs.io, model_id: eleven_v3, voice_id: "v1", output_format: opus_48000_64 }\n',
      ),
      { test: false },
    );
    assert.deepEqual(c.stt, { provider: 'elevenlabs', base_url: 'https://api.elevenlabs.io', model: 'scribe_v2', key: 'elevenlabs', language: 'ru', vocabulary: ['Acme', 'Борис'], audio_max_minutes: 15 });
    assert.deepEqual(c.tts, { provider: 'elevenlabs', base_url: 'https://api.elevenlabs.io', model: 'eleven_v3', key: 'elevenlabs', voice_id: 'v1', output_format: 'opus_48000_64' });
  });

  it('elevenlabs по умолчанию: адрес, модели, ключ elevenlabs, голос не задан', () => {
    const c = parseConfig({ ...base, stt: { provider: 'elevenlabs' }, tts: { provider: 'elevenlabs' } }, { test: false });
    assert.deepEqual([c.stt.base_url, c.stt.model, c.stt.key], ['https://api.elevenlabs.io', 'scribe_v2', 'elevenlabs']);
    assert.deepEqual(c.tts, { provider: 'elevenlabs', base_url: 'https://api.elevenlabs.io', model: 'eleven_multilingual_v2', key: 'elevenlabs', voice_id: null, output_format: 'opus_48000_64' });
  });

  it('распознавание и синтез — независимо: openai и elevenlabs вместе; OpenRouter — openai со своим адресом и ключом', () => {
    const c = parseConfig(
      {
        ...base,
        stt: { provider: 'openai', base_url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-transcribe', key: 'openrouter' },
        tts: { provider: 'elevenlabs', voice_id: 'v2' },
      },
      { test: false },
    );
    assert.deepEqual([c.stt.provider, c.stt.base_url, c.stt.model, c.stt.key], ['openai', 'https://openrouter.ai/api/v1', 'openai/gpt-4o-transcribe', 'openrouter']);
    assert.deepEqual([c.tts.provider, c.tts.key], ['elevenlabs', 'elevenlabs']);
  });

  it('неизвестный провайдер — ошибка по-русски с полем и вариантами', () => {
    const text = problems(() => parseConfig({ ...base, stt: { provider: 'whisper' }, tts: { provider: 7 } }, { test: false })).join('\n');
    assert.match(text, /^stt\.provider — неизвестный провайдер «whisper»: openai или elevenlabs$/m);
    assert.match(text, /^tts\.provider — неизвестный провайдер «7»: openai или elevenlabs$/m);
  });

  it('поле другого провайдера — подсказка; прежнее и новое имя вместе — ошибка; лишнее поле — ошибка; имя ключа проверено', () => {
    const text = problems(() =>
      parseConfig(
        {
          ...base,
          stt: { provider: 'openai', keyterms: ['Acme'] },
          tts: { provider: 'openai', voice_id: 'x', output_format: 'opus_48000_64' },
        },
        { test: false },
      ),
    ).join('\n');
    assert.match(text, /stt\.keyterms — нет такого поля у openai: у openai словарь — vocabulary/);
    assert.match(text, /tts\.voice_id — нет такого поля у openai: у openai голос — voice/);
    assert.match(text, /tts\.output_format — нет такого поля у openai/);
    const both = problems(() => parseConfig({ ...base, stt: { provider: 'elevenlabs', model: 'a', model_id: 'b' } }, { test: false })).join('\n');
    assert.match(both, /stt\.model_id — model_id и model — одно поле: оставь model/);
    const extra = problems(() => parseConfig({ ...base, tts: { provider: 'openai', speed: 2 } }, { test: false })).join('\n');
    assert.match(extra, /speed/);
    const key = problems(() => parseConfig({ ...base, stt: { key: 'мой ключ' } }, { test: false })).join('\n');
    assert.match(key, /stt\.key — имя ключа — латиница/);
    const fmt = problems(() => parseConfig({ ...base, tts: { provider: 'elevenlabs', output_format: 'mp3_44100_128' } }, { test: false })).join('\n');
    assert.match(fmt, /только Ogg\/Opus/);
  });

  it('адрес голоса — https; http только к 127.0.0.1 под тестом (ключ не уходит в открытую сеть)', () => {
    assert.match(problems(() => parseConfig({ ...base, stt: { base_url: 'http://api.openai.com/v1' } }, { test: false })).join(), /stt\.base_url — нужен https/);
    assert.equal(parseConfig({ ...base, tts: { base_url: 'http://127.0.0.1:9/v1' } }, { test: true }).tts.base_url, 'http://127.0.0.1:9/v1');
  });

  it('логин и ключ в адресе — ошибка: адрес пишется в журнал и doctor без маски; сам адрес в ошибку не попадает', () => {
    const secret = 'sk-or-v1-ДЕЛАЙ-ТАК-НЕ-НАДО-0123456789';
    const text = problems(() =>
      parseConfig(
        {
          ...base,
          telegram: { api_base: 'https://u:p4ss@api.telegram.org' },
          stt: { base_url: `https://user:${encodeURIComponent(secret)}@openrouter.ai/api/v1` },
          tts: { provider: 'elevenlabs', base_url: `https://${encodeURIComponent(secret)}@api.elevenlabs.io` },
        },
        { test: false },
      ),
    ).join('\n');
    assert.match(text, /^stt\.base_url — без логина и ключа в адресе: ключ — в связке ключей \(stt\.key\)$/m);
    assert.match(text, /^tts\.base_url — без логина и ключа в адресе: ключ — в связке ключей \(tts\.key\)$/m);
    assert.match(text, /^telegram\.api_base — без логина и ключа в адресе: токен бота — в связке ключей$/m);
    assert.ok(!text.includes('p4ss') && !text.includes(encodeURIComponent(secret)) && !text.includes('user'), text);
  });

  it('config ранних сборок без provider (тогда по умолчанию elevenlabs): подсказка ведёт и к provider: elevenlabs', () => {
    const text = problems(() => parseConfig({ ...base, stt: { keyterms: ['Acme'] }, tts: { voice_id: 'v1' } }, { test: false })).join('\n');
    assert.match(
      text,
      /^stt\.keyterms — нет такого поля у openai: у openai словарь — vocabulary; если это настройка elevenlabs — укажи provider: elevenlabs \(без provider — openai; в ранних сборках — elevenlabs\)$/m,
    );
    assert.match(text, /^tts\.voice_id — нет такого поля у openai: у openai голос — voice; если это настройка elevenlabs — укажи provider: elevenlabs/m);
    // provider: openai задан явно — подсказки про elevenlabs нет: владелец выбрал OpenAI.
    const explicit = problems(() => parseConfig({ ...base, stt: { provider: 'openai', keyterms: ['Acme'] } }, { test: false })).join('\n');
    assert.ok(!explicit.includes('укажи provider'), explicit);
    // С provider: elevenlabs тот же config читается (прежние имена полей).
    const c = parseConfig({ ...base, stt: { provider: 'elevenlabs', keyterms: ['Acme'] }, tts: { provider: 'elevenlabs', voice_id: 'v1' } }, { test: false });
    assert.deepEqual([c.stt.provider, c.stt.vocabulary, c.tts.provider], ['elevenlabs', ['Acme'], 'elevenlabs']);
  });
});

describe('rules.yaml', () => {
  it('пример из TECH-SPEC 5.1 читается как есть', () => {
    const { rules, missing } = loadRules(tmpFile('rules.yaml', SPEC_RULES));
    assert.equal(missing, false);
    assert.equal(rules.subjects[0]?.id, 'owner');
    assert.deepEqual(rules.subjects[0]?.transports, [{ network: 'telegram', address: '123456789' }]);
    assert.deepEqual(rules.chats[0], { chat: 'private', space: 'личное', role: DEFAULT_ROLE });
  });

  it('посылки (0.3.3): parcels: true у правила чата — читается и пишется; без него — как прежде', () => {
    const r = parseRules({ chats: [{ chat: 'private', space: 'личное', role: DEFAULT_ROLE, parcels: true }, { chat: -100500, space: 'семья', role: DEFAULT_ROLE }] });
    assert.equal(r.chats[0]?.parcels, true);
    assert.equal(r.chats[1]?.parcels, undefined);
    const dir = tmpDir('stg-rules-');
    const f = path.join(dir, 'rules.yaml');
    writeRules(f, r);
    const back = loadRules(f).rules;
    assert.deepEqual(back.chats[0], { chat: 'private', space: 'личное', role: DEFAULT_ROLE, parcels: true });
    assert.deepEqual(back.chats[1], { chat: -100500, space: 'семья', role: DEFAULT_ROLE });
    assert.ok(!fs.readFileSync(f, 'utf8').includes('parcels: false'), 'нет поля — не пишется');
  });

  it('номер без кавычек становится строкой', () => {
    const r = parseRules({ subjects: [{ id: 'a', who: 'guest', transports: [{ network: 'telegram', address: 42 }] }] });
    assert.equal(r.subjects[0]?.transports[0]?.address, '42');
  });

  it('повторы id и номера — ошибка', () => {
    const text = problems(() =>
      parseRules({
        subjects: [
          { id: 'a', who: 'x', transports: [{ network: 'telegram', address: '1' }] },
          { id: 'a', who: 'y', transports: [{ network: 'telegram', address: '1' }] },
        ],
      }),
    ).join('\n');
    assert.match(text, /субъект «a» уже есть/);
    assert.match(text, /уже принадлежит субъекту «a»/);
  });

  it('нет файла — правила по умолчанию; запись и чтение дают то же', () => {
    const dir = tmpDir('stg-rules-');
    const f = path.join(dir, 'rules.yaml');
    assert.equal(loadRules(f).missing, true);
    const def = defaultRules(123456789);
    writeRules(f, def);
    assert.deepEqual(loadRules(f).rules, def);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  });
});

describe('владелец задан в config.yaml (Ш-21)', () => {
  const config = parseConfig({ bot: 'b_bot', owner_id: 111, timezone: 'UTC' }, { test: false });

  it('владельца нет в правилах — он есть в действующих правилах', () => {
    const { rules, notes } = effectiveRules(config, { subjects: [], chats: [] });
    const owner = rules.subjects.find((s) => s.who === 'owner');
    assert.deepEqual(owner?.transports, [{ network: 'telegram', address: '111' }]);
    assert.ok(notes.length >= 1);
    assert.equal(rules.chats[0]?.role, DEFAULT_ROLE);
  });

  it('номер в правилах расходится — действует config.yaml; номер владельца снят с другого субъекта', () => {
    const { rules } = effectiveRules(config, {
      subjects: [
        { id: 'owner', who: 'owner', transports: [{ network: 'telegram', address: '999' }] },
        { id: 'p', who: 'guest', transports: [{ network: 'telegram', address: '111' }] },
      ],
      chats: [{ chat: 'private', space: 'личное', role: DEFAULT_ROLE }],
    });
    assert.deepEqual(rules.subjects.find((s) => s.id === 'owner')?.transports, [{ network: 'telegram', address: '111' }]);
    assert.deepEqual(rules.subjects.find((s) => s.id === 'p')?.transports, []);
  });

  it('в правилах нет лички — она добавлена: команды владельца идут только в ней (M5)', () => {
    const { rules, notes } = effectiveRules(config, {
      subjects: [{ id: 'owner', who: 'owner', transports: [{ network: 'telegram', address: '111' }] }],
      chats: [{ chat: -100500, space: 'работа', role: 'секретарь' }],
    });
    assert.deepEqual(rules.chats.map((c) => c.chat), ['private', -100500]);
    assert.ok(notes.some((n) => n.includes('нет лички')));
  });

  it('пустой owner_id — у владельца нет номера Telegram (первая настройка)', () => {
    const c = parseConfig({ bot: 'b_bot', owner_id: null, timezone: 'UTC' }, { test: false });
    const { rules } = effectiveRules(c, defaultRules(123));
    assert.deepEqual(rules.subjects.find((s) => s.who === 'owner')?.transports, []);
  });
});
