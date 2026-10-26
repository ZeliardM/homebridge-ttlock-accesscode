import type { Characteristic, CharacteristicValue, WithUUID } from 'homebridge';

import type TTLockAccessCodePlatform from '../platform.js';

export type TTLockDevice = Lock;

export interface SysInfo {
  alias: string;
  battery: number;
  device_id: string;
  fw_ver: string;
  hw_ver: string;
  mac: string;
  model: string;
  passcodes?: Passcode[];
  state: number;
  [key: string]: string | number | boolean | Passcode[] | undefined;
}

export interface Lock {
  // Discovery: TTLock lists the lock, but its details could not be read (sys_info holds only what lock/list returns)
  discovery_incomplete?: boolean;
  feature_info: FeatureInfo;
  last_seen: Date;
  offline: boolean;
  sys_info: SysInfo;
}

export interface FeatureInfo {
  passcode: boolean;
}

export interface Passcode {
  passcode_id: string;
  index: string;
  lock_id: string;
  passcode: string;
}

export interface DescriptorContext {
  platform: TTLockAccessCodePlatform;
  device: SysInfo;
  alias: string;
}

export interface CharacteristicDescriptor {
  type: WithUUID<new () => Characteristic>;
  name?: string;
  writable?: boolean;
  syncGroup?: string;
  debouncePolls?: number;
  syncHomeKitValueAfterSet?: boolean;
  getInitial(context: DescriptorContext): CharacteristicValue;
  getCurrent(context: DescriptorContext): CharacteristicValue;
  applySet?(value: CharacteristicValue, context: DescriptorContext): Promise<void | string>;
  // Returns a reason to refuse the set before HomeKit is answered, or undefined to allow it
  checkSet?: ((value: CharacteristicValue, context: DescriptorContext) => string | undefined) | undefined;
  // Answer HomeKit right away and run applySet in the background (for commands slower than HomeKit waits)
  applySetInBackground?: boolean;
}