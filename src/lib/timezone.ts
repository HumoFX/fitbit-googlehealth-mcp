import type { Env } from '../env';
import type { HealthProvider } from '../providers/types';
import { DEFAULT_FALLBACK_TIMEZONE, isValidTimeZone, todayInZone } from './date';

// A timezone changes rarely; a day of caching keeps it off the hot path.
const TZ_CACHE_TTL_SEC = 24 * 60 * 60;
const TZ_CACHE_KEY = 'user_timezone';

/**
 * The timezone a bare `date` argument should be interpreted in. Resolution
 * order: the user's own Google Health / Fitbit profile setting, then the
 * DEFAULT_TIMEZONE var, then Asia/Tokyo (what this server assumed before
 * timezones were resolved at all).
 *
 * Failures are swallowed deliberately: an old grant without the profile
 * scope must degrade to a default, not turn every dateless tool call into
 * an auth error.
 */
export async function resolveTimezone(
  env: Env,
  provider: Pick<HealthProvider, 'getProfile'>,
): Promise<string> {
  const fallback =
    env.DEFAULT_TIMEZONE && isValidTimeZone(env.DEFAULT_TIMEZONE)
      ? env.DEFAULT_TIMEZONE
      : DEFAULT_FALLBACK_TIMEZONE;

  const cached = await env.CACHE.get(TZ_CACHE_KEY);
  if (cached) return cached;

  let resolved = fallback;
  try {
    const profile = await provider.getProfile();
    const timezone = profile.user.timezone;
    if (timezone && isValidTimeZone(timezone)) {
      resolved = timezone;
    }
  } catch {
    // keep the fallback
  }

  await env.CACHE.put(TZ_CACHE_KEY, resolved, { expirationTtl: TZ_CACHE_TTL_SEC });
  return resolved;
}

/**
 * The zone to stamp on writes. Callers pass it into the provider input, so
 * concurrent requests from different users never share one offset.
 */
export async function applyTimeZone(
  env: Env,
  provider: Pick<HealthProvider, 'getProfile'>,
): Promise<string> {
  return resolveTimezone(env, provider);
}

/** Today's civil date in the user's timezone — the default for bare `date` args. */
export async function resolveToday(
  env: Env,
  provider: Pick<HealthProvider, 'getProfile'>,
): Promise<string> {
  return todayInZone(await applyTimeZone(env, provider));
}
