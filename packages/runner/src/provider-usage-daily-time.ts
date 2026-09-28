// Calendar-day arithmetic for the daily usage series (O5).
//
// Attempt times are stored as UTC instants; a calendar day only exists relative
// to a timezone, so every conversion goes through an explicit IANA zone and
// nothing here depends on the process timezone.
import { PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS } from '@littlesheep/types';

export class ProviderUsageDailyRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUsageDailyRangeError';
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function isSupportedTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resolved && resolved.trim() ? resolved : 'UTC';
}

export function isValidLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** Calendar day (not instant) of an ISO instant in the given timezone. */
export function zonedDateKey(instant: string, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(instant));
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

export function localToday(timeZone: string, now: Date): string {
  return zonedDateKey(now.toISOString(), timeZone);
}

/**
 * Inclusive calendar-day enumeration. The arithmetic runs in UTC on purpose:
 * local days are named by their calendar date, so a DST transition must not
 * shift or duplicate a day inside the series.
 */
export function localDateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number) as [number, number, number];
  const [toYear, toMonth, toDay] = to.split('-').map(Number) as [number, number, number];
  const end = Date.UTC(toYear, toMonth - 1, toDay);
  for (let cursor = Date.UTC(fromYear, fromMonth - 1, fromDay); cursor <= end; cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
    if (dates.length > PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS) {
      throw new ProviderUsageDailyRangeError(
        `date range exceeds ${PROVIDER_USAGE_DAILY_MAX_RANGE_DAYS} days`,
      );
    }
  }
  return dates;
}

/** Default range: the last `days` calendar days ending today, inclusive. */
export function defaultDailyRange(
  timeZone: string,
  now: Date,
  days: number,
): { from: string; to: string } {
  const to = localToday(timeZone, now);
  const [year, month, day] = to.split('-').map(Number) as [number, number, number];
  const from = new Date(Date.UTC(year, month - 1, day) - (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

/** Validates a requested range against the response bound and returns its size. */
export function assertBoundedDailyRange(from: string, to: string): number {
  const dates = localDateRange(from, to);
  if (dates.length === 0) throw new ProviderUsageDailyRangeError('date range is empty');
  return dates.length;
}
