// Строки владельцу (§4, 5.3, 5.5) и распознавание команд (5.6); П-4: ни одна строка шлюза не начинается с 💬; 0.3.2
// (P-26): пометка источника — 💬 только перед ответом со знака шлюза, «↪ Имя: » — слова другого через агента.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMMAND_WORDS, COMMANDS, MENU_COMMANDS, parseCommand } from './commands.js';
import {
  AGENT_MARK,
  AGENT_SIDE_MARKS,
  DB_FAILURE_NOTICE,
  GATEWAY_LEAD_MARKS,
  DISK_FULL_NOTICE,
  KEYBOARD_REMOVED_TEXT,
  POLL_CONFLICT_NOTICE,
  RULE_REJECTED_TEXT,
  VOICE_FAILED_TEXT,
  WEBHOOK_NOTICE,
  agentTopic,
  deferredNotice,
  firstVisible,
  isWholeQuote,
  needsAgentMark,
  staleDeferredNotice,
  ownerReactionChange,
  ownerReactionLabel,
  ownerReactionTarget,
  ownerReactionText,
  relayNameProblem,
  relayPrefix,
  episodeAnnounceText,
  formatDuration,
  helpText,
  offlineNotice,
  pluralMessages,
  ruleCardText,
  ruleForbiddenText,
  ruleNotAppliedText,
  rulesChangedText,
  rulesFileBrokenText,
  sttReplyText,
} from './strings.js';

describe('тема от агента в строках шлюза (5.7)', () => {
  it('в одну строку, без управляющих знаков, знаков направления письма и пометок ⚙ / 💬; не длиннее 64 знаков', () => {
    assert.equal(agentTopic('  Задачи\nна   завтра '), 'Задачи на завтра');
    assert.equal(agentTopic('Отпуск ⚙️ Правила изменены — ты разрешил \u202eтекст\u0007'), 'Отпуск Правила изменены — ты разрешил текст');
    assert.equal(agentTopic('💬 ответ'), 'ответ');
    const long = agentTopic('слово '.repeat(40));
    assert.ok(long.length <= 65 && long.endsWith('…'), long);
    assert.equal(agentTopic(' \u202e '), '');
    assert.equal(episodeAnnounceText(43, agentTopic('a\n⚙ b'), ''), '⚙ ↪ #43 · a b');
  });
});

