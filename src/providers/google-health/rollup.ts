import { z } from 'zod';
import type { GoogleHealthClient } from './client';
import { GhCivilDateTimeSchema, int64, isoToGhDate, nextDayIso } from './wire';

/**
 * `:dailyRollUp` — civil-day aggregation. The response has no pagination
 * (default pageSize 1440 covers the 90-day maximum range at 1-day windows).
 *
 * Range caps (per API): 14 days for calories-in-heart-rate-zone, heart-rate,
 * active-minutes, and total-calories; 90 days for everything else. Callers
 * pass the applicable cap to `dailyRollUpChunked`.
 */
export const DailyRollupPointSchema = z.object({
  civilStartTime: GhCivilDateTimeSchema,
  civilEndTime: GhCivilDateTimeSchema.optional(),
  steps: z.object({ countSum: int64.optional() }).optional(),
  distance: z.object({ millimetersSum: int64.optional() }).optional(),
  altitude: z.object({ gainMillimetersSum: int64.optional() }).optional(),
  floors: z.object({ countSum: int64.optional() }).optional(),
  totalCalories: z.object({ kcalSum: z.number().optional() }).optional(),
  activeEnergyBurned: z.object({ kcalSum: z.number().optional() }).optional(),
  sedentaryPeriod: z.object({ durationSum: z.string().optional() }).optional(),
  activeMinutes: z
    .object({
      activeMinutesRollupByActivityLevel: z
        .array(z.object({ activityLevel: z.string(), activeMinutesSum: int64.optional() }))
        .optional(),
    })
    .optional(),
  timeInHeartRateZone: z
    .object({
      timeInHeartRateZones: z
        .array(z.object({ heartRateZone: z.string(), duration: z.string().optional() }))
        .optional(),
    })
    .optional(),
});
export type DailyRollupPoint = z.infer<typeof DailyRollupPointSchema>;

const DailyRollupResponseSchema = z.object({
  rollupDataPoints: z.array(DailyRollupPointSchema).optional(),
});

/** One-day-window daily rollup over an inclusive [start, end] date range. */
export async function dailyRollUp(
  client: GoogleHealthClient,
  dataType: string,
  start: string,
  endInclusive: string,
): Promise<DailyRollupPoint[]> {
  const response = await client.requestJson(DailyRollupResponseSchema, {
    path: `/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`,
    method: 'POST',
    json: {
      range: {
        start: { date: isoToGhDate(start) },
        end: { date: isoToGhDate(nextDayIso(endInclusive)) },
      },
      windowSizeDays: 1,
    },
  });
  return response.rollupDataPoints ?? [];
}

/**
 * Split an inclusive [start, end] date range into consecutive chunks of at
 * most `maxDays` days each.
 */
export function chunkDateRange(
  start: string,
  endInclusive: string,
  maxDays: number,
): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  let chunkStart = start;
  while (chunkStart <= endInclusive) {
    let chunkEnd = chunkStart;
    for (let d = 1; d < maxDays && chunkEnd < endInclusive; d++) {
      chunkEnd = nextDayIso(chunkEnd);
    }
    chunks.push({ start: chunkStart, end: chunkEnd });
    chunkStart = nextDayIso(chunkEnd);
  }
  return chunks;
}

// Upper bound on sequential rollup requests per tool call, so oversized
// ranges fail fast with an actionable message instead of dying mid-loop on
// the Workers subrequest budget (50/request on the free plan).
const MAX_CHUNKS_PER_CALL = 20;

/** `dailyRollUp` over ranges longer than the data type's cap, sequentially. */
export async function dailyRollUpChunked(
  client: GoogleHealthClient,
  dataType: string,
  start: string,
  endInclusive: string,
  maxDays: number,
): Promise<DailyRollupPoint[]> {
  const chunks = chunkDateRange(start, endInclusive, maxDays);
  if (chunks.length > MAX_CHUNKS_PER_CALL) {
    throw new RangeError(
      `Range ${start}..${endInclusive} needs ${chunks.length} ${dataType} rollup requests ` +
        `(max ${MAX_CHUNKS_PER_CALL}, ≈${MAX_CHUNKS_PER_CALL * maxDays} days for this resource) — narrow the range.`,
    );
  }
  const all: DailyRollupPoint[] = [];
  for (const chunk of chunks) {
    all.push(...(await dailyRollUp(client, dataType, chunk.start, chunk.end)));
  }
  return all;
}
