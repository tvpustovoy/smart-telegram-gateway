// Проверка договора подделки Telegram (ACCEPTANCE §1): подделка должна вести себя как Bot API там, где на неё
// опираются тесты шлюза. Клиент — TelegramApi из stg-core.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Message, Update } from '@grammyjs/types';
import { TelegramApi, TelegramApiError, TelegramNetworkError } from 'stg-core';
import { FakeTelegram, checkTelegramHtml, errors, reply, user } from './index.js';

const TOKEN = '123456:TEST-token_fake';
const owner = user(111, 'Анна', { username: 'anna' });
const stranger = user(555, 'Петя');

async function withFake<T>(fn: (fake: FakeTelegram, api: TelegramApi) => Promise<T>, opts: Partial<ConstructorParameters<typeof FakeTelegram>[0]> = {}): Promise<T> {
  const fake = await FakeTelegram.start({ token: TOKEN, ...opts });
  try {
    return await fn(fake, new TelegramApi(fake.apiBase, TOKEN));
  } finally {
    await fake.stop();
  }
}

describe('подделка Telegram: опрос', () => {
  it('getMe; чужой токен — 401', () =>
    withFake(async (fake, api) => {
      const me = await api.getMe();
      assert.equal(me.is_bot, true);
      assert.equal(me.username, 'test_assistant_bot');
      const wrong = new TelegramApi(fake.apiBase, '1:wrong');
      await assert.rejects(wrong.getMe(), (e: unknown) => e instanceof TelegramApiError && e.errorCode === 401);
    }));

  it('длинный опрос держит запрос до обновления', () =>
    withFake(async (fake, api) => {
      const t0 = Date.now();
      const p = api.call<Update[]>('getUpdates', { timeout: 10 });
      await new Promise((r) => setTimeout(r, 100));
      fake.push(fake.builder.text(owner, 'привет'));
      const got = await p;
      assert.equal(got.length, 1);
      assert.equal(got[0]?.message?.text, 'привет');
      assert.ok(Date.now() - t0 < 5000);
    }));

  it('длинный опрос без обновлений отвечает пустым списком по timeout', () =>
    withFake(async (_fake, api) => {
      const t0 = Date.now();
      assert.deepEqual(await api.call('getUpdates', { timeout: 1 }), []);
      assert.ok(Date.now() - t0 >= 900);
    }));

  it('offset сбрасывает подтверждённое; limit режет выдачу', () =>
    withFake(async (fake, api) => {
      const ups = fake.push(...[1, 2, 3].map((i) => fake.builder.text(owner, `m${i}`)));
      const first = await api.call<Update[]>('getUpdates', { limit: 2 });
      assert.deepEqual(first.map((u) => u.update_id), [ups[0]?.update_id, ups[1]?.update_id]);
      const again = await api.call<Update[]>('getUpdates', {});
      assert.equal(again.length, 3, 'без offset неподтверждённое отдаётся снова');
      const last = ups[2]?.update_id ?? 0;
      assert.deepEqual(await api.call('getUpdates', { offset: last + 1 }), []);
      assert.equal(fake.pending().length, 0);
      assert.equal(fake.lastOffset, last + 1);
    }));

  it('allowed_updates фильтрует виды обновлений', () =>
    withFake(async (fake, api) => {
      const m = fake.builder.text(owner, 'текст');
      fake.push(m, fake.builder.edited(m, 'правка'), fake.builder.callback(owner, 'x'));
      const got = await api.call<Update[]>('getUpdates', { allowed_updates: ['message'] });
      assert.deepEqual(got.map((u) => Object.keys(u).filter((k) => k !== 'update_id')[0]), ['message']);
    }));

  it('повторная выдача подтверждённого по сценарию', () =>
    withFake(async (fake, api) => {
      const [u] = fake.push(fake.builder.text(owner, 'раз'));
      const id = u?.update_id ?? 0;
      await api.call('getUpdates', { offset: id + 1 });
      fake.redeliver(id);
      const got = await api.call<Update[]>('getUpdates', { offset: id + 1 });
      assert.deepEqual(got.map((x) => x.update_id), [id]);
    }));

  it('второй опрос — 409 первому; вебхук — 409 и виден в getWebhookInfo', () =>
    withFake(async (fake, api) => {
      const first = api.call('getUpdates', { timeout: 10 });
      await fake.waitForCall((c) => c.method === 'getUpdates');
      const second = api.call('getUpdates', { timeout: 0 });
      await assert.rejects(first, (e: unknown) => e instanceof TelegramApiError && e.errorCode === 409 && /terminated by other getUpdates/.test(e.description));
      await second;
      fake.setWebhook('https://example.com/hook');
      assert.equal((await api.getWebhookInfo()).url, 'https://example.com/hook');
      await assert.rejects(api.call('getUpdates', {}), (e: unknown) => e instanceof TelegramApiError && e.errorCode === 409 && /webhook is active/.test(e.description));
      assert.equal(fake.callsOf('deleteWebhook').length, 0);
    }));
});

