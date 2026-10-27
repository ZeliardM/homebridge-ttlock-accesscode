import type { CharacteristicValue, Logger } from 'homebridge';

import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';

import TTLockAccessCodePlatform from '../platform.js';
import type { PasscodeList, SysInfo } from './deviceTypes.js';
import { TTLockApiError } from '../api/ttlockApi.js';
import type { TTLockApi } from '../api/ttlockApi.js';
import type { ApiCallPriority } from '../api/usageTracker.js';

// HomeKit gives up on a write after 9 s (HAP answers OPERATION_TIMED_OUT); keep ~40 ms of it for the reply.
// Access-code writes are answered when they are done, so they get this long.
export const HOMEKIT_WRITE_TIME_LIMIT_MS = 8960;
// A lock command is answered to HomeKit at once and sent in the background, but must not move the lock long after
// it was asked to. Counted from the HomeKit request, so time spent waiting behind a poll counts too.
export const LOCK_COMMAND_TIME_LIMIT_MS = 60000;
// performance.now() time by which the HomeKit write being handled must be done
const homeKitWriteDeadline = new AsyncLocalStorage<number>();

export function runHomeKitWrite<T>(limitMs: number, write: () => Promise<T>): Promise<T> {
  return homeKitWriteDeadline.run(performance.now() + limitMs, write);
}

export const deviceEventEmitter = new EventEmitter();

export default class DeviceManager {
  private readonly api: TTLockApi;
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

  public async discoverDevices(skipStateFor?: ReadonlySet<string>, priority?: ApiCallPriority): Promise<void> {
    this.log.debug('Starting device discovery...');
    try {
      const devices = await this.api.getDevices(skipStateFor, priority);
      for (const device of devices) {
        this.log.debug(`Discovered device: ${device.sys_info.alias} (${device.sys_info.device_id})`);
        deviceEventEmitter.emit('deviceDiscovered', device);
      }
    } catch (error) {
      // The platform logs a failed discovery
      this.handleManagerError(error, 'discoverDevices');
      throw error;
    }
  }

  async getSysInfo(deviceId: string, shouldYield?: () => boolean): Promise<Partial<SysInfo>> {
    try {
      return await this.api.getSysInfo(deviceId, shouldYield);
    } catch (error) {
      // The lock logs a failed poll; a poll skipped because the gateway was busy is not an error
      if (!(error instanceof TTLockApiError && error.skipped)) {
        this.handleManagerError(error, 'getSysInfo');
      }
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
    const finishBy = homeKitWriteDeadline.getStore() ?? performance.now() + LOCK_COMMAND_TIME_LIMIT_MS;
    // A failure is not logged here: the lock logs it, or why the command was not sent
    switch (action) {
      case 'lock':
        await this.api.lock(deviceId, { finishBy });
        break;
      case 'unlock':
        await this.api.unlock(deviceId, { finishBy });
        break;
      default:
        throw new Error(`Unsupported action: ${action} for feature: ${feature}`);
    }
  }

  async managePasscodes(
    deviceId: string,
    operation: string,
    passcode?: string,
  ): Promise<PasscodeList | { keyboardPwdId: string } | void> {
    // An add or delete is not sent once HomeKit has stopped waiting for it. A read has no time limit, so the
    // passcode list can still be refreshed after a slow write.
    const sendBy = homeKitWriteDeadline.getStore();
    // A failure is not logged here: the lock logs the failed access-code write
    switch (operation) {
      case 'add':
        return await this.api.addPasscode(deviceId, passcode!, sendBy);
      case 'delete':
        await this.api.deletePasscode(deviceId, passcode!, sendBy);
        break;
      case 'get':
        return await this.api.getPasscodes(deviceId, { retry: 'notSent', priority: 'user' });
      default:
        throw new Error(`Unsupported passcode operation: ${operation}`);
    }
  }

  // Only at debug: the caller logs the failure once, at the level it calls for
  private handleManagerError(error: unknown, context: string): void {
    if (error instanceof Error) {
      this.log.debug(`[${context}] Error: ${error.message}`);
      if (error.stack) {
        this.log.debug(error.stack);
      }
      return;
    }
    this.log.debug(`[${context}] Unknown error: ${JSON.stringify(error)}`);
  }
}
