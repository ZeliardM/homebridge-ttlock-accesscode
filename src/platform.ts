import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  WithUUID,
} from 'homebridge';

import { EventEmitter } from 'node:events';

import HomeKitDevice from './devices/baseDevice.js';
import create from './devices/create.js';
import DeviceManager from './devices/deviceManager.js';
import { parseConfig } from './config.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { TaskQueue } from './taskQueue.js';
import {
  deferAndCombine,
  isObjectLike,
  loadPackageConfig,
  lookup,
  lookupCharacteristicNameByUUID,
  satisfiesVersion,
} from './utils.js';
import { TTLockApi } from './api/ttlockApi.js';
import { UsageTracker } from './api/usageTracker.js';
import { deviceEventEmitter } from './devices/deviceManager.js';
import type { TTLockAccessCodeConfig } from './config.js';
import type { TTLockDevice } from './devices/deviceTypes.js';

export type TTLockAccessCodeAccessoryContext = {
  deviceId?: string;
  lastSeen?: Date;
  offline?: boolean;
};

let packageConfig: { name: string; version: string; engines: { node: string } };

export default class TTLockAccessCodePlatform implements DynamicPlatformPlugin {
  public readonly Characteristic: typeof Characteristic;
  public readonly configuredAccessories: Map<string, PlatformAccessory<TTLockAccessCodeAccessoryContext>> = new Map();
  public readonly offlineAccessories: Map<string, PlatformAccessory<TTLockAccessCodeAccessoryContext>> = new Map();
  public readonly Service: typeof Service;
  public config: TTLockAccessCodeConfig;
  public deviceManager: DeviceManager | undefined;
  public isShuttingDown: boolean = false;
  public periodicDeviceDiscovering: boolean = false;
  public periodicDeviceDiscoveryEmitter: EventEmitter;
  public ttLockApi: TTLockApi | undefined;
  public usageTracker: UsageTracker | undefined;
  public taskQueue: TaskQueue;
  private readonly homekitDevicesById: Map<string, HomeKitDevice> = new Map();
  private deviceDiscoveredHandler?: (device: TTLockDevice) => Promise<void>;
  private platformInitialization: Promise<void>;

  constructor(public readonly log: Logging, config: PlatformConfig, public readonly api: API) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.config = parseConfig(config);
    this.periodicDeviceDiscoveryEmitter = new EventEmitter();
    this.taskQueue = new TaskQueue(this.log, () => this.isShuttingDown);

    this.periodicDeviceDiscoveryEmitter.setMaxListeners(255);
    this.setupDeviceEventEmitter('firstDiscovery');

    this.platformInitialization = this.initializePlatform();

