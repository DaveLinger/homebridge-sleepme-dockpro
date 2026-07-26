import {Server, createServer} from 'node:http';
import {SleepmePlatformAccessory} from './platformAccessory.js';
import {SleepmePlatform} from './platform.js';
import {Client, Control, DeviceStatus} from './sleepme/client.js';
import {RateLimiter} from './sleepme/rateLimiter.js';
import {
  Characteristic,
  FakeAccessory,
  RecordingLog,
  Service,
  dockProStatus,
  fakeAccessory,
  messagesAt,
  recordingLog,
} from './testSupport.js';

const TEMPERATURE_DEBOUNCE_MS = 500;
const settle = () => new Promise(resolve => setTimeout(resolve, TEMPERATURE_DEBOUNCE_MS + 150));

type Patch = [kind: string, value: unknown];

interface Built {
  accessory: SleepmePlatformAccessory;
  fake: FakeAccessory;
  log: RecordingLog;
  patches: Patch[];
}

// Every accessory owns a repeating poll timer and an hourly metrics interval, so
// each one built during a test has to be disposed or the event loop never drains
// and Jest hangs after the assertions pass.
const built: SleepmePlatformAccessory[] = [];
afterEach(() => {
  while (built.length) {
    built.pop()?.dispose();
  }
});

function build(options: {
  deviceCount?: number;
  status?: DeviceStatus;
  activeSeconds?: number;
  waterLevelType?: string;
} = {}): Built {
  const {deviceCount = 1, status = dockProStatus(), activeSeconds = 10} = options;
  const fake = fakeAccessory();
  const log = recordingLog();
  const patches: Patch[] = [];

  const client = {
    getDeviceStatus: async () => ({data: status, status: 200}),
    setTemperatureFahrenheit: async (_id: string, value: number) => {
      patches.push(['temperature', value]);
      return {data: status.control as Control, status: 200};
    },
    setThermalControlStatus: async (_id: string, value: string) => {
      patches.push(['state', value]);
      return {data: status.control as Control, status: 200};
    },
    setDisplayTemperatureUnit: async () => ({data: status.control as Control, status: 200}),
  } as unknown as Client;

  const platform = {
    log,
    Service,
    Characteristic,
    config: {
      water_level_type: options.waterLevelType ?? 'motion',
      active_polling_interval_seconds: activeSeconds,
    },
    clientFor: () => client,
  } as unknown as SleepmePlatform;

  const accessory = new SleepmePlatformAccessory(
    platform, fake as never, status, deviceCount,
  );
  built.push(accessory);
  return {accessory, fake, log, patches};
}

// Reaching into private state is deliberate: these are the invariants worth
// pinning, and exposing them purely for tests would be worse.
const activeIntervalMs = (accessory: SleepmePlatformAccessory): number =>
  (accessory as unknown as {activePollingIntervalMs: number}).activePollingIntervalMs;
const standbyIntervalMs = (accessory: SleepmePlatformAccessory): number =>
  (accessory as unknown as {standbyPollingIntervalMs: number}).standbyPollingIntervalMs;

describe('polling interval scaling', () => {
  // Total polling must stay within the account's budget however many devices
  // share the token, so the floor is per-device.
  it.each([[1, 10], [2, 20], [3, 30], [4, 40]])(
    'with %i device(s), a 10s setting becomes %is',
    (deviceCount, expectedSeconds) => {
      const {accessory} = build({deviceCount});
      expect(activeIntervalMs(accessory)).toBe(expectedSeconds * 1000);
    },
  );

  // Scaling raises an unsafe interval; it must never stretch a safe one, or the
  // default would get worse for exactly the multi-device users it protects.
  it('leaves a configured interval that is already above the floor untouched', () => {
    const {accessory} = build({deviceCount: 2, activeSeconds: 45});
    expect(activeIntervalMs(accessory)).toBe(45_000);
  });

  it('does not scale standby polling', () => {
    const {accessory} = build({deviceCount: 4});
    expect(standbyIntervalMs(accessory)).toBe(15 * 60 * 1000);
  });

  it('explains the adjustment in the log when it raises the interval', () => {
    const {log} = build({deviceCount: 3});
    expect(messagesAt(log, 'info').join('\n')).toContain('raised from 10s to 30s');
  });
});

