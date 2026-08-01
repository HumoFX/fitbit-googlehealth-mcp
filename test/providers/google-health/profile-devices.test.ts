import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleHealthProvider } from '../../../src/providers/google-health';
import { resetGoogleTokenMemory } from '../../../src/providers/google-health/oauth';
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

describe('getProfile', () => {
  it('merges identity, profile and settings into the domain shape', async () => {
    // Google splits what Fitbit returned from one endpoint across three.
    const fetchMock = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      const body = path.endsWith('/identity')
        ? { healthUserId: 'hu-1', legacyUserId: 'FITBIT42' }
        : path.endsWith('/settings')
          ? { timeZone: 'Asia/Tokyo', weightUnit: 'KILOGRAM', heightUnit: 'CENTIMETER' }
          : { age: 34, membershipStartDate: { year: 2019, month: 5, day: 20 } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const profile = await new GoogleHealthProvider(envWithFreshToken()).getProfile();

    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).pathname).sort()).toEqual([
      '/v4/users/me/identity',
      '/v4/users/me/profile',
      '/v4/users/me/settings',
    ]);
    expect(profile.user.encodedId).toBe('hu-1');
    expect(profile.user.timezone).toBe('Asia/Tokyo');
    expect(profile.user.weightUnit).toBe('KILOGRAM');
    expect(profile.user.heightUnit).toBe('CENTIMETER');
    expect(profile.user.memberSince).toBe('2019-05-20');
    // Fitbit's displayName / dateOfBirth / height / weight have no Google
    // counterpart, so they stay absent rather than being invented.
    expect(profile.user.displayName).toBeUndefined();
    expect(profile.user.dateOfBirth).toBeUndefined();
  });

  it('still returns a profile when settings are unavailable', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/settings')) return new Response('forbidden', { status: 403 });
      const body = path.endsWith('/identity') ? { healthUserId: 'hu-2' } : { age: 20 };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const profile = await new GoogleHealthProvider(envWithFreshToken()).getProfile();
    expect(profile.user.encodedId).toBe('hu-2');
    expect(profile.user.timezone).toBeUndefined();
  });
});

describe('listDevices', () => {
  it('maps every PairedDevice field, battery and sync time included', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL) =>
        new Response(
          JSON.stringify({
            pairedDevices: [
              {
                name: 'users/me/pairedDevices/dev-1',
                deviceVersion: 'Charge 6',
                deviceType: 'TRACKER',
                batteryLevel: 72,
                batteryStatus: 'High',
                lastSyncTime: '2026-08-01T09:12:00Z',
                macAddress: 'AA:BB:CC:DD:EE:FF',
                features: ['STEPS', 'HEART_RATE'],
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const devices = await new GoogleHealthProvider(envWithFreshToken()).listDevices();

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/v4/users/me/pairedDevices');
    // The API defaults to a small page; ask for all of them.
    expect(url.searchParams.get('pageSize')).toBe('100');
    expect(devices).toEqual([
      {
        id: 'users/me/pairedDevices/dev-1',
        deviceVersion: 'Charge 6',
        type: 'TRACKER',
        battery: 'High',
        batteryLevel: 72,
        lastSyncTime: '2026-08-01T09:12:00Z',
        mac: 'AA:BB:CC:DD:EE:FF',
        features: ['STEPS', 'HEART_RATE'],
      },
    ]);
  });

  it('follows pagination so devices beyond the first page are not dropped', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const token = new URL(String(input)).searchParams.get('pageToken');
      const body = token
        ? { pairedDevices: [{ name: 'd2', deviceVersion: 'Scale' }] }
        : { pairedDevices: [{ name: 'd1', deviceVersion: 'Charge 6' }], nextPageToken: 'p2' };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const devices = await new GoogleHealthProvider(envWithFreshToken()).listDevices();
    expect(devices.map((d) => d.id)).toEqual(['d1', 'd2']);
  });
});
