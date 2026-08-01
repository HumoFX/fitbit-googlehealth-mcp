import { z } from 'zod';
import type { Device, Profile } from '../types';
import type { GoogleHealthClient } from './client';
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

/** Optional sub-request: a missing scope or empty resource must not sink the call. */
async function tryGet<T>(
  client: GoogleHealthClient,
  schema: z.ZodType<T>,
  path: string,
): Promise<T | undefined> {
  try {
    return await client.requestJson(schema, { path });
  } catch {
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
        displayName: z.string().optional(),
        formFactor: z.string().optional(),
        manufacturer: z.string().optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
});

/**
 * Paired devices carry only a name, form factor and manufacturer — Google
 * publishes no battery level or last-sync time, which is most of what
 * Fitbit's device list was consulted for.
 */
export async function listDevices(client: GoogleHealthClient): Promise<Device[]> {
  const response = await client.requestJson(PairedDevicesResponseSchema, {
    path: '/users/me/pairedDevices',
  });
  return (response.pairedDevices ?? []).map((device) => ({
    id: device.name ?? '',
    deviceVersion: device.displayName,
    type: device.formFactor,
    battery: undefined,
    batteryLevel: undefined,
    lastSyncTime: undefined,
  }));
}
