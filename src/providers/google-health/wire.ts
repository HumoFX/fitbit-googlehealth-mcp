import { z } from 'zod';

/**
 * Shared wire primitives for the Google Health API (v4).
 *
 * Conventions that differ from Fitbit and are normalized here:
 * - int64 fields arrive as decimal strings → `int64` coerces to number
 * - durations are protobuf strings like "3600s" / "3600.5s"
 * - dates are google.type.Date objects {year, month, day}
 * - timestamps are RFC-3339 UTC with separate civil/UTC-offset views
 */

export const int64 = z.coerce.number();

export const GhDateSchema = z.object({
  year: z.number(),
  month: z.number(),
  day: z.number(),
});
export type GhDate = z.infer<typeof GhDateSchema>;

export const GhTimeOfDaySchema = z.object({
  hours: z.number().optional(),
  minutes: z.number().optional(),
  seconds: z.number().optional(),
  nanos: z.number().optional(),
});
export type GhTimeOfDay = z.infer<typeof GhTimeOfDaySchema>;

export const GhCivilDateTimeSchema = z.object({
  date: GhDateSchema,
  time: GhTimeOfDaySchema.optional(),
});
export type GhCivilDateTime = z.infer<typeof GhCivilDateTimeSchema>;

/** SessionTimeInterval / ObservationTimeInterval share this wire shape. */
export const GhIntervalSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
  startUtcOffset: z.string().optional(),
  endUtcOffset: z.string().optional(),
  civilStartTime: GhCivilDateTimeSchema.optional(),
  civilEndTime: GhCivilDateTimeSchema.optional(),
});
export type GhInterval = z.infer<typeof GhIntervalSchema>;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `{year: 2026, month: 7, day: 5}` → `2026-07-05` */
export function ghDateToIso(d: GhDate): string {
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;
}

/** CivilDateTime → local ISO string in Fitbit's `YYYY-MM-DDTHH:mm:ss.000` shape. */
export function civilToLocalIso(c: GhCivilDateTime): string {
  const t = c.time ?? {};
  return `${ghDateToIso(c.date)}T${pad2(t.hours ?? 0)}:${pad2(t.minutes ?? 0)}:${pad2(t.seconds ?? 0)}.000`;
}

/** Parse a google-duration string ("3600s", "-3600.5s"). Malformed → 0. */
export function durationToSeconds(d: string | undefined): number {
  if (!d) return 0;
  const n = Number(d.replace(/s$/, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Shift an RFC-3339 UTC timestamp by a google-duration UTC offset and format
 * the resulting local wall-clock time as `YYYY-MM-DDTHH:mm:ss.000`.
 */
export function shiftToLocalIso(utcIso: string, offset: string | undefined): string {
  const shifted = new Date(Date.parse(utcIso) + durationToSeconds(offset) * 1000);
  return shifted.toISOString().slice(0, 23);
}

/** `2026-07-05` → `{year: 2026, month: 7, day: 5}` */
export function isoToGhDate(date: string): GhDate {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new RangeError(`Expected YYYY-MM-DD date, got: ${date}`);
  }
  return { year, month, day };
}

/** `2026-01-31` → `2026-02-01` (UTC-safe day increment). */
export function nextDayIso(date: string): string {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1000);
  return next.toISOString().slice(0, 10);
}

/**
 * AIP-160 civil time-range filter with an inclusive start date and an
 * exclusive next-day upper bound, e.g.
 * `sleep.interval.civil_end_time >= "2026-07-25" AND sleep.interval.civil_end_time < "2026-08-01"`.
 */
export function civilRangeFilter(
  field: string,
  startDate: string,
  endDateInclusive: string,
): string {
  return `${field} >= "${startDate}" AND ${field} < "${nextDayIso(endDateInclusive)}"`;
}