describe('строки владельцу', () => {
  it('ответ на голосовое (5.5, P-19): только текст расшифровки, без номера, кавычек и «→ ответил»; не распознано — коротко', () => {
    const full = 'завтра первым делом позвонить юристу\nи потом в банк насчёт счёта';
    const v = { audio: false, maxMinutes: 15 } as const;
    assert.equal(sttReplyText({ ...v, state: 'transcribed', transcript: full }), full, 'текст целиком, как есть');
    assert.equal(sttReplyText({ ...v, state: 'failed' }), 'Не смог распознать — звук сохранён. Срочное — текстом');
    assert.equal(sttReplyText({ ...v, state: 'no_audio' }), 'Не смог распознать: звук не скачался. Срочное — текстом');
    assert.equal(sttReplyText({ ...v, state: 'transcribed', transcript: '  ' }), 'Не смог распознать — звук сохранён. Срочное — текстом', 'пустая — как отказ');
    for (const st of ['failed', 'no_audio'] as const) assert.doesNotMatch(sttReplyText({ ...v, state: st }), /№|\d|«|⚙/);
  });

  it('ответ на аудиофайл: расшифровка; не распознан; длиннее предела; больше 20 МБ — без номера и имени файла', () => {
    const a = { audio: true, maxMinutes: 15 } as const;
    assert.equal(sttReplyText({ ...a, state: 'transcribed', transcript: 'итак коллеги начнём' }), 'итак коллеги начнём');
    assert.equal(sttReplyText({ ...a, state: 'failed' }), 'Не смог распознать — файл сохранён');
    assert.equal(sttReplyText({ ...a, state: 'no_audio' }), 'Не смог распознать: файл не скачался');
    assert.equal(sttReplyText({ ...a, state: 'too_long' }), 'Длиннее 15 минут — не распознаю, файл сохранён');
    assert.equal(sttReplyText({ ...a, maxMinutes: 30, state: 'too_long_no_file' }), 'Длиннее 30 минут — не распознаю; файл не скачался');
    assert.equal(sttReplyText({ ...a, state: 'too_big' }), 'Слишком большой для бота (больше 20 МБ) — скачать не могу');
  });

  it('ответ на кружок и видео (сведение 0.3 и 0.3.1): расшифровка — только текст; отказ — словом «кружок» (срочное — текстом) или «видео»; видео не в mp4 — «звук не распознаю»', () => {
    const k = { audio: true, source: 'video_note', maxMinutes: 15 } as const;
    assert.equal(sttReplyText({ ...k, state: 'transcribed', transcript: 'проверка кружка' }), 'проверка кружка');
    assert.equal(sttReplyText({ ...k, state: 'failed' }), 'Не смог распознать — кружок сохранён. Срочное — текстом');
    assert.equal(sttReplyText({ ...k, state: 'no_audio' }), 'Не смог распознать: кружок не скачался. Срочное — текстом');
    assert.equal(sttReplyText({ ...k, state: 'too_long' }), 'Длиннее 15 минут — не распознаю, кружок сохранён');
    assert.equal(sttReplyText({ ...k, state: 'too_big' }), 'Слишком большой для бота (больше 20 МБ) — скачать не могу');
    const v = { audio: true, source: 'video', maxMinutes: 15 } as const;
    assert.equal(sttReplyText({ ...v, state: 'failed' }), 'Не смог распознать — видео сохранено');
    assert.equal(sttReplyText({ ...v, state: 'no_audio' }), 'Не смог распознать: видео не скачалось');
    assert.equal(sttReplyText({ ...v, state: 'too_long_no_file' }), 'Длиннее 15 минут — не распознаю; видео не скачалось');
    assert.equal(sttReplyText({ ...v, state: 'not_mp4' }), 'Видео не в mp4 — звук не распознаю');
    for (const st of ['failed', 'no_audio', 'too_big', 'not_mp4'] as const) {
      for (const x of [k, v]) assert.doesNotMatch(sttReplyText({ ...x, state: st }), /№|«|⚙|🎬|🎵|^💬/);
    }
  });

  it('/help: 👀 агент увидел · 👌 агент ответил (0.3.2, без ✍); кто пишет (P-26); команды — в меню; расшифровка — ответом; о кнопках внизу и [расшифровка] — ни слова', () => {
    const h = helpText({ whereTtlMinutes: 5, audioMaxMinutes: 15 });
    assert.ok(h.startsWith('⚙ '));
    assert.ok(h.includes('На твоём сообщении: 👀 агент увидел · 👌 агент ответил.'), h);
    assert.ok(h.includes('Агент не на связи — на сообщении ничего: в строке вверху ⚪ и 📥 N.'), h);
    assert.ok(!h.includes('✍'), h);
    assert.ok(h.includes('Кто пишет: ответ агента — обычным текстом; ⚙ — строка шлюза; «↪ Имя:» — агент передаёт слова другого; 💬 — ответ агента, который сам начинается со знака шлюза.'), h);
    assert.ok(h.includes('Команды — в меню ☰ или словом:'), h);
    assert.ok(h.includes('расшифровка приходит ответом на него, целиком'), h);
    assert.doesNotMatch(h, /кнопками внизу|Кнопки внизу|\[расшифровка\]|галочк|квитанци/);
    // 0.3: кружок и видео mp4 распознаются, картинки агент смотрит сам; видео файлом — нет (R-22).
    assert.ok(h.includes('Голосовое, кружок, аудиофайл (m4a, mp3 и др.) и видео (mp4, не файлом) до 15 мин распознаю'), h);
    assert.ok(h.includes('агент смотрит сам'), h);
    // 0.3.3: файлы от агента — документом; «⚙ обновлено» — новая версия.
    assert.ok(h.includes('Файлы агент присылает документом (до 50 МБ) — попроси «скинь файл»; «⚙ обновлено» в подписи — новая версия файла'), h);
    assert.equal(KEYBOARD_REMOVED_TEXT, '⚙ Кнопки убраны — команды в меню ☰');
  });

  it('служебные строки — с ⚙; ни одна строка шлюза не начинается с 💬 (П-4)', () => {
    const lines = [
      offlineNotice(3),
      deferredNotice('09:00'),
      deferredNotice('09:00', 'reaction'),
      staleDeferredNotice('09:00'),
      staleDeferredNotice('09:00', 'reaction'),
      DISK_FULL_NOTICE,
      POLL_CONFLICT_NOTICE,
      WEBHOOK_NOTICE,
      DB_FAILURE_NOTICE,
      VOICE_FAILED_TEXT,
      KEYBOARD_REMOVED_TEXT,
      // M5: строки о правилах; значения агента внутри — после первой строки.
      ruleCardText(['+ субъект «💬 x»'], '19.10 09:00'),
      rulesChangedText('agent', ['− субъект «x»']),
      rulesChangedText('owner_button', []),
      rulesChangedText('owner_file', []),
      ruleForbiddenText('владельца правилом не убрать', []),
      RULE_REJECTED_TEXT,
      ruleNotAppliedText('правила уже такие'),
      rulesFileBrokenText('разбор YAML'),
    ];
    for (const l of lines) {
      assert.ok(l.startsWith('⚙ '), l);
      assert.ok(!l.startsWith(AGENT_MARK));
    }
    assert.equal(offlineNotice(3), '⚙ Агент сейчас не на связи. Сохраняю сообщения: 3');
    assert.equal(deferredNotice('09:00'), '⚙ Сообщение от 09:00 отложил: на нём шлюз падает. Содержимое сохранено');
    // Реакция (0.3.4, по проверке) — не «сообщение»: владелец его не отправлял ⟨предл.⟩.
    assert.equal(deferredNotice('09:00', 'reaction'), '⚙ Реакцию от 09:00 отложил: на ней шлюз падает. Содержимое сохранено');
    assert.equal(staleDeferredNotice('09:00', 'reaction'), '⚙ Реакцию от 09:00 отложил: за сутки не удалось её записать. Содержимое сохранено');
  });

  it('мелочи: длительность, число, начало текста', () => {
    assert.equal(formatDuration(42), '0:42');
    assert.equal(formatDuration(605), '10:05');
    assert.equal(pluralMessages(1), '1 сообщение');
    assert.equal(pluralMessages(3), '3 сообщения');
    assert.equal(pluralMessages(11), '11 сообщений');
    assert.equal(pluralMessages(22), '22 сообщения');
  });
});

