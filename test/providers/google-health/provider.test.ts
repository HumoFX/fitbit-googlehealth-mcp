import { afterEach, describe, expect, it, vi } from 'vitest';
import { FitbitProvider } from '../../../src/providers/fitbit';
import { GoogleHealthProvider } from '../../../src/providers/google-health';
import { selectProvider } from '../../../src/server';
import { createMockEnv } from '../../helpers/mock-env';

function envWithFreshToken(overrides: Record<string, string> = {}) {
  return createMockEnv(
    {
      gh_access_token: 'valid-token',
      gh_refresh_token: 'refresh-token',
      gh_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
    },
    overrides as never,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GoogleHealthProvider', () => {
  it('serves the MVP read methods (spot check: getSleep)', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL) =>
        new Response(JSON.stringify({ dataPoints: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new GoogleHealthProvider(envWithFreshToken());
    await expect(provider.getSleep('2026-07-31')).resolves.toEqual([]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/dataTypes/sleep/');
  });

  it('implements every HealthProvider method', () => {
    // The Fitbit provider is the reference surface; any method it has that
    // Google Health lacks would silently fall off the tool list.
    const provider = new GoogleHealthProvider(envWithFreshToken());
    const reference = new FitbitProvider(createMockEnv());
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(reference)).filter(
      (name) => name !== 'constructor',
    );

    expect(methods.length).toBeGreaterThan(20);
    for (const method of methods) {
      expect(typeof (provider as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });
});

describe('selectProvider', () => {
  it('defaults to FitbitProvider when HEALTH_PROVIDER is unset', () => {
    expect(selectProvider(createMockEnv())).toBeInstanceOf(FitbitProvider);
  });

  it('selects FitbitProvider explicitly', () => {
    expect(selectProvider(createMockEnv({}, { HEALTH_PROVIDER: 'fitbit' }))).toBeInstanceOf(
      FitbitProvider,
    );
  });

  it('selects GoogleHealthProvider for google_health', () => {
    expect(selectProvider(createMockEnv({}, { HEALTH_PROVIDER: 'google_health' }))).toBeInstanceOf(
      GoogleHealthProvider,
    );
  });

  it('throws on unknown provider values', () => {
    expect(() => selectProvider(createMockEnv({}, { HEALTH_PROVIDER: 'garmin' as never }))).toThrow(
      /HEALTH_PROVIDER/,
    );
  });

  it('forces GoogleHealthProvider when a userId is given (multi-user requests)', () => {
    // Multi-user grants only exist for Google Health; HEALTH_PROVIDER is
    // irrelevant for per-user requests even if it still says fitbit.
    expect(
      selectProvider(createMockEnv({}, { HEALTH_PROVIDER: 'fitbit' }), '10001'),
    ).toBeInstanceOf(GoogleHealthProvider);
  });
});
