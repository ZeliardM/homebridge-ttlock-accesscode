import { Categories } from 'homebridge';
import type { CharacteristicValue, Service, WithUUID } from 'homebridge';

import pkg from 'ber-tlv';

import HomeKitDevice from './baseDevice.js';
import {
  buildAccessCodeDescriptors,
  buildBatteryDescriptors,
  buildLockDescriptors,
} from './descriptorHelpers.js';
import type TTLockAccessCodePlatform from '../platform.js';
import type { CharacteristicDescriptor, Lock, Passcode, SysInfo } from './deviceTypes.js';

const { TlvFactory } = pkg;

class AccessCodeProtocolError extends Error {}

export default class HomeKitDeviceLock extends HomeKitDevice {
  private hasPasscode: boolean;
  private lockBusy = false;

  constructor(
    platform: TTLockAccessCodePlatform,
    public ttlockDevice: Lock,
  ) {
    super(platform, ttlockDevice, Categories.DOOR_LOCK, 'DOOR_LOCK');
    this.hasPasscode = !!ttlockDevice.feature_info.passcode;
    this.setupServices();
  }

  public async initialize(): Promise<void> {
    await this.startPolling();
  }

  protected getServiceTypes(): WithUUID<typeof Service>[] {
    const types: WithUUID<typeof Service>[] = [this.platform.Service.LockMechanism, this.platform.Service.Battery];
    if (this.hasPasscode) {
      types.push(this.platform.Service.AccessCode);
    }
    return types;
  }

  protected buildDescriptors(service: Service): CharacteristicDescriptor[] {
    const C = this.platform.Characteristic;
    if (service.UUID === this.platform.Service.LockMechanism.UUID) {
      return buildLockDescriptors(
        C,
        async (value, context) => {
          const blockReason = this.deviceManager?.getLockCommandBlockReason(context.device.device_id);
          if (blockReason) {
            const action = Number(value) === C.LockTargetState.SECURED ? 'lock' : 'unlock';
            this.log.warn(`Ignoring ${action} command for ${context.alias}: ${blockReason}`);
            return false;
          }
          await this.deviceManager!.controlDevice(context.device.device_id, 'state', value);
          return true;
        },
      );
    }
    if (service.UUID === this.platform.Service.Battery.UUID) {
      return buildBatteryDescriptors(C);
    }
    if (service.UUID === this.platform.Service.AccessCode.UUID) {
      return buildAccessCodeDescriptors(
        C,
        () => this.getAccessCodeSupportedConfiguration(),
        async (value, context) => {
          return await this.setAccessCodeControlPoint(context.device, value);
        },
        () => this.getConfigurationState(),
      );
    }
    return [];
  }

  private getAccessCodeSupportedConfiguration(): string {
    const configuration: Record<string, Buffer> = {
      '01': Buffer.from([1]),
      '02': Buffer.from([6]),
      '03': Buffer.from([9]),
      '04': Buffer.from([10]),
    };
    const tlvBuffer: Buffer[] = [];
    for (const [key, value] of Object.entries(configuration)) {
      const keyInt = parseInt(key, 16);
      tlvBuffer.push(Buffer.from([keyInt, value.length, ...value]));
    }
    return Buffer.concat(tlvBuffer).toString('base64') ?? 'AQEBAgEGAwEJBAEK';
  }

  private getAccessCodeService(): Service | undefined {
    return this.homebridgeAccessory.getService(this.platform.Service.AccessCode) ?? undefined;
  }

  private setLockBusy(busy: boolean): void {
    this.lockBusy = busy;
    const accessCodeService = this.getAccessCodeService();
    if (accessCodeService) {
      accessCodeService
        .getCharacteristic(this.platform.Characteristic.ConfigurationState)
        .updateValue(this.getConfigurationState());
    }
  }

  private async ensurePasscodesLoaded(device: SysInfo): Promise<Passcode[]> {
    if (Array.isArray(device.passcodes)) {
      return device.passcodes;
    }
    device.passcodes = await this.deviceManager!.managePasscodes(device.device_id, 'get') as Passcode[];
    return device.passcodes;
  }

