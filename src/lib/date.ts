const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Fallback when no timezone is configured or resolvable. */
export const DEFAULT_FALLBACK_TIMEZONE = 'Asia/Tokyo';

function partsInZone(instant: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
}

/** True when the runtime recognises the IANA zone name. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Civil date (`YYYY-MM-DD`) of an instant in the given zone. */
export function dateStringInZone(instant: Date, timeZone: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = partsInZone(instant, zone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Today's civil date in the given zone. */
export function todayInZone(timeZone: string): string {
  return dateStringInZone(new Date(), timeZone);
}

/**
 * The zone's UTC offset in seconds *at that instant*, so daylight saving is
 * accounted for rather than assumed away.
 */
export function offsetSecondsInZone(instant: Date, timeZone: string): number {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const p = partsInZone(instant, zone);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour === '24' ? '0' : p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return Math.round((asUtc - instant.getTime()) / 1000);
}

/** Midnight-relative civil time in a zone expressed as a UTC instant. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [h, m] = time.split(':').map(Number);
  const naive = Date.parse(`${date}T00:00:00Z`) + ((h ?? 0) * 3600 + (m ?? 0) * 60) * 1000;
  // Two passes: the offset can differ either side of a DST boundary.
  let guess = naive - offsetSecondsInZone(new Date(naive), timeZone) * 1000;
  guess = naive - offsetSecondsInZone(new Date(guess), timeZone) * 1000;
  return new Date(guess);
}

/**
 * Format a Date/ms/ISO string as `YYYY-MM-DD` in JST.
 * Defaults to "today in JST" when no argument is given.
 */
export function toJstDateString(input: Date | string | number = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`Invalid date input: ${String(input)}`);
  }
  const shifted = new Date(d.getTime() + JST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

export function todayJst(): string {
  return toJstDateString();
}

const ISO_DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function assertIsoDate(value: string, field = 'date'): asserts value is string {
  if (!ISO_DATE_RE.test(value)) {
    throw new RangeError(`${field} must be YYYY-MM-DD (got: ${value})`);
  }
}

/**
 * Return `start,end` as YYYY-MM-DD after validating both are present and
 * `start <= end`. Used by Fitbit range endpoints.
 */
export function normalizeRange(start: string, end: string): { start: string; end: string } {
  assertIsoDate(start, 'start');
  assertIsoDate(end, 'end');
  if (start > end) {
    throw new RangeError(`Range is inverted: start=${start} > end=${end}`);
  }
  return { start, end };
}