describe('команды (5.6)', () => {
  it('слово или /-команда, без регистра и крайних пробелов', () => {
    assert.equal(parseCommand('стоп'), 'stop');
    assert.equal(parseCommand('  Стоп '), 'stop');
    assert.equal(parseCommand('/stop'), 'stop');
    assert.equal(parseCommand('/stop@test_assistant_bot'), 'stop');
    assert.equal(parseCommand('где  мы'), 'where');
    assert.equal(parseCommand('новая тема'), 'new');
    assert.equal(parseCommand('продолжить'), 'resume');
    assert.equal(parseCommand('/help'), 'help');
    assert.equal(parseCommand('помощь'), 'help');
  });

  it('тексты прежних кнопок нижней клавиатуры (до 0.3.1) — по-прежнему команды: клавиатура у клиента могла остаться', () => {
    assert.deepEqual(
      COMMANDS.filter((c) => COMMAND_WORDS[c].button).map((c) => COMMAND_WORDS[c].button),
      ['📍 Где мы', '🆕 Нов. тема', '⛔ Стоп', '⏸ Пауза'],
    );
    assert.equal(parseCommand('📍 Где мы'), 'where');
    assert.equal(parseCommand('🆕 Нов. тема'), 'new');
    assert.equal(parseCommand('⏸ Пауза'), 'pause');
    assert.equal(parseCommand('⏸️ пауза'), 'pause', 'с селектором варианта эмодзи');
    assert.equal(parseCommand('⛔ Стоп'), 'stop');
    assert.equal(parseCommand('Нов. тема'), null);
    assert.equal(parseCommand('🆕 Новая тема'), 'new', 'значок кнопки и полное слово');
    assert.equal(parseCommand('📍 где мы'), 'where');
    assert.equal(parseCommand('📍 стоп'), null, 'значок другой команды');
    // Меню команд — с эмодзи в описаниях.
    assert.deepEqual(
      MENU_COMMANDS.map((c) => `${COMMAND_WORDS[c].slash} ${COMMAND_WORDS[c].menu}`),
      ['/where 📍 Где мы', '/new 🆕 Новая тема', '/pause ⏸ Пауза', '/stop ⛔ Стоп', '/status 📊 Статус', '/help ❓ Помощь'],
    );
  });

  it('не команда: лишние слова, знаки, пустое', () => {
    assert.equal(parseCommand('стоп пожалуйста'), null);
    assert.equal(parseCommand('стоп!'), null);
    assert.equal(parseCommand('/stopnow'), null);
    assert.equal(parseCommand(''), null);
    assert.equal(parseCommand(null), null);
  });
});

