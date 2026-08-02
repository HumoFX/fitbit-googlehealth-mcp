import { DEFAULT_FALLBACK_TIMEZONE, dateStringInZone, offsetSecondsInZone } from '../../lib/date';
import type {
  BodyFatLog,
  ExerciseLog,
  FoodLogEntry,
  LogActivityInput,
  LogBodyFatInput,
  LogFoodInput,
  LogMealInput,
  LogSleepInput,
  LogWaterInput,
  LogWeightInput,
  NutritionalValues,
  SleepLog,
  WaterLogEntry,
  WeightLog,
} from '../types';
import type { GoogleHealthClient } from './client';
import {
  batchDeleteDataPoints,
  createDataPoint,
  toMealTypeEnum,
  toSampleTime,
  toSessionInterval,
} from './write';

const grams = (value: number) => ({ grams: value, userProvidedUnit: 'GRAM' as const });

/**
 * Nutrients that Google models as typed entries rather than dedicated
 * fields. Carbs and fat are excluded — they have top-level slots on
 * NutritionLog. Sodium is conventionally logged in milligrams.
 */
const NUTRIENT_FIELDS: Array<{
  key: keyof NutritionalValues;
  nutrient: string;
  toQuantity: (value: number) => Record<string, unknown>;
}> = [
  { key: 'protein', nutrient: 'PROTEIN', toQuantity: grams },
  { key: 'fiber', nutrient: 'DIETARY_FIBER', toQuantity: grams },
  { key: 'sugar', nutrient: 'SUGAR', toQuantity: grams },
  {
    key: 'sodium',
    nutrient: 'SODIUM',
    toQuantity: (mg) => ({ grams: mg / 1000, userProvidedUnit: 'MILLIGRAM' as const }),
  },
];

function buildNutritionLog(opts: {
  date: string;
  timeZone?: string;
  mealType: Parameters<typeof toMealTypeEnum>[0];
  foodName: string;
  calories: number;
  nutritionalValues?: NutritionalValues;
}): Record<string, unknown> {
  const nv = opts.nutritionalValues ?? {};
  const nutrients = NUTRIENT_FIELDS.flatMap(({ key, nutrient, toQuantity }) => {
    const value = nv[key];
    return value === undefined ? [] : [{ nutrient, quantity: toQuantity(value) }];
  });

  return {
    interval: toSessionInterval({ date: opts.date, timeZone: opts.timeZone }),
    foodDisplayName: opts.foodName,
    mealType: toMealTypeEnum(opts.mealType),
    energy: { kcal: opts.calories, userProvidedUnit: 'KILOCALORIE' },
    ...(nv.carbs !== undefined ? { totalCarbohydrate: grams(nv.carbs) } : {}),
    ...(nv.fat !== undefined ? { totalFat: grams(nv.fat) } : {}),
    ...(nutrients.length > 0 ? { nutrients } : {}),
  };
}

function foodEntry(
  logId: string,
  input: { foodName: string; calories: number; date: string },
): FoodLogEntry {
  return {
    logId,
    loggedFood: { name: input.foodName, calories: input.calories },
    logDate: input.date,
  };
}

export async function logFood(
  client: GoogleHealthClient,
  input: LogFoodInput,
): Promise<FoodLogEntry> {
  const name = await createDataPoint(client, 'nutrition-log', {
    nutritionLog: buildNutritionLog(input),
  });
  return foodEntry(name, input);
}

/**
 * One nutrition log per item, written sequentially so a partial failure is
 * visible in the entries written so far rather than lost in a rejected batch.
 */
export async function logMeal(
  client: GoogleHealthClient,
  input: LogMealInput,
): Promise<FoodLogEntry[]> {
  const entries: FoodLogEntry[] = [];
  for (const item of input.items) {
    const name = await createDataPoint(client, 'nutrition-log', {
      nutritionLog: buildNutritionLog({
        date: input.date,
        mealType: input.mealType,
        foodName: item.name,
        calories: item.calories,
        nutritionalValues: { protein: item.protein, carbs: item.carbs, fat: item.fat },
        timeZone: input.timeZone,
      }),
    });
    entries.push(foodEntry(name, { ...item, foodName: item.name, date: input.date }));
  }
  return entries;
}

export async function logWater(
  client: GoogleHealthClient,
  input: LogWaterInput,
): Promise<WaterLogEntry> {
  const name = await createDataPoint(client, 'hydration-log', {
    hydrationLog: {
      interval: toSessionInterval({ date: input.date, timeZone: input.timeZone }),
      amountConsumed: { milliliters: input.amountMl, userProvidedUnit: 'MILLILITER' },
    },
  });
  return { logId: name, amount: input.amountMl };
}

