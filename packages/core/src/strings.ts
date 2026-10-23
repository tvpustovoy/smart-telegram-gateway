// Строки владельцу (TECH-SPEC §4, 5.3, 5.5–5.7) — в одном месте. Служебные строки шлюза начинаются с `⚙`, закреплённая
// строка состояния — с `📍`. Ответ агента с 0.3.2 — чистым текстом (P-26: в большинстве ответов самого агента значок не
// нужен); `💬` получает только ответ агента, который сам начинается со знака шлюза (GATEWAY_LEAD_MARKS), а слова
// другого, переданные агентом (reply.from), — «↪ <имя>: » (Ш-23). Квитанция сообщением нет ни у чего: 👀 «агент
// увидел» и 👌 «агент ответил» — реакции на сообщении владельца (с 0.3.2 без ✍: R-1, reactions.ts; с 0.3.6 ответ снимает
// реакцию, 👌 — закрыто без ответа, #52). Звук — голосовое,
// кружок (0.3), аудиофайл, видео (0.3) — получает ответом (reply) саму расшифровку — только текст, без номера и вводных,
// — или короткую причину, почему её нет (P-19: образец — бот Voice Messages). Строки, которых нет в спецификации
// дословно, помечены «M1».

import { htmlToPlain } from './markdown.js';
import { cutGraphemes } from './split.js';

export const SERVICE_MARK = '⚙';
export const AGENT_MARK = '💬';
/**
 * Пометка ответа агента, который сам начинается со знака шлюза (Ш-23; с 0.3.2 — только у такого ответа, P-26): ставится
 * перед частью, а не перед каждым ответом.
 */
export const AGENT_PREFIX = `${AGENT_MARK} `;
/** Знак «слова другого через агента» (0.3.2, P-26): «↪ Помощник: …» — шлюз ставит его перед ответом с reply.from. */
export const RELAY_MARK = '↪';
/**
 * Знаки, с которых начинаются строки шлюза и пометки источника (Ш-23; TECH-SPEC 5.5, сужение 0.3.2): `⚙` — служебная
 * строка, `📍` — закреплённая строка, `№` — квитанции прежних версий («№ 118 записал»), `↪` — слова другого через агента,
 * `💬` — сама пометка. Ответ агента, первый видимый знак которого — один из них, уходит с `💬 ` в начале: агент не
 * выдаёт свой текст за строку шлюза и за чужие слова. `👀` из прежнего списка (§5.5 до 0.3.2) не входит ⟨предл.⟩: с 0.2
 * им не начинается ни одна строка шлюза — это реакция, а не начало сообщения.
 */
export const GATEWAY_LEAD_MARKS: readonly string[] = [SERVICE_MARK, '📍', '№', RELAY_MARK, AGENT_MARK];
/**
 * Знаки стороны агента (0.3.2): `💬` (ответ агента, начатый со знака шлюза) и `↪` (слова другого через агента). Строка
 * шлюза — расшифровка голосового, ответ о звуке — ими не начинается: шлюз ставит перед ней `⚙ ` (Ш-23, guardServiceText).
 * `⚙`, `📍`, `№` в начале расшифровки (владелец сказал «номер пять» — «№ 5…») пометки не получают ⟨предл.⟩: это и есть
 * строка шлюза — выдать себя за шлюз ей незачем, а «⚙ № 5…» портило бы обычную расшифровку.
 */
export const AGENT_SIDE_MARKS: readonly string[] = [AGENT_MARK, RELAY_MARK];

/**
 * Знаки, которые выглядят пустым местом, хотя они — буквы или символы: заполнители хангыля (U+115F, U+1160, U+3164,
 * U+FFA0) и пустая клетка Брайля (U+2800). Ими «прячут» начало текста — и в имени from их тоже нет.
 */
const BLANK_LOOKING = '\\u115F\\u1160\\u3164\\uFFA0\\u2800';
/**
 * Невидимое в начале текста (Ш-23; по проверке 0.3.2 — классами Юникода, а не списком): пробелы и разделители (\s,
 * Z), управляющие (Cc), знаки форматирования (Cf — нулевая ширина, направление письма, теги U+E0000…, мягкий перенос),
 * комбинирующие знаки (M — селекторы начертания, CGJ U+034F, U+17B4/17B5, U+180B…180F: сами по себе не видны),
 * неназначенные и частные (Cn, Co: шрифт может нарисовать их пустыми) ⟨предл.⟩ и знаки BLANK_LOOKING. Лишнее в этом
 * списке стоит только лишнего `💬` перед ответом, недостающее — подделки строки шлюза.
 */
const INVISIBLE_CLASS = `\\s\\p{Z}\\p{Cc}\\p{Cf}\\p{Cn}\\p{Co}\\p{Cs}\\p{M}${BLANK_LOOKING}`;
const LEADING_INVISIBLE = new RegExp(`^[${INVISIBLE_CLASS}]+`, 'u');
/** Видимого нет вовсе: только знаки тех же классов, что LEADING_INVISIBLE (по проверке 0.3.4 — для isWholeQuote). */
const INVISIBLE_ONLY = new RegExp(`^[${INVISIBLE_CLASS}]*$`, 'u');