  private async refreshPasscodes(device: SysInfo): Promise<Passcode[]> {
    device.passcodes = await this.deviceManager!.managePasscodes(device.device_id, 'get') as Passcode[];
    return device.passcodes;
  }

  private getPasscodeIdentifier(passcode: Passcode): bigint {
    return BigInt(passcode.index);
  }

  private encodePasscodeIdentifier(identifier: bigint): string {
    let hex = identifier.toString(16);
    if (hex.length % 2 !== 0) {
      hex = `0${hex}`;
    }
    return hex;
  }

  private findPasscodeByIdentifier(passcodes: Passcode[], identifier: bigint): Passcode | undefined {
    return passcodes.find(passcode => this.getPasscodeIdentifier(passcode) === identifier);
  }

  private buildPasscodeResponseRecord(passcode: Passcode): string {
    const identifierValue = this.encodePasscodeIdentifier(this.getPasscodeIdentifier(passcode));
    const identifier = TlvFactory.serialize(
      TlvFactory.primitiveTlv('01', identifierValue),
    ).toString('hex');
    const accessCode = TlvFactory.serialize(
      TlvFactory.primitiveTlv('02', Buffer.from(passcode.passcode).toString('hex')),
    ).toString('hex');
    const flags = TlvFactory.serialize(TlvFactory.primitiveTlv('03', '00')).toString('hex');
    const status = TlvFactory.serialize(TlvFactory.primitiveTlv('04', '00')).toString('hex');
    return TlvFactory.serialize(
      TlvFactory.primitiveTlv('03', identifier + accessCode + flags + status),
    ).toString('hex');
  }

  private parseOperationType(decodedTlv: Array<{ value: Buffer }>): number {
    const operation = decodedTlv[0];
    if (!operation) {
      throw new AccessCodeProtocolError('Empty AccessCodeControlPoint request');
    }
    return Number(operation.value.toString('hex'));
  }

  private parseIdentifierRequest(element: { value: Buffer }, requestType: string): bigint {
    const request = TlvFactory.parse(element.value);
    const identifierRecord = request[0];
    if (!identifierRecord) {
      throw new AccessCodeProtocolError(`${requestType} request is missing its passcode index`);
    }
    const identifier = identifierRecord.value.toString('hex');
    if (!identifier) {
      throw new AccessCodeProtocolError(`${requestType} request contained an empty passcode index`);
    }
    return BigInt(`0x${identifier}`);
  }

  private parsePasscodeRequest(element: { value: Buffer }): string {
    const request = TlvFactory.parse(element.value);
    const passcodeRecord = request[0];
    if (!passcodeRecord) {
      throw new AccessCodeProtocolError('Add request is missing the passcode payload');
    }
    return passcodeRecord.value.toString();
  }

  private async buildListResponse(device: SysInfo): Promise<string> {
    const passcodes = await this.ensurePasscodesLoaded(device);
    const records = passcodes.map(passcode => {
      this.log.debug(`Passcode ${passcode.passcode} found on ${this.name}`);
      return this.buildPasscodeResponseRecord(passcode);
    });
    return `010101${records.join('0000')}`;
  }

  private async buildReadResponse(
    device: SysInfo,
    decodedTlv: Array<{ value: Buffer }>,
  ): Promise<string> {
    const passcodes = await this.ensurePasscodesLoaded(device);
    const records = decodedTlv.slice(1).map((element) => {
      const passcodeIdentifier = this.parseIdentifierRequest(element, 'Read');
      const passcode = this.findPasscodeByIdentifier(passcodes, passcodeIdentifier);
      if (!passcode) {
        throw new AccessCodeProtocolError(`Passcode identifier ${passcodeIdentifier.toString()} was not found for read`);
      }
      this.log.debug(`Reading passcode ${passcode.passcode} on ${this.name}`);
      return this.buildPasscodeResponseRecord(passcode);
    });
    return `010102${records.join('0000')}`;
  }

