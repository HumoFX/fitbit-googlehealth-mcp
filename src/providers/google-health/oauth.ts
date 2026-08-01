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

// Google tokens live in the same TOKENS KV namespace as Fitbit's, but under
// `gh_`-prefixed keys so both providers can coexist during the dual-run window.
const KV_ACCESS = 'gh_access_token';
const KV_REFRESH = 'gh_refresh_token';
const KV_EXPIRES = 'gh_expires_at';

export type GoogleTokenBundle = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix seconds
};

async function readStoredTokens(env: Env): Promise<GoogleTokenBundle> {
  const [accessToken, refreshToken, expiresAtRaw] = await Promise.all([
    env.TOKENS.get(KV_ACCESS),
    env.TOKENS.get(KV_REFRESH),
    env.TOKENS.get(KV_EXPIRES),
  ]);
  if (!accessToken || !refreshToken || !expiresAtRaw) {
    throw new GoogleHealthAuthError(
      'Google Health tokens not found in TOKENS KV. Run `pnpm run setup:google-health` on a developer machine and populate the namespace.',
    );
  }
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) {
    throw new GoogleHealthAuthError(`${KV_EXPIRES} in KV is not numeric: ${expiresAtRaw}`);
  }
  return { accessToken, refreshToken, expiresAt };
}

async function persistTokens(
  env: Env,
  tokens: TokenResponseT,
  refreshToken: string,
  issuedAtSec: number,
): Promise<void> {
  const expiresAt = issuedAtSec + tokens.expires_in;
  await Promise.all([
    env.TOKENS.put(KV_ACCESS, tokens.access_token),
    env.TOKENS.put(KV_REFRESH, refreshToken),
    env.TOKENS.put(KV_EXPIRES, String(expiresAt)),
  ]);
}

export async function refreshGoogleTokens(
  env: Env,
  refreshToken: string,
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

  const nextRefreshToken = parsed.refresh_token ?? refreshToken;
  const issuedAtSec = Math.floor(Date.now() / 1000);
  await persistTokens(env, parsed, nextRefreshToken, issuedAtSec);

  return {
    accessToken: parsed.access_token,
    refreshToken: nextRefreshToken,
    expiresAt: issuedAtSec + parsed.expires_in,
  };
}

/**
 * Returns a currently-valid Google access token, refreshing it when within
 * REFRESH_SKEW_SEC of expiry. Safe to call on every API request.
 *
 * Concurrency note: Google refresh tokens are not single-use, so two
 * simultaneous refreshes both succeed independently — no KV-CAS lock needed.
 */
export async function getGoogleAccessToken(env: Env): Promise<string> {
  const current = await readStoredTokens(env);
  const now = Math.floor(Date.now() / 1000);
  if (current.expiresAt - REFRESH_SKEW_SEC > now) {
    return current.accessToken;
  }
  const refreshed = await refreshGoogleTokens(env, current.refreshToken);
  return refreshed.accessToken;
}

/** Force the next `getGoogleAccessToken()` to refresh. Used after an unexpected 401. */
export async function invalidateGoogleAccessToken(env: Env): Promise<void> {
  await env.TOKENS.put(KV_EXPIRES, '0');
}
