import type { Env } from '../../env';
import type {
  ActivityResourceT,
  BodyFatLog,
  BodyLog,
  CardioFitness,
  DailySummary,
  Device,
  ExerciseLog,
  FoodLog,
  FoodLogEntry,
  HealthProvider,
  HeartRateDay,
  HeartRateIntraday,
  HrvDay,
  IntradayDetailLevelT,
  LogActivityInput,
  LogBodyFatInput,
  LogFoodInput,
  LogId,
  LogMealInput,
  LogSleepInput,
  LogWaterInput,
  LogWeightInput,
  Profile,
  RespiratoryRateDay,
  SkinTempDay,
  SleepLog,
  SpO2Day,
  TimeSeries,
  WaterLogEntry,
  WeightLog,
} from '../types';
import { getActivityTimeSeries, getDailySummary } from './activity';
import { GoogleHealthClient } from './client';
import { getHeartRateRange } from './heart';
import {
  getCardioFitness,
  getHRV,
  getRespiratoryRate,
  getSkinTemperature,
  getSpO2,
} from './metrics';
import { getSleep, getSleepRange } from './sleep';
import {
  deleteByType,
  logActivity,
  logBodyFat,
  logFood,
  logMeal,
  logSleep,
  logWater,
  logWeight,
} from './write-domains';

const SUPPORTED =
  'reads: get_sleep, get_sleep_range, get_daily_summary, get_activity_timeseries, ' +
  'get_heart_rate_range, get_hrv; writes: log_food, log_meal_photo, log_water, log_weight, ' +
  'log_body_fat, log_activity, log_sleep and the matching deletes';

function notImplemented(method: string): never {
  throw new Error(
    `${method} is not implemented by the google_health provider yet ` +
      `(supported: ${SUPPORTED}). ` +
      'Set HEALTH_PROVIDER=fitbit for full coverage until the Fitbit Web API turndown (September 2026).',
  );
}

/**
 * GoogleHealthProvider — implements the MVP read slice of HealthProvider
 * against the Google Health API v4 (health.googleapis.com), the successor
 * of the Fitbit Web API. Remaining methods throw a descriptive error until
 * they are ported.
 */
export class GoogleHealthProvider implements HealthProvider {
  private readonly client: GoogleHealthClient;

  constructor(env: Env, userId?: string) {
    this.client = new GoogleHealthClient(env, userId);
  }

  // ---------- Read: MVP ----------
  getSleep(date: string): Promise<SleepLog[]> {
    return getSleep(this.client, date);
  }
  getSleepRange(start: string, end: string): Promise<SleepLog[]> {
    return getSleepRange(this.client, start, end);
  }
  getDailySummary(date: string): Promise<DailySummary> {
    return getDailySummary(this.client, date);
  }
  getActivityTimeSeries(
    resource: ActivityResourceT,
    start: string,
    end: string,
  ): Promise<TimeSeries> {
    return getActivityTimeSeries(this.client, resource, start, end);
  }
  getHeartRateRange(start: string, end: string): Promise<HeartRateDay[]> {
    return getHeartRateRange(this.client, start, end);
  }
  getHRV(start: string, end: string): Promise<HrvDay[]> {
    return getHRV(this.client, start, end);
  }

  // ---------- Read: not ported yet ----------
  async getProfile(): Promise<Profile> {
    notImplemented('get_profile');
  }
  async listDevices(): Promise<Device[]> {
    notImplemented('list_devices');
  }
  async getExerciseList(_opts: { beforeDate?: string; limit?: number }): Promise<ExerciseLog[]> {
    notImplemented('get_exercise_list');
  }
  async getHeartRateIntraday(
    _date: string,
    _detailLevel: IntradayDetailLevelT,
  ): Promise<HeartRateIntraday> {
    notImplemented('get_heart_rate_intraday');
  }
  async getBodyLog(_start: string, _end: string): Promise<BodyLog> {
    notImplemented('get_body_log');
  }
  async getFoodLog(_date: string): Promise<FoodLog> {
    notImplemented('get_food_log');
  }
  getSpO2(start: string, end: string): Promise<SpO2Day[]> {
    return getSpO2(this.client, start, end);
  }
  getRespiratoryRate(start: string, end: string): Promise<RespiratoryRateDay[]> {
    return getRespiratoryRate(this.client, start, end);
  }
  getSkinTemperature(start: string, end: string): Promise<SkinTempDay[]> {
    return getSkinTemperature(this.client, start, end);
  }
  getCardioFitness(date: string): Promise<CardioFitness> {
    return getCardioFitness(this.client, date);
  }

  // ---------- Write ----------
  logFood(input: LogFoodInput): Promise<FoodLogEntry> {
    return logFood(this.client, input);
  }
  logMeal(input: LogMealInput): Promise<FoodLogEntry[]> {
    return logMeal(this.client, input);
  }
  logWater(input: LogWaterInput): Promise<WaterLogEntry> {
    return logWater(this.client, input);
  }
  logWeight(input: LogWeightInput): Promise<WeightLog> {
    return logWeight(this.client, input);
  }
  logBodyFat(input: LogBodyFatInput): Promise<BodyFatLog> {
    return logBodyFat(this.client, input);
  }
  logActivity(input: LogActivityInput): Promise<ExerciseLog> {
    return logActivity(this.client, input);
  }
  logSleep(input: LogSleepInput): Promise<SleepLog> {
    return logSleep(this.client, input);
  }
  deleteFoodLog(logId: LogId): Promise<void> {
    return deleteByType(this.client, 'food', logId);
  }
  deleteWaterLog(logId: LogId): Promise<void> {
    return deleteByType(this.client, 'water', logId);
  }
  deleteWeightLog(logId: LogId): Promise<void> {
    return deleteByType(this.client, 'weight', logId);
  }
  deleteBodyFatLog(logId: LogId): Promise<void> {
    return deleteByType(this.client, 'bodyFat', logId);
  }
  deleteActivityLog(logId: LogId): Promise<void> {
    return deleteByType(this.client, 'activity', logId);
  }
  deleteSleepLog(logId: LogId): Promise<void> {
    return deleteByType(this.client, 'sleep', logId);
  }
}
