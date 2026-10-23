// Материал без слов владельца (0.3.6, issue #51): что в сообщении — слова владельца, материал без слов или ни то ни другое.
// По сообщению Telegram через метку доверия (labelMessage, 5.4) — так, как решает приём (admission.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '@grammyjs/types';
import { hasOwnerWords, linksOnly, materialClass, type MaterialClass } from './material.js';
import { labelMessage } from './trust.js';

const OWNER = { id: 111, is_bot: false, first_name: 'Владелец' };
const OTHER = { id: 222, is_bot: false, first_name: 'Участник' };
const chat = { id: 111, type: 'private', first_name: 'Владелец' };

/** replyToAgent — реплай на сообщение агента (при приёме — reply_to.kind = agent по messages_out, admission.ts). */
function classOf(msg: Record<string, unknown>, opts: { fromOwner?: boolean; kind?: 'command'; replyToAgent?: boolean } = {}): MaterialClass {
  const fromOwner = opts.fromOwner ?? true;
  const m = { message_id: 1, date: 1, chat, from: fromOwner ? OWNER : OTHER, ...msg } as unknown as Message;
  const l = labelMessage(m, { ownerId: OWNER.id, fromOwner });
  return materialClass({
    fromOwner,
    kind: opts.kind ?? l.kind,
    trust: l.trust,
    text: l.text,
    attachments: l.attachments,
    forwarded: l.forward !== null,
    replyToAgent: opts.replyToAgent ?? false,
  });
}

const file = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ file_id: 'f', file_unique_id: 'uf', ...extra });