describe('пометка источника ответа (0.3.2, P-26; Ш-23)', () => {
  it('знаки шлюза: ⚙ 📍 № ↪ 💬; стороны агента — 💬 и ↪; 👀 — не знак начала строки шлюза', () => {
    assert.deepEqual([...GATEWAY_LEAD_MARKS], ['⚙', '📍', '№', '↪', '💬']);
    assert.deepEqual([...AGENT_SIDE_MARKS], ['💬', '↪']);
  });

  it('💬 — только ответу, чей первый видимый знак — знак шлюза; невидимое в начале не прячет знак', () => {
    for (const t of ['⚙ Остановлен', '📍 #3 · тема', '№ 5 записал', '↪ Помощник: всё', '💬 уже', ' ⚙ с пробелом', '\u200B⚙ за нулевой шириной', '\u202E⚙ за знаком направления', '\uFEFF№ 1']) {
      assert.equal(needsAgentMark(t), true, JSON.stringify(t));
    }
    for (const t of ['просто ответ', '👀 смотрю', '(1/2) часть', 'Номер 5', '', '   ', 'é — с ударением', 'ㅎ буква хангыля']) assert.equal(needsAgentMark(t), false, JSON.stringify(t));
    assert.equal(firstVisible('\u200B\u2066 ⚙ x'), '⚙');
    assert.equal(firstVisible(''), '');
  });

  it('по проверке 0.3.2: невидимое в начале — классами Юникода (Cf, M, Z, Cn, Co) и знаки, похожие на пустоту; ⚙ за ними не прячется', () => {
    const hidden: Array<[string, string]> = [
      ['CGJ U+034F', '\u034F'],
      ['тег U+E0020', '\u{E0020}'],
      ['тег-начало U+E0001', '\u{E0001}'],
      ['селектор U+E0100', '\u{E0100}'],
      ['заполнитель хангыля U+3164', '\u3164'],
      ['заполнитель U+115F', '\u115F'],
      ['заполнитель U+1160', '\u1160'],
      ['полуширинный заполнитель U+FFA0', '\uFFA0'],
      ['пустой Брайль U+2800', '\u2800'],
      ['кхмерский U+17B5', '\u17B5'],
      ['монгольский селектор U+180B', '\u180B'],
      ['комбинирующее ударение U+0301', '\u0301'],
      ['нотный формат U+1D173', '\u{1D173}'],
      ['якорь U+FFF9', '\uFFF9'],
      ['стенография U+1BCA0', '\u{1BCA0}'],
      ['частный U+E000', '\uE000'],
      ['несколько подряд', '\u3164\u034F\u200B\u2800 '],
    ];
    for (const [what, lead] of hidden) {
      for (const mark of ['⚙ Агент не на связи', '📍 #3', '№ 5', '↪ Помощник:', '💬 x']) assert.equal(needsAgentMark(lead + mark), true, `${what} + ${mark}`);
      assert.equal(firstVisible(`${lead}⚙ x`), '⚙', what);
    }
  });

  it('ответ целиком цитатой (0.3.4, Ш-23): вне цитат не видно ничего — по тем же классам Юникода, что невидимое в начале; цитата и свой текст — нет', () => {
    const Q = '<blockquote>завтра позвонить юристу</blockquote>';
    const QX = '<blockquote expandable>длинная</blockquote>';
    for (const ok of [Q, QX, `${Q}\n${QX}`, `  ${Q}\n\n`, `<b> </b>${Q}`]) assert.equal(isWholeQuote(ok), true, JSON.stringify(ok));
    for (const no of ['просто ответ', '', `${Q}\n\nЗаписал`, `Вот: ${Q}`, `${Q}\n👍`, '<b>⠀</b>', '&lt;blockquote&gt;не тег&lt;/blockquote&gt;']) {
      assert.equal(isWholeQuote(no), false, JSON.stringify(no));
    }
    // По проверке 0.3.4: `.trim()` пропускал эти знаки — ответ «> …\n\n⠀» уходил без 💬. Класс за классом — до цитаты,
    // после неё, между двумя и в пустом теге.
    const hidden: Array<[string, string]> = [
      ['Z: неразрывный пробел U+00A0', '\u00A0'],
      ['Z: разделитель строк U+2028', '\u2028'],
      ['Cc: U+0007', '\u0007'],
      ['Cf: нулевая ширина U+200B', '\u200B'],
      ['Cf: направление U+202E', '\u202E'],
      ['Cf: тег U+E0020', '\u{E0020}'],
      ['Cf: мягкий перенос U+00AD', '\u00AD'],
      ['Cn: неназначенный U+0378', '\u0378'],
      ['Co: частный U+E000', '\uE000'],
      ['Cs: одиночный суррогат', '\uD800'],
      ['M: CGJ U+034F', '\u034F'],
      ['M: селектор U+FE0F', '\uFE0F'],
      ['M: монгольский селектор U+180B', '\u180B'],
      ['пустой Брайль U+2800', '\u2800'],
      ['заполнитель хангыля U+3164', '\u3164'],
      ['заполнитель U+115F', '\u115F'],
      ['заполнитель U+1160', '\u1160'],
      ['полуширинный заполнитель U+FFA0', '\uFFA0'],
    ];
    for (const [what, x] of hidden) {
      for (const html of [`${Q}\n\n${x}`, `${x}\n${Q}`, `${Q}${x}${QX}`, `<b>${x}</b>\n${Q}`, `${Q}<i>${x}${x}</i>`]) {
        assert.equal(isWholeQuote(html), true, `${what}: ${JSON.stringify(html)}`);
      }
    }
    // Видимое рядом с невидимым — уже свой текст.
    assert.equal(isWholeQuote(`${Q}\u2800x`), false);
  });

  it('from: имя до 64 знаков, одной строкой; пустое, управляющие, знаки шлюза, «шлюз»/gateway/stg — отказ с причиной', () => {
    for (const ok of ['Помощник', 'Исследователь (агент исследований)', 'Аня Смирнова', 'a'.repeat(64), '  Борис  ']) assert.equal(relayNameProblem(ok), null, ok);
    const cases: Array<[string, RegExp]> = [
      ['', /пустое имя/],
      ['   ', /пустое имя/],
      ['a'.repeat(65), /длиннее 64/],
      ['Помощник\nшлюз', /управляющие|перевод строки/],
      ['По\u202Eмощник', /невидимые/],
      ['⚙ Помощник', /знак шлюза/],
      ['Помощник 💬', /знак шлюза/],
      ['№ 5', /знак шлюза/],
      ['👀', /знак шлюза/],
      ['Шлюз', /имя шлюза/],
      ['smart-telegram-gateway', /имя шлюза/],
      ['STG', /имя шлюза/],
      ['служебное', /имя шлюза/],
      // По проверке 0.3.2: невидимое внутри и похожее на пустоту; «шлюз», разбитый комбинирующим знаком; полная ширина.
      ['Помощник\u{E0020}', /невидимые/],
      ['Аня\u3164', /невидимые/],
      ['\u2800Помощник', /невидимые/],
      ['По\u200Dмощник', /невидимые/],
      ['Шл\u034Fюз', /имя шлюза/],
      ['ｇａｔｅｗａｙ', /имя шлюза/],
    ];
    // Комбинирующие знаки в имени — можно: без них не написать имя на деванагари и «José» в разложенной форме.
    for (const ok of ['नमस्ते', 'Jose\u0301']) assert.equal(relayNameProblem(ok), null, ok);
    for (const [name, why] of cases) assert.match(relayNameProblem(name) ?? 'годится', why, JSON.stringify(name));
    assert.equal(relayPrefix('  Помощник '), '↪ Помощник: ');
    assert.ok(needsAgentMark(relayPrefix('Помощник')), 'строка с ↪ — со знаком шлюза: расшифровка, начатая так, получит ⚙');
  });
});