export async function logWeight(
  client: GoogleHealthClient,
  input: LogWeightInput,
): Promise<WeightLog> {
  const name = await createDataPoint(client, 'weight', {
    weight: {
      sampleTime: toSampleTime({ date: input.date, time: input.time, timeZone: input.timeZone }),
      weightGrams: Math.round(input.weightKg * 1000),
    },
  });
  return { logId: name, date: input.date, time: input.time, weight: input.weightKg };
}

export async function logBodyFat(
  client: GoogleHealthClient,
  input: LogBodyFatInput,
): Promise<BodyFatLog> {
  const name = await createDataPoint(client, 'body-fat', {
    bodyFat: {
      sampleTime: toSampleTime({ date: input.date, time: input.time, timeZone: input.timeZone }),
      percentage: input.fatPercent,
    },
  });
  return { logId: name, date: input.date, time: input.time, fat: input.fatPercent };
}

/**
 * Common activity names → Google's ExerciseType enum. The enum has ~180
 * members; anything unrecognised falls back to WORKOUT while the user's own
 * wording survives in displayName.
 */
const EXERCISE_TYPES: Record<string, string> = {
  run: 'RUNNING',
  running: 'RUNNING',
  jog: 'RUNNING',
  jogging: 'RUNNING',
  walk: 'WALKING',
  walking: 'WALKING',
  hike: 'HIKING',
  hiking: 'HIKING',
  bike: 'BIKING',
  biking: 'BIKING',
  cycling: 'BIKING',
  swim: 'SWIMMING',
  swimming: 'SWIMMING',
  yoga: 'YOGA',
  pilates: 'PILATES',
  tennis: 'TENNIS',
  golf: 'GOLF',
  boxing: 'BOXING',
  dance: 'DANCING',
  dancing: 'DANCING',
  elliptical: 'ELLIPTICAL',
  rowing: 'ROWING',
  spinning: 'SPINNING',
  treadmill: 'TREADMILL',
  weights: 'WEIGHTLIFTING',
  weightlifting: 'WEIGHTLIFTING',
  strength: 'STRENGTH_TRAINING',
};

export function toExerciseType(activityName: string): string {
  return EXERCISE_TYPES[activityName.trim().toLowerCase()] ?? 'WORKOUT';
}

export async function logActivity(
  client: GoogleHealthClient,
  input: LogActivityInput,
): Promise<ExerciseLog> {
  const displayName = input.activityName ?? 'Workout';
  // `startTime` arrives as HH:mm:ss from the Fitbit-shaped tool input.
  const time = input.startTime.slice(0, 5);
  const metricsSummary: Record<string, number> = {};
  if (input.manualCalories !== undefined) metricsSummary.caloriesKcal = input.manualCalories;
  if (input.distanceKm !== undefined) {
    metricsSummary.distanceMillimeters = Math.round(input.distanceKm * 1_000_000);
  }

  const name = await createDataPoint(client, 'exercise', {
    exercise: {
      interval: toSessionInterval({
        date: input.date,
        time,
        durationMs: input.durationMs,
        timeZone: input.timeZone,
      }),
      exerciseType: toExerciseType(displayName),
      displayName,
      // Required by the API even when a manual log carries no device metrics.
      metricsSummary,
    },
  });

  return {
    logId: name,
    activityName: displayName,
    startTime: `${input.date}T${input.startTime}`,
    duration: input.durationMs,
    calories: input.manualCalories,
    distance: input.distanceKm,
    distanceUnit: input.distanceKm !== undefined ? 'Kilometer' : undefined,
  };
}

export async function logSleep(
  client: GoogleHealthClient,
  input: LogSleepInput,
): Promise<SleepLog> {
  const interval = toSessionInterval({
    date: input.date,
    time: input.startTime,
    durationMs: input.durationMs,
    timeZone: input.timeZone,
  });
  const name = await createDataPoint(client, 'sleep', { sleep: { interval } });

  // A sleep belongs to the date it ended, matching Fitbit's dateOfSleep.
  const zone = input.timeZone ?? DEFAULT_FALLBACK_TIMEZONE;
  const endInstant = new Date(Date.parse(interval.endTime));
  const endLocalMs = endInstant.getTime() + offsetSecondsInZone(endInstant, zone) * 1000;
  return {
    logId: name,
    dateOfSleep: dateStringInZone(endInstant, zone),
    startTime: `${input.date}T${input.startTime}:00.000`,
    endTime: new Date(endLocalMs).toISOString().slice(0, 23),
    duration: input.durationMs,
    minutesAsleep: Math.round(input.durationMs / 60_000),
  };
}

const DELETE_TYPES = {
  food: 'nutrition-log',
  water: 'hydration-log',
  weight: 'weight',
  bodyFat: 'body-fat',
  activity: 'exercise',
  sleep: 'sleep',
} as const;

export function deleteByType(
  client: GoogleHealthClient,
  kind: keyof typeof DELETE_TYPES,
  logId: string | number,
): Promise<void> {
  return batchDeleteDataPoints(client, DELETE_TYPES[kind], [logId]);
}
