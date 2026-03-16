import HomeKitDevice from './baseDevice.js';
import HomekitDeviceLock from './homekitLock.js';
import type TTLockAccessCodePlatform from '../platform.js';
import type { TTLockDevice } from './deviceTypes.js';

export default async function create(
  platform: TTLockAccessCodePlatform,
  ttlockDevice: TTLockDevice,
): Promise<HomeKitDevice | undefined> {
  platform.log.debug('Device classified as Lock:', ttlockDevice.sys_info.model);
  const instance: HomeKitDevice = new HomekitDeviceLock(platform, ttlockDevice);

  try {
    await instance.initialize();
  } catch (error) {
    platform.log.error(`Error initializing device [${ttlockDevice.sys_info.device_id}]:`, error);
    return undefined;
  }
  return instance;
}
