import { PlatformAccessoryEvent } from 'homebridge';
import type {
  Categories,
  Characteristic,
  CharacteristicValue,
  HapStatusError,
  Logger,
  Nullable,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';

import { EventEmitter } from 'node:events';

import accessoryInformation from './accessoryInformation.js';
import DeviceManager from './deviceManager.js';
import { deferAndCombine, prefixLogger } from '../utils.js';
import type TTLockAccessCodePlatform from '../platform.js';
import type {
  CharacteristicDescriptor,
  DescriptorContext,
  SysInfo,
  TTLockDevice,
} from './deviceTypes.js';
import type { TTLockAccessCodeAccessoryContext } from '../platform.js';

export default abstract class HomeKitDevice {
  readonly log: Logger;
  protected deviceManager: DeviceManager | undefined;
  public homebridgeAccessory: PlatformAccessory<TTLockAccessCodeAccessoryContext>;
  public isUpdating = false;
  protected previousSnapshot?: HomeKitDevice;
  protected pollingInterval?: NodeJS.Timeout;
  protected updateEmitter = new EventEmitter();

  private static locks: Map<string, Promise<unknown>> = new Map();

  protected getSysInfoDeferred: () => Promise<void>;

  private services: Array<{
    serviceType: WithUUID<typeof Service>;
    service: Service;
    descriptors: CharacteristicDescriptor[];
  }> = [];

  constructor(
    readonly platform: TTLockAccessCodePlatform,
    public ttlockDevice: TTLockDevice,
    readonly category: Categories,
    readonly categoryName: string,
  ) {
    this.platform = platform;
    this.deviceManager = this.platform.deviceManager;
    this.log = prefixLogger(this.platform.log, `[${this.name}]`);
    this.homebridgeAccessory = this.initializeAccessory();
    this.homebridgeAccessory.on(PlatformAccessoryEvent.IDENTIFY, () => this.identify());
    this.platform.periodicDeviceDiscoveryEmitter.on('periodicDeviceDiscoveryComplete', () => {
      this.updateEmitter.emit('periodicDeviceDiscoveryComplete');
    });

    this.getSysInfoDeferred = deferAndCombine(
      this.fetchSysInfoInternal.bind(this),
      this.platform.config.advancedOptions.waitTimeUpdate,
    );

    if (this.previousSnapshot) {
      this.previousSnapshot.ttlockDevice = JSON.parse(JSON.stringify(this.ttlockDevice));
    } else {
      this.previousSnapshot = Object.create(this);
    }
  }

  private initializeAccessory(): PlatformAccessory<TTLockAccessCodeAccessoryContext> {
    const uuid = this.platform.api.hap.uuid.generate(this.id);
    const existingAccessory = this.platform.configuredAccessories.get(uuid);
    let accessory: PlatformAccessory<TTLockAccessCodeAccessoryContext>;
    if (!existingAccessory) {
      this.log.debug(`Creating new Platform Accessory [${this.id}] [${uuid}] category: ${this.categoryName}`);
      accessory = new this.platform.api.platformAccessory(this.name, uuid, this.category);
      accessory.context.deviceId = this.id;
      accessory.context.lastSeen = this.ttlockDevice.last_seen;
      accessory.context.offline = this.ttlockDevice.offline;
      this.platform.registerPlatformAccessory(accessory);
    } else {
      accessory = existingAccessory;
      this.updateAccessory(accessory);
    }
    const info = accessoryInformation(this.platform.api.hap)(accessory, this);
    if (!info) {
      this.log.error('Could not retrieve default AccessoryInformation');
    }
    return accessory;
  }

  private updateAccessory(accessory: PlatformAccessory<TTLockAccessCodeAccessoryContext>): void {
    accessory.displayName = this.name;
    accessory.context.deviceId = this.id;
    accessory.context.lastSeen = this.ttlockDevice.last_seen;
    accessory.context.offline = this.ttlockDevice.offline;
    this.platform.configuredAccessories.set(accessory.UUID, accessory);
    this.platform.api.updatePlatformAccessories([accessory]);
  }

  get id(): string {
    return this.ttlockDevice.sys_info.device_id;
  }

  get name(): string {
    return this.ttlockDevice.sys_info.alias;
  }

  get manufacturer(): string {
    return 'TTLock';
  }

  get model(): string {
    return `${this.ttlockDevice.sys_info.model} ${this.ttlockDevice.sys_info.hw_ver}`;
  }

  get serialNumber(): string {
    return this.ttlockDevice.sys_info.mac;
  }

  get firmwareRevision(): string {
    return this.ttlockDevice.sys_info.fw_ver;
  }

  protected makeLockKey(): string {
    return `${this.ttlockDevice.sys_info.device_id}`;
  }

  protected async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previousPromise = HomeKitDevice.locks.get(key) ?? Promise.resolve();
    const currentPromise = previousPromise.then(async () => {
      try {
        return await action();
      } finally {
        if (HomeKitDevice.locks.get(key) === currentPromise) {
          HomeKitDevice.locks.delete(key);
        }
      }
    });
    HomeKitDevice.locks.set(key, currentPromise);
    return currentPromise as Promise<T>;
  }

  protected shouldSkipUpdate(): boolean {
    return this.ttlockDevice.offline || this.platform.isShuttingDown;
  }

  protected async waitForUpdateOrDiscovery(): Promise<void> {
    let discoveryFinished = false;
    await Promise.race([
      new Promise<void>(resolve => this.updateEmitter.once('updateComplete', resolve)),
      new Promise<void>(resolve => {
        this.updateEmitter.once('periodicDeviceDiscoveryComplete', () => {
          discoveryFinished = true;
          resolve();
        });
      }),
    ]);
    if (discoveryFinished && this.pollingInterval) {
      await new Promise(r => setTimeout(r, this.platform.config.discoveryOptions.pollingInterval));
    }
  }

  protected async getSysInfo(): Promise<void> {
    await this.getSysInfoDeferred();
  }

  private async fetchSysInfoInternal(): Promise<void> {
    if (!this.deviceManager) {
      this.log.warn('Device manager not available');
      return;
    }
    const deviceId = this.ttlockDevice.sys_info?.device_id;
    if (!deviceId) {
      this.log.warn('No device_id in sys_info');
      return;
    }
    try {
      this.previousSnapshot!.ttlockDevice = JSON.parse(JSON.stringify(this.ttlockDevice));
      const updatedSysInfo = await this.deviceManager.getSysInfo(deviceId);
      if (!updatedSysInfo) {
        this.log.warn('getSysInfo returned undefined');
        return;
      }
      this.ttlockDevice.sys_info.battery = updatedSysInfo.battery!;
      this.ttlockDevice.sys_info.state = updatedSysInfo.state!;
      this.log.debug(`Updated sys_info: ${updatedSysInfo.alias ?? deviceId}`);
    } catch (error) {
      this.log.error('Error updating sys_info', error);
    }
  }

  protected async refreshAndUpdateCharacteristics(forceUpdate: boolean): Promise<void> {
    const deviceKey = this.ttlockDevice.sys_info.device_id;
    if (!forceUpdate && HomeKitDevice.locks.has(deviceKey)) {
      this.log.debug('Skipping poll; active update lock');
      return;
    }
    await this.withLock(deviceKey, async () => {
      if (this.shouldSkipUpdate()) {
        await this.stopPolling();
        return;
      }
      if (this.isUpdating || this.platform.periodicDeviceDiscovering) {
        await this.waitForUpdateOrDiscovery();
      }
      this.isUpdating = true;
      try {
        await this.getSysInfo();
        await this.updateAllServicesAndCharacteristics(forceUpdate);
      } catch (error) {
        this.log.error('Error during poll update:', error);
        this.ttlockDevice.offline = true;
        await this.stopPolling();
      } finally {
        this.isUpdating = false;
        this.updateEmitter.emit('updateComplete');
      }
    });
  }

  public async startPolling(): Promise<void> {
    if (this.shouldSkipUpdate()) {
      await this.stopPolling();
      return;
    }
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    const deviceCount = this.platform.configuredAccessories.size || 0;
    const userIntervalMs = this.platform.config.discoveryOptions.pollingInterval;
    const effectiveInterval = this.platform.computeEffectivePollingInterval(deviceCount, userIntervalMs);
    this.log.debug(`Starting polling with interval ${effectiveInterval}ms`);
    this.pollingInterval = setInterval(
      () => void this.refreshAndUpdateCharacteristics(false),
      effectiveInterval,
    );
  }

  public async stopPolling(): Promise<void> {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
    if (this.isUpdating) {
      await new Promise<void>(resolve => {
        this.isUpdating = false;
        this.updateEmitter.once('updateComplete', resolve);
      });
    }
  }

  public updateAfterPeriodicDiscovery(): void {
    void this.refreshAndUpdateCharacteristics(true);
  }

  protected setupServices(): void {
    const serviceTypes = this.getServiceTypes();
    if (!serviceTypes || serviceTypes.length === 0) {
      return;
    }
    for (const serviceType of serviceTypes) {
      const service = this.homebridgeAccessory.getService(serviceType) ?? this.addService(serviceType, this.name);
      const descriptors = this.buildDescriptors(service);
      for (const descriptor of descriptors) {
        this.registerCharacteristic(
          service,
          descriptor.type,
          () => this.genericOnGet(service, descriptor),
          descriptor.writable ? (value: CharacteristicValue) => this.genericOnSet(service, descriptor, value) : undefined,
        );
        this.initializeCharacteristic(service, descriptor);
      }
      this.services.push({ serviceType, service, descriptors });
    }
  }

  protected getServiceTypes(): WithUUID<typeof Service>[] {
    return [];
  }

  protected buildDescriptors(service: Service): CharacteristicDescriptor[] {
    void service;
    return [];
  }

  protected registerCharacteristic(
    service: Service,
    type: WithUUID<new () => Characteristic>,
    onGet: () => Promise<CharacteristicValue>,
    onSet?: (value: CharacteristicValue) => Promise<void | string>,
  ): void {
    const characteristic = service.getCharacteristic(type) ?? service.addCharacteristic(type);
    characteristic.onGet(onGet);
    if (onSet) {
      characteristic.onSet(onSet);
    }
  }

  protected initializeCharacteristic(
    service: Service,
    descriptor: CharacteristicDescriptor,
  ): void {
    const context = this.buildDescriptorContext();
    const initial = descriptor.getInitial(context);
    const characteristic = service.getCharacteristic(descriptor.type);
    characteristic.updateValue(initial);
  }

  protected buildDescriptorContext(): DescriptorContext {
    return {
      platform: this.platform,
      device: this,
    };
  }

  public updateDeviceField<K extends keyof SysInfo>(key: K, value: SysInfo[K]): void {
    (this.ttlockDevice.sys_info as SysInfo)[key] = value;
  }

  private async genericOnGet(service: Service, descriptor: CharacteristicDescriptor): Promise<CharacteristicValue> {
    try {
      const characteristic = service.getCharacteristic(descriptor.type);
      return characteristic.value!;
    } catch (error) {
      this.log.error(`OnGet error for ${descriptor.name ?? descriptor.type.UUID}`, error);
      this.ttlockDevice.offline = true;
      await this.stopPolling();
      return this.defaultValueForCharacteristic(descriptor.type);
    }
  }

  private async genericOnSet(service: Service, descriptor: CharacteristicDescriptor, value: CharacteristicValue): Promise<void | string> {
    if (!descriptor.applySet) {
      return;
    }
    const context = this.buildDescriptorContext();
    const result = await this.executeDescriptorSet(service, descriptor, value, context);
    if (result !== undefined) {
      return result;
    }
  }

  private async executeDescriptorSet(
    service: Service,
    descriptor: CharacteristicDescriptor,
    value: CharacteristicValue,
    context: DescriptorContext,
  ): Promise<void | string> {
    const lockKey = this.makeLockKey();
    return await this.withLock(lockKey, async () => {
      if (this.shouldSkipUpdate()) {
        return;
      }
      if (!this.deviceManager) {
        throw new Error('Device manager undefined');
      }
      try {
        this.isUpdating = true;
        const result = await descriptor.applySet!(value, context);
        let postSetValue: CharacteristicValue;
        this.previousSnapshot = JSON.parse(JSON.stringify(this.ttlockDevice));
        let descriptorsToUpdate: CharacteristicDescriptor[] = [];
        if (result !== undefined) {
          return result;
        } else {
          if (descriptor.syncGroup) {
            descriptorsToUpdate = this.services
              .find(entry => entry.service === service)!
              .descriptors.filter(d => d.syncGroup === descriptor.syncGroup);
          } else {
            descriptorsToUpdate = [descriptor];
          }
        }
        for (const desc of descriptorsToUpdate) {
          postSetValue = desc.getCurrent(context);
          this.updateValue(
            service,
            service.getCharacteristic(desc.type),
            context.device.name,
            postSetValue,
          );
        }
      } catch (error) {
        this.log.error(`OnSet error for ${descriptor.name ?? descriptor.type.UUID}`, error);
        this.ttlockDevice.offline = true;
        await this.stopPolling();
      } finally {
        this.isUpdating = false;
        this.updateEmitter.emit('updateComplete');
      }
    });
  }

  protected async updateAllServicesAndCharacteristics(forceUpdate: boolean): Promise<void> {
    for (const entry of this.services) {
      for (const descriptor of entry.descriptors) {
        const context = this.buildDescriptorContext();
        try {
          const previousContext: DescriptorContext = {
            platform: this.platform,
            device: this.previousSnapshot!,
          };

          const previousValue = descriptor.getCurrent(previousContext);
          const nextValue = descriptor.getCurrent(context);
          this.updateIfChanged(
            entry.service,
            entry.service.getCharacteristic(descriptor.type),
            context.device.name,
            previousValue as CharacteristicValue,
            nextValue as CharacteristicValue,
            descriptor.name,
            forceUpdate,
          );
        } catch (error) {
          this.log.error(`Update diff error for ${descriptor.name ?? descriptor.type.UUID}`, error);
        }
      }
    }
  }

  protected defaultValueForCharacteristic(type: WithUUID<new () => Characteristic>): CharacteristicValue {
    const C = this.platform.Characteristic;
    switch (type.UUID) {
      case C.LockCurrentState.UUID:
      case C.LockTargetState.UUID:
      case C.ConfigurationState.UUID:
        return 1;
      case C.BatteryLevel.UUID:
        return 100;
      case C.StatusLowBattery.UUID:
        return 0;
      case C.AccessCodeSupportedConfiguration.UUID:
        return 'AQEBAgEGAwEJBAEK';
      default:
        return '';
    }
  }

  protected updateIfChanged<T extends CharacteristicValue>(
    service: Service,
    characteristic: Characteristic,
    alias: string,
    previousValue: T,
    nextValue: T,
    label?: string,
    force = false,
  ): void {
    const needsInit = characteristic.value === undefined || characteristic.value === null;
    if (force || needsInit || previousValue !== nextValue) {
      if (label) {
        this.log.debug(`[${alias}] Updating ${label}: ${previousValue} → ${nextValue}`);
      }
      this.updateValue(service, characteristic, alias, nextValue as unknown as Nullable<CharacteristicValue>);
    }
  }

  protected addService(serviceCtor: WithUUID<typeof this.platform.Service>, name: string): Service {
    const friendly = this.platform.getServiceName(serviceCtor);
    this.log.debug(`Creating ${friendly} Service on ${name}`);
    return this.homebridgeAccessory.addService(serviceCtor, name, serviceCtor.UUID);
  }

  protected updateValue(
    service: Service,
    characteristic: Characteristic,
    deviceAlias: string,
    value: Nullable<CharacteristicValue> | Error | HapStatusError,
  ): void {
    this.log.info(`Updating ${this.platform.lsc(service, characteristic)} on ${deviceAlias} to ${value}`);
    characteristic.updateValue(value);
  }

  public abstract initialize(): Promise<void>;
  public abstract identify(): void;
}