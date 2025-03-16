// filename: src/services/thermostatService.ts
import {CharacteristicValue, Logging, PlatformAccessory, Service} from 'homebridge';
import {Client, DeviceStatus} from '../sleepme/client.js';
import {HIGH_TEMP_TARGET_F, LOW_TEMP_TARGET_F, HIGH_TEMP_THRESHOLD_F, LOW_TEMP_THRESHOLD_F, SleepmeContext} from '../types/index.js';
import {Option} from '../utils/option.js';
import {Mapper} from '../utils/mapper.js';
import {RetryService} from './retry.js';

/**
 * Manages the thermostat service for Sleepme devices
 */
export class ThermostatService {
  private service: Service;
  private expectedThermalState: 'standby' | 'active' | null = null;
  private previousHeatingCoolingState: number | null = null;

  constructor(
    private readonly accessory: PlatformAccessory,
    private readonly log: Logging,
    private readonly platformCharacteristic: any,
    private readonly platformService: typeof Service,
    private readonly retryService: RetryService,
    private readonly mapper: Mapper,
    private readonly onStateChange: (isActive: boolean) => void
  ) {
    this.service = this.setupService();
  }

  /**
   * Sets up the thermostat service
   */
  private setupService(): Service {
    return this.accessory.getService(this.platformService.Thermostat) ||
      this.accessory.addService(this.platformService.Thermostat, `${this.accessory.displayName} - Dock Pro`);
  }

