// -----------------------------------------------------------------------------
// Local time of the utility: an instant read in the contract timezone (month,
// hour, weekday, date), with the changes of time of that zone (Intl, the IANA
// database of Node). Pure.
// -----------------------------------------------------------------------------

import { DAY } from './constants.js';

const formatters = new Map();
/** Formatters kept at most (one per timezone used: a handful). */
const MAX_FORMATTERS = 32;

/** True for a timezone Node knows (an IANA name). */
export function validTimezone(timezone) {
  if (typeof timezone !== 'string' || timezone.length === 0 || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function formatterOf(timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    if (formatters.size >= MAX_FORMATTERS) formatters.clear();
    formatters.set(timezone, formatter);
  }
  return formatter;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * The local clock of `ms` in `timezone`:
 * `{ year, month (1-12), day, hour (0-23), minute, weekday (0 = Sunday), date: 'YYYY-MM-DD' }`.
 */
export function localParts(ms, timezone) {
  const parts = {};
  for (const { type, value } of formatterOf(timezone).formatToParts(new Date(ms))) {
    parts[type] = value;
  }
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  return {
    year,
    month,
    day,
    hour,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday],
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** A 'YYYY-MM-DD' date as a day number (days since 1970-01-01), NaN when it is not one. */
export function dayNumber(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const [y, m, d] = date.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return NaN;
  }
  return ms / DAY;
}

/**
 * The local days of [startMs, endMs) in `timezone` (an end at local midnight
 * does not count the next day), intersected with the contract validity
 * (`validFrom`, `validTo`: inclusive local dates, `validTo` null = ongoing).
 * This is how a supplier counts the days of the period it bills, and how the
 * core scales an allowance per day.
 */
export function daysInPeriod(startMs, endMs, timezone, { validFrom, validTo } = {}) {
  if (!(endMs > startMs)) return 0;
  let first = dayNumber(localParts(startMs, timezone).date);
  let last = dayNumber(localParts(endMs - 1, timezone).date);
  const from = dayNumber(validFrom);
  if (Number.isFinite(from)) first = Math.max(first, from);
  const to = dayNumber(validTo);
  if (Number.isFinite(to)) last = Math.min(last, to);
  return Math.max(0, last - first + 1);
}
