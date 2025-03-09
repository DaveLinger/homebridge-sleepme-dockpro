import {CharacteristicValue, PlatformAccessory, Service} from 'homebridge';

import {SleepmePlatform} from './platform.js';
import {Client, Control, Device, DeviceStatus} from './sleepme/client.js';
import {ApiQueueManager, RequestCallback} from './apiQueueManager.js';

type SleepmeContext = {
  device: Device;
  apiKey: string;
};

interface PlatformConfig {
  water_level_type?: 'battery' | 'leak' | 'motion';
  slow_polling_interval_minutes?: number;
  api_request_interval_ms?: number;
  max_api_retries?: number;
  api_retry_backoff_ms?: number;
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

  orElse<T>(elseValue: T): T {
    if (!this.value) {
      return elseValue;
    }
    return this.value as unknown as T;
  }
}

const FAST_POLLING_INTERVAL_MS = 15 * 1000;
const DEFAULT_SLOW_POLLING_INTERVAL_MINUTES = 15;
const POLLING_RECENCY_THRESHOLD_MS = 60 * 1000;
const HIGH_TEMP_THRESHOLD_F = 115;
const HIGH_TEMP_TARGET_F = 999;
const LOW_TEMP_THRESHOLD_F = 55;
const LOW_TEMP_TARGET_F = -1;
const DEFAULT_API_REQUEST_INTERVAL_MS = 1000; // 1 second minimum between API requests
const DEFAULT_MAX_API_RETRIES = 3;
const DEFAULT_API_RETRY_BACKOFF_MS = 5000; // 5 seconds

export class SleepmePlatformAccessory {
  private thermostatService: Service;
  private waterLevelService: Service;
  private deviceStatus: DeviceStatus | null;
  private lastInteractionTime: Date;
  private timeout: NodeJS.Timeout | undefined;
  private readonly waterLevelType: 'battery' | 'leak' | 'motion';
  private readonly slowPollingIntervalMs: number;
  private readonly apiQueueManager: ApiQueueManager;
  private previousHeatingCoolingState: number | null = null;

  constructor(
    private readonly platform: SleepmePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.lastInteractionTime = new Date();
    const {Characteristic, Service} = this.platform;
    const {apiKey, device} = this.accessory.context as SleepmeContext;
    const client = new Client(apiKey);
    this.deviceStatus = null;

    // Get configuration
    const config = this.platform.config as PlatformConfig;
    this.waterLevelType = config.water_level_type || 'battery';
    
    // Set up polling interval from config or use default
    const configuredMinutes = config.slow_polling_interval_minutes;
    if (configuredMinutes !== undefined) {
      if (configuredMinutes < 1) {
        this.platform.log.warn('Slow polling interval must be at least 1 minute. Using 1 minute.');
        this.slowPollingIntervalMs = 60 * 1000;
      } else {
        this.slowPollingIntervalMs = configuredMinutes * 60 * 1000;
        this.platform.log.debug(`Using configured slow polling interval of ${configuredMinutes} minutes`);
      }
    } else {
      this.slowPollingIntervalMs = DEFAULT_SLOW_POLLING_INTERVAL_MINUTES * 60 * 1000;
      this.platform.log.debug(`Using default slow polling interval of ${DEFAULT_SLOW_POLLING_INTERVAL_MINUTES} minutes`);
    }

    // Set up API queue manager
    const apiRequestInterval = config.api_request_interval_ms || DEFAULT_API_REQUEST_INTERVAL_MS;
    const maxApiRetries = config.max_api_retries || DEFAULT_MAX_API_RETRIES;
    const apiRetryBackoff = config.api_retry_backoff_ms || DEFAULT_API_RETRY_BACKOFF_MS;
    
    this.apiQueueManager = new ApiQueueManager(
      client,
      this.platform.log,
      apiRequestInterval,
      maxApiRetries,
      apiRetryBackoff
    );

    // Debug log the configuration
    this.platform.log.debug('Configuration:', JSON.stringify(config));
    this.platform.log.debug(`Water level type configured as: ${this.waterLevelType}`);
    this.platform.log.debug(`API request interval: ${apiRequestInterval}ms`);
    this.platform.log.debug(`Max API retries: ${maxApiRetries}`);
    this.platform.log.debug(`API retry backoff: ${apiRetryBackoff}ms`);

    // Initialize service bindings first
    this.thermostatService = this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat, `${this.accessory.displayName} - Dock Pro`);

