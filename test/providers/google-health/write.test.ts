import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleHealthApiError } from '../../../src/lib/errors';
import { GoogleHealthClient } from '../../../src/providers/google-health/client';
import { resetGoogleTokenMemory } from '../../../src/providers/google-health/oauth';
import {
  batchDeleteDataPoints,
  createDataPoint,
  dataPointIdFromName,
  toMealTypeEnum,
  toSampleTime,
  toSessionInterval,
} from '../../../src/providers/google-health/write';
import { createMockEnv } from '../../helpers/mock-env';

function envWithFreshToken() {
  return createMockEnv({
    gh_access_token: 'valid-token',
    gh_refresh_token: 'refresh-token',
    gh_expires_at: String(Math.floor(Date.now() / 1000) + 3600),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetGoogleTokenMemory();
});

describe('toSessionInterval / toSampleTime', () => {
  it('builds a session interval from a JST date, time and duration', () => {
    const interval = toSessionInterval({
      date: '2026-08-01',
      time: '13:30',
      durationMs: 30 * 60_000,
    });
    // JST is UTC+9, so 13:30 local is 04:30Z
    expect(interval.startTime).toBe('2026-08-01T04:30:00.000Z');
    expect(interval.endTime).toBe('2026-08-01T05:00:00.000Z');
    expect(interval.startUtcOffset).toBe('32400s');
    expect(interval.endUtcOffset).toBe('32400s');
  });

  it('defaults to noon local time when no time is given', () => {
    const interval = toSessionInterval({ date: '2026-08-01' });
    expect(interval.startTime).toBe('2026-08-01T03:00:00.000Z');
    // a point-in-time log is a zero-length window
    expect(interval.endTime).toBe(interval.startTime);
  });

  it('builds a sample time with the JST offset', () => {
    expect(toSampleTime({ date: '2026-08-01', time: '07:15' })).toEqual({
      physicalTime: '2026-07-31T22:15:00.000Z',
      utcOffset: '32400s',
    });
  });
});

describe('toMealTypeEnum', () => {
  it('maps Fitbit meal types onto the Google enum', () => {
    expect(toMealTypeEnum('Breakfast')).toBe('BREAKFAST');
    expect(toMealTypeEnum('Lunch')).toBe('LUNCH');
    expect(toMealTypeEnum('Dinner')).toBe('DINNER');
    expect(toMealTypeEnum('Anytime')).toBe('ANYTIME');
    // Google documents BEFORE_LUNCH as "a morning snack" and BEFORE_DINNER
    // as "an afternoon snack" — an exact match for Fitbit's two snack slots.
    expect(toMealTypeEnum('MorningSnack')).toBe('BEFORE_LUNCH');
    expect(toMealTypeEnum('AfternoonSnack')).toBe('BEFORE_DINNER');
  });
});

describe('dataPointIdFromName', () => {
  it('returns the full resource name, which is what batchDelete expects', () => {
    expect(dataPointIdFromName('users/me/dataTypes/nutrition-log/dataPoints/abc-123')).toBe(
      'users/me/dataTypes/nutrition-log/dataPoints/abc-123',
    );
  });
});

describe('createDataPoint', () => {
  it('POSTs the data point and returns the created resource name', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            name: 'operations/op-1',
            done: true,
            response: {
              '@type': 'type.googleapis.com/google.devicesandservices.health.v4.DataPoint',
              name: 'users/me/dataTypes/weight/dataPoints/w-1',
              weight: { weightGrams: 70000 },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const name = await createDataPoint(client, 'weight', {
      weight: { weightGrams: 70000, sampleTime: { physicalTime: 'x', utcOffset: '0s' } },
    });

    expect(name).toBe('users/me/dataTypes/weight/dataPoints/w-1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL | string, RequestInit];
    expect(new URL(String(url)).pathname).toBe('/v4/users/me/dataTypes/weight/dataPoints');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      weight: { weightGrams: 70000, sampleTime: { physicalTime: 'x', utcOffset: '0s' } },
    });
  });

  it('surfaces an operation that completed with an error', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            name: 'operations/op-2',
            done: true,
            error: { code: 3, message: 'nutrition log interval is invalid' },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    const err = await createDataPoint(client, 'nutrition-log', {}).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GoogleHealthApiError);
    expect((err as Error).message).toMatch(/nutrition log interval is invalid/);
  });

  it('reports a still-running operation rather than inventing an id', async () => {
    // Writes are expected to complete inline; if one ever comes back async we
    // must not pretend we know the resource name.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ name: 'operations/op-3', done: false }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    await expect(createDataPoint(client, 'weight', {})).rejects.toThrow(
      /still (in progress|running)/i,
    );
  });
});

describe('batchDeleteDataPoints', () => {
  it('POSTs the resource names to :batchDelete', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ name: 'operations/d-1', done: true, response: {} }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new GoogleHealthClient(envWithFreshToken());
    await batchDeleteDataPoints(client, 'nutrition-log', [
      'users/me/dataTypes/nutrition-log/dataPoints/n-1',
    ]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL | string, RequestInit];
    expect(new URL(String(url)).pathname).toBe(
      '/v4/users/me/dataTypes/nutrition-log/dataPoints:batchDelete',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      names: ['users/me/dataTypes/nutrition-log/dataPoints/n-1'],
    });
  });

  it('rejects a numeric Fitbit-style id with an actionable message', async () => {
    const client = new GoogleHealthClient(envWithFreshToken());
    await expect(batchDeleteDataPoints(client, 'weight', [42 as never])).rejects.toThrow(
      /resource name/i,
    );
  });
});
