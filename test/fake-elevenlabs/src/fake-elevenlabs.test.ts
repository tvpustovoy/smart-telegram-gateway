// Подделки провайдеров голоса по договору (ACCEPTANCE §1) — диалекты ElevenLabs и OpenAI — и клиенты шлюза против них
// (stg-core: elevenlabs.ts, openai.ts за общим интерфейсом voice-provider.ts): поля запросов, ключ, ошибки и их вид,
// 429, зависание, контейнер синтеза; разбор Ogg/Opus своим кодом сверяется с ffprobe, если он есть.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  ElevenLabsSpeechToText,
  ElevenLabsTextToSpeech,
  OPENAI_PROMPT_MAX_CHARS,
  PROVIDER_ERROR_MAX_CHARS,
  OpenAiSpeechToText,
  OpenAiTextToSpeech,
  VoiceProviderError,
  createSpeechToText,
  createTextToSpeech,
  inspectOggOpus,
  oggPageCrc,
  parseConfig,
  sttVocabularyUse,
  vocabularyPrompt,
  vocabularyPromptTerms,
  voiceDurationSeconds,
  voiceProviderLabel,
  type SpeechToText,
  type TextToSpeech,
} from 'stg-core';
import { FakeElevenLabs, FakeOpenAiAudio, makeOggOpus, oggCrc, oggOpusDuration, type FakeVoiceServer, type VoiceDialect } from './index.js';

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

const KEY = 'test-voice-key-0001';

function form(fields: Record<string, string | string[]>, file: { name: string } | null = { name: 'v.ogg' }): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  if (file) f.append('file', new Blob([makeOggOpus(1)], { type: 'audio/ogg' }), file.name);
  return f;
}

