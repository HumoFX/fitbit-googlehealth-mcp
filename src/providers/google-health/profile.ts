import { z } from 'zod';
import {
  GoogleHealthApiError,
  GoogleHealthAuthError,
  GoogleHealthRateLimitError,
} from '../../lib/errors';
import type { Device, Profile } from '../types';
import { type GoogleHealthClient, paginate } from './client';
import { GhDateSchema, ghDateToIso } from './wire';

const IdentitySchema = z.object({
  name: z.string().optional(),
  healthUserId: z.string().optional(),
  legacyUserId: z.string().optional(),
});

const ProfileSchema = z.object({
  name: z.string().optional(),
  age: z.number().optional(),
  membershipStartDate: GhDateSchema.optional(),
});

const SettingsSchema = z.object({
  timeZone: z.string().optional(),
  weightUnit: z.string().optional(),
  heightUnit: z.string().optional(),
  languageLocale: z.string().optional(),
});

/**
 * Optional sub-request: an empty or forbidden *resource* must not sink the
 * whole profile, but auth and rate-limit failures are real and must
 * propagate — swallowing them would report a blank profile as success and
 * then cache it for an hour.
 */
async function tryGet<T>(
  client: GoogleHealthClient,
  schema: z.ZodType<T>,
  path: string,
): Promise<T | undefined> {
  try {
    return await client.requestJson(schema, { path });
  } catch (err) {
    if (err instanceof GoogleHealthAuthError || err instanceof GoogleHealthRateLimitError) {
      throw err;
    }
    if (err instanceof GoogleHealthApiError && err.status >= 500) {
      throw err;
    }
    return undefined;
  }
}

/**
 * Fitbit served one profile document; Google splits it across three
 * resources — identity (ids), profile (age, membership), settings (units
 * and timezone). Fields with no Google counterpart (displayName,
 * dateOfBirth, height, weight, averageDailySteps) stay absent.
 */
export async function getProfile(client: GoogleHealthClient): Promise<Profile> {
  const [identity, profile, settings] = await Promise.all([
    tryGet(client, IdentitySchema, '/users/me/identity'),
    tryGet(client, ProfileSchema, '/users/me/profile'),
    tryGet(client, SettingsSchema, '/users/me/settings'),
  ]);

  return {
    user: {
      encodedId: identity?.healthUserId ?? identity?.legacyUserId ?? '',
      timezone: settings?.timeZone,
      weightUnit: settings?.weightUnit,
      heightUnit: settings?.heightUnit,
      locale: settings?.languageLocale,
      memberSince: profile?.membershipStartDate
        ? ghDateToIso(profile.membershipStartDate)
        : undefined,
    },
  };
}

const PairedDevicesResponseSchema = z.object({
  pairedDevices: z
    .array(
      z.object({
        name: z.string().optional(),
        deviceVersion: z.string().optional(),
        deviceType: z.string().optional(), // TRACKER | SCALE
        batteryLevel: z.number().optional(),
        batteryStatus: z.string().optional(), // High | Medium | Low | Empty
        lastSyncTime: z.string().optional(),
        macAddress: z.string().optional(),
        features: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

// The endpoint's default page is small; one page of 100 covers any
// plausible number of paired devices, and pagination is followed anyway.
const DEVICES_PAGE_SIZE = 100;

/** Paired devices, including battery state and last-sync time. */
export async function listDevices(client: GoogleHealthClient): Promise<Device[]> {
  const { items } = await paginate(async (pageToken) => {
    const response = await client.requestJson(PairedDevicesResponseSchema, {
      path: '/users/me/pairedDevices',
      query: { pageSize: DEVICES_PAGE_SIZE, pageToken },
    });
    return { items: response.pairedDevices ?? [], nextPageToken: response.nextPageToken };
  });

  return items.map((device) => ({
    id: device.name ?? '',
    deviceVersion: device.deviceVersion,
    type: device.deviceType,
    battery: device.batteryStatus,
    batteryLevel: device.batteryLevel,
    lastSyncTime: device.lastSyncTime,
    mac: device.macAddress,
    features: device.features,
  }));
}
