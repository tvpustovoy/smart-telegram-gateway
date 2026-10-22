// Общее для интеграционных тестов M1: подделка Telegram со временем по поддельным часам шлюза, каталог бота, запуск.

import { KEYBOARD_REMOVED_TEXT, type Update } from 'stg-core';
import type { FakeChannel } from 'stg-fake-channel';
import { FakeTelegram, user, type FakeTelegramOptions, type SentMessage } from 'stg-fake-telegram';
import {
  FakeTime,
  GatewayProcess,
  TEST_TOKEN,
  assertNoLoss,
  assertNoToken,
  connectAdapter,
  makeHome,
  pump,
  q1,
  testEnv,
  type HomeOptions,
  type TestHome,
} from './harness.js';

export const OWNER = user(111, 'Анна', { username: 'anna' });
export const STRANGER = user(555_001, 'Петя', { username: 'petya' });
export const OTHER = user(777_001, 'Аня', { lastName: 'Смирнова' });

export interface Setup {
  fake: FakeTelegram;
  home: TestHome;
  env: NodeJS.ProcessEnv;
  time: FakeTime;
  /**
   * Сверки при закрытии (после каждого интеграционного теста): П-1 — если подделка что-то отдавала, П-2 — всегда.
   * Тест выключает П-1, когда база заведомо не годится (A1.15) или подделка общая с другой папкой (A1.14 — там сверка
   * своя).
   */
  checks: { noLoss: boolean; noToken: boolean; allowInProgress?: number[] };
  start(extraEnv?: Record<string, string | undefined>): Promise<GatewayProcess>;
  spawn(extraEnv?: Record<string, string | undefined>): GatewayProcess;
  close(): Promise<void>;
}

export async function setup(
  opts: { fake?: Partial<FakeTelegramOptions>; home?: Partial<HomeOptions>; env?: Record<string, string | undefined> } = {},
): Promise<Setup> {
  const time = new FakeTime();
  const fake = await FakeTelegram.start({ token: TEST_TOKEN, now: time.now, ...opts.fake });
  const home = makeHome({ apiBase: fake.apiBase, ownerId: OWNER.id, ...opts.home });
  time.bind(home);
  const env = testEnv(home, { STG_TEST_TELEGRAM_TOKEN: TEST_TOKEN, ...opts.env });
  const live: GatewayProcess[] = [];
  const checks: Setup['checks'] = { noLoss: true, noToken: true };
  return {
    fake,
    home,
    env,
    time,
    checks,
    async start(extra = {}) {
      const g = await GatewayProcess.start(home, { ...env, ...extra });
      live.push(g);
      return g;
    },
    spawn(extra = {}) {
      const g = GatewayProcess.spawn(home, { ...env, ...extra });
      live.push(g);
      return g;
    },
    async close() {
      for (const g of live) if (g.alive) await g.kill9();
      await fake.stop();
      if (checks.noToken) assertNoToken(home);
      if (checks.noLoss && fake.handedOut.size > 0) assertNoLoss(fake, home, checks.allowInProgress ? { allowInProgress: checks.allowInProgress } : {});
    },
  };
}

/** Тексты сообщений бота в чат. */
export function botTexts(fake: FakeTelegram, chatId = OWNER.id): string[] {
  return fake.sentTo(chatId).map((m) => m.text ?? m.caption ?? '');
}

/**
 * Номера событий, на которые ушла текстовая квитанция (в том числе сводная «№ a–b» прежней версии), — сколько раз каждое.
 * С 0.3.1 текстовой квитанции нет ни у чего (✍ · 👀 · 👌 — реакции; голосовое получает ответом расшифровку).
 */
