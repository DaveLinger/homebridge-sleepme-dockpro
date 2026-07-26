// filename: src/platformAccessory.ts
import {CharacteristicValue, PlatformAccessory, Service} from 'homebridge';

import {SleepmePlatform} from './platform.js';
import {Client, Device, DeviceStatus, SleepmeApiError} from './sleepme/client.js';
import {POLL_BUDGET_PER_MINUTE, RateLimitDeferredError, REQUESTS_PER_MINUTE} from './sleepme/rateLimiter.js';

type SleepmeContext = {
  device: Device;
  apiKey: string;
};

interface PlatformConfig {
  water_level_type?: 'battery' | 'leak' | 'motion';
  active_polling_interval_seconds?: number;
  standby_polling_interval_minutes?: number;
}

interface Mapper {
  toHeatingCoolingState: (status: DeviceStatus) => 0 | 1 | 2;
}

function newMapper(platform: SleepmePlatform): Mapper {
  const {Characteristic} = platform;
  return {
    toHeatingCoolingState: (status: DeviceStatus): 0 | 1 | 2 => {
      if (status.control.thermal_control_status === 'standby') {
        return Characteristic.CurrentHeatingCoolingState.OFF;
      }

      const currentTemp = status.status.water_temperature_c;
      const targetTemp = status.control.set_temperature_c;

      if (targetTemp > currentTemp) {
        return Characteristic.CurrentHeatingCoolingState.HEAT;
      } else {
        return Characteristic.CurrentHeatingCoolingState.COOL;
      }
    },
  };
}

class Option<T> {
  readonly value: T | null;

  constructor(value: T | null) {
    this.value = value;
  }

  map<TNext>(mapF: (value: T) => TNext): Option<TNext> {
    if (this.value) {
      return new Option(mapF(this.value));
    }
    return new Option<TNext>(null);
  }

  orElse(elseValue: T): T {
    return this.value ?? elseValue;
  }
}

// Normalizes the unknown value from a catch block into a loggable string.
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Default polling intervals
const DEFAULT_ACTIVE_POLLING_INTERVAL_SECONDS = 45;   // 45 seconds when device is active
const DEFAULT_STANDBY_POLLING_INTERVAL_MINUTES = 15;  // 15 minutes when device is in standby
// Smallest safe active interval for a SINGLE device: the account's polling budget
// spread across a minute. With N devices on one token the floor becomes N times
// this, which keeps total polling at POLL_BUDGET_PER_MINUTE regardless of count.
const MIN_ACTIVE_SECONDS_PER_DEVICE = Math.ceil(60 / POLL_BUDGET_PER_MINUTE);
// Standby polling is not scaled: at the 15 minute default even four devices cost
// well under one request per minute, and stretching it would only delay noticing
// a state change for no quota benefit.
const MIN_STANDBY_POLLING_INTERVAL_MINUTES = 1;
// Dragging the temperature slider in the Home app emits a write per step, so a
// single gesture can produce a dozen distinct values in a couple of seconds. Only
// the value the user settles on is worth sending. This window is short enough to
// feel instant — the optimistic update has already moved the UI — and long enough
// to swallow a whole drag.
const TEMPERATURE_DEBOUNCE_MS = 500;
const INITIAL_RETRY_DELAY_MS = 15000;                 // 15 seconds for first retry
const MAX_RETRY_DELAY_MS = 60000;                     // Cap retry delay at 60 seconds
const MAX_RETRIES = 3;                                // Maximum number of retry attempts
const HIGH_TEMP_THRESHOLD_F = 115;
const HIGH_TEMP_TARGET_F = 999;
const LOW_TEMP_THRESHOLD_F = 55;
const LOW_TEMP_TARGET_F = -1;

export class SleepmePlatformAccessory {
  private thermostatService: Service;
  private waterLevelService: Service;
  private deviceStatus: DeviceStatus | null;
  private timeout: NodeJS.Timeout | undefined;
  private readonly waterLevelType: 'battery' | 'leak' | 'motion';
  private readonly activePollingIntervalMs: number;
  private readonly standbyPollingIntervalMs: number;
  private expectedThermalState: 'standby' | 'active' | null = null; // Track expected state
  // Previous water readings, so transitions can be logged at info level (see publishUpdates)
  private previousWaterLevel: number | null = null;
  private previousIsWaterLow: boolean | null = null;
  // Coalesces a burst of slider writes into one request (see queueTemperatureCommand)
  private pendingTemperatureF: number | null = null;
  private temperatureDebounce: NodeJS.Timeout | undefined;

