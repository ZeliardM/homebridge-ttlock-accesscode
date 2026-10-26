import { Categories } from 'homebridge';
import type { CharacteristicValue, Service, WithUUID } from 'homebridge';

import pkg from 'ber-tlv';

import HomeKitDevice from './baseDevice.js';
import { LOCK_COMMAND_TIME_LIMIT_MS, LockCommandBlockedError } from './deviceManager.js';
import { TTLockApiError, TTLockApiErrorCategory } from '../api/ttlockApi.js';
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
          const action = Number(value) === C.LockTargetState.SECURED ? 'lock' : 'unlock';
          try {
            await this.deviceManager!.controlDevice(context.device.device_id, 'state', value);
          } catch (error) {
            // The door changed while the command was waiting or retrying
            if (error instanceof LockCommandBlockedError) {
              this.log.warn(`Stopped ${action} command for ${context.alias}: ${error.message}`);
              return false;
            }
            // It waited too long (behind a poll or another request) to be sure the lock would not move late
            if (error instanceof TTLockApiError && error.category === TTLockApiErrorCategory.DeadlineExpired) {
              this.log.warn(
                `Did not send ${action} to ${context.alias}: it could no longer finish within ` +
                `${LOCK_COMMAND_TIME_LIMIT_MS / 1000}s of the request`,
              );
              return false;
            }
            throw error;
          }
          // TTLock carried the command out through the gateway, so the lock answers again even if its last polls
          // did not; HomeKit stops showing No Response without waiting for the next poll
          this.markDeviceReachable();
          return true;
        },
        (value, context) => {
          const blockReason = this.deviceManager?.getLockCommandBlockReason(context.device.device_id);
          if (blockReason) {
            const action = Number(value) === C.LockTargetState.SECURED ? 'lock' : 'unlock';
            this.log.warn(`Ignoring ${action} command for ${context.alias}: ${blockReason}`);
          }
          return blockReason;
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

  // Whether a failed add or delete may still have changed the lock's codes (it got no answer, or no readable one), or
  // may have failed because the cached list is out of date (TTLock turned down a code it already has, or one already
  // deleted). Not when TTLock never got it, or turned it away before acting on it.
  private passcodesMayHaveChanged(error: unknown): boolean {
    if (!(error instanceof TTLockApiError)) {
      return true;
    }
    if (error.networkFailure === 'notSent' || error.networkFailure === 'tls' || error.gatewayTransient) {
      return false;
    }
    switch (error.category) {
      case TTLockApiErrorCategory.AuthExpired:
      case TTLockApiErrorCategory.AuthInvalid:
      case TTLockApiErrorCategory.BudgetExhausted:
      case TTLockApiErrorCategory.DeadlineExpired:
      case TTLockApiErrorCategory.GatewayOffline:
      case TTLockApiErrorCategory.RateLimited:
        return false;
      default:
        return true;
    }
  }

  // After a failed add or delete, read the list again: it says whether the change took effect, and keeps the cache
  // from answering HomeKit with codes that are no longer right. Undefined when the codes cannot have changed, or the
  // list could not be read; the cache is then dropped, so the next request reads the list.
  private async recheckPasscodes(device: SysInfo, error: unknown): Promise<Passcode[] | undefined> {
    if (!this.passcodesMayHaveChanged(error)) {
      return undefined;
    }
    this.log.debug(`Reading the access codes on ${this.name} again to see whether the change took effect`);
    try {
      return await this.refreshPasscodes(device);
    } catch (refreshError) {
      delete device.passcodes;
      this.log.debug(
        `Could not read the access codes on ${this.name} again: ` +
        `${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
      );
      return undefined;
    }
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
      this.log.debug(`Passcode id ${passcode.passcode_id} found on ${this.name}`);
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
      this.log.debug(`Reading passcode id ${passcode.passcode_id} on ${this.name}`);
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
      if (passcode) {
        this.log.debug(`The passcode to add already exists on ${this.name} as passcode id ${passcode.passcode_id}`);
      } else {
        passcode = await this.addPasscode(device, newPassCode);
      }
      records.push(this.buildPasscodeResponseRecord(passcode));
    }
    return `010103${records.join('0000')}`;
  }

  // An add that may have reached TTLock is not sent again, because TTLock may have applied it; the list says whether
  // it did
  private async addPasscode(device: SysInfo, newPassCode: string): Promise<Passcode> {
    this.log.info(`Adding a new passcode to ${this.name}`);
    let passcodeId: string;
    try {
      const added = await this.deviceManager!
        .managePasscodes(device.device_id, 'add', newPassCode) as { keyboardPwdId?: unknown };
      if (typeof added.keyboardPwdId !== 'number' && typeof added.keyboardPwdId !== 'string') {
        throw new TTLockApiError(
          'TTLock did not say which passcode id it added',
          TTLockApiErrorCategory.InvalidResponse,
          false,
          'keyboardPwd/add',
        );
      }
      passcodeId = String(added.keyboardPwdId);
    } catch (error) {
      const passcode = (await this.recheckPasscodes(device, error))?.find(existing => existing.passcode === newPassCode);
      if (!passcode) {
        throw error;
      }
      this.log.info(
        `The passcode is on ${this.name} as passcode id ${passcode.passcode_id}, although TTLock did not confirm the add`,
      );
      return passcode;
    }
    // TTLock's answer says what was added. Reading the list again would cost a call and time HomeKit is waiting, and
    // if that read failed, an add that was done would be answered as failed.
    const cachedPasscodes = device.passcodes ?? [];
    const passcode: Passcode = {
      passcode_id: passcodeId,
      // After the codes already listed: a delete leaves the others' indexes as they are
      index: String(cachedPasscodes.reduce((last, existing) => Math.max(last, Number(existing.index)), -1) + 1),
      lock_id: device.device_id,
      passcode: newPassCode,
    };
    device.passcodes = [...cachedPasscodes, passcode];
    return passcode;
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
    this.log.info(`Deleting passcode id ${passcode.passcode_id} on ${this.name}`);
    await this.deletePasscode(device, passcode);
    return `010105${this.buildPasscodeResponseRecord(passcode)}`;
  }

  // Like an add, a delete that may have reached TTLock is not sent again; the list says whether it took effect
  private async deletePasscode(device: SysInfo, passcode: Passcode): Promise<void> {
    try {
      await this.deviceManager!.managePasscodes(device.device_id, 'delete', passcode.passcode_id);
    } catch (error) {
      const passcodes = await this.recheckPasscodes(device, error);
      if (!passcodes || passcodes.some(existing => existing.passcode_id === passcode.passcode_id)) {
        throw error;
      }
      this.log.info(
        `Passcode id ${passcode.passcode_id} is no longer on ${this.name}, although TTLock did not confirm the delete`,
      );
      return;
    }
    // TTLock confirmed it; as after an add, the list is not read again
    device.passcodes = (device.passcodes ?? []).filter(existing => existing.passcode_id !== passcode.passcode_id);
  }

  private async setAccessCodeControlPoint(device: SysInfo, value: CharacteristicValue): Promise<string> {
    this.setLockBusy(true);
    try {
      const decodedTlv = TlvFactory.parse(Buffer.from(String(value), 'base64').toString('hex'));
      // The records carry the access codes, so log only how many there are
      this.log.debug(`Decoded AccessCodeControlPoint request on ${this.name}: ${decodedTlv.length} TLV record(s)`);

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
