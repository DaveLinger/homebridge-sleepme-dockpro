// filename: src/platform.ts
import {API, DynamicPlatformPlugin, Logging, PlatformAccessory, Service, Characteristic} from 'homebridge';

import {Client, DeviceStatus} from './sleepme/client.js';

import {PLATFORM_NAME, PLUGIN_NAME} from './settings.js';
import {SleepmePlatformAccessory} from './platformAccessory.js';

export type PluginConfig = {
  api_keys: string[];
  platform: string;
  device_ids?: string[];
  supported_models?: string[];
};

// Only the Dock Pro exposes the thermal and water fields this plugin drives. Other
// SleepMe products report a different model — the ST501NA Sleep Tracker, for one,
// has no water_level or is_water_low at all — and would otherwise be registered as
// a thermostat whose readings never update.
const DEFAULT_SUPPORTED_MODELS = ['DP999NA'];

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The config arrives as user-authored JSON, so every field is validated at runtime
// rather than trusted from the PluginConfig type.
const validateConfig = (config: PluginConfig): [boolean, string] => {
  const apiKeys: unknown = config.api_keys;
  const tokenDocsUrl = 'https://docs.developer.sleep.me/docs/';

  if (!apiKeys || !Array.isArray(apiKeys)) {
    return [false, 'No API keys configured. Please add your SleepMe API token in the plugin settings. ' +
      `Create an API token at: ${tokenDocsUrl}`];
  }
  if (apiKeys.length === 0) {
    return [false, 'API keys array is empty. Please add at least one SleepMe API token. ' +
      `Create an API token at: ${tokenDocsUrl}`];
  }
  if (apiKeys.some((key: unknown) => typeof key !== 'string')) {
    return [false, 'One or more API keys are invalid (must be text strings). ' +
      'Please check your API tokens in the plugin settings.'];
  }
  if (apiKeys.some((key: string) => key.trim().length === 0)) {
    return [false, 'One or more API keys are empty. ' +
      'Please remove empty entries and ensure all API tokens are valid.'];
  }
  return [true, ''];
};

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
    const allowedIds = (this.config.device_ids ?? [])
      .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
      .map(id => id.trim());
    const supportedModels = this.config.supported_models?.length
      ? this.config.supported_models
      : DEFAULT_SUPPORTED_MODELS;

    if (allowedIds.length > 0) {
      this.log.info(`Device allowlist active — only these device IDs will be added: ${allowedIds.join(', ')}`);
    }

    this.config.api_keys.forEach(key => {
      const client = new Client(key, undefined, this.log);
      client.listDevices().then(async r => {
        for (const device of r.data) {
          if (allowedIds.length > 0 && !allowedIds.includes(device.id)) {
            this.log.info(`Skipping "${device.name}" (${device.id}): not in the configured device ID allowlist`);
            continue;
          }

          // The device list does not include the model, so read the status here to
          // identify it. The status is handed to the accessory below so it does not
          // fetch again, keeping startup at one status call per device.
          let initialStatus: DeviceStatus | undefined;
          try {
            initialStatus = (await client.getDeviceStatus(device.id)).data;
          } catch (error) {
            this.log.warn(
              `Could not read status for "${device.name}" (${device.id}) during discovery: ${errorMessage(error)}. ` +
              'Adding it anyway without a model check.',
            );
          }

          // Only skip on a model we positively identified as unsupported. If the status
          // call failed we add the device rather than risk dropping a working dock.
          const model = initialStatus?.about.model;
          if (model && !supportedModels.includes(model)) {
            this.log.info(
              `Skipping "${device.name}" (${device.id}): model ${model} is not a supported Dock Pro ` +
              `(supported: ${supportedModels.join(', ')}). ` +
              'If this is a Dock Pro, add its model to supported_models in the plugin config.',
            );
            continue;
          }

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
            new SleepmePlatformAccessory(this, existingAccessory, initialStatus);

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
            new SleepmePlatformAccessory(this, accessory, initialStatus);
            // link the accessory to your platform
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          }
        }
      }).catch(error => {
        this.log.error(`Failed to discover devices: ${errorMessage(error)}`);
      });
    });
  }
}