/** Первый видимый знак текста (простого, не HTML); пусто — ''. */
export function firstVisible(text: string): string {
  const t = text.replace(LEADING_INVISIBLE, '');
  const cp = t.codePointAt(0);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/** Текст начинается (первым видимым знаком) с одного из знаков. */
export function startsWithMark(text: string, marks: readonly string[]): boolean {
  const t = text.replace(LEADING_INVISIBLE, '');
  return marks.some((m) => t.startsWith(m));
}

/** Ответ агента (часть, простым текстом) нужно пометить `💬`: начинается со знака шлюза (Ш-23, 0.3.2). */
export function needsAgentMark(plain: string): boolean {
  return startsWithMark(plain, GATEWAY_LEAD_MARKS);
}

/** Цитата Telegram в HTML: `<blockquote>` или `<blockquote expandable>` с содержимым. */
const QUOTE_BLOCK = /<blockquote(?:\s[^>]*)?>[\s\S]*?<\/blockquote>/g;

/**
 * Всё сообщение (часть, HTML) — цитата: одна или несколько, а вне них не видно ничего. Так с 0.3.4 выглядит расшифровка
 * (R-23 а). Ответ агента такого вида получает `💬 ` (Ш-23): иначе агент выдал бы свой текст за расшифровку шлюза ⟨предл.⟩.
 * Ответ, где цитата — только часть (цитата и свой текст), на расшифровку не похож и пометки не получает.
 * «Вне цитат пусто» — по видимому тексту (теги сняты, сущности раскрыты) и теми же классами Юникода, что невидимое в
 * начале ответа (LEADING_INVISIBLE): по проверке 0.3.4 `.trim()` пропускал пустую клетку Брайля, нулевую ширину и
 * заполнители хангыля до и после цитаты — «> завтра позвонить юристу\n\n⠀» уходил без `💬`, неотличимый от расшифровки.
 */
export function isWholeQuote(html: string): boolean {
  if (!/<blockquote(?:\s[^>]*)?>/.test(html)) return false;
  return INVISIBLE_ONLY.test(htmlToPlain(html.replace(QUOTE_BLOCK, '')));
}

/** Предел имени в reply.from (0.3.2, P-26) ⟨предл.⟩. */
export const RELAY_NAME_MAX = 64;
/** Имена, которыми агент не может назвать источник слов: шлюз и служебное ⟨предл.⟩. */
const RELAY_NAME_DENIED = /шлюз|gateway|smart[\s_-]*telegram|\bstg\b|служебн/iu;
/**
 * Управляющие знаки, переводы строк, знаки форматирования (Cf: нулевая ширина, направление письма, теги) и знаки, которые
 * выглядят пустым местом (BLANK_LOOKING), в имени. Комбинирующие знаки (M) в имени можно: без них не написать «नमस्ते».
 */
const RELAY_NAME_UNSAFE = new RegExp(`[\\p{Cc}\\p{Cf}\\p{Cs}\\u2028\\u2029${BLANK_LOOKING}]`, 'u');
/** Имя для сравнения со словами шлюза: совместимая форма (NFKD — «ｇａｔｅｗａｙ» → «gateway») без комбинирующих знаков. */
function foldedName(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '');
}

/**
 * reply.from (0.3.2, P-26) — почему имя не годится; null — годится. Имя — коротко (до 64 знаков), одной строкой, без
 * управляющих и невидимых знаков; не шлюз и не служебное («шлюз», «gateway», «stg», «служебное») и без знаков шлюза
 * (⚙ 📍 № ↪ 💬 👀 📥) — агент не выдаёт чужие слова за строку шлюза ⟨предл.⟩.
 */
export function relayNameProblem(raw: string): string | null {
  const name = raw.trim();
  if (!name) return 'from: пустое имя — не указывай from, если отвечаешь сам';
  if (name.length > RELAY_NAME_MAX) return `from: имя длиннее ${RELAY_NAME_MAX} знаков`;
  if (RELAY_NAME_UNSAFE.test(name)) return 'from: в имени управляющие или невидимые знаки, перевод строки';
  if ([...GATEWAY_LEAD_MARKS, '👀', '📥'].some((m) => name.includes(m))) return 'from: в имени знак шлюза (⚙ 📍 № ↪ 💬 👀)';
  if (RELAY_NAME_DENIED.test(name) || RELAY_NAME_DENIED.test(foldedName(name))) return 'from: так называть нельзя — это имя шлюза или служебное';
  return null;
}

/** Начало ответа со словами другого (0.3.2, P-26): «↪ Помощник: » — простым текстом (имя уже проверено). */
export function relayPrefix(name: string): string {
  return `${RELAY_MARK} ${name.trim()}: `;
}

/**
 * Посылка не ушла (0.3.3; находка проверки): владелец просил файл и видит 👌 — строкой шлюза он узнаёт, что файла
 * не будет и почему ⟨предл.⟩. chat — номер чужого чата, если файл шёл не в личку владельца.
 */
export function parcelFailedText(file: string, why: string, chat: number | null): string {
  return `${SERVICE_MARK} файл ${file}${chat !== null ? ` (в чат ${chat})` : ''} не отправлен: ${why}`;
}

/** Пометка источника без текста следом (0.3.3): подпись документа, чужого файла без своей подписи — «↪ <имя>». */
export function relayLabel(name: string): string {
  return `${RELAY_MARK} ${name.trim()}`;
}

/** 0:42, 12:05 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 1 сообщение, 2 сообщения, 5 сообщений. */
export function pluralMessages(n: number): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return `${n} сообщение`;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return `${n} сообщения`;
  return `${n} сообщений`;
}

