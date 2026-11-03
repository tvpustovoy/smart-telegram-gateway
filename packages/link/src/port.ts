// Порт к сети агентов: всё, что stg-link делает с сетью, — за этим узким интерфейсом. Сама сеть сменная: модуль с openPort
// указывается при запуске и в репозиторий не входит, поэтому у шлюза нет зависимости от неё. Тесты подставляют свой порт.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Непрочитанное письмо. from — адрес отправителя: подтверждённый сетью, не имя для показа. */
export interface Letter {
  wire_id: string;
  from: string;
  kind: string;
  text: string | null;
  reply_to: string | null;
  /** Файл письма: что заявил отправитель, байты — по запросу. */
  file?: LetterFile;
}

export interface LetterFile {
  name: string;
  mime: string | null;
  bytes: number;
}

export type SendVerdict = { sent: true; wire_id: string } | { sent: false; reason: string };

export interface NetworkPort {
  /** Непрочитанные письма; прочитанными не становятся. */
  unread(): Promise<Letter[]>;
  /** Отметить прочитанными: только после того, как шлюз их принял. */
  consume(wireIds: string[]): Promise<void>;
  /** reply_to — письмо или файл, на которое это ответ. */
  send(address: string, text: string, reply_to?: string): Promise<SendVerdict>;
  /** В сети файл и текст — разные сообщения. Подпись к файлу — отдельным письмом. */
  sendFile(address: string, file: string, name: string, mime: string | null): Promise<SendVerdict>;
  /** Записать байты файла письма wire_id в dest. Прочитанным письмо не становится. */
  fetchFile(wireId: string, dest: string): Promise<void>;
  /** Срабатывает на новое письмо. Ошибка потока — исключение: вызывающий подпишется снова. */
  wakes(signal: AbortSignal): AsyncIterable<void>;
  close(): Promise<void>;
}

export interface PortOptions {
  /** Имя шлюза в сети; порт занимает его, чужое не перехватывает. */
  identity: string;
  /** Каталог бота: порт может держать здесь своё состояние. */
  home: string;
}

export type OpenPort = (opts: PortOptions) => Promise<NetworkPort>;

/** Загрузить модуль порта по пути: он экспортирует openPort. */
export async function loadPort(file: string): Promise<OpenPort> {
  const mod = (await import(pathToFileURL(path.resolve(file)).href)) as { openPort?: unknown };
  if (typeof mod.openPort !== 'function') throw new Error(`в модуле ${file} нет функции openPort`);
  return mod.openPort as OpenPort;
}