describe('подделка Telegram: сценарий и сбои', () => {
  it('N-й вызов метода → ответ (429 с retry_after); с N-го и times', () =>
    withFake(async (fake, api) => {
      fake.onCall('sendMessage', 2, errors.tooManyRequests(7));
      fake.scenario({ method: 'getMe', from: 2, times: 2, reply: errors.serverError(502) });
      await api.call('sendMessage', { chat_id: 111, text: 'a' });
      await assert.rejects(api.call('sendMessage', { chat_id: 111, text: 'b' }), (e: unknown) => e instanceof TelegramApiError && e.errorCode === 429 && e.retryAfter === 7);
      await api.call('sendMessage', { chat_id: 111, text: 'c' });
      await api.getMe();
      await assert.rejects(api.getMe(), (e: unknown) => e instanceof TelegramApiError && e.errorCode === 502);
      await assert.rejects(api.getMe(), (e: unknown) => e instanceof TelegramApiError && e.errorCode === 502);
      await api.getMe();
    }));

  it('ошибки 400 «can’t parse entities», «not modified», 403 — в формате Bot API', () =>
    withFake(async (fake, api) => {
      fake.onCall('sendMessage', 1, errors.forbidden());
      await assert.rejects(api.call('sendMessage', { chat_id: 1, text: 'x' }), (e: unknown) => e instanceof TelegramApiError && e.errorCode === 403);
      await assert.rejects(
        api.call('sendMessage', { chat_id: 1, text: '<b>не закрыт', parse_mode: 'HTML' }),
        (e: unknown) => e instanceof TelegramApiError && e.errorCode === 400 && /can't parse entities/.test(e.description),
      );
      const m = await api.call<Message>('sendMessage', { chat_id: 1, text: 'текст' });
      await assert.rejects(
        api.call('editMessageText', { chat_id: 1, message_id: m.message_id, text: 'текст' }),
        (e: unknown) => e instanceof TelegramApiError && /message is not modified/.test(e.description),
      );
      await api.call('editMessageText', { chat_id: 1, message_id: m.message_id, text: 'новый' });
      assert.deepEqual(fake.sentTo(1).at(-1)?.edits.map((e) => e.text), ['новый']);
      await assert.rejects(api.call('sendMessage', { chat_id: 1, text: 'я'.repeat(4097) }), /message is too long/);
    }));

  it('правка (Bot API «Updating messages»): только без разметки или со встроенными кнопками; кнопки — снять и поставить', () =>
    withFake(async (fake, api) => {
      const kb = await api.call<Message>('sendMessage', { chat_id: 1, text: 'с клавиатурой', reply_markup: { keyboard: [[{ text: 'стоп' }]], is_persistent: true } });
      await assert.rejects(api.call('editMessageText', { chat_id: 1, message_id: kb.message_id, text: 'правка' }), /message can't be edited/);
      const inl = { inline_keyboard: [[{ text: 'верно', callback_data: 't1' }]] };
      const m = await api.call<Message>('sendMessage', { chat_id: 1, text: 'с кнопкой', reply_markup: inl });
      await assert.rejects(api.call('editMessageReplyMarkup', { chat_id: 1, message_id: m.message_id, reply_markup: inl }), /message is not modified/);
      await api.call('editMessageReplyMarkup', { chat_id: 1, message_id: m.message_id });
      await assert.rejects(
        api.call('editMessageText', { chat_id: 1, message_id: m.message_id, text: 'x', reply_markup: { keyboard: [[{ text: 'a' }]] } }),
        /inline keyboard expected/,
      );
      const plain = await api.call<Message>('sendMessage', { chat_id: 1, text: 'без разметки' });
      await api.call('editMessageText', { chat_id: 1, message_id: plain.message_id, text: 'с кнопкой', reply_markup: inl });
      assert.deepEqual(fake.sentTo(1).find((x) => x.message_id === plain.message_id)?.edits.at(-1)?.reply_markup, inl);
      assert.equal(fake.sentTo(1).find((x) => x.message_id === m.message_id)?.edits.at(-1)?.reply_markup, null);
    }));

  it('зависание: клиент рвёт по таймауту; обрыв: ошибка сети', () =>
    withFake(async (fake, api) => {
      fake.onCall('getUpdates', 1, reply.hang());
      await assert.rejects(api.call('getUpdates', { timeout: 30 }, { timeoutMs: 300 }), (e: unknown) => e instanceof TelegramNetworkError && e.timedOut);
      fake.onCall('getMe', 1, reply.drop());
      await assert.rejects(api.getMe(), (e: unknown) => e instanceof TelegramNetworkError && !e.timedOut);
      const hang = fake.callsOf('getUpdates')[0];
      assert.equal(hang?.outcome, 'hang');
    }));

  it('предел частоты в чат: больше 1 в секунду — 429', () =>
    withFake(
      async (_fake, api) => {
        await api.call('sendMessage', { chat_id: 7, text: 'a' });
        await assert.rejects(api.call('sendMessage', { chat_id: 7, text: 'b' }), (e: unknown) => e instanceof TelegramApiError && e.errorCode === 429 && e.retryAfter === 1);
        await api.call('sendMessage', { chat_id: 8, text: 'другой чат' });
        await new Promise((r) => setTimeout(r, 1050));
        await api.call('sendMessage', { chat_id: 7, text: 'c' });
      },
      { chatRateLimit: { perSecond: 1, retryAfter: 1 } },
    ));

  it('задержка ответа', () =>
    withFake(
      async (_fake, api) => {
        const t0 = Date.now();
        await api.getMe();
        assert.ok(Date.now() - t0 >= 45);
      },
      { latencyMs: 50 },
    ));
});

describe('подделка Telegram: отправка и файлы', () => {
  it('message_id растёт и общий с входящими в этом чате', () =>
    withFake(async (fake, api) => {
      const [u] = fake.push(fake.builder.text(owner, 'вход'));
      const inId = u?.message?.message_id ?? 0;
      const out = await api.call<Message>('sendMessage', { chat_id: owner.id, text: 'ответ' });
      assert.equal(out.message_id, inId + 1);
      const [u2] = fake.push(fake.builder.text(owner, 'ещё'));
      assert.equal(u2?.message?.message_id, inId + 2);
    }));

  it('sendVoice multipart с duration; getFile и скачивание', () =>
    withFake(async (fake, api) => {
      const form = new FormData();
      form.append('chat_id', String(owner.id));
      form.append('duration', '42');
      form.append('caption', 'подпись');
      form.append('voice', new Blob([Buffer.from('OggS-образец')], { type: 'audio/ogg' }), 'voice.ogg');
      const r = await fetch(`${fake.apiBase}/bot${TOKEN}/sendVoice`, { method: 'POST', body: form });
      const body = (await r.json()) as { ok: boolean; result: Message };
      assert.equal(body.ok, true);
      const sent = fake.sent.at(-1);
      assert.equal(sent?.method, 'sendVoice');
      assert.deepEqual(sent?.voice, { bytes: Buffer.byteLength('OggS-образец'), duration: 42 });
      assert.equal(sent?.caption, 'подпись');

      const f = fake.addFile(Buffer.from('звук'), { fileId: 'v1' });
      const info = await api.call<{ file_path: string }>('getFile', { file_id: 'v1' });
      assert.equal(info.file_path, f.file_path);
      const dl = await fetch(api.fileUrl(info.file_path));
      assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), 'звук');
      const missing = await fetch(`${fake.apiBase}/file/bot${TOKEN}/nope`);
      assert.equal(missing.status, 404);
    }));

  it('реакция, «печатает…», ответ на нажатие, команды меню — записаны', () =>
    withFake(async (fake, api) => {
      const [cb] = fake.push(fake.builder.callback(owner, 'tok'));
      await api.call('setMessageReaction', { chat_id: owner.id, message_id: 5, reaction: [{ type: 'emoji', emoji: '👀' }] });
      await api.call('sendChatAction', { chat_id: owner.id, action: 'typing' });
      await api.call('answerCallbackQuery', { callback_query_id: cb?.callback_query?.id, text: 'истёк срок' });
      await assert.rejects(api.call('answerCallbackQuery', { callback_query_id: cb?.callback_query?.id }), /query is too old/);
      await api.call('setMyCommands', { commands: [{ command: 'stop', description: 'стоп' }] });
      assert.deepEqual(fake.reactions[0]?.reaction, [{ type: 'emoji', emoji: '👀' }]);
      assert.equal(fake.chatActions[0]?.action, 'typing');
      assert.equal(fake.callbackAnswers[0]?.text, 'истёк срок');
      assert.equal(fake.commands.length, 1);
    }));

  it('журнал вызовов: метод, параметры, время; токена в журнале нет', () =>
    withFake(async (fake, api) => {
      const t0 = Date.now();
      await api.getMe();
      await api.call('sendMessage', { chat_id: 1, text: 'x' });
      assert.deepEqual(fake.calls.map((c) => c.method), ['getMe', 'sendMessage']);
      assert.ok((fake.calls[0]?.at ?? 0) >= t0);
      assert.equal(fake.calls[1]?.params.text, 'x');
      assert.ok(!JSON.stringify(fake.calls).includes(TOKEN));
    }));
});