/** Начало ответа агента для reply_to.excerpt (5.4): до 200 знаков, по границе графемы. */
export function agentExcerpt(text: string, max = 200): string {
  return cutGraphemes(text.replace(/\s+/g, ' ').trim(), max).text;
}

// ——— реакция владельца на ответ агента (0.3.4; P-31, issue #34) ———
// Толкование — на стороне агента: шлюз передаёт значки как есть, без словаря «👍 = да» (issue #34).

/**
 * Значок реакции (ReactionType Bot API) строкой для агента: эмодзи — как есть; свой эмодзи (custom_emoji) и платная
 * (paid) — словами ⟨предл.⟩: картинки своего эмодзи у шлюза нет, а id агенту ничего не скажет.
 */
export function ownerReactionLabel(r: { type?: unknown; emoji?: unknown }): string {
  if (r.type === 'emoji' && typeof r.emoji === 'string' && r.emoji) return r.emoji;
  if (r.type === 'custom_emoji') return 'свой эмодзи';
  if (r.type === 'paid') return '⭐ платная';
  return typeof r.type === 'string' && r.type ? r.type : 'реакция';
}

/**
 * Что сделал владелец, словами: поставил — «👍»; сменил — «❤ (было 👍)»; снял — «снял 👍» ⟨предл.: снятие — тоже
 * событие, агент мог уже действовать по 👍⟩.
 */
export function ownerReactionChange(emoji: readonly string[], old: readonly string[]): string {
  const now = emoji.join(' ');
  const was = old.join(' ');
  if (!emoji.length) return was ? `снял ${was}` : 'снял реакцию';
  if (!old.length) return now;
  return `${now} (было ${was})`;
}

/** Куда реакция: «на твой ответ к № 12» · «на твоё сообщение» (ответ по своей инициативе, без №). */
export function ownerReactionTarget(toSeq: number | null): string {
  return toSeq !== null ? `на твой ответ к № ${toSeq}` : 'на твоё сообщение';
}

/**
 * Текст события для прежнего канала (до 0.3.4): кадр вида text, заголовок «[№ N · эп. E · слово владельца]», дальше —
 * это. Новый канал строит заголовок сам по полю reaction (format.ts).
 */
export function ownerReactionText(r: { to_seq: number | null; emoji: readonly string[]; old: readonly string[]; excerpt: string | null }): string {
  const ex = r.excerpt ? ` — твой ответ: «${r.excerpt}»` : '';
  return `Реакция ${ownerReactionTarget(r.to_seq)}: ${ownerReactionChange(r.emoji, r.old)}${ex}`;
}

/**
 * Номер эпизода в строках владельцу — `#7` (короче прежнего «Эп 7»):
 * закреплённая строка, объявления темы, «где мы», квитанции, кнопки выбора темы. Агенту — по-прежнему «эп. 7» (заголовки
 * событий, инструкции канала, CLAUDE.md папки агента).
 */
export const EPISODE_MARK = '#';

/** `#7`. */
export function episodeTag(id: number): string {
  return `${EPISODE_MARK}${id}`;
}

/** §4 п. 6, Ш-14. */
export function offlineNotice(waiting: number): string {
  return `${SERVICE_MARK} Агент сейчас не на связи. Сохраняю сообщения: ${waiting}`;
}

/** Что отложено (5.3, Ш-15): сообщение (по умолчанию) или реакция владельца (0.3.4, 5.17). */
export type DeferredWhat = 'message' | 'reaction';

/**
 * 5.3, Ш-15. Реакция (0.3.4, по проверке: падение на ней тоже считается) — «Реакцию от ЧЧ:ММ отложил: на ней…» ⟨предл.⟩:
 * «сообщение» назвало бы то, чего владелец не отправлял.
 */
export function deferredNotice(hhmm: string, what: DeferredWhat = 'message'): string {
  if (what === 'reaction') return `${SERVICE_MARK} Реакцию от ${hhmm} отложил: на ней шлюз падает. Содержимое сохранено`;
  return `${SERVICE_MARK} Сообщение от ${hhmm} отложил: на нём шлюз падает. Содержимое сохранено`;
}

/**
 * Строка «в работе» больше суток: Telegram это обновление уже не вернёт (держит 24 часа), а принять его шлюз не успел
 * (падение посреди скачивания и простой, диск полон дольше суток). Содержимое — в отложенном (M1-исправления: текст
 * строки). Реакция (0.3.4) — «Реакцию от ЧЧ:ММ…» ⟨предл.⟩.
 */
export function staleDeferredNotice(hhmm: string, what: DeferredWhat = 'message'): string {
  if (what === 'reaction') return `${SERVICE_MARK} Реакцию от ${hhmm} отложил: за сутки не удалось её записать. Содержимое сохранено`;
  return `${SERVICE_MARK} Сообщение от ${hhmm} отложил: за сутки не удалось его записать. Содержимое сохранено`;
}

/** 5.2. */
export const DISK_FULL_NOTICE = `${SERVICE_MARK} Диск полон, приём остановлен. Telegram держит сообщения 24 часа`;

/** 5.3, Ш-24. */
export const POLL_CONFLICT_NOTICE = `${SERVICE_MARK} Похоже, бота опрашивает кто-то ещё — проверь токен у BotFather`;

