import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GoogleHealthApiError, GoogleHealthRateLimitError } from '../../../src/lib/errors';
import { GoogleHealthClient, paginate } from '../../../src/providers/google-health/client';
import { createMockEnv } from '../../helpers/mock-env';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Env with a token that stays valid for the whole test. */
function envWithFreshToken() {
  return createMockEnv({
    gh_access_token: 'valid-token',
    gh_refresh_token: 'refresh-token',
    gh_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GoogleHealthClient.requestJson', () => {
  it('sends Bearer auth and query params to the v4 base URL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const result = await client.requestJson(z.object({ ok: z.boolean() }), {
      path: '/users/me/dataTypes/sleep/dataPoints:reconcile',
      query: { pageSize: 25, filter: 'sleep.interval.civil_end_time >= "2026-08-01"' },
    });

    expect(result).toEqual({ ok: true });
    const call = fetchMock.mock.calls[0] as unknown as [URL | string, RequestInit];
    const url = new URL(String(call[0]));
    expect(url.origin).toBe('https://health.googleapis.com');
    expect(url.pathname).toBe('/v4/users/me/dataTypes/sleep/dataPoints:reconcile');
    expect(url.searchParams.get('pageSize')).toBe('25');
    expect(url.searchParams.get('filter')).toBe('sleep.interval.civil_end_time >= "2026-08-01"');
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer valid-token');
    expect(headers.Accept).toBe('application/json');
  });

  it('POSTs a JSON body with content-type application/json', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ rollupDataPoints: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    await client.requestJson(z.object({ rollupDataPoints: z.array(z.unknown()) }), {
      path: '/users/me/dataTypes/steps/dataPoints:dailyRollUp',
      method: 'POST',
      json: { range: {}, windowSizeDays: 1 },
    });

    const call = fetchMock.mock.calls[0] as unknown as [URL | string, RequestInit];
    expect(call[1].method).toBe('POST');
    const headers = call[1].headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(call[1].body))).toEqual({ range: {}, windowSizeDays: 1 });
  });

  it('refreshes the token and retries once on 401', async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === GOOGLE_TOKEN_URL) {
        return jsonResponse({
          access_token: 'refreshed-token',
          expires_in: 3599,
          token_type: 'Bearer',
        });
      }
      apiCalls++;
      if (apiCalls === 1) return new Response('unauthorized', { status: 401 });
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const result = await client.requestJson(z.object({ ok: z.boolean() }), {
      path: '/users/me/dataTypes/steps/dataPoints',
    });

    expect(result).toEqual({ ok: true });
    expect(apiCalls).toBe(2);
    const lastApiCall = fetchMock.mock.calls.at(-1) as unknown as [URL | string, RequestInit];
    const headers = lastApiCall[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer refreshed-token');
  });

  it('sleeps and retries on 429, then throws GoogleHealthRateLimitError when it persists', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        async () => new Response('quota', { status: 429, headers: { 'Retry-After': '1' } }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const client = new GoogleHealthClient(envWithFreshToken());
      const promise = client
        .requestJson(z.object({}), { path: '/users/me/dataTypes/steps/dataPoints' })
        .then(
          () => {
            throw new Error('expected rejection');
          },
          (err: unknown) => err,
        );
      await vi.advanceTimersByTimeAsync(60_000);
      const err = await promise;
      expect(err).toBeInstanceOf(GoogleHealthRateLimitError);
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws GoogleHealthApiError with status and body on other HTTP errors', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"error":{"code":403,"message":"insufficient scopes"}}', { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const err = await client
      .requestJson(z.object({}), { path: '/users/me/dataTypes/sleep/dataPoints' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(GoogleHealthApiError);
    expect((err as GoogleHealthApiError).status).toBe(403);
    expect((err as GoogleHealthApiError).message).toMatch(/insufficient scopes/);
  });

  it('throws GoogleHealthApiError with a raw-body preview when schema validation fails', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ unexpected: 'shape' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const err = await client
      .requestJson(z.object({ dataPoints: z.array(z.unknown()) }), {
        path: '/users/me/dataTypes/sleep/dataPoints',
      })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(GoogleHealthApiError);
    expect((err as GoogleHealthApiError).message).toMatch(/Schema validation failed/);
    // The full raw-body preview lives in bodyText (message is truncated to 240 chars).
    expect((err as GoogleHealthApiError).bodyText).toMatch(/unexpected/);
  });
});

describe('paginate', () => {
  it('follows nextPageToken until exhausted and concatenates items', async () => {
    const pages: Record<string, { items: number[]; nextPageToken?: string }> = {
      first: { items: [1, 2], nextPageToken: 'p2' },
      p2: { items: [3], nextPageToken: 'p3' },
      p3: { items: [4] },
    };
    const fetchPage = vi.fn(async (token?: string) => {
      const page = pages[token ?? 'first'];
      if (!page) throw new Error(`unknown page token: ${token}`);
      return page;
    });

    const all = await paginate(fetchPage);
    expect(all).toEqual([1, 2, 3, 4]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('stops after maxPages to avoid unbounded loops', async () => {
    const fetchPage = vi.fn(async () => ({ items: [1], nextPageToken: 'again' }));
    const all = await paginate(fetchPage, { maxPages: 3 });
    expect(all).toEqual([1, 1, 1]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });
});