export function receiptCounts(fake: FakeTelegram, chatId = OWNER.id): Map<number, number> {
  const counts = new Map<number, number>();
  for (const t of botTexts(fake, chatId)) {
    const m = /^№ (\d+)(?:–(\d+))?(?: \(#\d+\))? (?:записал|голосовое|правка)/.exec(t);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let s = a; s <= b; s++) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
}

/** Сообщение владельца в обновлении (новое или правка). */
function messageOf(u: Update): { chatId: number; messageId: number } {
  const m = u.message ?? u.edited_message;
  if (!m) throw new Error(`в обновлении ${u.update_id} нет сообщения`);
  return { chatId: m.chat.id, messageId: m.message_id };
}

/** Реакция бота на сообщение владельца сейчас (последний setMessageReaction): 👀, 👌 или null (с 0.3.2 ✍ нет). */
export function reactionOf(fake: FakeTelegram, u: Update): string | null {
  const { chatId, messageId } = messageOf(u);
  return fake.currentReaction(chatId, messageId);
}

/** Обновление принято (COMMIT): его событие в базе. С 0.3.2 реакции при записи нет — 👀 встаёт, когда агент увидел. */
export function recorded(s: Pick<Setup, 'home'>, u: Update): boolean {
  return !!q1(s.home, "SELECT 1 FROM updates u JOIN events e ON e.update_id = u.update_id WHERE u.update_id = ? AND u.status = 'admitted'", u.update_id);
}

/** Реакции бота на сообщение по порядку. */
export function reactionsOf(fake: FakeTelegram, u: Update): string[] {
  const { chatId, messageId } = messageOf(u);
  return fake.reactionHistory(chatId, messageId);
}

/** Дождаться записи (COMMIT) каждого из сообщений — двигая поддельные часы. */
export function waitRecorded(s: Setup, gw: GatewayProcess, us: Update | Update[], what = 'записи (COMMIT)'): Promise<true> {
  const list = Array.isArray(us) ? us : [us];
  return pump(gw, () => list.every((u) => recorded(s, u)) || null, { what });
}

/**
 * Агент на связи: поддельный переходник с проверенной арендой, который на каждое отданное событие отвечает delivered — как
 * канал, толкнувший событие в сессию (тогда шлюз ставит 👀 «агент увидел»). Повторную отдачу — тоже.
 */
export interface SeeingAgent {
  ch: FakeChannel;
  turn: number;
  close(): void;
}

/** done: после delivered сразу отмечать событие обработанным (как агент, которому отвечать не нужно). */
export async function seeingAgent(s: Pick<Setup, 'home'>, opts: { done?: boolean } = {}): Promise<SeeingAgent> {
  const { ch, turn } = await connectAdapter(s.home);
  let next = 0;
  const timer = setInterval(() => {
    for (; next < ch.received.length; next++) {
      const m = ch.received[next]!.message;
      if (m?.type !== 'event' || m.kind === 'probe') continue;
      const seq = m.seq;
      ch.delivered(seq)
        .then(() => (opts.done ? ch.request('done', { seqs: [seq] }) : null))
        .catch(() => undefined);
    }
  }, 5);
  return {
    ch,
    turn,
    close() {
      clearInterval(timer);
      ch.close();
    },
  };
}

/** Строка, которая один раз, при первом старте 0.3.1, снимает нижнюю клавиатуру прежних версий (P-18). */
export function isKeyboardRemoval(m: SentMessage): boolean {
  return m.text === KEYBOARD_REMOVED_TEXT;
}

/** Нижняя клавиатура (ReplyKeyboardMarkup) у сообщения бота — с 0.3.1 её нет ни у одного. */
export function hasReplyKeyboard(m: SentMessage): boolean {
  const rm = m.reply_markup as { keyboard?: unknown } | null;
  return !!rm?.keyboard;
}

/** Закреплённая строка состояния (закреплённое сообщение бота владельцу) — её текст сейчас; null — нет. */
export function statusLineOf(fake: FakeTelegram, chatId = OWNER.id): { message: SentMessage; text: string } | null {
  const id = fake.pinned.get(chatId);
  if (id === undefined) return null;
  const m = fake.sentTo(chatId).find((x) => x.message_id === id);
  if (!m) return null;
  return { message: m, text: m.edits.at(-1)?.text ?? m.text ?? '' };
}

/**
 * Сообщения бота, кроме закреплённой строки состояния (её правят на месте) и строки, снимающей клавиатуру прежних версий
 * (уходит один раз при первом старте 0.3.1; её проверяет m2-statusline).
 */
export function chatMessages(fake: FakeTelegram, chatId = OWNER.id): SentMessage[] {
  const pinnedIds = new Set(fake.pins.filter((p) => p.chat_id === chatId).map((p) => p.message_id));
  return fake.sentTo(chatId).filter((m) => !pinnedIds.has(m.message_id) && !isKeyboardRemoval(m));
}

/** Это вызов setMessageReaction с 👀. */
export function isEyes(params: Record<string, unknown>): boolean {
  return JSON.stringify(params.reaction ?? '').includes('👀');
}

/**
 * Реакции на сообщении — по порядку 👀 → 👌 (0.3.2: ✍ нет), каждая не раньше предыдущей; какие-то могут слиться (запрос
 * ещё не ушёл, а агент уже ответил). last — какой должна быть последняя.
 */
export function inReactionOrder(rs: readonly string[], last: string): boolean {
  const order = ['👀', '👌'];
  return rs.length > 0 && rs.at(-1) === last && rs.every((x, i) => order.includes(x) && (i === 0 || order.indexOf(x) > order.indexOf(rs[i - 1]!)));
}

/** Это вызов setMessageReaction с ✍ — с 0.3.2 шлюз его не ставит (проверка «✍ нет»). */
export function isPen(params: Record<string, unknown>): boolean {
  return JSON.stringify(params.reaction ?? '').includes('✍');
}
