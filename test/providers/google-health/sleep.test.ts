import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleHealthClient } from '../../../src/providers/google-health/client';
import {
  getSleep,
  getSleepRange,
  mapGhSleepToSleepLog,
} from '../../../src/providers/google-health/sleep';
import { createMockEnv } from '../../helpers/mock-env';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/google-health/sleep-reconcile.json'), 'utf-8'),
);

function envWithFreshToken() {
  return createMockEnv({
    gh_access_token: 'valid-token',
    gh_refresh_token: 'refresh-token',
    gh_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getSleepRange', () => {
  it('queries :reconcile with a civil_end_time filter and maps sessions to SleepLog', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const logs = await getSleepRange(client, '2026-07-25', '2026-07-31');

    const call = fetchMock.mock.calls[0] as unknown as [URL | string];
    const url = new URL(String(call[0]));
    expect(url.pathname).toBe('/v4/users/me/dataTypes/sleep/dataPoints:reconcile');
    expect(url.searchParams.get('filter')).toBe(
      'sleep.interval.civil_end_time >= "2026-07-25" AND sleep.interval.civil_end_time < "2026-08-01"',
    );
    expect(url.searchParams.get('pageSize')).toBe('25');

    expect(logs).toHaveLength(2);
    const main = logs[0];
    if (!main) throw new Error('missing main sleep');

    // Identity and civil-date semantics (Fitbit dateOfSleep = date sleep ended)
    expect(main.logId).toBe('users/me/dataTypes/sleep/dataPoints/main-sleep-0730');
    expect(main.dateOfSleep).toBe('2026-07-31');
    expect(main.startTime).toBe('2026-07-30T23:10:00.000');
    expect(main.endTime).toBe('2026-07-31T06:40:00.000');
    expect(main.duration).toBe(27_000_000);

    // Summary metrics
    expect(main.minutesAsleep).toBe(440);
    expect(main.minutesAwake).toBe(10);
    expect(main.minutesToFallAsleep).toBe(5);
    expect(main.timeInBed).toBe(450);
    expect(main.efficiency).toBeUndefined();
    expect(main.type).toBe('stages');
    expect(main.isMainSleep).toBe(true);

    // Stage segments → levels.data with lowercase levels and computed seconds
    const data = main.levels?.data;
    if (!data) throw new Error('missing levels.data');
    expect(data).toHaveLength(5);
    expect(data[0]).toEqual({
      dateTime: '2026-07-30T23:10:00.000',
      level: 'light',
      seconds: 7200,
    });
    expect(data[3]).toEqual({
      dateTime: '2026-07-31T03:10:00.000',
      level: 'wake',
      seconds: 600,
    });

    // Stage summary → levels.summary keyed by lowercase stage
    expect(main.levels?.summary).toEqual({
      light: { minutes: 320, count: 2 },
      deep: { minutes: 60, count: 1 },
      rem: { minutes: 60, count: 1 },
      wake: { minutes: 10, count: 1 },
    });

    // The nap: classic sleep, same-day civil times
    const nap = logs[1];
    if (!nap) throw new Error('missing nap');
    expect(nap.dateOfSleep).toBe('2026-07-31');
    expect(nap.type).toBe('classic');
    expect(nap.isMainSleep).toBe(false);
    expect(nap.minutesAsleep).toBe(60);
    expect(nap.levels?.data?.[0]?.level).toBe('asleep');
  });

  it('throws instead of silently returning a truncated result when pages exceed the cap', async () => {
    // Sleep pages are hard-capped at 25 items; paginate stops at 20 pages.
    // An always-present nextPageToken must surface as an error, not as a
    // silently incomplete (and then cached) result.
    const fetchMock = vi.fn(async () => {
      const body = { dataPoints: [fixture.dataPoints[0]], nextPageToken: 'more' };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    await expect(getSleepRange(client, '2020-01-01', '2026-07-31')).rejects.toThrow(
      /narrow the date range/i,
    );
  });

  it('follows nextPageToken across reconcile pages', async () => {
    const page1 = {
      dataPoints: [fixture.dataPoints[0]],
      nextPageToken: 'page-2',
    };
    const page2 = { dataPoints: [fixture.dataPoints[1]] };
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const body = url.searchParams.get('pageToken') === 'page-2' ? page2 : page1;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const logs = await getSleepRange(client, '2026-07-25', '2026-07-31');
    expect(logs).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('mapGhSleepToSleepLog fallback paths', () => {
  it('derives local times from UTC + offsets when civil times are absent', () => {
    const log = mapGhSleepToSleepLog('users/me/dataTypes/sleep/dataPoints/x', {
      interval: {
        startTime: '2026-07-30T14:10:00Z',
        endTime: '2026-07-30T21:40:00Z',
        startUtcOffset: '32400s',
        endUtcOffset: '32400s',
      },
      type: 'STAGES',
    });

    expect(log.startTime).toBe('2026-07-30T23:10:00.000');
    expect(log.endTime).toBe('2026-07-31T06:40:00.000');
    expect(log.dateOfSleep).toBe('2026-07-31');
    expect(log.duration).toBe(27_000_000);
    // no summary and no stages → minutesAsleep falls back to the duration
    expect(log.minutesAsleep).toBe(450);
  });

  it('applies per-end offsets when the UTC offset changes mid-session (DST end)', () => {
    const log = mapGhSleepToSleepLog(undefined, {
      interval: {
        startTime: '2026-11-01T03:00:00Z',
        endTime: '2026-11-01T11:00:00Z',
        startUtcOffset: '-14400s', // UTC-4 before the switch
        endUtcOffset: '-18000s', // UTC-5 after the switch
      },
    });

    expect(log.startTime).toBe('2026-10-31T23:00:00.000');
    expect(log.endTime).toBe('2026-11-01T06:00:00.000');
    expect(log.dateOfSleep).toBe('2026-11-01');
    // duration stays physical: 8h regardless of the civil-time jump
    expect(log.duration).toBe(8 * 3_600_000);
  });

  it("maps AWAKE to 'awake' (not 'wake') for CLASSIC sleeps", () => {
    const log = mapGhSleepToSleepLog(undefined, {
      interval: {
        startTime: '2026-07-31T04:00:00Z',
        endTime: '2026-07-31T05:00:00Z',
        startUtcOffset: '32400s',
        endUtcOffset: '32400s',
      },
      type: 'CLASSIC',
      stages: [
        {
          startTime: '2026-07-31T04:00:00Z',
          endTime: '2026-07-31T04:50:00Z',
          startUtcOffset: '32400s',
          endUtcOffset: '32400s',
          type: 'ASLEEP',
        },
        {
          startTime: '2026-07-31T04:50:00Z',
          endTime: '2026-07-31T05:00:00Z',
          startUtcOffset: '32400s',
          endUtcOffset: '32400s',
          type: 'AWAKE',
        },
      ],
    });

    expect(log.levels?.data?.map((d) => d.level)).toEqual(['asleep', 'awake']);
  });
});

describe('getSleep', () => {
  it('filters a single civil end date', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ dataPoints: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const logs = await getSleep(client, '2026-07-31');

    const call = fetchMock.mock.calls[0] as unknown as [URL | string];
    const url = new URL(String(call[0]));
    expect(url.searchParams.get('filter')).toBe(
      'sleep.interval.civil_end_time >= "2026-07-31" AND sleep.interval.civil_end_time < "2026-08-01"',
    );
    expect(logs).toEqual([]);
  });
});
