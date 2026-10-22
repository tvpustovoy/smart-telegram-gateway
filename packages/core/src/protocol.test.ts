import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  FrameDecoder,
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  MAX_MEDIA_FRAME_BYTES,
  MAX_REPLY_TEXT,
  MediaResultSchema,
  PROTOCOL_VERSION,
  RuleChangeSchema,
  SendFileResultSchema,
  encodeFrame,
  parseAdapterLine,
  parseGatewayLine,
  type AdapterMessage,
} from './protocol.js';

function ok(line: string): AdapterMessage {
  const r = parseAdapterLine(line);
  assert.ok(r.ok, r.ok ? '' : r.text);
  return r.message;
}

function bad(line: string): { text: string; req_id: string | null } {
  const r = parseAdapterLine(line);
  assert.ok(!r.ok, 'ожидался bad_request');
  assert.equal(r.code, 'bad_request');
  return { text: r.text, req_id: r.req_id };
}

describe('протокол: переходник → шлюз (5.10)', () => {
  it('пример из 5.10: hello, done, delivered, reply', () => {
    const hello = ok(
      JSON.stringify({ type: 'hello', req_id: 'r1', adapter: 'stg-channel', version: PROTOCOL_VERSION, role: 'adapter', session_hint: { cwd: '/x', pid: 42 } }),
    );
    assert.equal(hello.type, 'hello');
    assert.equal(ok(JSON.stringify({ type: 'done', req_id: 'r2', seqs: [1] })).type, 'done');
    assert.equal(ok(JSON.stringify({ type: 'delivered', req_id: 'r3', seq: 118 })).type, 'delivered');
    const reply = ok(JSON.stringify({ type: 'reply', req_id: 'r4', seq: 118, text: 'Записал', turn: 7 }));
    assert.equal(reply.type === 'reply' && reply.voice, false);
    const own = ok(JSON.stringify({ type: 'reply', req_id: 'r5', seq: null, text: 'сам', voice: true, turn: 7 }));
    assert.equal(own.type === 'reply' && own.seq, null);
  });

  it('episode, episode_summary, where, rule, ping, pong', () => {
    assert.equal(ok(JSON.stringify({ type: 'episode', req_id: 'a', action: 'name', topic: 'Задачи на завтра' })).type, 'episode');
    assert.equal(ok(JSON.stringify({ type: 'episode', req_id: 'a', action: 'new', topic: 'Т', reason: 'сменилась тема' })).type, 'episode');
    assert.equal(ok(JSON.stringify({ type: 'episode_summary', req_id: 'b', episode_id: 42, text: 'итог' })).type, 'episode_summary');
    assert.equal(ok(JSON.stringify({ type: 'where', req_id: 'c' })).type, 'where');
    assert.equal(
      ok(JSON.stringify({ type: 'rule', req_id: 'd', change: [{ op: 'remove', target: 'subject', id: 'petya' }] })).type,
      'rule',
    );
    assert.equal(ok('{"type":"ping"}').type, 'ping');
    assert.equal(ok('{"type":"pong"}').type, 'pong');
  });

  it('deferred_retry (5.3, M3): update_id — целое; лишнее поле — bad_request', () => {
    const m = ok(JSON.stringify({ type: 'deferred_retry', req_id: 'cli-req', update_id: 123 }));
    assert.equal(m.type === 'deferred_retry' && m.update_id, 123);
    bad(JSON.stringify({ type: 'deferred_retry', req_id: 'x', update_id: 'abc' }));
    bad(JSON.stringify({ type: 'deferred_retry', req_id: 'x', update_id: 1, force: true }));
  });

  it('role в episode — bad_request (A3.19, A5.7)', () => {
    const r = bad(JSON.stringify({ type: 'episode', req_id: 'e1', action: 'new', topic: 'Т', role: 'юрист' }));
    assert.equal(r.req_id, 'e1');
    assert.match(r.text, /role/);
  });

  it('неизвестный type, не JSON, не объект, лишнее поле — bad_request', () => {
    assert.match(bad('{"type":"launch","req_id":"x"}').text, /неизвестный type/);
    assert.equal(bad('{"type":"launch","req_id":"x"}').req_id, 'x');
    assert.match(bad('не json').text, /не JSON/);
    assert.match(bad('[1,2]').text, /не объект/);
    assert.match(bad(JSON.stringify({ type: 'where', req_id: 'w', extra: 1 })).text, /extra/);
    bad(JSON.stringify({ type: 'done', req_id: 'd', seqs: [] }));
    bad(JSON.stringify({ type: 'reply', req_id: 'r', seq: 1, text: 'x' }));
    bad(JSON.stringify({ type: 'hello', req_id: 'h', adapter: 'a', version: 1, role: 'boss' }));
  });

  it('кадр больше 1 МБ — bad_request', () => {
    const big = JSON.stringify({ type: 'reply', req_id: 'r', seq: 1, text: 'я'.repeat(MAX_FRAME_BYTES / 2), turn: 1 });
    assert.match(bad(big).text, /1 МБ/);
  });

  it('изменение правил: поля субъекта и чата (5.9)', () => {
    assert.ok(RuleChangeSchema.safeParse([{ op: 'set', target: 'chat', id: 'private', field: 'role', value: 'юрист' }]).success);
    assert.ok(
      RuleChangeSchema.safeParse([
        { op: 'add', target: 'subject', id: 'mama', value: { who: 'family', transports: [{ network: 'telegram', address: '5' }] } },
      ]).success,
    );
    assert.ok(!RuleChangeSchema.safeParse([{ op: 'set', target: 'chat', id: 'private', field: 'who', value: 'x' }]).success);
    assert.ok(!RuleChangeSchema.safeParse([{ op: 'remove', target: 'subject', id: 'x', field: 'who' }]).success);
    assert.ok(!RuleChangeSchema.safeParse([{ op: 'add', target: 'chat', id: '5', value: { space: 'a', extra: 1 } }]).success);
    assert.ok(!RuleChangeSchema.safeParse([]).success);
  });
});

