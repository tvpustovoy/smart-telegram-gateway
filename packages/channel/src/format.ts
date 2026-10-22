// Событие шлюза → уведомление канала `notifications/claude/channel` (TECH-SPEC 5.11). content — строка с заголовком в
// квадратных скобках: «[№ 118 · эп. 42 · слово владельца] текст»; чужое — «[№ 119 · эп. 42 · чужое · переслано из
// канала «…»] текст»; реплай — «[№ 140 · эп. 42 · слово владельца · ответ на твоё сообщение к № 118: «начало…»] текст».
// meta — только строки (Claude Code кладёт их атрибутами тега <channel>; ключи — латиница и «_»): seq, kind, trust,
// mixed, redelivery, reply_to, episode, topic, role, chat, media; пустые не кладутся.
// Картинка (0.3): в заголовке — подсказка «фото — посмотреть: media(seq: N)» (у кружка и видео — «кадр: media(seq: N)»);
// звук файлом — «кружок», «видео», «аудиофайл»; расшифровка своего аудиофайла и кружка — «(расшифровка аудиофайла)»,
// чужого — «(расшифровка аудиофайла — чужое)» (R-2, R-20); видео не в mp4 — «(видео: звук не распознаётся —
// формат не mp4)» ⟨предл.⟩.
// Реакция владельца на твой ответ (0.3.4): «[№ 15 · эп. 7 · реакция владельца на твой ответ к № 12: 👍] твой ответ:
// «…»»; сменил — «❤ (было 👍)», снял — «снял 👍»; meta.kind = reaction, meta.trust = owner. Шлюз шлёт её кадром вида text
// с полем reaction (прежний канал читает текст); толкование — на стороне агента, ответ не обязателен (instructions).
// Правила канала (0.3.5, issue #47): «[№ 57 · правила канала, версия 1a2b3c4d5e6f] Текущие правила канала … done(seqs: [57]).»
// и следом — сами instructions этого канала целиком (свои, той же версии: шлюз шлёт только версию); meta.kind =
// instructions, meta.version.
// Материал без слов владельца (0.3.6, issue #51): шлюз держит его окном и отдаёт вместе со словами владельца — в заголовке
// «слова владельца — следом, № M» (слова — следующее событие), «слова владельца — раньше, № K» (сказал до материала) или
// «слов владельца не было за 1 мин» (окно кончилось без слов; сколько материал на деле ждал); meta.material = after ·
// before · none, meta.words_seq. Своё фото или файл владельца без подписи в таком событии — «чужое (фото)», а не «слово
// владельца + чужое (фото)»: его слов в нём нет (рядом стояло бы «слов владельца не было»); meta.trust — untrusted,
// meta.mixed — false. Его текст из одних ссылок (поделился страницей; core/material.ts, linksOnly) с пометкой — «ссылка
// владельца» («ссылки владельца»): прислал он, но слов в нём нет; meta.trust — тоже untrusted (в базе и в кадре — owner).
// Без пометки (окно 0, прежний шлюз; его ссылка реплаем на сообщение агента — ответ, шлюз отдаёт её без пометки) — метка
// прежняя: «слово владельца».
// Слова владельца к материалу после окна (0.3.6): реплай на материал (reply_to.material) — «слова к материалу № N» вместо
// «ответ на своё сообщение № N» (meta.to_material); первые слова после материала, ушедшего без слов (after_material), —
// «слова после материала № N» или «№ N, K» (meta.after_material). Прежний шлюз полей не шлёт — заголовок прежний.
// Здесь же — слова, которыми инструменты возвращают модели исход.

import { cutGraphemes, formatDuration, formatElapsed, linksOnly, localTime, ownerReactionChange, ownerReactionTarget, type EventMessage, type Mode } from 'stg-core';
import { INSTRUCTIONS, INSTRUCTIONS_VERSION } from './instructions.js';

export const CHANNEL_NOTIFICATION = 'notifications/claude/channel';