  // Metrics tracking
  private metrics = {
    apiCalls: {
      successful: 0,
      failed: 0,
      rateLimited: 0,
      timeout: 0,
    },
    lastSuccessfulPoll: null as Date | null,
    lastFailedPoll: null as Date | null,
    consecutiveFailures: 0,
  };

  constructor(
    private readonly platform: SleepmePlatform,
    private readonly accessory: PlatformAccessory,
    initialStatus?: DeviceStatus,
    deviceCount = 1,
  ) {
    const {Characteristic} = this.platform;
    const {apiKey, device} = this.accessory.context as SleepmeContext;
    // Shared per token so the rate limiter sees the whole account's traffic.
    const client = this.platform.clientFor(apiKey);
    this.deviceStatus = null;

    // Get configuration
    const config = this.platform.config as PlatformConfig;
    this.waterLevelType = config.water_level_type || 'battery';

    // Active polling scales with how many devices share this token's quota.
    //
    // The account gets POLL_BUDGET_PER_MINUTE polling requests per minute, so one
    // device can safely poll every 60 / that budget seconds, and N devices need N
    // times that. Taking the max with the configured value means the scaling only
    // ever raises an interval that would breach the quota: two docks left at the
    // 45s default stay at 45s rather than being stretched to 90s, while two docks
    // set to the 10s floor land on 20s.
    const minSafeActiveSeconds = MIN_ACTIVE_SECONDS_PER_DEVICE * deviceCount;
    const requestedActiveSeconds = config.active_polling_interval_seconds ?? DEFAULT_ACTIVE_POLLING_INTERVAL_SECONDS;
    const effectiveActiveSeconds = Math.max(requestedActiveSeconds, minSafeActiveSeconds);
    this.activePollingIntervalMs = effectiveActiveSeconds * 1000;

    if (effectiveActiveSeconds > requestedActiveSeconds) {
      this.platform.log.info(
        `${this.accessory.displayName}: Active polling interval raised from ${requestedActiveSeconds}s to ` +
        `${effectiveActiveSeconds}s because ${deviceCount} devices share this account's quota of ` +
        `${REQUESTS_PER_MINUTE} requests per minute.`,
      );
    } else {
      this.platform.log.debug(
        `${this.accessory.displayName}: Active polling interval ${effectiveActiveSeconds}s ` +
        `(safe floor for ${deviceCount} device(s) is ${minSafeActiveSeconds}s)`,
      );
    }

    // Set up standby polling interval from config or use default
    const configuredStandbyMinutes = config.standby_polling_interval_minutes;
    if (configuredStandbyMinutes !== undefined) {
      if (configuredStandbyMinutes < MIN_STANDBY_POLLING_INTERVAL_MINUTES) {
        this.platform.log.warn(
          `Standby polling interval must be at least ${MIN_STANDBY_POLLING_INTERVAL_MINUTES} minute(s). ` +
          `Using ${MIN_STANDBY_POLLING_INTERVAL_MINUTES} minute(s).`,
        );
        this.standbyPollingIntervalMs = MIN_STANDBY_POLLING_INTERVAL_MINUTES * 60 * 1000;
      } else {
        this.standbyPollingIntervalMs = configuredStandbyMinutes * 60 * 1000;
        this.platform.log.debug(`Using configured standby polling interval of ${configuredStandbyMinutes} minutes`);
      }
    } else {
      this.standbyPollingIntervalMs = DEFAULT_STANDBY_POLLING_INTERVAL_MINUTES * 60 * 1000;
      this.platform.log.debug(`Using default standby polling interval of ${DEFAULT_STANDBY_POLLING_INTERVAL_MINUTES} minutes`);
    }

    // Debug log the startup state and configuration
    this.platform.log.debug(`Initializing ${this.accessory.displayName}`);
    this.platform.log.debug('Configuration:', JSON.stringify(config));
    this.platform.log.debug(`Water level type configured as: ${this.waterLevelType}`);
    this.platform.log.debug(`Active polling interval: ${this.activePollingIntervalMs/1000} seconds`);
    this.platform.log.debug(`Standby polling interval: ${this.standbyPollingIntervalMs/60000} minutes`);

    // Initialize service bindings first
    this.thermostatService = this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat, `${this.accessory.displayName} - Dock Pro`);

    // Reuse the water level service matching the configured type, and drop only the
    // services left behind by a *previous* configuration. Removing and re-adding the
    // service on every launch would republish the accessory's service list each restart.
    const waterLevelServices = {
      battery: this.platform.Service.Battery,
      leak: this.platform.Service.LeakSensor,
      motion: this.platform.Service.MotionSensor,
    };
    const waterLevelServiceName = `${this.accessory.displayName} - Water Level`;

