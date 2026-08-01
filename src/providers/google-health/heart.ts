import { z } from 'zod';
import type { HeartRateDay, HeartRateZone } from '../types';
import { type GoogleHealthClient, paginate } from './client';
import { chunkDateRange, DailyRollupPointSchema, dailyRollUp } from './rollup';
import { civilRangeFilter, durationToSeconds, GhDateSchema, ghDateToIso, int64 } from './wire';

const ZONE_ORDER = ['LIGHT', 'MODERATE', 'VIGOROUS', 'PEAK'] as const;
const ZONE_NAMES: Record<string, string> = {
  LIGHT: 'Light',
  MODERATE: 'Moderate',
  VIGOROUS: 'Vigorous',
  PEAK: 'Peak',
};

// time-in-heart-rate-zone is not in the API's 14-day list, so 90 days applies.
const TIME_IN_ZONE_MAX_RANGE_DAYS = 90;

const RhrListResponseSchema = z.object({
  dataPoints: z
    .array(
      z.object({
        name: z.string().optional(),
        dailyRestingHeartRate: z.object({ date: GhDateSchema, beatsPerMinute: int64 }).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

const ZonesListResponseSchema = z.object({
  dataPoints: z
    .array(
      z.object({
        name: z.string().optional(),
        dailyHeartRateZones: z
          .object({
            date: GhDateSchema,
            heartRateZones: z.array(
              z.object({
                heartRateZoneType: z.string(),
                minBeatsPerMinute: int64.optional(),
                maxBeatsPerMinute: int64.optional(),
              }),
            ),
          })
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

type ZoneThresholds = { type: string; min?: number; max?: number };

async function fetchRestingHeartRate(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<Map<string, number>> {
  const filter = civilRangeFilter('daily_resting_heart_rate.date', start, end);
  const { items: points, truncated } = await paginate(async (pageToken) => {
    const response = await client.requestJson(RhrListResponseSchema, {
      path: '/users/me/dataTypes/daily-resting-heart-rate/dataPoints',
      query: { filter, pageToken },
    });
    return { items: response.dataPoints ?? [], nextPageToken: response.nextPageToken };
  });
  if (truncated) {
    throw new RangeError(
      `Resting-heart-rate query ${start}..${end} was cut off by pagination — narrow the date range.`,
    );
  }

  const byDate = new Map<string, number>();
  for (const point of points) {
    const rhr = point.dailyRestingHeartRate;
    if (rhr) byDate.set(ghDateToIso(rhr.date), rhr.beatsPerMinute);
  }
  return byDate;
}

async function fetchZoneThresholds(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<Map<string, ZoneThresholds[]>> {
  const filter = civilRangeFilter('daily_heart_rate_zones.date', start, end);
  const { items: points, truncated } = await paginate(async (pageToken) => {
    const response = await client.requestJson(ZonesListResponseSchema, {
      path: '/users/me/dataTypes/daily-heart-rate-zones/dataPoints',
      query: { filter, pageToken },
    });
    return { items: response.dataPoints ?? [], nextPageToken: response.nextPageToken };
  });
  if (truncated) {
    throw new RangeError(
      `Heart-rate-zones query ${start}..${end} was cut off by pagination — narrow the date range.`,
    );
  }

  const byDate = new Map<string, ZoneThresholds[]>();
  for (const point of points) {
    const zones = point.dailyHeartRateZones;
    if (!zones) continue;
    byDate.set(
      ghDateToIso(zones.date),
      zones.heartRateZones.map((zone) => ({
        type: zone.heartRateZoneType,
        min: zone.minBeatsPerMinute,
        max: zone.maxBeatsPerMinute,
      })),
    );
  }
  return byDate;
}

async function fetchTimeInZoneMinutes(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<Map<string, Map<string, number>>> {
  const byDate = new Map<string, Map<string, number>>();
  for (const chunk of chunkDateRange(start, end, TIME_IN_ZONE_MAX_RANGE_DAYS)) {
    const points = await dailyRollUp(client, 'time-in-heart-rate-zone', chunk.start, chunk.end);
    for (const point of points) {
      const zones = point.timeInHeartRateZone?.timeInHeartRateZones;
      if (!zones) continue;
      const perZone = new Map<string, number>();
      for (const zone of zones) {
        perZone.set(zone.heartRateZone, Math.round(durationToSeconds(zone.duration) / 60));
      }
      byDate.set(ghDateToIso(point.civilStartTime.date), perZone);
    }
  }
  return byDate;
}

function buildZones(
  thresholds: ZoneThresholds[] | undefined,
  minutesByZone: Map<string, number> | undefined,
): HeartRateZone[] | undefined {
  const types = new Set<string>([
    ...(thresholds?.map((t) => t.type) ?? []),
    ...(minutesByZone?.keys() ?? []),
  ]);
  if (types.size === 0) return undefined;

  const ordered = [
    ...ZONE_ORDER.filter((t) => types.has(t)),
    ...[...types].filter((t) => !(ZONE_ORDER as readonly string[]).includes(t)),
  ];
  return ordered.map((type) => {
    const threshold = thresholds?.find((t) => t.type === type);
    // A day with rollup data but no entry for this zone spent 0 minutes in it;
    // a day with no rollup data at all has unknown time-in-zone.
    const minutes = minutesByZone ? (minutesByZone.get(type) ?? 0) : undefined;
    const zone: HeartRateZone = { name: ZONE_NAMES[type] ?? type };
    if (threshold?.min !== undefined) zone.min = threshold.min;
    if (threshold?.max !== undefined) zone.max = threshold.max;
    if (minutes !== undefined) zone.minutes = minutes;
    return zone;
  });
}

/**
 * Daily resting heart rate + heart-rate zones for each day in the range,
 * assembled from three Google Health data types: `daily-resting-heart-rate`,
 * `daily-heart-rate-zones` (Karvonen bpm thresholds), and
 * `time-in-heart-rate-zone` (per-zone durations via daily rollup).
 *
 * Zone caloriesOut has no Google Health equivalent here and is omitted
 * (`calories-in-heart-rate-zone` exists but is capped at 14-day ranges).
 */
export async function getHeartRateRange(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<HeartRateDay[]> {
  const [rhrByDate, zonesByDate, minutesByDate] = await Promise.all([
    fetchRestingHeartRate(client, start, end),
    fetchZoneThresholds(client, start, end),
    fetchTimeInZoneMinutes(client, start, end),
  ]);

  const dates = [
    ...new Set([...rhrByDate.keys(), ...zonesByDate.keys(), ...minutesByDate.keys()]),
  ].sort();

  return dates.map((date) => ({
    dateTime: date,
    value: {
      restingHeartRate: rhrByDate.get(date),
      heartRateZones: buildZones(zonesByDate.get(date), minutesByDate.get(date)),
    },
  }));
}

export type { ZoneThresholds };
// Re-exported for the daily-summary composite in activity.ts.
export {
  buildZones,
  DailyRollupPointSchema,
  fetchRestingHeartRate,
  fetchTimeInZoneMinutes,
  fetchZoneThresholds,
};
