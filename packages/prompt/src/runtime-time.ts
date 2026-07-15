export type RuntimeTimeFormat = 'auto' | '12' | '24';

export interface RuntimeClockValue {
  instant: string;
  localDateTime: string;
  timeZone: string;
  utcOffset: string;
}

/** Resolve a valid IANA time zone, falling back to the host and then UTC. */
export function resolveRuntimeTimeZone(configured?: string): string {
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const candidate of [configured, host, 'UTC']) {
    if (!candidate) continue;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
      return candidate;
    } catch {
      // Try the next deterministic fallback.
    }
  }
  return 'UTC';
}

/** Format an exact clock value to local second precision plus UTC offset. */
export function formatRuntimeClock(now: Date, configuredTimeZone?: string): RuntimeClockValue {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Runtime clock requires a valid Date.');
  const timeZone = resolveRuntimeTimeZone(configuredTimeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) throw new Error(`Runtime clock is missing ${type}.`);
    return part;
  };
  const year = value('year');
  const month = value('month');
  const day = value('day');
  const hour = value('hour');
  const minute = value('minute');
  const second = value('second');
  const localAsUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const instantAtSecond = Math.floor(now.getTime() / 1000) * 1000;
  const offsetMinutes = Math.round((localAsUtc - instantAtSecond) / 60_000);

  return {
    instant: now.toISOString(),
    localDateTime: `${year}-${month}-${day} ${hour}:${minute}:${second}`,
    timeZone,
    utcOffset: formatUtcOffset(offsetMinutes),
  };
}

export function formatElapsedMilliseconds(durationMs: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(durationMs) ? durationMs : 0));
  const milliseconds = safe % 1000;
  const totalSeconds = Math.floor(safe / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