    // Remove any existing water level services first
    const existingBatteryService = this.accessory.getService(this.platform.Service.Battery);
    const existingLeakService = this.accessory.getService(this.platform.Service.LeakSensor);
    const existingMotionService = this.accessory.getService(this.platform.Service.MotionSensor);
    const existingHighModeService = this.accessory.getService('High Mode');
    const existingBoostService = this.accessory.getService('Temperature Boost');
    
    // Debug existing services
    this.platform.log.debug(`Existing services before removal:
      Battery: ${!!existingBatteryService}
      Leak: ${!!existingLeakService}
      Motion: ${!!existingMotionService}`);
    
    if (existingBatteryService) {
      this.platform.log.debug('Removing existing battery service');
      this.accessory.removeService(existingBatteryService);
    }
    if (existingLeakService) {
      this.platform.log.debug('Removing existing leak service');
      this.accessory.removeService(existingLeakService);
    }
    if (existingMotionService) {
      this.platform.log.debug('Removing existing motion service');
      this.accessory.removeService(existingMotionService);
    }
    if (existingHighModeService) {
      this.platform.log.debug('Removing existing high mode service');
      this.accessory.removeService(existingHighModeService);
    }
    if (existingBoostService) {
      this.platform.log.debug('Removing existing temperature boost service');
      this.accessory.removeService(existingBoostService);
    }

    // Add the appropriate water level service based on configuration
    this.platform.log.debug(`Creating new water level service of type: ${this.waterLevelType}`);
    if (this.waterLevelType === 'leak') {
      this.waterLevelService = this.accessory.addService(
        this.platform.Service.LeakSensor,
        `${this.accessory.displayName} - Water Level`
      );
    } else if (this.waterLevelType === 'motion') {
      this.waterLevelService = this.accessory.addService(
        this.platform.Service.MotionSensor,
        `${this.accessory.displayName} - Water Level`
      );
    } else {
      this.waterLevelService = this.accessory.addService(
        this.platform.Service.Battery,
        `${this.accessory.displayName} - Water Level`
      );
    }

    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Sleepme')
      .setCharacteristic(Characteristic.Model, 'Dock Pro')
      .setCharacteristic(Characteristic.SerialNumber, device.id);

    // Initialize all characteristic handlers after services are created
    this.initializeCharacteristics(device);

    // Get initial device status
    this.enqueueGetDeviceStatus(device.id);

