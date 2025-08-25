import {
  Characteristic,
  CharacteristicValue,
  Logging,
  PlatformAccessory,
  Service,
  WithUUID,
} from 'homebridge';

import pkg from 'ber-tlv';
import { EventEmitter } from 'node:events';

import platformAccessoryInformation from './platformAccessoryInformation.js';
import { TTLockAccessoryContext, TTLockAccessCodePlatform } from './platform.js';
import { TTLockApi } from './api/ttlockApi.js';
import { Lock, TLV8Configuration } from './types/index.js';

const { TlvFactory } = pkg;

function encodeTLV8(data: TLV8Configuration): Buffer {
  const tlvBuffer = [];
  for (const [key, value] of Object.entries(data)) {
    const keyInt = parseInt(key, 16);
    tlvBuffer.push(Buffer.from([keyInt, value.length, ...value]));
  }
  return Buffer.concat(tlvBuffer);
}

function getAccessCodeSupportedConfiguration(): string {
  const configuration: TLV8Configuration = {
    '01': Buffer.from([1]),
    '02': Buffer.from([6]),
    '03': Buffer.from([9]),
    '04': Buffer.from([10]),
  };
  return encodeTLV8(configuration).toString('base64');
}

export class TTLockHomeKitDevice {
  private readonly log: Logging;
  private readonly ttLockApi?: TTLockApi;
  private debounceTimeout: NodeJS.Timeout | null = null;
  private lastStateChangeTime: number = 0;
  private lockBusy = false;
  private pollingInterval?: NodeJS.Timeout;
  private previousLock?: Lock;
  private updateEmitter = new EventEmitter();

  public isUpdating = false;
  public platformAccessory: PlatformAccessory<TTLockAccessoryContext>;

  constructor(
    private readonly platform: TTLockAccessCodePlatform,
    public lock: Lock,
  ) {
    this.log = this.platform.log;
    this.log.info(`Initializing TTLockHomeKitDevice for ${this.lock.alias}`);
    this.ttLockApi = this.platform.ttLockApi;

    this.platformAccessory = this.initalizeAccessory();
    this.platformAccessory.on('identify', () => this.identify());
    this.checkServices();
    this.startPolling();

    this.platform.periodicDeviceDiscoveryEmitter.on('periodicDeviceDiscoveryComplete', () => {
      this.updateEmitter.emit('periodicDeviceDiscoveryComplete');
    });
  }

  private initalizeAccessory(): PlatformAccessory<TTLockAccessoryContext> {
    const uuid = this.platform.api.hap.uuid.generate(this.lock.id);
    const existingAccessory = this.platform.configuredAccessories.get(uuid);
    let platformAccessory: PlatformAccessory<TTLockAccessoryContext>;

    if (!existingAccessory) {
      this.log.debug(`Creating new Platform Accessory [${this.id}] [${uuid}]`);
      platformAccessory = new this.platform.api.platformAccessory(this.name, uuid);
      platformAccessory.context.id = this.id;
      this.platform.registerPlatformAccessory(platformAccessory);
    } else {
      this.log.debug(`Existing Platform Accessory found [${existingAccessory.context.id}] [${existingAccessory.UUID}]`);
      platformAccessory = existingAccessory;
      this.updatePlatformAccessory(platformAccessory);
    }

    const accInfo = platformAccessoryInformation(this.platform.api.hap)(
      platformAccessory,
      this,
    );
    if (!accInfo) {
      this.log.error('Failed to retrieve default AccessoryInformation.');
    }
    return platformAccessory;
  }

  private updatePlatformAccessory(platformAccessory: PlatformAccessory<TTLockAccessoryContext>): void {
    this.correctPlatformAccessory(platformAccessory, 'displayName', this.name);
    this.correctPlatformAccessory(platformAccessory.context, 'id', this.id);
    this.platform.configuredAccessories.set(platformAccessory.UUID, platformAccessory);
    this.platform.api.updatePlatformAccessories([platformAccessory]);
  }

