import type { CharacteristicValue, Logger } from 'homebridge';

import { EventEmitter } from 'node:events';

import TTLockAccessCodePlatform from '../platform.js';
import DirigeraApi from '../api/dirigeraApi.js';
import HomeKitDeviceDoor from './homekitDoor.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../settings.js';
import type { Passcode, SysInfo } from './deviceTypes.js';
import type {
  DirigeraDoorSensorUnavailable,
  DirigeraDoorSensorUpdate,
} from '../api/dirigeraApi.js';
import type { ManualDoorHubConfig } from '../config.js';
import type { TTLockApi } from '../api/ttlockApi.js';

export const deviceEventEmitter = new EventEmitter();

export default class DeviceManager {
  private readonly api: TTLockApi;
  private readonly dirigeraApis: DirigeraApi[] = [];
  private readonly doorsByLockId = new Map<string, HomeKitDeviceDoor[]>();
  private readonly log: Logger;
  private readonly platform: TTLockAccessCodePlatform;

  constructor(platform: TTLockAccessCodePlatform) {
    this.platform = platform;
    this.log = this.platform.log;
    if (!this.platform.ttLockApi) {
      throw new Error('TTLock API is not initialized');
    }
    this.api = this.platform.ttLockApi;
  }

  public initializeExternalDoors(): void {
    const configuredDoorUuids = new Set<string>();
    const doorsBySensorId = this.createExternalDoors(configuredDoorUuids);
    const candidateSensorIds = new Set(doorsBySensorId.keys());

    if (candidateSensorIds.size > 0) {
      const pairedHubs = this.platform.config.externalDoors.hubs
        .filter(hubConfig => hubConfig.ip.length > 0 && hubConfig.accessToken.length > 0);
      const startTasks = pairedHubs.map(hubConfig => {
        const api = new DirigeraApi(
          hubConfig,
          this.platform.config.externalDoors.doorPollingInterval,
          candidateSensorIds,
          this.log,
        );
        this.registerDirigeraHandlers(api, doorsBySensorId);
        this.dirigeraApis.push(api);
        return this.startDirigeraApi(api, hubConfig);
      });

      void this.markUnresolvedDoorSensorsAfterStartup(startTasks, candidateSensorIds, doorsBySensorId);
    }

    this.removeStaleExternalDoorAccessories(configuredDoorUuids);
  }

  public stopExternalDoors(): void {
    for (const api of this.dirigeraApis) {
      api.stop();
    }
    this.dirigeraApis.length = 0;
    this.doorsByLockId.clear();
  }

  public getLockCommandBlockReason(lockId: string): string | undefined {
    const linkedDoors = this.doorsByLockId.get(lockId) ?? [];
    const blockingReasons = linkedDoors
      .map(door => door.getLockGuardState())
      .filter(state => !state.canOperate)
      .map(state => state.reason)
      .filter((reason): reason is string => !!reason);

    if (blockingReasons.length === 0) {
      return undefined;
    }

    return `${blockingReasons.join('; ')}; TTLock command was not sent`;
  }

  public async discoverDevices(): Promise<void> {
    this.log.debug('Starting device discovery...');
    try {
      const devices = await this.api.getDevices();
      for (const device of devices) {
        this.log.debug(`Discovered device: ${device.sys_info.alias} (${device.sys_info.device_id})`);
        deviceEventEmitter.emit('deviceDiscovered', device);
      }
    } catch (error) {
      this.handleManagerError(error, 'discoverDevices');
      throw error;
    }
  }

  private createExternalDoors(configuredDoorUuids: Set<string>): Map<string, HomeKitDeviceDoor[]> {
    const doorsBySensorId = new Map<string, HomeKitDeviceDoor[]>();

    for (const doorConfig of this.platform.config.externalDoors.doors) {
      const door = new HomeKitDeviceDoor(this.platform, doorConfig);
      configuredDoorUuids.add(door.uuid);

      const doorsForSensor = doorsBySensorId.get(door.sensorId) ?? [];
      doorsForSensor.push(door);
      doorsBySensorId.set(door.sensorId, doorsForSensor);

      const doorsForLock = this.doorsByLockId.get(door.linkedLockId) ?? [];
      doorsForLock.push(door);
      this.doorsByLockId.set(door.linkedLockId, doorsForLock);
    }

    return doorsBySensorId;
  }

