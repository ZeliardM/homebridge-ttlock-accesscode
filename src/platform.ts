import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, WithUUID } from 'homebridge';

import { EventEmitter } from 'node:events';

import { parseConfig } from './config.js';
import { TTLockHomeKitDevice } from './homekitDevice.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { lookup, lookupCharacteristicNameByUUID, isObjectLike } from './utils.js';
import { TTLockApi } from './api/ttlockApi.js';
import { BatteryLevel, Lock, LockDetails, LockIdList, LockState, PasscodeList } from './types/index.js';
import type { TTLockAccessCodeConfig } from './config.js';

export type TTLockAccessoryContext = {
  id?: string;
  lastSeen?: Date;
  offline?: boolean;
};

export class TTLockAccessCodePlatform implements DynamicPlatformPlugin {
  private readonly homekitDevicesById: Map<string, TTLockHomeKitDevice> = new Map();
  public readonly configuredAccessories: Map<string, PlatformAccessory<TTLockAccessoryContext>> = new Map();
  public readonly offlineAccessories: Map<string, PlatformAccessory<TTLockAccessoryContext>> = new Map();
  public config: TTLockAccessCodeConfig;
  public isShuttingDown = false;
  public ongoingTasks: Promise<void>[] = [];
  public periodicDeviceDiscoveryEmitter = new EventEmitter();
  public periodicDeviceDiscovering = false;
  public ttLockApi: TTLockApi | undefined;

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.config = parseConfig(config);

