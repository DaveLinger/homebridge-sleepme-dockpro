// filename: src/services/waterLevelService.ts
import {Characteristic, Logging, PlatformAccessory, Service} from 'homebridge';
import {DeviceStatus} from '../sleepme/client.js';
import {Option} from '../utils/option.js';

/**
 * Manages the water level service for Sleepme devices
 */
export class WaterLevelService {
  private service: Service;
  private readonly type: 'battery' | 'leak' | 'motion';

  constructor(
    private readonly accessory: PlatformAccessory,
    private readonly log: Logging,
    private readonly platformCharacteristic: typeof Characteristic,
    private readonly platformService: typeof Service,
    type: 'battery' | 'leak' | 'motion' = 'battery'
  ) {
    this.type = type;
    this.service = this.setupService();
  }

  /**
   * Sets up the appropriate service based on configuration
   */
  private setupService(): Service {
    // Remove any existing water level services first
    const existingBatteryService = this.accessory.getService(this.platformService.Battery);
    const existingLeakService = this.accessory.getService(this.platformService.LeakSensor);
    const existingMotionService = this.accessory.getService(this.platformService.MotionSensor);
    
    if (existingBatteryService) {
      this.log.debug('Removing existing battery service');
      this.accessory.removeService(existingBatteryService);
    }
    if (existingLeakService) {
      this.log.debug('Removing existing leak service');
      this.accessory.removeService(existingLeakService);
    }
    if (existingMotionService) {
      this.log.debug('Removing existing motion service');
      this.accessory.removeService(existingMotionService);
    }

    // Add the appropriate water level service based on configuration
    this.log.debug(`Creating new water level service of type: ${this.type}`);
    if (this.type === 'leak') {
      return this.accessory.addService(
        this.platformService.LeakSensor,
        `${this.accessory.displayName} - Water Level`
      );
    } else if (this.type === 'motion') {
      return this.accessory.addService(
        this.platformService.MotionSensor,
        `${this.accessory.displayName} - Water Level`
      );
    } else {
      return this.accessory.addService(
        this.platformService.Battery,
        `${this.accessory.displayName} - Water Level`
      );
    }
  }

  /**
   * Initializes the service characteristics
   */
  initializeCharacteristics(deviceStatus: DeviceStatus | null): void {
    const {platformCharacteristic} = this;

    if (this.type === 'leak') {
      this.service.getCharacteristic(platformCharacteristic.LeakDetected)
        .onGet(() => new Option(deviceStatus)
          .map(ds => ds.status.is_water_low ? 
            platformCharacteristic.LeakDetected.LEAK_DETECTED : 
            platformCharacteristic.LeakDetected.LEAK_NOT_DETECTED)
          .orElse(platformCharacteristic.LeakDetected.LEAK_NOT_DETECTED));
    } else if (this.type === 'motion') {
      this.service.getCharacteristic(platformCharacteristic.MotionDetected)
        .onGet(() => new Option(deviceStatus)
          .map(ds => ds.status.is_water_low)
          .orElse(false));
    } else {
      this.service.getCharacteristic(platformCharacteristic.StatusLowBattery)
        .onGet(() => new Option(deviceStatus)
          .map(ds => ds.status.is_water_low)
          .orElse(false));

      this.service.getCharacteristic(platformCharacteristic.BatteryLevel)
        .onGet(() => new Option(deviceStatus)
          .map(ds => ds.status.water_level)
          .orElse(50));
    }
  }

  /**
   * Updates the service with current device status
   */
  updateCharacteristics(deviceStatus: DeviceStatus): void {
    const {platformCharacteristic} = this;

    if (this.type === 'leak') {
      this.service.updateCharacteristic(
        platformCharacteristic.LeakDetected,
        deviceStatus.status.is_water_low ?
          platformCharacteristic.LeakDetected.LEAK_DETECTED : 
          platformCharacteristic.LeakDetected.LEAK_NOT_DETECTED
      );
    } else if (this.type === 'motion') {
      this.service.updateCharacteristic(
        platformCharacteristic.MotionDetected,
        deviceStatus.status.is_water_low
      );
    } else {
      this.service.updateCharacteristic(
        platformCharacteristic.BatteryLevel, 
        deviceStatus.status.water_level
      );
      this.service.updateCharacteristic(
        platformCharacteristic.StatusLowBattery, 
        deviceStatus.status.is_water_low
      );
    }
  }
}