    Object.entries(waterLevelServices).forEach(([type, serviceType]) => {
      if (type === this.waterLevelType) {
        return;
      }
      const staleService = this.accessory.getService(serviceType);
      if (staleService) {
        this.platform.log.debug(`Removing ${type} water level service from a previous configuration`);
        this.accessory.removeService(staleService);
      }
    });

    const configuredService = waterLevelServices[this.waterLevelType];
    const existingWaterLevelService = this.accessory.getService(configuredService);
    if (existingWaterLevelService) {
      this.platform.log.debug(`Reusing existing ${this.waterLevelType} water level service`);
      this.waterLevelService = existingWaterLevelService;
      this.waterLevelService.setCharacteristic(Characteristic.Name, waterLevelServiceName);
    } else {
      this.platform.log.debug(`Creating new water level service of type: ${this.waterLevelType}`);
      this.waterLevelService = this.accessory.addService(configuredService, waterLevelServiceName);
    }

    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Sleepme')
      .setCharacteristic(Characteristic.Model, 'Dock Pro')
      .setCharacteristic(Characteristic.SerialNumber, device.id);

    // Initialize all characteristic handlers after services are created
    this.initializeCharacteristics(client, device);

    // Apply the status the platform already fetched during discovery, if it passed one
    // in; otherwise fetch it now. Reusing it keeps startup to one status call per device.
    if (initialStatus) {
      this.applyDeviceStatus(initialStatus);
    } else {
      client.getDeviceStatus(device.id)
        .then(statusResponse => this.applyDeviceStatus(statusResponse.data))
        .catch(error => {
          if (error instanceof RateLimitDeferredError) {
            // Not a failure — the polling cycle will pick the status up shortly.
            this.platform.log.debug(`${this.accessory.displayName}: ${error.message}`);
            return;
          }
          this.platform.log.error(
            `Failed to get initial device status for ${this.accessory.displayName}: ${errorMessage(error)}`,
          );
          // Still continue with setup, we'll retry on the next polling cycle
        });
    }

    // Set up polling based on initial unknown state
    // We'll use the active polling rate initially until we know the device state
    this.scheduleNextCheck(async () => {
      this.platform.log.debug(`Polling device status for ${this.accessory.displayName}`)
      const r = await client.getDeviceStatus(device.id);
      this.platform.log.debug(`Response (${this.accessory.displayName}): ${r.status}`)
      return r.data
    });