describe('A11.11 · окно материала (0.3.6, #51): слова владельца, материал, ни то ни другое', () => {
  it('слова владельца: текст (и ссылка рядом с его словами), подпись к фото и файлу, голосовое, свой кружок и аудиофайл, ответ на сообщение другого чата со своим текстом', () => {
    assert.equal(classOf({ text: 'посмотри это' }), 'words');
    assert.equal(classOf({ text: 'посмотри https://example.com/article' }), 'words');
    assert.equal(classOf({ photo: [{ ...file(), width: 10, height: 10 }], caption: 'что тут?' }), 'words');
    assert.equal(classOf({ document: file({ file_name: 'a.pdf', mime_type: 'application/pdf' }), caption: 'сократи' }), 'words');
    assert.equal(classOf({ video: file({ duration: 3, width: 10, height: 10 }), caption: 'это что' }), 'words');
    assert.equal(classOf({ voice: file({ duration: 3 }) }), 'words', 'голосовое — слово с момента прихода');
    assert.equal(classOf({ video_note: file({ duration: 3, length: 240 }) }), 'words', 'свой кружок');
    assert.equal(classOf({ audio: file({ duration: 30, file_name: 'memo.m4a' }) }), 'words', 'свой аудиофайл');
    assert.equal(
      classOf({ text: 'вот это', external_reply: { origin: { type: 'channel', chat: { id: -100, type: 'channel', title: 'Канал' }, message_id: 5, date: 1 } } }),
      'words',
    );
  });

  it('материал без слов: фото, файл, видео без подписи; пересылка (любая — и своего старого сообщения, и голосового); через инлайн-бота; место и контакт', () => {
    assert.equal(classOf({ photo: [{ ...file(), width: 10, height: 10 }] }), 'material');
    assert.equal(classOf({ document: file({ file_name: 'a.pdf', mime_type: 'application/pdf' }) }), 'material');
    assert.equal(classOf({ video: file({ duration: 3, width: 10, height: 10 }) }), 'material');
    const fwd = { forward_origin: { type: 'user', sender_user: OTHER, date: 1 } };
    assert.equal(classOf({ ...fwd, text: 'статья' }), 'material');
    assert.equal(classOf({ ...fwd, photo: [{ ...file(), width: 10, height: 10 }], caption: 'подпись автора' }), 'material', 'подпись в пересылке — не слова владельца');
    assert.equal(classOf({ ...fwd, voice: file({ duration: 3 }) }), 'material');
    assert.equal(classOf({ forward_origin: { type: 'user', sender_user: OWNER, date: 1 }, text: 'моё старое' }), 'material', 'своё пересланное — тоже материал');
    assert.equal(classOf({ text: 'Статья', via_bot: { id: 9, is_bot: true, first_name: 'wiki', username: 'wiki' } }), 'material');
    assert.equal(classOf({ location: { latitude: 1, longitude: 2 } }), 'material');
    assert.equal(classOf({ contact: { phone_number: '+0', first_name: 'К' } }), 'material');
  });

  it('ни то ни другое: жесты (стикер, кубик, GIF) без подписи; команда; сообщения другого участника', () => {
    assert.equal(classOf({ sticker: file({ emoji: '👍', width: 1, height: 1, type: 'regular', is_animated: false, is_video: false }) }), null);
    assert.equal(classOf({ dice: { emoji: '🎲', value: 3 } }), null);
    assert.equal(classOf({ animation: file({ duration: 2, width: 1, height: 1 }) }), null);
    assert.equal(classOf({ text: 'стоп' }, { kind: 'command' }), null);
    assert.equal(classOf({ photo: [{ ...file(), width: 10, height: 10 }] }, { fromOwner: false }), null);
    assert.equal(classOf({ text: 'привет' }, { fromOwner: false }), null);
  });

  it('A11.25 · текст из одних ссылок (поделился страницей из браузера) — материал без слов; любое слово рядом — слова', () => {
    // Одни ссылки: http(s)://, www., t.me/ — в любом регистре; несколько; пробелы, переносы и разделяющая пунктуация вокруг.
    for (const text of [
      'https://example.com/article',
      'http://example.com',
      'HTTPS://EXAMPLE.COM/A',
      'www.example.com/page',
      't.me/some_channel/42',
      '  https://example.com/a \n',
      'https://a.example, https://b.example',
      'https://a.example\nhttps://b.example\n\nwww.c.example',
      '(https://example.com/a)',
      '«https://example.com/a»',
      '— https://example.com/a',
      '• https://a.example\n• https://b.example',
      '<https://example.com/a>.',
      'https://ru.wikipedia.org/wiki/Сон',
      // Конец ссылки — как у Telegram: замыкающие . , ; : ? ! ) » " ' — не часть ссылки, а разделители вокруг неё.
      'https://ru.wikipedia.org/wiki/Сон.',
      'https://ru.wikipedia.org/wiki/Sleep_(film)',
      'https://example.com/a;',
      '"https://example.com/a"',
      "'https://example.com/a'",
      'https://example.com/a?x=1&y=2#top',
      'https://example.com:8080/a',
      'https://пример.рф/статья',
      't.me/some_channel/42.',
      // Невидимые знаки вокруг: LRM и RLM (U+200E, U+200F), знак вставленного объекта (U+FFFC), нулевой ширины.
      '\u200Fhttps://example.com/a\u200E',
      'https://example.com/a\uFFFC',
      '\uFFFC https://example.com/a',
      '\u200Bhttps://example.com/a/\u200E',
    ]) {
      assert.equal(classOf({ text }), 'material', text);
      assert.ok(linksOnly(text) > 0, text);
    }
    assert.deepEqual([linksOnly('https://a.example'), linksOnly('https://a.example, https://b.example'), linksOnly('https://a.example\nwww.b.example\nt.me/c')], [1, 2, 3]);
    assert.equal(linksOnly('https://a.example,https://b.example'), 2, 'запятая за доменом — конец ссылки');
    // Внутри пути запятая — часть ссылки, как у Telegram: одна ссылка, материал.
    assert.equal(linksOnly('https://example.com/a,b'), 1, 'запятая внутри пути — часть ссылки');
    assert.equal(linksOnly('https://example.com/a,b, https://example.com/c'), 2, 'запятая с пробелом после пути — разделитель');
    assert.equal(classOf({ text: 'https://example.com/a,b' }), 'material');
    // Слово рядом со ссылкой — слова: «посмотри …», заголовок страницы над ссылкой (от слов владельца не отличить), вопрос,
    // эмодзи, номер в списке, хэштег; ссылка на словах (text_link) — в тексте видны слова, адреса нет.
    for (const text of [
      'посмотри https://example.com/a',
      'Как спать меньше и успевать больше\nhttps://example.com/a',
      'https://example.com/a ?',
      'https://example.com/a 🔥',
      '1. https://example.com/a',
      '#читать https://example.com/a',
      'посмотри:https://example.com/a',
      // Слово или знак вплотную к ссылке: за доменом ссылку продолжают только порт, «/», «?», «#»; эмодзи и « » < > её
      // обрывают; «?» и «!» в конце — не часть ссылки, а вопрос владельца.
      'https://a.com,посмотри',
      'https://a.com🔥',
      'https://a.com/статья🔥',
      'https://a.com?',
      'https://a.com/a?',
      'https://a.com/a!',
      'https://a.com/a?x=1?',
      'https://a.com/a«важно»',
      'https://a.com/a<b>',
      'https://a.com: посмотри',
    ]) {
      assert.equal(classOf({ text }), 'words', text);
      assert.equal(linksOnly(text), 0, text);
    }
    assert.equal(classOf({ text: 'вот статья', entities: [{ type: 'text_link', offset: 4, length: 6, url: 'https://example.com/a' }] }), 'words', 'text_link — слова');
    // Не ссылка по тексту — слова, как прежде: адрес без www и схемы, число, начало без адреса, середина слова или адреса.
    for (const text of ['example.com/a', '1.5', 'www.', 'https://', 'art.me/x', 'user@www.example.com', '...']) {
      assert.equal(classOf({ text }), 'words', text);
      assert.equal(linksOnly(text), 0, text);
    }
    // Подпись из одних ссылок у фото и файла — без слов: материал; у голосового — голосовое и так слова.
    assert.equal(classOf({ photo: [{ ...file(), width: 10, height: 10 }], caption: 'https://example.com/a' }), 'material');
    assert.equal(classOf({ document: file({ file_name: 'a.pdf', mime_type: 'application/pdf' }), caption: 'https://example.com/a' }), 'material');
    assert.equal(classOf({ voice: file({ duration: 3 }), caption: 'https://example.com/a' }), 'words');
    // Пересылка и инлайн-бот со ссылкой — материал, как были; ссылка участника — ни то ни другое (окно — только у владельца).
    assert.equal(classOf({ forward_origin: { type: 'user', sender_user: OTHER, date: 1 }, text: 'https://example.com/a' }), 'material');
    assert.equal(classOf({ text: 'https://example.com/a', via_bot: { id: 9, is_bot: true, first_name: 'wiki', username: 'wiki' } }), 'material');
    assert.equal(classOf({ text: 'https://example.com/a' }, { fromOwner: false }), null);
    // По строке базы (реплай на материал, «слова раньше», «слова после материала»; правка удерживаемого) — тот же ответ.
    assert.equal(hasOwnerWords({ kind: 'text', trust: 'owner', text: 'https://example.com/a', attachments: [] }), false);
    assert.equal(hasOwnerWords({ kind: 'text', trust: 'owner', text: 'посмотри https://example.com/a', attachments: [] }), true);
    assert.equal(materialClass({ fromOwner: true, kind: 'text', trust: 'owner', text: 'https://example.com/a', attachments: [], forwarded: false, replyToAgent: false }), 'material');
  });

  it('A11.26 · текст из одних ссылок реплаем на сообщение агента — ответ ему, а не материал: ни то ни другое (сразу, окна не открывает и не отпускает); прочее — как без реплая', () => {
    // Агент попросил ссылку — владелец ответил ею реплаем: это его ответ, не материал.
    assert.equal(classOf({ text: 'https://example.com/a' }, { replyToAgent: true }), null);
    assert.equal(classOf({ text: 'https://a.example\nt.me/b' }, { replyToAgent: true }), null);
    // Словами он не становится: окно не отпускает, «словами раньше» и «после материала» не считается.
    assert.equal(hasOwnerWords({ kind: 'text', trust: 'owner', text: 'https://example.com/a', attachments: [] }), false);
    // Слова реплаем на агента — слова, как раньше; ссылка без реплая — материал.
    assert.equal(classOf({ text: 'вот она: https://example.com/a' }, { replyToAgent: true }), 'words');
    assert.equal(classOf({ text: 'https://example.com/a' }, { replyToAgent: false }), 'material');
    // Фото, файл, пересылка и инлайн-бот реплаем на агента — материал, как были: ответ — только свой текст из ссылок.
    assert.equal(classOf({ photo: [{ ...file(), width: 10, height: 10 }] }, { replyToAgent: true }), 'material');
    assert.equal(classOf({ photo: [{ ...file(), width: 10, height: 10 }], caption: 'https://example.com/a' }, { replyToAgent: true }), 'material');
    assert.equal(classOf({ text: 'https://example.com/a', via_bot: { id: 9, is_bot: true, first_name: 'wiki', username: 'wiki' } }, { replyToAgent: true }), 'material');
    // По строке базы (isMaterialEvent: реплай на такое сообщение) — тот же ответ: reply_to хранится в событии.
    assert.equal(materialClass({ fromOwner: true, kind: 'text', trust: 'owner', text: 'https://example.com/a', attachments: [], forwarded: false, replyToAgent: true }), null);
  });

  it('hasOwnerWords — по строке базы: метка owner и текст, голос или свой звук файлом; пустая подпись и чужая метка — нет', () => {
    assert.equal(hasOwnerWords({ kind: 'text', trust: 'owner', text: 'да', attachments: [] }), true);
    assert.equal(hasOwnerWords({ kind: 'photo', trust: 'owner', text: '  ', attachments: [] }), false);
    assert.equal(hasOwnerWords({ kind: 'voice', trust: 'untrusted', text: null, attachments: [] }), false);
    assert.equal(hasOwnerWords({ kind: 'document', trust: 'owner', text: null, attachments: [{ kind: 'document', trust: 'owner', ref: { type: 'video_note' } }] }), true);
    assert.equal(hasOwnerWords({ kind: 'document', trust: 'owner', text: null, attachments: [{ kind: 'document', trust: 'untrusted', ref: { type: 'video' } }] }), false);
  });
});