export interface ChannelNotice {
  content: string;
  meta: Record<string, string>;
}

const TRUST_WORDS: Record<NonNullable<EventMessage['trust']>, string> = {
  owner: 'слово владельца',
  untrusted: 'чужое',
  owner_forward: 'своё пересланное',
};

const ATTACHMENT_WORDS: Record<EventMessage['attachments'][number]['kind'], string> = {
  quote: 'цитата',
  external_reply: 'ответ на сообщение из другого чата',
  via_bot: 'через инлайн-бота',
  photo: 'фото',
  document: 'файл',
  voice: 'голос',
};

const CLOSE_WORDS: Record<string, string> = {
  idle: 'тишина',
  owner_new_topic: 'владелец начал новую тему',
  telegram_topic: 'другая тема Telegram',
  agent_new: 'ты открыл новую тему',
  owner_rejected: 'владелец отклонил смену',
  role_change: 'смена роли',
};

// ——— чужой текст не подделывает заголовок (J-6, Ш-4, Ш-20) ———
// Заголовок события — первая строка уведомления в квадратных скобках; метку доверия модель читает в нём (и в атрибуте
// trust). Текст сообщения, имя пересылки, тема и выдержки приходят от людей и агента, поэтому:
// - управляющие знаки (кроме перевода строки и табуляции) и знаки направления письма убираются;
// - «[№ …» и «[шлюз …» внутри текста пишутся с «［» (полноширинная скобка): похожего на заголовок в теле нет;
// - имя, тема и выдержка — в «…», в одну строку, без «[», «]», ««», «»» и без «·» (разделитель заголовка), с пределом длины.

