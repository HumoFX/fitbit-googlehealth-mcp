import type { ActivityResourceT, DailySummary, TimeSeries } from '../types';
import type { GoogleHealthClient } from './client';
import {
  buildZones,
  fetchRestingHeartRate,
  fetchTimeInZoneMinutes,
  fetchZoneThresholds,
} from './heart';
import { type DailyRollupPoint, dailyRollUp, dailyRollUpChunked } from './rollup';
import { durationToSeconds, ghDateToIso } from './wire';

// Per-request range caps: 14 days for active-minutes and total-calories,
// 90 days for the rest (see RollUpDataPointsRequest docs).
const MAX_RANGE_DEFAULT = 90;
const MAX_RANGE_CAPPED = 14;

function activeMinutesForLevel(point: DailyRollupPoint, level: string): number {
  const entries = point.activeMinutes?.activeMinutesRollupByActivityLevel ?? [];
  return entries.find((e) => e.activityLevel === level)?.activeMinutesSum ?? 0;
}

type ResourceSpec = {
  dataType: string;
  maxDays: number;
  extract: (point: DailyRollupPoint) => number;
};

/**
 * Fitbit activity time-series resources → Google Health data types.
 * `caloriesBMR` is absent: basal-energy-burned exists as a raw data type but
 * has no rollup, so a daily series would require summing raw intervals.
 */
const RESOURCE_MAP: Partial<Record<ActivityResourceT, ResourceSpec>> = {
  steps: {
    dataType: 'steps',
    maxDays: MAX_RANGE_DEFAULT,
    extract: (p) => p.steps?.countSum ?? 0,
  },
  distance: {
    dataType: 'distance',
    maxDays: MAX_RANGE_DEFAULT,
    extract: (p) => (p.distance?.millimetersSum ?? 0) / 1_000_000, // mm → km
  },
  calories: {
    dataType: 'total-calories',
    maxDays: MAX_RANGE_CAPPED,
    extract: (p) => Math.round(p.totalCalories?.kcalSum ?? 0),
  },
  activityCalories: {
    dataType: 'active-energy-burned',
    maxDays: MAX_RANGE_DEFAULT,
    extract: (p) => Math.round(p.activeEnergyBurned?.kcalSum ?? 0),
  },
  elevation: {
    dataType: 'altitude',
    maxDays: MAX_RANGE_DEFAULT,
    extract: (p) => (p.altitude?.gainMillimetersSum ?? 0) / 1000, // mm → m
  },
  floors: {
    dataType: 'floors',
    maxDays: MAX_RANGE_DEFAULT,
    extract: (p) => p.floors?.countSum ?? 0,
  },
  minutesSedentary: {
    dataType: 'sedentary-period',
    maxDays: MAX_RANGE_DEFAULT,
    extract: (p) => Math.round(durationToSeconds(p.sedentaryPeriod?.durationSum) / 60),
  },
  minutesLightlyActive: {
    dataType: 'active-minutes',
    maxDays: MAX_RANGE_CAPPED,
    extract: (p) => activeMinutesForLevel(p, 'LIGHT'),
  },
  minutesFairlyActive: {
    dataType: 'active-minutes',
    maxDays: MAX_RANGE_CAPPED,
    extract: (p) => activeMinutesForLevel(p, 'MODERATE'),
  },
  minutesVeryActive: {
    dataType: 'active-minutes',
    maxDays: MAX_RANGE_CAPPED,
    extract: (p) => activeMinutesForLevel(p, 'VIGOROUS'),
  },
};

export async function getActivityTimeSeries(
  client: GoogleHealthClient,
  resource: ActivityResourceT,
  start: string,
  end: string,
): Promise<TimeSeries> {
  const spec = RESOURCE_MAP[resource];
  if (!spec) {
    throw new RangeError(
      `Resource "${resource}" has no Google Health equivalent. Supported resources: ${Object.keys(RESOURCE_MAP).join(', ')}.`,
    );
  }

  const points = await dailyRollUpChunked(client, spec.dataType, start, end, spec.maxDays);
  return {
    resource,
    // The API returns rollup windows newest-first; Fitbit series are ascending.
    points: points
      .map((p) => ({
        dateTime: ghDateToIso(p.civilStartTime.date),
        value: spec.extract(p),
      }))
      .sort((a, b) => a.dateTime.localeCompare(b.dateTime)),
  };
}

