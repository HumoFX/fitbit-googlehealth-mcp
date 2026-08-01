import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleHealthProvider } from '../../../src/providers/google-health';
import { resetGoogleTokenMemory } from '../../../src/providers/google-health/oauth';
import { createMockEnv } from '../../helpers/mock-env';

function envWithFreshToken() {
  return createMockEnv({
    gh_access_token: 'valid-token',
    gh_refresh_token: 'refresh-token',
    gh_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
  });
}

function stubList(body: unknown) {
  const urls: URL[] = [];
  const fetchMock = vi.fn(async (input: string | URL) => {
    urls.push(new URL(String(input)));
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return urls;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetGoogleTokenMemory();
});

describe('getSpO2', () => {
  it('maps daily-oxygen-saturation bounds onto avg/min/max', async () => {
    const urls = stubList({
      dataPoints: [
        {
          dailyOxygenSaturation: {
            date: { year: 2026, month: 8, day: 1 },
            averagePercentage: 96.4,
            lowerBoundPercentage: 93.1,
            upperBoundPercentage: 99.2,
          },
        },
      ],
    });

    const days = await new GoogleHealthProvider(envWithFreshToken()).getSpO2(
      '2026-08-01',
      '2026-08-02',
    );

    expect(urls[0]?.pathname).toBe('/v4/users/me/dataTypes/daily-oxygen-saturation/dataPoints');
    expect(urls[0]?.searchParams.get('filter')).toBe(
      'daily_oxygen_saturation.date >= "2026-08-01" AND daily_oxygen_saturation.date < "2026-08-03"',
    );
    expect(days).toEqual([{ dateTime: '2026-08-01', value: { avg: 96.4, min: 93.1, max: 99.2 } }]);
  });
});

describe('getRespiratoryRate', () => {
  it('maps the daily breathing rate', async () => {
    stubList({
      dataPoints: [
        {
          dailyRespiratoryRate: { date: { year: 2026, month: 8, day: 1 }, breathsPerMinute: 14.2 },
        },
      ],
    });

    const days = await new GoogleHealthProvider(envWithFreshToken()).getRespiratoryRate(
      '2026-08-01',
      '2026-08-01',
    );
    expect(days).toEqual([{ dateTime: '2026-08-01', value: { breathingRate: 14.2 } }]);
  });
});

describe('getSkinTemperature', () => {
  it('exposes the absolute nightly reading and the relative deviation', async () => {
    // Fitbit reported a relative delta only; Google reports an absolute
    // nightly temperature plus a 30-day relative standard deviation.
    stubList({
      dataPoints: [
        {
          dailySleepTemperatureDerivations: {
            date: { year: 2026, month: 8, day: 1 },
            nightlyTemperatureCelsius: 33.8,
            relativeNightlyStddev30dCelsius: -0.4,
            baselineTemperatureCelsius: 34.2,
          },
        },
      ],
    });

    const days = await new GoogleHealthProvider(envWithFreshToken()).getSkinTemperature(
      '2026-08-01',
      '2026-08-01',
    );
    expect(days).toEqual([
      {
        dateTime: '2026-08-01',
        value: {
          nightlyRelative: -0.4,
          nightlyAbsoluteCelsius: 33.8,
          baselineCelsius: 34.2,
        },
      },
    ]);
  });
});

describe('getCardioFitness', () => {
  it('returns the VO2 max for the requested day', async () => {
    const urls = stubList({
      dataPoints: [
        {
          dailyVo2Max: {
            date: { year: 2026, month: 8, day: 1 },
            vo2Max: 47.3,
            cardioFitnessLevel: 'GOOD',
            estimated: true,
          },
        },
      ],
    });

    const result = await new GoogleHealthProvider(envWithFreshToken()).getCardioFitness(
      '2026-08-01',
    );
    expect(urls[0]?.pathname).toBe('/v4/users/me/dataTypes/daily-vo2-max/dataPoints');
    expect(result).toEqual({ dateTime: '2026-08-01', value: { vo2Max: 47.3 } });
  });

  it('returns an empty value when the day has no reading', async () => {
    stubList({ dataPoints: [] });
    const result = await new GoogleHealthProvider(envWithFreshToken()).getCardioFitness(
      '2026-08-01',
    );
    expect(result).toEqual({ dateTime: '2026-08-01', value: {} });
  });
});