describe('протокол: шлюз → переходник', () => {
  it('welcome, event, mode, ack, error, where_result читаются; лишние поля не мешают', () => {
    const lines = [
      { type: 'welcome', req_id: 'r1', lease_id: 'L1', mode: 'running', turn: 7 },
      {
        type: 'event',
        seq: 118,
        kind: 'text',
        trust: 'owner',
        mixed: false,
        text: 'завтра первым делом',
        transcript: null,
        attachments: [],
        forward: null,
        reply_to: { kind: 'agent', event_seq: 100, excerpt: 'Записал', episode_topic: 'Задачи' },
        edit_of: null,
        chat: { id: 123, kind: 'private' },
        subject: { id: 'owner', who: 'owner' },
        episode: { id: 42, topic: 'Новая тема', role: 'личный ассистент', new: false },
        redelivery: false,
        future_field: 1,
      },
      { type: 'event', seq: 1, kind: 'probe', trust: null, mixed: false, text: null, transcript: null, attachments: [], forward: null, reply_to: null, edit_of: null, chat: null, subject: null, episode: null, redelivery: false },
      { type: 'mode', state: 'stopped', turn: 8 },
      { type: 'ack', req_id: 'r4', result: 'queued' },
      { type: 'error', req_id: null, code: 'bad_request', text: 'кадр — не JSON' },
      { type: 'error', req_id: 'h', code: 'busy', text: 'занято', holder: 'stg-channel', since: 1 },
      { type: 'where_result', req_id: 'w', text: 'Новая тема · Личный ассистент' },
      { type: 'ping' },
    ];
    for (const l of lines) {
      const r = parseGatewayLine(JSON.stringify(l));
      assert.ok(r.ok, r.ok ? '' : `${l.type}: ${r.text}`);
    }
    const r = parseGatewayLine(JSON.stringify({ type: 'error', req_id: 'x', code: 'nope', text: '' }));
    assert.ok(!r.ok);
  });
});

describe('протокол: кадры', () => {
  it('encodeFrame — строка с \\n; больше 1 МБ — ошибка', () => {
    assert.equal(encodeFrame({ type: 'ping' }), '{"type":"ping"}\n');
    assert.throws(() => encodeFrame({ type: 'x', t: 'a'.repeat(MAX_FRAME_BYTES) }), FrameTooLargeError);
  });

  it('декодер собирает кадр из кусков, в том числе знак UTF-8 на границе', () => {
    const d = new FrameDecoder();
    const buf = Buffer.from('{"text":"ёж 👀"}\n{"type":"ping"}\n', 'utf8');
    const out = [];
    for (let i = 0; i < buf.length; i++) out.push(...d.push(buf.subarray(i, i + 1)));
    assert.deepEqual(out, [
      { kind: 'line', line: '{"text":"ёж 👀"}' },
      { kind: 'line', line: '{"type":"ping"}' },
    ]);
  });

  it('кадр больше предела отбрасывается до \\n, следующий кадр читается', () => {
    const d = new FrameDecoder(64);
    const out = [...d.push(Buffer.from('x'.repeat(50))), ...d.push(Buffer.from('y'.repeat(50) + '\n{"type":"ping"}\n'))];
    assert.equal(out.length, 2);
    assert.equal(out[0]?.kind, 'oversize');
    assert.deepEqual(out[1], { kind: 'line', line: '{"type":"ping"}' });
  });
});