describe('подделка Telegram: построители форм 5.4', () => {
  let fake: FakeTelegram;
  before(async () => {
    fake = await FakeTelegram.start({ token: TOKEN });
  });
  after(() => fake.stop());

  it('пересылки: user, своя, hidden_user, канал, чат; пересланное голосовое', () => {
    const b = fake.builder;
    assert.equal(b.forward(owner, { type: 'user', user: stranger }, 't').message?.forward_origin?.type, 'user');
    const own = b.forward(owner, { type: 'user', user: owner }, 't').message?.forward_origin;
    assert.ok(own?.type === 'user' && own.sender_user.id === owner.id);
    assert.equal(b.forward(owner, { type: 'hidden_user', name: 'Аноним' }, 't').message?.forward_origin?.type, 'hidden_user');
    assert.equal(b.forward(owner, { type: 'channel', chat: { id: -100, title: 'Канал' } }, 't').message?.forward_origin?.type, 'channel');
    assert.equal(b.forward(owner, { type: 'chat', chat: { id: -5, title: 'Группа' } }, 't').message?.forward_origin?.type, 'chat');
    const fv = b.forwardVoice(owner, { type: 'user', user: stranger }, { duration: 5 }).message;
    assert.ok(fv?.voice && fv.forward_origin?.type === 'user');
  });

  it('external_reply, quote, via_bot, фото с подписью, документ', () => {
    const b = fake.builder;
    assert.ok(b.externalReply(owner, 'мой текст', { origin: { type: 'user', user: stranger } }).message?.external_reply);
    const q = b.quoteExternal(owner, 'мой', 'чужая цитата', { type: 'channel', chat: { id: -1, title: 'К' } }).message;
    assert.equal(q?.quote?.text, 'чужая цитата');
    assert.ok(q?.external_reply);
    assert.equal(b.viaBot(owner, 'x', user(9, 'bot', { username: 'gif' })).message?.via_bot?.is_bot, true);
    const ph = b.photo(owner, 'подпись').message;
    assert.equal(ph?.caption, 'подпись');
    assert.ok(Array.isArray(ph?.photo));
    assert.equal(b.document(owner, { fileName: 'a.pdf' }, null).message?.document?.file_name, 'a.pdf');
  });

  it('реплай на сообщение бота с цитатой; правка; нажатие от чужого; темы', async () => {
    const b = fake.builder;
    const api = new TelegramApi(fake.apiBase, TOKEN);
    const botMsg = await api.call<Message>('sendMessage', { chat_id: owner.id, text: 'ответ агента' });
    const r = b.replyTo(owner, 'да', botMsg, { quote: 'ответ' }).message;
    assert.equal(r?.reply_to_message?.message_id, botMsg.message_id);
    assert.equal(r?.reply_to_message?.from?.is_bot, true);
    assert.equal(r?.quote?.text, 'ответ');
    const orig = b.text(owner, 'было');
    const ed = b.edited(orig, 'стало');
    assert.equal(ed.edited_message?.message_id, orig.message?.message_id);
    assert.equal(ed.edited_message?.text, 'стало');
    assert.ok(ed.edited_message?.edit_date);
    assert.equal(b.callback(stranger, 'tok').callback_query?.from.id, stranger.id);
    const topic = b.text(owner, 'в теме', { thread: { id: 77, isTopic: true } }).message;
    assert.equal(topic?.message_thread_id, 77);
    assert.equal(topic?.is_topic_message, true);
    const noTopic = b.text(owner, 'без признака', { thread: { id: 77, isTopic: false } }).message;
    assert.equal(noTopic?.is_topic_message, undefined);
    assert.ok(b.command(owner, '/stop').message?.entities?.[0]?.type === 'bot_command');
  });
});

describe('подделка Telegram: разметка HTML', () => {
  it('допустимые теги и сущности; неизвестный тег, непарный, лишний конец — ошибка', () => {
    assert.equal(checkTelegramHtml('<b>жирный</b> &lt;x&gt; <a href="https://x">ссылка</a> <pre><code>код</code></pre>').error, null);
    assert.equal(checkTelegramHtml('a &amp; b').plain, 'a & b');
    assert.match(checkTelegramHtml('<div>x</div>').error ?? '', /Unsupported start tag "div"/);
    assert.match(checkTelegramHtml('<b>x').error ?? '', /Can't find end tag/);
    assert.match(checkTelegramHtml('x</b>').error ?? '', /Unexpected end tag/);
    assert.match(checkTelegramHtml('<b><i>x</b></i>').error ?? '', /Unmatched end tag/);
    assert.match(checkTelegramHtml('&nbsp;').error ?? '', /Unsupported HTML entity/);
  });
});