  /**
   * Initializes the service characteristics
   */
  initializeCharacteristics(client: Client, deviceStatus: DeviceStatus | null): void {
    const {platformCharacteristic} = this;
    const {device} = this.accessory.context as SleepmeContext;

    this.service.getCharacteristic(platformCharacteristic.CurrentHeatingCoolingState)
      .onGet(() => new Option(deviceStatus)
        .map(ds => this.mapper.toHeatingCoolingState(ds))
        .orElse(0));

    this.service.getCharacteristic(platformCharacteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          platformCharacteristic.TargetHeatingCoolingState.OFF,  // 0
          platformCharacteristic.TargetHeatingCoolingState.AUTO  // 3
        ]
      })
      .onGet(() => new Option(deviceStatus)
        .map(ds => ds.control.thermal_control_status === 'standby' ? 
          platformCharacteristic.TargetHeatingCoolingState.OFF : 
          platformCharacteristic.TargetHeatingCoolingState.AUTO)
        .orElse(platformCharacteristic.TargetHeatingCoolingState.OFF))
      .onSet(async (value: CharacteristicValue) => {
        const targetState = (value === platformCharacteristic.TargetHeatingCoolingState.OFF) ? 'standby' : 'active';
        this.log.info(`${this.accessory.displayName}: HomeKit state changed to ${targetState}`);
        
        // Store the expected state
        this.expectedThermalState = targetState;
        
        // Optimistically update the local state first for immediate HomeKit feedback
        if (deviceStatus) {
          deviceStatus.control.thermal_control_status = targetState;
          
          // Notify of state change - this will trigger polling interval update
          this.onStateChange(targetState === 'active');
        }
        
        // Then actually send the command to the API with retry support
        const setThermalControlOperation = () => client.setThermalControlStatus(device.id, targetState);
        
        try {
          const response = await this.retryService.retryApiCall(
            setThermalControlOperation,
            "set thermal control status"
          );
          
          const responseState = response.data.thermal_control_status;
          
          // Check if the response state matches the expected state
          if (responseState !== targetState && this.expectedThermalState === targetState) {
            // State mismatch detected - handle it with multiple retries
            const controlData = await this.retryService.handleStateMismatch(
              client, 
              device, 
              targetState, 
              responseState,
              deviceStatus?.control || null
            );
            return controlData;
          } else {
            this.expectedThermalState = null; // Reset expected state since it matches
            return response.data;
          }
        } catch (error) {
          this.log.error(`${this.accessory.displayName}: Failed to set thermal control state after retries: ${error instanceof Error ? error.message : String(error)}`);
          
          // If the API fails, revert our optimistic update by getting the actual device status
          try {
            const statusResponse = await client.getDeviceStatus(device.id);
            this.expectedThermalState = null; // Clear the expected state
            
            // Notify of the actual state - this will trigger polling interval update
            this.onStateChange(statusResponse.data.control.thermal_control_status === 'active');
            
            return statusResponse.data.control;
          } catch (refreshError) {
            this.log.error(`${this.accessory.displayName}: Failed to refresh status after error: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
            throw refreshError;
          }
        }
      });

    this.service.getCharacteristic(platformCharacteristic.CurrentTemperature)
      .onGet(() => new Option(deviceStatus)
        .map(ds => ds.status.water_temperature_c)
        .orElse(21));

    this.service.getCharacteristic(platformCharacteristic.TargetTemperature)
      .setProps({
        minValue: 12,
        maxValue: 46.7,
        minStep: 0.5
      })
      .onGet(() => new Option(deviceStatus)
        .map(ds => {
          // Handle both high and low special temperature cases
          if (ds.control.set_temperature_f >= HIGH_TEMP_TARGET_F) {
            return 46.7; // Maximum allowed Celsius temperature
          } else if (ds.control.set_temperature_f <= LOW_TEMP_TARGET_F) {
            return 12.2; // 54°F in Celsius
          }
          return ds.control.set_temperature_c;
        })
        .orElse(21))
      .onSet(async (value: CharacteristicValue) => {
        const tempC = value as number;
        let tempF = (tempC * (9 / 5)) + 32;
        
        // Round to nearest whole number for API call
        tempF = Math.round(tempF);
        
        // Optimistically update the local state first for immediate HomeKit feedback
        if (deviceStatus) {
          // Update the local temperature values
          deviceStatus.control.set_temperature_c = tempC;
          deviceStatus.control.set_temperature_f = tempF;
          
          // Handle special temperature cases
          let apiTemp = tempF;
          if (tempF > HIGH_TEMP_THRESHOLD_F) {
            this.log.info(`${this.accessory.displayName}: Temperature over ${HIGH_TEMP_THRESHOLD_F}F, mapping to ${HIGH_TEMP_TARGET_F}F for API call`);
            apiTemp = HIGH_TEMP_TARGET_F;
          } else if (tempF < LOW_TEMP_THRESHOLD_F) {
            this.log.info(`${this.accessory.displayName}: Temperature under ${LOW_TEMP_THRESHOLD_F}F, mapping to ${LOW_TEMP_TARGET_F}F for API call`);
            apiTemp = LOW_TEMP_TARGET_F;
          } else {
            this.log.info(`${this.accessory.displayName}: Setting temperature to: ${tempC}°C (${tempF}°F)`);
          }
          
          // Create the API operation function with the correct temperature
          const setTemperatureOperation = () => client.setTemperatureFahrenheit(device.id, apiTemp);
          
          try {
            // Call the API with retry support
            await this.retryService.retryApiCall(
              setTemperatureOperation,
              "set temperature"
            );
            
            // Get the full updated status after successful temperature change
            const statusResponse = await client.getDeviceStatus(device.id);
            return statusResponse.data.control;
          } catch (error) {
            this.log.error(`${this.accessory.displayName}: Failed to set temperature after retries: ${error instanceof Error ? error.message : String(error)}`);
            
            // If the API fails after all retries, refresh the status to get the actual state
            try {
              const statusResponse = await client.getDeviceStatus(device.id);
              return statusResponse.data.control;
            } catch (refreshError) {
              this.log.error(`${this.accessory.displayName}: Failed to refresh status after error: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
              throw refreshError;
            }
          }
        }
        
        return null;
      });

    this.service.getCharacteristic(platformCharacteristic.TemperatureDisplayUnits)
      .onGet(() => new Option(deviceStatus)
        .map(ds => ds.control.display_temperature_unit === 'c' ? 0 : 1)
        .orElse(1));
  }

  /**
   * Updates the service with current device status
   */
  updateCharacteristics(deviceStatus: DeviceStatus): void {
    const {platformCharacteristic} = this;
    const currentState = this.mapper.toHeatingCoolingState(deviceStatus);
    
    // Update thermostat characteristics
    this.service.updateCharacteristic(
      platformCharacteristic.TemperatureDisplayUnits, 
      deviceStatus.control.display_temperature_unit === 'c' ? 0 : 1
    );
    
    this.service.updateCharacteristic(
      platformCharacteristic.CurrentHeatingCoolingState, 
      currentState
    );
    
    this.service.updateCharacteristic(
      platformCharacteristic.TargetHeatingCoolingState, 
      deviceStatus.control.thermal_control_status === 'standby' ? 
        platformCharacteristic.TargetHeatingCoolingState.OFF : 
        platformCharacteristic.TargetHeatingCoolingState.AUTO
    );
    
    // Update current temperature
    this.service.updateCharacteristic(
      platformCharacteristic.CurrentTemperature, 
      deviceStatus.status.water_temperature_c
    );

    // Handle special temperature cases for target temp
    let displayTempC = deviceStatus.control.set_temperature_c;
    const targetTempF = deviceStatus.control.set_temperature_f;
    
    if (targetTempF >= HIGH_TEMP_TARGET_F) {
      displayTempC = 46.7;
    } else if (targetTempF <= LOW_TEMP_TARGET_F) {
      displayTempC = 12.2; // 54°F in Celsius
    }
    
    // Update target temperature
    this.service.updateCharacteristic(
      platformCharacteristic.TargetTemperature, 
      displayTempC
    );
    
    // Only notify if the state changes between OFF and ON (HEAT/COOL)
    if (this.previousHeatingCoolingState !== currentState) {
      const wasOff = this.previousHeatingCoolingState === 0;
      const isOff = currentState === 0;
      
      if (wasOff || isOff) {
        // If state changed, notify parent
        if (this.previousHeatingCoolingState !== null) {
          this.onStateChange(!isOff);
        }
      }
      
      this.previousHeatingCoolingState = currentState;
    }
  }

  /**
   * Gets the current active state of the device
   */
  isDeviceActive(deviceStatus: DeviceStatus | null): boolean {
    if (!deviceStatus) {
      return false;
    }
    return deviceStatus.control.thermal_control_status === 'active';
  }

  /**
   * Sets the expected thermal state (for state mismatch handling)
   */
  setExpectedThermalState(state: 'standby' | 'active' | null): void {
    this.expectedThermalState = state;
  }

  /**
   * Gets the expected thermal state (for state mismatch handling)
   */
  getExpectedThermalState(): 'standby' | 'active' | null {
    return this.expectedThermalState;
  }
}