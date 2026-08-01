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

/** Capture every write and answer with a completed operation. */
function stubWrites() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let seq = 0;
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
    seq++;
    const type = path.split('/dataTypes/')[1]?.split('/')[0] ?? 'unknown';
    return new Response(
      JSON.stringify({
        name: `operations/op-${seq}`,
        done: true,
        response: { name: `users/me/dataTypes/${type}/dataPoints/dp-${seq}` },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetGoogleTokenMemory();
});

describe('logFood', () => {
  it('writes an anonymous nutrition log with macros as typed quantities', async () => {
    const calls = stubWrites();
    const provider = new GoogleHealthProvider(envWithFreshToken());

    const entry = await provider.logFood({
      date: '2026-08-01',
      mealType: 'Lunch',
      foodName: '親子丼',
      calories: 680,
      nutritionalValues: { protein: 32, carbs: 95, fat: 18, fiber: 3, sodium: 1200, sugar: 6 },
    });

    expect(calls[0]?.path).toBe('/v4/users/me/dataTypes/nutrition-log/dataPoints');
    const log = calls[0]?.body.nutritionLog as Record<string, unknown>;
    expect(log.foodDisplayName).toBe('親子丼');
    expect(log.mealType).toBe('LUNCH');
    expect(log.energy).toEqual({ kcal: 680, userProvidedUnit: 'KILOCALORIE' });
    // Google models carbs and fat as top-level weight quantities…
    expect(log.totalCarbohydrate).toEqual({ grams: 95, userProvidedUnit: 'GRAM' });
    expect(log.totalFat).toEqual({ grams: 18, userProvidedUnit: 'GRAM' });
    // …and everything else as typed nutrient entries — no guessing at key
    // names the way the Fitbit API required.
    const nutrients = log.nutrients as Array<{ nutrient: string; quantity: unknown }>;
    expect(nutrients).toEqual(
      expect.arrayContaining([
        { nutrient: 'PROTEIN', quantity: { grams: 32, userProvidedUnit: 'GRAM' } },
        { nutrient: 'DIETARY_FIBER', quantity: { grams: 3, userProvidedUnit: 'GRAM' } },
        { nutrient: 'SUGAR', quantity: { grams: 6, userProvidedUnit: 'GRAM' } },
      ]),
    );
    // sodium is logged in milligrams by convention, so it converts to grams
    expect(nutrients).toEqual(
      expect.arrayContaining([
        { nutrient: 'SODIUM', quantity: { grams: 1.2, userProvidedUnit: 'MILLIGRAM' } },
      ]),
    );

    expect(entry.logId).toBe('users/me/dataTypes/nutrition-log/dataPoints/dp-1');
    expect(entry.loggedFood?.name).toBe('親子丼');
    expect(entry.loggedFood?.calories).toBe(680);
  });

  it('omits macro fields that were not provided', async () => {
    const calls = stubWrites();
    const provider = new GoogleHealthProvider(envWithFreshToken());
    await provider.logFood({
      date: '2026-08-01',
      mealType: 'Anytime',
      foodName: 'apple',
      calories: 95,
    });
    const log = calls[0]?.body.nutritionLog as Record<string, unknown>;
    expect(log.totalCarbohydrate).toBeUndefined();
    expect(log.totalFat).toBeUndefined();
    expect(log.nutrients).toBeUndefined();
  });
});

describe('logMeal', () => {
  it('writes one nutrition log per item and reports every id', async () => {
    const calls = stubWrites();
    const provider = new GoogleHealthProvider(envWithFreshToken());

    const entries = await provider.logMeal({
      date: '2026-08-01',
      mealType: 'Dinner',
      items: [
        { name: 'rice', calories: 200, protein: 4 },
        { name: 'salmon', calories: 350, protein: 34, fat: 22 },
      ],
    });

    expect(calls).toHaveLength(2);
    expect(entries.map((e) => e.logId)).toEqual([
      'users/me/dataTypes/nutrition-log/dataPoints/dp-1',
      'users/me/dataTypes/nutrition-log/dataPoints/dp-2',
    ]);
    expect((calls[1]?.body.nutritionLog as { foodDisplayName: string }).foodDisplayName).toBe(
      'salmon',
    );
  });
});

describe('logWater / logWeight / logBodyFat', () => {
  it('writes hydration in millilitres', async () => {
    const calls = stubWrites();
    const provider = new GoogleHealthProvider(envWithFreshToken());
    const entry = await provider.logWater({ date: '2026-08-01', amountMl: 500 });

    expect(calls[0]?.path).toBe('/v4/users/me/dataTypes/hydration-log/dataPoints');
    expect((calls[0]?.body.hydrationLog as Record<string, unknown>).amountConsumed).toEqual({
      milliliters: 500,
      userProvidedUnit: 'MILLILITER',
    });
    expect(entry.amount).toBe(500);
  });

  it('converts kilograms to the grams the API expects', async () => {
    const calls = stubWrites();
    const provider = new GoogleHealthProvider(envWithFreshToken());
    const entry = await provider.logWeight({ date: '2026-08-01', time: '07:15', weightKg: 70.4 });

    expect(calls[0]?.path).toBe('/v4/users/me/dataTypes/weight/dataPoints');
    const weight = calls[0]?.body.weight as Record<string, unknown>;
    expect(weight.weightGrams).toBe(70400);
    expect(weight.sampleTime).toEqual({
      physicalTime: '2026-07-31T22:15:00.000Z',
      utcOffset: '32400s',
    });
    // the domain type keeps reporting kilograms
    expect(entry.weight).toBe(70.4);
  });

  it('writes body fat as a percentage', async () => {
    const calls = stubWrites();
    const provider = new GoogleHealthProvider(envWithFreshToken());
    const entry = await provider.logBodyFat({ date: '2026-08-01', fatPercent: 18.5 });

    expect(calls[0]?.path).toBe('/v4/users/me/dataTypes/body-fat/dataPoints');
    expect((calls[0]?.body.bodyFat as Record<string, unknown>).percentage).toBe(18.5);
    expect(entry.fat).toBe(18.5);
  });
});

describe('logActivity / logSleep', () => {
  it('writes an exercise session with the required summary block', async () => {
    const calls = stubWrites();
    const provider = new GoogleHealthProvider(envWithFreshToken());

    const entry = await provider.logActivity({
      date: '2026-08-01',
      startTime: '18:30:00',
      activityName: 'Running',
      manualCalories: 420,
      durationMs: 45 * 60_000,
      distanceKm: 7.5,
    });

    expect(calls[0]?.path).toBe('/v4/users/me/dataTypes/exercise/dataPoints');
    const exercise = calls[0]?.body.exercise as Record<string, unknown>;
    expect(exercise.displayName).toBe('Running');
    expect(exercise.exerciseType).toBe('RUNNING');
    expect(exercise.interval).toMatchObject({
      startTime: '2026-08-01T09:30:00.000Z',
      endTime: '2026-08-01T10:15:00.000Z',
    });
    // metricsSummary is required by the API even for a manual log
    expect(exercise.metricsSummary).toEqual({
      caloriesKcal: 420,
      distanceMillimeters: 7_500_000,
    });
    expect(entry.activityName).toBe('Running');
    expect(entry.duration).toBe(45 * 60_000);
  });

  it('falls back to a generic exercise type for unknown activity names', async () => {
    const calls = stubWrites();
    const provider = new GoogleHealthProvider(envWithFreshToken());
    await provider.logActivity({
      date: '2026-08-01',
      startTime: '10:00:00',
      activityName: 'Underwater basket weaving',
      manualCalories: 100,
      durationMs: 60_000,
    });
    const exercise = calls[0]?.body.exercise as Record<string, unknown>;
    expect(exercise.exerciseType).toBe('WORKOUT');
    // the user's wording survives as the display name
    expect(exercise.displayName).toBe('Underwater basket weaving');
  });

  it('writes a manual sleep session', async () => {
    const calls = stubWrites();
    const provider = new GoogleHealthProvider(envWithFreshToken());

    const entry = await provider.logSleep({
      date: '2026-08-01',
      startTime: '23:40',
      durationMs: 7 * 3600_000,
    });

    expect(calls[0]?.path).toBe('/v4/users/me/dataTypes/sleep/dataPoints');
    expect((calls[0]?.body.sleep as Record<string, unknown>).interval).toMatchObject({
      startTime: '2026-08-01T14:40:00.000Z',
      endTime: '2026-08-01T21:40:00.000Z',
    });
    expect(entry.duration).toBe(7 * 3600_000);
    expect(entry.dateOfSleep).toBe('2026-08-02');
  });
});

describe('deletes', () => {
  it('routes each delete to its data type', async () => {
    const calls = stubWrites();
    const provider = new GoogleHealthProvider(envWithFreshToken());

    await provider.deleteFoodLog('users/me/dataTypes/nutrition-log/dataPoints/n-1');
    await provider.deleteWaterLog('users/me/dataTypes/hydration-log/dataPoints/h-1');
    await provider.deleteWeightLog('users/me/dataTypes/weight/dataPoints/w-1');
    await provider.deleteBodyFatLog('users/me/dataTypes/body-fat/dataPoints/b-1');
    await provider.deleteActivityLog('users/me/dataTypes/exercise/dataPoints/e-1');
    await provider.deleteSleepLog('users/me/dataTypes/sleep/dataPoints/s-1');

    expect(calls.map((c) => c.path)).toEqual([
      '/v4/users/me/dataTypes/nutrition-log/dataPoints:batchDelete',
      '/v4/users/me/dataTypes/hydration-log/dataPoints:batchDelete',
      '/v4/users/me/dataTypes/weight/dataPoints:batchDelete',
      '/v4/users/me/dataTypes/body-fat/dataPoints:batchDelete',
      '/v4/users/me/dataTypes/exercise/dataPoints:batchDelete',
      '/v4/users/me/dataTypes/sleep/dataPoints:batchDelete',
    ]);
    expect(calls[0]?.body).toEqual({
      names: ['users/me/dataTypes/nutrition-log/dataPoints/n-1'],
    });
  });
});
