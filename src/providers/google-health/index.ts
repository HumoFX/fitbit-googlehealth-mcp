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
import { getHRV } from './metrics';
import { getSleep, getSleepRange } from './sleep';

const MVP_READS =
  'get_sleep, get_sleep_range, get_daily_summary, get_activity_timeseries, get_heart_rate_range, get_hrv';

function notImplemented(method: string): never {
  throw new Error(
    `${method} is not implemented by the google_health provider yet ` +
      `(current MVP is read-only: ${MVP_READS}). ` +
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

  constructor(env: Env) {
    this.client = new GoogleHealthClient(env);
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
  async getSpO2(_start: string, _end: string): Promise<SpO2Day[]> {
    notImplemented('get_spo2');
  }
  async getRespiratoryRate(_start: string, _end: string): Promise<RespiratoryRateDay[]> {
    notImplemented('get_respiratory_rate');
  }
  async getSkinTemperature(_start: string, _end: string): Promise<SkinTempDay[]> {
    notImplemented('get_skin_temperature');
  }
  async getCardioFitness(_date: string): Promise<CardioFitness> {
    notImplemented('get_cardio_fitness');
  }

  // ---------- Write: not ported yet ----------
  async logFood(_input: LogFoodInput): Promise<FoodLogEntry> {
    notImplemented('log_food');
  }
  async logMeal(_input: LogMealInput): Promise<FoodLogEntry[]> {
    notImplemented('log_meal_photo');
  }
  async logWater(_input: LogWaterInput): Promise<WaterLogEntry> {
    notImplemented('log_water');
  }
  async logWeight(_input: LogWeightInput): Promise<WeightLog> {
    notImplemented('log_weight');
  }
  async logBodyFat(_input: LogBodyFatInput): Promise<BodyFatLog> {
    notImplemented('log_body_fat');
  }
  async logActivity(_input: LogActivityInput): Promise<ExerciseLog> {
    notImplemented('log_activity');
  }
  async logSleep(_input: LogSleepInput): Promise<SleepLog> {
    notImplemented('log_sleep');
  }
  async deleteFoodLog(_logId: number): Promise<void> {
    notImplemented('delete_food_log');
  }
  async deleteWaterLog(_logId: number): Promise<void> {
    notImplemented('delete_water_log');
  }
  async deleteWeightLog(_logId: number): Promise<void> {
    notImplemented('delete_weight_log');
  }
  async deleteBodyFatLog(_logId: number): Promise<void> {
    notImplemented('delete_body_fat_log');
  }
  async deleteActivityLog(_logId: number): Promise<void> {
    notImplemented('delete_activity_log');
  }
  async deleteSleepLog(_logId: number): Promise<void> {
    notImplemented('delete_sleep_log');
  }
}
