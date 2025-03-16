// filename: src/types/index.ts
import {Device} from '../sleepme/client.js';

export type SleepmeContext = {
  device: Device;
  apiKey: string;
};

export interface PlatformConfig {
  water_level_type?: 'battery' | 'leak' | 'motion';
  active_polling_interval_seconds?: number;
  standby_polling_interval_minutes?: number;
}

// Default polling intervals
export const DEFAULT_ACTIVE_POLLING_INTERVAL_SECONDS = 30;   // 30 seconds when device is active
export const DEFAULT_STANDBY_POLLING_INTERVAL_MINUTES = 15;  // 15 minutes when device is in standby
export const INITIAL_RETRY_DELAY_MS = 15000;                 // 15 seconds for first retry
export const MAX_RETRIES = 3;                                // Maximum number of retry attempts
export const STATE_MISMATCH_RETRY_DELAY_MS = 5000;           // 5 seconds between state mismatch retries
export const MAX_STATE_MISMATCH_RETRIES = 3;                 // Maximum retries for state mismatches
export const HIGH_TEMP_THRESHOLD_F = 115;
export const HIGH_TEMP_TARGET_F = 999;
export const LOW_TEMP_THRESHOLD_F = 55;
export const LOW_TEMP_TARGET_F = -1;