/** Управляющие знаки (кроме \n и \t) и знаки направления письма. */
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
/** «[№» и «[шлюз» (в том числе через пробелы и знаки нулевой ширины) — начало заголовка события или строки шлюза. */
const HEADER_LIKE_RE = /\[([\s\u200B-\u200D\u2060\uFEFF]*)(№|шлюз)/giu;

/** Текст сообщения: без управляющих знаков и без похожего на заголовок события. */
export function neutralText(text: string): string {
  return text.replace(CONTROL_RE, '').replace(HEADER_LIKE_RE, '［$1$2');
}

/** Значение внутри заголовка: в одну строку, без скобок, кавычек-ёлочек и «·»; длиннее max — с «…». */
export function headerValue(s: string, max: number): string {
  const flat = s
    .replace(CONTROL_RE, ' ')
    .replace(/[\[\]«»]/g, '')
    .replace(/·/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
  const c = cutGraphemes(flat, max);
  return c.cut ? `${c.text.trimEnd()}…` : c.text;
}

/** Предел имени пересылки, темы и выдержки в заголовке. */
const NAME_MAX = 64;
const TOPIC_MAX = 128;
const EXCERPT_MAX = 200;

function quoted(s: string, max = NAME_MAX): string {
  return `«${headerValue(s, max)}»`;
}

function forwardWords(f: NonNullable<EventMessage['forward']>): string {
  const name = f.from_name ? ` ${quoted(f.from_name)}` : '';
  switch (f.origin_type) {
    case 'user':
      return `переслано от${name || ' пользователя'}`;
    case 'hidden_user':
      return `переслано от скрытого отправителя${name}`;
    case 'chat':
      return `переслано из чата${name}`;
    case 'channel':
      return `переслано из канала${name}`;
  }
}

/**
 * Реплай. ownWords — в событии слова владельца (0.3.6): реплай на материал — «слова к материалу № N»; иначе (чужое, его
 * материал без слов) — «ответ на материал № N».
 */
function replyWords(r: NonNullable<EventMessage['reply_to']>, currentTopic: string | null, ownWords: boolean): string {
  const seq = r.event_seq ?? null;
  let s: string;
  switch (r.kind) {
    case 'agent':
      s = `ответ на твоё сообщение${seq !== null ? ` к № ${seq}` : ''}${r.excerpt ? `: ${quoted(r.excerpt, EXCERPT_MAX)}` : ''}`;
      break;
    case 'receipt':
      s = `ответ на квитанцию${seq !== null ? ` № ${seq}` : ''}`;
      break;
    case 'service':
      s = `ответ на строку шлюза${seq !== null ? ` к № ${seq}` : ''}`;
      break;
    case 'owner':
      if (r.material) s = `${ownWords ? 'слова к материалу' : 'ответ на материал'}${seq !== null ? ` № ${seq}` : ''}`;
      else s = `ответ на своё сообщение${seq !== null ? ` № ${seq}` : ''}`;
      break;
    default:
      s = 'ответ на сообщение, которого у шлюза нет';
  }
  if (r.episode_topic && r.episode_topic !== currentTopic) s += ` (тема ${quoted(r.episode_topic, TOPIC_MAX)})`;
  return s;
}

/** Откуда звук файлом: аудиофайл · кружок · видео (0.3; прежний шлюз поля source не шлёт — аудиофайл). */
function soundSource(audio: EventMessage['audio']): 'audio' | 'video_note' | 'video' {
  return audio?.source === 'video_note' ? 'video_note' : audio?.source === 'video' ? 'video' : 'audio';
}

/** Звук файлом в родительном падеже: «расшифровка кружка». */
const SOUND_OF: Record<'audio' | 'video_note' | 'video', string> = { audio: 'аудиофайла', video_note: 'кружка', video: 'видео' };

function mediaWord(ev: EventMessage): string | null {
  const { kind, audio, media } = ev;
  let word: string | null = null;
  if (kind === 'photo') word = 'фото';
  else if (kind === 'voice') word = 'голосовое';
  else if (kind === 'document') {
    if (audio) word = { audio: 'аудиофайл', video_note: 'кружок', video: 'видео' }[soundSource(audio)];
    else if (media?.what === 'image') word = 'изображение файлом';
    else if (media?.what === 'video_note') word = 'кружок';
    else if (media?.what === 'video') word = 'видео';
    else word = 'файл';
  }
  // Картинку агент смотрит сам (0.3): у кружка и видео — кадр-обложка.
  if (media) {
    const frameOnly = media.what === 'video_note' || media.what === 'video';
    if (frameOnly && media.frame === false) return word;
    const hint = frameOnly ? `кадр: media(seq: ${ev.seq})` : `посмотреть: media(seq: ${ev.seq})`;
    return word ? `${word} — ${hint}` : hint;
  }
  return word;
}

function bodyOf(ev: EventMessage): string {
  const text = ev.text !== null ? neutralText(ev.text) : null;
  if (ev.kind === 'voice') {
    // Расшифровку делает шлюз (5.8); не вышло — пометка «не распознано», звук у шлюза.
    const transcript = ev.transcript !== null ? neutralText(ev.transcript) : null;
    if (transcript) return text ? `${transcript}\n(подпись: ${text})` : transcript;
    return text ? `(голосовое не распознано; подпись: ${text})` : '(голосовое не распознано)';
  }
  if (ev.kind === 'document' && ev.transcript !== null) {
    // Звук файлом (J-2; 0.3 — кружок, видео): расшифровку делает шлюз. Свой аудиофайл и свой кружок без пересылки —
    // слово владельца (R-2, R-20); пересланный, чужой и видео — «чужое» (Ш-20). Подпись — его слово.
    const transcript = neutralText(ev.transcript);
    const own = ev.attachments.find((a) => a.kind === 'document')?.trust === 'owner';
    const mark = `(расшифровка ${SOUND_OF[soundSource(ev.audio)]}${own ? '' : ' — чужое'})`;
    return text ? `${mark} ${transcript}\n(подпись: ${text})` : `${mark} ${transcript}`;
  }
  if (ev.kind === 'document' && ev.audio) {
    // Звук файлом не распознан — почему; файл (если скачан) у шлюза.
    const a = ev.audio;
    const source = soundSource(a);
    const len = a.seconds !== null ? ` ${formatDuration(a.seconds)}` : '';
    const what = source === 'video_note' ? 'кружок' : `${source === 'video' ? 'видео' : 'аудиофайл'} ${quoted(neutralText(a.name), TOPIC_MAX)}`;
    const why =
      a.state === 'too_long'
        ? `длиннее ${a.max_minutes} минут — не распознаю; файл у шлюза`
        : a.state === 'too_big'
          ? 'больше 20 МБ — бот не может его скачать'
          : 'распознать не вышло; файл у шлюза, если скачался';
    const note = `(${what}${len}: ${why})`;
    return text ? `${note}\n(подпись: ${text})` : note;
  }
  if (ev.kind === 'document' && ev.media?.what === 'video') {
    // Видео без поля audio — не mp4 (или без файла): звук не распознаётся (перекодировать нечем) ⟨предл.⟩ — иначе агент
    // решит, что в видео ничего не говорили.
    const note = '(видео: звук не распознаётся — формат не mp4)';
    return text ? `${note}\n(подпись: ${text})` : note;
  }
  if (text) return text;
  // Картинку агент смотрит сам — media(seq) (0.3); прочий файл — у шлюза.
  if (ev.media) return '(без подписи)';
  if (ev.kind === 'photo' || ev.kind === 'document') return '(без подписи; содержимое файла у шлюза)';
  return '(без текста)';
}

/**
 * Материал владельца без его слов, отданный с пометкой окна (0.3.6, issue #51): фото, файл, видео без подписи, текст из
 * одних ссылок. Метка сообщения — его (owner), но слов в нём нет: агенту — как чужое.
 */
function ownerMaterialWithoutWords(ev: EventMessage): boolean {
  return ev.trust === 'owner' && !!ev.material && materialWords(ev.material) !== null;
}

/**
 * Метка своего текста из одних ссылок с пометкой окна (0.3.6, issue #51; поделился страницей): «ссылка владельца» или
 * «ссылки владельца» — прислал он, слов нет; не «чужое»: со стороны его не присылали, и не «слово владельца»: рядом стоит
 * «слов владельца не было». Не из одних ссылок — null.
 */
function ownerLinksLabel(ev: EventMessage): string | null {
  const n = linksOnly(ev.text);
  return n === 0 ? null : n === 1 ? 'ссылка владельца' : 'ссылки владельца';
}

/** meta: только строки, пустые не кладутся. */
function metaOf(ev: EventMessage): Record<string, string> {
  const bare = ownerMaterialWithoutWords(ev);
  const m: Record<string, string> = { seq: String(ev.seq), kind: ev.kind, mixed: String(bare ? false : ev.mixed), redelivery: String(ev.redelivery) };
  if (ev.trust) m.trust = bare ? 'untrusted' : ev.trust;
  if (ev.reply_to) m.reply_to = ev.reply_to.event_seq !== null && ev.reply_to.event_seq !== undefined ? `${ev.reply_to.kind}:${ev.reply_to.event_seq}` : ev.reply_to.kind;
  if (ev.episode) {
    m.episode = String(ev.episode.id);
    m.topic = headerValue(ev.episode.topic, TOPIC_MAX);
    m.role = headerValue(ev.episode.role, NAME_MAX);
  }
  if (ev.chat) m.chat = ev.chat.kind;
  if (ev.edit_of !== null) m.edit_of = String(ev.edit_of);
  if (ev.media) m.media = headerValue(ev.media.what, NAME_MAX);
  if (ev.material) {
    m.material = headerValue(ev.material.words, NAME_MAX);
    if (ev.material.words_seq !== null) m.words_seq = String(ev.material.words_seq);
  }
  // Слова к материалу после окна (0.3.6): реплай на материал и первые слова после материала, ушедшего без слов.
  if (ev.reply_to?.material && ev.reply_to.event_seq !== null && ev.reply_to.event_seq !== undefined) m.to_material = String(ev.reply_to.event_seq);
  if (ev.after_material?.length) m.after_material = ev.after_material.join(',');
  if (ev.reaction) {
    // Реакция владельца (0.3.4): кадр вида text, а для модели — reaction.
    m.kind = 'reaction';
    m.reaction = headerValue(ownerReactionChange(ev.reaction.emoji, ev.reaction.old), NAME_MAX);
    if (ev.reaction.to_seq !== null) m.reply_to = `agent:${ev.reaction.to_seq}`;
  }
  return m;
}

/**
 * Реакция владельца на ответ агента (0.3.4; P-31, issue #34): «[№ N · эп. E ·
 * реакция владельца на твой ответ к № M: 👍] твой ответ: «начало…»». Значки — как есть, без толкования: что значит 👍
 * здесь, решает агент.
 */
function formatReaction(ev: EventMessage & { reaction: NonNullable<EventMessage['reaction']> }, meta: Record<string, string>): ChannelNotice {
  const r = ev.reaction;
  const parts = [`№ ${ev.seq}`];
  if (ev.episode) parts.push(`эп. ${ev.episode.id}`);
  parts.push(`реакция владельца ${ownerReactionTarget(r.to_seq)}: ${headerValue(ownerReactionChange(r.emoji, r.old), NAME_MAX)}`);
  if (ev.redelivery) parts.push('повтор: проверь, не сделано ли уже');
  const body = r.excerpt ? `твой ответ: ${quoted(neutralText(r.excerpt), EXCERPT_MAX)}` : '(начала ответа у шлюза нет)';
  return { content: `[${parts.join(' · ')}] ${body}`, meta };
}

/**
 * Правила канала (0.3.5, issue #47): разговору, который их не получал (Claude Code не передаёт instructions
 * продолженному разговору), — текущие instructions этого канала целиком. Текст — свой: шлюз шлёт только версию, а
 * событие правил получает лишь канал, который назвал её в hello, — то есть этот же; версия в заголовке — своя.
 */
function formatInstructions(ev: EventMessage, meta: Record<string, string>): ChannelNotice {
  const head = `[№ ${ev.seq} · правила канала, версия ${INSTRUCTIONS_VERSION}${ev.redelivery ? ' · повтор' : ''}]`;
  const lead =
    'Текущие правила канала smart-telegram-gateway — ниже целиком. Claude Code не передаёт их продолженному разговору, поэтому их присылает шлюз. ' +
    `Они заменяют прежние правила этого канала, если ты их видел. Прочти и ответь done(seqs: [${ev.seq}]).`;
  return { content: `${head} ${lead}\n\n${INSTRUCTIONS}`, meta: { ...meta, version: INSTRUCTIONS_VERSION } };
}

/** Сколько материал ждал слов владельца (после «за»): «40 с», «2 мин», «1 ч 05 мин». */
export function materialWait(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} с` : formatElapsed(ms);
}

/**
 * Пометка материала без слов владельца (0.3.6, issue #51): слова пришли следом · были раньше · окна не хватило. Значение
 * words — строкой (новое значение прежний канал не сломает: пометки нет).
 */
function materialWords(m: NonNullable<EventMessage['material']>): string | null {
  const n = m.words_seq !== null ? `, № ${m.words_seq}` : '';
  if (m.words === 'after') return `слова владельца — следом${n}`;
  if (m.words === 'before') return `слова владельца — раньше${n}`;
  if (m.words === 'none') return `слов владельца не было${m.waited_ms !== null ? ` за ${materialWait(m.waited_ms)}` : ''}`;
  return null;
}

/** Слова после материала, ушедшего без слов (0.3.6, issue #51): «слова после материала № N» или «№ N, K». */
function afterMaterialWords(seqs: readonly number[] | undefined): string | null {
  return seqs?.length ? `слова после материала № ${seqs.join(', ')}` : null;
}

/** Событие → уведомление канала. */
export function formatEvent(ev: EventMessage): ChannelNotice {
  const meta = metaOf(ev);
  if (ev.kind === 'probe') {
    // Код — только здесь, в тексте события: done на пробу засчитывается с ним (5.10). В журнал канала он не пишется.
    const code = ev.code !== undefined ? `, code: "${ev.code}"` : '';
    return {
      content: `[№ ${ev.seq} · проверка канала] Это проверочное событие шлюза: ответь done(seqs: [${ev.seq}]${code}) и больше ничего не делай.`,
      meta,
    };
  }
  if (ev.kind === 'instructions') return formatInstructions(ev, meta);
  if (ev.reaction) return formatReaction({ ...ev, reaction: ev.reaction }, meta);
  const ep = ev.episode;
  if (ev.kind === 'episode_closed' && ep) {
    const why = ep.close_reason ? `: ${CLOSE_WORDS[ep.close_reason] ?? ep.close_reason}` : '';
    const head = `[№ ${ev.seq} · эп. ${ep.id} закрыт${why}${ev.redelivery ? ' · повтор: проверь, не прислал ли итог уже' : ''}]`;
    return { content: `${head} Тема ${quoted(ep.topic, TOPIC_MAX)}. Пришли итог эпизода: episode_summary(episode_id: ${ep.id}, text: …).`, meta };
  }
  if (ev.kind === 'episode_reopened' && ep) {
    const head = `[№ ${ev.seq} · эп. ${ep.id} снова открыт: владелец нажал [не то]${ev.redelivery ? ' · повтор' : ''}]`;
    return { content: `${head} Разговор вернулся к теме ${quoted(ep.topic, TOPIC_MAX)}.`, meta };
  }
  const parts = [`№ ${ev.seq}`];
  if (ep) parts.push(ep.new ? `эп. ${ep.id} (новый)` : `эп. ${ep.id}`);
  if (ev.kind === 'edit') parts.push(ev.edit_of !== null ? `правка к № ${ev.edit_of}` : 'правка, исходного нет');
  const media = mediaWord(ev);
  if (media) parts.push(media);
  let trust = ev.trust ? TRUST_WORDS[ev.trust] : 'без метки';
  const foreign = ev.attachments.filter((a) => a.trust !== 'owner' && a.kind !== 'via_bot').map((a) => ATTACHMENT_WORDS[a.kind]);
  const foreignWords = [...new Set(foreign)].join(', ');
  if (ownerMaterialWithoutWords(ev)) trust = foreign.length ? `${TRUST_WORDS.untrusted} (${foreignWords})` : (ownerLinksLabel(ev) ?? TRUST_WORDS.untrusted);
  else if (ev.mixed && foreign.length) trust += ` + чужое (${foreignWords})`;
  else if (ev.mixed) trust += ' + чужое';
  parts.push(trust);
  if (ev.attachments.some((a) => a.kind === 'via_bot')) parts.push('через инлайн-бота');
  if (ev.forward) parts.push(forwardWords(ev.forward));
  if (ev.reply_to) parts.push(replyWords(ev.reply_to, ep?.topic ?? null, ev.trust === 'owner' && !ownerMaterialWithoutWords(ev)));
  const words = ev.material ? materialWords(ev.material) : null;
  if (words) parts.push(words);
  const after = afterMaterialWords(ev.after_material);
  if (after) parts.push(after);
  if (ev.redelivery) parts.push('повтор: проверь, не сделано ли уже');
  return { content: `[${parts.join(' · ')}] ${bodyOf(ev)}`, meta };
}

/** Смена режима шлюза → служебное уведомление в сессию (5.10: при stopped канал толкает «стоп»). */
export function formatMode(state: Mode, previous: Mode | null): ChannelNotice | null {
  const meta = { kind: 'mode', state };
  if (state === 'stopped') {
    return {
      content: '[шлюз · стоп] Владелец сказал «стоп»: твои ответы не уходят, новых событий не будет до его кнопки [продолжить]. Прекрати текущее дело.',
      meta,
    };
  }
  if (state === 'paused') {
    return {
      content: '[шлюз · пауза] Владелец поставил паузу: ответы на его сообщения уходят, сообщения по своей инициативе (reply без seq) придерживаются до «продолжить».',
      meta,
    };
  }
  if (previous === 'stopped') return { content: '[шлюз · стоп снят] Владелец нажал [продолжить]: можно работать дальше; накопленное придёт по порядку.', meta };
  if (previous === 'paused') return { content: '[шлюз · пауза снята] Сообщения по своей инициативе снова уходят сразу.', meta };
  return null;
}

// ——— исходы инструментов словами (5.11) ———

export const OUTCOME = {
  sent: 'отправлено',
  held: 'пауза: сообщение придержано — уйдёт, когда владелец скажет «продолжить»',
  stopped: 'Владелец сказал стоп — ответ не отправлен. Прекрати текущее дело',
  gatewayDown: 'шлюз недоступен — повтори позже',
  noAnswer: 'шлюз не ответил — повтори позже (сначала проверь where(): могло и дойти)',
  /** Запрос ушёл, а связь оборвалась до ответа шлюза: могло дойти. */
  lostAfterSend: 'связь со шлюзом оборвалась после отправки — могло дойти; сначала проверь where(), прежде чем повторять',
  /** То же для reply: повтор тем же текстом шлюз второй раз не отправит. */
  replyLost:
    'связь со шлюзом оборвалась после отправки — ответ мог уйти. Повтори тот же reply с тем же текстом, когда шлюз будет доступен: второй раз шлюз его не отправит',
  mismatch: 'версии протокола шлюза и канала не совпали — обнови шлюз и канал',
  /** Шлюз старше 0.3: инструмента media у него нет. */
  mediaUnsupported: 'шлюз старой версии: картинки (media) не умеет — скажи владельцу, что шлюз нужно обновить',
  /** Шлюз старше 0.3.2: поля from у reply нет — ответ не отправлен. */
  fromUnsupported:
    'шлюз старой версии: from (чьи слова передаёшь) не знает — ответ не отправлен. Повтори reply без from, а чьи это слова, напиши в начале текста',
  /** Шлюз старше 0.3.3: посылок (send_file) нет — файл не отправлен. */
  filesUnsupported: 'шлюз старой версии: файлы (send_file) отправлять не умеет — файл не отправлен. Скажи владельцу, что шлюз нужно обновить, и где лежит файл',
  /** send_file после «стопа» или с прерванного хода. */
  fileStopped: 'Владелец сказал стоп — файл не отправлен. Прекрати текущее дело',
  /** Повтор send_file с тем же ключом (после обрыва): второй раз шлюз не отправлял — что стало с первым вызовом. */
  fileRepeated: 'этот send_file шлюз уже принял до обрыва связи и второй раз не отправлял:',
  fileRepeatedHint: 'Если после того вызова ты менял файл и владельцу нужна новая версия — вызови send_file ещё раз: это будет новая отправка',
  /** То же, что replyLost, для send_file. */
  fileLost:
    'связь со шлюзом оборвалась после отправки — файл мог уйти. Повтори тот же send_file с тем же path и подписью, когда шлюз будет доступен: второй раз шлюз его не отправит',
} as const;

export function busyText(since: number | null, timezone: string): string {
  return `очередь держит другая сессия${since !== null ? ` (с ${localTime(since, timezone)})` : ''}`;
}

export const UNVERIFIED_TEXT =
  'сессия открыта без канала: события шлюза сюда не доходили. Переподключаюсь — придёт проверочное событие, ответь на него done';