    // Set up polling
    this.scheduleNextCheck(device.id);
  }

  private initializeCharacteristics(device: Device) {
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
          .map(ds => ds.status.is_water_low)
          .orElse(false));

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
          Characteristic.TargetHeatingCoolingState.OFF,  // 0
          Characteristic.TargetHeatingCoolingState.AUTO  // 3
        ]
      })
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.control.thermal_control_status === 'standby' ? 
          Characteristic.TargetHeatingCoolingState.OFF : 
          Characteristic.TargetHeatingCoolingState.AUTO)
        .orElse(Characteristic.TargetHeatingCoolingState.OFF))
      .onSet(async (value: CharacteristicValue) => {
        const targetState = (value === Characteristic.TargetHeatingCoolingState.OFF) ? 'standby' : 'active';
        this.platform.log(`Setting TargetHeatingCoolingState for ${this.accessory.displayName} to ${targetState} (${value})`);
        
        // Immediately update UI, then enqueue the actual API request
        if (this.deviceStatus) {
          this.deviceStatus.control.thermal_control_status = targetState;
          this.publishUpdates();
        }
        
        this.lastInteractionTime = new Date();
        this.enqueueSetThermalControlStatus(device.id, targetState);
      });

    this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.status.water_temperature_c)
        .orElse(-270));

    this.thermostatService.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: 12,
        maxValue: 46.7,
        minStep: 0.5
      })
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => {
          // Handle both high and low special temperature cases
          if (ds.control.set_temperature_f >= HIGH_TEMP_TARGET_F) {
            return 46.7; // Maximum allowed Celsius temperature
          } else if (ds.control.set_temperature_f <= LOW_TEMP_TARGET_F) {
            return 12.2; // 54°F in Celsius
          }
          const tempC = ds.control.set_temperature_c;
          const tempF = (tempC * (9/5)) + 32;
          this.platform.log.debug(`Current target temperature: ${tempC}°C (${tempF.toFixed(1)}°F)`);
          return tempC;
        })
        .orElse(21))
      .onSet(async (value: CharacteristicValue) => {
        const tempC = value as number;
        let tempF = (tempC * (9 / 5)) + 32;
        
        // Round to nearest whole number for API call
        tempF = Math.round(tempF);
        
        // Update UI immediately
        if (this.deviceStatus) {
          this.deviceStatus.control.set_temperature_c = tempC;
          this.deviceStatus.control.set_temperature_f = tempF;
          this.publishUpdates();
        }
        
        this.lastInteractionTime = new Date();
        
        // Map temperatures over threshold to HIGH_TEMP_TARGET_F
        // and under threshold to LOW_TEMP_TARGET_F
        if (tempF > HIGH_TEMP_THRESHOLD_F) {
          this.platform.log(`Temperature over ${HIGH_TEMP_THRESHOLD_F}F, mapping to ${HIGH_TEMP_TARGET_F}F for API call`);
          this.enqueueSetTemperatureFahrenheit(device.id, HIGH_TEMP_TARGET_F);
        } else if (tempF < LOW_TEMP_THRESHOLD_F) {
          this.platform.log(`Temperature under ${LOW_TEMP_THRESHOLD_F}F, mapping to ${LOW_TEMP_TARGET_F}F for API call`);
          this.enqueueSetTemperatureFahrenheit(device.id, LOW_TEMP_TARGET_F);
        } else {
          this.platform.log(`Setting temperature to: ${tempC}°C (${tempF}°F)`);
          this.enqueueSetTemperatureFahrenheit(device.id, tempF);
        }
      });

    this.thermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => new Option(this.deviceStatus)
        .map(ds => ds.control.display_temperature_unit === 'c' ? 0 : 1)
        .orElse(1));
  }

  private scheduleNextCheck(deviceId: string) {
    const timeSinceLastInteractionMS = new Date().valueOf() - this.lastInteractionTime.valueOf();
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.platform.log.debug(`Polling at: ${new Date()}`);
      this.platform.log.debug(`Last interaction at: ${this.lastInteractionTime}`);
      
      this.enqueueGetDeviceStatus(deviceId);
      this.scheduleNextCheck(deviceId);
    }, timeSinceLastInteractionMS < POLLING_RECENCY_THRESHOLD_MS ? FAST_POLLING_INTERVAL_MS : this.slowPollingIntervalMs);
  }

  // API Queue Methods
  private enqueueGetDeviceStatus(deviceId: string) {
    const callback: RequestCallback = (result) => {
      if (result.success && result.data && 'status' in result.data) {
        this.deviceStatus = result.data as DeviceStatus;
        this.publishUpdates();
      } else if (!result.success) {
        this.platform.log.error(`Failed to get device status: ${result.error?.message || 'Unknown error'}`);
      }
    };
    
    this.apiQueueManager.enqueue(deviceId, 'getDeviceStatus', [], callback);
  }
  
  private enqueueSetTemperatureFahrenheit(deviceId: string, temperature: number) {
    const callback: RequestCallback = (result) => {
      if (result.success && result.data) {
        if (this.deviceStatus) {
          this.deviceStatus.control = result.data as Control;
          this.publishUpdates();
        }
      } else if (!result.success) {
        this.platform.log.error(`Failed to set temperature: ${result.error?.message || 'Unknown error'}`);
        this.enqueueGetDeviceStatus(deviceId); // Get current state if update failed
      }
    };
    
    this.apiQueueManager.enqueue(deviceId, 'setTemperatureFahrenheit', [temperature], callback);
  }
  
  private enqueueSetThermalControlStatus(deviceId: string, status: 'standby' | 'active') {
    const callback: RequestCallback = (result) => {
      if (result.success && result.data) {
        if (this.deviceStatus) {
          this.deviceStatus.control = result.data as Control;
          this.publishUpdates();
        }
      } else if (!result.success) {
        this.platform.log.error(`Failed to set thermal control status: ${result.error?.message || 'Unknown error'}`);
        this.enqueueGetDeviceStatus(deviceId); // Get current state if update failed
      }
    };
    
    this.apiQueueManager.enqueue(deviceId, 'setThermalControlStatus', [status], callback);
  }

  private publishUpdates() {
    const s = this.deviceStatus;
    if (!s) {
      return;
    }

    const {Characteristic} = this.platform;
    const mapper = newMapper(this.platform);
    
    const currentState = mapper.toHeatingCoolingState(s);
    
    // Update water level service based on type
    if (this.waterLevelType === 'leak') {
      this.waterLevelService.updateCharacteristic(
        Characteristic.LeakDetected,
        s.status.is_water_low ?
          Characteristic.LeakDetected.LEAK_DETECTED : 
          Characteristic.LeakDetected.LEAK_NOT_DETECTED
      );
    } else if (this.waterLevelType === 'motion') {
      this.waterLevelService.updateCharacteristic(
        Characteristic.MotionDetected,
        s.status.is_water_low
      );
    } else {
      this.waterLevelService.updateCharacteristic(Characteristic.BatteryLevel, s.status.water_level);
      this.waterLevelService.updateCharacteristic(Characteristic.StatusLowBattery, s.status.is_water_low);
    }

    // Update thermostat characteristics
    this.thermostatService.updateCharacteristic(Characteristic.TemperatureDisplayUnits, 
      s.control.display_temperature_unit === 'c' ? 0 : 1);
    this.thermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, currentState);
    this.thermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, 
      s.control.thermal_control_status === 'standby' ? 
        Characteristic.TargetHeatingCoolingState.OFF : 
        Characteristic.TargetHeatingCoolingState.AUTO);
    
    // Log current water temperature in both units
    const currentTempC = s.status.water_temperature_c;
    const currentTempF = (currentTempC * (9/5)) + 32;
    this.platform.log.debug(`Current water temperature: ${currentTempC}°C (${currentTempF.toFixed(1)}°F)`);
    this.thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, currentTempC);

    // Handle both high and low temperature special cases
    const targetTempF = s.control.set_temperature_f;
    let displayTempC;
    if (targetTempF >= HIGH_TEMP_TARGET_F) {
      displayTempC = 46.7;
    } else if (targetTempF <= LOW_TEMP_TARGET_F) {
      displayTempC = 12.2; // 54°F in Celsius
    } else {
      displayTempC = s.control.set_temperature_c;
    }
    this.platform.log.debug(`Target temperature: ${displayTempC}°C (${targetTempF}°F)`);
    this.thermostatService.updateCharacteristic(Characteristic.TargetTemperature, displayTempC);
    
    // Only log if the heating/cooling state has changed
    if (this.previousHeatingCoolingState !== currentState) {
      this.platform.log(`Updated heating/cooling state to: ${currentState} (0=OFF, 1=HEAT, 2=COOL)`);
      this.previousHeatingCoolingState = currentState;
    }
    
    // Check if there was an error with the API
    const deviceState = this.apiQueueManager.getDeviceState(this.accessory.context.device.id);
    if (deviceState.lastError) {
      this.platform.log.warn(
        `Device ${this.accessory.displayName} has API error: ${deviceState.lastError.code} - ${deviceState.lastError.message}`
      );
    }
  }
}