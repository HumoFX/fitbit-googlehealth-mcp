import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleHealthProvider } from '../../../src/providers/google-health';
import { downsample } from '../../../src/providers/google-health/heart';
import { resetGoogleTokenMemory } from '../../../src/providers/google-health/oauth';
import { createMockEnv } from '../../helpers/mock-env';

function envWithFreshToken() {
  return createMockEnv({
    gh_access_token: 'valid-token',
    gh_refresh_token: 'refresh-token',
    gh_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
  });
}

function stubByPath(handler: (path: string) => unknown) {
  const urls: URL[] = [];
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    return new Response(JSON.stringify(handler(url.pathname)), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return urls;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetGoogleTokenMemory();
});

describe('downsample', () => {
  const points = [
    { time: '00:00:00', value: 60 },
    { time: '00:00:30', value: 62 },
    { time: '00:01:00', value: 70 },
    { time: '00:01:30', value: 80 },
    { time: '00:05:00', value: 90 },
  ];

  it('averages native samples into the requested bucket', () => {
    // The API has no detailLevel buckets — it returns ~5-second native
    // samples, so the resolution Fitbit callers ask for is produced here.
    expect(downsample(points, '1min')).toEqual([
      { time: '00:00:00', value: 61 },
      { time: '00:01:00', value: 75 },
      { time: '00:05:00', value: 90 },
    ]);
  });

  it('collapses everything into five-minute buckets', () => {
    expect(downsample(points, '5min')).toEqual([
      { time: '00:00:00', value: 68 },
      { time: '00:05:00', value: 90 },
    ]);
  });

  it('passes samples through at 1sec', () => {
    expect(downsample(points, '1sec')).toEqual(points);
  });
});

describe('getHeartRateIntraday', () => {
  it('lists native samples for the day and downsamples them', async () => {
    const urls = stubByPath((path) => {
      if (path.includes('/daily-resting-heart-rate/')) {
        return {
          dataPoints: [
            {
              dailyRestingHeartRate: {
                date: { year: 2026, month: 8, day: 1 },
                beatsPerMinute: '58',
              },
            },
          ],
        };
      }
      if (path.includes('/dataTypes/heart-rate/')) {
        return {
          dataPoints: [
            {
              heartRate: {
                sampleTime: { physicalTime: '2026-07-31T15:00:00Z', utcOffset: '32400s' },
                beatsPerMinute: '61',
              },
            },
            {
              heartRate: {
                sampleTime: { physicalTime: '2026-07-31T15:00:30Z', utcOffset: '32400s' },
                beatsPerMinute: '63',
              },
            },
          ],
        };
      }
      return { dataPoints: [], rollupDataPoints: [] };
    });

    const result = await new GoogleHealthProvider(envWithFreshToken()).getHeartRateIntraday(
      '2026-08-01',
      '1min',
    );

    const hrUrl = urls.find((u) => u.pathname.includes('/dataTypes/heart-rate/'));
    expect(hrUrl?.searchParams.get('filter')).toBe(
      'heart_rate.sample_time.civil_time >= "2026-08-01" AND heart_rate.sample_time.civil_time < "2026-08-02"',
    );
    expect(result.date).toBe('2026-08-01');
    expect(result.detailLevel).toBe('1min');
    expect(result.restingHeartRate).toBe(58);
    // times are local wall clock, as Fitbit reported them
    expect(result.points).toEqual([{ time: '00:00:00', value: 62 }]);
  });
});

describe('getExerciseList', () => {
  it('maps exercise sessions newest-first with their summary metrics', async () => {
    const urls = stubByPath(() => ({
      dataPoints: [
        {
          dataPointName: 'users/me/dataTypes/exercise/dataPoints/e-1',
          exercise: {
            interval: {
              startTime: '2026-08-01T09:30:00Z',
              endTime: '2026-08-01T10:15:00Z',
              startUtcOffset: '32400s',
              endUtcOffset: '32400s',
            },
            exerciseType: 'RUNNING',
            displayName: 'Morning run',
            activeDuration: '2700s',
            metricsSummary: {
              caloriesKcal: 420,
              distanceMillimeters: 7500000,
              averageHeartRateBeatsPerMinute: '148',
              steps: '8200',
            },
          },
        },
      ],
    }));

    const logs = await new GoogleHealthProvider(envWithFreshToken()).getExerciseList({
      beforeDate: '2026-08-02',
      limit: 5,
    });

    expect(urls[0]?.pathname).toBe('/v4/users/me/dataTypes/exercise/dataPoints:reconcile');
    expect(logs).toEqual([
      {
        logId: 'users/me/dataTypes/exercise/dataPoints/e-1',
        activityName: 'Morning run',
        startTime: '2026-08-01T18:30:00.000',
        duration: 45 * 60_000,
        calories: 420,
        distance: 7.5,
        distanceUnit: 'Kilometer',
        steps: 8200,
        averageHeartRate: 148,
      },
    ]);
  });
});