    this.api.on('didFinishLaunching', async () => {
      this.log.debug('TTLockAccessCode Platform finished launching');
      await this.platformInitialization;
      await this.didFinishLaunching();
      if (this.offlineAccessories.size > 0) {
        this.log.debug('Unregistering offline accessories');
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, Array.from(this.offlineAccessories.values()));
        this.offlineAccessories.clear();
      }
    });

    this.api.on('shutdown', async () => {
      this.log.debug('TTLockAccessCode Platform shutting down');
      if (!this.isShuttingDown) {
        this.isShuttingDown = true;
      }
      this.log.debug('Stopping all polling tasks');
      for (const device of this.homekitDevicesById.values()) {
        await device.stopPolling();
      }
      this.log.debug('Waiting for tasks to complete');
      try {
        await this.taskQueue.waitForEmptyQueue();
      } catch (error) {
        this.log.error('Error while waiting for task queue to empty during shutdown:', error);
      }
      this.stopTTLockApi();
    });
  }

  private setupDeviceEventEmitter(mode: string, discoveredDeviceIds?: Set<string>): void {
    if (this.deviceDiscoveredHandler) {
      deviceEventEmitter.off('deviceDiscovered', this.deviceDiscoveredHandler);
    }
    this.log.debug(`Setting up device event emitter: ${mode}`);
    if (mode === 'periodicDiscovery' && discoveredDeviceIds) {
      this.deviceDiscoveredHandler = async (device: TTLockDevice) => {
        this.log.debug(`Device discovered during periodic discovery: ${device.sys_info.device_id}`);
        discoveredDeviceIds.add(device.sys_info.device_id);
        this.log.debug(`Added device ID to discoveredDeviceIds: ${device.sys_info.device_id}`);
        await this.processDevice(device);
      };
    } else {
      this.deviceDiscoveredHandler = async (device: TTLockDevice) => {
        this.log.debug(`Device discovered during initial discovery: ${device.sys_info.device_id}`);
        await this.processDevice(device);
      };
    }
    deviceEventEmitter.on('deviceDiscovered', this.deviceDiscoveredHandler);
  }

  async initializePlatform(): Promise<void> {
    packageConfig = await loadPackageConfig(this.log);
    this.logInitializationDetails();
    await this.verifyEnvironment();
  }

  private logInitializationDetails(): void {
    this.log.info(
      `${packageConfig.name} v${packageConfig.version}, node ${process.version}, ` +
      `homebridge v${this.api.serverVersion}, api v${this.api.version} Initializing...`,
    );
  }

  private async verifyEnvironment(): Promise<void> {
    this.log.debug('Verifying environment');

    try {
      this.log.debug('Checking Node.js version');
      if (!satisfiesVersion(process.version, packageConfig.engines.node)) {
        this.log.error(`Error: not using minimum node version ${packageConfig.engines.node}`);
      } else {
        this.log.debug(`Node.js version ${process.version} satisfies the requirement ${packageConfig.engines.node}`);
      }

      this.log.debug('Checking Homebridge version');
      if (
        this.api.versionGreaterOrEqual &&
        !(
          this.api.versionGreaterOrEqual('1.8.0') ||
          this.api.versionGreaterOrEqual('2.0.0')
        )
      ) {
        throw new Error(
          `homebridge-ttlock-accesscode requires Homebridge ^1.8.0 || ^2.0.0-beta.0. Currently running: ${this.api.serverVersion}`,
        );
      } else {
        this.log.debug(
          `Homebridge version ${this.api.serverVersion} satisfies the requirement ^1.8.0 || ^2.0.0-beta.0`,
        );
      }
    } catch (error) {
      this.log.error('Error verifying environment:', error);
      throw error;
    }
  }

  private async didFinishLaunching(): Promise<void> {
    this.log.debug('Finished launching');

    try {
      await this.startTTLockApi();

      this.log.debug('Initializing DeviceManager');
      this.deviceManager = new DeviceManager(this);
      this.log.debug('DeviceManager initialized');

      await this.discoverDevices();
      this.log.debug('Device discovery completed');

      const discoveredDeviceIds = new Set<string>();
      this.setupPeriodicDiscovery(discoveredDeviceIds);
    } catch (error) {
      this.log.error('An error occurred during startup:', error);
    }
  }

  private setupPeriodicDiscovery(discoveredDeviceIds: Set<string>): void {
    this.log.debug('Setting up periodic device discovery');
    this.setupDeviceEventEmitter('periodicDiscovery', discoveredDeviceIds);

    const discoveryTask = async () => {
      await this.periodicDeviceDiscovery(discoveredDeviceIds);
    };

    const deferredDiscoveryTask = deferAndCombine(discoveryTask, this.config.advancedOptions.waitTimeUpdate);

    setInterval(() => {
      try {
        this.taskQueue.addTask(deferredDiscoveryTask);
      } catch (error) {
        this.log.error('Error scheduling periodic device discovery:', error);
      }
    }, this.config.discoveryOptions.discoveryPollingInterval);

    this.log.debug('Periodic device discovery setup completed');
  }

  private async discoverDevices() {
    try {
      if (this.deviceManager) {
        try {
          const deviceCount = this.configuredAccessories.size || 0;
          const callsForDiscovery = 1 + (2 * deviceCount);
          if (this.usageTracker) {
            const reserved = await this.usageTracker.beginBatch(callsForDiscovery, 'initialDiscovery');
            if (!reserved) {
              this.log.info('Skipping initial device discovery due to API usage budget');
              return;
            }
          }
        } catch (error) {
          this.log.debug('Error reserving budget for initial discovery', error);
        }
        await this.deviceManager.discoverDevices();
      }
    } catch (error) {
      this.log.error('Error during discoverDevices:', error);
    }
  }

  private async periodicDeviceDiscovery(discoveredDeviceIds: Set<string>): Promise<void> {
    this.log.debug('Starting periodic device discovery');
    if (this.periodicDeviceDiscovering) {
      this.log.debug('Periodic device discovery already in progress');
      return;
    }
    if (this.isShuttingDown) {
      this.log.debug('Platform is shutting down, skipping periodic device discovery');
      return;
    }
    this.periodicDeviceDiscovering = true;
    discoveredDeviceIds.clear();
    this.log.debug('Cleared discoveredDeviceIds set before discovery.');
    try {
      if (this.deviceManager) {
        try {
          const deviceCount = this.configuredAccessories.size || 0;
          const callsForDiscovery = 1 + (2 * deviceCount);
          if (this.usageTracker) {
            const reserved = await this.usageTracker.beginBatch(callsForDiscovery, 'periodicDiscovery');
            if (!reserved) {
              this.log.info('Skipping periodic device discovery due to API usage budget');
              return;
            }
          }
        } catch (error) {
          this.log.debug('Error reserving budget for periodic discovery', error);
        }
        await this.deviceManager.discoverDevices();
      }
    } catch (error) {
      this.log.error('Error during periodic device discovery:', error);
    } finally {
      this.handleOfflineDevices(discoveredDeviceIds);
      this.periodicDeviceDiscovering = false;
      this.periodicDeviceDiscoveryEmitter.emit('periodicDeviceDiscoveryComplete');
      this.log.debug('Finished periodic device discovery');
    }
  }

  private async processDevice(device: TTLockDevice): Promise<void> {
    this.log.debug(`Processing device: ${device.sys_info.device_id}`);
    try {
      const now = new Date();
      device.last_seen = now;
      device.offline = false;
      const accessory = this.findPlatformAccessory(device.sys_info.device_id);
      if (accessory) {
        await this.updateExistingDevice(accessory, device, now);
      } else {
        await this.addNewDevice(device);
      }
    } catch (error) {
      this.log.error(`Error processing device [${device.sys_info.device_id}]:`, error);
    }
  }

  private handleOfflineDevices(discoveredDeviceIds: Set<string>): void {
    const now = new Date();
    this.configuredAccessories.forEach((accessory, uuid) => {
      const deviceId = accessory.context.deviceId;
      if (!deviceId) {
        this.log.warn(`Accessory [${accessory.displayName}] is missing a deviceId.`);
        return;
      }
      if (discoveredDeviceIds.has(deviceId)) {
        this.log.debug(`Accessory [${accessory.displayName}] was discovered and is online.`);
        this.updateAccessoryStatus(accessory, now, false);
      } else {
        this.handleOfflineAccessory(accessory, uuid, now);
      }
    });
  }

  private handleOfflineAccessory(
    accessory: PlatformAccessory<TTLockAccessCodeAccessoryContext>,
    uuid: string,
    now: Date,
  ): void {
    const timeSinceLastSeen = now.getTime() - new Date(accessory.context.lastSeen || 0).getTime();
    const offlineInterval = this.config.discoveryOptions.offlineInterval;
    if (timeSinceLastSeen > offlineInterval) {
      this.log.info(`Accessory [${accessory.displayName}] is offline and outside the offline interval. Removing.`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.configuredAccessories.delete(uuid);
    } else if (!accessory.context.offline) {
      this.log.debug(`Accessory [${accessory.displayName}] is offline but within the offline interval.`);
      this.updateAccessoryStatus(accessory, accessory.context.lastSeen || now, true);
    }
  }

  private findPlatformAccessory(deviceId: string): PlatformAccessory<TTLockAccessCodeAccessoryContext> | undefined {
    for (const accessory of this.configuredAccessories.values()) {
      if (accessory.context.deviceId === deviceId) {
        return accessory;
      }
    }
    return undefined;
  }

  private async updateExistingDevice(
    accessory: PlatformAccessory<TTLockAccessCodeAccessoryContext>,
    device: TTLockDevice,
    now: Date,
  ): Promise<void> {
    this.log.debug(`Device [${device.sys_info.device_id}] is already configured, updating status.`);
    this.updateAccessoryStatus(accessory, now, false);
    const existingDevice = this.homekitDevicesById.get(device.sys_info.device_id);
    if (existingDevice) {
      if (!existingDevice.isUpdating) {
        if (existingDevice.ttlockDevice.offline && !device.offline) {
          this.log.debug(`Device [${device.sys_info.device_id}] was offline and is now online. Updating and starting polling.`);
          existingDevice.ttlockDevice = device;
          existingDevice.updateAfterPeriodicDiscovery();
          existingDevice.startPolling();
        } else {
          this.log.debug(`Updating existing HomeKit device [${device.sys_info.device_id}].`);
          existingDevice.ttlockDevice = device;
          existingDevice.updateAfterPeriodicDiscovery();
        }
      } else {
        this.log.debug(`HomeKit device [${device.sys_info.device_id}] is currently updating. Skipping update.`);
      }
    } else {
      await this.addNewDevice(device);
    }
  }

  private async addNewDevice(device: TTLockDevice): Promise<void> {
    this.log.debug(`New device [${device.sys_info.device_id}] found, adding to HomeKit.`);
    await this.foundDevice(device);
  }

  private updateAccessoryStatus(
    accessory: PlatformAccessory<TTLockAccessCodeAccessoryContext>,
    lastSeen: Date,
    offline: boolean,
  ): void {
    accessory.context.lastSeen = lastSeen;
    accessory.context.offline = offline;
  }

  private async startTTLockApi(): Promise<void> {
    this.log.debug('Starting TTLock API');

    try {
      await this.createAndAuthenticateApi();
      this.log.debug('TTLock API process started successfully');
    } catch (error) {
      this.log.error(`Error starting TTLock API process: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  private stopTTLockApi(): void {
    this.log.debug('Stopping TTLock API');

    if (this.ttLockApi) {
      this.log.debug('TTLock API process found, attempting to kill the process');
      this.ttLockApi = undefined;
      this.log.debug('TTLock API process successfully killed');
    } else {
      this.log.debug('No TTLock API process found to stop');
    }
  }

  private async createAndAuthenticateApi() {
    this.log.debug('Creating and authenticating TTLock API...');
    try {
      this.log.debug('Initializing UsageTracker...');
      this.usageTracker = new UsageTracker(this.api, this.log, this.config.totalApiCallsPerMonth);
      await this.usageTracker.init();
      this.log.debug('UsageTracker initialized');
      this.usageTracker.on('tierChanged', () => {
        this.log.info('API usage tier changed — recalculating polling intervals...');
        void this.reschedulePolling();
      });
    } catch (err) {
      this.log.error('Failed to initialize usage tracker', err);
      this.usageTracker = undefined;
    }

    this.log.debug('Initializing TTLockApi...');
    this.ttLockApi = new TTLockApi(this.log, this.config.clientId, this.config.clientSecret, this.usageTracker);
    await this.ttLockApi.authenticate(this.config.username, this.config.password);
  }

  public computeEffectivePollingInterval(deviceCount: number, userIntervalMs: number): number {
    if (!this.usageTracker) {
      return userIntervalMs;
    }
    const usage = this.usageTracker.getUsage();
    const daysRemaining = usage.daysRemaining ?? usage.daysInMonth;
    const remainingDailyAllowance = (usage.remainingDailyAllowance !== undefined)
      ? usage.remainingDailyAllowance
      : Math.floor((usage.totalAllowed - usage.used) / Math.max(1, daysRemaining));
    const pollingBudgetPerDay = Math.floor(remainingDailyAllowance * 0.8);
    const estimatedCallsPerPoll = Math.max(1, deviceCount * 2);
    const maxPollsPerDay = Math.max(1, Math.floor(pollingBudgetPerDay / estimatedCallsPerPoll));
    const basePollingIntervalSec = Math.max(1, Math.floor(86400 / maxPollsPerDay));

    const remainingFraction = usage.totalAllowed === 0 ? 0 : usage.remaining / usage.totalAllowed;
    let multiplier = 1.0;
    if (remainingFraction < 0.05) {
      multiplier = 8.0;
    } else if (remainingFraction < 0.10) {
      multiplier = 4.0;
    } else if (remainingFraction < 0.20) {
      multiplier = 2.0;
    } else if (remainingFraction < 0.50) {
      multiplier = 1.5;
    }

    const minPollSec = 30;
    const maxPollSec = 3600;
    const finalSec = Math.min(Math.max(basePollingIntervalSec * multiplier, minPollSec), maxPollSec);
    const finalMs = Math.floor(finalSec * 1000);
    return Math.max(userIntervalMs, finalMs);
  }

  private async reschedulePolling(): Promise<void> {
    this.log.debug('Rescheduling polling for all devices');
    for (const device of this.homekitDevicesById.values()) {
      try {
        await device.startPolling();
      } catch (err) {
        this.log.debug('Error rescheduling polling for device', err);
      }
    }
  }

  public lsc(
    serviceOrCharacteristic: Service | Characteristic | { UUID: string },
    characteristic?: Characteristic | { UUID: string },
  ): string {
    const serviceName = serviceOrCharacteristic instanceof this.api.hap.Service
      ? this.getServiceName(serviceOrCharacteristic)
      : undefined;

    const characteristicName = characteristic instanceof this.api.hap.Characteristic
      ? this.getCharacteristicName(characteristic)
      : serviceOrCharacteristic instanceof this.api.hap.Characteristic || 'UUID' in serviceOrCharacteristic
        ? this.getCharacteristicName(serviceOrCharacteristic)
        : undefined;

    const result = `[${serviceName ? serviceName : ''}` +
                   `${serviceName && characteristicName ? '.' : ''}` +
                   `${characteristicName ? characteristicName : ''}]`;
    return result;
  }

  getServiceName(service: { UUID: string }): string | undefined {
    const serviceName = lookup(this.api.hap.Service, (objectProp, value) =>
      isObjectLike(objectProp) && 'UUID' in objectProp && objectProp.UUID === value, service.UUID);
    return serviceName;
  }

  getCharacteristicName(characteristic: WithUUID<{ name?: string | null; displayName?: string | null }>): string | undefined {
    const name = characteristic.name;
    const displayName = characteristic.displayName;
    const lookupName = lookupCharacteristicNameByUUID(this.api.hap.Characteristic, characteristic.UUID);
    return name ?? displayName ?? lookupName;
  }

  registerPlatformAccessory(accessory: PlatformAccessory<TTLockAccessCodeAccessoryContext>): void {
    this.log.debug('Registering platform accessory:', accessory.displayName);

    if (!this.configuredAccessories.has(accessory.UUID)) {
      this.log.debug(`Platform Accessory ${accessory.displayName} is not in configuredAccessories, adding it.`);
      this.configuredAccessories.set(accessory.UUID, accessory);
    } else {
      this.log.debug(`Platform Accessory ${accessory.displayName} is already in configuredAccessories.`);
    }

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.log.debug(`Platform Accessory ${accessory.displayName} registered with Homebridge.`);
  }

  configureAccessory(accessory: PlatformAccessory<TTLockAccessCodeAccessoryContext>): void {
    this.log.debug(`Configuring Platform Accessory: [${accessory.displayName}] UUID: ${accessory.UUID}`);

    if (!accessory.context.lastSeen && !accessory.context.offline) {
      this.log.debug(`Setting initial lastSeen and offline status for Platform Accessory: [${accessory.displayName}]`);
      accessory.context.lastSeen = new Date();
      accessory.context.offline = false;
    }

    if (accessory.context.lastSeen) {
      const now = new Date();
      const timeSinceLastSeen = now.getTime() - new Date(accessory.context.lastSeen).getTime();
      const offlineInterval = this.config.discoveryOptions.offlineInterval;

      this.log.debug(`Platform Accessory [${accessory.displayName}] last seen ${timeSinceLastSeen}ms ago, ` +
        `offline interval is ${offlineInterval}ms, offline status: ${accessory.context.offline}`);

      if (timeSinceLastSeen > offlineInterval && accessory.context.offline === true) {
        this.log.info(
          `Platform Accessory [${accessory.displayName}] is offline and outside the offline interval, ` +
          'moving to offlineAccessories',
        );
        this.configuredAccessories.delete(accessory.UUID);
        this.offlineAccessories.set(accessory.UUID, accessory);
        return;
      } else if (timeSinceLastSeen < offlineInterval && accessory.context.offline === true) {
        this.log.debug(`Platform Accessory [${accessory.displayName}] is offline and within offline interval.`);
      } else if (accessory.context.offline === false) {
        this.log.debug(`Platform Accessory [${accessory.displayName}] is online, updating lastSeen time.`);
        this.updateAccessoryStatus(accessory, now, false);
      }
    }

    if (!this.configuredAccessories.has(accessory.UUID)) {
      this.log.debug(
        `Platform Accessory [${accessory.displayName}] with UUID [${accessory.UUID}] ` +
        'is not in configuredAccessories, adding it.',
      );
      this.configuredAccessories.set(accessory.UUID, accessory);
    } else {
      this.log.debug(
        `Platform Accessory [${accessory.displayName}] with UUID ` +
        `[${accessory.UUID}] is already in configuredAccessories.`,
      );
    }
  }

  private async foundDevice(device: TTLockDevice): Promise<void> {
    const { sys_info: { alias: deviceAlias, device_id: deviceId } } = device;

    if (!deviceId) {
      this.log.error('Missing deviceId:', deviceAlias);
      return;
    }

    if (this.homekitDevicesById.has(deviceId)) {
      this.log.info(`HomeKit device already added: [${deviceAlias}] [${deviceId}]`);
      return;
    }

    this.log.info(`Adding HomeKit device: [${deviceAlias}] [${deviceId}]`);
    const homekitDevice = await this.createHomeKitDevice(device) as HomeKitDevice | undefined;
    if (homekitDevice) {
      this.homekitDevicesById.set(deviceId, homekitDevice);
      this.log.debug(`HomeKit device [${deviceAlias}] [${deviceId}] successfully added`);
    } else {
      this.log.error(`Failed to add HomeKit device for: [${deviceAlias}] [${deviceId}]`);
    }
  }

  private async createHomeKitDevice(ttlockDevice: TTLockDevice): Promise<HomeKitDevice | undefined> {
    this.log.debug('Creating HomeKit device for:', ttlockDevice.sys_info);
    return await create(this, ttlockDevice);
  }
}
