import { z } from 'zod';
import type { Env } from '../env';
import { GoogleHealthAuthError } from '../lib/errors';
import type { GoogleTokenBundle } from '../providers/google-health/oauth';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Scopes requested when a user connects the MCP server. `openid` is what
 * makes Google return an id_token, whose `sub` claim is our stable per-user
 * key; the rest are the read scopes the MVP tools need.
 */
export const GOOGLE_LOGIN_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
];

export function buildGoogleAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', GOOGLE_LOGIN_SCOPES.join(' '));
  url.searchParams.set('state', opts.state);
  // offline + consent are what make Google mint a refresh token, without
  // which the unattended Worker refresh dies after an hour.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

/**
 * Read `sub` (and `email`) out of an id_token.
 *
 * No signature verification: the token came to us directly over TLS from
 * Google's token endpoint in response to our own client-authenticated
 * request, which per OpenID Connect Core §3.1.3.7 is the case where
 * validation may be skipped.
 */
export function decodeIdTokenSub(idToken: string): { sub: string; email?: string } {
  const parts = idToken.split('.');
  const payloadPart = parts[1];
  if (parts.length !== 3 || !payloadPart) {
    throw new GoogleHealthAuthError(`Malformed id_token: expected three JWT segments`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(atob(payloadPart.replace(/-/g, '+').replace(/_/g, '/')));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new GoogleHealthAuthError(`Could not decode id_token payload: ${reason}`);
  }
  const parsed = z.object({ sub: z.string(), email: z.string().optional() }).safeParse(payload);
  if (!parsed.success) {
    throw new GoogleHealthAuthError('id_token payload has no `sub` claim');
  }
  return { sub: parsed.data.sub, email: parsed.data.email };
}

const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  token_type: z.string(),
  id_token: z.string(),
  scope: z.string().optional(),
});

export type GoogleLoginResult = {
  userId: string;
  email?: string;
  tokens: GoogleTokenBundle;
};

/** Exchange an authorization code for tokens and the caller's identity. */
export async function exchangeGoogleCode(
  env: Env,
  opts: { code: string; redirectUri: string },
): Promise<GoogleLoginResult> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new GoogleHealthAuthError(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set. Run `wrangler secret put ...`.',
    );
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
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
      `Google token exchange failed: HTTP ${res.status} ${res.statusText} — ${text}`,
    );
  }

  const parsed = TokenResponse.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new GoogleHealthAuthError(
      `Google token exchange returned an unexpected payload: ${parsed.error.message}`,
    );
  }
  if (!parsed.data.refresh_token) {
    throw new GoogleHealthAuthError(
      'Google returned no refresh token — the grant would expire within the hour. ' +
        'This happens when the user previously authorized this client; revoke access at ' +
        'https://myaccount.google.com/permissions and reconnect.',
    );
  }

  const identity = decodeIdTokenSub(parsed.data.id_token);
  return {
    userId: identity.sub,
    email: identity.email,
    tokens: {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + parsed.data.expires_in,
    },
  };
}
