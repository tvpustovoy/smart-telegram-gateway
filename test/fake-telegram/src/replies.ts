// Ответы подделки и ошибки Telegram в его формате: `{ok: false, error_code, description, parameters.retry_after}`.

export type FakeReply =
  | { kind: 'ok'; result: unknown }
  | { kind: 'error'; code: number; description: string; retryAfter?: number }
  /** Не отвечать вовсе: соединение висит, пока клиент не оборвёт или подделка не остановится. */
  | { kind: 'hang' }
  /** Оборвать соединение без ответа. */
  | { kind: 'drop' }
  /** Подождать и ответить как обычно (или как `then`). */
  | { kind: 'delay'; ms: number; then?: FakeReply };

export const reply = {
  ok: (result: unknown): FakeReply => ({ kind: 'ok', result }),
  error: (code: number, description: string, retryAfter?: number): FakeReply =>
    retryAfter === undefined ? { kind: 'error', code, description } : { kind: 'error', code, description, retryAfter },
  hang: (): FakeReply => ({ kind: 'hang' }),
  drop: (): FakeReply => ({ kind: 'drop' }),
  delay: (ms: number, then?: FakeReply): FakeReply => (then ? { kind: 'delay', ms, then } : { kind: 'delay', ms }),
};

/** Ошибки из договора подделок (ACCEPTANCE §1) — тексты как у настоящего Bot API. */
export const errors = {
  parseEntities: (detail = 'Unsupported start tag "x" at byte offset 0'): FakeReply =>
    reply.error(400, `Bad Request: can't parse entities: ${detail}`),
  notModified: (): FakeReply =>
    reply.error(
      400,
      'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
    ),
  tooLong: (): FakeReply => reply.error(400, 'Bad Request: message is too long'),
  forbidden: (): FakeReply => reply.error(403, 'Forbidden: bot was blocked by the user'),
  conflictPolling: (): FakeReply =>
    reply.error(409, 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'),
  conflictWebhook: (): FakeReply =>
    reply.error(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"),
  tooManyRequests: (retryAfter: number): FakeReply => reply.error(429, `Too Many Requests: retry after ${retryAfter}`, retryAfter),
  serverError: (code = 502): FakeReply =>
    reply.error(code, code === 500 ? 'Internal Server Error' : code === 503 ? 'Service Unavailable' : code === 504 ? 'Gateway Timeout' : 'Bad Gateway'),
  unauthorized: (): FakeReply => reply.error(401, 'Unauthorized'),
  notFound: (): FakeReply => reply.error(404, 'Not Found'),
};
