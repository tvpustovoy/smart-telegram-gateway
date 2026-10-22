// Сроки канала (TECH-SPEC 5.10): переподключение 1…30 с, повтор hello после busy — 30 с, своя проверка связи со
// шлюзом — ping каждые 15 с, нет ответа 45 с — соединение рвётся и поднимается заново. Канал — отдельный процесс,
// который запускает Claude Code; его сроки — по настоящему времени. Под тестом (STG_TEST=1) их можно ужать
// множителем STG_TEST_CHANNEL_TIME_SCALE (0 < k ≤ 1): поддельные часы шлюза в процесс канала не попадают.

import { BUSY_RETRY_MS, LEASE_PING_MS, LEASE_PONG_TIMEOUT_MS, RECONNECT_MAX_MS, RECONNECT_MIN_MS } from 'stg-core';

export interface ChannelTiming {
  reconnectMinMs: number;
  reconnectMaxMs: number;
  busyRetryMs: number;
  pingMs: number;
  pongTimeoutMs: number;
  /** Сколько ждать ответа шлюза на запрос инструмента. */
  requestTimeoutMs: number;
  /** Сколько ждать картинку (media, 0.3): шлюз скачивает файл у Telegram до 60 с. */
  mediaTimeoutMs: number;
  /** Сколько ждать, пока сокет допишет перед выходом. */
  exitFlushMs: number;
}

export const DEFAULT_TIMING: ChannelTiming = {
  reconnectMinMs: RECONNECT_MIN_MS,
  reconnectMaxMs: RECONNECT_MAX_MS,
  busyRetryMs: BUSY_RETRY_MS,
  pingMs: LEASE_PING_MS,
  pongTimeoutMs: LEASE_PONG_TIMEOUT_MS,
  requestTimeoutMs: 10_000,
  mediaTimeoutMs: 90_000,
  exitFlushMs: 500,
};

/** Сроки по окружению: множитель — только под тестом. */
export function timingFromEnv(env: NodeJS.ProcessEnv): ChannelTiming {
  const raw = env.STG_TEST === '1' ? env.STG_TEST_CHANNEL_TIME_SCALE : undefined;
  const k = raw ? Number(raw) : 1;
  if (!Number.isFinite(k) || k <= 0 || k > 1) return DEFAULT_TIMING;
  const scale = (ms: number): number => Math.max(1, Math.round(ms * k));
  return {
    reconnectMinMs: scale(DEFAULT_TIMING.reconnectMinMs),
    reconnectMaxMs: scale(DEFAULT_TIMING.reconnectMaxMs),
    busyRetryMs: scale(DEFAULT_TIMING.busyRetryMs),
    pingMs: scale(DEFAULT_TIMING.pingMs),
    pongTimeoutMs: scale(DEFAULT_TIMING.pongTimeoutMs),
    // Ответ шлюза — по настоящему времени шлюза: его не ужимаем.
    requestTimeoutMs: DEFAULT_TIMING.requestTimeoutMs,
    mediaTimeoutMs: DEFAULT_TIMING.mediaTimeoutMs,
    exitFlushMs: DEFAULT_TIMING.exitFlushMs,
  };
}
