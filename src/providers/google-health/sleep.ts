import { z } from 'zod';
import type { SleepLog } from '../types';
import { type GoogleHealthClient, paginate } from './client';
import {
  civilRangeFilter,
  civilToLocalIso,
  durationToSeconds,
  ghDateToIso,
  GhIntervalSchema,
  int64,
  shiftToLocalIso,
} from './wire';

// Sleep and exercise responses are hard-capped at 25 items per page.
const SLEEP_PAGE_SIZE = 25;

const GhSleepStageSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
  startUtcOffset: z.string().optional(),
  endUtcOffset: z.string().optional(),
  type: z.string(),
});
type GhSleepStage = z.infer<typeof GhSleepStageSchema>;

const GhSleepSchema = z.object({
  interval: GhIntervalSchema,
  type: z.string().optional(),
  stages: z.array(GhSleepStageSchema).optional(),
  summary: z
    .object({
      minutesAsleep: int64.optional(),
      minutesAwake: int64.optional(),
      minutesToFallAsleep: int64.optional(),
      minutesAfterWakeUp: int64.optional(),
      minutesInSleepPeriod: int64.optional(),
      stagesSummary: z
        .array(z.object({ type: z.string(), minutes: int64.optional(), count: int64.optional() }))
        .optional(),
    })
    .optional(),
  metadata: z
    .object({
      mainSleep: z.boolean().optional(),
      nap: z.boolean().optional(),
      processed: z.boolean().optional(),
      stagesStatus: z.string().optional(),
    })
    .optional(),
});
type GhSleep = z.infer<typeof GhSleepSchema>;

const SleepReconcileResponseSchema = z.object({
  dataPoints: z
    .array(z.object({ dataPointName: z.string().optional(), sleep: GhSleepSchema.optional() }))
    .optional(),
  nextPageToken: z.string().optional(),
});

/**
 * Google stage enums → Fitbit level strings. Fitbit uses `wake` for
 * stages-typed sleeps but `awake` for classic ones, so the mapping is
 * conditional on the session type.
 */
function mapStageLevel(ghType: string, sleepType: string | undefined): string {
  if (ghType === 'AWAKE') {
    return sleepType === 'CLASSIC' ? 'awake' : 'wake';
  }
  return ghType.toLowerCase();
}

function stageSeconds(stage: GhSleepStage): number {
  return Math.round((Date.parse(stage.endTime) - Date.parse(stage.startTime)) / 1000);
}

/** Stages counted as "asleep" for both classic and stages sessions. */
const ASLEEP_STAGES = new Set(['LIGHT', 'DEEP', 'REM', 'ASLEEP']);

export function mapGhSleepToSleepLog(dataPointName: string | undefined, s: GhSleep): SleepLog {
  const { interval } = s;
  const startLocal = interval.civilStartTime
    ? civilToLocalIso(interval.civilStartTime)
    : shiftToLocalIso(interval.startTime, interval.startUtcOffset);
  const endLocal = interval.civilEndTime
    ? civilToLocalIso(interval.civilEndTime)
    : shiftToLocalIso(interval.endTime, interval.endUtcOffset);
  const durationMs = Date.parse(interval.endTime) - Date.parse(interval.startTime);

  const stages = s.stages ?? [];
  const minutesAsleep =
    s.summary?.minutesAsleep ??
    (stages.length > 0
      ? Math.round(
          stages
            .filter((st) => ASLEEP_STAGES.has(st.type))
            .reduce((sum, st) => sum + stageSeconds(st), 0) / 60,
        )
      : Math.floor(durationMs / 60_000));

  const levelsData = stages.map((st) => ({
    dateTime: shiftToLocalIso(st.startTime, st.startUtcOffset ?? interval.startUtcOffset),
    level: mapStageLevel(st.type, s.type),
    seconds: stageSeconds(st),
  }));

  const stagesSummary = s.summary?.stagesSummary ?? [];
  const levelsSummary: Record<string, Record<string, number>> = {};
  for (const entry of stagesSummary) {
    levelsSummary[mapStageLevel(entry.type, s.type)] = {
      minutes: entry.minutes ?? 0,
      count: entry.count ?? 0,
    };
  }

  return {
    logId: dataPointName ?? '',
    dateOfSleep: interval.civilEndTime
      ? ghDateToIso(interval.civilEndTime.date)
      : endLocal.slice(0, 10),
    startTime: startLocal,
    endTime: endLocal,
    duration: durationMs,
    minutesAsleep,
    minutesAwake: s.summary?.minutesAwake,
    minutesToFallAsleep: s.summary?.minutesToFallAsleep,
    timeInBed: s.summary?.minutesInSleepPeriod,
    // Google Health has no efficiency metric — intentionally left undefined.
    efficiency: undefined,
    type: s.type?.toLowerCase(),
    isMainSleep: s.metadata?.mainSleep,
    levels:
      levelsData.length > 0 || Object.keys(levelsSummary).length > 0
        ? {
            summary: Object.keys(levelsSummary).length > 0 ? levelsSummary : undefined,
            data: levelsData.length > 0 ? levelsData : undefined,
          }
        : undefined,
  };
}

/**
 * Sleep sessions whose civil end date falls within [start, end], matching
 * Fitbit's `dateOfSleep` semantics (a sleep belongs to the date it ended).
 * Served from the reconciled stream so overlapping device/manual records
 * are already merged.
 */
export async function getSleepRange(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<SleepLog[]> {
  const filter = civilRangeFilter('sleep.interval.civil_end_time', start, end);
  const dataPoints = await paginate(async (pageToken) => {
    const response = await client.requestJson(SleepReconcileResponseSchema, {
      path: '/users/me/dataTypes/sleep/dataPoints:reconcile',
      query: { filter, pageSize: SLEEP_PAGE_SIZE, pageToken },
    });
    return { items: response.dataPoints ?? [], nextPageToken: response.nextPageToken };
  });

  return dataPoints
    .filter((dp) => dp.sleep !== undefined)
    .map((dp) => mapGhSleepToSleepLog(dp.dataPointName, dp.sleep as GhSleep));
}

export async function getSleep(client: GoogleHealthClient, date: string): Promise<SleepLog[]> {
  return getSleepRange(client, date, date);
}
