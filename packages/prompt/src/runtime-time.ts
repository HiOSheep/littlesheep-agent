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
