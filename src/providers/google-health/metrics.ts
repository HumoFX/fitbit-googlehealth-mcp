import { z } from 'zod';
import type { CardioFitness, HrvDay, RespiratoryRateDay, SkinTempDay, SpO2Day } from '../types';
import { type GoogleHealthClient, paginate } from './client';
import { civilRangeFilter, type GhDate, GhDateSchema, ghDateToIso } from './wire';

const HrvListResponseSchema = z.object({
  dataPoints: z
    .array(
      z.object({
        name: z.string().optional(),
        dailyHeartRateVariability: z
          .object({
            date: GhDateSchema,
            averageHeartRateVariabilityMilliseconds: z.number().optional(),
            deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: z.number().optional(),
            nonRemHeartRateBeatsPerMinute: z.coerce.number().optional(),
            entropy: z.number().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

/**
 * Daily HRV via `daily-heart-rate-variability`. Field mapping to the Fitbit
 * shape: dailyRmssd ← averageHeartRateVariabilityMilliseconds (both RMSSD in
 * ms), deepRmssd ← deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds.
 * Google-only extras (entropy, non-REM HR) are not part of the domain type.
 */
export async function getHRV(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<HrvDay[]> {
  const filter = civilRangeFilter('daily_heart_rate_variability.date', start, end);
  const { items: points, truncated } = await paginate(async (pageToken) => {
    const response = await client.requestJson(HrvListResponseSchema, {
      path: '/users/me/dataTypes/daily-heart-rate-variability/dataPoints',
      query: { filter, pageToken },
    });
    return { items: response.dataPoints ?? [], nextPageToken: response.nextPageToken };
  });
  if (truncated) {
    throw new RangeError(
      `HRV query ${start}..${end} was cut off by pagination — narrow the date range.`,
    );
  }

  return points
    .flatMap((point) => {
      const hrv = point.dailyHeartRateVariability;
      if (!hrv) return [];
      // Points may legally carry only entropy / non-REM HR; without either
      // RMSSD field they have no Fitbit-shaped value and would skew averages.
      if (
        hrv.averageHeartRateVariabilityMilliseconds === undefined &&
        hrv.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds === undefined
      ) {
        return [];
      }
      return [
        {
          dateTime: ghDateToIso(hrv.date),
          value: {
            dailyRmssd: hrv.averageHeartRateVariabilityMilliseconds,
            deepRmssd: hrv.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds,
          },
        },
      ];
    })
    .sort((a, b) => a.dateTime.localeCompare(b.dateTime));
}

/**
 * Shared shape for the `daily-*` data types: one data point per civil date,
 * filtered by `<snake_case_type>.date`, mapped to a Fitbit-style day entry.
 */
async function listDailyMetric<TWire, TOut>(
  client: GoogleHealthClient,
  opts: {
    dataType: string;
    unionField: string;
    filterField: string;
    schema: z.ZodType<TWire>;
    map: (wire: TWire, date: string) => TOut;
  },
  start: string,
  end: string,
): Promise<TOut[]> {
  const responseSchema = z.object({
    dataPoints: z.array(z.object({ name: z.string().optional() }).catchall(z.unknown())).optional(),
    nextPageToken: z.string().optional(),
  });
  const filter = civilRangeFilter(opts.filterField, start, end);
  const { items, truncated } = await paginate(async (pageToken) => {
    const response = await client.requestJson(responseSchema, {
      path: `/users/me/dataTypes/${opts.dataType}/dataPoints`,
      query: { filter, pageToken },
    });
    return { items: response.dataPoints ?? [], nextPageToken: response.nextPageToken };
  });
  if (truncated) {
    throw new RangeError(
      `${opts.dataType} query ${start}..${end} was cut off by pagination — narrow the date range.`,
    );
  }

  return items
    .flatMap((point) => {
      const raw = (point as Record<string, unknown>)[opts.unionField];
      if (raw === undefined) return [];
      const parsed = opts.schema.safeParse(raw);
      if (!parsed.success) return [];
      const date = ghDateToIso((raw as { date: GhDate }).date);
      return [{ date, out: opts.map(parsed.data, date) }];
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((entry) => entry.out);
}

const DailySpO2Schema = z.object({
  date: GhDateSchema,
  averagePercentage: z.number().optional(),
  lowerBoundPercentage: z.number().optional(),
  upperBoundPercentage: z.number().optional(),
});

export function getSpO2(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<SpO2Day[]> {
  return listDailyMetric(
    client,
    {
      dataType: 'daily-oxygen-saturation',
      unionField: 'dailyOxygenSaturation',
      filterField: 'daily_oxygen_saturation.date',
      schema: DailySpO2Schema,
      map: (w, date) => ({
        dateTime: date,
        value: {
          avg: w.averagePercentage,
          min: w.lowerBoundPercentage,
          max: w.upperBoundPercentage,
        },
      }),
    },
    start,
    end,
  );
}

const DailyRespiratoryRateSchema = z.object({
  date: GhDateSchema,
  breathsPerMinute: z.number().optional(),
});

/**
 * Fitbit broke breathing rate down per sleep stage; Google keeps the daily
 * value here and the per-stage statistics in a separate
 * `respiratory-rate-sleep-summary` type, so only the overall rate is filled.
 */
export function getRespiratoryRate(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<RespiratoryRateDay[]> {
  return listDailyMetric(
    client,
    {
      dataType: 'daily-respiratory-rate',
      unionField: 'dailyRespiratoryRate',
      filterField: 'daily_respiratory_rate.date',
      schema: DailyRespiratoryRateSchema,
      map: (w, date) => ({ dateTime: date, value: { breathingRate: w.breathsPerMinute } }),
    },
    start,
    end,
  );
}

const DailySkinTempSchema = z.object({
  date: GhDateSchema,
  nightlyTemperatureCelsius: z.number().optional(),
  relativeNightlyStddev30dCelsius: z.number().optional(),
  baselineTemperatureCelsius: z.number().optional(),
});

export function getSkinTemperature(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<SkinTempDay[]> {
  return listDailyMetric(
    client,
    {
      dataType: 'daily-sleep-temperature-derivations',
      unionField: 'dailySleepTemperatureDerivations',
      filterField: 'daily_sleep_temperature_derivations.date',
      schema: DailySkinTempSchema,
      map: (w, date) => ({
        dateTime: date,
        value: {
          nightlyRelative: w.relativeNightlyStddev30dCelsius,
          nightlyAbsoluteCelsius: w.nightlyTemperatureCelsius,
          baselineCelsius: w.baselineTemperatureCelsius,
        },
      }),
    },
    start,
    end,
  );
}

const DailyVo2MaxSchema = z.object({
  date: GhDateSchema,
  vo2Max: z.number().optional(),
  cardioFitnessLevel: z.string().optional(),
});

export async function getCardioFitness(
  client: GoogleHealthClient,
  date: string,
): Promise<CardioFitness> {
  const days = await listDailyMetric(
    client,
    {
      dataType: 'daily-vo2-max',
      unionField: 'dailyVo2Max',
      filterField: 'daily_vo2_max.date',
      schema: DailyVo2MaxSchema,
      map: (w, d): CardioFitness => ({ dateTime: d, value: { vo2Max: w.vo2Max } }),
    },
    date,
    date,
  );
  return days[0] ?? { dateTime: date, value: {} };
}
