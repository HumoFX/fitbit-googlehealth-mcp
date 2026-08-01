import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleHealthAuthError } from '../../../src/lib/errors';
import {
  getGoogleAccessToken,
  invalidateGoogleAccessToken,
  refreshGoogleTokens,
  resetGoogleTokenMemory,
} from '../../../src/providers/google-health/oauth';
import { createMockEnv, type MockKv } from '../../helpers/mock-env';

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('getGoogleAccessToken', () => {
  beforeEach(() => {
    resetGoogleTokenMemory();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns current gh_access_token when not near expiry', async () => {
    const env = createMockEnv({
      gh_access_token: 'current-google-token',
      gh_refresh_token: 'refresh-google',
      gh_expires_at: String(Math.floor(Date.now() / 1000) + 600),
    });
    const token = await getGoogleAccessToken(env);
    expect(token).toBe('current-google-token');
  });

  it('refreshes when the token is within the 60-second skew window', async () => {
    const fetchMock = vi.fn(async () =>
      tokenResponse({
        access_token: 'new-google-token',
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
        token_type: 'Bearer',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv({
      gh_access_token: 'stale',
      gh_refresh_token: 'refresh-google',
      // 30s from now → inside the 60s skew, must refresh
      gh_expires_at: String(Math.floor(Date.now() / 1000) + 30),
    });

    const token = await getGoogleAccessToken(env);
    expect(token).toBe('new-google-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await env.TOKENS.get('gh_access_token')).toBe('new-google-token');
  });

  it('throws GoogleHealthAuthError when tokens are missing', async () => {
    const env = createMockEnv();
    await expect(getGoogleAccessToken(env)).rejects.toBeInstanceOf(GoogleHealthAuthError);
  });

  it('throws GoogleHealthAuthError when gh_expires_at is not numeric', async () => {
    const env = createMockEnv({
      gh_access_token: 'a',
      gh_refresh_token: 'r',
      gh_expires_at: 'garbage',
    });
    await expect(getGoogleAccessToken(env)).rejects.toBeInstanceOf(GoogleHealthAuthError);
  });
});

describe('refreshGoogleTokens', () => {
  beforeEach(() => {
    resetGoogleTokenMemory();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('persists the new access token with gh_expires_at = now + expires_in', async () => {
    const fetchMock = vi.fn(async () =>
      tokenResponse({ access_token: 'a2', expires_in: 3599, token_type: 'Bearer' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv({ gh_refresh_token: 'old-refresh' });
    const result = await refreshGoogleTokens(env, 'old-refresh');

    expect(result.accessToken).toBe('a2');
    const nowSec = Math.floor(Date.now() / 1000);
    expect(result.expiresAt).toBe(nowSec + 3599);
    expect(await env.TOKENS.get('gh_access_token')).toBe('a2');
    expect(await env.TOKENS.get('gh_expires_at')).toBe(String(nowSec + 3599));
  });

  it('keeps the stored refresh token when the response omits refresh_token', async () => {
    // Google does not rotate refresh tokens on refresh (unlike Fitbit).
    const fetchMock = vi.fn(async () =>
      tokenResponse({ access_token: 'a2', expires_in: 3599, token_type: 'Bearer' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv({ gh_refresh_token: 'keep-me' });
    const result = await refreshGoogleTokens(env, 'keep-me');

    expect(result.refreshToken).toBe('keep-me');
    expect(await env.TOKENS.get('gh_refresh_token')).toBe('keep-me');
  });

  it('persists a rotated refresh token when the response includes one', async () => {
    const fetchMock = vi.fn(async () =>
      tokenResponse({
        access_token: 'a2',
        refresh_token: 'rotated',
        expires_in: 3599,
        token_type: 'Bearer',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv({ gh_refresh_token: 'old' });
    const result = await refreshGoogleTokens(env, 'old');

    expect(result.refreshToken).toBe('rotated');
    expect(await env.TOKENS.get('gh_refresh_token')).toBe('rotated');
  });

  it('sends a form-encoded body with client credentials (no Basic auth header)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init: RequestInit) =>
      tokenResponse({ access_token: 'a2', expires_in: 100, token_type: 'Bearer' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv({ gh_refresh_token: 'rt' });
    await refreshGoogleTokens(env, 'rt');

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const [url, init] = call;
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt');
    expect(body.get('client_id')).toBe('test-google-client-id');
    expect(body.get('client_secret')).toBe('test-google-client-secret');
  });

  it('throws GoogleHealthAuthError with the response body on HTTP 4xx', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{"error": "invalid_grant"}', { status: 400 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv({ gh_refresh_token: 'rt' });
    await expect(refreshGoogleTokens(env, 'rt')).rejects.toThrow(/invalid_grant/);
  });

  it('throws GoogleHealthAuthError when client id / secret are absent', async () => {
    const env = createMockEnv(
      { gh_refresh_token: 'rt' },
      { GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' },
    );
    await expect(refreshGoogleTokens(env, 'rt')).rejects.toBeInstanceOf(GoogleHealthAuthError);
  });
});

describe('invalidateGoogleAccessToken', () => {
  it('writes gh_expires_at=0 so the next getGoogleAccessToken refreshes', async () => {
    const env = createMockEnv({
      gh_access_token: 'a',
      gh_refresh_token: 'r',
      gh_expires_at: '9999999999',
    });
    await invalidateGoogleAccessToken(env);
    expect(await env.TOKENS.get('gh_expires_at')).toBe('0');
  });
});

describe('token memory and single-flight refresh', () => {
  beforeEach(() => {
    resetGoogleTokenMemory();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('coalesces concurrent refreshes into a single token request', async () => {
    // A composite tool call fires ~10 parallel API requests; if the token is
    // expired they must not each hit the token endpoint and hammer the same
    // KV keys (Cloudflare KV allows ~1 write/sec/key).
    let releaseFetch: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return tokenResponse({ access_token: 'herd-token', expires_in: 3599, token_type: 'Bearer' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv({
      gh_access_token: 'expired',
      gh_refresh_token: 'refresh-x',
      gh_expires_at: String(Math.floor(Date.now() / 1000) - 10),
    });

    const pending = Promise.all(Array.from({ length: 5 }, () => getGoogleAccessToken(env)));
    releaseFetch();
    const tokens = await pending;

    expect(tokens).toEqual(Array.from({ length: 5 }, () => 'herd-token'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const puts = (env.TOKENS as unknown as MockKv).put.mock.calls;
    expect(puts.filter(([key]) => key === 'gh_access_token')).toHaveLength(1);
  });

  it('serves repeat calls from memory without re-reading KV', async () => {
    const env = createMockEnv({
      gh_access_token: 'memo-token',
      gh_refresh_token: 'r',
      gh_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    });

    await getGoogleAccessToken(env);
    const kvGets = (env.TOKENS as unknown as MockKv).get.mock.calls.length;
    const again = await getGoogleAccessToken(env);

    expect(again).toBe('memo-token');
    expect((env.TOKENS as unknown as MockKv).get.mock.calls.length).toBe(kvGets);
  });

  it('invalidateGoogleAccessToken drops the memory cache too', async () => {
    const fetchMock = vi.fn(async () =>
      tokenResponse({ access_token: 'after-401', expires_in: 3599, token_type: 'Bearer' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env = createMockEnv({
      gh_access_token: 'rejected-by-api',
      gh_refresh_token: 'r',
      gh_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    });

    await getGoogleAccessToken(env);
    await invalidateGoogleAccessToken(env);
    const token = await getGoogleAccessToken(env);

    expect(token).toBe('after-401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