/** 5.3: «Стоит вебхук — строка владельцу» (M1: текст строки). */
export const WEBHOOK_NOTICE = `${SERVICE_MARK} У бота стоит вебхук: Telegram не отдаёт сообщения шлюзу. Снять вебхук — только по твоему слову`;

/** 5.2: «сбой — опрос не начинается, строка владельцу» (M1: текст строки). */
export const DB_FAILURE_NOTICE = `${SERVICE_MARK} База шлюза не открылась, приём остановлен. Подробности — stg doctor`;

// ——— M2: команды, режимы, эпизоды (5.6, 5.7) ———

/** Тема эпизода, открытого кодом (5.7 ⟨предл. принято⟩): тему называет агент. */
export const NEW_TOPIC = 'Новая тема';

/** Роль для строк владельцу — с большой буквы: «личный ассистент» → «Личный ассистент» (§4). */
export function roleLabel(role: string): string {
  const r = role.replace(/\s+/g, ' ').trim();
  return r ? r[0]!.toLocaleUpperCase('ru') + r.slice(1) : r;
}

/** Тема в одну строку. */
export function flatTopic(topic: string): string {
  return topic.replace(/\s+/g, ' ').trim();
}

/** Предел темы от агента — как у значений правил и подсказки поля ввода. */
export const AGENT_TOPIC_MAX = 64;
/** Управляющие знаки и знаки направления письма (ими можно переставить текст строки шлюза). */
const UNSAFE_LINE_G = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * Тема от агента (episode name · new) — она идёт в строки шлюза «⚙ ↪ #N · тема», «где мы», закреплённую строку: в одну
 * строку, без управляющих знаков и знаков направления письма, без пометок строк шлюза и агента (⚙, 💬), не длиннее 64
 * знаков (длиннее — с «…»). Так тема не выдаёт себя за другую строку шлюза.
 */
