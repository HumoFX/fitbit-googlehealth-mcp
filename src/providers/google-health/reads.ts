import { z } from 'zod';
import type { BodyFatLog, BodyLog, ExerciseLog, FoodLog, WeightLog } from '../types';
import { type GoogleHealthClient, paginate } from './client';
import {
  civilRangeFilter,
  durationToSeconds,
  GhIntervalSchema,
  int64,
  shiftToLocalIso,
} from './wire';

// Exercise and sleep pages are hard-capped at 25 items by the API.
const SESSION_PAGE_SIZE = 25;

/** Fitbit meal ids, so existing consumers of `mealTypeId` keep working. */
const MEAL_TYPE_IDS: Record<string, number> = {
  BEFORE_BREAKFAST: 1,
  BREAKFAST: 1,
  BEFORE_LUNCH: 2,
  LUNCH: 3,
  BEFORE_DINNER: 4,
  DINNER: 5,
  // Fitbit had no evening-snack or generic-snack slot; both land on
  // Anytime rather than dropping the field.
  AFTER_DINNER: 7,
  SNACK: 7,
  ANYTIME: 7,
  MEAL_TYPE_UNSPECIFIED: 7,
};

const SampleTimeSchema = z.object({
  physicalTime: z.string(),
  utcOffset: z.string().optional(),
});

async function listAll<T>(
  client: GoogleHealthClient,
  opts: { path: string; filter: string; pageSize?: number; schema: z.ZodType<T> },
): Promise<T[]> {
  const responseSchema = z.object({
    dataPoints: z.array(opts.schema).optional(),
    nextPageToken: z.string().optional(),
  });
  const { items, truncated } = await paginate(async (pageToken) => {
    const response = await client.requestJson(responseSchema, {
      path: opts.path,
      query: { filter: opts.filter, pageSize: opts.pageSize, pageToken },
    });
    return { items: response.dataPoints ?? [], nextPageToken: response.nextPageToken };
  });
  if (truncated) {
    throw new RangeError(
      `Query on ${opts.path} was cut off by pagination — narrow the date range.`,
    );
  }
  return items;
}

// ---------- Exercise list ----------

