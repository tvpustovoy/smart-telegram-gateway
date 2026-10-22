// Точки сбоя для тестов (TECH-SPEC §7, ACCEPTANCE §1): STG_FAULT=<точка>[:update_id] → немедленный
// process.exit(137). Работают только при STG_TEST=1; без него переменная не действует.

export const FAULT_POINTS = [
  'before_files',
  'after_files',
  'after_commit',
  'after_eyes',
  'in_send',
  'in_handler',
  'in_stt',
] as const;

export type FaultPoint = (typeof FAULT_POINTS)[number];

export interface FaultSpec {
  point: FaultPoint;
  /** null — срабатывает на любом обновлении. */
  updateId: number | null;
}

export class FaultSpecError extends Error {}

/** Разобрать значение STG_FAULT. Пустое — null. Неизвестная точка — ошибка: опечатка в тесте не должна молчать. */
export function parseFaultSpec(value: string | undefined): FaultSpec | null {
  if (value === undefined || value.trim() === '') return null;
  const m = /^([a-z_]+)(?::(\d+))?$/.exec(value.trim());
  if (!m || !m[1]) throw new FaultSpecError(`STG_FAULT=${value}: ожидается <точка>[:update_id]`);
  const point = m[1];
  if (!(FAULT_POINTS as readonly string[]).includes(point)) {
    throw new FaultSpecError(`STG_FAULT=${value}: неизвестная точка «${point}»; есть: ${FAULT_POINTS.join(', ')}`);
  }
  return { point: point as FaultPoint, updateId: m[2] !== undefined ? Number(m[2]) : null };
}

/** Совпадает ли точка (и номер обновления) с заданной. */
export function faultMatches(spec: FaultSpec | null, point: FaultPoint, updateId?: number | null): boolean {
  if (!spec || spec.point !== point) return false;
  if (spec.updateId === null) return true;
  return updateId !== undefined && updateId !== null && spec.updateId === updateId;
}

let cached: { env: string | undefined; test: string | undefined; spec: FaultSpec | null } | null = null;

function activeSpec(): FaultSpec | null {
  const env = process.env.STG_FAULT;
  const test = process.env.STG_TEST;
  if (!cached || cached.env !== env || cached.test !== test) {
    cached = { env, test, spec: test === '1' ? parseFaultSpec(env) : null };
  }
  return cached.spec;
}

/** Проверить STG_FAULT при старте процесса: неверное значение — ошибка сразу, а не в точке. */
export function validateFaultEnv(): FaultSpec | null {
  return activeSpec();
}

/** Точка сбоя: если STG_FAULT указывает на неё (и на это обновление) — немедленный выход с кодом 137. */
export function faultPoint(point: FaultPoint, updateId?: number | null): void {
  const spec = activeSpec();
  if (!faultMatches(spec, point, updateId)) return;
  process.stderr.write(`stg: точка сбоя ${point}${updateId != null ? `:${updateId}` : ''} — выход 137\n`);
  process.exit(137);
}
