// Живая лента разговора для окна терминала (#55): что пришло из Telegram, что делает агент (команды, вызовы
// инструментов шлюза, краткие рассуждения, если Codex их отдаёт), что ушло владельцу. Одна строка — одно событие, со
// временем. Без секретов: код проверочного события, вывод команд и окружение в ленту не попадают. Технический журнал —
// отдельно (stderr).

export type FeedKind =
  /** Событие из Telegram → агенту. */
  | 'in'
  /** Ответ владельцу (reply, send_file). */
  | 'out'
  /** Другой инструмент шлюза (done, where, episode, media, rule, episode_summary). */
  | 'tool'
  /** Команда в песочнице. */
  | 'cmd'
  /** Правка файла. */
  | 'file'
  /** Краткое рассуждение модели. */
  | 'think'
  /** Обычный текст хода (владелец его не видит). */
  | 'text'
  /** Начало и конец хода. */
  | 'turn'
  /** Аренда, режим, Codex. */
  | 'sys'
  /** Сбой, отказ. */
  | 'warn';

const ICON: Record<FeedKind, string> = {
  in: '📩',
  out: '📤',
  tool: '🔧',
  cmd: '$ ',
  file: '✎ ',
  think: '💭',
  text: '💬',
  turn: '◆ ',
  sys: '⚙ ',
  warn: '⚠ ',
};

const COLOR: Record<FeedKind, string> = {
  in: '1;36',
  out: '1;32',
  tool: '32',
  cmd: '33',
  file: '33',
  think: '2',
  text: '2',
  turn: '35',
  sys: '34',
  warn: '1;31',
};

export interface Feed {
  line(kind: FeedKind, text: string): void;
}

/** Текст в одну строку не длиннее max знаков: переводы строк — «⏎». */
export function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\r?\n/g, ' ⏎ ').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

export interface FeedOptions {
  write: (s: string) => void;
  timezone: string;
  /** Цвета ANSI (окно терминала); в файл и в тесты — без них. */
  color: boolean;
}

export function createFeed(opts: FeedOptions): Feed {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('ru-RU', { timeZone: opts.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    fmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  return {
    line(kind, text) {
      const time = fmt.format(new Date());
      const body = `${ICON[kind]} ${text}`;
      opts.write(opts.color ? `\x1b[2m${time}\x1b[0m  \x1b[${COLOR[kind]}m${body}\x1b[0m\n` : `${time}  ${body}\n`);
    },
  };
}

/** Лента в никуда (модульные тесты). */
export const NO_FEED: Feed = { line: () => undefined };
