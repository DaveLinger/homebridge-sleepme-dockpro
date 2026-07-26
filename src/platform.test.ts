import {API, PlatformAccessory} from 'homebridge';
import {SleepmePlatform} from './platform.js';
import {Client, Device, DeviceStatus} from './sleepme/client.js';
import {
  Characteristic,
  RecordingLog,
  Service,
  dockProStatus,
  messagesAt,
  recordingLog,
} from './testSupport.js';

// Discovery constructs real accessory handlers, each owning a polling timer and a
// metrics interval. The platform tracks them for its shutdown hook, so tests lean
// on the same path rather than reaching inside.
const platforms: SleepmePlatform[] = [];
afterEach(() => {
  while (platforms.length) {
    platforms.pop()?.disposeAll();
  }
});

const DOCK_PRO = 'DP999NA';
const SLEEP_TRACKER = 'ST501NA';

const sleepTrackerStatus = (): DeviceStatus => {
  const status = dockProStatus();
  return {
    ...status,
    about: {...status.about, model: SLEEP_TRACKER},
    // The real Sleep Tracker payload has no water or water-temperature fields.
    status: {is_connected: true} as DeviceStatus['status'],
  };
};

interface Harness {
  platform: SleepmePlatform;
  log: RecordingLog;
  registered: string[];
  statusCalls: string[];
}

function harness(devices: Device[], statusByModel: Record<string, DeviceStatus>,
  config: Record<string, unknown> = {}): Harness {
  const log = recordingLog();
  const registered: string[] = [];
  const statusCalls: string[] = [];

  class FakeAccessoryClass {
    displayName: string;
    UUID: string;
    context: Record<string, unknown> = {};
    private services = new Map<string, unknown>();

    constructor(displayName: string, uuid: string) {
      this.displayName = displayName;
      this.UUID = uuid;
      this.services.set('AccessoryInformation', this.makeService());
    }

    private makeService() {
      return {
        getCharacteristic() {
          const characteristic = {
            onGet: () => characteristic,
            onSet: () => characteristic,
            setProps: () => characteristic,
          };
          return characteristic;
        },
        setCharacteristic() {
          return this;
        },
        updateCharacteristic() {
          return this;
        },
      };
    }

    getService(type: unknown) {
      return this.services.get(String(type));
    }

    addService(type: unknown) {
      const service = this.makeService();
      this.services.set(String(type), service);
      return service;
    }

    removeService(service: unknown) {
      for (const [name, existing] of this.services) {
        if (existing === service) {
          this.services.delete(name);
        }
      }
    }
  }

  const api = {
    hap: {
      Service,
      Characteristic,
      uuid: {generate: (input: string) => `uuid-${input}`},
    },
    platformAccessory: FakeAccessoryClass,
    on: () => undefined,
    registerPlatformAccessories: (_plugin: string, _name: string, accessories: PlatformAccessory[]) => {
      registered.push(...accessories.map(accessory => accessory.displayName));
    },
    unregisterPlatformAccessories: () => undefined,
  } as unknown as API;

  const platform = new SleepmePlatform(
    log as never,
    {platform: 'SleepmeDockProHomebridgePlugin', api_keys: ['token'], ...config} as never,
    api,
  );

  // Replace the shared Client with one that serves the fixtures.
  const client = {
    listDevices: async () => ({data: devices, status: 200}),
    getDeviceStatus: async (id: string) => {
      statusCalls.push(id);
      const device = devices.find(candidate => candidate.id === id);
      const model = device?.name.includes('Tracker') ? SLEEP_TRACKER : DOCK_PRO;
      return {data: statusByModel[model], status: 200};
    },
  } as unknown as Client;
  (platform as unknown as {clientFor: () => Client}).clientFor = () => client;

  platforms.push(platform);
  return {platform, log, registered, statusCalls};
}

const flush = () => new Promise(resolve => setTimeout(resolve, 50));

const fixtures = {[DOCK_PRO]: dockProStatus(), [SLEEP_TRACKER]: sleepTrackerStatus()};

describe('device discovery filtering', () => {
  const dock: Device = {id: 'dock-1', name: 'Passenger Side', attachments: ['CHILIPAD_PRO']};
  const tracker: Device = {id: 'tracker-1', name: 'Sleep Tracker', attachments: []};

  it('registers a Dock Pro', async () => {
    const {platform, registered} = harness([dock], fixtures);
    platform.discoverDevices();
    await flush();
    expect(registered).toEqual(['Passenger Side']);
  });

  // A Sleep Tracker exposes none of the fields this plugin drives, so registering
  // it would produce a thermostat and water sensor that never update.
  it('skips a device whose model is not a supported Dock Pro', async () => {
    const {platform, registered, log} = harness([dock, tracker], fixtures);
    platform.discoverDevices();
    await flush();

    expect(registered).toEqual(['Passenger Side']);
    expect(registered).not.toContain('Sleep Tracker');
    expect(messagesAt(log, 'info').join('\n')).toContain(`model ${SLEEP_TRACKER} is not a supported Dock Pro`);
  });

  it('honours supported_models when SleepMe ships a new code', async () => {
    const {platform, registered} = harness([dock, tracker], fixtures,
      {supported_models: [DOCK_PRO, SLEEP_TRACKER]});
    platform.discoverDevices();
    await flush();
    expect(registered).toEqual(['Passenger Side', 'Sleep Tracker']);
  });

  it('restricts registration to a device_ids allowlist', async () => {
    const second: Device = {id: 'dock-2', name: 'Driver Side', attachments: ['CHILIPAD_PRO']};
    const {platform, registered, log} = harness([dock, second], fixtures, {device_ids: ['dock-2']});
    platform.discoverDevices();
    await flush();

    expect(registered).toEqual(['Driver Side']);
    expect(messagesAt(log, 'info').join('\n')).toContain('not in the configured device ID allowlist');
  });

  // Startup costs one list call plus one status call per device. Re-fetching in
  // the accessory would double that against a 10-per-minute quota.
  it('reads each device status exactly once and hands it to the accessory', async () => {
    const {platform, statusCalls} = harness([dock], fixtures);
    platform.discoverDevices();
    await flush();
    expect(statusCalls.filter(id => id === 'dock-1')).toHaveLength(1);
  });

  it('warns rather than registering nothing silently when no dock is found', async () => {
    const {platform, registered, log} = harness([tracker], fixtures);
    platform.discoverDevices();
    await flush();

    expect(registered).toEqual([]);
    expect(messagesAt(log, 'warn').join('\n')).toContain('No supported Dock Pro devices found');
  });
});

describe('config validation', () => {
  const validate = (config: unknown): string[] => {
    const log = recordingLog();
    const api = {
      hap: {Service, Characteristic, uuid: {generate: (input: string) => input}},
      on: () => undefined,
    } as unknown as API;
    new SleepmePlatform(log as never, config as never, api);
    return messagesAt(log, 'error');
  };

  it('rejects a missing api_keys list', () => {
    expect(validate({platform: 'x'}).join('\n')).toContain('No API keys configured');
  });

  it('rejects an empty api_keys list', () => {
    expect(validate({platform: 'x', api_keys: []}).join('\n')).toContain('API keys array is empty');
  });

  it('rejects a non-string token', () => {
    expect(validate({platform: 'x', api_keys: [42]}).join('\n')).toContain('must be text strings');
  });

  it('rejects a blank token', () => {
    expect(validate({platform: 'x', api_keys: ['   ']}).join('\n')).toContain('are empty');
  });

  it('accepts a valid token', () => {
    expect(validate({platform: 'x', api_keys: ['token']})).toEqual([]);
  });
});
