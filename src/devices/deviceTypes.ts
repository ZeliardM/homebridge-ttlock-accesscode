import type { Characteristic, CharacteristicValue, WithUUID } from 'homebridge';

import type HomeKitDevice from './baseDevice.js';
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
  device: HomeKitDevice;
}

export interface CharacteristicDescriptor {
  type: WithUUID<new () => Characteristic>;
  name?: string;
  writable?: boolean;
  syncGroup?: string;
  getInitial(context?: DescriptorContext): CharacteristicValue;
  getCurrent(context?: DescriptorContext): CharacteristicValue;
  applySet?(value: CharacteristicValue, context: DescriptorContext): Promise<void | string>;
}