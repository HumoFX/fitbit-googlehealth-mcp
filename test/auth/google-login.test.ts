import { describe, expect, it, vi } from 'vitest';
import {
  buildGoogleAuthUrl,
  decodeIdTokenSub,
  exchangeGoogleCode,
  GOOGLE_LOGIN_SCOPES,
} from '../../src/auth/google-login';
import { createMockEnv } from '../helpers/mock-env';

/** Minimal unsigned JWT with the given payload (structure is all we parse). */
function fakeIdToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.signature`;
}

describe('GOOGLE_LOGIN_SCOPES', () => {
  it('requests openid (for the sub claim) alongside the health read scopes', () => {
    expect(GOOGLE_LOGIN_SCOPES).toContain('openid');
    expect(GOOGLE_LOGIN_SCOPES).toContain(
      'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
    );
    expect(GOOGLE_LOGIN_SCOPES).toContain(
      'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
    );
    expect(GOOGLE_LOGIN_SCOPES).toContain(
      'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
    );
  });
});

describe('buildGoogleAuthUrl', () => {
  it('builds an offline-access consent URL carrying our state', () => {
    const url = new URL(
      buildGoogleAuthUrl({
        clientId: 'client-123',
        redirectUri: 'https://worker.example/oauth/google/callback',
        state: 'opaque-state',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://worker.example/oauth/google/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('opaque-state');
    // offline + consent are what make Google issue a refresh token for the
    // unattended Worker refresh
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_LOGIN_SCOPES.join(' '));
  });
});

describe('decodeIdTokenSub', () => {
  it('extracts the sub claim used as our stable user id', () => {
    expect(decodeIdTokenSub(fakeIdToken({ sub: '112233445566', email: 'a@b.c' }))).toEqual({
      sub: '112233445566',
      email: 'a@b.c',
    });
  });

  it('tolerates a missing email', () => {
    expect(decodeIdTokenSub(fakeIdToken({ sub: '42' }))).toEqual({ sub: '42', email: undefined });
  });

  it('throws when the token is malformed or has no sub', () => {
    expect(() => decodeIdTokenSub('not-a-jwt')).toThrow(/id_token/i);
    expect(() => decodeIdTokenSub(fakeIdToken({ email: 'a@b.c' }))).toThrow(/sub/i);
  });
});

describe('exchangeGoogleCode', () => {
  it('posts the code with client credentials and returns tokens plus identity', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 3599,
            token_type: 'Bearer',
            id_token: fakeIdToken({ sub: '900', email: 'user@example.com' }),
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv();
    const result = await exchangeGoogleCode(env, {
      code: 'auth-code',
      redirectUri: 'https://worker.example/oauth/google/callback',
    });

    expect(result.userId).toBe('900');
    expect(result.email).toBe('user@example.com');
    expect(result.tokens.accessToken).toBe('at');
    expect(result.tokens.refreshToken).toBe('rt');
    expect(result.tokens.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string | URL, RequestInit];
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('client_id')).toBe('test-google-client-id');
    expect(body.get('client_secret')).toBe('test-google-client-secret');
  });

  it('fails loudly when Google returns no refresh token', async () => {
    // Without a refresh token the grant dies in an hour — surface it at
    // connect time rather than silently later.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'at',
            expires_in: 3599,
            token_type: 'Bearer',
            id_token: fakeIdToken({ sub: '900' }),
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv();
    await expect(
      exchangeGoogleCode(env, { code: 'c', redirectUri: 'https://x/cb' }),
    ).rejects.toThrow(/refresh token/i);
  });

  it('surfaces Google token-endpoint errors', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv();
    await expect(
      exchangeGoogleCode(env, { code: 'c', redirectUri: 'https://x/cb' }),
    ).rejects.toThrow(/invalid_grant/);
  });
});
