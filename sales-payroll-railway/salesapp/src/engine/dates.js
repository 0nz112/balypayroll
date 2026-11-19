// Date helpers on plain 'YYYY-MM-DD' strings (calendar dates, no time zone drift).
// Business timezone is Asia/Baghdad (UTC+3, no DST).
// Payroll week: Saturday → Friday. Payday: the following Tuesday (Saturday + 10).

export const TIMEZONE = 'Asia/Baghdad';

const toUTC = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`Invalid date: ${iso}`);
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUTC = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (iso, n) => fromUTC(toUTC(iso) + n * 86400000);
export const diffDays = (a, b) => Math.round((toUTC(a) - toUTC(b)) / 86400000); // a - b
export const dayOfWeek = (iso) => new Date(toUTC(iso)).getUTCDay(); // Sun=0 … Sat=6

export const weekStartOf = (iso) => addDays(iso, -((dayOfWeek(iso) + 1) % 7));
export const weekEndOf = (iso) => addDays(weekStartOf(iso), 6);
export const payDateOf = (iso) => addDays(weekStartOf(iso), 10);
/** A week belongs to the month of its Friday, so it is never split across months. */
export const payrollMonthOf = (iso) => weekEndOf(iso).slice(0, 7) + '-01';

export function baghdadToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** All payroll weeks whose Friday falls in the given month ('YYYY-MM'). */
export function payrollWeeksOfMonth(ym) {
  const first = `${ym}-01`;
  let start = weekStartOf(first);
  if (weekEndOf(start).slice(0, 7) !== ym) start = addDays(start, 7);
  const weeks = [];
  for (let s = start; weekEndOf(s).slice(0, 7) === ym; s = addDays(s, 7)) {
    weeks.push({ week_start: s, week_end: addDays(s, 6), pay_date: addDays(s, 10), payroll_month: `${ym}-01` });
  }
  return weeks;
}

export function rangePreset(key, today = baghdadToday()) {
  switch (key) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'week': return { from: weekStartOf(today), to: today };
    case 'last_week': { const s = addDays(weekStartOf(today), -7); return { from: s, to: addDays(s, 6) }; }
    case 'month': return { from: today.slice(0, 8) + '01', to: today };
    case 'last_30': return { from: addDays(today, -29), to: today };
    case 'last_month': {
      const firstThis = today.slice(0, 8) + '01';
      const lastPrev = addDays(firstThis, -1);
      return { from: lastPrev.slice(0, 8) + '01', to: lastPrev };
    }
    default: return { from: addDays(today, -29), to: today };
  }
}
