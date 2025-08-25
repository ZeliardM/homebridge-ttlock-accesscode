export interface Lock {
  id: string;
  alias: string;
  mac: string;
  model: string;
  hardwareRevision: string;
  firmwareRevision: string;
  state: number;
  battery: number;
  passCodes: Passcode[];
  offline: boolean;
  lastSeen: Date;
}

export interface LockId{
  lockId: string;
}

export type LockIdList = LockId[];

export interface LockDetails {
  lockId: string;
  lockAlias: string;
  lockMac: string;
  modelNum: string;
  hardwareRevision: string;
  firmwareRevision: string;
}

export interface LockState {
  state: number;
}

export interface BatteryLevel {
  battery: number;
}

export interface Passcode {
  id: string;
  index: string;
  lockId: string;
  passcode: string;
}

export type PasscodeList = Passcode[];

export type TLV8Configuration = Record<string, Buffer>;