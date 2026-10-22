// Время владельца: даты журнала и ЧЧ:ММ в строках — по часовому поясу из config.yaml.

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatter(cache: Map<string, Intl.DateTimeFormat>, tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...opts });
    cache.set(tz, f);
  }
  return f;
}

/** ГГГГ-ММ-ДД в поясе tz. */
export function localDate(ms: number, tz: string): string {
  const parts = formatter(dateFormatters, tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** ЧЧ:ММ в поясе tz. */
export function localTime(ms: number, tz: string): string {
  const parts = formatter(timeFormatters, tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ms);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

/** ДД.ММ в поясе tz (срок кнопки в строке владельцу). */
export function localDayMonth(ms: number, tz: string): string {
  const d = localDate(ms, tz);
  return `${d.slice(8, 10)}.${d.slice(5, 7)}`;
}
