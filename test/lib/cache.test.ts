import { describe, expect, it, vi } from 'vitest';
import { cacheKey, getCached, invalidate } from '../../src/lib/cache';
import { createMockEnv, type MockKv } from '../helpers/mock-env';

describe('cacheKey', () => {
  it('returns the endpoint as-is when there are no args', () => {
    expect(cacheKey('/1/user/-/profile.json')).toBe('/1/user/-/profile.json');
  });

  it('serializes args in alphabetical order', () => {
    expect(cacheKey('/x', { b: '2', a: '1' })).toBe('/x?a=1&b=2');
  });

  it('filters out undefined and null values', () => {
    expect(cacheKey('/x', { a: '1', b: undefined, c: null })).toBe('/x?a=1');
  });

  it('stringifies non-string values', () => {
    expect(cacheKey('/x', { limit: 10, days: 7 })).toBe('/x?days=7&limit=10');
  });
});

describe('provider-namespaced cache storage', () => {
  it('prefixes KV keys with the active provider (fitbit by default)', async () => {
    const env = createMockEnv();
    await getCached(env, 'get_sleep?date=2026-07-31', async () => ({ ok: 1 }));
    const store = (env.CACHE as unknown as MockKv).__store;
    expect([...store.keys()]).toEqual(['fitbit:get_sleep?date=2026-07-31']);
  });

  it('separates entries between providers for the same logical key', async () => {
    const fitbitEnv = createMockEnv();
    const googleEnv = createMockEnv({}, { HEALTH_PROVIDER: 'google_health' });
    // Share one KV namespace between both envs
    (googleEnv as { CACHE: unknown }).CACHE = fitbitEnv.CACHE;

    await getCached(fitbitEnv, 'get_sleep?date=2026-07-31', async () => 'from-fitbit');
    const fromGoogle = await getCached(
      googleEnv,
      'get_sleep?date=2026-07-31',
      async () => 'from-google',
    );

    expect(fromGoogle).toBe('from-google');
    const store = (fitbitEnv.CACHE as unknown as MockKv).__store;
    expect([...store.keys()].sort()).toEqual([
      'fitbit:get_sleep?date=2026-07-31',
      'google_health:get_sleep?date=2026-07-31',
    ]);
  });

  it('invalidate deletes the namespaced key', async () => {
    const env = createMockEnv({}, { HEALTH_PROVIDER: 'google_health' });
    await getCached(env, 'get_sleep?date=2026-07-31', async () => 'x');
    await invalidate(env, 'get_sleep?date=2026-07-31');
    const store = (env.CACHE as unknown as MockKv).__store;
    expect(store.size).toBe(0);
  });

  it('serves cache hits without re-running the fetcher', async () => {
    const env = createMockEnv();
    const fetcher = vi.fn(async () => 'fresh');
    await getCached(env, 'k', fetcher);
    const second = await getCached(env, 'k', fetcher);
    expect(second).toBe('fresh');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stores entries with the default 1h TTL', async () => {
    const env = createMockEnv();
    await getCached(env, 'k', async () => 1);
    const putCall = (env.CACHE as unknown as MockKv).put.mock.calls[0];
    expect(putCall?.[2]).toEqual({ expirationTtl: 3600 });
  });

  it('honours a custom ttlSec', async () => {
    const env = createMockEnv();
    await getCached(env, 'k', async () => 1, { ttlSec: 60 });
    const putCall = (env.CACHE as unknown as MockKv).put.mock.calls[0];
    expect(putCall?.[2]).toEqual({ expirationTtl: 60 });
  });
});
