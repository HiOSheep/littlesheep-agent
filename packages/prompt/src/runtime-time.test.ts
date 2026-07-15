import { describe, expect, it } from 'vitest';
import {
  formatElapsedMilliseconds,
  formatRuntimeClock,
  resolveRuntimeTimeZone,
} from './runtime-time.js';

describe('runtime time formatting', () => {
  it('formats exact local seconds and offset for the configured time zone', () => {
    expect(formatRuntimeClock(
      new Date('2026-07-15T03:04:05.678Z'),
      'Asia/Hong_Kong',
    )).toEqual({
      instant: '2026-07-15T03:04:05.678Z',
      localDateTime: '2026-07-15 11:04:05',
      timeZone: 'Asia/Hong_Kong',
      utcOffset: '+08:00',
    });
  });

  it('falls back from an invalid configured time zone', () => {
    expect(resolveRuntimeTimeZone('Not/A_Time_Zone')).not.toBe('Not/A_Time_Zone');
  });

  it('formats elapsed milliseconds without dropping sub-second precision', () => {
    expect(formatElapsedMilliseconds(3_661_042)).toBe('01:01:01.042');
  });
});
