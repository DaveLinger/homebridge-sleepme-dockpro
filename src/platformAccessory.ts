// filename: src/platformAccessory.ts
import {PlatformAccessory} from 'homebridge';

import {SleepmePlatform} from './platform.js';
import {Client, DeviceStatus} from './sleepme/client.js';
import {PlatformConfig, SleepmeContext} from './types/index.js';
import {newMapper} from './utils/mapper.js';
import {RetryService} from './services/retry.js';
import {WaterLevelService} from './services/waterLevelService.js';
import {ThermostatService} from './services/thermostatService.js';
import {PollingService} from './services/polling.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory the platform registers
 * Each accessory may expose multiple services of different types.
 */
export class SleepmePlatformAccessory {
  private readonly client: Client;
  private readonly retryService: RetryService;
  private readonly waterLevelService: WaterLevelService;
  private readonly thermostatService: ThermostatService;
  private readonly pollingService: PollingService;
  private deviceStatus: DeviceStatus | null = null;

  constructor(
    private readonly platform: SleepmePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const {Characteristic, Service} = this.platform;
    const {apiKey, device} = this.accessory.context as SleepmeContext;
    
    // Get configuration
    const config = this.platform.config as PlatformConfig;
    const waterLevelType = config.water_level_type || 'battery';
    
    // Initialize services
    this.client = new Client(apiKey, undefined, this.platform.log);
    this.retryService = new RetryService(this.platform.log, this.accessory.displayName);
    
    // Initialize water level service
    this.waterLevelService = new WaterLevelService(
      this.accessory,
      this.platform.log,
      Characteristic,
      Service,
      waterLevelType
    );
    
    // Create a mapper for device data
    const mapper = newMapper(this.platform);
    
    // Initialize thermostat service with state change callback
    this.thermostatService = new ThermostatService(
      this.accessory,
      this.platform.log,
      Characteristic,
      Service,
      this.retryService,
      mapper,
      (isActive: boolean) => this.handleDeviceStateChange(isActive)
    );
    
    // Initialize polling service
    this.pollingService = new PollingService(
      this.platform.log,
      this.accessory.displayName,
      this.retryService,
      {
        activePollingIntervalSeconds: config.active_polling_interval_seconds,
        standbyPollingIntervalMinutes: config.standby_polling_interval_minutes
      }
    );
    
    // Set accessory information
    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Sleepme')
      .setCharacteristic(Characteristic.Model, 'Dock Pro')
      .setCharacteristic(Characteristic.SerialNumber, device.id);
    
    // Initialize characteristics for services
    this.waterLevelService.initializeCharacteristics(this.deviceStatus);
    this.thermostatService.initializeCharacteristics(this.client, this.deviceStatus);
    
    // Get initial device status
    this.client.getDeviceStatus(device.id)
      .then(statusResponse => {
        this.deviceStatus = statusResponse.data;
        this.updateServices();
        
        // Start polling with the initial state
        const isActive = this.deviceStatus.control.thermal_control_status === 'active';
        this.pollingService.startPolling(
          this.client,
          device.id,
          isActive,
          (status: DeviceStatus) => this.handleStatusUpdate(status)
        );
      })
      .catch(error => {
        this.platform.log.error(`Failed to get initial device status for ${this.accessory.displayName}: ${error instanceof Error ? error.message : String(error)}`);
        
        // Still start polling with default inactive state
        this.pollingService.startPolling(
          this.client,
          device.id,
          false,  // Assume inactive initially
          (status: DeviceStatus) => this.handleStatusUpdate(status)
        );
      });
  }
  
  /**
   * Handles device state changes (active/standby)
   */
  private handleDeviceStateChange(isActive: boolean): void {
    this.platform.log.debug(`${this.accessory.displayName}: Device state changed to ${isActive ? 'ACTIVE' : 'STANDBY'}`);
    
    // Update polling interval based on new state
    this.pollingService.updatePollingInterval(isActive);
    
    // Restart polling with the new state
    const {device} = this.accessory.context as SleepmeContext;
    this.pollingService.startPolling(
      this.client,
      device.id,
      isActive,
      (status: DeviceStatus) => this.handleStatusUpdate(status)
    );
  }
  
  /**
   * Handles device status updates from polling
   */
  private handleStatusUpdate(status: DeviceStatus): void {
    // Check if we're waiting for a specific thermal state
    const expectedState = this.thermostatService.getExpectedThermalState();
    
    if (expectedState !== null && status.control.thermal_control_status !== expectedState) {
      this.platform.log.warn(`${this.accessory.displayName}: Device state (${status.control.thermal_control_status}) does not match expected state (${expectedState}) during polling`);
      
      // Don't update HomeKit with the mismatched state - keep the optimistic state
      // But do update everything else
      const savedStatus = {...status};
      savedStatus.control.thermal_control_status = expectedState;
      this.deviceStatus = savedStatus;
    } else {
      // If we had an expected state and it now matches, clear it
      if (expectedState !== null && status.control.thermal_control_status === expectedState) {
        this.platform.log.info(`${this.accessory.displayName}: Device state now matches expected state (${expectedState})`);
        this.thermostatService.setExpectedThermalState(null);
      }
      
      // Normal update path
      this.deviceStatus = status;
    }
    
    // Update HomeKit services
    this.updateServices();
    
    // Log current status
    this.logDeviceStatus();
  }
  
  /**
   * Updates all services with current device status
   */
  private updateServices(): void {
    if (!this.deviceStatus) {
      return;
    }
    
    // Update water level service
    this.waterLevelService.updateCharacteristics(this.deviceStatus);
    
    // Update thermostat service
    this.thermostatService.updateCharacteristics(this.deviceStatus);
  }
  
  /**
   * Logs the current device status
   */
  private logDeviceStatus(): void {
    if (!this.deviceStatus) {
      return;
    }
    
    const s = this.deviceStatus;
    const currentTempC = s.status.water_temperature_c;
    const currentTempF = (currentTempC * (9/5)) + 32;
    const stateDesc = s.control.thermal_control_status === 'standby' ? 'STANDBY' : 'ON';
    
    // Log consolidated temperature information based on state
    if (s.control.thermal_control_status === 'standby') {
      // In standby mode, only show current temperature
      this.platform.log(`${this.accessory.displayName}: [${stateDesc}] ${currentTempC.toFixed(1)}°C (${currentTempF.toFixed(1)}°F)`);
    } else {
      // In active mode, show both current and target temperatures
      const targetTempF = s.control.set_temperature_f;
      const targetTempC = s.control.set_temperature_c;
      this.platform.log(`${this.accessory.displayName}: [${stateDesc}] Current: ${currentTempC.toFixed(1)}°C (${currentTempF.toFixed(1)}°F) → Target: ${targetTempC.toFixed(1)}°C (${targetTempF}°F)`);
    }
  }
}