// Команды владельца (TECH-SPEC 5.6, Ш-6). Команда засчитывается, только если сообщение от владельца в личке, без
// пересылки, цитаты, external_reply и инлайн-бота, и текст точно совпадает (без регистра и крайних пробелов) со
// словом, /-командой из меню или текстом прежней кнопки нижней клавиатуры. Нижней клавиатуры с 0.3.1 нет (P-18: все
// команды — в меню), но тексты её кнопок («📍 Где мы» · «🆕 Нов. тема» · «⏸ Пауза» · «⛔ Стоп»)
// по-прежнему команды: у клиента клавиатура могла остаться, пока её не сняли. Исполняет команды код (этап M2); здесь —
// только распознавание.

export const COMMANDS = ['where', 'new', 'stop', 'pause', 'resume', 'status', 'help', 'agents', 'stt'] as const;
export type CommandName = (typeof COMMANDS)[number];

/**
 * Слово, /-команда, текст прежней кнопки нижней клавиатуры (до 0.3.1; если команда была на ней) и подпись в меню команд
 * (setMyCommands) — для каждой команды.
 */
export const COMMAND_WORDS: Record<CommandName, { word: string; slash: string; button?: string; menu: string }> = {
  where: { word: 'где мы', slash: '/where', button: '📍 Где мы', menu: '📍 Где мы' },
  new: { word: 'новая тема', slash: '/new', button: '🆕 Нов. тема', menu: '🆕 Новая тема' },
  stop: { word: 'стоп', slash: '/stop', button: '⛔ Стоп', menu: '⛔ Стоп' },
  pause: { word: 'пауза', slash: '/pause', button: '⏸ Пауза', menu: '⏸ Пауза' },
  resume: { word: 'продолжить', slash: '/resume', menu: '▶ Продолжить после паузы' },
  status: { word: 'статус', slash: '/status', menu: '📊 Статус' },
  help: { word: 'помощь', slash: '/help', menu: '❓ Помощь' },
  agents: { word: 'агенты', slash: '/agents', menu: '🔌 Агенты' },
  stt: { word: 'распознавание', slash: '/stt', menu: '🔇 Распознавание пересланного' },
};

/** Меню команд (кнопка меню Telegram, личка владельца) — по порядку. */
export const MENU_COMMANDS: readonly CommandName[] = ['where', 'new', 'agents', 'pause', 'stop', 'stt', 'status', 'help'];

/**
 * Команда ведущему агенту (линия, TECH-SPEC 5.20), имя — line.main_command. «/имя» — вернуться к нему (rest пуст),
 * «/имя текст» — написать ему, не меняя линию.
 */
export function parseMainCommand(text: string | null, command: string): { rest: string } | null {
  const m = text?.trim().match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/i);
  if (!m || m[1]!.toLowerCase() !== command) return null;
  return { rest: (m[2] ?? '').trim() };
}

/** Для сравнения: без регистра, крайних и двойных пробелов и без селектора варианта эмодзи (U+FE0F). */
function norm(s: string): string {
  return s.replace(/️/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Распознать команду в тексте. null — не команда. `/stop@имя_бота` тоже засчитывается: так её шлёт меню Telegram.
 * Проверку «от владельца, в личке, без чужого» делает вызывающий (Labeled.plainOwnerText).
 */
export function parseCommand(text: string | null): CommandName | null {
  if (text === null) return null;
  const t = norm(text);
  if (t === '') return null;
  for (const name of COMMANDS) {
    const w = COMMAND_WORDS[name];
    if (t === w.word) return name;
    if (w.button) {
      // Прежняя кнопка: «📍 Где мы»; тот же значок с полным словом — тоже («🆕 Новая тема», как в меню).
      const b = norm(w.button);
      if (t === b) return name;
      const icon = b.split(' ')[0]!;
      if (t === `${icon} ${w.word}`) return name;
    }
    if (t === w.slash || t.startsWith(`${w.slash}@`)) {
      if (t === w.slash || /^@[a-z0-9_]{1,64}$/.test(t.slice(w.slash.length))) return name;
    }
  }
  return null;
}

/**
 * Распознавание пересланного и аудиофайлов на время (TECH-SPEC 5.8 «Без распознавания»): `/stt` и слово «распознавание» —
 * выключить на STT_OFF_DEFAULT_MINUTES или включить, если выключено; `/stt off [срок]` и `/stt <срок>` — выключить;
 * `/stt on` — включить. Срок — `30m`, `2h` (и `мин`, `ч`); число без единицы — минуты; от минуты до суток. Не команда —
 * null; срок не понят — bad (строка владельцу с образцом).
 */
export type SttCommand = { action: 'toggle' } | { action: 'on' } | { action: 'off'; minutes: number } | { action: 'bad'; arg: string };

/** На сколько выключает /stt без срока. */
export const STT_OFF_DEFAULT_MINUTES = 60;
/** Самый долгий срок: дольше — пусть владелец выключит снова, а не забудет. */
export const STT_OFF_MAX_MINUTES = 24 * 60;

const STT_ON_WORDS = new Set(['on', 'вкл', 'включить']);
const STT_OFF_WORDS = new Set(['off', 'выкл', 'выключить']);

export function parseSttCommand(text: string | null): SttCommand | null {
  if (text === null) return null;
  const t = norm(text);
  if (t === COMMAND_WORDS.stt.word) return { action: 'toggle' };
  const m = t.match(/^\/stt(?:@[a-z0-9_]{1,64})?(?:\s+(.*))?$/);
  if (!m) return null;
  const rest = (m[1] ?? '').trim();
  if (rest === '') return { action: 'toggle' };
  const words = rest.split(' ');
  if (words.length === 1 && STT_ON_WORDS.has(rest)) return { action: 'on' };
  const spec = STT_OFF_WORDS.has(words[0]!) ? words.slice(1).join(' ') : rest;
  if (spec === '') return { action: 'off', minutes: STT_OFF_DEFAULT_MINUTES };
  const minutes = sttMinutesOf(spec);
  return minutes === null ? { action: 'bad', arg: spec } : { action: 'off', minutes };
}

/** Срок `/stt`: `30m`, `30 мин`, `2h`, `2ч`, `45` (минуты) — в минутах; вне 1…STT_OFF_MAX_MINUTES или не понят — null. */
function sttMinutesOf(spec: string): number | null {
  const m = spec.match(/^(\d{1,4})\s*(m|min|м|мин|h|ч|час|часа|часов)?$/);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] && /^[hч]/.test(m[2]) ? 60 : 1);
  return n >= 1 && n <= STT_OFF_MAX_MINUTES ? n : null;
}
