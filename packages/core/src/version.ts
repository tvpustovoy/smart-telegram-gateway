// Версия продукта и требования к среде (TECH-SPEC §6).

export const PRODUCT_VERSION = '0.1.0';

/** Node ≥ 22.13 — встроенный node:sqlite без флага. */
export const MIN_NODE = { major: 22, minor: 13 } as const;

export function parseNodeVersion(v: string): { major: number; minor: number; patch: number } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function nodeVersionOk(v: string): boolean {
  const p = parseNodeVersion(v);
  if (!p) return false;
  return p.major > MIN_NODE.major || (p.major === MIN_NODE.major && p.minor >= MIN_NODE.minor);
}

/**
 * Флаги Node для процесса шлюза (N-2: память ≤ 200 МБ). Без предела V8 растит кучу лениво: на 10 тыс. событий RSS
 * доходит до ~240 МБ мусора, который ещё не собран; живых данных — меньше 64 МБ. С пределом — ~140 МБ. Те же флаги —
 * в шебанге stg-gateway, в тестах и в плисте службы (M3).
 */
export const GATEWAY_NODE_FLAGS = ['--disable-warning=ExperimentalWarning', '--max-old-space-size=128', '--max-semi-space-size=4'] as const;