const ExercisePointSchema = z.object({
  dataPointName: z.string().optional(),
  name: z.string().optional(),
  exercise: z
    .object({
      interval: GhIntervalSchema,
      exerciseType: z.string().optional(),
      displayName: z.string().optional(),
      activeDuration: z.string().optional(),
      metricsSummary: z
        .object({
          caloriesKcal: z.number().optional(),
          distanceMillimeters: z.number().optional(),
          steps: int64.optional(),
          averageHeartRateBeatsPerMinute: int64.optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * Recent exercise sessions, newest first. Fitbit paged with
 * `beforeDate` + `limit`; here the window is a civil date range ending on
 * `beforeDate`, since the API filters rather than offsets.
 */
export async function getExerciseList(
  client: GoogleHealthClient,
  opts: { beforeDate?: string; limit?: number } = {},
): Promise<ExerciseLog[]> {
  const end = opts.beforeDate ?? new Date().toISOString().slice(0, 10);
  // The API filters instead of paging by offset, so recall is a window
  // rather than an offset. 90 days is the maximum range the API accepts
  // for a single query; `limit` then trims the newest rows from it.
  const start = new Date(Date.parse(`${end}T00:00:00Z`) - 89 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const points = await listAll(client, {
    path: '/users/me/dataTypes/exercise/dataPoints:reconcile',
    filter: civilRangeFilter('exercise.interval.civil_start_time', start, end),
    pageSize: SESSION_PAGE_SIZE,
    schema: ExercisePointSchema,
  });

  return points
    .flatMap((point) => {
      const ex = point.exercise;
      if (!ex) return [];
      const metrics = ex.metricsSummary;
      const distanceKm =
        metrics?.distanceMillimeters !== undefined
          ? metrics.distanceMillimeters / 1_000_000
          : undefined;
      return [
        {
          logId: point.dataPointName ?? point.name ?? '',
          activityName: ex.displayName,
          startTime: shiftToLocalIso(ex.interval.startTime, ex.interval.startUtcOffset),
          duration: ex.activeDuration
            ? durationToSeconds(ex.activeDuration) * 1000
            : Date.parse(ex.interval.endTime) - Date.parse(ex.interval.startTime),
          calories: metrics?.caloriesKcal,
          distance: distanceKm,
          distanceUnit: distanceKm !== undefined ? 'Kilometer' : undefined,
          steps: metrics?.steps,
          averageHeartRate: metrics?.averageHeartRateBeatsPerMinute,
        } satisfies ExerciseLog,
      ];
    })
    .sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''))
    .slice(0, opts.limit ?? 10);
}

// ---------- Body log ----------

const WeightPointSchema = z.object({
  dataPointName: z.string().optional(),
  name: z.string().optional(),
  weight: z.object({ sampleTime: SampleTimeSchema, weightGrams: z.number() }).optional(),
});

const BodyFatPointSchema = z.object({
  dataPointName: z.string().optional(),
  name: z.string().optional(),
  bodyFat: z.object({ sampleTime: SampleTimeSchema, percentage: z.number() }).optional(),
});

export async function getBodyLog(
  client: GoogleHealthClient,
  start: string,
  end: string,
): Promise<BodyLog> {
  const [weightPoints, fatPoints] = await Promise.all([
    listAll(client, {
      path: '/users/me/dataTypes/weight/dataPoints:reconcile',
      filter: civilRangeFilter('weight.sample_time.civil_time', start, end),
      schema: WeightPointSchema,
    }),
    listAll(client, {
      path: '/users/me/dataTypes/body-fat/dataPoints:reconcile',
      filter: civilRangeFilter('body_fat.sample_time.civil_time', start, end),
      schema: BodyFatPointSchema,
    }),
  ]);

  const weight: WeightLog[] = weightPoints.flatMap((point) => {
    const w = point.weight;
    if (!w) return [];
    const local = shiftToLocalIso(w.sampleTime.physicalTime, w.sampleTime.utcOffset);
    return [
      {
        logId: point.dataPointName ?? point.name ?? '',
        date: local.slice(0, 10),
        time: local.slice(11, 19),
        weight: w.weightGrams / 1000,
      },
    ];
  });

  const fat: BodyFatLog[] = fatPoints.flatMap((point) => {
    const f = point.bodyFat;
    if (!f) return [];
    const local = shiftToLocalIso(f.sampleTime.physicalTime, f.sampleTime.utcOffset);
    return [
      {
        logId: point.dataPointName ?? point.name ?? '',
        date: local.slice(0, 10),
        time: local.slice(11, 19),
        fat: f.percentage,
      },
    ];
  });

  return { weight, fat };
}

// ---------- Food log ----------

const NutritionPointSchema = z.object({
  dataPointName: z.string().optional(),
  name: z.string().optional(),
  nutritionLog: z
    .object({
      interval: GhIntervalSchema,
      foodDisplayName: z.string().optional(),
      mealType: z.string().optional(),
      energy: z.object({ kcal: z.number().optional() }).optional(),
      totalCarbohydrate: z.object({ grams: z.number().optional() }).optional(),
      totalFat: z.object({ grams: z.number().optional() }).optional(),
      nutrients: z
        .array(
          z.object({
            nutrient: z.string(),
            quantity: z.object({ grams: z.number().optional() }).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const HydrationPointSchema = z.object({
  dataPointName: z.string().optional(),
  name: z.string().optional(),
  hydrationLog: z
    .object({
      interval: GhIntervalSchema,
      amountConsumed: z.object({ milliliters: z.number().optional() }).optional(),
    })
    .optional(),
});

function addTo(target: Record<string, number>, key: string, value: number | undefined): void {
  if (value === undefined) return;
  target[key] = Math.round(((target[key] ?? 0) + value) * 100) / 100;
}

/**
 * A day of food and water. Totals are summed here so the model does not
 * have to add up entries itself. Calorie goals have no Google counterpart,
 * so `goals` is never populated.
 */
export async function getFoodLog(client: GoogleHealthClient, date: string): Promise<FoodLog> {
  const [foodPoints, waterPoints] = await Promise.all([
    listAll(client, {
      path: '/users/me/dataTypes/nutrition-log/dataPoints:reconcile',
      filter: civilRangeFilter('nutrition_log.interval.civil_start_time', date, date),
      schema: NutritionPointSchema,
    }),
    listAll(client, {
      path: '/users/me/dataTypes/hydration-log/dataPoints:reconcile',
      filter: civilRangeFilter('hydration_log.interval.civil_start_time', date, date),
      schema: HydrationPointSchema,
    }),
  ]);

  const summary: Record<string, number> = {};

  const foods = foodPoints.flatMap((point) => {
    const log = point.nutritionLog;
    if (!log) return [];
    const nutrients: Record<string, number> = {};
    for (const entry of log.nutrients ?? []) {
      const grams = entry.quantity?.grams;
      if (grams === undefined) continue;
      if (entry.nutrient === 'PROTEIN') nutrients.protein = grams;
      else if (entry.nutrient === 'DIETARY_FIBER') nutrients.fiber = grams;
      else if (entry.nutrient === 'SUGAR') nutrients.sugar = grams;
      // sodium is written in milligrams; report it the same way
      else if (entry.nutrient === 'SODIUM') nutrients.sodium = Math.round(grams * 1000);
    }

    const values = {
      calories: log.energy?.kcal,
      carbs: log.totalCarbohydrate?.grams,
      fat: log.totalFat?.grams,
      ...nutrients,
    };
    for (const [key, value] of Object.entries(values)) addTo(summary, key, value);

    return [
      {
        logId: point.dataPointName ?? point.name ?? '',
        logDate: date,
        loggedFood: {
          name: log.foodDisplayName,
          calories: log.energy?.kcal,
          mealTypeId: log.mealType ? MEAL_TYPE_IDS[log.mealType] : undefined,
        },
        nutritionalValues: values,
      },
    ];
  });

  const water = waterPoints.flatMap((point) => {
    const amount = point.hydrationLog?.amountConsumed?.milliliters;
    if (amount === undefined) return [];
    addTo(summary, 'water', amount);
    return [{ logId: point.dataPointName ?? point.name ?? '', amount }];
  });

  return {
    foods,
    summary,
    water: { summary: { water: summary.water }, water },
  };
}