    this.api.on('didFinishLaunching', async () => {
      this.log.info('TTLockAccessCode Platform finished launching');
      try {
        await this.createAndAuthenticateApi();
        await this.discoverDevices();
        this.log.debug('Setting up periodic device discovery');
        setInterval(async () => {
          await this.periodicDeviceDiscovery();
        }, this.config.discoveryOptions.discoveryPollingInterval);
        this.log.debug('Periodic device discovery setup completed');
        if (this.offlineAccessories.size > 0) {
          this.log.debug('Unregistering offline accessories');
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, Array.from(this.offlineAccessories.values()));
          this.offlineAccessories.clear();
        }
      } catch (error) {
        this.log.error('An error occurred during startup:', error);
      }
    });

    this.api.on('shutdown', async () => {
      this.log.debug('TTLockAccessCode platform shutting down');
      this.isShuttingDown = true;
      await Promise.all(this.ongoingTasks);
      this.log.debug('All ongoing tasks completed. Platform is now shutting down.');
    });

    this.periodicDeviceDiscoveryEmitter.setMaxListeners(150);
  }

  private async createAndAuthenticateApi() {
    this.log.debug('Creating and authenticating TTLock API');
    try {
      this.ttLockApi = new TTLockApi(this.log, this.config.clientId, this.config.clientSecret);
      await this.ttLockApi.authenticate(this.config.username, this.config.password);
    } catch (error) {
      this.log.error('Failed to authenticate with TTLock API:', error);
    }
  }

  private async discoverDevices() {
    this.log.debug('Discovering devices');
    if (!this.ttLockApi) {
      this.log.error('TTLock API not initialized');
      return;
    }
    try {
      const locks = await this.ttLockApi.getLocks();
      const detailedLocks = await this.getDetailedLocks(locks);
      for (const detailedLock of detailedLocks) {
        this.foundDevice(detailedLock);
      }

      this.periodicDeviceDiscoveryEmitter.setMaxListeners(detailedLocks.length + 10);
      const maxListenerCount = this.periodicDeviceDiscoveryEmitter.getMaxListeners();
      this.log.debug('periodicDeviceDiscoveryEmitter max listener count:', maxListenerCount);
    } catch (error) {
      this.log.error('Error discovering devices:', error);
    }
  }

  private async getDetailedLocks(locks: LockIdList): Promise<Lock[]> {
    if (!this.ttLockApi) {
      return Promise.reject(new Error('TTLock API not initialized'));
    }

    const detailedLocks: Lock[] = [];

    for (const lock of locks) {
      this.log.debug(`Processing lock: ${lock.lockId}`);
      const lockDetails: LockDetails = await this.ttLockApi.getLockDetails(lock.lockId);
      const lockState: LockState = await this.ttLockApi.getLockState(lock.lockId);
      const lockBattery: BatteryLevel = await this.ttLockApi.getBatteryLevel(lock.lockId);
      const lockPassCodes: PasscodeList = await this.ttLockApi.getPasscodes(lock.lockId);
      const detailedLock: Lock = await this.ttLockApi.mapToLock(lockDetails, lockState, lockBattery, lockPassCodes);
      this.log.debug(`Detailed lock: ${JSON.stringify(detailedLock)}`);
      detailedLocks.push(detailedLock);
    }

    return detailedLocks;
  }

  private foundDevice(device: Lock): void {
    const { alias: deviceAlias, id: deviceId } = device;

    if (!deviceId) {
      this.log.error('Missing deviceId:', deviceAlias);
      return;
    }

    if (this.homekitDevicesById.has(deviceId)) {
      this.log.info(`HomeKit device already added: [${deviceAlias}] [${deviceId}]`);
      return;
    }

    this.log.info(`Adding HomeKit device: [${deviceAlias}] [${deviceId}]`);
    const homekitDevice = new TTLockHomeKitDevice(this, device);
    if (homekitDevice) {
      this.homekitDevicesById.set(deviceId, homekitDevice);
      this.log.debug(`HomeKit device [${deviceAlias}] [${deviceId}] successfully added`);
    } else {
      this.log.error(`Failed to add HomeKit device for: [${deviceAlias}] [${deviceId}]`);
    }
  }

  private async periodicDeviceDiscovery(): Promise<void> {
    if (this.periodicDeviceDiscovering) {
      this.log.debug('Periodic device discovery is already in progress');
      return;
    }
    if (!this.ttLockApi) {
      this.log.error('TTLock API not initialized');
      return;
    }
    this.periodicDeviceDiscovering = true;
    try {
      this.log.debug('Starting periodic device discovery');
      const locks = await this.ttLockApi.getLocks();
      const detailedLocks = await this.getDetailedLocks(locks);
      const now = new Date();
      const offlineInterval = this.config.discoveryOptions.offlineInterval;

      this.configuredAccessories.forEach((platformAccessory, uuid) => {
        const deviceId = platformAccessory.context.id;
        if (deviceId) {
          const device = this.findDiscoveredDevice(detailedLocks, platformAccessory);
          if (device) {
            this.updateAccessoryDeviceStatus(platformAccessory, device, now);
            this.updateOrCreateHomeKitDevice(deviceId, device);
          } else {
            this.updateAccessoryStatus(platformAccessory);
            this.handleOfflineAccessory(platformAccessory, uuid, now, offlineInterval);
          }
        }
      });
    } finally {
      this.periodicDeviceDiscovering = false;
      this.log.debug('Ending periodic device discovery');
      this.periodicDeviceDiscoveryEmitter.emit('periodicDeviceDiscoveryComplete');
    }
  }

  private findDiscoveredDevice(
    discoveredDevices: Lock[],
    platformAccessory: PlatformAccessory<TTLockAccessoryContext>,
  ): Lock | undefined {
    this.log.debug(`Finding discovered device with Platform Accessory ${platformAccessory.displayName}`);

    try {
      const device = discoveredDevices.find(device => device.id === platformAccessory.context.id);

      if (device) {
        this.log.debug(`Discovered device ${device.alias}`);
      } else {
        this.log.debug(`No discovered device found with Platform Accessory ${platformAccessory.displayName}`);
      }

      return device;
    } catch (error) {
      this.log.error(`Error finding discovered device with Platform Accessory ${platformAccessory.displayName}: ${error}`);
      return undefined;
    }
  }

  private updateAccessoryDeviceStatus(
    platformAccessory: PlatformAccessory<TTLockAccessoryContext>,
    device: Lock,
    now: Date,
  ): void {
    this.log.debug(`Updating Platform Accessory and HomeKit device statuses for ${platformAccessory.displayName}`);

    try {
      this.log.debug(`Setting HomeKit device ${device.alias} last seen time to now and marking as online`);
      device.lastSeen = now;
      device.offline = false;

      this.log.debug(`Setting Platform Accessory ${platformAccessory.displayName} last seen time to now and marking as online`);
      platformAccessory.context.lastSeen = now;
      platformAccessory.context.offline = false;

      this.log.debug(`Updating Platform Accessory ${platformAccessory.displayName}`);
      this.api.updatePlatformAccessories([platformAccessory]);

      this.log.debug(`Platform Accessory and HomeKit device statuses for ${platformAccessory.displayName} updated successfully`);
    } catch (error) {
      this.log.error(`Error updating Platform Accessory and HomeKit device statuses for ${platformAccessory.displayName}: ${error}`);
    }
  }

  private updateOrCreateHomeKitDevice(deviceId: string, device: Lock): void {
    this.log.debug(`Updating or creating HomeKit device ${device.alias}`);

    try {
      if (this.homekitDevicesById.has(deviceId)) {
        this.log.debug(`HomeKit device ${device.alias} already exists.`);
        const existingDevice = this.homekitDevicesById.get(deviceId);
        if (existingDevice) {
          if (!existingDevice.isUpdating) {
            if (existingDevice.lock.offline === true && device.offline === false) {
              this.log.debug(`HomeKit device ${device.alias} was offline and is now online. ` +
                'Updating device and starting polling.');
              existingDevice.lock = device;
              existingDevice.startPolling();
            } else {
              this.log.debug(`Updating existing HomeKit device ${device.alias}`);
              existingDevice.lock = device;
            }
          } else {
            this.log.debug(`HomeKit device ${device.alias} is currently updating. Skipping update.`);
          }
        } else {
          this.log.error(`Failed to retrieve existing HomeKit device ${device.alias} from homekitDevicesById.`);
        }
      } else {
        this.log.debug(`HomeKit device ${device.alias} does not exist.`);
        this.foundDevice(device);
      }
    } catch (error) {
      this.log.error(`Error updating or creating HomeKit device ${device.alias}: ${error}`);
    }
  }

  private updateAccessoryStatus(platformAccessory: PlatformAccessory): void {
    try {
      this.log.debug(`Setting Platform Accessory ${platformAccessory.displayName} offline status to true`);
      platformAccessory.context.offline = true;

      this.api.updatePlatformAccessories([platformAccessory]);

      this.log.debug(`Platform Accessory ${platformAccessory.displayName} status updated successfully`);
    } catch (error) {
      this.log.error(`Error updating Platform Accessory ${platformAccessory.displayName} status: ${error}`);
    }
  }

  private handleOfflineAccessory(platformAccessory: PlatformAccessory, uuid: string, now: Date, offlineInterval: number): void {
    this.log.debug(`Handling offline Platform Accessory ${platformAccessory.displayName}`);

    try {
      const homekitDevice = this.homekitDevicesById.get(platformAccessory.context.deviceId);
      if (homekitDevice) {
        const timeSinceLastSeen = now.getTime() - new Date(homekitDevice.lock.lastSeen).getTime();
        this.log.debug(
          `Time since last seen for Platform Accessory ${platformAccessory.displayName}: ${timeSinceLastSeen}ms, ` +
          `offline interval: ${offlineInterval}ms`,
        );

        if (timeSinceLastSeen < offlineInterval) {
          this.log.debug(`Platform Accessory ${platformAccessory.displayName} is offline and within offline interval.`);
          homekitDevice.lock.offline = true;
        } else if (timeSinceLastSeen > offlineInterval) {
          this.log.info(`Platform Accessory ${platformAccessory.displayName} is offline and outside the offline interval, removing.`);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
          this.configuredAccessories.delete(uuid);
          this.log.debug(`Platform Accessory [${platformAccessory.displayName}] removed successfully.`);
        }
      } else if (platformAccessory.context.offline === true) {
        const timeSinceLastSeen = now.getTime() - new Date(platformAccessory.context.lastSeen).getTime();
        this.log.debug(
          `Time since last seen for Platform Accessory ${platformAccessory.displayName}: ${timeSinceLastSeen}ms, ` +
          `offline interval: ${offlineInterval}ms`,
        );

        if (timeSinceLastSeen < offlineInterval) {
          this.log.debug(`Platform Accessory [${platformAccessory.displayName}] is offline and within offline interval.`);
          this.updateAccessoryStatus(platformAccessory);
        } else if (timeSinceLastSeen > offlineInterval) {
          this.log.info(`Platform Accessory ${platformAccessory.displayName} is offline and outside the offline interval, removing.`);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
          this.configuredAccessories.delete(uuid);
          this.log.debug(`Platform Accessory [${platformAccessory.displayName}] removed successfully.`);
        }
      }
    } catch (error) {
      this.log.error(`Error handling offline Platform Accessory ${platformAccessory.displayName}: ${error}`);
    }
  }

  registerPlatformAccessory(platformAccessory: PlatformAccessory<TTLockAccessoryContext>): void {
    this.log.debug('Registering platform platformAccessory:', platformAccessory.displayName);

    if (!this.configuredAccessories.has(platformAccessory.UUID)) {
      this.log.debug(`Platform Accessory ${platformAccessory.displayName} is not in configuredAccessories, adding it.`);
      this.configuredAccessories.set(platformAccessory.UUID, platformAccessory);
    } else {
      this.log.debug(`Platform Accessory ${platformAccessory.displayName} is already in configuredAccessories.`);
    }

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
    this.log.debug(`Platform Accessory ${platformAccessory.displayName} registered with Homebridge.`);
  }

  configureAccessory(platformAccessory: PlatformAccessory<TTLockAccessoryContext>): void {
    this.log.debug(`Configuring Platform Accessory: [${platformAccessory.displayName}] UUID: ${platformAccessory.UUID}`);

    if (!platformAccessory.context.lastSeen && !platformAccessory.context.offline) {
      this.log.debug(`Setting initial lastSeen and offline status for Platform Accessory: [${platformAccessory.displayName}]`);
      platformAccessory.context.lastSeen = new Date();
      platformAccessory.context.offline = false;
    }

    if (platformAccessory.context.lastSeen) {
      const now = new Date();
      const timeSinceLastSeen = now.getTime() - new Date(platformAccessory.context.lastSeen).getTime();
      const offlineInterval = this.config.discoveryOptions.offlineInterval;

      this.log.debug(`Platform Accessory [${platformAccessory.displayName}] last seen ${timeSinceLastSeen}ms ago, ` +
        `offline interval is ${offlineInterval}ms, offline status: ${platformAccessory.context.offline}`);

      if (timeSinceLastSeen > offlineInterval && platformAccessory.context.offline === true) {
        this.log.info(`Platform Accessory [${platformAccessory.displayName}] is offline and outside the offline interval, ` +
          'moving to offlineAccessories');
        this.configuredAccessories.delete(platformAccessory.UUID);
        this.offlineAccessories.set(platformAccessory.UUID, platformAccessory);
        return;
      } else if (timeSinceLastSeen < offlineInterval && platformAccessory.context.offline === true) {
        this.log.debug(`Platform Accessory [${platformAccessory.displayName}] is offline and within offline interval.`);
      } else if (platformAccessory.context.offline === false) {
        this.log.debug(`Platform Accessory [${platformAccessory.displayName}] is online, updating lastSeen time.`);
        platformAccessory.context.lastSeen = now;
        this.api.updatePlatformAccessories([platformAccessory]);
      }
    }

    if (!this.configuredAccessories.has(platformAccessory.UUID)) {
      this.log.debug(
        `Platform Accessory [${platformAccessory.displayName}] with UUID ` +
        `[${platformAccessory.UUID}] is not in configuredAccessories, adding it.`,
      );
      this.configuredAccessories.set(platformAccessory.UUID, platformAccessory);
    } else {
      this.log.debug(
        `Platform Accessory [${platformAccessory.displayName}] with UUID [${platformAccessory.UUID}] is already in configuredAccessories.`,
      );
    }
  }

  getServiceName(service: { UUID: string }): string {
    const serviceName = lookup(this.api.hap.Service, (thisKeyValue, value) =>
      isObjectLike(thisKeyValue) && 'UUID' in thisKeyValue && thisKeyValue.UUID === value, service.UUID);
    return serviceName;
  }

  getCharacteristicName(characteristic: WithUUID<{ name?: string | null; displayName?: string | null }>): string | undefined {
    const name = characteristic.name;
    const displayName = characteristic.displayName;
    const lookupName = lookupCharacteristicNameByUUID(this.api.hap.Characteristic, characteristic.UUID);
    return name ?? displayName ?? lookupName;
  }
}