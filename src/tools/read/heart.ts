import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import { cacheKey, getCached } from '../../lib/cache';
import { assertIsoDate, normalizeRange } from '../../lib/date';
import { toolErrorResult } from '../../lib/errors';
import type { HealthProvider } from '../../providers/types';
import {
  HeartRateDaySchema,
  HeartRateIntradaySchema,
  IntradayDetailLevel,
} from '../../providers/types';

export function registerHeartReadTools(
  server: McpServer,
  provider: HealthProvider,
  env: Env,
): void {
  server.registerTool(
    'get_heart_rate_range',
    {
      title: 'Heart rate across a date range',
      description:
        'Daily resting heart rate and time-in-zone for each day in the range. Cached 1h.',
      inputSchema: {
        start: z.string().describe('YYYY-MM-DD'),
        end: z.string().describe('YYYY-MM-DD'),
      },
      outputSchema: { days: z.array(HeartRateDaySchema) },
    },
    async ({ start, end }) => {
      try {
        const range = normalizeRange(start, end);
        const days = await getCached(env, cacheKey('get_heart_rate_range', range), () =>
          provider.getHeartRateRange(range.start, range.end),
        );
        return {
          structuredContent: { days },
          content: [{ type: 'text', text: JSON.stringify(days, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.registerTool(
    'get_heart_rate_intraday',
    {
      title: 'Intraday heart rate for one day',
      description:
        'Time-series heart rate for a single day at the requested resolution; 1min is best for all-day trends. The series is aggregated and capped, so it is a shape of the day rather than every raw sample. Under the fitbit provider the dataset is sometimes empty or partial even when zone summaries are complete (Fitbit prunes points around logged workouts); under google_health the samples are whatever the device recorded, averaged into the requested buckets. `restingHeartRate` and `heartRateZones` are reliable either way, so fall back to `get_heart_rate_range` when `points` is empty.',
      inputSchema: {
        date: z.string().describe('YYYY-MM-DD'),
        detailLevel: IntradayDetailLevel.describe(
          'Resolution. Use 1min for day-long views, 5min/15min for lighter payloads, 1sec during a workout.',
        ),
      },
      outputSchema: HeartRateIntradaySchema.shape,
    },
    async ({ date, detailLevel }) => {
      try {
        assertIsoDate(date, 'date');
        const data = await getCached(
          env,
          cacheKey('get_heart_rate_intraday', { date, detailLevel }),
          () => provider.getHeartRateIntraday(date, detailLevel),
        );
        return {
          structuredContent: data,
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
