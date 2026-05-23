import { Categories, PlatformAccessoryEvent } from 'homebridge';
import type {
  CharacteristicValue,
  Logger,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';

import accessoryInformation from './accessoryInformation.js';
import type { ManualDoorConfig } from '../config.js';
import type TTLockAccessCodePlatform from '../platform.js';
import type { DirigeraDoorSensorUpdate } from '../api/dirigeraApi.js';
import type { ManualDoorAccessoryContext } from '../platform.js';
import { prefixLogger } from '../utils.js';

const CLOSED_POSITION = 0;
const OPEN_POSITION = 100;

export type DoorGuardState = {
  canOperate: boolean;
  reason?: string;
};

export default class HomeKitDeviceDoor {
  public readonly log: Logger;
  public readonly homebridgeAccessory: PlatformAccessory<ManualDoorAccessoryContext>;
  private readonly doorService: Service;
  private available = false;
  private contactOpen?: boolean;
  private hasReportedState = false;
  private lastUnavailableReason: string | undefined;

  constructor(
    private readonly platform: TTLockAccessCodePlatform,
    public readonly config: ManualDoorConfig,
  ) {
    this.log = prefixLogger(this.platform.log, `[${this.name}]`);
    this.homebridgeAccessory = this.initializeAccessory();
    this.doorService = this.setupDoorService();
    this.updateAccessoryInformation();
    this.homebridgeAccessory.on(PlatformAccessoryEvent.IDENTIFY, () => this.identify());
    this.syncCharacteristics();
  }

  public get id(): string {
    return this.config.id;
  }

  public get name(): string {
    return this.config.name;
  }

  public get linkedLockId(): string {
    return this.config.lock;
  }

  public get sensorId(): string {
    return this.config.sensor;
  }

  public get manufacturer(): string {
    return 'IKEA DIRIGERA';
  }

  public get model(): string {
    return 'Manual Door';
  }

  public get serialNumber(): string {
    return this.sensorId;
  }

  public get firmwareRevision(): string {
    return '1.0.0';
  }

  public get uuid(): string {
    return this.homebridgeAccessory.UUID;
  }

  public applySensorUpdate(update: DirigeraDoorSensorUpdate): void {
    const previousOpen = this.contactOpen;
    const wasAvailable = this.available;

    this.contactOpen = update.isOpen;
    this.available = update.isReachable !== false;
    this.hasReportedState = true;
    this.lastUnavailableReason = undefined;
    this.homebridgeAccessory.context.lastSeen = new Date();
    this.homebridgeAccessory.context.offline = !this.available;
    this.homebridgeAccessory.context.manualDoorOpen = this.contactOpen;

    if (previousOpen === undefined) {
      this.log.info(`Manual door [${this.name}] is ${this.contactOpen ? 'open' : 'closed'} from DIRIGERA sensor [${this.sensorId}]`);
    } else if (previousOpen !== this.contactOpen) {
      this.log.info(`Manual door [${this.name}] changed to ${this.contactOpen ? 'open' : 'closed'}`);
    } else {
      this.log.debug(`Manual door [${this.name}] remains ${this.contactOpen ? 'open' : 'closed'}`);
    }

    this.syncCharacteristics();
    if (!wasAvailable || previousOpen !== this.contactOpen) {
      this.platform.api.updatePlatformAccessories([this.homebridgeAccessory]);
    }
  }

  public markUnavailable(reason: string): void {
    const wasAvailable = this.available;
    this.available = false;
    this.hasReportedState = true;
    this.lastUnavailableReason = reason;
    this.homebridgeAccessory.context.offline = true;

    if (wasAvailable || this.contactOpen === undefined) {
      this.log.warn(`Manual door [${this.name}] sensor is unavailable: ${reason}`);
    } else {
      this.log.debug(`Manual door [${this.name}] sensor remains unavailable: ${reason}`);
    }

    this.syncCharacteristics();
    if (wasAvailable) {
      this.platform.api.updatePlatformAccessories([this.homebridgeAccessory]);
    }
  }

  public getLockGuardState(): DoorGuardState {
    if (!this.hasReportedState) {
      return {
        canOperate: false,
        reason: `linked manual door [${this.name}] sensor has not reported yet`,
      };
    }

    if (!this.available || this.contactOpen === undefined) {
      return {
        canOperate: false,
        reason: `linked manual door [${this.name}] sensor is unavailable`,
      };
    }

    if (this.contactOpen) {
      return {
        canOperate: false,
        reason: `linked manual door [${this.name}] is open`,
      };
    }

    return { canOperate: true };
  }

  private initializeAccessory(): PlatformAccessory<ManualDoorAccessoryContext> {
    const uuid = this.platform.api.hap.uuid.generate(`manualDoor:${this.id}`);
    const existingAccessory = this.platform.configuredAccessories.get(uuid) as PlatformAccessory<ManualDoorAccessoryContext> | undefined;
    let accessory: PlatformAccessory<ManualDoorAccessoryContext>;

    if (existingAccessory) {
      accessory = existingAccessory;
      accessory.displayName = this.name;
      this.log.debug(`Using cached manual door accessory [${this.name}] [${uuid}]`);
    } else {
      this.log.debug(`Creating manual door accessory [${this.name}] [${uuid}]`);
      accessory = new this.platform.api.platformAccessory(this.name, uuid, Categories.DOOR);
      this.platform.registerPlatformAccessory(accessory);
    }

    accessory.context.kind = 'manualDoor';
    accessory.context.manualDoorId = this.id;
    accessory.context.manualDoorSensorId = this.sensorId;
    accessory.context.manualDoorLinkedLockId = this.linkedLockId;
    if (typeof accessory.context.manualDoorOpen === 'boolean') {
      this.contactOpen = accessory.context.manualDoorOpen;
    }

    if (accessory.context.lastSeen) {
      accessory.context.lastSeen = new Date(accessory.context.lastSeen);
    } else {
      delete accessory.context.lastSeen;
    }
    this.available = this.contactOpen !== undefined && accessory.context.offline === false;
    accessory.context.offline = !this.available;

    this.platform.configuredAccessories.set(accessory.UUID, accessory);
    return accessory;
  }

  private setupDoorService(): Service {
    const S = this.platform.Service;
    const C = this.platform.Characteristic;
    const service = this.homebridgeAccessory.getService(S.Door) ?? this.addService(S.Door, this.name);

    service.getCharacteristic(C.CurrentPosition)
      .setProps({ minValue: CLOSED_POSITION, maxValue: OPEN_POSITION, minStep: OPEN_POSITION })
      .onGet(() => this.getCurrentPosition());

    service.getCharacteristic(C.TargetPosition)
      .setProps({ minValue: CLOSED_POSITION, maxValue: OPEN_POSITION, minStep: OPEN_POSITION })
      .onGet(() => this.getTargetPosition())
      .onSet(value => this.setTargetPosition(value));

    service.getCharacteristic(C.PositionState)
      .onGet(() => C.PositionState.STOPPED);

    service.getCharacteristic(C.StatusActive)
      .onGet(() => this.available);

    service.getCharacteristic(C.StatusFault)
      .onGet(() => this.getStatusFault());

    return service;
  }

  private addService(serviceCtor: WithUUID<typeof Service>, name: string): Service {
    return this.homebridgeAccessory.addService(serviceCtor, name, serviceCtor.UUID);
  }

  private updateAccessoryInformation(): void {
    const info = accessoryInformation(this.platform.api.hap)(this.homebridgeAccessory, this);
    if (!info) {
      this.log.error('Could not retrieve default AccessoryInformation');
    }
  }

  private getCurrentPosition(): CharacteristicValue {
    if (this.contactOpen === undefined) {
      throw this.getUnavailableError();
    }
    return this.contactOpen ? OPEN_POSITION : CLOSED_POSITION;
  }

  private getTargetPosition(): CharacteristicValue {
    return this.getCurrentPosition();
  }

  private setTargetPosition(_value: CharacteristicValue): void {
    if (this.contactOpen === undefined) {
      this.syncCharacteristics();
      return;
    }

    this.log.debug(`Ignoring HomeKit target position for manual door [${this.name}]; sensor state is authoritative`);
    this.syncCharacteristics();
  }

  private getStatusFault(): CharacteristicValue {
    const C = this.platform.Characteristic;
    return this.available ? C.StatusFault.NO_FAULT : C.StatusFault.GENERAL_FAULT;
  }

  private syncCharacteristics(): void {
    const C = this.platform.Characteristic;

    if (this.contactOpen === undefined) {
      const error = this.getUnavailableError();
      this.doorService.getCharacteristic(C.CurrentPosition).updateValue(error);
      this.doorService.getCharacteristic(C.TargetPosition).updateValue(error);
    } else {
      const position = this.contactOpen ? OPEN_POSITION : CLOSED_POSITION;
      this.doorService.getCharacteristic(C.CurrentPosition).updateValue(position);
      this.doorService.getCharacteristic(C.TargetPosition).updateValue(position);
    }

    this.doorService.getCharacteristic(C.PositionState).updateValue(C.PositionState.STOPPED);
    this.doorService.getCharacteristic(C.StatusActive).updateValue(this.available);
    this.doorService.getCharacteristic(C.StatusFault).updateValue(this.getStatusFault());
  }

  private getUnavailableError(): Error {
    return new Error(this.lastUnavailableReason ?? 'DIRIGERA contact sensor has not reported yet');
  }

  private identify(): void {
    this.log.info(`Identify manual door [${this.name}]`);
  }
}