    // Log metrics summary every hour for monitoring (debug level)
    setInterval(() => {
      if (this.metrics.apiCalls.successful > 0 || this.metrics.apiCalls.failed > 0) {
        this.logMetricsSummary('debug');
      }
    }, 60 * 60 * 1000); // Every hour
  }

  /**
   * Coalesces temperature writes so a slider drag costs one API request.
   *
   * Each write replaces the pending value and restarts the timer, so only the value
   * the user settles on is sent. HomeKit is never made to wait: the caller has
   * already applied the optimistic update and returned, and the request itself runs
   * detached with its own error handling.
   */
  private queueTemperatureCommand(client: Client, device: Device, apiTemp: number): void {
    this.pendingTemperatureF = apiTemp;

    if (this.temperatureDebounce) {
      clearTimeout(this.temperatureDebounce);
      this.platform.log.debug(
        `${this.accessory.displayName}: Superseding queued temperature command with ${apiTemp}°F`,
      );
    }

    this.temperatureDebounce = setTimeout(() => {
      this.temperatureDebounce = undefined;
      const target = this.pendingTemperatureF;
      this.pendingTemperatureF = null;
      if (target === null) {
        return;
      }

      this.retryApiCall(
        () => client.setTemperatureFahrenheit(device.id, target),
        this.accessory.displayName,
        'set temperature',
      )
        .catch(error => {
          this.platform.log.error(
            `${this.accessory.displayName}: Failed to set temperature after retries: ${errorMessage(error)}`,
          );
          // Revert optimistic update by fetching actual device state
          return client.getDeviceStatus(device.id)
            .then(statusResponse => {
              this.deviceStatus = statusResponse.data;
              this.publishUpdates();
            })
            .catch(refreshError => {
              if (refreshError instanceof RateLimitDeferredError) {
                this.platform.log.debug(`${this.accessory.displayName}: ${refreshError.message}`);
                return;
              }
              this.platform.log.error(
                `${this.accessory.displayName}: Failed to refresh status after error: ${errorMessage(refreshError)}`,
              );
            });
        });
    }, TEMPERATURE_DEBOUNCE_MS);
  }

  // Adopts a fresh device status: stores it, refreshes the reported firmware
  // version, and pushes every characteristic to HomeKit.
  private applyDeviceStatus(status: DeviceStatus): void {
    this.deviceStatus = status;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, status.about.firmware_version);

    this.publishUpdates();
  }

  // Update the retry helper method in the SleepmePlatformAccessory class
  private retryApiCall<T>(
    operation: () => Promise<T>,
    deviceName: string,
    operationName: string,
    maxRetries: number = MAX_RETRIES,
    currentAttempt: number = 1,
  ): Promise<T> {
    return operation().then(result => {
      // Track successful API call
      this.metrics.apiCalls.successful++;
      this.metrics.consecutiveFailures = 0;
      this.metrics.lastSuccessfulPoll = new Date();
      return result;
    }).catch(error => {
      // A deferred poll is not a failure. No request left the process, so it must not
      // be retried (that would hammer a window that is already full) and must not be
      // counted against the metrics. The caller reschedules instead.
      if (error instanceof RateLimitDeferredError) {
        throw error;
      }

      // Track failed API call
      const statusCode = error instanceof SleepmeApiError ? error.statusCode : undefined;
      const errorCode = error instanceof SleepmeApiError ? error.code : undefined;

      if (statusCode === 429) {
        this.metrics.apiCalls.rateLimited++;
      } else if (errorCode === 'ECONNABORTED') {
        this.metrics.apiCalls.timeout++;
      }

      // Retry on any error, not just rate limits
      if (currentAttempt <= maxRetries) {
        // Calculate exponential backoff delay with cap: 15s, 30s, 60s (capped)
        const uncappedDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, currentAttempt - 1);
        const delay = Math.min(uncappedDelay, MAX_RETRY_DELAY_MS);

        // Format error message based on status code if available
        let errorDetails = errorMessage(error);
        if (statusCode) {
          errorDetails = `HTTP ${statusCode}: ${errorDetails}`;
        }

        this.platform.log.warn(
          `${deviceName}: Failed to ${operationName} (${errorDetails}). ` +
          `Retrying in ${delay/1000}s (attempt ${currentAttempt}/${maxRetries})`,
        );

        // Wait and then retry with exponential backoff
        return new Promise(resolve => setTimeout(resolve, delay))
          .then(() => this.retryApiCall(
            operation,
            deviceName,
            operationName,
            maxRetries,
            currentAttempt + 1,
          ));
      }

      // If we've exhausted retries, track the failure and rethrow
      this.metrics.apiCalls.failed++;
      this.metrics.consecutiveFailures++;
      this.metrics.lastFailedPoll = new Date();

      // Log metrics summary if we have multiple consecutive failures (warn level to alert user)
      if (this.metrics.consecutiveFailures >= 3) {
        this.logMetricsSummary('warn');
      }

      throw error;
    });
  }

  // Helper method to clamp temperature values to valid range for HomeKit
  private clampTemperature(value: number, min: number, max: number, defaultValue: number = 21): number {
    // Check if value is a valid number
    if (typeof value !== 'number' || isNaN(value) || !isFinite(value)) {
      return defaultValue;
    }
    return Math.max(min, Math.min(max, value));
  }

  // Log metrics summary for debugging
  private logMetricsSummary(level: 'info' | 'warn' | 'debug' = 'info'): void {
    const total = this.metrics.apiCalls.successful + this.metrics.apiCalls.failed;
    const successRate = total > 0 ? ((this.metrics.apiCalls.successful / total) * 100).toFixed(1) : '0.0';

    const message =
      `${this.accessory.displayName} API Metrics: ` +
      `Success: ${this.metrics.apiCalls.successful}, ` +
      `Failed: ${this.metrics.apiCalls.failed}, ` +
      `Rate Limited: ${this.metrics.apiCalls.rateLimited}, ` +
      `Timeout: ${this.metrics.apiCalls.timeout}, ` +
      `Success Rate: ${successRate}%, ` +
      `Consecutive Failures: ${this.metrics.consecutiveFailures}, ` +
      `Last Success: ${this.metrics.lastSuccessfulPoll?.toLocaleString() || 'Never'}`;

    if (level === 'warn') {
      this.platform.log.warn(message);
    } else if (level === 'debug') {
      this.platform.log.debug(message);
    } else {
      this.platform.log.info(message);
    }
  }

  private initializeCharacteristics(client: Client, device: Device) {
    const {Characteristic} = this.platform;

    // Initialize water level characteristics based on type
    if (this.waterLevelType === 'leak') {
      this.waterLevelService.getCharacteristic(Characteristic.LeakDetected)
        .onGet(() => new Option(this.deviceStatus)
          .map(ds => ds.status.is_water_low ?
            Characteristic.LeakDetected.LEAK_DETECTED :
            Characteristic.LeakDetected.LEAK_NOT_DETECTED)
          .orElse(Characteristic.LeakDetected.LEAK_NOT_DETECTED));
    } else if (this.waterLevelType === 'motion') {
      this.waterLevelService.getCharacteristic(Characteristic.MotionDetected)
        .onGet(() => new Option(this.deviceStatus)
          .map(ds => ds.status.is_water_low)
          .orElse(false));
    } else {
      this.waterLevelService.getCharacteristic(Characteristic.StatusLowBattery)
        .onGet(() => new Option(this.deviceStatus)
          .map(ds => ds.status.is_water_low ?
            Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW :
            Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL)
          .orElse(Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL));

      this.waterLevelService.getCharacteristic(Characteristic.BatteryLevel)
        .onGet(() => new Option(this.deviceStatus)
          .map(ds => ds.status.water_level)
          .orElse(50));
    }

    // Initialize thermostat characteristics
    this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => newMapper(this.platform).toHeatingCoolingState(ds))
        .orElse(0));

    this.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.TargetHeatingCoolingState.OFF,   // 0
          Characteristic.TargetHeatingCoolingState.HEAT,  // 1 — iOS tile tap sends this
          Characteristic.TargetHeatingCoolingState.COOL,  // 2
          Characteristic.TargetHeatingCoolingState.AUTO,  // 3
        ],
      })
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.control.thermal_control_status === 'standby' ?
          Characteristic.TargetHeatingCoolingState.OFF :
          Characteristic.TargetHeatingCoolingState.AUTO)
        .orElse(Characteristic.TargetHeatingCoolingState.OFF))
      .onSet(async (value: CharacteristicValue) => {
        const targetState = (value === Characteristic.TargetHeatingCoolingState.OFF) ? 'standby' : 'active';

        // Skip a command that asks for the state the device is already in — with a
        // quota of 10 requests a minute, redundant writes are expensive. This is
        // deliberately conservative: it only fires when the state is confirmed
        // (expectedThermalState is null, so no command is in flight) and known from
        // a real reading. Anything less certain still sends, because silently
        // dropping a genuine turn-on is far worse than spending a request.
        if (this.deviceStatus && this.expectedThermalState === null &&
            this.deviceStatus.control.thermal_control_status === targetState) {
          this.platform.log.debug(
            `${this.accessory.displayName}: Ignoring redundant state command — already ${targetState}`,
          );
          return;
        }

        this.platform.log(`${this.accessory.displayName}: HomeKit state changed to ${targetState}`);

        // Store the expected state
        this.expectedThermalState = targetState;

        // Optimistically update the local state first for immediate HomeKit feedback
        if (this.deviceStatus) {
          this.deviceStatus.control.thermal_control_status = targetState;
          this.publishUpdates();
          // Delay the poll reschedule so the device has time to process the command
          // before we read its state back
          setTimeout(() => this.scheduleNextPollBasedOnState(), 2000);
        }

        // Send the command to the API — fires regardless of whether deviceStatus is populated.
        // Not returned: all error paths are handled in .catch() and the handler always resolves void.
        // The SleepMe PATCH response reflects the device's instantaneous state, not the
        // commanded state — the device (especially when turning on) takes time to transition.
        // Validating the response against targetState causes false "state mismatch" loops
        // that ultimately revert the optimistic update and show "no response" in HomeKit.
        // Instead: if the API call succeeds (no error thrown), trust the command was accepted
        // and clear expectedThermalState. The polling logic already preserves expectedThermalState
        // across polls and will update HomeKit once the device actually confirms the new state.
        this.retryApiCall(
          () => client.setThermalControlStatus(device.id, targetState),
          this.accessory.displayName,
          'set thermal control status',
        )
          .then(() => {
            this.expectedThermalState = null;
          })
          .catch(error => {
            this.platform.log.error(
              `${this.accessory.displayName}: Failed to set thermal control state after retries: ${errorMessage(error)}`,
            );
            return client.getDeviceStatus(device.id)
              .then(statusResponse => {
                this.deviceStatus = statusResponse.data;
                this.expectedThermalState = null;
                this.publishUpdates();
                this.scheduleNextPollBasedOnState();
              })
              .catch(refreshError => {
                this.platform.log.error(
                  `${this.accessory.displayName}: Failed to refresh status after error: ${errorMessage(refreshError)}`,
                );
              });
          });
      });

    this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => this.clampTemperature(ds.status.water_temperature_c, 12, 46.7))
        .orElse(21));

    this.thermostatService.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: 12,
        maxValue: 46.7,
        minStep: 0.5,
      })
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => {
          // Handle both high and low special temperature cases
          if (ds.control.set_temperature_f >= HIGH_TEMP_TARGET_F) {
            return 46.7; // Maximum allowed Celsius temperature
          } else if (ds.control.set_temperature_f <= LOW_TEMP_TARGET_F) {
            return 12.2; // 54°F in Celsius
          }
          // Always clamp the temperature to valid HomeKit range
          return this.clampTemperature(ds.control.set_temperature_c, 12, 46.7, 21);
        })
        .orElse(21))
      .onSet(async (value: CharacteristicValue) => {
        const tempC = value as number;
        const tempF = Math.round((tempC * (9 / 5)) + 32);

        // Map to special API values for extremes
        let apiTemp = tempF;
        if (tempF > HIGH_TEMP_THRESHOLD_F) {
          apiTemp = HIGH_TEMP_TARGET_F;
        } else if (tempF < LOW_TEMP_THRESHOLD_F) {
          apiTemp = LOW_TEMP_TARGET_F;
        }

        // Skip a write that would not change anything. The comparison is against the
        // value actually sent rather than the HomeKit value, because the sentinel
        // mapping above collapses a whole range of settings onto one request: 46.5°C
        // and 46.7°C are both 999°F, so only the first needs to go out. Dragging the
        // slider emits a value per step, and at 10 requests a minute those add up.
        if (this.deviceStatus && this.deviceStatus.control.set_temperature_f === apiTemp) {
          this.platform.log.debug(
            `${this.accessory.displayName}: Ignoring redundant temperature command — already set to ${apiTemp}°F`,
          );
          return;
        }

        if (apiTemp === HIGH_TEMP_TARGET_F) {
          this.platform.log(
            `${this.accessory.displayName}: Temperature over ${HIGH_TEMP_THRESHOLD_F}F, ` +
            `mapping to ${HIGH_TEMP_TARGET_F}F for API call`,
          );
        } else if (apiTemp === LOW_TEMP_TARGET_F) {
          this.platform.log(
            `${this.accessory.displayName}: Temperature under ${LOW_TEMP_THRESHOLD_F}F, ` +
            `mapping to ${LOW_TEMP_TARGET_F}F for API call`,
          );
        } else {
          this.platform.log(`${this.accessory.displayName}: Setting temperature to: ${tempC}°C (${tempF}°F)`);
        }

        // Optimistic update — only possible if we already have device state.
        // set_temperature_f stores the value sent, so it matches what the device will
        // report back and keeps the dedup check above correct for repeated HIGH/LOW sets.
        if (this.deviceStatus) {
          this.deviceStatus.control.set_temperature_c = tempC;
          this.deviceStatus.control.set_temperature_f = apiTemp;
          this.publishUpdates();
        }

        // Queue rather than send. A slider drag emits many writes in a second or two
        // and only the final value matters; the optimistic update above has already
        // moved the UI, so the short delay is invisible.
        this.queueTemperatureCommand(client, device, apiTemp);
      });

    // TemperatureDisplayUnits is a writable characteristic on Service.Thermostat.
    // A missing onSet causes HomeKit to receive an error on any bundled write that
    // includes this characteristic (e.g. the tile quick-toggle), which silently
    // blocks the entire request — including TargetHeatingCoolingState — producing
    // "no response" with no log output at all.
    this.thermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.control.display_temperature_unit === 'c' ? 0 : 1)
        .orElse(1))
      .onSet((value: CharacteristicValue) => {
        const unit = value === 0 ? 'c' : 'f';
        this.platform.log(`${this.accessory.displayName}: Temperature display unit changed to ${unit.toUpperCase()}`);
        if (this.deviceStatus) {
          this.deviceStatus.control.display_temperature_unit = unit;
        }
        client.setDisplayTemperatureUnit(device.id, unit)
          .catch(error => {
            this.platform.log.error(`${this.accessory.displayName}: Failed to set display temperature unit: ${errorMessage(error)}`);
          });
      });
  }

  // New method to determine which polling interval to use based on device state
  private getPollingIntervalBasedOnState(): number {
    if (!this.deviceStatus) {
      // If we don't know the state yet, use active polling rate
      this.platform.log.debug(`${this.accessory.displayName}: No device status yet, using active polling interval`);
      return this.activePollingIntervalMs;
    }

    const isActive = this.deviceStatus.control.thermal_control_status === 'active';
    const interval = isActive ? this.activePollingIntervalMs : this.standbyPollingIntervalMs;

    this.platform.log.debug(
      `${this.accessory.displayName}: Device is ${isActive ? 'ACTIVE' : 'STANDBY'}, ` +
      `using ${interval/1000} second polling interval`,
    );
    return interval;
  }

  // New method to immediately update polling schedule based on current state
  private scheduleNextPollBasedOnState(): void {
    // Clear existing timeout
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }

    // Get the appropriate polling interval based on state
    const pollingInterval = this.getPollingIntervalBasedOnState();

    this.platform.log.debug(
      `${this.accessory.displayName}: Rescheduling polling with ${pollingInterval/1000}s interval based on current state`,
    );

    // Schedule the next poll with the new interval
    this.scheduleNextCheck(async () => {
      const {apiKey, device} = this.accessory.context as SleepmeContext;
      const client = this.platform.clientFor(apiKey);
      this.platform.log.debug(`Polling device status for ${this.accessory.displayName}`);
      const r = await client.getDeviceStatus(device.id);
      this.platform.log.debug(`Response (${this.accessory.displayName}): ${r.status}`);
      return r.data;
    });
  }

  private scheduleNextCheck(poller: () => Promise<DeviceStatus>) {
    // Get the appropriate polling interval based on current state
    const pollingInterval = this.getPollingIntervalBasedOnState();

    this.platform.log.debug(`${this.accessory.displayName}: Scheduling next poll in ${pollingInterval/1000}s`);

    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.platform.log.debug(`${this.accessory.displayName}: Polling at: ${new Date()}`);

      // Use the retry mechanism for polling as well
      const getStatusOperation = () => poller();

      this.retryApiCall(
        getStatusOperation,
        this.accessory.displayName,
        'poll device status',
      )
        .then(s => {
          const previousState = this.deviceStatus?.control.thermal_control_status;
          const previousFirmware = this.deviceStatus?.about.firmware_version;
          this.deviceStatus = s;

          // Update firmware version if it changed
          if (previousFirmware && s.about.firmware_version !== previousFirmware) {
            this.platform.log.info(
              `${this.accessory.displayName}: Firmware updated from ${previousFirmware} to ${s.about.firmware_version}`,
            );
          this.accessory.getService(this.platform.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.Characteristic.FirmwareRevision, s.about.firmware_version);
          }

          // Check if we're waiting for a specific thermal state
          if (this.expectedThermalState !== null && s.control.thermal_control_status !== this.expectedThermalState) {
            this.platform.log.warn(
              `${this.accessory.displayName}: Device state (${s.control.thermal_control_status}) ` +
            `does not match expected state (${this.expectedThermalState}) during polling`,
            );
            // Don't update HomeKit with the mismatched state - we'll keep the optimistic state
            // But do update everything else
            const savedState = this.expectedThermalState;
            if (this.deviceStatus) {
              this.deviceStatus.control.thermal_control_status = savedState;
            }
          } else if (this.expectedThermalState !== null && s.control.thermal_control_status === this.expectedThermalState) {
          // State now matches what we expected - we can clear the expected state flag
            this.platform.log.info(`${this.accessory.displayName}: Device state now matches expected state (${this.expectedThermalState})`);
            this.expectedThermalState = null;
          }

          // Check if device state has changed, which would affect polling interval
          const currentState = this.deviceStatus.control.thermal_control_status;
          if (previousState !== currentState) {
            this.platform.log.info(
              `${this.accessory.displayName}: Device state changed from ${previousState || 'unknown'} ` +
            `to ${currentState}, adjusting polling interval`,
            );
            // Update UI first
            this.publishUpdates();
            // Then reschedule with the new appropriate interval
            this.scheduleNextPollBasedOnState();
            return; // Skip the normal schedule since we're rescheduling with a different interval
          }

          this.publishUpdates();
          this.platform.log.debug(`${this.accessory.displayName}: Current thermal control status: ${s.control.thermal_control_status}`);

          // Schedule next poll with the same interval
          this.scheduleNextCheck(poller);
        })
        .catch(error => {
          if (error instanceof RateLimitDeferredError) {
            this.platform.log.debug(`${this.accessory.displayName}: ${error.message}`);
          } else {
            this.platform.log.error(
              `${this.accessory.displayName}: Error polling device after retries: ${errorMessage(error)}`,
            );
          }
          // Still schedule next check even if there was an error after all retries
          this.scheduleNextCheck(poller);
        });
    }, pollingInterval);
  }

  // Publishes all characteristic updates to HomeKit
  private publishUpdates(): void {
    if (!this.deviceStatus) {
      return;
    }

    const { Characteristic } = this.platform;

    // Update thermostat characteristics
    this.thermostatService.updateCharacteristic(
      Characteristic.CurrentHeatingCoolingState,
      newMapper(this.platform).toHeatingCoolingState(this.deviceStatus),
    );

    this.thermostatService.updateCharacteristic(
      Characteristic.TargetHeatingCoolingState,
      this.deviceStatus.control.thermal_control_status === 'standby' ?
        Characteristic.TargetHeatingCoolingState.OFF :
        Characteristic.TargetHeatingCoolingState.AUTO,
    );

    const rawTemp = this.deviceStatus.status.water_temperature_c;
    if (typeof rawTemp !== 'number' || isNaN(rawTemp) || !isFinite(rawTemp)) {
      this.platform.log.warn(
        `${this.accessory.displayName}: Invalid water temperature received: ${rawTemp}. Using default value.`,
      );
    }
    const currentTemp = this.clampTemperature(rawTemp, 12, 46.7);
    this.thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, currentTemp);

    // Determine target temperature value considering special cases
    let targetTemp = this.deviceStatus.control.set_temperature_c;
    if (this.deviceStatus.control.set_temperature_f >= HIGH_TEMP_TARGET_F) {
      targetTemp = 46.7; // Maximum allowed Celsius temperature
    } else if (this.deviceStatus.control.set_temperature_f <= LOW_TEMP_TARGET_F) {
      targetTemp = 12.2; // Minimum allowed temperature (54°F)
    }

    // Check if temperature is out of range before clamping
    if (targetTemp < 12 || targetTemp > 46.7) {
      this.platform.log.warn(
        `${this.accessory.displayName}: API returned out-of-range target temperature: ` +
        `${targetTemp}°C (${this.deviceStatus.control.set_temperature_f}°F). Clamping to valid range.`,
      );
    }

    // Always apply clamping to ensure we never send out-of-range values to HomeKit
    targetTemp = this.clampTemperature(targetTemp, 12, 46.7, 21);
    this.thermostatService.updateCharacteristic(Characteristic.TargetTemperature, targetTemp);

    this.thermostatService.updateCharacteristic(
      Characteristic.TemperatureDisplayUnits,
      this.deviceStatus.control.display_temperature_unit === 'c' ? 0 : 1,
    );

    // Update water level characteristics based on service type
    if (this.waterLevelType === 'leak') {
      this.waterLevelService.updateCharacteristic(
        Characteristic.LeakDetected,
        this.deviceStatus.status.is_water_low ?
          Characteristic.LeakDetected.LEAK_DETECTED :
          Characteristic.LeakDetected.LEAK_NOT_DETECTED,
      );
    } else if (this.waterLevelType === 'motion') {
      this.waterLevelService.updateCharacteristic(
        Characteristic.MotionDetected,
        this.deviceStatus.status.is_water_low,
      );
    } else {
      // Battery service
      this.waterLevelService.updateCharacteristic(
        Characteristic.StatusLowBattery,
        this.deviceStatus.status.is_water_low ?
          Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW :
          Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );

      this.waterLevelService.updateCharacteristic(
        Characteristic.BatteryLevel,
        this.deviceStatus.status.water_level,
      );
    }

    this.logWaterLevelChanges();

    // Log the state update if needed
    const state = this.deviceStatus.control.thermal_control_status;
    const temp = this.deviceStatus.control.set_temperature_f;
    const waterLevel = this.deviceStatus.status.water_level;

    this.platform.log.debug(
      `${this.accessory.displayName}: Updated HomeKit - State: ${state.toUpperCase()}, Temp: ${temp}°F, Water: ${waterLevel}%`,
    );
  }

  /**
   * Records water level history at info level, so the Homebridge log preserves
   * low-water events without needing debug logging enabled.
   *
   * `is_water_low` is the flag that actually drives the leak/motion sensor, so
   * every transition is logged. The percentage is logged only when it changes,
   * which stays silent for the common case of a tank that reads a steady 100%.
   */
  private logWaterLevelChanges(): void {
    if (!this.deviceStatus) {
      return;
    }

    const waterLevel = this.deviceStatus.status.water_level;
    const isWaterLow = this.deviceStatus.status.is_water_low;

    if (this.previousIsWaterLow === null) {
      this.platform.log.info(
        `${this.accessory.displayName}: Water level ${waterLevel}% at startup, low water flag is ${isWaterLow}`,
      );
    } else {
      if (isWaterLow !== this.previousIsWaterLow) {
        if (isWaterLow) {
          this.platform.log.warn(`${this.accessory.displayName}: LOW WATER detected (level ${waterLevel}%)`);
        } else {
          this.platform.log.info(`${this.accessory.displayName}: Low water cleared (level ${waterLevel}%)`);
        }
      }
      if (waterLevel !== this.previousWaterLevel) {
        this.platform.log.info(
          `${this.accessory.displayName}: Water level changed ` +
          `${this.previousWaterLevel}% -> ${waterLevel}% (low water flag is ${isWaterLow})`,
        );
      }
    }

    this.previousWaterLevel = waterLevel;
    this.previousIsWaterLow = isWaterLow;
  }
}