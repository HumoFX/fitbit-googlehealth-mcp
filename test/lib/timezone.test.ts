import { afterEach, describe, expect, it, vi } from 'vitest';
import { dateStringInZone, offsetSecondsInZone, todayInZone } from '../../src/lib/date';
import { resolveTimezone } from '../../src/lib/timezone';
import { createMockEnv, type MockKv } from '../helpers/mock-env';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('dateStringInZone', () => {
  it('formats an instant as the civil date in the given zone', () => {
    const instant = new Date('2026-08-02T19:30:00Z');
    // Tashkent is UTC+5, so 19:30Z is already 00:30 the next day
    expect(dateStringInZone(instant, 'Asia/Tashkent')).toBe('2026-08-03');
    expect(dateStringInZone(instant, 'Asia/Tokyo')).toBe('2026-08-03');
    expect(dateStringInZone(instant, 'UTC')).toBe('2026-08-02');
    expect(dateStringInZone(instant, 'America/New_York')).toBe('2026-08-02');
  });

  it('falls back to UTC when the zone is not a valid IANA name', () => {
    const instant = new Date('2026-08-02T19:30:00Z');
    expect(dateStringInZone(instant, 'Not/AZone')).toBe('2026-08-02');
  });
});

describe('offsetSecondsInZone', () => {
  it('returns the zone offset at a given instant', () => {
    const instant = new Date('2026-08-02T12:00:00Z');
    expect(offsetSecondsInZone(instant, 'Asia/Tashkent')).toBe(5 * 3600);
    expect(offsetSecondsInZone(instant, 'Asia/Tokyo')).toBe(9 * 3600);
    expect(offsetSecondsInZone(instant, 'UTC')).toBe(0);
  });

  it('honours daylight saving at the given instant', () => {
    // New York is UTC-4 in August, UTC-5 in January
    expect(offsetSecondsInZone(new Date('2026-08-02T12:00:00Z'), 'America/New_York')).toBe(
      -4 * 3600,
    );
    expect(offsetSecondsInZone(new Date('2026-01-02T12:00:00Z'), 'America/New_York')).toBe(
      -5 * 3600,
    );
  });
});

describe('todayInZone', () => {
  it('uses the zone rather than the host clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T20:00:00Z'));
    expect(todayInZone('Asia/Tashkent')).toBe('2026-08-03');
    expect(todayInZone('America/New_York')).toBe('2026-08-02');
  });
});

describe('resolveTimezone', () => {
  it("reads the user's timezone from the provider and caches it", async () => {
    const env = createMockEnv();
    const getProfile = vi.fn(async () => ({ user: { encodedId: 'u', timezone: 'Asia/Tashkent' } }));

    expect(await resolveTimezone(env, { getProfile } as never)).toBe('Asia/Tashkent');
    // second call is served from KV, not the API
    expect(await resolveTimezone(env, { getProfile } as never)).toBe('Asia/Tashkent');
    expect(getProfile).toHaveBeenCalledTimes(1);

    const store = (env.CACHE as unknown as MockKv).__store;
    expect([...store.keys()].some((k) => k.includes('timezone'))).toBe(true);
  });

  it('falls back to DEFAULT_TIMEZONE when the provider has none', async () => {
    const env = createMockEnv({}, { DEFAULT_TIMEZONE: 'Europe/Lisbon' } as never);
    const getProfile = vi.fn(async () => ({ user: { encodedId: 'u' } }));
    expect(await resolveTimezone(env, { getProfile } as never)).toBe('Europe/Lisbon');
  });

  it('falls back when the profile call fails, without surfacing the error', async () => {
    // Old grants lack the profile/settings scopes; a date default must not
    // turn every tool call into an auth failure.
    const env = createMockEnv({}, { DEFAULT_TIMEZONE: 'Europe/Lisbon' } as never);
    const getProfile = vi.fn(async () => {
      throw new Error('403 insufficient scopes');
    });
    expect(await resolveTimezone(env, { getProfile } as never)).toBe('Europe/Lisbon');
  });

  it('defaults to Asia/Tokyo when nothing else is configured', async () => {
    const env = createMockEnv();
    const getProfile = vi.fn(async () => ({ user: { encodedId: 'u' } }));
    expect(await resolveTimezone(env, { getProfile } as never)).toBe('Asia/Tokyo');
  });

  it('rejects a bogus provider timezone rather than propagating it', async () => {
    const env = createMockEnv();
    const getProfile = vi.fn(async () => ({ user: { encodedId: 'u', timezone: 'Mars/Olympus' } }));
    expect(await resolveTimezone(env, { getProfile } as never)).toBe('Asia/Tokyo');
  });
});
