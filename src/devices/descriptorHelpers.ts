import type { Characteristic, CharacteristicValue } from 'homebridge';

import type { CharacteristicDescriptor, DescriptorContext } from './deviceTypes.js';

export function buildLockDescriptors(
  C: typeof Characteristic,
  setTarget: (value: number | CharacteristicValue, context: DescriptorContext) => Promise<void>,
): CharacteristicDescriptor[] {
  return [
    {
      type: C.LockCurrentState,
      name: 'LockCurrentState',
      writable: false,
      syncGroup: 'lockState',
      getInitial: context => context!.device.ttlockDevice.sys_info.state ?? C.LockCurrentState.SECURED,
      getCurrent: context => context!.device.ttlockDevice.sys_info.state ?? C.LockCurrentState.SECURED,
    },
    {
      type: C.LockTargetState,
      name: 'LockTargetState',
      writable: true,
      syncGroup: 'lockState',
      getInitial: context => context!.device.ttlockDevice.sys_info.state ?? C.LockTargetState.SECURED,
      getCurrent: context => context!.device.ttlockDevice.sys_info.state ?? C.LockTargetState.SECURED,
      applySet: async (value, context) => {
        await setTarget(Number(value), context);
        context.device.ttlockDevice.sys_info.state = Number(value);
        context.device.updateDeviceField('state', context.device.ttlockDevice.sys_info.state);
      },
    },
  ];
}

export function buildBatteryDescriptors(C: typeof Characteristic): CharacteristicDescriptor[] {
  return [
    {
      type: C.BatteryLevel,
      name: 'BatteryLevel',
      writable: false,
      getInitial: context => context!.device.ttlockDevice.sys_info.battery ?? 100,
      getCurrent: context => context!.device.ttlockDevice.sys_info.battery ?? 100,
    },
    {
      type: C.StatusLowBattery,
      name: 'StatusLowBattery',
      writable: false,
      getInitial: context => {
        return (context!.device.ttlockDevice.sys_info.battery < 20)
          ? C.StatusLowBattery.BATTERY_LEVEL_LOW
          : C.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      },
      getCurrent: context => {
        return (context!.device.ttlockDevice.sys_info.battery < 20)
          ? C.StatusLowBattery.BATTERY_LEVEL_LOW
          : C.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      },
    },
  ];
}

export function buildAccessCodeDescriptors(
  C: typeof Characteristic,
  getAccessCodeSupportedConfiguration: () => string,
  setAccessCodeControlPoint: (value: CharacteristicValue, context: DescriptorContext) => Promise<string>,
  getConfigurationState: () => number,
): CharacteristicDescriptor[] {
  return [
    {
      type: C.AccessCodeSupportedConfiguration,
      name: 'AccessCodeSupportedConfiguration',
      writable: false,
      getInitial: () => getAccessCodeSupportedConfiguration() ?? 'AQEBAgEGAwEJBAEK',
      getCurrent: () => getAccessCodeSupportedConfiguration() ?? 'AQEBAgEGAwEJBAEK',
    },
    {
      type: C.AccessCodeControlPoint,
      name: 'AccessCodeControlPoint',
      writable: true,
      getInitial: () => '',
      getCurrent: () => '',
      applySet: async (value, context) => {
        const result = await setAccessCodeControlPoint(value, context);
        context.device.updateDeviceField('passcodes', context.device.ttlockDevice.sys_info.passcodes!);
        return result;
      },
    },
    {
      type: C.ConfigurationState,
      name: 'ConfigurationState',
      writable: false,
      getInitial: () => getConfigurationState() ?? 1,
      getCurrent: () => getConfigurationState() ?? 1,
    },
  ];
}