describe('water level logging', () => {
  const waterStatus = (level: number, low: boolean) =>
    dockProStatus({}, {water_level: level, is_water_low: low});

  const republish = (built: Built, status: DeviceStatus) => {
    (built.accessory as unknown as {deviceStatus: DeviceStatus}).deviceStatus = status;
    (built.accessory as unknown as {publishUpdates: () => void}).publishUpdates();
  };

  it('records the level and flag once at startup', () => {
    const {log} = build({status: waterStatus(100, false)});
    expect(messagesAt(log, 'info')).toContainEqual(
      expect.stringContaining('Water level 100% at startup, low water flag is false'),
    );
  });

  it('stays silent when nothing changed', () => {
    const built = build({status: waterStatus(100, false)});
    built.log.entries.length = 0;
    republish(built, waterStatus(100, false));
    expect(messagesAt(built.log, 'info', 'warn')).toEqual([]);
  });

  // The case we suspect on current firmware: the level moves but the flag never
  // trips. Logging them separately is what will reveal that.
  it('logs a level change without claiming low water', () => {
    const built = build({status: waterStatus(100, false)});
    built.log.entries.length = 0;
    republish(built, waterStatus(42, false));

    const messages = messagesAt(built.log, 'info', 'warn').join('\n');
    expect(messages).toContain('100% -> 42%');
    expect(messages).not.toContain('LOW WATER');
  });

  it('warns when the low water flag trips and informs when it clears', () => {
    const built = build({status: waterStatus(42, false)});
    built.log.entries.length = 0;

    republish(built, waterStatus(15, true));
    expect(messagesAt(built.log, 'warn').join('\n')).toContain('LOW WATER detected (level 15%)');

    built.log.entries.length = 0;
    republish(built, waterStatus(100, false));
    expect(messagesAt(built.log, 'info').join('\n')).toContain('Low water cleared');
  });
});

describe('redundant command suppression', () => {
  it('skips a temperature write that matches the current setting', async () => {
    const built = build({status: dockProStatus({set_temperature_f: 70, set_temperature_c: 21})});
    await built.fake.setters['TargetTemperature'](21 as never);
    await settle();
    expect(built.patches).toEqual([]);
  });

  it('sends a temperature that actually changes, once', async () => {
    const built = build({status: dockProStatus({set_temperature_f: 70, set_temperature_c: 21})});
    await built.fake.setters['TargetTemperature'](25 as never);
    await settle();
    expect(built.patches).toEqual([['temperature', 77]]);

    await built.fake.setters['TargetTemperature'](25 as never);
    await settle();
    expect(built.patches).toHaveLength(1);
  });

  // 46.7C and 46.5C both map to the 999 sentinel, so comparing HomeKit values
  // rather than the value actually sent would resend the same request.
  it('treats Celsius values that map to the same sentinel as identical', async () => {
    const built = build({status: dockProStatus({set_temperature_f: 70, set_temperature_c: 21})});
    await built.fake.setters['TargetTemperature'](46.7 as never);
    await settle();
    expect(built.patches).toEqual([['temperature', 999]]);

    await built.fake.setters['TargetTemperature'](46.5 as never);
    await settle();
    expect(built.patches).toHaveLength(1);
  });

  it('skips a state write that matches the confirmed state', async () => {
    const built = build({status: dockProStatus({thermal_control_status: 'standby'})});
    await built.fake.setters['TargetHeatingCoolingState'](0 as never);
    expect(built.patches).toEqual([]);

    await built.fake.setters['TargetHeatingCoolingState'](3 as never);
    expect(built.patches).toEqual([['state', 'active']]);
  });

  // Dropping a genuine turn-on is far worse than spending a request, so dedup
  // must only fire when the state is actually known and settled.
  it('does not suppress while a command is still in flight', async () => {
    const built = build({status: dockProStatus({thermal_control_status: 'active'})});
    (built.accessory as unknown as {expectedThermalState: string}).expectedThermalState = 'active';
    await built.fake.setters['TargetHeatingCoolingState'](3 as never);
    expect(built.patches).toHaveLength(1);
  });

  it('does not suppress before any status is known', async () => {
    const built = build({status: dockProStatus({thermal_control_status: 'standby'})});
    (built.accessory as unknown as {deviceStatus: DeviceStatus | null}).deviceStatus = null;
    await built.fake.setters['TargetHeatingCoolingState'](0 as never);
    expect(built.patches).toHaveLength(1);
  });
});