  private async buildAddResponse(
    device: SysInfo,
    decodedTlv: Array<{ value: Buffer }>,
  ): Promise<string> {
    const records: string[] = [];
    for (const element of decodedTlv.slice(1)) {
      const newPassCode = this.parsePasscodeRequest(element);
      const cachedPasscodes = await this.ensurePasscodesLoaded(device);
      let passcode = cachedPasscodes.find(existing => existing.passcode === newPassCode);
      if (!passcode) {
        this.log.info(`Adding new passcode ${newPassCode} to ${this.name}`);
        const newPasscode = await this.deviceManager!
          .managePasscodes(device.device_id, 'add', newPassCode) as { keyboardPwdId: string };
        const refreshedPasscodes = await this.refreshPasscodes(device);
        passcode = refreshedPasscodes.find(existing =>
          existing.passcode_id === newPasscode.keyboardPwdId.toString()
          || existing.passcode === newPassCode,
        );
      } else {
        this.log.debug(`Passcode ${newPassCode} already exists on ${this.name}`);
      }
      if (!passcode) {
        throw new AccessCodeProtocolError(`Passcode ${newPassCode} was not available after add`);
      }
      records.push(this.buildPasscodeResponseRecord(passcode));
    }
    return `010103${records.join('0000')}`;
  }

  private async buildDeleteResponse(
    device: SysInfo,
    decodedTlv: Array<{ value: Buffer }>,
  ): Promise<string> {
    if (decodedTlv.length < 2) {
      throw new AccessCodeProtocolError('Delete request is missing the target passcode index');
    }
    const deleteRequest = decodedTlv[1];
    if (!deleteRequest) {
      throw new AccessCodeProtocolError('Delete request is missing the target passcode index');
    }
    const passcodes = await this.ensurePasscodesLoaded(device);
    const deletePasscodeIdentifier = this.parseIdentifierRequest(deleteRequest, 'Delete');
    const passcode = this.findPasscodeByIdentifier(passcodes, deletePasscodeIdentifier);
    if (!passcode) {
      throw new AccessCodeProtocolError(`Passcode identifier ${deletePasscodeIdentifier.toString()} was not found for delete`);
    }
    this.log.info(`Deleting passcode ${passcode.passcode} on ${this.name}`);
    await this.deviceManager!.managePasscodes(device.device_id, 'delete', passcode.passcode_id);
    await this.refreshPasscodes(device);
    return `010105${this.buildPasscodeResponseRecord(passcode)}`;
  }

  private async setAccessCodeControlPoint(device: SysInfo, value: CharacteristicValue): Promise<string> {
    this.setLockBusy(true);
    try {
      const decodedTlv = TlvFactory.parse(Buffer.from(String(value), 'base64').toString('hex'));
      this.log.debug(`Decoded TLV for AccessCodeControlPoint on ${this.name}:`, decodedTlv);

      let requestType = '';
      let responseTlv = '';

      switch (this.parseOperationType(decodedTlv)) {
        case 1: {
          requestType = 'List';
          responseTlv = await this.buildListResponse(device);
          break;
        }
        case 2: {
          requestType = 'Read';
          responseTlv = await this.buildReadResponse(device, decodedTlv);
          break;
        }
        case 3: {
          requestType = 'Add';
          responseTlv = await this.buildAddResponse(device, decodedTlv);
          break;
        }
        case 5: {
          requestType = 'Delete';
          responseTlv = await this.buildDeleteResponse(device, decodedTlv);
          break;
        }
        default:
          throw new AccessCodeProtocolError(`Unsupported AccessCodeControlPoint operation: ${this.parseOperationType(decodedTlv)}`);
      }

      this.log.info(`Access Code Control ${requestType} Request completed for ${this.name}`);
      return Buffer.from(responseTlv, 'hex').toString('base64');
    } catch (error) {
      if (error instanceof AccessCodeProtocolError) {
        this.log.warn(`Invalid AccessCodeControlPoint request on ${this.name}: ${error.message}`);
        return '';
      }
      throw error;
    } finally {
      this.setLockBusy(false);
    }
  }

  private getConfigurationState(): number {
    return this.lockBusy ? 0 : 1;
  }

  protected async updateAllServicesAndCharacteristics(forceUpdate: boolean): Promise<void> {
    await super.updateAllServicesAndCharacteristics(forceUpdate);
  }

  public identify(): void {
    this.log.info('identify');
  }
}