describe('реакция владельца на ответ агента (0.3.4): значки как есть, без толкования', () => {
  it('значок: эмодзи — как есть; свой эмодзи и платная — словами', () => {
    assert.equal(ownerReactionLabel({ type: 'emoji', emoji: '👍' }), '👍');
    assert.equal(ownerReactionLabel({ type: 'emoji', emoji: '❤‍🔥' }), '❤‍🔥');
    assert.equal(ownerReactionLabel({ type: 'custom_emoji', emoji: undefined }), 'свой эмодзи');
    assert.equal(ownerReactionLabel({ type: 'paid' }), '⭐ платная');
    assert.equal(ownerReactionLabel({ type: 'новый_вид' }), 'новый_вид');
  });

  it('что сделал: поставил · сменил (было …) · снял; к чему: к № или по своей инициативе', () => {
    assert.equal(ownerReactionChange(['👍'], []), '👍');
    assert.equal(ownerReactionChange(['❤'], ['👍']), '❤ (было 👍)');
    assert.equal(ownerReactionChange(['👍', '🔥'], []), '👍 🔥');
    assert.equal(ownerReactionChange([], ['👍']), 'снял 👍');
    assert.equal(ownerReactionChange([], []), 'снял реакцию');
    assert.equal(ownerReactionTarget(12), 'на твой ответ к № 12');
    assert.equal(ownerReactionTarget(null), 'на твоё сообщение');
  });

  it('текст для прежнего канала: «Реакция на твой ответ к № 12: 👍 — твой ответ: «…»»', () => {
    assert.equal(ownerReactionText({ to_seq: 12, emoji: ['👍'], old: [], excerpt: 'Да, вижу' }), 'Реакция на твой ответ к № 12: 👍 — твой ответ: «Да, вижу»');
    assert.equal(ownerReactionText({ to_seq: null, emoji: [], old: ['👍'], excerpt: null }), 'Реакция на твоё сообщение: снял 👍');
  });
});
