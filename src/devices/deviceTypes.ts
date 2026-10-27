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
  // How many entries TTLock's list of access codes had, counting the ones left out of passcodes; only for the first
  // HomeKit identifiers
  passcode_list_length?: number | undefined;
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
  lock_id: string;
  passcode: string;
  // TTLock keyboardPwdType: 2 permanent, 3 valid from start_date to end_date (ms; 0 for none); the others are
  // one-time, cyclic or erase codes. Undefined when TTLock does not say.
  type?: number | undefined;
  start_date?: number | undefined;
  end_date?: number | undefined;
  // Where TTLock's list put the code, counting the entries left out; only for the first HomeKit identifiers
  list_position?: number | undefined;
}

// TTLock's list of a lock's access codes: the codes that can be sent to HomeKit, and how many entries the list had,
// counting the ones left out
export interface PasscodeList {
  passcodes: Passcode[];
  listLength: number;
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
  // What a set asks for, in words for the log (for example 'unlock')
  describeSet?: ((value: CharacteristicValue) => string) | undefined;
}