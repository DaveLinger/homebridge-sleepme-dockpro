// filename: src/platform.ts
import {API, DynamicPlatformPlugin, Logging, PlatformAccessory, Service, Characteristic} from 'homebridge';

import {Client} from './sleepme/client.js';

import {PLATFORM_NAME, PLUGIN_NAME} from './settings.js';
import {SleepmePlatformAccessory} from './platformAccessory.js';

export type PluginConfig = {
  api_keys: string[];
  platform: string;
};

const validateConfig = (config: any):[boolean, string] => {
  if(!config.api_keys || !Array.isArray(config.api_keys)) {
    return [false, "No API keys configured - plugin will not start"]
  }
  if (config.api_keys.some((s:unknown) => typeof s !== 'string')) {
    return [false, "Some API keys are invalid"]
  }
  return [true, '']
}

// When this event is fired it means Homebridge has restored all cached accessories from disk.
// Dynamic Platform plugins should only register new accessories after this event was fired,
// in order to ensure they weren't added to homebridge already. This event can also be used
// to start discovery of new accessories.
const didFinishLaunching = 'didFinishLaunching';

export class SleepmePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PluginConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const [validConfig, message] = validateConfig(this.config);
    if (!validConfig) {
      this.log.error(message)
      return
    }

    this.log.debug('Finished initializing platform:', config.platform);
    if (!log.success) {
      log.success = log.info;
    }
    this.api.on(didFinishLaunching, () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    this.config.api_keys.forEach(key => {
      const client = new Client(key, undefined, this.log);
      client.listDevices().then(r => {
        r.data.forEach(device => {
          const uuid = this.api.hap.uuid.generate(device.id);
          const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
          if (existingAccessory) {
            // the accessory already exists
            this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

            // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. e.g.:
            // existingAccessory.context.device = device;
            // this.api.updatePlatformAccessories([existingAccessory]);

            // create the accessory handler for the restored accessory
            // this is imported from `platformAccessory.ts`
            new SleepmePlatformAccessory(this, existingAccessory);

            // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, e.g.:
            // remove platform accessories when no longer present
            // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
            // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
          } else {
            // the accessory does not yet exist, so we need to create it
            this.log.info('Adding new accessory:', device.name);
            // create a new accessory
            const accessory = new this.api.platformAccessory(device.name, uuid);

            // store a copy of the device object in the `accessory.context`
            // the `context` property can be used to store any data about the accessory you may need
            accessory.context.device = device;
            accessory.context.apiKey = key;

            // create the accessory handler for the newly create accessory
            // this is imported from `platformAccessory.ts`
            new SleepmePlatformAccessory(this, accessory);
            // link the accessory to your platform
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          }
        });
      }).catch(error => {
        this.log.error(`Failed to discover devices: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }
}