export function agentTopic(raw: string): string {
  const flat = raw
    .replace(UNSAFE_LINE_G, ' ')
    .replace(/[⚙💬]\uFE0F?/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const c = cutGraphemes(flat, AGENT_TOPIC_MAX);
  return c.cut ? `${c.text.trimEnd()}…` : c.text;
}

/**
 * Тема эпизода, открытого кодом, — «Новая тема» в базе (5.7 ⟨предл. принято⟩); владельцу она показывается как «тема не
 * названа»: «Новая тема · Личный ассистент» в строке владельцу непонятна.
 */
export const UNNAMED_TOPIC = 'тема не названа';

/** Тема для строк владельцу: в одну строку; не названная агентом — «тема не названа». */
export function shownTopic(topic: string): string {
  const t = flatTopic(topic);
  return t === '' || t === NEW_TOPIC ? UNNAMED_TOPIC : t;
}

/**
 * «#43 · Задачи на завтра»; роль — последней, только если она есть: «#43 · Задачи на завтра · Секретарь». Роль по
 * умолчанию («личный ассистент») вызывающий не передаёт — пустая строка (shownRole, config.ts: пока роль одна, её не
 * показывают).
 */
export function episodeLabel(id: number, topic: string, role: string): string {
  const r = roleLabel(role);
  return `${episodeTag(id)} · ${shownTopic(topic)}${r ? ` · ${r}` : ''}`;
}

/** Объявление смены эпизода агентом (§4 п. 4, 5.7): `⚙ ↪ #43 · Задачи на завтра` (другая роль — последней). */
export function episodeAnnounceText(id: number, topic: string, role: string): string {
  return `${SERVICE_MARK} ↪ ${episodeLabel(id, topic, role)}`;
}

/** После [не то] — прежний эпизод или прежняя тема (M2: текст строки). */
export function episodeReturnedText(id: number, topic: string, role: string): string {
  return `${SERVICE_MARK} ↩ ${episodeLabel(id, topic, role)}`;
}

/** [верно] под объявлением — объявление правится в одну строку без кнопок (0.2.0, J-4). */
export function episodeConfirmedText(id: number, topic: string, role: string): string {
  return `${episodeAnnounceText(id, topic, role)} — верно`;
}

/** [не то], а вернуть некуда (или выбор темы — следующим сообщением): объявление правится в одну строку без кнопок. */
export function episodeRejectedText(id: number, topic: string, role: string): string {
  return `${episodeAnnounceText(id, topic, role)} — не то`;
}

/** [не то], когда прежний эпизод закрыт больше 4 часов назад: кнопки с темами (M2: текст строки). */
export const PICK_EPISODE_TEXT = `${SERVICE_MARK} К какой теме вернуться?`;

/** «стоп» (5.6). */
export const STOPPED_TEXT = `${SERVICE_MARK} Остановлен, сообщения сохраняю`;
/** «продолжить» (и «пауза») текстом в stopped (5.6). */
export const STOP_NEEDS_BUTTON_TEXT = `${SERVICE_MARK} Стоп снимается кнопкой [продолжить]`;
// «пауза», «продолжить» из паузы и «новая тема» ответной строки не дают: режим и эпизод видны в закреплённой строке
// (0.2.0, J-4: меньше лишних сообщений в чате). Строка не закрепилась (3 попытки) — её не видно вверху
// чата: тогда эти команды отвечают временной строкой, она удаляется, как ответ «где мы» (находка проверки 0.2.0).

/** «пауза», когда строка состояния не закреплена. */
export const PAUSED_NOTE_TEXT = `${SERVICE_MARK} ⏸ Пауза: агент отвечает на твои сообщения, сам не пишет`;
/** «продолжить» из паузы, когда строка состояния не закреплена. */
export const RESUMED_NOTE_TEXT = `${SERVICE_MARK} Пауза снята`;
/** «новая тема», когда строка состояния не закреплена: `⚙ 🆕 #44 · тема не названа`. */
export function newTopicNoteText(id: number): string {
  return `${SERVICE_MARK} 🆕 ${episodeTag(id)} · ${UNNAMED_TOPIC}`;
}

/** [продолжить] нажата: строка «стоп» правится на это, без кнопок (M2: текст строки; с 0.2.0 — правкой, не новой строкой). */
export function stopLiftedText(waiting: number): string {
  return waiting > 0 ? `${SERVICE_MARK} Стоп снят, отдаю агенту накопленное: ${waiting}` : `${SERVICE_MARK} Стоп снят`;
}

/** Подписи встроенных кнопок шлюза. */
export const BUTTON_LABELS = { resume: 'продолжить', ok: 'верно', reject: 'не то' } as const;

/** Отказ на нажатие (5.9) — текст answerCallbackQuery. */
export const BUTTON_REFUSALS = { expired: 'истёк срок', used: 'уже использовано', notYours: 'не ваша кнопка' } as const;

// ——— M3: канал Claude Code (5.10, 5.11) ———

/**
 * Правила канала разговору агента (0.3.5, issue #47): что шлюз знает о них для этого разговора — получил текущую версию
 * (current), событие «правила канала» отдано и ждёт done (pending), разговор их не получал — событие отдано сейчас
 * (sent). Строкой — в ответ на where() агента (не владельцу).
 */
export interface InstructionsState {
  state: 'current' | 'pending' | 'sent';
  version: string;
  seq: number | null;
}

/** Строка «где мы» агенту о правилах канала (0.3.5, issue #47) ⟨предл.: текст⟩. */
export function instructionsWhereLine(o: InstructionsState): string {
  const n = o.seq !== null ? `№ ${o.seq} ` : '';
  switch (o.state) {
    case 'current':
      return `Правила канала: версия ${o.version} — этот разговор их получил${o.seq !== null ? ` (№ ${o.seq})` : ''}.`;
    case 'pending':
      return `Правила канала: версия ${o.version} — событие ${n}«правила канала» отдано и ждёт твоего done.`;
    case 'sent':
      return `Правила канала: версия ${o.version} — этот разговор их не получал: шлюз прислал событие ${n}«правила канала», прочти его и ответь done.`;
  }
}

/**
 * К-5: событие отдано, повтор отдан, а ответа нет ещё срок — строка владельцу (M3: текст строки). Одна строка на
 * проверку сроков, со всеми № сразу.
 */
export function silentAgentNotice(seqs: readonly number[]): string {
  const one = seqs.length === 1;
  return `${SERVICE_MARK} Агент на связи, но не ответил на ${seqList(seqs)} — отдал ${one ? 'его' : 'их'} ещё раз, ответа нет. ${one ? 'Сообщение сохранено' : 'Сообщения сохранены'}`;
}

/** «статус» и `stg status` (5.10): аренда не прошла проверку канала — сессия Claude Code открыта без флага канала. */
export const CHANNEL_UNVERIFIED_HINT = 'сессия открыта без канала — перезапусти start.sh';

/** «идёт 12 мин», «идёт 1 ч 05 мин». */
export function formatElapsed(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'меньше минуты';
  if (min < 60) return `${min} мин`;
  return `${Math.floor(min / 60)} ч ${String(min % 60).padStart(2, '0')} мин`;
}

/** Задержка для строк владельцу: «55 мс», «1,1 с». */
export function formatMs(v: number | null): string {
  if (v === null) return '—';
  return v < 1000 ? `${Math.round(v)} мс` : `${(v / 1000).toFixed(1).replace('.', ',')} с`;
}

/** Список № для строк: «№ 118, 119, 120» — не больше max, дальше «…». */
export function seqList(seqs: readonly number[], max = 10): string {
  const shown = seqs.slice(0, max).join(', ');
  return `№ ${shown}${seqs.length > max ? ', …' : ''}`;
}

// ——— M4: голос (5.5, 5.8; Ш-7, Ш-8, Ш-26) ———

/**
 * Что стало со звуком — для ответа на него (5.5; 0.3.1): распознано · не распознал · звук не скачался; у звука файлом
 * (аудиофайл, кружок, видео) — ещё «длиннее предела» (файл сохранён или не скачался) и «больше 20 МБ»; у видео не в mp4
 * — «звук не распознаю» (сведение 0.3 и 0.3.1 ⟨предл.⟩).
 */
export type SttReplyState = 'transcribed' | 'failed' | 'no_audio' | 'too_long' | 'too_long_no_file' | 'too_big' | 'not_mp4';

export interface SttReplyInput {
  /** Звук файлом — аудиофайл, кружок, видео (иначе — голосовое). */
  audio: boolean;
  /** Откуда звук файлом (0.3): аудиофайл (по умолчанию) · кружок · видео — от этого слово в отказе. */
  source?: 'audio' | 'video_note' | 'video';
  state: SttReplyState;
  /** Расшифровка — при state = transcribed. */
  transcript?: string | null;
  /** Предел распознавания аудиофайла, минуты (stt.audio_max_minutes). */
  maxMinutes: number;
}

/**
 * Слово в отказе (сведение 0.3 и 0.3.1 ⟨предл.⟩): что сохранено и что не скачалось — звук голосового, файл, кружок,
 * видео.
 */
const STT_REPLY_WORDS: Readonly<Record<'voice' | 'audio' | 'video_note' | 'video', { saved: string; lost: string }>> = {
  voice: { saved: 'звук сохранён', lost: 'звук не скачался' },
  audio: { saved: 'файл сохранён', lost: 'файл не скачался' },
  video_note: { saved: 'кружок сохранён', lost: 'кружок не скачался' },
  video: { saved: 'видео сохранено', lost: 'видео не скачалось' },
};

/**
 * Ответ шлюза на голосовое, кружок, аудиофайл или видео (5.5; P-19, образец — бот Voice Messages: ответ без вводных
 * и без номера сообщения, кнопки — после): распознано — только текст расшифровки целиком, без номера, кавычек и пометок; нет
 * расшифровки — короткая причина ⟨предл.: тексты⟩: голосовое — `Не смог распознать — звук сохранён. Срочное — текстом`
 * (звук не скачался — `Не смог распознать: звук не скачался. Срочное — текстом`); аудиофайл — `Не смог распознать — файл
 * сохранён`, `Не смог распознать: файл не скачался`, `Длиннее 15 минут — не распознаю, файл сохранён`, `Слишком большой
 * для бота (больше 20 МБ) — скачать не могу`. Кружок (0.3) — как голосовое, словом «кружок»: `Не смог распознать — кружок
 * сохранён. Срочное — текстом`; видео (0.3) — как аудиофайл, словом «видео» (`… — видео сохранено`); видео не в mp4 —
 * `Видео не в mp4 — звук не распознаю` (сведение 0.3 и 0.3.1 ⟨предл.⟩). Пометки `⚙` нет — это ответ на сообщение
 * владельца, а не строка о шлюзе. С 0.3.4 (R-23 а) расшифровка уходит цитатой — `<blockquote>`
 * Telegram, длинная — свёрнутой (`splitQuote`, отправитель): цитата и есть знак «это не слова агента», поэтому `⚙ ` перед
 * расшифровкой, начатой с `💬` или `↪` (0.3.2), больше не ставится; только если разметка не прошла (400 разбора) и цитата
 * ушла простым текстом (Ш-23). Отказы — простым текстом, без цитаты ⟨предл.⟩. Нарезка длинного — у отправителя (5.5,
 * без меток частей).
 */
export function sttReplyText(r: SttReplyInput): string {
  const source = r.audio ? (r.source ?? 'audio') : 'voice';
  const w = STT_REPLY_WORDS[source];
  const urgent = source === 'voice' || source === 'video_note' ? '. Срочное — текстом' : '';
  switch (r.state) {
    case 'transcribed':
      if (r.transcript && r.transcript.trim()) return r.transcript;
      return sttReplyText({ ...r, state: 'failed' });
    case 'failed':
      return `Не смог распознать — ${w.saved}${urgent}`;
    case 'no_audio':
      return `Не смог распознать: ${w.lost}${urgent}`;
    case 'too_long':
      return `Длиннее ${r.maxMinutes} минут — не распознаю, ${w.saved}`;
    case 'too_long_no_file':
      return `Длиннее ${r.maxMinutes} минут — не распознаю; ${w.lost}`;
    case 'too_big':
      return 'Слишком большой для бота (больше 20 МБ) — скачать не могу';
    case 'not_mp4':
      return 'Видео не в mp4 — звук не распознаю';
  }
}

/** Синтез ответа голосом не удался (5.5): ответ уходит текстом, перед ним — эта строка. */
export const VOICE_FAILED_TEXT = `${SERVICE_MARK} голос не получился`;

// ——— интерфейс чата (J-4; 0.2.0: закреплённая строка; с 0.3.1 нижней клавиатуры нет — команды в меню) ———

/**
 * Состояние агента в закреплённой строке: свободен · думает (ему отдано, ответа ещё нет) · не на связи · модель не
 * отвечает (отказ модели, D-6: агент жив, но ответить не может).
 */
export type AgentState = 'free' | 'busy' | 'offline' | 'failed';

/**
 * Значки состояния агента — только кружок, без слов («на связи» словами не нужно — хватает кружка): 🟢 свободен ·
 * 🟡 думает · ⚪ не на связи · 🔴 модель не отвечает ⟨предл.⟩.
 */
export const AGENT_STATE_MARK: Readonly<Record<AgentState, string>> = { free: '🟢', busy: '🟡', offline: '⚪', failed: '🔴' };

/**
 * Нижней клавиатуры больше нет (P-18: кнопки убраны, все команды — в меню). У
 * клиента она остаётся, пока бот её не снимет: один раз, при первом старте этой версии, — эта строка с reply_markup
 * {remove_keyboard: true} ⟨предл.: текст⟩. Строка не удаляется ⟨предл.⟩: убирает ли клиент клавиатуру снова или
 * возвращает прежнюю, если удалить сообщение, которое её сняло, — не проверено.
 */
export const KEYBOARD_REMOVED_TEXT = `${SERVICE_MARK} Кнопки убраны — команды в меню ☰`;

/** Пометка закреплённой строки состояния и значок «сколько ждут». */
export const STATUS_LINE_MARK = '📍';
export const WAITING_MARK = '📥';

export interface StatusLineInput {
  /**
   * Эпизод лички владельца: открытый или, если открытого нет, последний — с пометкой closed (следующее сообщение откроет
   * новый); null — эпизодов ещё не было вовсе.
   */
  episode: { id: number; topic: string; closed?: boolean } | null;
  /**
   * Имя роли (ownerRoleName: роль по умолчанию — пустая строка, её не показывают; другая — с большой буквы или
   * ui.role_short) — эпизода или та, с которой откроется следующий.
   */
  role: string;
  agent: AgentState;
  /** Сколько сообщений владельца ждут агента. */
  waiting: number;
  mode: 'running' | 'paused' | 'stopped';
  /** Значки агента — контекст или сжатие, лимиты (agent-state.ts, agentIndicatorParts): `🧠 16%`, `🕐 31% · 📅 64%`. */
  indicators?: readonly string[];
}

/** Пометка закрытого эпизода в закреплённой строке. */
export const CLOSED_EPISODE_MARK = 'закрыт';
/** Эпизодов в личке ещё не было ⟨предл.⟩. */
export const NO_EPISODES_YET = 'Тем ещё не было';

/**
 * Закреплённая строка состояния (5.7; J-4). Первая строка — номер эпизода и тема (её видно в шапке чата): `📍 #2 · тема
 * не названа`; номер — `#N` (короче «Эп 7»), роль по умолчанию не показывается (пока роль одна), другая — последней:
 * `📍 #2 · тема не названа · Секретарь`. Открытого эпизода нет —
 * последний с пометкой: `📍 #5 · Отпуск в мае · закрыт` (прежнее «Эпизода нет» рядом с
 * «Эп. 5» в чате читалось как противоречие; «закрыт» — сразу за темой, чтобы не обрезался в шапке чата на телефоне
 * ⟨предл.⟩); эпизодов не было вовсе — `📍 Тем ещё не было` ⟨предл.⟩. Вторая — значками: режим, если не «работает»
 * (`⛔ стоп`, `⏸ пауза`), кружок агента, сколько ждут (`📥 4`, если есть), значки агента (5.14: `🧠 16%` или `🌀`,
 * `🕐 31% · 📅 64%` — последним: внутри него свой « · »): `🟢 · 📥 4 · 🧠 16% · 🕐 31% · 📅 64%`. Начинается с 📍 — не с 💬
 * (Ш-23). Расшифровка значков — в /help.
 */
export function statusLineText(s: StatusLineInput): string {
  const role = s.role.replace(/\s+/g, ' ').trim();
  const tail = role ? ` · ${role}` : '';
  const ep = s.episode;
  const first = ep
    ? `${STATUS_LINE_MARK} ${episodeTag(ep.id)} · ${shownTopic(ep.topic)}${ep.closed ? ` · ${CLOSED_EPISODE_MARK}` : ''}${tail}`
    : `${STATUS_LINE_MARK} ${NO_EPISODES_YET}${tail}`;
  const second: string[] = [];
  if (s.mode === 'stopped') second.push('⛔ стоп');
  else if (s.mode === 'paused') second.push('⏸ пауза');
  second.push(AGENT_STATE_MARK[s.agent]);
  if (s.waiting > 0) second.push(`${WAITING_MARK} ${s.waiting}`);
  for (const p of s.indicators ?? []) second.push(p);
  return `${first}\n${second.join(' · ')}`;
}

/**
 * /help (5.6; J-4, 0.2.0; реакции, меню вместо кнопок и расшифровка ответом — 0.3.1; 0.3.2 —
 * без ✍, пометка источника ответа): что значат реакции, закреплённая строка и её значки, кто пишет (шлюз, агент, чужие
 * слова через агента), команды меню, голос и аудио. Видео mp4 тоже распознаётся (0.3) — в справке оно названо с
 * оговоркой «не файлом»: видео файлом — обычный файл (R-22) ⟨предл.: текст⟩. Реакции — по ui.clear_receipts (0.3.6,
 * #52; по умолчанию да): ответ снимает 👀, 👌 — закрыто без ответа, до следующего сообщения владельца ⟨предл.: текст⟩;
 * false — как раньше.
 */
export function helpText(o: { whereTtlMinutes: number; audioMaxMinutes: number; clearReceipts?: boolean }): string {
  return [
    `${SERVICE_MARK} Как устроен чат`,
    o.clearReceipts === false
      ? 'На твоём сообщении: 👀 агент увидел · 👌 агент ответил. Агент не на связи — на сообщении ничего: в строке вверху ⚪ и 📥 N.'
      : 'На твоём сообщении: 👀 агент увидел; ответил — 👀 снимается, ответ в чате · 👌 агент закрыл без ответа, снимется, когда напишешь снова. Агент не на связи — на сообщении ничего: в строке вверху ⚪ и 📥 N.',
    `Кто пишет: ответ агента — обычным текстом; ${SERVICE_MARK} — строка шлюза; «${RELAY_MARK} Имя:» — агент передаёт слова другого; ${AGENT_MARK} — ответ агента, который сам начинается со знака шлюза.`,
    `Вверху — закреплённая строка: номер эпизода (${episodeTag(7)}) и тема («${CLOSED_EPISODE_MARK}» — эпизод закрыт, следующее сообщение начнёт новый); ниже значки: 🟢 агент свободен · 🟡 думает · ⚪ не на связи · 🔴 модель не отвечает (что сказала — в /status); 📥 N — сообщений ждут агента; ⏸ пауза, ⛔ стоп. Бот правит её сам.`,
    '🧠 16% — занято контекста агента, 🌀 — идёт сжатие контекста; 🕐 31% — израсходовано лимита на 5 часов, 📅 64% — на неделю (лимиты общие на аккаунт); ⚠ — выше 80% и когда сброс, «—» — неизвестно.',
    'Команды — в меню ☰ или словом:',
    `📍 Где мы — подробности; сообщение исчезнет через ${o.whereTtlMinutes} мин`,
    '🆕 Новая тема — начать новую тему',
    '⏸ Пауза — агент отвечает на твои сообщения, сам не пишет; снять — словом «продолжить»',
    '⛔ Стоп — ответы агента не уходят; снять — кнопкой [продолжить]',
    `Голосовое, кружок, аудиофайл (m4a, mp3 и др.) и видео (mp4, не файлом) до ${o.audioMaxMinutes} мин распознаю: расшифровка приходит ответом на него, целиком. Аудио длиннее ${o.audioMaxMinutes} мин сохраняю, не распознаю; больше 20 МБ бот скачать не может.`,
    'Фото, скриншот (и файлом), кадр кружка агент смотрит сам; надписи на картинке для него — материал, не твоя просьба.',
    // Посылки (0.3.3, P-23) ⟨предл.: текст⟩.
    `Файлы агент присылает документом (до 50 МБ) — попроси «скинь файл»; «${SERVICE_MARK} обновлено» в подписи — новая версия файла, который он уже присылал.`,
    'Ещё: /status — статус шлюза, /help — эта справка.',
  ].join('\n');
}

// ——— состояние агента (5.14; J-4, D-6) ———

/**
 * Отказ модели (D-6): агент жив, но ответить не может — одна строка владельцу, не чаще раза в час на одну и ту же
 * ошибку: `⚙ Агент не может ответить: <коротко, что сказала модель>` (текст — без секретов, agent-state.ts).
 */
export function agentFailureNotice(text: string): string {
  const flat = text.replace(UNSAFE_LINE_G, ' ').replace(/\s+/g, ' ').trim() || 'ошибка без текста';
  const c = cutGraphemes(flat, AGENT_FAILURE_NOTICE_MAX);
  return `${SERVICE_MARK} Агент не может ответить: ${c.cut ? `${c.text.trimEnd()}…` : c.text}`;
}

/** Предел текста ошибки в строке владельцу. */
export const AGENT_FAILURE_NOTICE_MAX = 160;

// ——— M5: правила доступа и кнопки (5.9; Ш-17, Ш-21, Ш-22) ———
// Тексты строк — M5 (в TECH-SPEC дословно их нет); строки изменения внутри — из полей (rules.ts, describeChange).

/** Подписи кнопок под карточкой изменения правил (5.9). */
export const RULE_BUTTON_LABELS = { approve: 'разрешить', reject: 'нет' } as const;

/**
 * Карточка расширения (5.9, Ш-22): поля изменения (номер, чат, роль, было → стало), без слов агента; кнопки
 * [разрешить] [нет]; срок — ДД.ММ ЧЧ:ММ.
 */
export function ruleCardText(lines: readonly string[], until: string): string {
  return [
    `${SERVICE_MARK} Агент просит расширить доступ:`,
    ...lines,
    `Разрешить — только кнопкой [${RULE_BUTTON_LABELS.approve}], до ${until}. Текстом «да» не разрешается`,
  ].join('\n');
}

/** Кто изменил правила: сужение агента (сразу) · расширение по кнопке владельца · ручная правка rules.yaml. */
export type RulesChangedBy = 'agent' | 'owner_button' | 'owner_file';

/** Строка владельцу о каждом изменении правил (5.9). */
export function rulesChangedText(by: RulesChangedBy, lines: readonly string[]): string {
  const head =
    by === 'agent'
      ? 'Правила сужены агентом — применено сразу:'
      : by === 'owner_button'
        ? 'Правила изменены — ты разрешил:'
        : 'Правила изменены правкой rules.yaml:';
  return [`${SERVICE_MARK} ${head}`, ...lines].join('\n');
}

/** Агент просил убрать или поменять владельца (Ш-21): отказ — строкой владельцу. */
export function ruleForbiddenText(reason: string, lines: readonly string[]): string {
  return [`${SERVICE_MARK} Агент просил изменить правила — отказано: ${reason}`, ...lines].join('\n');
}

/** [нет] под карточкой. */
export const RULE_REJECTED_TEXT = `${SERVICE_MARK} Изменение правил отклонено — не применено`;

/** [разрешить], а применить нельзя: правила с тех пор поменялись, rules.yaml правлен вручную. */
export function ruleNotAppliedText(reason: string): string {
  return `${SERVICE_MARK} Изменение правил не применено: ${reason}`;
}

/** rules.yaml не разобрался при старте — шлюз держит прежнюю рабочую копию (одна строка на одну поломку). */
export function rulesFileBrokenText(problem: string): string {
  return `${SERVICE_MARK} rules.yaml не прочитан (${problem}) — действуют прежние правила. Подробности — stg doctor`;
}