  private correctPlatformAccessory<T, K extends keyof T>(obj: T, key: K, expectedValue: T[K]): void {
    if (obj[key] !== expectedValue) {
      this.log.debug(`Correcting Platform Accessory ${String(key)} from: ${String(obj[key])} to: ${String(expectedValue)}`);
      obj[key] = expectedValue;
    }
  }

  get id(): string {
    return this.lock.id;
  }

  get name(): string {
    return this.lock.alias;
  }

  get manufacturer(): string {
    return 'TTLock';
  }

  get model(): string {
    return this.lock.model;
  }

  get serialNumber(): string {
    return this.lock.mac;
  }

  get firmwareRevision(): string {
    return this.lock.firmwareRevision;
  }

  private checkServices(): void {
    const services = [
      this.platform.api.hap.Service.LockManagement,
      this.platform.api.hap.Service.LockMechanism,
      this.platform.api.hap.Service.Battery,
      this.platform.api.hap.Service.AccessCode,
      this.platform.api.hap.Service.NFCAccess,
    ];

    services.forEach((svc) => {
      const checkedService: Service =
        this.platformAccessory.getService(svc) ??
        this.platformAccessory.addService(svc, this.name, this.platformAccessory.UUID);

      if (checkedService.UUID !== this.platform.api.hap.Service.LockManagement.UUID) {
        this.checkCharacteristics(checkedService);
      }
      return checkedService;
    });
  }

