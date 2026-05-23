import type { Characteristic, CharacteristicValue } from 'homebridge';

import type { CharacteristicDescriptor, DescriptorContext } from './deviceTypes.js';

export function buildLockDescriptors(
  C: typeof Characteristic,
  setTarget: (value: number | CharacteristicValue, context: DescriptorContext) => Promise<boolean | void>,
): CharacteristicDescriptor[] {
  return [
    {
      type: C.LockCurrentState,
      name: 'LockCurrentState',
      writable: false,
      syncGroup: 'lockState',
      syncHomeKitValueAfterSet: true,
      getInitial: context => context!.device.state ?? C.LockCurrentState.SECURED,
      getCurrent: context => context!.device.state ?? C.LockCurrentState.SECURED,
    },
    {
      type: C.LockTargetState,
      name: 'LockTargetState',
      writable: true,
      syncGroup: 'lockState',
      syncHomeKitValueAfterSet: true,
      getInitial: context => context!.device.state ?? C.LockTargetState.SECURED,
      getCurrent: context => context!.device.state ?? C.LockTargetState.SECURED,
      applySet: async (value, context) => {
        const applied = await setTarget(Number(value), context);
        if (applied === false) {
          return;
        }
        context.device.state = Number(value);
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
      getInitial: context => context!.device.battery ?? 100,
      getCurrent: context => context!.device.battery ?? 100,
    },
    {
      type: C.StatusLowBattery,
      name: 'StatusLowBattery',
      writable: false,
      getInitial: context => {
        return (context!.device.battery < 20)
          ? C.StatusLowBattery.BATTERY_LEVEL_LOW
          : C.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      },
      getCurrent: context => {
        return (context!.device.battery < 20)
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
      applySet: async (value, context) => await setAccessCodeControlPoint(value, context),
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
