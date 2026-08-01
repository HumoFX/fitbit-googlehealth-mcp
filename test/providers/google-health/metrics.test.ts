import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleHealthClient } from '../../../src/providers/google-health/client';
import { getHRV } from '../../../src/providers/google-health/metrics';
import { createMockEnv } from '../../helpers/mock-env';

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

describe('getHRV', () => {
  it('lists daily-heart-rate-variability and maps RMSSD fields to HrvDay', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            dataPoints: [
              {
                name: 'users/me/dataTypes/daily-heart-rate-variability/dataPoints/hrv-0730',
                dailyHeartRateVariability: {
                  date: { year: 2026, month: 7, day: 30 },
                  averageHeartRateVariabilityMilliseconds: 42.5,
                  deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 51.2,
                  nonRemHeartRateBeatsPerMinute: '58',
                  entropy: 3.1,
                },
              },
              {
                // Sparse day: only the average is present
                dailyHeartRateVariability: {
                  date: { year: 2026, month: 7, day: 31 },
                  averageHeartRateVariabilityMilliseconds: 39.0,
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const days = await getHRV(client, '2026-07-30', '2026-07-31');

    const call = fetchMock.mock.calls[0] as unknown as [URL | string];
    const url = new URL(String(call[0]));
    expect(url.pathname).toBe('/v4/users/me/dataTypes/daily-heart-rate-variability/dataPoints');
    expect(url.searchParams.get('filter')).toBe(
      'daily_heart_rate_variability.date >= "2026-07-30" AND daily_heart_rate_variability.date < "2026-08-01"',
    );

    expect(days).toEqual([
      { dateTime: '2026-07-30', value: { dailyRmssd: 42.5, deepRmssd: 51.2 } },
      { dateTime: '2026-07-31', value: { dailyRmssd: 39.0, deepRmssd: undefined } },
    ]);
  });

  it('sorts days ascending regardless of API order', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            dataPoints: [
              {
                dailyHeartRateVariability: {
                  date: { year: 2026, month: 7, day: 31 },
                  averageHeartRateVariabilityMilliseconds: 39,
                },
              },
              {
                dailyHeartRateVariability: {
                  date: { year: 2026, month: 7, day: 29 },
                  averageHeartRateVariabilityMilliseconds: 44,
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const days = await getHRV(client, '2026-07-29', '2026-07-31');
    expect(days.map((d) => d.dateTime)).toEqual(['2026-07-29', '2026-07-31']);
  });
});