describe('протокол: 0.3.2 — тождество процесса в hello (R-4) и чьи слова в reply (P-26)', () => {
  it('hello: instance_id (до 64 знаков [A-Za-z0-9_-]) и prev_lease — необязательные; без них — как раньше; плохой instance_id — bad_request', () => {
    const base = { type: 'hello', req_id: 'h', adapter: 'stg-channel', version: PROTOCOL_VERSION, role: 'adapter', session_hint: { cwd: '/x', pid: 1 } };
    const h = ok(JSON.stringify({ ...base, instance_id: 'Ab3_-xyz12345678', prev_lease: 'L-1' }));
    assert.ok(h.type === 'hello' && h.instance_id === 'Ab3_-xyz12345678' && h.prev_lease === 'L-1');
    const legacy = ok(JSON.stringify(base));
    assert.ok(legacy.type === 'hello' && legacy.instance_id === undefined && legacy.prev_lease === undefined);
    bad(JSON.stringify({ ...base, instance_id: 'коротко' }));
    bad(JSON.stringify({ ...base, instance_id: 'a b c d e f g h' }));
    bad(JSON.stringify({ ...base, prev_lease: '' }));
  });

  it('reply.from — строка до 256 (имя проверяет шлюз: до 64 знаков, без знаков шлюза); не строка — bad_request', () => {
    const r = ok(JSON.stringify({ type: 'reply', req_id: 'r', seq: 1, text: 'да', turn: 0, from: 'Исследователь' }));
    assert.ok(r.type === 'reply' && r.from === 'Исследователь');
    bad(JSON.stringify({ type: 'reply', req_id: 'r', seq: 1, text: 'да', turn: 0, from: 7 }));
    bad(JSON.stringify({ type: 'reply', req_id: 'r', seq: 1, text: 'да', turn: 0, from: 'я'.repeat(257) }));
  });
});

describe('протокол: предел текста ответа', () => {
  it(`reply.text до ${MAX_REPLY_TEXT} единиц — принят; длиннее — bad_request`, () => {
    ok(JSON.stringify({ type: 'reply', req_id: 'r', seq: 1, text: 'я'.repeat(MAX_REPLY_TEXT), turn: 0 }));
    bad(JSON.stringify({ type: 'reply', req_id: 'r', seq: 1, text: 'я'.repeat(MAX_REPLY_TEXT + 1), turn: 0 }));
  });
});

