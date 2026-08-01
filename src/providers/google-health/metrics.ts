import { z } from 'zod';
import type { HrvDay } from '../types';
import { type GoogleHealthClient, paginate } from './client';
import { civilRangeFilter, GhDateSchema, ghDateToIso } from './wire';

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
