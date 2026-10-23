// Сроки адаптера Codex (#55). Сроки связи со шлюзом — общие с каналом (stg-channel, timing.ts); здесь — свои: перезапуск
// app-server с паузой 1…30 с, снять аренду, если Codex не поднялся за минуту, повтор хода после отказа и сбоя, проверка
// входа, повтор «агент работает» шлюзу. Под тестом (STG_TEST=1) их можно ужать множителем STG_TEST_CODEX_TIME_SCALE (0 < k ≤ 1),
// а повтор «агент работает» задать прямо — STG_TEST_CODEX_WORKING_REPEAT_MS (целое > 0, мс): тест хода дольше срока
// шлюза (15 минут по его поддельным часам) с признаками жизни Codex по настоящим.

export interface CodexTiming {
  restartMinMs: number;
  restartMaxMs: number;
  /** Codex не поднимается столько — аренда снимается (владелец видит «не на связи»). */
  giveUpMs: number;
  /** turn/start отказал (Codex занят ручным сжатием и т. п.) — повтор через столько. */
  turnRetryMs: number;
  /** Ход упал прочей ошибкой — повторы через столько (последний — дальше каждый раз). */
  failRetryMs: number[];
  /** Лимит тарифа, предел запросов, слетел вход — повтор через столько. */
  limitRetryMs: number;
  /** Нет входа в ChatGPT — проверять снова через столько. */
  accountRetryMs: number;
  /** Срок ответа app-server на запрос (initialize, thread/start …). */
  requestTimeoutMs: number;
  /**
   * Ход идёт — `working` шлюзу повторяется на признаки жизни Codex (уведомления треда, вызовы инструментов), не чаще
   * этого (#55). Шлюз держит «печатает…» WORKING_HOLD_MS (15 мин) после последнего.
   */
  workingRepeatMs: number;
}

export const DEFAULT_CODEX_TIMING: CodexTiming = {
  restartMinMs: 1000,
  restartMaxMs: 30_000,
  giveUpMs: 60_000,
  turnRetryMs: 5000,
  failRetryMs: [60_000, 300_000, 900_000],
  limitRetryMs: 300_000,
  accountRetryMs: 60_000,
  requestTimeoutMs: 120_000,
  workingRepeatMs: 30_000,
};

export function codexTimingFromEnv(env: NodeJS.ProcessEnv): CodexTiming {
  const test = env.STG_TEST === '1';
  const raw = test ? env.STG_TEST_CODEX_TIME_SCALE : undefined;
  const k = raw ? Number(raw) : 1;
  const d = DEFAULT_CODEX_TIMING;
  let t = d;
  if (Number.isFinite(k) && k > 0 && k <= 1 && k !== 1) {
    const scale = (ms: number): number => Math.max(1, Math.round(ms * k));
    t = {
      restartMinMs: scale(d.restartMinMs),
      restartMaxMs: scale(d.restartMaxMs),
      giveUpMs: scale(d.giveUpMs),
      turnRetryMs: scale(d.turnRetryMs),
      failRetryMs: d.failRetryMs.map(scale),
      limitRetryMs: scale(d.limitRetryMs),
      accountRetryMs: scale(d.accountRetryMs),
      requestTimeoutMs: d.requestTimeoutMs,
      workingRepeatMs: scale(d.workingRepeatMs),
    };
  }
  const repeat = test && env.STG_TEST_CODEX_WORKING_REPEAT_MS ? Number(env.STG_TEST_CODEX_WORKING_REPEAT_MS) : NaN;
  return Number.isInteger(repeat) && repeat > 0 ? { ...t, workingRepeatMs: repeat } : t;
}
