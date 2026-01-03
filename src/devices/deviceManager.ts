import type { CharacteristicValue, Logger } from 'homebridge';

import { EventEmitter } from 'node:events';

import TTLockAccessCodePlatform from '../platform.js';
import type { Passcode, SysInfo } from './deviceTypes.js';
import type { TTLockApi } from '../api/ttlockApi.js';

export const deviceEventEmitter = new EventEmitter();

export default class DeviceManager {
  private api: TTLockApi | undefined;
  private log: Logger;
  private readonly platform: TTLockAccessCodePlatform;

  constructor(platform: TTLockAccessCodePlatform) {
    this.platform = platform;
    this.log = this.platform.log;
    if (!this.platform.ttLockApi) {
      throw new Error('TTLock API is not initialized');
    }
    this.api = this.platform.ttLockApi;
  }

  public async discoverDevices(): Promise<void> {
    const devices = await this.api!.getDevices();
    for (const device of devices) {
      deviceEventEmitter.emit('deviceDiscovered', device);
    }
  }

  async getSysInfo(deviceId: string): Promise<Partial<SysInfo> | undefined> {
    return this.api!.getSysInfo(deviceId);
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
          await this.api!.lock(deviceId);
          break;
        case 'unlock':
          await this.api!.unlock(deviceId);
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
          return await this.api!.addPasscode(deviceId, passcode!);
        case 'delete':
          await this.api!.deletePasscode(deviceId, passcode!);
          break;
        case 'get':
          return await this.api!.getPasscodes(deviceId);
        default:
          throw new Error(`Unsupported passcode operation: ${operation}`);
      }
    } catch (error) {
      this.log.error(`Failed to manage passcodes on device ${deviceId} for operation ${operation}:`, error);
      throw error;
    }
  }
}