// Команды владельца (TECH-SPEC 5.6, Ш-6). Команда засчитывается, только если сообщение от владельца в личке, без
// пересылки, цитаты, external_reply и инлайн-бота, и текст точно совпадает (без регистра и крайних пробелов) со
// словом, /-командой из меню или текстом прежней кнопки нижней клавиатуры. Нижней клавиатуры с 0.3.1 нет (P-18: все
// команды — в меню), но тексты её кнопок («📍 Где мы» · «🆕 Нов. тема» · «⏸ Пауза» · «⛔ Стоп»)
// по-прежнему команды: у клиента клавиатура могла остаться, пока её не сняли. Исполняет команды код (этап M2); здесь —
// только распознавание.

export const COMMANDS = ['where', 'new', 'stop', 'pause', 'resume', 'status', 'help'] as const;
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
};

/** Меню команд (кнопка меню Telegram, личка владельца) — по порядку. */
export const MENU_COMMANDS: readonly CommandName[] = ['where', 'new', 'pause', 'stop', 'status', 'help'];

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