function firstPoint(points: DailyRollupPoint[]): DailyRollupPoint | undefined {
  return points[0];
}

/**
 * Fitbit's single daily-summary endpoint has no one-shot Google Health
 * equivalent — the composite is assembled from per-type 1-day rollups plus
 * the daily heart-rate reads. ~11 requests per call, well within the
 * 300 req/min/user quota; the tool layer caches the result for 1h.
 *
 * Not populated (no Google Health source): goals, caloriesBMR,
 * marginalCalories, per-zone caloriesOut.
 */
export async function getDailySummary(
  client: GoogleHealthClient,
  date: string,
): Promise<DailySummary> {
  const [
    steps,
    distance,
    totalCalories,
    activeEnergy,
    floors,
    altitude,
    activeMinutes,
    sedentary,
    rhrByDate,
    zonesByDate,
    minutesByDate,
  ] = await Promise.all([
    dailyRollUp(client, 'steps', date, date),
    dailyRollUp(client, 'distance', date, date),
    dailyRollUp(client, 'total-calories', date, date),
    dailyRollUp(client, 'active-energy-burned', date, date),
    dailyRollUp(client, 'floors', date, date),
    dailyRollUp(client, 'altitude', date, date),
    dailyRollUp(client, 'active-minutes', date, date),
    dailyRollUp(client, 'sedentary-period', date, date),
    fetchRestingHeartRate(client, date, date),
    fetchZoneThresholds(client, date, date),
    fetchTimeInZoneMinutes(client, date, date),
  ]);

  const stepsPoint = firstPoint(steps);
  const distancePoint = firstPoint(distance);
  const caloriesPoint = firstPoint(totalCalories);
  const activeEnergyPoint = firstPoint(activeEnergy);
  const floorsPoint = firstPoint(floors);
  const altitudePoint = firstPoint(altitude);
  const activeMinutesPoint = firstPoint(activeMinutes);
  const sedentaryPoint = firstPoint(sedentary);

  const distanceKm =
    distancePoint?.distance?.millimetersSum !== undefined
      ? distancePoint.distance.millimetersSum / 1_000_000
      : undefined;

  return {
    summary: {
      steps: stepsPoint?.steps?.countSum,
      caloriesOut:
        caloriesPoint?.totalCalories?.kcalSum !== undefined
          ? Math.round(caloriesPoint.totalCalories.kcalSum)
          : undefined,
      activityCalories:
        activeEnergyPoint?.activeEnergyBurned?.kcalSum !== undefined
          ? Math.round(activeEnergyPoint.activeEnergyBurned.kcalSum)
          : undefined,
      distances:
        distanceKm !== undefined ? [{ activity: 'total', distance: distanceKm }] : undefined,
      floors: floorsPoint?.floors?.countSum,
      elevation:
        altitudePoint?.altitude?.gainMillimetersSum !== undefined
          ? altitudePoint.altitude.gainMillimetersSum / 1000 // mm → m
          : undefined,
      sedentaryMinutes:
        sedentaryPoint?.sedentaryPeriod?.durationSum !== undefined
          ? Math.round(durationToSeconds(sedentaryPoint.sedentaryPeriod.durationSum) / 60)
          : undefined,
      lightlyActiveMinutes: activeMinutesPoint
        ? activeMinutesForLevel(activeMinutesPoint, 'LIGHT')
        : undefined,
      fairlyActiveMinutes: activeMinutesPoint
        ? activeMinutesForLevel(activeMinutesPoint, 'MODERATE')
        : undefined,
      veryActiveMinutes: activeMinutesPoint
        ? activeMinutesForLevel(activeMinutesPoint, 'VIGOROUS')
        : undefined,
      restingHeartRate: rhrByDate.get(date),
      heartRateZones: buildZones(zonesByDate.get(date), minutesByDate.get(date)),
    },
  };
}
