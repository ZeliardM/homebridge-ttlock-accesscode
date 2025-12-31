import HomeKitDevice from './baseDevice.js';
import HomekitDeviceLock from './homekitLock.js';
import type TTLockAccessCodePlatform from '../platform.js';
import type { TTLockDevice } from './deviceTypes.js';

function isLock(device: TTLockDevice) {
  if (device) {
    return true;
  }
  return false;
}

export default async function create(
  platform: TTLockAccessCodePlatform,
  ttlockDevice: TTLockDevice,
): Promise<HomeKitDevice | undefined> {
  let instance: HomeKitDevice;

  if (isLock(ttlockDevice)) {
    platform.log.debug('Device classified as Lock:', ttlockDevice.sys_info.model);
    instance = new HomekitDeviceLock(platform, ttlockDevice);
  } else {
    platform.log.error('Unknown device type; skipping:', ttlockDevice.sys_info.model);
    return undefined;
  }

  try {
    await instance.initialize();
  } catch (error) {
    platform.log.error(`Error initializing device [${ttlockDevice.sys_info.device_id}]:`, error);
    return undefined;
  }
  return instance;
}
