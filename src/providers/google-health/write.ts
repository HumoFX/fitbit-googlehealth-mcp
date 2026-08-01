import { z } from 'zod';
import { GoogleHealthApiError } from '../../lib/errors';
import type { LogId, MealTypeT } from '../types';
import type { GoogleHealthClient } from './client';

/**
 * All write paths go through `create` / `:batchDelete`, both of which return
 * a long-running `Operation` rather than the resource itself. In practice
 * these complete inline (`done: true`), and the created DataPoint comes back
 * in `operation.response`.
 */
const OperationSchema = z.object({
  name: z.string().optional(),
  done: z.boolean().optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).optional(),
  response: z.record(z.string(), z.unknown()).optional(),
});

// JST is what the tool layer dates are expressed in (see lib/date.ts).
const JST_OFFSET_SEC = 9 * 60 * 60;
const JST_OFFSET_DURATION = `${JST_OFFSET_SEC}s`;

function localToUtcIso(date: string, time: string): string {
  const [h, m] = time.split(':').map(Number);
  const base = Date.parse(`${date}T00:00:00Z`);
  const ms = base + ((h ?? 0) * 3600 + (m ?? 0) * 60 - JST_OFFSET_SEC) * 1000;
  return new Date(ms).toISOString();
}

export type SessionInterval = {
  startTime: string;
  endTime: string;
  startUtcOffset: string;
  endUtcOffset: string;
};

// The API rejects an empty window ("start time must be strictly earlier
// than end time"), so instantaneous logs get a one-minute one.
const POINT_IN_TIME_WINDOW_MS = 60_000;

/**
 * A SessionTimeInterval for logs that span a window (meals, hydration,
 * exercise, sleep). Without an explicit time we use local noon, which keeps
 * the entry on the intended civil date regardless of the offset.
 */
export function toSessionInterval(opts: {
  date: string;
  time?: string;
  durationMs?: number;
}): SessionInterval {
  const startTime = localToUtcIso(opts.date, opts.time ?? '12:00');
  const endTime = new Date(
    Date.parse(startTime) + (opts.durationMs || POINT_IN_TIME_WINDOW_MS),
  ).toISOString();
  return {
    startTime,
    endTime,
    startUtcOffset: JST_OFFSET_DURATION,
    endUtcOffset: JST_OFFSET_DURATION,
  };
}

/** An ObservationSampleTime for instantaneous measurements (weight, body fat). */
export function toSampleTime(opts: { date: string; time?: string }): {
  physicalTime: string;
  utcOffset: string;
} {
  return {
    physicalTime: localToUtcIso(opts.date, opts.time ?? '12:00'),
    utcOffset: JST_OFFSET_DURATION,
  };
}

/**
 * Fitbit meal slots → Google's meal enum. Google documents BEFORE_LUNCH as
 * "a morning snack" and BEFORE_DINNER as "an afternoon snack", so Fitbit's
 * two snack slots map exactly rather than collapsing into generic SNACK.
 */
const MEAL_TYPES: Record<MealTypeT, string> = {
  Breakfast: 'BREAKFAST',
  MorningSnack: 'BEFORE_LUNCH',
  Lunch: 'LUNCH',
  AfternoonSnack: 'BEFORE_DINNER',
  Dinner: 'DINNER',
  Anytime: 'ANYTIME',
};

export function toMealTypeEnum(mealType: MealTypeT): string {
  return MEAL_TYPES[mealType];
}

/** Data points are addressed by their full resource name everywhere. */
export function dataPointIdFromName(name: string): string {
  return name;
}

function unwrapOperation(raw: unknown, path: string): Record<string, unknown> | undefined {
  const parsed = OperationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GoogleHealthApiError(200, `Unexpected operation payload at ${path}`, path);
  }
  const op = parsed.data;
  if (op.error) {
    throw new GoogleHealthApiError(
      200,
      `Operation failed (code ${op.error.code ?? '?'}): ${op.error.message ?? 'no message'}`,
      path,
    );
  }
  if (op.done === false) {
    throw new GoogleHealthApiError(
      200,
      `Write is still in progress (operation ${op.name ?? 'unknown'}); the API returned an ` +
        'incomplete long-running operation. Re-read the day to confirm whether it landed.',
      path,
    );
  }
  return op.response;
}

/** Create one data point and return its resource name. */
export async function createDataPoint(
  client: GoogleHealthClient,
  dataType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const path = `/users/me/dataTypes/${dataType}/dataPoints`;
  const raw = await client.requestJson(z.unknown(), { path, method: 'POST', json: payload });
  const response = unwrapOperation(raw, path);
  const name = response?.name;
  if (typeof name !== 'string') {
    throw new GoogleHealthApiError(
      200,
      'Write succeeded but the operation carried no resource name, so the entry cannot be ' +
        'referenced for deletion. Re-read the day to locate it.',
      path,
    );
  }
  return name;
}

/** Delete data points by resource name (up to 10 000 per request). */
export async function batchDeleteDataPoints(
  client: GoogleHealthClient,
  dataType: string,
  names: LogId[],
): Promise<void> {
  for (const name of names) {
    if (typeof name !== 'string' || !name.includes('/dataPoints/')) {
      throw new RangeError(
        `Google Health deletes take the full data-point resource name ` +
          `(users/me/dataTypes/${dataType}/dataPoints/…), got: ${String(name)}. ` +
          'Use the logId returned by the matching read tool.',
      );
    }
  }
  const path = `/users/me/dataTypes/${dataType}/dataPoints:batchDelete`;
  const raw = await client.requestJson(z.unknown(), {
    path,
    method: 'POST',
    json: { names },
  });
  unwrapOperation(raw, path);
}