  private async startDirigeraApi(
    api: DirigeraApi,
    hubConfig: ManualDoorHubConfig,
  ): Promise<Set<string>> {
    try {
      const resolvedSensorIds = await api.start();
      if (this.platform.isShuttingDown) {
        api.stop();
      }
      return resolvedSensorIds;
    } catch (error) {
      if (this.platform.isShuttingDown) {
        return new Set();
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.log.warn(`Failed to start DIRIGERA hub [${hubConfig.ip}] for external doors: ${reason}`);
      return new Set();
    }
  }

  private async markUnresolvedDoorSensorsAfterStartup(
    startTasks: Promise<Set<string>>[],
    pendingSensorIds: Set<string>,
    doorsBySensorId: Map<string, HomeKitDeviceDoor[]>,
  ): Promise<void> {
    const resolvedSensorSets = await Promise.all(startTasks);
    for (const resolvedSensorIds of resolvedSensorSets) {
      for (const sensorId of resolvedSensorIds) {
        pendingSensorIds.delete(sensorId);
      }
    }

    for (const sensorId of pendingSensorIds) {
      const doors = doorsBySensorId.get(sensorId) ?? [];
      for (const door of doors) {
        door.markUnavailable('DIRIGERA sensor was not found on any configured hub');
      }
    }
  }

  private registerDirigeraHandlers(
    api: DirigeraApi,
    doorsBySensorId: Map<string, HomeKitDeviceDoor[]>,
  ): void {
    api.on('sensorUpdate', (update: DirigeraDoorSensorUpdate) => {
      const doors = doorsBySensorId.get(update.sensorId) ?? [];
      for (const door of doors) {
        door.applySensorUpdate(update);
      }
    });

    api.on('sensorUnavailable', (event: DirigeraDoorSensorUnavailable) => {
      const doors = doorsBySensorId.get(event.sensorId) ?? [];
      for (const door of doors) {
        door.markUnavailable(event.error);
      }
    });
  }

  private removeStaleExternalDoorAccessories(configuredDoorUuids: Set<string>): void {
    const staleAccessories = Array.from(this.platform.configuredAccessories.values())
      .filter(accessory => accessory.context.kind === 'manualDoor' && !configuredDoorUuids.has(accessory.UUID));

    if (staleAccessories.length === 0) {
      return;
    }

    this.log.info(`Removing ${staleAccessories.length} stale external door accessory/accessories`);
    this.platform.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    for (const accessory of staleAccessories) {
      this.platform.configuredAccessories.delete(accessory.UUID);
    }
  }

  async getSysInfo(deviceId: string): Promise<Partial<SysInfo> | undefined> {
    try {
      return await this.api.getSysInfo(deviceId);
    } catch (error) {
      this.handleManagerError(error, 'getSysInfo');
      throw error;
    }
  }

  async controlDevice(deviceId: string, feature: string, value: CharacteristicValue): Promise<void> {
    const action = this.mapFeatureToAction(feature, value);
    await this.performDeviceAction(deviceId, feature, action);
  }

  private mapFeatureToAction(feature: string, value: CharacteristicValue): string {
    switch (feature) {
      case 'state':
        return value === 1 ? 'lock' : 'unlock';
      default:
        throw new Error(`Unsupported feature: ${feature}`);
    }
  }

  private async performDeviceAction(
    deviceId: string,
    feature: string,
    action: string,
  ): Promise<void> {
    try {
      switch (action) {
        case 'lock':
          await this.api.lock(deviceId);
          break;
        case 'unlock':
          await this.api.unlock(deviceId);
          break;
        default:
          throw new Error(`Unsupported action: ${action} for feature: ${feature}`);
      }
    } catch (error) {
      this.log.error(`Failed to perform action ${action} on device ${deviceId} for feature ${feature}:`, error);
      throw error;
    }
  }

  async managePasscodes(
    deviceId: string,
    operation: string,
    passcode?: string,
  ): Promise<Passcode[] | { keyboardPwdId: string } | void> {
    try {
      switch (operation) {
        case 'add':
          return await this.api.addPasscode(deviceId, passcode!);
        case 'delete':
          await this.api.deletePasscode(deviceId, passcode!);
          break;
        case 'get':
          return await this.api.getPasscodes(deviceId);
        default:
          throw new Error(`Unsupported passcode operation: ${operation}`);
      }
    } catch (error) {
      this.log.error(`Failed to manage passcodes on device ${deviceId} for operation ${operation}:`, error);
      throw error;
    }
  }

  private handleManagerError(error: unknown, context: string): void {
    if (error instanceof Error) {
      this.log.error(`[${context}] Error: ${error.message}`);
      if (error.stack) {
        this.log.debug(error.stack);
      }
      return;
    }
    this.log.error(`[${context}] Unknown error: ${JSON.stringify(error)}`);
  }
}
