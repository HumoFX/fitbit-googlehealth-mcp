import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleHealthClient } from '../../../src/providers/google-health/client';
import { getHeartRateRange } from '../../../src/providers/google-health/heart';
import { chunkDateRange } from '../../../src/providers/google-health/rollup';
import { createMockEnv } from '../../helpers/mock-env';

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, '../../fixtures/google-health', name), 'utf-8'));
}

const rhrFixture = loadFixture('daily-rhr-list.json');
const zonesFixture = loadFixture('daily-zones-list.json');
const tizFixture = loadFixture('time-in-zone-rollup.json');

function envWithFreshToken() {
  return createMockEnv({
    gh_access_token: 'valid-token',
    gh_refresh_token: 'refresh-token',
    gh_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
  });
}

/** Dispatch mocked responses by data type in the URL. */
function stubHeartFetch() {
  const requests: URL[] = [];
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    requests.push(url);
    let body: unknown = { dataPoints: [] };
    if (url.pathname.includes('/daily-resting-heart-rate/')) body = rhrFixture;
    else if (url.pathname.includes('/daily-heart-rate-zones/')) body = zonesFixture;
    else if (url.pathname.includes('/time-in-heart-rate-zone/')) body = tizFixture;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, requests };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chunkDateRange', () => {
  it('returns a single chunk when the range fits', () => {
    expect(chunkDateRange('2026-07-01', '2026-07-10', 14)).toEqual([
      { start: '2026-07-01', end: '2026-07-10' },
    ]);
  });

  it('splits ranges longer than maxDays into consecutive chunks', () => {
    expect(chunkDateRange('2026-07-01', '2026-07-30', 14)).toEqual([
      { start: '2026-07-01', end: '2026-07-14' },
      { start: '2026-07-15', end: '2026-07-28' },
      { start: '2026-07-29', end: '2026-07-30' },
    ]);
  });

  it('handles a single-day range', () => {
    expect(chunkDateRange('2026-07-01', '2026-07-01', 14)).toEqual([
      { start: '2026-07-01', end: '2026-07-01' },
    ]);
  });
});

describe('getHeartRateRange', () => {
  it('merges resting HR, zone thresholds, and time-in-zone into HeartRateDay[]', async () => {
    stubHeartFetch();

    const client = new GoogleHealthClient(envWithFreshToken());
    const days = await getHeartRateRange(client, '2026-07-30', '2026-07-31');

    expect(days).toHaveLength(2);
    const [d1, d2] = days;
    if (!d1 || !d2) throw new Error('missing days');

    expect(d1.dateTime).toBe('2026-07-30');
    expect(d1.value.restingHeartRate).toBe(52);
    const zones1 = d1.value.heartRateZones;
    if (!zones1) throw new Error('missing zones');
    expect(zones1).toHaveLength(4);
    expect(zones1[0]).toEqual({ name: 'Light', min: 97, max: 118, minutes: 60 });
    expect(zones1[1]).toEqual({ name: 'Moderate', min: 119, max: 139, minutes: 10 });
    // Zones with thresholds but no recorded time on a day that has rollup data → 0 minutes
    expect(zones1[2]).toEqual({ name: 'Vigorous', min: 140, max: 162, minutes: 0 });
    expect(zones1[3]).toEqual({ name: 'Peak', min: 163, max: 220, minutes: 0 });

    expect(d2.dateTime).toBe('2026-07-31');
    expect(d2.value.restingHeartRate).toBe(54);
    expect(d2.value.heartRateZones?.[3]).toEqual({ name: 'Peak', min: 163, max: 220, minutes: 2 });
  });

  it('queries daily date filters for list reads and a civil range for the rollup', async () => {
    const { fetchMock, requests } = stubHeartFetch();

    const client = new GoogleHealthClient(envWithFreshToken());
    await getHeartRateRange(client, '2026-07-30', '2026-07-31');

    const rhrUrl = requests.find((u) => u.pathname.includes('/daily-resting-heart-rate/'));
    if (!rhrUrl) throw new Error('missing RHR request');
    expect(rhrUrl.searchParams.get('filter')).toBe(
      'daily_resting_heart_rate.date >= "2026-07-30" AND daily_resting_heart_rate.date < "2026-08-01"',
    );

    const zonesUrl = requests.find((u) => u.pathname.includes('/daily-heart-rate-zones/'));
    if (!zonesUrl) throw new Error('missing zones request');
    expect(zonesUrl.searchParams.get('filter')).toBe(
      'daily_heart_rate_zones.date >= "2026-07-30" AND daily_heart_rate_zones.date < "2026-08-01"',
    );

    const tizCall = fetchMock.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('/time-in-heart-rate-zone/'),
    ) as unknown as [URL | string, RequestInit];
    expect(String(tizCall[0])).toContain('dataPoints:dailyRollUp');
    const body = JSON.parse(String(tizCall[1].body));
    expect(body).toEqual({
      range: {
        start: { date: { year: 2026, month: 7, day: 30 } },
        end: { date: { year: 2026, month: 8, day: 1 } },
      },
      windowSizeDays: 1,
    });
  });

  it('returns days sorted ascending even when sources are sparse', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      let body: unknown = { dataPoints: [] };
      if (url.pathname.includes('/daily-resting-heart-rate/')) {
        // only one day, out of range order vs zones
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
      } else if (url.pathname.includes('/time-in-heart-rate-zone/')) {
        body = { rollupDataPoints: [] };
      } else if (url.pathname.includes('/daily-heart-rate-zones/')) {
        body = {
          dataPoints: [
            {
              dailyHeartRateZones: {
                date: { year: 2026, month: 7, day: 30 },
                heartRateZones: [
                  {
                    heartRateZoneType: 'LIGHT',
                    minBeatsPerMinute: '97',
                    maxBeatsPerMinute: '118',
                  },
                ],
              },
            },
          ],
        };
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const days = await getHeartRateRange(client, '2026-07-25', '2026-07-31');

    expect(days.map((d) => d.dateTime)).toEqual(['2026-07-30', '2026-07-31']);
    // Day without any rollup data → minutes stays undefined (unknown, not zero)
    expect(days[0]?.value.heartRateZones?.[0]?.minutes).toBeUndefined();
    // Day without zone thresholds → no heartRateZones array
    expect(days[1]?.value.heartRateZones).toBeUndefined();
    expect(days[1]?.value.restingHeartRate).toBe(54);
  });
});