describe('подделка ElevenLabs: договор', () => {
  it('распознавание: поля multipart записаны; расшифровка, ошибка, 429 с Retry-After, 401, 422 без model_id и файла', async () => {
    const f = await FakeElevenLabs.start({ apiKey: KEY, transcript: 'завтра первым делом позвонить' });
    try {
      const post = (key: string, body: FormData): Promise<Response> =>
        fetch(`${f.baseUrl}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': key }, body });
      const okForm = form({ model_id: 'scribe_v2', language_code: 'ru', keyterms: ['Acme', 'Борис'] });
      const ok = (await (await post(KEY, okForm)).json()) as { text: string; words: unknown[] };
      assert.equal(ok.text, 'завтра первым делом позвонить');
      assert.equal(ok.words.length, 4);
      assert.deepEqual(f.stt[0]?.vocabulary, ['Acme', 'Борис']);
      assert.equal(f.stt[0]?.language, 'ru');
      assert.ok((f.stt[0]?.file?.bytes ?? 0) > 0);
      assert.equal((await post('wrong-key', okForm)).status, 401);
      assert.equal(f.calls.at(-1)?.authorized, false);
      const r422 = await post(KEY, form({ language_code: 'ru' }, null));
      assert.equal(r422.status, 422);
      assert.deepEqual(((await r422.json()) as { detail: Array<{ loc: string[] }> }).detail.map((d) => d.loc[1]), ['model_id', 'file']);
      f.sttMode = 'error';
      assert.equal((await post(KEY, okForm)).status, 500);
      f.sttMode = 'rate_limited';
      const r429 = await post(KEY, okForm);
      assert.equal(r429.status, 429);
      assert.equal(r429.headers.get('retry-after'), '1');
      f.sttMode = 'hang';
      await assert.rejects(
        fetch(`${f.baseUrl}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': KEY }, body: okForm, signal: AbortSignal.timeout(200) }),
      );
    } finally {
      await f.stop();
    }
  });

  it('сценарий: режимы на очередные вызовы, затем общий', async () => {
    const f = await FakeElevenLabs.start({ apiKey: KEY });
    try {
      f.sttScript = ['error', 'rate_limited'];
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        codes.push((await fetch(`${f.baseUrl}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': KEY }, body: form({ model_id: 'scribe_v2' }) })).status);
      }
      assert.deepEqual(codes, [500, 429, 200]);
    } finally {
      await f.stop();
    }
  });

  it('синтез: Ogg/Opus заданной длительности при opus_*, иначе не Ogg; без text — 422', async () => {
    const f = await FakeElevenLabs.start({ apiKey: KEY, ttsSeconds: 4.2 });
    try {
      const post = (fmt: string, body: unknown): Promise<Response> =>
        fetch(`${f.baseUrl}/v1/text-to-speech/voice1?output_format=${fmt}`, {
          method: 'POST',
          headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const audio = Buffer.from(await (await post('opus_48000_64', { text: 'привет', model_id: 'eleven_multilingual_v2' })).arrayBuffer());
      assert.equal(audio.subarray(0, 4).toString('ascii'), 'OggS');
      assert.equal(oggOpusDuration(audio), 4.2);
      const { at: _at, fields: _fields, ...rec } = f.tts[0]!;
      assert.deepEqual(rec, { voice: 'voice1', format: 'opus_48000_64', model: 'eleven_multilingual_v2', text: 'привет', mode: 'ok' });
      const mp3 = Buffer.from(await (await post('mp3_44100_128', { text: 'привет' })).arrayBuffer());
      assert.notEqual(mp3.subarray(0, 4).toString('ascii'), 'OggS');
      assert.equal((await post('opus_48000_64', { model_id: 'x' })).status, 422);
    } finally {
      await f.stop();
    }
  });
});

describe('подделка OpenAI: договор', () => {
  it('распознавание: Bearer; file и model обязательны; расширение файла проверено; prompt и language записаны', async () => {
    const f = await FakeOpenAiAudio.start({ apiKey: KEY, transcript: 'купи хлеба' });
    try {
      const post = (auth: string | null, body: FormData): Promise<Response> =>
        fetch(`${f.baseUrl}/audio/transcriptions`, { method: 'POST', headers: auth ? { authorization: auth } : {}, body });
      const ok = await post(`Bearer ${KEY}`, form({ model: 'gpt-4o-transcribe', language: 'ru', prompt: 'Acme, Борис', response_format: 'json' }));
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { text: string }).text, 'купи хлеба');
      assert.deepEqual([f.stt[0]?.model, f.stt[0]?.language, f.stt[0]?.vocabulary, f.stt[0]?.file?.filename], ['gpt-4o-transcribe', 'ru', ['Acme', 'Борис'], 'v.ogg']);
      const text = await post(`Bearer ${KEY}`, form({ model: 'm', response_format: 'text' }));
      assert.equal(await text.text(), 'купи хлеба');
      // Ключ — только Bearer: xi-api-key или чужой ключ — 401 (в тексте — присланный ключ).
      const r401 = await post(`Bearer wrong-key-777`, form({ model: 'm' }));
      assert.equal(r401.status, 401);
      const e401 = ((await r401.json()) as { error: { code: string; message: string } }).error;
      assert.equal(e401.code, 'invalid_api_key');
      assert.match(e401.message, /wrong-key-777/);
      assert.equal((await post(null, form({ model: 'm' }))).status, 401);
      const noFile = await post(`Bearer ${KEY}`, form({ model: 'm' }, null));
      assert.equal(noFile.status, 400);
      assert.equal(((await noFile.json()) as { error: { param: string } }).error.param, 'file');
      const noModel = await post(`Bearer ${KEY}`, form({ language: 'ru' }));
      assert.equal(((await noModel.json()) as { error: { param: string } }).error.param, 'model');
      assert.equal((await post(`Bearer ${KEY}`, form({ model: 'm' }, { name: 'voice.bin' }))).status, 400, 'неизвестное расширение');
      f.sttScript = ['error', 'rate_limited', 'quota'];
      const codes = [];
      for (let i = 0; i < 3; i++) {
        const r = await post(`Bearer ${KEY}`, form({ model: 'm' }));
        codes.push([r.status, ((await r.json()) as { error: { code: string | null; type: string } }).error.code ?? 'null', r.headers.get('retry-after')]);
      }
      assert.deepEqual(codes, [
        [500, 'null', null],
        [429, 'rate_limit_exceeded', '1'],
        [429, 'insufficient_quota', null],
      ]);
    } finally {
      await f.stop();
    }
  });

  it('синтез: JSON model, input, voice; response_format opus — Ogg/Opus заданной длительности, иначе mp3; нет поля — 400', async () => {
    const f = await FakeOpenAiAudio.start({ apiKey: KEY, ttsSeconds: 2.6 });
    try {
      const post = (body: unknown): Promise<Response> =>
        fetch(`${f.baseUrl}/audio/speech`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const r = await post({ model: 'gpt-4o-mini-tts', input: 'привет', voice: 'alloy', response_format: 'opus', instructions: 'спокойно' });
      const audio = Buffer.from(await r.arrayBuffer());
      assert.equal(oggOpusDuration(audio), 2.6);
      const { at: _at, ...rec } = f.tts[0]!;
      assert.deepEqual(rec, {
        model: 'gpt-4o-mini-tts',
        voice: 'alloy',
        format: 'opus',
        text: 'привет',
        fields: { model: 'gpt-4o-mini-tts', input: 'привет', voice: 'alloy', response_format: 'opus', instructions: 'спокойно' },
        mode: 'ok',
      });
      const mp3 = Buffer.from(await (await post({ model: 'm', input: 'привет', voice: 'alloy' })).arrayBuffer());
      assert.notEqual(mp3.subarray(0, 4).toString('ascii'), 'OggS');
      for (const k of ['model', 'input', 'voice']) {
        const body: Record<string, string> = { model: 'm', input: 'x', voice: 'alloy', response_format: 'opus' };
        delete body[k];
        const bad = await post(body);
        assert.equal(bad.status, 400, k);
        assert.equal(((await bad.json()) as { error: { param: string } }).error.param, k);
      }
    } finally {
      await f.stop();
    }
  });
});

interface Dialect {
  dialect: VoiceDialect;
  start(opts: { apiKey: string; transcript?: string; sttMode?: 'hang'; ttsSeconds?: number }): Promise<FakeVoiceServer>;
  stt(base: string): SpeechToText;
  tts(base: string): TextToSpeech;
  /** Что ушло провайдеру — как он записал поля. */
  fields(f: FakeVoiceServer): Record<string, unknown>;
}

const DIALECTS: Dialect[] = [
  {
    dialect: 'elevenlabs',
    start: (o) => FakeElevenLabs.start(o),
    stt: (base) => new ElevenLabsSpeechToText({ baseUrl: base, model: 'scribe_v2' }),
    tts: (base) => new ElevenLabsTextToSpeech({ baseUrl: base, model: 'eleven_multilingual_v2', outputFormat: 'opus_48000_64' }),
    fields: (f) => ({ tag_audio_events: f.stt[0]?.fields.tag_audio_events, keyterms: f.stt[0]?.fields.keyterms }),
  },
  {
    dialect: 'openai',
    start: (o) => FakeOpenAiAudio.start(o),
    stt: (base) => new OpenAiSpeechToText({ baseUrl: base, model: 'gpt-4o-transcribe' }),
    tts: (base) => new OpenAiTextToSpeech({ baseUrl: base, model: 'gpt-4o-mini-tts' }),
    fields: (f) => ({ prompt: f.stt[0]?.fields.prompt, response_format: f.stt[0]?.fields.response_format }),
  },
];

const EXPECTED_FIELDS: Record<VoiceDialect, Record<string, unknown>> = {
  elevenlabs: { tag_audio_events: ['false'], keyterms: ['Acme', 'Борис', 'Kubernetes'] },
  openai: { prompt: ['Acme, Борис, Kubernetes'], response_format: ['json'] },
};

async function refusal(p: Promise<unknown>): Promise<VoiceProviderError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof VoiceProviderError, String(e));
    return e;
  }
  throw new Error('отказа не было');
}

for (const d of DIALECTS) {
  describe(`клиент ${d.dialect} шлюза против подделки (stg-core, общий интерфейс)`, () => {
    const call = (key = KEY, ms = 5000) => ({ key, signal: AbortSignal.timeout(ms) });

    it('распознавание: модель, язык явно, словарь, файл .ogg; расшифровка — пробелы сжаты', async () => {
      const f = await d.start({ apiKey: KEY, transcript: '  купи   хлеба  ' });
      try {
        const r = await d.stt(f.baseUrl).transcribe(makeOggOpus(2), 'audio/ogg', { language: 'ru', vocabulary: ['Acme', 'Борис', 'Kubernetes'], filename: '42.ogg' }, call());
        assert.equal(r.text, 'купи хлеба');
        const rec = f.stt[0]!;
        assert.deepEqual(
          { model: rec.model, language: rec.language, vocabulary: rec.vocabulary, bytes: rec.file?.bytes, name: rec.file?.filename, type: rec.file?.type },
          { model: d.dialect === 'openai' ? 'gpt-4o-transcribe' : 'scribe_v2', language: 'ru', vocabulary: ['Acme', 'Борис', 'Kubernetes'], bytes: makeOggOpus(2).length, name: '42.ogg', type: 'audio/ogg' },
        );
        assert.deepEqual(d.fields(f), EXPECTED_FIELDS[d.dialect]);
        assert.ok(f.calls.every((c) => c.authorized), 'ключ — как положено диалекту');
      } finally {
        await f.stop();
      }
    });

    it('отказы общего вида: 500 — server, повтор; 429 — rate, Retry-After; 401 — auth, без повтора; пустая — bad_output; ключ в тексте не появляется', async () => {
      const f = await d.start({ apiKey: KEY });
      try {
        const stt = d.stt(f.baseUrl);
        const run = (key = KEY): Promise<unknown> => stt.transcribe(makeOggOpus(1), 'audio/ogg', { language: 'ru', vocabulary: [] }, call(key));
        f.sttMode = 'error';
        let e = await refusal(run());
        assert.deepEqual([e.what, e.provider, e.status, e.kind, e.code, e.retryable], ['stt', d.dialect, 500, 'server', f.codes.server, true]);
        f.sttMode = 'rate_limited';
        e = await refusal(run());
        assert.deepEqual([e.status, e.kind, e.code, e.retryable, e.retryAfterMs], [429, 'rate', f.codes.rate, true, 1000]);
        f.sttMode = 'empty';
        e = await refusal(run());
        assert.deepEqual([e.kind, e.code, e.retryable], ['bad_output', 'empty', false]);
        f.sttMode = 'ok';
        e = await refusal(run('wrong-key-12345'));
        assert.deepEqual([e.status, e.kind, e.code, e.retryable], [401, 'auth', f.codes.auth, false]);
        assert.ok(!e.message.includes('wrong-key-12345'), e.message);
      } finally {
        await f.stop();
      }
    });

    it('ключ в тексте ошибки после 300-го знака — ни целиком, ни началом: маска идёт до обрезки (распознавание и синтез)', async () => {
      const f = await d.start({ apiKey: KEY });
      try {
        // Ключ длиной как у настоящих (70 знаков); провайдер вернул присланный ключ в тексте 401 после N знаков.
        const secret = `sk-proj-${'Q7wZ'.repeat(15)}k1`;
        const stt = d.stt(f.baseUrl);
        const tts = d.tts(f.baseUrl);
        const runs = [
          (): Promise<unknown> => stt.transcribe(makeOggOpus(1), 'audio/ogg', { language: 'ru', vocabulary: [] }, call(secret)),
          (): Promise<unknown> => tts.synthesize('привет', { voice: 'v' }, call(secret)),
        ];
        for (const pad of [0, 200, 250, 260, 270, 280, 290, 300, 320, 2000]) {
          f.authEcho = pad;
          for (const run of runs) {
            const e = await refusal(run());
            assert.deepEqual([e.status, e.kind, e.retryable], [401, 'auth', false]);
            assert.ok(e.message.length <= PROVIDER_ERROR_MAX_CHARS, `${pad}: ${e.message.length}`);
            assert.ok(!e.message.includes(secret.slice(0, 4)) && !e.code.includes(secret.slice(0, 4)), `${pad}: ${e.message}`);
            if (pad <= 200) assert.match(e.message, /key=<секрет>/, 'ключ вырезан, текст ошибки виден');
          }
        }
      } finally {
        await f.stop();
      }
    });

    it('зависание: отмена сигналом — network/timeout, повтор', async () => {
      const f = await d.start({ apiKey: KEY, sttMode: 'hang' });
      try {
        const e = await refusal(d.stt(f.baseUrl).transcribe(makeOggOpus(1), 'audio/ogg', { language: 'ru', vocabulary: [] }, call(KEY, 300)));
        assert.deepEqual([e.kind, e.code, e.retryable], ['network', 'timeout', true]);
      } finally {
        await f.stop();
      }
    });

    it('синтез: Ogg/Opus разобран своим кодом, длительность для sendVoice; не Ogg — bad_output/not_ogg; длиннее предела — bad_input/too_long', async () => {
      const f = await d.start({ apiKey: KEY, ttsSeconds: 7.3 });
      try {
        const tts = d.tts(f.baseUrl);
        const r = await tts.synthesize('привет', { voice: 'v 1' }, call());
        assert.ok(Math.abs(r.info.seconds - 7.3) < 0.01);
        assert.equal(voiceDurationSeconds(r.info.seconds), 7);
        assert.deepEqual([f.tts[0]?.voice, f.tts[0]?.text, f.tts[0]?.format], ['v 1', 'привет', d.dialect === 'openai' ? 'opus' : 'opus_48000_64']);
        f.ttsMode = 'not_ogg';
        let e = await refusal(tts.synthesize('привет', { voice: 'v 1' }, call()));
        assert.deepEqual([e.what, e.kind, e.code, e.retryable], ['tts', 'bad_output', 'not_ogg', false]);
        assert.match(e.message, /content-type audio\/mpeg, начало 494433/);
        const calls = f.tts.length;
        e = await refusal(tts.synthesize('я'.repeat(tts.maxChars + 1), { voice: 'v 1' }, call()));
        assert.deepEqual([e.kind, e.code, e.retryable], ['bad_input', 'too_long', false]);
        assert.equal(f.tts.length, calls, 'длинный текст провайдеру не ушёл');
      } finally {
        await f.stop();
      }
    });

    it('провайдер по config.yaml: фабрика, адрес и модель в info', () => {
      const c = parseConfig({ bot: 'b_bot', timezone: 'UTC', stt: { provider: d.dialect }, tts: { provider: d.dialect } }, { test: false });
      const stt = createSpeechToText(c.stt);
      const tts = createTextToSpeech(c.tts);
      assert.equal(stt.info.provider, d.dialect);
      assert.equal(tts.info.provider, d.dialect);
      assert.equal(voiceProviderLabel(stt.info), d.dialect === 'openai' ? 'OpenAI' : 'ElevenLabs');
      assert.equal(tts.maxChars, d.dialect === 'openai' ? 4096 : 10_000);
    });
  });
}

describe('клиент openai: особенное', () => {
  it('429 insufficient_quota — не повторять; instructions — только если заданы; OpenRouter — тот же клиент по адресу', async () => {
    const f = await FakeOpenAiAudio.start({ apiKey: KEY });
    try {
      f.sttMode = 'quota';
      const e = await refusal(new OpenAiSpeechToText({ baseUrl: f.baseUrl, model: 'm' }).transcribe(makeOggOpus(1), 'audio/ogg', { language: 'ru', vocabulary: [] }, { key: KEY, signal: AbortSignal.timeout(5000) }));
      assert.deepEqual([e.status, e.kind, e.code, e.retryable], [429, 'rate', 'insufficient_quota', false]);
      await new OpenAiTextToSpeech({ baseUrl: f.baseUrl, model: 'gpt-4o-mini-tts' }).synthesize('a', { voice: 'alloy' }, { key: KEY, signal: AbortSignal.timeout(5000) });
      await new OpenAiTextToSpeech({ baseUrl: f.baseUrl, model: 'gpt-4o-mini-tts', instructions: 'по-деловому' }).synthesize('b', { voice: 'alloy' }, { key: KEY, signal: AbortSignal.timeout(5000) });
      assert.equal('instructions' in f.tts[0]!.fields, false);
      assert.equal(f.tts[1]!.fields.instructions, 'по-деловому');
      assert.equal(voiceProviderLabel({ provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }), 'OpenRouter');
      assert.equal(voiceProviderLabel({ provider: 'openai', baseUrl: f.baseUrl }), `OpenAI-совместимый (${new URL(f.baseUrl).host})`);
    } finally {
      await f.stop();
    }
  });

  it('словарь в prompt — через запятую, целыми терминами, не длиннее предела; сколько уходит — видно', () => {
    assert.equal(vocabularyPrompt([]), '');
    assert.equal(vocabularyPrompt(['Acme', 'Борис']), 'Acme, Борис');
    const many = Array.from({ length: 300 }, (_, i) => `термин${i}`);
    const p = vocabularyPrompt(many);
    assert.ok(p.length <= OPENAI_PROMPT_MAX_CHARS && p.length > OPENAI_PROMPT_MAX_CHARS - 20, String(p.length));
    assert.ok(p.split(', ').every((t, i) => t === many[i]), 'термины целые, по порядку');
    const sent = vocabularyPromptTerms(many).length;
    assert.equal(sent, p.split(', ').length);
    // «статус», doctor и stt_config говорят, сколько уходит: у openai — K из N; у elevenlabs уходят все, но больше 100 — медленно.
    const base = { bot: 'b_bot', timezone: 'UTC' };
    const o = sttVocabularyUse(parseConfig({ ...base, stt: { vocabulary: many } }, { test: false }).stt);
    assert.deepEqual(o, { terms: 300, sent, slow: false, note: `в prompt уходит ${sent} из 300 терминов: предел ${OPENAI_PROMPT_MAX_CHARS} знаков` });
    assert.deepEqual(sttVocabularyUse(parseConfig({ ...base, stt: { vocabulary: ['Acme'] } }, { test: false }).stt), { terms: 1, sent: 1, slow: false, note: null });
    const el = sttVocabularyUse(parseConfig({ ...base, stt: { provider: 'elevenlabs', vocabulary: many } }, { test: false }).stt);
    assert.deepEqual(el, { terms: 300, sent: 300, slow: true, note: 'больше 100 — запрос не быстрее 20 с' });
  });
});

describe('Ogg/Opus: образец и разбор', () => {
  it('образец Ogg: контрольные суммы страниц верны', () => {
    const buf = makeOggOpus(1);
    let pos = 0;
    let pages = 0;
    while (pos < buf.length) {
      const segs = buf[pos + 26] ?? 0;
      let size = 0;
      for (let i = 0; i < segs; i++) size += buf[pos + 27 + i] ?? 0;
      const end = pos + 27 + segs + size;
      const pageBuf = Buffer.from(buf.subarray(pos, end));
      const crc = pageBuf.readUInt32LE(22);
      pageBuf.writeUInt32LE(0, 22);
      assert.equal(oggCrc(pageBuf), crc);
      assert.equal(oggPageCrc(pageBuf), crc);
      pos = end;
      pages++;
    }
    assert.equal(pages, 3);
  });

  it('ffprobe (если есть) видит ogg/opus той же длительности', (t) => {
    const probe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      t.skip('ffprobe не найден');
      return;
    }
    const file = path.join(tmpDir('stg-ogg-'), 'v.ogg');
    fs.writeFileSync(file, makeOggOpus(2.5));
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_name', '-of', 'json', file], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const info = JSON.parse(r.stdout) as { format: { format_name: string; duration: string }; streams: Array<{ codec_name: string }> };
    assert.equal(info.format.format_name, 'ogg');
    assert.equal(info.streams[0]?.codec_name, 'opus');
    assert.ok(Math.abs(Number(info.format.duration) - 2.5) < 0.05, info.format.duration);
  });

  it('разбор Ogg/Opus: битая страница, не Opus, обрезанный файл — отказ с причиной', () => {
    const good = makeOggOpus(2);
    assert.ok(inspectOggOpus(good).ok);
    const bad = Buffer.from(good);
    bad[bad.length - 5] = (bad[bad.length - 5]! + 1) & 0xff;
    const r1 = inspectOggOpus(bad);
    assert.ok(!r1.ok && /контрольная сумма/.test(r1.reason));
    const r2 = inspectOggOpus(good.subarray(0, good.length - 10));
    assert.ok(!r2.ok && /обрезанная/.test(r2.reason));
    const r3 = inspectOggOpus(Buffer.from('ID3\x04 not ogg at all......................', 'latin1'));
    assert.ok(!r3.ok && /не Ogg/.test(r3.reason));
  });
});
