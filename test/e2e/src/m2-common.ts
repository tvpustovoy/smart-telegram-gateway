// Общее для интеграционных тестов M2: кнопки шлюза под сообщениями бота, нажатия, ожидание строк владельцу.

import type { SentMessage } from 'stg-fake-telegram';
import { pump, waitUntil, type GatewayProcess } from './harness.js';
import { OWNER, type Setup } from './m1-common.js';

export interface InlineButton {
  text: string;
  data: string;
}

/** Встроенные кнопки сообщения бота (inline_keyboard), по порядку. */
export function buttonsOf(m: SentMessage): InlineButton[] {
  const rm = m.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | null;
  return (rm?.inline_keyboard ?? []).flat().map((b) => ({ text: b.text, data: b.callback_data }));
}

/**
 * Нижняя клавиатура или подсказка поля ввода у сообщения бота: с 0.3.1 их нет ни у одного (P-18) — true, если что-то
 * из них есть.
 */
export function keyboardOrPlaceholder(m: SentMessage): boolean {
  const rm = m.reply_markup as { input_field_placeholder?: string; keyboard?: unknown } | null;
  return !!rm && ('keyboard' in rm || 'input_field_placeholder' in rm);
}

/** Дождаться сообщения бота владельцу (поддельные часы двигаются: отправитель шлёт не чаще раза в секунду). */
export function waitSent(s: Setup, gw: GatewayProcess, pred: (m: SentMessage) => boolean, what = 'сообщения бота'): Promise<SentMessage> {
  return pump(gw, () => s.fake.sentTo(OWNER.id).find(pred), { what });
}

/** Все сообщения бота владельцу с этим текстом. */
export function sentWithText(s: Setup, text: string): SentMessage[] {
  return s.fake.sentTo(OWNER.id).filter((m) => m.text === text);
}

/** Нажать кнопку владельцем (или другим) и дождаться ответа на нажатие; вернуть его текст (null — без текста). */
export async function press(s: Setup, message: SentMessage, label: string, from = OWNER): Promise<string | null> {
  const b = buttonsOf(message).find((x) => x.text === label);
  if (!b) throw new Error(`нет кнопки «${label}» под «${message.text}»: ${JSON.stringify(buttonsOf(message))}`);
  const [u] = s.fake.push(s.fake.builder.callback(from, b.data, message.message));
  const id = u!.callback_query!.id;
  const a = await waitUntil(() => s.fake.callbackAnswers.find((x) => x.callback_query_id === id), 10_000, `ответа на нажатие «${label}»`);
  return a.text;
}