describe('temperature debounce', () => {
  // A slider drag emits a write per step and every value is distinct, so dedup
  // alone does not help: without debouncing, one gesture spends the whole quota.
  it('collapses a drag into a single request for the settled value', async () => {
    const built = build({status: dockProStatus({set_temperature_f: 70, set_temperature_c: 21})});

    for (const value of [21.5, 22, 22.5, 23, 23.5, 24, 24.5, 25, 25.5]) {
      await built.fake.setters['TargetTemperature'](value as never);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(built.patches).toEqual([]);

    await settle();
    expect(built.patches).toEqual([['temperature', 78]]);
  });

  it('does not debounce power, where latency is what matters', async () => {
    const built = build({status: dockProStatus({thermal_control_status: 'standby'})});
    await built.fake.setters['TargetHeatingCoolingState'](3 as never);
    expect(built.patches).toEqual([['state', 'active']]);
  });
});

describe('behaviour when the rate limit is reached', () => {
  let server: Server;
  let baseUrl: string;
  let requests: string[];

  beforeAll(async () => {
    requests = [];
    server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(dockProStatus()));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  });

  // A held command resumes on its own timer, which outlives the test that started
  // it. Without draining here, a PATCH from one test lands during the next and
  // corrupts its request count.
  afterEach(async () => {
    await new Promise(resolve => setTimeout(resolve, MS_BEFORE_WINDOW_RESET * 3));
    requests.length = 0;
  });

  // The clock is frozen 200ms short of the window boundary so a held command
  // resumes quickly. Otherwise every such test would leave a real 60 second timer
  // pending, which keeps the event loop alive long after the assertions finish.
  const MS_BEFORE_WINDOW_RESET = 200;

  function buildAgainstExhaustedLimiter() {
    const limiter = new RateLimiter(10, 4, () => 60_000 - MS_BEFORE_WINDOW_RESET);
    const clientLog = recordingLog();
    const client = new Client('token', baseUrl, clientLog as never, limiter);
    for (let i = 0; i < 10; i++) {
      limiter.tryAcquire('command');
    }
    requests.length = 0;

    const fake = fakeAccessory();
    const log = recordingLog();
    const platform = {
      log, Service, Characteristic,
      config: {water_level_type: 'motion', active_polling_interval_seconds: 45},
      clientFor: () => client,
    } as unknown as SleepmePlatform;
    built.push(new SleepmePlatformAccessory(platform, fake as never, dockProStatus(), 1));
    return {fake, log, clientLog};
  }

  // onGet must never touch the network: it answers from cache, so an exhausted
  // budget cannot make HomeKit show a stale or unresponsive accessory.
  it('answers reads from cache without an API call', async () => {
    const {fake} = buildAgainstExhaustedLimiter();
    const started = Date.now();
    const value = await fake.getters['CurrentTemperature'](undefined as never);

    expect(value).toBe(21);
    expect(Date.now() - started).toBeLessThan(50);
    expect(requests).toEqual([]);
  });

  // A delayed command must not make HomeKit wait, or the tile shows "no response".
  it('returns from a write promptly instead of blocking on the window', async () => {
    const {fake} = buildAgainstExhaustedLimiter();
    const started = Date.now();
    await expect(fake.setters['TargetHeatingCoolingState'](3 as never)).resolves.not.toThrow();
    expect(Date.now() - started).toBeLessThan(100);
  });

  // The command must be deferred, not dropped: HomeKit already believes it took
  // effect, so silently discarding it would leave the device out of sync.
  it('holds the command back, then sends it once the window resets', async () => {
    const {fake, clientLog} = buildAgainstExhaustedLimiter();
    await fake.setters['TargetHeatingCoolingState'](3 as never);

    await new Promise(resolve => setTimeout(resolve, MS_BEFORE_WINDOW_RESET / 2));
    expect(requests.filter(request => request.startsWith('PATCH'))).toEqual([]);
    expect(messagesAt(clientLog, 'warn').join('\n')).toContain('rate limit reached');

    await new Promise(resolve => setTimeout(resolve, MS_BEFORE_WINDOW_RESET * 2));
    expect(requests.filter(request => request.startsWith('PATCH'))).toHaveLength(1);
  });

  it('never surfaces an error-level log to the operator', async () => {
    const {fake, log, clientLog} = buildAgainstExhaustedLimiter();
    await fake.setters['TargetHeatingCoolingState'](3 as never);
    await new Promise(resolve => setTimeout(resolve, MS_BEFORE_WINDOW_RESET * 3));

    expect(messagesAt(log, 'error')).toEqual([]);
    expect(messagesAt(clientLog, 'error')).toEqual([]);
  });
});
