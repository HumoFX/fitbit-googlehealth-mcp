import { z } from 'zod';
import type { Env } from '../../env';
import { GoogleHealthAuthError } from '../../lib/errors';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Google does not rotate refresh tokens on refresh, so `refresh_token` is
// normally absent from the refresh response (unlike Fitbit).
const TokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string(),
});
type TokenResponseT = z.infer<typeof TokenResponse>;

const REFRESH_SKEW_SEC = 60;

/**
 * KV key layout in the TOKENS namespace:
 * - single-user mode (no userId): `gh_access_token` / `gh_refresh_token` /
 *   `gh_expires_at` — seeded by scripts/setup-google-health.ts
 * - multi-user mode: `gh_u_<userId>_*` — seeded by the OAuth callback via
 *   `persistGoogleTokens`, where userId is the Google `sub` claim
 * Fitbit's unprefixed keys live alongside; the prefixes never collide.
 */
function kvKeys(userId?: string) {
  const prefix = userId ? `gh_u_${userId}_` : 'gh_';
  return {
    access: `${prefix}access_token`,
    refresh: `${prefix}refresh_token`,
    expires: `${prefix}expires_at`,
  };
}

export type GoogleTokenBundle = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix seconds
};

// Per-isolate token memory, keyed by user (single-user mode uses ''). A
// composite tool call fires ~10 parallel API requests through
// getGoogleAccessToken; without this they would each read 3 KV keys
// (subrequest budget) and, on expiry, stampede the token endpoint with
// concurrent KV writes to the same keys (KV allows ~1 write/sec/key).
// Memory is only ever a copy of what KV holds, so a stale isolate at worst
// triggers the client's 401 → invalidate → refresh path.
const memoryTokens = new Map<string, { accessToken: string; expiresAt: number }>();
const refreshesInFlight = new Map<string, Promise<GoogleTokenBundle>>();

function memoryKey(userId?: string): string {
  return userId ?? '';
}

/** Test-only: clear the per-isolate token memory between test cases. */
export function resetGoogleTokenMemory(): void {
  memoryTokens.clear();
  refreshesInFlight.clear();
}

async function readStoredTokens(env: Env, userId?: string): Promise<GoogleTokenBundle> {
  const keys = kvKeys(userId);
  const [accessToken, refreshToken, expiresAtRaw] = await Promise.all([
    env.TOKENS.get(keys.access),
    env.TOKENS.get(keys.refresh),
    env.TOKENS.get(keys.expires),
  ]);
  if (!accessToken || !refreshToken || !expiresAtRaw) {
    throw new GoogleHealthAuthError(
      userId
        ? `Google Health tokens for user ${userId} not found in TOKENS KV. Reconnect the connector to re-authorize.`
        : 'Google Health tokens not found in TOKENS KV. Run `pnpm run setup:google-health` on a developer machine and populate the namespace.',
    );
  }
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) {
    throw new GoogleHealthAuthError(`${keys.expires} in KV is not numeric: ${expiresAtRaw}`);
  }
  return { accessToken, refreshToken, expiresAt };
}

/**
 * Store a user's Google token bundle. Used by the multi-user OAuth callback
 * after the authorization-code exchange, and internally after refreshes.
 */
export async function persistGoogleTokens(
  env: Env,
  userId: string | undefined,
  bundle: GoogleTokenBundle,
): Promise<void> {
  const keys = kvKeys(userId);
  await Promise.all([
    env.TOKENS.put(keys.access, bundle.accessToken),
    env.TOKENS.put(keys.refresh, bundle.refreshToken),
    env.TOKENS.put(keys.expires, String(bundle.expiresAt)),
  ]);
  memoryTokens.set(memoryKey(userId), {
    accessToken: bundle.accessToken,
    expiresAt: bundle.expiresAt,
  });
}

export async function refreshGoogleTokens(
  env: Env,
  refreshToken: string,
  userId?: string,
): Promise<GoogleTokenBundle> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new GoogleHealthAuthError(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set. Run `wrangler secret put ...`.',
    );
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new GoogleHealthAuthError(
      `Token refresh failed: HTTP ${res.status} ${res.statusText} — ${text}`,
    );
  }

  let parsed: TokenResponseT;
  try {
    parsed = TokenResponse.parse(JSON.parse(text));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GoogleHealthAuthError(
      `Token refresh returned unexpected payload (${reason}): ${text}`,
    );
  }

  const issuedAtSec = Math.floor(Date.now() / 1000);
  const bundle: GoogleTokenBundle = {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? refreshToken,
    expiresAt: issuedAtSec + parsed.expires_in,
  };
  await persistGoogleTokens(env, userId, bundle);
  return bundle;
}

/**
 * Returns a currently-valid Google access token for the given user (or the
 * single-user bundle when userId is omitted), refreshing it when within
 * REFRESH_SKEW_SEC of expiry. Repeat calls are served from per-isolate
 * memory; concurrent refreshes are coalesced per user (single-flight).
 */
export async function getGoogleAccessToken(env: Env, userId?: string): Promise<string> {
  const key = memoryKey(userId);
  const now = Math.floor(Date.now() / 1000);
  const cached = memoryTokens.get(key);
  if (cached && cached.expiresAt - REFRESH_SKEW_SEC > now) {
    return cached.accessToken;
  }

  let inFlight = refreshesInFlight.get(key);
  if (!inFlight) {
    inFlight = (async () => {
      const current = await readStoredTokens(env, userId);
      if (current.expiresAt - REFRESH_SKEW_SEC > now) {
        memoryTokens.set(key, {
          accessToken: current.accessToken,
          expiresAt: current.expiresAt,
        });
        return current;
      }
      return refreshGoogleTokens(env, current.refreshToken, userId);
    })().finally(() => {
      refreshesInFlight.delete(key);
    });
    refreshesInFlight.set(key, inFlight);
  }
  const bundle = await inFlight;
  return bundle.accessToken;
}

/** Force the next `getGoogleAccessToken()` to refresh. Used after an unexpected 401. */
export async function invalidateGoogleAccessToken(env: Env, userId?: string): Promise<void> {
  memoryTokens.delete(memoryKey(userId));
  await env.TOKENS.put(kvKeys(userId).expires, '0');
}
