// filename: src/testSupport.ts
//
// Shared doubles for the unit tests. Homebridge's Service and Characteristic are
// opaque runtime objects, so these stand in for just the surface the plugin uses:
// characteristics are identified by name, and handler registrations plus
// characteristic writes are recorded so tests can assert on them.
//
// Excluded from the published build by tsconfig.build.json.

import {DeviceStatus} from './sleepme/client.js';

export type LogEntry = [level: string, message: string];

export interface RecordingLog {
  (message: string, ...parameters: unknown[]): void;
  info: (message: string, ...parameters: unknown[]) => void;
  warn: (message: string, ...parameters: unknown[]) => void;
  error: (message: string, ...parameters: unknown[]) => void;
  debug: (message: string, ...parameters: unknown[]) => void;
  success: (message: string, ...parameters: unknown[]) => void;
  entries: LogEntry[];
}

export function recordingLog(): RecordingLog {
  const entries: LogEntry[] = [];
  const format = (message: string, parameters: unknown[]) =>
    [message, ...parameters.map(String)].join(' ');

  const log = ((message: string, ...parameters: unknown[]) => {
    entries.push(['info', format(message, parameters)]);
  }) as RecordingLog;

  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    log[level] = (message: string, ...parameters: unknown[]) => {
      entries.push([level, format(message, parameters)]);
    };
  }
  log.success = log.info;
  log.entries = entries;
  return log;
}

export const messagesAt = (log: RecordingLog, ...levels: string[]): string[] =>
  log.entries.filter(([level]) => levels.includes(level)).map(([, message]) => message);

/**
 * A characteristic key that stringifies to its own name so it can be used as a map
 * key, while still carrying HomeKit's numeric constants (OFF, LEAK_DETECTED, ...).
 */
const characteristicKey = (name: string, constants: Record<string, number> = {}) =>
  Object.assign(new String(name), constants);

export const Service = new Proxy({}, {get: (_target, key) => String(key)}) as never;

export const Characteristic = {
  Name: characteristicKey('Name'),
  Manufacturer: characteristicKey('Manufacturer'),
  Model: characteristicKey('Model'),
  SerialNumber: characteristicKey('SerialNumber'),
  FirmwareRevision: characteristicKey('FirmwareRevision'),
  LeakDetected: characteristicKey('LeakDetected', {LEAK_DETECTED: 1, LEAK_NOT_DETECTED: 0}),
  MotionDetected: characteristicKey('MotionDetected'),
  StatusLowBattery: characteristicKey('StatusLowBattery', {BATTERY_LEVEL_LOW: 1, BATTERY_LEVEL_NORMAL: 0}),
  BatteryLevel: characteristicKey('BatteryLevel'),
  CurrentHeatingCoolingState: characteristicKey('CurrentHeatingCoolingState', {OFF: 0, HEAT: 1, COOL: 2}),
  TargetHeatingCoolingState: characteristicKey('TargetHeatingCoolingState', {OFF: 0, HEAT: 1, COOL: 2, AUTO: 3}),
  CurrentTemperature: characteristicKey('CurrentTemperature'),
  TargetTemperature: characteristicKey('TargetTemperature'),
  TemperatureDisplayUnits: characteristicKey('TemperatureDisplayUnits'),
} as never;

export type Handler = (value: never) => unknown | Promise<unknown>;

export interface FakeAccessory {
  displayName: string;
  UUID?: string;
  context: Record<string, unknown>;
  getService: (type: unknown) => unknown;
  addService: (type: unknown, name?: string) => unknown;
  removeService: (service: unknown) => void;
  /** onSet handlers, keyed by characteristic name. */
  setters: Record<string, Handler>;
  /** onGet handlers, keyed by characteristic name. */
  getters: Record<string, Handler>;
  /** Every updateCharacteristic call, in order. */
  published: Array<[name: string, value: unknown]>;
  /** Names of the services currently present. */
  serviceNames: () => string[];
}

export function fakeAccessory(displayName = 'Dock', context: Record<string, unknown> = {}): FakeAccessory {
  const setters: Record<string, Handler> = {};
  const getters: Record<string, Handler> = {};
  const published: Array<[string, unknown]> = [];

  const makeService = () => ({
    getCharacteristic(name: unknown) {
      const characteristic = {
        onGet(handler: Handler) {
          getters[String(name)] = handler;
          return characteristic;
        },
        onSet(handler: Handler) {
          setters[String(name)] = handler;
          return characteristic;
        },
        setProps() {
          return characteristic;
        },
      };
      return characteristic;
    },
    setCharacteristic() {
      return this;
    },
    updateCharacteristic(name: unknown, value: unknown) {
      published.push([String(name), value]);
      return this;
    },
  });

  // AccessoryInformation always exists; the plugin asserts it non-null.
  const services = new Map<string, unknown>([['AccessoryInformation', makeService()]]);

  return {
    displayName,
    context: {apiKey: 'token', device: {id: 'device-1', name: displayName}, ...context},
    getService: (type: unknown) => services.get(String(type)),
    addService: (type: unknown) => {
      const service = makeService();
      services.set(String(type), service);
      return service;
    },
    removeService: (service: unknown) => {
      for (const [name, existing] of services) {
        if (existing === service) {
          services.delete(name);
        }
      }
    },
    setters,
    getters,
    published,
    serviceNames: () => [...services.keys()].filter(name => name !== 'AccessoryInformation'),
  };
}

/** A Dock Pro status payload shaped exactly like the live API response. */
export function dockProStatus(control: Partial<DeviceStatus['control']> = {},
  deviceStatus: Partial<DeviceStatus['status']> = {}): DeviceStatus {
  return {
    about: {
      firmware_version: '5.39.2134',
      ip_address: '10.0.1.178',
      lan_address: '10.0.1.178',
      mac_address: '2c:bc:bb:03:5d:a8',
      model: 'DP999NA',
      serial_number: '32409070055',
    },
    control: {
      brightness_level: 100,
      display_temperature_unit: 'f',
      set_temperature_c: 21,
      set_temperature_f: 70,
      thermal_control_status: 'standby',
      time_zone: 'America/New_York',
      ...control,
    },
    status: {
      is_connected: true,
      is_water_low: false,
      water_level: 100,
      water_temperature_f: 70,
      water_temperature_c: 21,
      ...deviceStatus,
    },
  };
}
