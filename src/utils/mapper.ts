// filename: src/utils/mapper.ts
import {DeviceStatus} from '../sleepme/client.js';
import {SleepmePlatform} from '../platform.js';

/**
 * Interface for mapping device data to HomeKit values
 */
export interface Mapper {
  toHeatingCoolingState: (status: DeviceStatus) => 0 | 1 | 2;
}

/**
 * Creates a new mapper for converting Sleepme data to HomeKit values
 */
export function newMapper(platform: SleepmePlatform): Mapper {
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