describe('протокол: картинки (0.3) — media и совместимость с прежним каналом', () => {
  it('media {req_id, seq} — запрос переходника; без seq и с лишним полем — bad_request', () => {
    const m = ok(JSON.stringify({ type: 'media', req_id: 'm1', seq: 59 }));
    assert.deepEqual(m, { type: 'media', req_id: 'm1', seq: 59 });
    bad(JSON.stringify({ type: 'media', req_id: 'm2' }));
    bad(JSON.stringify({ type: 'media', req_id: 'm3', seq: 59, path: '/etc/passwd' }));
    bad(JSON.stringify({ type: 'media', req_id: 'm4', seq: 0 }));
  });

  it('ответ на media: картинка в base64 до 8 МБ кадром; обычный кадр — по-прежнему до 1 МБ', () => {
    const data = Buffer.alloc(5 * 1024 * 1024, 7).toString('base64');
    const result = { seq: 59, what: 'photo', image: { mime: 'image/jpeg', data, width: 1280, height: 960, bytes: 5 * 1024 * 1024, shown: 'original' }, note: null };
    assert.throws(() => encodeFrame({ type: 'ack', req_id: 'm1', result }), FrameTooLargeError);
    const line = encodeFrame({ type: 'ack', req_id: 'm1', result }, MAX_MEDIA_FRAME_BYTES);
    const d = new FrameDecoder(MAX_MEDIA_FRAME_BYTES);
    const frames = d.push(Buffer.from(line, 'utf8'));
    assert.equal(frames[0]?.kind, 'line');
    const p = parseGatewayLine((frames[0] as { line: string }).line);
    assert.ok(p.ok && p.message.type === 'ack');
    assert.ok(MediaResultSchema.safeParse(p.message.result).success);
    // Ничего не показать — image: null и пометка; незнакомое значение what не ломает разбор.
    assert.ok(MediaResultSchema.safeParse({ seq: 1, what: 'sticker', image: null, note: 'слишком большое для просмотра: 7,2 МБ' }).success);
    assert.ok(!MediaResultSchema.safeParse({ seq: 1, what: 'photo' }).success);
  });

  it('прежний канал (схема события до 0.3) читает событие нового шлюза: media и audio.source отбрасываются', () => {
    // Копия схемы события 0.2 (protocol.ts на 5b32c9c) — как её знает переходник, развёрнутый до 0.3.
    const trust = z.enum(['owner', 'untrusted', 'owner_forward']);
    const OldEvent = z.object({
      type: z.literal('event'),
      seq: z.int().positive(),
      kind: z.enum(['text', 'voice', 'photo', 'document', 'edit', 'command', 'callback', 'closed_topic', 'episode_closed', 'episode_reopened', 'probe']),
      trust: trust.nullable(),
      mixed: z.boolean(),
      text: z.string().nullable(),
      transcript: z.string().nullable(),
      attachments: z.array(z.object({ kind: z.enum(['quote', 'external_reply', 'via_bot', 'photo', 'document', 'voice']), trust })),
      forward: z.object({ origin_type: z.enum(['user', 'hidden_user', 'chat', 'channel']), from_name: z.string().nullable() }).nullable(),
      reply_to: z.object({ kind: z.enum(['agent', 'receipt', 'service', 'owner', 'unknown']) }).nullable(),
      edit_of: z.int().positive().nullable(),
      chat: z.object({ id: z.int(), kind: z.enum(['private', 'group', 'supergroup', 'channel']) }).nullable(),
      subject: z.object({ id: z.string(), who: z.string() }).nullable(),
      episode: z.object({ id: z.int().positive(), topic: z.string(), role: z.string(), new: z.boolean() }).nullable(),
      redelivery: z.boolean(),
      code: z.string().optional(),
      audio: z
        .object({ name: z.string(), seconds: z.number().nonnegative().nullable(), state: z.enum(['transcribed', 'too_long', 'too_big', 'failed']), max_minutes: z.int().positive() })
        .optional(),
    });
    const common = { type: 'event', mixed: false, forward: null, reply_to: null, edit_of: null, chat: { id: 111, kind: 'private' }, subject: { id: 'owner', who: 'owner' }, episode: { id: 9, topic: 'т', role: 'р', new: false }, redelivery: false };
    const frames = [
      // Фото: подсказка media.
      { ...common, seq: 59, kind: 'photo', trust: 'owner', mixed: true, text: null, transcript: null, attachments: [{ kind: 'photo', trust: 'untrusted' }], media: { what: 'photo' } },
      // Свой кружок: слово владельца, звук — расшифровка, кадр.
      {
        ...common,
        seq: 76,
        kind: 'document',
        trust: 'owner',
        text: null,
        transcript: 'это кружок',
        attachments: [{ kind: 'document', trust: 'owner' }],
        audio: { name: 'кружок', seconds: 42, state: 'transcribed', max_minutes: 15, source: 'video_note' },
        media: { what: 'video_note', frame: true },
      },
    ];
    for (const f of frames) {
      const r = OldEvent.safeParse(JSON.parse(JSON.stringify(f)));
      assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues));
      assert.ok(!('media' in r.data), 'media прежний канал не видит');
      const n = parseGatewayLine(JSON.stringify(f));
      assert.ok(n.ok && n.message.type === 'event' && n.message.media?.what === f.media.what, 'новый канал видит подсказку');
    }
  });
});