  private checkCharacteristics(service: Service): void {
    const characteristicsMap = {
      LockMechanism: [
        {
          type: this.platform.api.hap.Characteristic.LockCurrentState,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.LockCurrentState),
        },
        {
          type: this.platform.api.hap.Characteristic.LockTargetState,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.LockTargetState),
        },
      ],
      Battery: [
        {
          type: this.platform.api.hap.Characteristic.BatteryLevel,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.BatteryLevel),
        },
        {
          type: this.platform.api.hap.Characteristic.StatusLowBattery,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.StatusLowBattery),
        },
      ],
      AccessCode: [
        {
          type: this.platform.api.hap.Characteristic.AccessCodeSupportedConfiguration,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.AccessCodeSupportedConfiguration),
        },
        {
          type: this.platform.api.hap.Characteristic.AccessCodeControlPoint,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.AccessCodeControlPoint),
        },
        {
          type: this.platform.api.hap.Characteristic.ConfigurationState,
          name: this.platform.getCharacteristicName(this.platform.api.hap.Characteristic.ConfigurationState),
        },
      ],
    } as const;

    const serviceName = this.platform.getServiceName(service) as keyof typeof characteristicsMap;
    const characteristics = characteristicsMap[serviceName] || [];

    characteristics.forEach(({ type, name }) => {
      this.getOrAddCharacteristic(service, type, name);
    });
  }

  private getOrAddCharacteristic(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName?: string,
  ): Characteristic {
    const characteristic = service.getCharacteristic(characteristicType) ??
      service.addCharacteristic(characteristicType);

    characteristic.onGet(this.handleOnGet.bind(this, service, characteristicType, characteristicName));
    if (characteristicType === this.platform.api.hap.Characteristic.LockTargetState) {
      characteristic.onSet(this.handleLockTargetStateOnSet.bind(this, service));
    } else if (characteristicType === this.platform.api.hap.Characteristic.AccessCodeControlPoint) {
      characteristic.onSet(this.handleAccessCodeControlPointOnSet.bind(this));
    }

    return characteristic;
  }

  private async handleOnGet(
    service: Service,
    characteristicType: WithUUID<new () => Characteristic>,
    characteristicName: string | undefined,
  ): Promise<CharacteristicValue> {
    try {
      if (this.lock.offline || this.platform.isShuttingDown) {
        this.log.debug(`Device is offline or shutting down, returning default for ${characteristicName}`);
        return this.getDefaultValue(characteristicType);
      }
      if (
        characteristicType !== this.platform.api.hap.Characteristic.AccessCodeControlPoint
      ) {
        let value = service.getCharacteristic(characteristicType).value as CharacteristicValue | undefined;
        if (!value) {
          value = this.getInitialValue(characteristicType, service);
          service.getCharacteristic(characteristicType).updateValue(value);
        }
        this.log.debug(`Got value for ${characteristicName}: ${value}`);
        return value ?? this.getDefaultValue(characteristicType);
      }
    } catch (error) {
      this.log.error(`Error getting value for ${characteristicName} on ${this.name}:`, error);
      this.lock.offline = true;
      this.stopPolling();
    }
    return this.getDefaultValue(characteristicType);
  }

  private getInitialValue(
    characteristicType: WithUUID<new () => Characteristic>,
    service: Service,
  ): CharacteristicValue {
    switch (characteristicType) {
      case this.platform.api.hap.Characteristic.LockCurrentState:
        return this.lock.state ?? this.platform.api.hap.Characteristic.LockCurrentState.SECURED;
      case this.platform.api.hap.Characteristic.LockTargetState:
        return this.lock.state ?? this.platform.api.hap.Characteristic.LockTargetState.SECURED;
      case this.platform.api.hap.Characteristic.BatteryLevel:
        return this.lock.battery ?? 100;
      case this.platform.api.hap.Characteristic.StatusLowBattery:
        return this.lock.battery < 20
          ? this.platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.platform.api.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      case this.platform.api.hap.Characteristic.AccessCodeSupportedConfiguration:
        return this.handleAccessCodeSupportedConfigurationOnGet(service);
      case this.platform.api.hap.Characteristic.ConfigurationState:
        return this.handleConfigurationStateOnGet(service);
      default:
        return this.getDefaultValue(characteristicType);
    }
  }

  private getDefaultValue(characteristicType: WithUUID<new () => Characteristic>): CharacteristicValue {
    const hap = this.platform.api.hap;
    switch (characteristicType) {
      case hap.Characteristic.LockCurrentState:
        return hap.Characteristic.LockCurrentState.SECURED;
      case hap.Characteristic.LockTargetState:
        return hap.Characteristic.LockTargetState.SECURED;
      case hap.Characteristic.BatteryLevel:
        return 100;
      case hap.Characteristic.StatusLowBattery:
        return hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      case hap.Characteristic.AccessCodeSupportedConfiguration:
        return 'AQEBAgEGAwEJBAEK';
      case hap.Characteristic.AccessCodeControlPoint:
        return '';
      case hap.Characteristic.ConfigurationState:
        return 1;
      default:
        return '';
    }
  }

  private handleAccessCodeSupportedConfigurationOnGet(service: Service): CharacteristicValue {
    const value = getAccessCodeSupportedConfiguration();
    service
      .getCharacteristic(this.platform.api.hap.Characteristic.AccessCodeSupportedConfiguration)
      .updateValue(value);
    return (
      service.getCharacteristic(this.platform.api.hap.Characteristic.AccessCodeSupportedConfiguration).value ??
      value
    );
  }

  private handleConfigurationStateOnGet(service: Service): CharacteristicValue {
    service
      .getCharacteristic(this.platform.api.hap.Characteristic.ConfigurationState)
      .updateValue(this.lockBusy ? 0 : 1);
    return service.getCharacteristic(this.platform.api.hap.Characteristic.ConfigurationState).value ?? 1;
  }

  private async handleLockTargetStateOnSet(service: Service, value: CharacteristicValue): Promise<void> {
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
    }

    this.debounceTimeout = setTimeout(async () => {
      if (this.lock.offline || this.platform.isShuttingDown) {
        this.log.debug('Device offline or shutting down, cannot set LockTargetState');
        return;
      }

      await this.waitForPendingUpdates();

      if (!this.ttLockApi) {
        this.log.error(`TTLock API unavailable for ${this.name}`);
        throw new Error('TTLock API not initialized');
      }
      try {
        this.isUpdating = true;
        if (value === this.platform.api.hap.Characteristic.LockTargetState.SECURED) {
          await this.ttLockApi.lock(this.lock.id);
        } else {
          await this.ttLockApi.unlock(this.lock.id);
        }
        this.lock.state = value as number;
        service.getCharacteristic(this.platform.api.hap.Characteristic.LockTargetState).updateValue(value);
        service.getCharacteristic(this.platform.api.hap.Characteristic.LockCurrentState).updateValue(value);
        const lockState = this.lock.state === 1 ? 'SECURED' : 'UNSECURED';
        this.log.info(`Lock state set to ${lockState} for ${this.name}`);
        this.lastStateChangeTime = Date.now();
      } catch (error) {
        this.log.error(`Error setting LockTargetState for ${this.name}:`, error);
        this.lock.offline = true;
        this.stopPolling();
      } finally {
        this.isUpdating = false;
        this.updateEmitter.emit('updateComplete');
      }
    }, 500);
  }

  private async handleAccessCodeControlPointOnSet(value: CharacteristicValue): Promise<string> {
    if (this.lock.offline || this.platform.isShuttingDown) {
      this.log.debug('Device offline or shutting down, cannot set LockTargetState');
      return '';
    }

    await this.waitForPendingUpdates();

    if (!this.ttLockApi) {
      this.log.error(`TTLock API unavailable for ${this.name}`);
      throw new Error('TTLock API not initialized');
    }
    try {
      this.isUpdating = true;
      this.lockBusy = true;
      const decTlv = TlvFactory.parse(Buffer.from(value.toString(), 'base64').toString('hex'));
      this.log.debug(`Decoded Access Code TLV: ${JSON.stringify(decTlv)}`);

      let responseTlv = '';
      let response = '';
      let identifier = '', accessCode = '', flags = '', status = '';

      switch (Number(decTlv[0].value.toString('hex'))) {
        case 1:
          this.log.debug('Access Code Control: List Request');
          responseTlv = '010101';
          this.lock.passCodes.forEach((pc, index) => {
            identifier = TlvFactory.serialize(TlvFactory.primitiveTlv('01', String(pc.index).padStart(2, '0'))).toString('hex');
            accessCode = TlvFactory.serialize(TlvFactory.primitiveTlv('02', Buffer.from(pc.passcode).toString('hex'))).toString('hex');
            flags = TlvFactory.serialize(TlvFactory.primitiveTlv('03', '00')).toString('hex');
            status = TlvFactory.serialize(TlvFactory.primitiveTlv('04', '00')).toString('hex');
            this.log.debug(`Passcode ${pc.passcode} found on ${this.lock.alias}`);
            responseTlv += TlvFactory.serialize(
              TlvFactory.primitiveTlv('03', identifier + accessCode + flags + status),
            ).toString('hex') + (index !== (this.lock.passCodes.length - 1) ? '0000' : '');
          });
          response = Buffer.from(responseTlv, 'hex').toString('base64');
          break;
        case 2:
          this.log.debug('Access Code Control: Read Request');
          responseTlv = '010102';
          if (this.lock.passCodes.length > 0) {
            for (let index = 1; index < decTlv.length; ++index) {
              const element = decTlv[index];
              const readReq = TlvFactory.parse(element.value);
              if (readReq.length > 0) {
                const passcodeIndexHex = readReq[0].value.toString('hex');
                const passcodeIndex = parseInt(passcodeIndexHex, 16);
                const pc = this.lock.passCodes[passcodeIndex];
                if (pc) {
                  this.log.debug(`Reading passcode ${pc.passcode} on ${this.lock.alias}`);
                  identifier = TlvFactory.serialize(TlvFactory.primitiveTlv('01', String(pc.index).padStart(2, '0'))).toString('hex');
                  accessCode = TlvFactory.serialize(
                    TlvFactory.primitiveTlv('02', Buffer.from(pc.passcode).toString('hex')),
                  ).toString('hex');
                  flags = TlvFactory.serialize(TlvFactory.primitiveTlv('03', '00')).toString('hex');
                  status = TlvFactory.serialize(TlvFactory.primitiveTlv('04', '00')).toString('hex');
                }
              }
              responseTlv += TlvFactory.serialize(
                TlvFactory.primitiveTlv('03', identifier + accessCode + flags + status),
              ).toString('hex') + (index !== (decTlv.length - 1) ? '0000' : '');
            }
          }
          response = Buffer.from(responseTlv, 'hex').toString('base64');
          break;
        case 3:
          this.log.debug('Access Code Control: Add Request');
          responseTlv = '010103';
          for (let index = 1; index < decTlv.length; index++) {
            const addReq = TlvFactory.parse(decTlv[index].value);
            if (addReq.length > 0) {
              const newPassCodeHex = addReq[0];
              const newPassCode = newPassCodeHex.value.toString();
              this.log.info(`Adding new passcode ${newPassCode} to ${this.lock.alias}`);
              const newPc = await this.ttLockApi.addPasscode(this.lock.id, newPassCode);
              this.lock.passCodes = await this.ttLockApi.getPasscodes(this.lock.id);
              const pc = this.lock.passCodes.find(p => p.id === newPc.keyboardPwdId.toString());
              if (pc) {
                const identifier = TlvFactory.serialize(TlvFactory.primitiveTlv('01', String(pc.index).padStart(2, '0'))).toString('hex');
                const accessCode = TlvFactory.serialize(
                  TlvFactory.primitiveTlv('02', Buffer.from(pc.passcode).toString('hex')),
                ).toString('hex');
                const flags = TlvFactory.serialize(TlvFactory.primitiveTlv('03', '00')).toString('hex');
                const status = TlvFactory.serialize(TlvFactory.primitiveTlv('04', '00')).toString('hex');
                responseTlv += TlvFactory.serialize(
                  TlvFactory.primitiveTlv('03', identifier + accessCode + flags + status),
                ).toString('hex') + (index !== (decTlv.length - 1) ? '0000' : '');
              }
            }
          }
          response = Buffer.from(responseTlv, 'hex').toString('base64');
          break;
        case 5: {
          this.log.debug('Access Code Control: Delete Request');
          responseTlv = '010105';
          const deleteReq = TlvFactory.parse(decTlv[1].value);
          if (deleteReq.length > 0) {
            const deletePassCodeIndexHex = deleteReq[0].value.toString('hex');
            const deletePassCodeIndex = parseInt(deletePassCodeIndexHex, 16);
            const pc = this.lock.passCodes[deletePassCodeIndex];
            if (pc) {
              this.log.info(`Deleting passcode ${pc.passcode} on ${this.lock.alias}`);
              await this.ttLockApi.deletePasscode(this.lock.id, pc.id);
              this.lock.passCodes = await this.ttLockApi.getPasscodes(this.lock.id);
              identifier = TlvFactory.serialize(TlvFactory.primitiveTlv('01', String(pc.index).padStart(2, '0'))).toString('hex');
              accessCode = TlvFactory.serialize(TlvFactory.primitiveTlv('02', Buffer.from(pc.passcode).toString('hex'))).toString('hex');
              flags = TlvFactory.serialize(TlvFactory.primitiveTlv('03', '00')).toString('hex');
              status = TlvFactory.serialize(TlvFactory.primitiveTlv('04', '00')).toString('hex');
              responseTlv += TlvFactory.serialize(
                TlvFactory.primitiveTlv('03', identifier + accessCode + flags + status),
              ).toString('hex');
            }
          }
          response = Buffer.from(responseTlv, 'hex').toString('base64');
          break;
        }
      }
      this.log.info(`Access Code Control request completed for ${this.lock.alias}: ${response}`);
      return response;
    } catch (error) {
      this.log.error(`Error setting LockTargetState for ${this.name}:`, error);
      this.lock.offline = true;
      this.stopPolling();
      return '';
    } finally {
      this.lockBusy = false;
      this.isUpdating = false;
      this.updateEmitter.emit('updateComplete');
    }
  }

  protected async updateState(): Promise<void> {
    if (this.lock.offline || this.platform.isShuttingDown) {
      this.stopPolling();
      return;
    }

    await this.waitForPendingUpdates();

    this.isUpdating = true;
    const task = (async () => {
      try {
        if (!this.ttLockApi) {
          this.log.error(`TTLock API unavailable for update state on ${this.name}`);
          throw new Error('TTLock API not initialized');
        }
        const currentTime = Date.now();
        this.previousLock = JSON.parse(JSON.stringify(this.lock));
        const updatedBattery = await this.ttLockApi.getBatteryLevel(this.lock.id);
        if (updatedBattery !== undefined) {
          this.lock.battery = updatedBattery.battery;
        }
        if (currentTime - this.lastStateChangeTime > 5000) {
          const updatedState = await this.ttLockApi.getLockState(this.lock.id);
          if (updatedState !== undefined) {
            this.lock.state = updatedState.state;
          }
        }

        this.updateBatteryService();
        this.updateLockService();
      } catch (error) {
        this.log.error('Error updating device state:', error);
        this.lock.offline = true;
        this.stopPolling();
      } finally {
        this.isUpdating = false;
        this.updateEmitter.emit('updateComplete');
      }
    })();

    this.platform.ongoingTasks.push(task);
    await task;
    this.platform.ongoingTasks = this.platform.ongoingTasks.filter((t) => t !== task);
  }

  public startPolling(): void {
    if (this.lock.offline || this.platform.isShuttingDown) {
      this.stopPolling();
      return;
    }
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    this.log.debug(`Starting polling for ${this.name}`);
    this.pollingInterval = setInterval(async () => {
      if (this.lock.offline || this.platform.isShuttingDown) {
        if (this.isUpdating) {
          this.isUpdating = false;
          this.updateEmitter.emit('updateComplete');
        }
        this.stopPolling();
      } else {
        await this.updateState();
      }
    }, this.platform.config.discoveryOptions.pollingInterval);
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
      this.log.debug(`Stopped polling for ${this.name}`);
    }
  }

  public identify(): void {
    this.log.info(`Lock identification triggered for ${this.lock.alias}`);
  }

  private async waitForPendingUpdates(): Promise<void> {
    if (this.isUpdating || this.platform.periodicDeviceDiscovering) {
      await Promise.race([
        new Promise<void>((resolve) => this.updateEmitter.once('updateComplete', resolve)),
        new Promise<void>((resolve) => this.updateEmitter.once('periodicDeviceDiscoveryComplete', resolve)),
      ]);
    }
  }

  private updateBatteryService() {
    const batteryService = this.platformAccessory.getService(this.platform.api.hap.Service.Battery);
    if (batteryService && this.previousLock && this.previousLock.battery !== this.lock.battery) {
      batteryService.updateCharacteristic(this.platform.api.hap.Characteristic.BatteryLevel, this.lock.battery);
      batteryService.updateCharacteristic(
        this.platform.api.hap.Characteristic.StatusLowBattery,
        this.lock.battery < 20 ? 1 : 0,
      );
      this.log.debug(
        `Battery changed from ${this.previousLock.battery}% to ${this.lock.battery}% on ${this.name}`,
      );
    }
  }

  private updateLockService() {
    const lockService = this.platformAccessory.getService(this.platform.api.hap.Service.LockMechanism);
    if (lockService && this.previousLock && this.previousLock.state !== this.lock.state) {
      lockService.updateCharacteristic(this.platform.api.hap.Characteristic.LockCurrentState, this.lock.state);
      lockService.updateCharacteristic(this.platform.api.hap.Characteristic.LockTargetState, this.lock.state);
      this.log.debug(`Lock state changed from ${this.previousLock.state} to ${this.lock.state} on ${this.name}`);
    }
  }
}