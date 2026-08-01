import { describe, expect, it } from 'vitest';
import {
  civilRangeFilter,
  civilToLocalIso,
  durationToSeconds,
  ghDateToIso,
  nextDayIso,
  shiftToLocalIso,
} from '../../../src/providers/google-health/wire';

describe('ghDateToIso', () => {
  it('formats a google.type.Date with zero padding', () => {
    expect(ghDateToIso({ year: 2026, month: 7, day: 5 })).toBe('2026-07-05');
  });
});

describe('civilToLocalIso', () => {
  it('formats a CivilDateTime as a local ISO string without timezone suffix', () => {
    expect(
      civilToLocalIso({
        date: { year: 2026, month: 7, day: 30 },
        time: { hours: 23, minutes: 10 },
      }),
    ).toBe('2026-07-30T23:10:00.000');
  });

  it('defaults missing time components to midnight', () => {
    expect(civilToLocalIso({ date: { year: 2026, month: 1, day: 2 } })).toBe(
      '2026-01-02T00:00:00.000',
    );
  });
});

describe('durationToSeconds', () => {
  it('parses whole and fractional google-duration strings', () => {
    expect(durationToSeconds('3600s')).toBe(3600);
    expect(durationToSeconds('3600.5s')).toBe(3600.5);
    expect(durationToSeconds('-3600s')).toBe(-3600);
  });

  it('returns 0 for missing or malformed values', () => {
    expect(durationToSeconds(undefined)).toBe(0);
    expect(durationToSeconds('abc')).toBe(0);
  });
});

describe('shiftToLocalIso', () => {
  it('applies a UTC offset to produce the local wall-clock time', () => {
    expect(shiftToLocalIso('2026-07-30T14:10:00Z', '32400s')).toBe('2026-07-30T23:10:00.000');
  });

  it('handles negative offsets crossing a date boundary', () => {
    expect(shiftToLocalIso('2026-07-31T03:00:00Z', '-14400s')).toBe('2026-07-30T23:00:00.000');
  });
});

describe('nextDayIso', () => {
  it('increments a date within a month', () => {
    expect(nextDayIso('2026-07-30')).toBe('2026-07-31');
  });

  it('rolls over month and year boundaries', () => {
    expect(nextDayIso('2026-01-31')).toBe('2026-02-01');
    expect(nextDayIso('2026-12-31')).toBe('2027-01-01');
  });
});

describe('civilRangeFilter', () => {
  it('builds an AIP-160 civil range with an exclusive next-day upper bound', () => {
    expect(civilRangeFilter('sleep.interval.civil_end_time', '2026-07-25', '2026-07-31')).toBe(
      'sleep.interval.civil_end_time >= "2026-07-25" AND sleep.interval.civil_end_time < "2026-08-01"',
    );
  });
});