describe('протокол: посылки (0.3.3) — send_file', () => {
  it('send_file {req_id, path, seq|null, turn}; caption, from, target, idem — необязательные; лишнее поле и плохая цель — bad_request', () => {
    const m = ok(JSON.stringify({ type: 'send_file', req_id: 'f1', path: 'отчёт/report.html', seq: 12, turn: 3 }));
    assert.deepEqual(m, { type: 'send_file', req_id: 'f1', path: 'отчёт/report.html', seq: 12, turn: 3 });
    const full = ok(JSON.stringify({ type: 'send_file', req_id: 'f2', path: '/x/parcels/a/b.md', seq: null, turn: 0, caption: '**итог**', from: 'Исследователь', target: 'telegram', idem: 'k_1' }));
    assert.equal(full.type === 'send_file' && full.caption, '**итог**');
    bad(JSON.stringify({ type: 'send_file', req_id: 'f3', seq: null, turn: 0 }));
    bad(JSON.stringify({ type: 'send_file', req_id: 'f4', path: '', seq: null, turn: 0 }));
    bad(JSON.stringify({ type: 'send_file', req_id: 'f5', path: 'a/b', seq: null, turn: 0, mode: 'raw' }));
    bad(JSON.stringify({ type: 'send_file', req_id: 'f6', path: 'a/b', seq: null, turn: 0, target: 'Web Site' }));
    bad(JSON.stringify({ type: 'send_file', req_id: 'f7', path: 'a/b', turn: 0 }));
  });

  it('ответ на send_file терпим: новое поле не ломает прежний канал; отказ — только status', () => {
    const r = SendFileResultSchema.safeParse({ status: 'queued', delivery: 5, parcel: 'отчёт', file: 'report.html', bytes: 10, version: 'abcd1234', sent_before: 0, updated: true, where: 'в чате Telegram', url_next: 'x' });
    assert.ok(r.success && r.data.updated === true && r.data.delivery === 5);
    assert.ok(SendFileResultSchema.safeParse({ status: 'dropped_stopped' }).success);
  });
});

describe('протокол: реакция владельца (0.3.4) — кадр вида text с полем reaction', () => {
  // Кадр, который шлюз 0.3.4 шлёт по событию базы вида reaction (adapter.ts, frame).
  const frame = {
    type: 'event',
    seq: 15,
    kind: 'text',
    trust: 'owner',
    mixed: false,
    text: 'Реакция на твой ответ к № 12: 👍 — твой ответ: «Да, вижу»',
    transcript: null,
    attachments: [],
    forward: null,
    reply_to: null,
    edit_of: null,
    chat: { id: 111, kind: 'private' },
    subject: { id: 'owner', who: 'owner' },
    episode: { id: 9, topic: 'т', role: 'р', new: false },
    redelivery: false,
    reaction: { to_seq: 12, emoji: ['👍'], old: [], excerpt: 'Да, вижу' },
  };

  it('новый канал видит поле reaction; снятие (emoji пуст) и ответ по своей инициативе (to_seq null) — тоже', () => {
    const n = parseGatewayLine(JSON.stringify(frame));
    assert.ok(n.ok && n.message.type === 'event');
    assert.deepEqual(n.message.reaction, frame.reaction);
    const removed = parseGatewayLine(JSON.stringify({ ...frame, reaction: { to_seq: null, emoji: [], old: ['👍'], excerpt: null } }));
    assert.ok(removed.ok && removed.message.type === 'event' && removed.message.reaction?.emoji.length === 0);
  });

  it('прежний канал (схема события 0.3.2: вида reaction нет, поля reaction нет) читает кадр обычным текстом и не отбрасывает его', () => {
    // Копия схемы события 0.3.2 — как её знает переходник, развёрнутый до 0.3.4: вид — из прежнего перечня.
    const OLD_KINDS = ['text', 'voice', 'photo', 'document', 'edit', 'command', 'callback', 'closed_topic', 'episode_closed', 'episode_reopened', 'probe'] as const;
    const trust = z.enum(['owner', 'untrusted', 'owner_forward']);
    const OldEvent = z.object({
      type: z.literal('event'),
      seq: z.int().positive(),
      kind: z.enum(OLD_KINDS),
      trust: trust.nullable(),
      mixed: z.boolean(),
      text: z.string().nullable(),
      transcript: z.string().nullable(),
      attachments: z.array(z.object({ kind: z.string(), trust })),
      forward: z.unknown().nullable(),
      reply_to: z.unknown().nullable(),
      edit_of: z.int().positive().nullable(),
      chat: z.object({ id: z.int(), kind: z.string() }).nullable(),
      subject: z.object({ id: z.string(), who: z.string() }).nullable(),
      episode: z.object({ id: z.int().positive(), topic: z.string(), role: z.string(), new: z.boolean() }).nullable(),
      redelivery: z.boolean(),
    });
    const r = OldEvent.safeParse(frame);
    assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues));
    assert.ok(!('reaction' in r.data), 'поле reaction прежний канал отбрасывает');
    assert.equal(r.data.text, frame.text);
    // Кадр вида reaction прежняя схема отбросила бы целиком — поэтому вид в кадре — text.
    assert.ok(!OldEvent.safeParse({ ...frame, kind: 'reaction' }).success);
  });
});
