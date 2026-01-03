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
          await this.deviceManager!.controlDevice(context.device.id, 'state', value);
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
          return await this.setAccessCodeControlPoint(context.device.ttlockDevice.sys_info, value);
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

  private async setAccessCodeControlPoint(device: SysInfo, value: CharacteristicValue): Promise<string> {
    try {
      this.lockBusy = true;
      this.isUpdating = true;

      const decodedTlv = TlvFactory.parse(Buffer.from(String(value), 'base64').toString('hex'));
      this.log.debug(`Decoded TLV for AccessCodeControlPoint on ${this.name}:`, decodedTlv);

      let responseTlv = '';
      let response = '';
      let requestType = '';
      let identifier = '', accessCode = '', flags = '', status = '';

      switch (Number(decodedTlv[0].value.toString('hex'))) {
        case 1: {
          requestType = 'List';
          responseTlv = '010101';
          device.passcodes!.forEach((pc, index) => {
            identifier = TlvFactory.serialize(TlvFactory.primitiveTlv('01', String(pc.index).padStart(2, '0'))).toString('hex');
            accessCode = TlvFactory.serialize(
              TlvFactory.primitiveTlv('02', Buffer.from(pc.passcode).toString('hex')),
            ).toString('hex');
            flags = TlvFactory.serialize(TlvFactory.primitiveTlv('03', '00')).toString('hex');
            status = TlvFactory.serialize(TlvFactory.primitiveTlv('04', '00')).toString('hex');
            this.log.debug(`Passcode ${pc.passcode} found on ${this.name}`);
            responseTlv += TlvFactory.serialize(
              TlvFactory.primitiveTlv('03', identifier + accessCode + flags + status),
            ).toString('hex') + (index !== (device.passcodes!.length - 1) ? '0000' : '');
          });
          response = Buffer.from(responseTlv, 'hex').toString('base64');
          break;
        }
        case 2: {
          requestType = 'Read';
          responseTlv = '010102';
          if (device.passcodes!.length > 0) {
            for (let index = 1; index < decodedTlv.length; ++index) {
              const element = decodedTlv[index];
              const readReq = TlvFactory.parse(element.value);
              if (readReq.length > 0) {
                const passcodeIndexHex = readReq[0].value.toString('hex');
                const passcodeIndex = parseInt(passcodeIndexHex, 16);
                const pc = device.passcodes![passcodeIndex];
                if (pc) {
                  this.log.debug(`Reading passcode ${pc.passcode} on ${this.name}`);
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
              ).toString('hex') + (index !== (decodedTlv.length - 1) ? '0000' : '');
            }
          }
          response = Buffer.from(responseTlv, 'hex').toString('base64');
          break;
        }
        case 3: {
          requestType = 'Add';
          responseTlv = '010103';
          for (let index = 1; index < decodedTlv.length; index++) {
            const addReq = TlvFactory.parse(decodedTlv[index].value);
            if (addReq.length > 0) {
              const newPassCodeHex = addReq[0];
              const newPassCode = newPassCodeHex.value.toString();
              let pc: Passcode | undefined = device.passcodes!.find(p => p.passcode === newPassCode);
              if (!pc) {
                this.log.info(`Adding new passcode ${newPassCode} to ${this.name}`);
                try {
                  const newPc = await this.deviceManager!
                    .managePasscodes(device.device_id, 'add', newPassCode) as { keyboardPwdId: string };
                  device.passcodes! = await this.deviceManager!.managePasscodes(device.device_id, 'get') as Passcode[];
                  pc = device.passcodes!.find(
                    (p: Passcode) =>
                      p.passcode_id === newPc.keyboardPwdId.toString() ||
                      p.passcode === newPassCode,
                  );
                } catch (err) {
                  this.log.error(`Failed to add passcode ${newPassCode} to ${this.name}`, err);
                }
              } else {
                this.log.debug(`Passcode ${newPassCode} already exists on ${this.name}`);
              }
              if (pc) {
                identifier = TlvFactory.serialize(TlvFactory.primitiveTlv('01', String(pc.index).padStart(2, '0'))).toString('hex');
                accessCode = TlvFactory.serialize(
                  TlvFactory.primitiveTlv('02', Buffer.from(pc.passcode).toString('hex')),
                ).toString('hex');
                flags = TlvFactory.serialize(TlvFactory.primitiveTlv('03', '00')).toString('hex');
                status = TlvFactory.serialize(TlvFactory.primitiveTlv('04', '00')).toString('hex');
                responseTlv += TlvFactory.serialize(
                  TlvFactory.primitiveTlv('03', identifier + accessCode + flags + status),
                ).toString('hex') + (index !== (decodedTlv.length - 1) ? '0000' : '');
              }
            }
          }
          response = Buffer.from(responseTlv, 'hex').toString('base64');
          break;
        }
        case 5: {
          requestType = 'Delete';
          responseTlv = '010105';
          const deleteReq = TlvFactory.parse(decodedTlv[1].value);
          if (deleteReq.length > 0) {
            const deletePassCodeIndexHex = deleteReq[0].value.toString('hex');
            const deletePassCodeIndex = parseInt(deletePassCodeIndexHex, 16);
            const pc = device.passcodes![deletePassCodeIndex];
            if (pc) {
              this.log.info(`Deleting passcode ${pc.passcode} on ${this.name}`);
              await this.deviceManager!.managePasscodes(device.device_id, 'delete', pc.passcode_id);
              device.passcodes! = await this.deviceManager!.managePasscodes(device.device_id, 'get') as Passcode[];
              identifier = TlvFactory.serialize(TlvFactory.primitiveTlv('01', String(pc.index).padStart(2, '0'))).toString('hex');
              accessCode = TlvFactory.serialize(
                TlvFactory.primitiveTlv('02', Buffer.from(pc.passcode).toString('hex')),
              ).toString('hex');
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

      this.log.info(`Access Code Control ${requestType} Request completed for ${this.name}`);
      return response;
    } catch (error) {
      this.log.error('Error processing AccessCodeControlPoint', error);
      this.ttlockDevice.offline = true;
      await this.stopPolling();
      return '';
    } finally {
      this.lockBusy = false;
      this.isUpdating = false;
      this.updateEmitter.emit('updateComplete');
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