describe('getBodyLog', () => {
  it('merges weight and body-fat samples', async () => {
    stubByPath((path) =>
      path.includes('/dataTypes/weight/')
        ? {
            dataPoints: [
              {
                dataPointName: 'users/me/dataTypes/weight/dataPoints/w-1',
                weight: {
                  sampleTime: { physicalTime: '2026-07-31T22:15:00Z', utcOffset: '32400s' },
                  weightGrams: 70400,
                },
              },
            ],
          }
        : {
            dataPoints: [
              {
                dataPointName: 'users/me/dataTypes/body-fat/dataPoints/b-1',
                bodyFat: {
                  sampleTime: { physicalTime: '2026-07-31T22:16:00Z', utcOffset: '32400s' },
                  percentage: 18.5,
                },
              },
            ],
          },
    );

    const body = await new GoogleHealthProvider(envWithFreshToken()).getBodyLog(
      '2026-08-01',
      '2026-08-01',
    );

    expect(body.weight).toEqual([
      {
        logId: 'users/me/dataTypes/weight/dataPoints/w-1',
        date: '2026-08-01',
        time: '07:15:00',
        weight: 70.4,
      },
    ]);
    expect(body.fat).toEqual([
      {
        logId: 'users/me/dataTypes/body-fat/dataPoints/b-1',
        date: '2026-08-01',
        time: '07:16:00',
        fat: 18.5,
      },
    ]);
  });
});

describe('getFoodLog', () => {
  it('merges nutrition and hydration logs into the day summary', async () => {
    stubByPath((path) =>
      path.includes('/dataTypes/nutrition-log/')
        ? {
            dataPoints: [
              {
                dataPointName: 'users/me/dataTypes/nutrition-log/dataPoints/n-1',
                nutritionLog: {
                  interval: {
                    startTime: '2026-08-01T03:00:00Z',
                    endTime: '2026-08-01T03:01:00Z',
                    startUtcOffset: '32400s',
                    endUtcOffset: '32400s',
                  },
                  foodDisplayName: 'plov',
                  mealType: 'LUNCH',
                  energy: { kcal: 650 },
                  totalCarbohydrate: { grams: 72 },
                  totalFat: { grams: 24 },
                  nutrients: [
                    { nutrient: 'PROTEIN', quantity: { grams: 28 } },
                    { nutrient: 'SODIUM', quantity: { grams: 0.9 } },
                  ],
                },
              },
            ],
          }
        : {
            dataPoints: [
              {
                dataPointName: 'users/me/dataTypes/hydration-log/dataPoints/h-1',
                hydrationLog: {
                  interval: {
                    startTime: '2026-08-01T03:00:00Z',
                    endTime: '2026-08-01T03:01:00Z',
                    startUtcOffset: '32400s',
                    endUtcOffset: '32400s',
                  },
                  amountConsumed: { milliliters: 250 },
                },
              },
            ],
          },
    );

    const log = await new GoogleHealthProvider(envWithFreshToken()).getFoodLog('2026-08-01');

    expect(log.foods).toEqual([
      {
        logId: 'users/me/dataTypes/nutrition-log/dataPoints/n-1',
        logDate: '2026-08-01',
        loggedFood: { name: 'plov', calories: 650, mealTypeId: 3 },
        nutritionalValues: { calories: 650, carbs: 72, fat: 24, protein: 28, sodium: 900 },
      },
    ]);
    // day totals, so the LLM does not have to add them up
    expect(log.summary).toEqual({
      calories: 650,
      carbs: 72,
      fat: 24,
      protein: 28,
      sodium: 900,
      water: 250,
    });
    expect(log.water?.water).toEqual([
      { logId: 'users/me/dataTypes/hydration-log/dataPoints/h-1', amount: 250 },
    ]);
  });
});
