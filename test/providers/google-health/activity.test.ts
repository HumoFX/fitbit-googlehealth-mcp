import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getActivityTimeSeries,
  getDailySummary,
} from '../../../src/providers/google-health/activity';
import { GoogleHealthClient } from '../../../src/providers/google-health/client';
import { createMockEnv } from '../../helpers/mock-env';

function envWithFreshToken() {
  return createMockEnv({
    gh_access_token: 'valid-token',
    gh_refresh_token: 'refresh-token',
    gh_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
  });
}

function rollupPoint(day: number, value: Record<string, unknown>) {
  return {
    civilStartTime: { date: { year: 2026, month: 7, day } },
    civilEndTime: { date: { year: 2026, month: 7, day: day + 1 } },
    ...value,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getActivityTimeSeries', () => {
  it('maps steps dailyRollUp points to a TimeSeries', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rollupDataPoints: [
              rollupPoint(30, { steps: { countSum: '8421' } }),
              rollupPoint(31, { steps: { countSum: '9100' } }),
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const series = await getActivityTimeSeries(client, 'steps', '2026-07-30', '2026-07-31');

    expect(series.resource).toBe('steps');
    expect(series.points).toEqual([
      { dateTime: '2026-07-30', value: 8421 },
      { dateTime: '2026-07-31', value: 9100 },
    ]);
    const call = fetchMock.mock.calls[0] as unknown as [URL | string, RequestInit];
    expect(String(call[0])).toContain('/dataTypes/steps/dataPoints:dailyRollUp');
  });

  it('converts distance millimeters to kilometers', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rollupDataPoints: [rollupPoint(31, { distance: { millimetersSum: '6230000' } })],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const series = await getActivityTimeSeries(client, 'distance', '2026-07-31', '2026-07-31');
    expect(series.points).toEqual([{ dateTime: '2026-07-31', value: 6.23 }]);
  });

  it('extracts the MODERATE level for minutesFairlyActive', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            rollupDataPoints: [
              rollupPoint(31, {
                activeMinutes: {
                  activeMinutesRollupByActivityLevel: [
                    { activityLevel: 'LIGHT', activeMinutesSum: '210' },
                    { activityLevel: 'MODERATE', activeMinutesSum: '35' },
                    { activityLevel: 'VIGOROUS', activeMinutesSum: '25' },
                  ],
                },
              }),
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const series = await getActivityTimeSeries(
      client,
      'minutesFairlyActive',
      '2026-07-31',
      '2026-07-31',
    );
    expect(series.points).toEqual([{ dateTime: '2026-07-31', value: 35 }]);
    const call = fetchMock.mock.calls[0] as unknown as [URL | string];
    expect(String(call[0])).toContain('/dataTypes/active-minutes/');
  });

  it('chunks total-calories requests at the 14-day cap', async () => {
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const startDay = body.range.start.date;
      return new Response(
        JSON.stringify({
          rollupDataPoints: [
            rollupPoint(startDay.day, { totalCalories: { kcalSum: 2000 + startDay.day } }),
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const series = await getActivityTimeSeries(client, 'calories', '2026-07-01', '2026-07-30');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const ranges = fetchMock.mock.calls.map((c: unknown[]) => {
      const body = JSON.parse(String((c[1] as RequestInit).body));
      return [body.range.start.date.day, body.range.end.date.day];
    });
    expect(ranges).toEqual([
      [1, 15],
      [15, 29],
      [29, 31],
    ]);
    expect(series.points).toEqual([
      { dateTime: '2026-07-01', value: 2001 },
      { dateTime: '2026-07-15', value: 2015 },
      { dateTime: '2026-07-29', value: 2029 },
    ]);
  });

  it('rejects caloriesBMR (no Google Health equivalent)', async () => {
    const client = new GoogleHealthClient(envWithFreshToken());
    await expect(
      getActivityTimeSeries(client, 'caloriesBMR', '2026-07-01', '2026-07-02'),
    ).rejects.toThrow(/caloriesBMR/);
  });
});

describe('getDailySummary', () => {
  it('assembles the composite summary from per-type rollups and daily reads', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const p = url.pathname;
      let body: unknown = { rollupDataPoints: [] };
      if (p.includes('/dataTypes/steps/')) {
        body = { rollupDataPoints: [rollupPoint(31, { steps: { countSum: '8421' } })] };
      } else if (p.includes('/dataTypes/distance/')) {
        body = {
          rollupDataPoints: [rollupPoint(31, { distance: { millimetersSum: '6230000' } })],
        };
      } else if (p.includes('/dataTypes/total-calories/')) {
        body = { rollupDataPoints: [rollupPoint(31, { totalCalories: { kcalSum: 2450.7 } })] };
      } else if (p.includes('/dataTypes/active-energy-burned/')) {
        body = {
          rollupDataPoints: [rollupPoint(31, { activeEnergyBurned: { kcalSum: 820.4 } })],
        };
      } else if (p.includes('/dataTypes/floors/')) {
        body = { rollupDataPoints: [rollupPoint(31, { floors: { countSum: '12' } })] };
      } else if (p.includes('/dataTypes/sedentary-period/')) {
        body = {
          rollupDataPoints: [rollupPoint(31, { sedentaryPeriod: { durationSum: '39600s' } })],
        };
      } else if (p.includes('/dataTypes/altitude/')) {
        body = {
          rollupDataPoints: [rollupPoint(31, { altitude: { gainMillimetersSum: '12500' } })],
        };
      } else if (p.includes('/dataTypes/active-minutes/')) {
        body = {
          rollupDataPoints: [
            rollupPoint(31, {
              activeMinutes: {
                activeMinutesRollupByActivityLevel: [
                  { activityLevel: 'LIGHT', activeMinutesSum: '210' },
                  { activityLevel: 'MODERATE', activeMinutesSum: '35' },
                  { activityLevel: 'VIGOROUS', activeMinutesSum: '25' },
                ],
              },
            }),
          ],
        };
      } else if (p.includes('/dataTypes/daily-resting-heart-rate/')) {
        body = {
          dataPoints: [
            {
              dailyRestingHeartRate: {
                date: { year: 2026, month: 7, day: 31 },
                beatsPerMinute: '54',
              },
            },
          ],
        };
      } else if (p.includes('/dataTypes/daily-heart-rate-zones/')) {
        body = {
          dataPoints: [
            {
              dailyHeartRateZones: {
                date: { year: 2026, month: 7, day: 31 },
                heartRateZones: [
                  { heartRateZoneType: 'LIGHT', minBeatsPerMinute: '97', maxBeatsPerMinute: '118' },
                ],
              },
            },
          ],
        };
      } else if (p.includes('/dataTypes/time-in-heart-rate-zone/')) {
        body = {
          rollupDataPoints: [
            rollupPoint(31, {
              timeInHeartRateZone: {
                timeInHeartRateZones: [{ heartRateZone: 'LIGHT', duration: '3600s' }],
              },
            }),
          ],
        };
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const summary = await getDailySummary(client, '2026-07-31');

    expect(summary.summary.steps).toBe(8421);
    expect(summary.summary.caloriesOut).toBe(2451);
    expect(summary.summary.activityCalories).toBe(820);
    expect(summary.summary.distances).toEqual([{ activity: 'total', distance: 6.23 }]);
    expect(summary.summary.floors).toBe(12);
    expect(summary.summary.elevation).toBe(12.5);
    expect(summary.summary.sedentaryMinutes).toBe(660);
    expect(summary.summary.lightlyActiveMinutes).toBe(210);
    expect(summary.summary.fairlyActiveMinutes).toBe(35);
    expect(summary.summary.veryActiveMinutes).toBe(25);
    expect(summary.summary.restingHeartRate).toBe(54);
    expect(summary.summary.heartRateZones).toEqual([
      { name: 'Light', min: 97, max: 118, minutes: 60 },
    ]);
    // Google Health has no goals API
    expect(summary.goals).toBeUndefined();
  });

  it('returns an empty summary shape when no data exists for the date', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const body = url.pathname.endsWith(':dailyRollUp')
        ? { rollupDataPoints: [] }
        : { dataPoints: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const summary = await getDailySummary(client, '2026-07-31');

    expect(summary.summary.steps).toBeUndefined();
    expect(summary.summary.distances).toBeUndefined();
    expect(summary.summary.elevation).toBeUndefined();
    expect(summary.summary.heartRateZones).toBeUndefined();
  });
});

describe('range guards', () => {
  it('rejects ranges needing more rollup requests than the chunk budget', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ rollupDataPoints: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    // calories is capped at 14-day chunks; 281+ days exceeds the 20-chunk budget
    await expect(
      getActivityTimeSeries(client, 'calories', '2025-01-01', '2026-07-31'),
    ).rejects.toThrow(/narrow the range/i);
    // and nothing should have been fetched
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty series when the API reports no data for the range', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const series = await getActivityTimeSeries(client, 'steps', '2026-07-30', '2026-07-31');
    expect(series.points).toEqual([]);
  });
});
