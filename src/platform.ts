import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  WithUUID,
} from 'homebridge';

import HomeKitDevice from './devices/baseDevice.js';
import create from './devices/create.js';
import DeviceManager, { deviceEventEmitter } from './devices/deviceManager.js';
import { parseConfig } from './config.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { TaskQueue } from './taskQueue.js';
import {
  deferAndCombine,
  isObjectLike,
  loadPackageConfig,
  lookup,
  lookupCharacteristicNameByUUID,
  satisfiesVersion,
} from './utils.js';
import { TTLockApi, TTLockApiError, TTLockApiErrorCategory } from './api/ttlockApi.js';
import { ApiCallPriority, UsageTracker } from './api/usageTracker.js';
import type { TTLockAccessCodeConfig } from './config.js';
import type { TTLockDevice } from './devices/deviceTypes.js';
import type { PackageConfig } from './utils.js';

export type TTLockAccessoryContext = {
  kind?: 'ttlock';
  deviceId?: string;
  lastSeen?: Date;
  offline?: boolean;
  // The HomeKit identifier of each access code, by TTLock passcode id. HomeKit keeps them, so they never change.
  passcodeIdentifiers?: Record<string, number>;
  // The identifier the next new access code gets; identifiers are never used again
  nextPasscodeIdentifier?: number;
};

export type ManualDoorAccessoryContext = {
  kind: 'manualDoor';
  lastSeen?: Date;
  manualDoorBatteryPercentage?: number;
  manualDoorId?: string;
  manualDoorLinkedLockId?: string;
  manualDoorOpen?: boolean;
  manualDoorSensorId?: string;
  offline?: boolean;
};

export type TTLockAccessCodeAccessoryContext = TTLockAccessoryContext | ManualDoorAccessoryContext;

// The polling interval all locks share, and when the first round of polls at it started (performance.now())
export type PollingRound = { intervalMs: number; startedAt: number };

let packageConfig: PackageConfig;

const TTLOCK_CREDENTIALS = {
  clientId: 'client ID',
  clientSecret: 'client secret',
  username: 'username',
  password: 'password',
} as const;
// Startup retry after TTLock rejected the login or the API budget ran out: trying again sooner cannot succeed,
// and every login TTLock rejects costs an API call and counts as a failed login on the account
const STARTUP_RETRY_SLOW_MS = 60 * 60 * 1000;
const STARTUP_RETRY_MAX_MS = 5 * 60 * 1000;
// Waits before discovery runs again while no discovery has completed since startup, or while locks known from the
// last run have not been found, instead of the discovery interval (12 h by default). The last wait repeats while no
// discovery has completed; locks that are not found are looked for only this many times.
const DISCOVERY_RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];
// Polling is scheduled again with a new interval once the interval worked out now is this much longer than the one
// in use (polling faster than the budget allows) or this much shorter (polling slower than it needs to)
const POLLING_INTERVAL_MAX_RISE = 0.10;
const POLLING_INTERVAL_MAX_FALL = 0.25;

export default class TTLockAccessCodePlatform implements DynamicPlatformPlugin {
  public readonly Characteristic: typeof Characteristic;
  public readonly configuredAccessories: Map<string, PlatformAccessory<TTLockAccessCodeAccessoryContext>> = new Map();
  public readonly offlineAccessories: Map<string, PlatformAccessory<TTLockAccessCodeAccessoryContext>> = new Map();
  public readonly Service: typeof Service;
  public config: TTLockAccessCodeConfig;
  public deviceManager: DeviceManager | undefined;
  public isShuttingDown: boolean = false;
  public periodicDeviceDiscovering: boolean = false;
  public ttLockApi: TTLockApi | undefined;
  public usageTracker: UsageTracker | undefined;
  public taskQueue: TaskQueue;
  private readonly homekitDevicesById: Map<string, HomeKitDevice> = new Map();
  private deviceDiscoveredHandler: ((device: TTLockDevice) => Promise<void>) | undefined;
  // performance.now() when the running or last discovery started
  private discoveryStartedAt = 0;
  // Discovered locks still being added or updated (see processDiscoveredDevice)
  private readonly devicesBeingProcessed = new Set<Promise<void>>();
  private discoveryInterval: NodeJS.Timeout | undefined;
  // Whether a discovery has completed since Homebridge started
  private discoveryCompleted = false;
  // Runs discovery again soon after startup (see scheduleDiscoveryRetry)
  private discoveryRetryTask: (() => Promise<void>) | undefined;
  private discoveryRetryTimer: NodeJS.Timeout | undefined;
  private discoveryRetryAttempt = 0;
  // Retries made only to look for locks that a completed discovery did not find
  private missingLockRetries = 0;
  private configInvalid = false;
  private platformInitialization: Promise<void>;
  // The wait between TTLock API startup attempts; shutdown wakes it
  private startupRetry: { timer: NodeJS.Timeout; wake: () => void } | undefined;
  private usageTierChangedHandler: (() => void) | undefined;
  private usageMonthStartedHandler: (() => void) | undefined;
  // Every lock polls at the same interval, at its own slot of each round (see getPollingRound)
  private pollingRound: PollingRound | undefined;
  // Checks the interval once a round (see schedulePollingIntervalCheck)
  private pollingCheckTimer: NodeJS.Timeout | undefined;

  constructor(public readonly log: Logging, config: PlatformConfig, public readonly api: API) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    // Homebridge does not catch errors thrown here, so a bad config would stop the whole bridge.
    // Log it and stay idle instead; cached accessories stay registered.
    try {
      this.config = parseConfig(config, message => this.log.warn(message));
    } catch (error) {
      this.log.error(
        `Invalid configuration, so ${PLATFORM_NAME} will not start. Fix the plugin settings and restart Homebridge. ` +
        (error instanceof Error ? error.message : String(error)),
      );
      this.config = parseConfig({});
      this.configInvalid = true;
    }
    this.taskQueue = new TaskQueue(this.log, () => this.isShuttingDown);

    this.setupDeviceEventEmitter('firstDiscovery');

    this.platformInitialization = this.initializePlatform();
    // Handled in the didFinishLaunching listener; without this, a failure before that listener runs is an
    // unhandled rejection, which stops Homebridge
    this.platformInitialization.catch(() => undefined);

    this.api.on('didFinishLaunching', async () => {
      this.log.debug('TTLockAccessCode Platform finished launching');
      try {
        await this.platformInitialization;
      } catch (error) {
        this.log.error(
          `Platform initialization failed, so ${PLATFORM_NAME} will not start: ` +
          (error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      if (this.configInvalid) {
        return;
      }
      // Before startup, which can wait a long time for TTLock: if the initial discovery finds one of these locks
      // again, it registers a new accessory with the same UUID, which Homebridge refuses while the old one is there
      if (this.offlineAccessories.size > 0) {
        this.log.debug('Unregistering offline accessories');
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, Array.from(this.offlineAccessories.values()));
        this.offlineAccessories.clear();
      }
      await this.didFinishLaunching();
    });

    this.api.on('shutdown', async () => {
      this.log.debug('TTLockAccessCode Platform shutting down');
      if (!this.isShuttingDown) {
        this.isShuttingDown = true;
      }
      // First: a lock command or discovery request that is retrying or waiting for the gateway is not sent any more
      this.ttLockApi?.stop();
      this.startupRetry?.wake();
      if (this.discoveryRetryTimer) {
        clearTimeout(this.discoveryRetryTimer);
        this.discoveryRetryTimer = undefined;
      }
      this.clearPollingIntervalCheck();
      if (this.discoveryInterval) {
        clearInterval(this.discoveryInterval);
        this.log.debug('Cleared periodic device discovery interval');
      }
      if (this.deviceDiscoveredHandler) {
        deviceEventEmitter.off('deviceDiscovered', this.deviceDiscoveredHandler);
      }
      this.deviceManager?.stopExternalDoors();
      this.log.debug('Stopping all polling tasks');
      for (const device of this.homekitDevicesById.values()) {
        await device.stopPolling(true);
      }
      this.log.debug('Waiting for tasks to complete');
      try {
        await this.taskQueue.waitForEmptyQueue();
      } catch (error) {
        this.log.error('Error while waiting for task queue to empty during shutdown:', error);
      }
      await this.stopTTLockApi();
    });
  }

  private setupDeviceEventEmitter(mode: string, discoveredDeviceIds?: Set<string>): void {
    if (this.deviceDiscoveredHandler) {
      deviceEventEmitter.off('deviceDiscovered', this.deviceDiscoveredHandler);
    }
    this.log.debug(`Setting up device event emitter: ${mode}`);
    if (mode === 'periodicDiscovery' && discoveredDeviceIds) {
      this.deviceDiscoveredHandler = async (device: TTLockDevice) => {
        this.log.debug(`Device discovered during periodic discovery: ${device.sys_info.device_id}`);
        discoveredDeviceIds.add(device.sys_info.device_id);
        this.log.debug(`Added device ID to discoveredDeviceIds: ${device.sys_info.device_id}`);
        await this.processDiscoveredDevice(device);
      };
    } else {
      this.deviceDiscoveredHandler = async (device: TTLockDevice) => {
        this.log.debug(`Device discovered during initial discovery: ${device.sys_info.device_id}`);
        await this.processDiscoveredDevice(device);
      };
    }
    deviceEventEmitter.on('deviceDiscovered', this.deviceDiscoveredHandler);
  }

  // The deviceDiscovered emit does not wait for its handlers, so discovery ends while the locks it found are still
  // being added. Keep track of them, so discovery can wait until they are all in place.
  private processDiscoveredDevice(device: TTLockDevice): Promise<void> {
    const processing = this.processDevice(device);
    this.devicesBeingProcessed.add(processing);
    return processing.finally(() => this.devicesBeingProcessed.delete(processing));
  }

  private async waitForDiscoveredDevices(): Promise<void> {
    // processDevice handles its own errors, so these never reject
    await Promise.all(this.devicesBeingProcessed);
  }

  async initializePlatform(): Promise<void> {
    packageConfig = await loadPackageConfig(this.log);
    this.logInitializationDetails();
    await this.verifyEnvironment();
  }

  private logInitializationDetails(): void {
    this.log.info(
      `${packageConfig.name} v${packageConfig.version}, node ${process.version}, ` +
      `homebridge v${this.api.serverVersion}, api v${this.api.version} Initializing...`,
    );
  }

  private async verifyEnvironment(): Promise<void> {
    this.log.debug('Verifying environment');

    try {
      this.log.debug('Checking Node.js version');
      if (!satisfiesVersion(process.version, packageConfig.engines.node)) {
        this.log.error(`Error: not using minimum node version ${packageConfig.engines.node}`);
      } else {
        this.log.debug(`Node.js version ${process.version} satisfies the requirement ${packageConfig.engines.node}`);
      }

      this.log.debug('Checking Homebridge version');
      if (!satisfiesVersion(this.api.serverVersion, packageConfig.engines.homebridge)) {
        throw new Error(
          `homebridge-ttlock-accesscode requires Homebridge ${packageConfig.engines.homebridge}. ` +
          `Currently running: ${this.api.serverVersion}`,
        );
      } else {
        this.log.debug(
          `Homebridge version ${this.api.serverVersion} satisfies the requirement ${packageConfig.engines.homebridge}`,
        );
      }
    } catch (error) {
      this.log.error('Error verifying environment:', error);
      throw error;
    }
  }

  private async didFinishLaunching(): Promise<void> {
    this.log.debug('Finished launching');

    // Checked for emptiness only; the values themselves are sent as they are
    const missing = (Object.keys(TTLOCK_CREDENTIALS) as (keyof typeof TTLOCK_CREDENTIALS)[])
      .filter(key => this.config[key].trim().length === 0)
      .map(key => TTLOCK_CREDENTIALS[key]);
    if (missing.length > 0) {
      this.log.error(
        `TTLock ${missing.join(', ')} not set, so ${PLATFORM_NAME} will not start. ` +
        'Set them in the plugin settings and restart Homebridge.',
      );
      return;
    }

    try {
      const apiStarted = await this.startTTLockApiWithRetry();
      if (!apiStarted) {
        this.log.warn('TTLock API did not start before shutdown; skipping device manager startup');
        return;
      }

      this.log.debug('Initializing DeviceManager');
      this.deviceManager = new DeviceManager(this);
      this.log.debug('DeviceManager initialized');
      this.deviceManager.initializeExternalDoors();

      const locksBefore = this.getTTLockDeviceIds().join(',');
      await this.discoverDevices();
      this.log.debug('Device discovery completed');
      if (this.isShuttingDown) {
        return;
      }
      await this.reschedulePollingIfLocksChanged(locksBefore);

      const discoveredDeviceIds = new Set<string>();
      this.setupPeriodicDiscovery(discoveredDeviceIds);
      this.scheduleDiscoveryRetry();
    } catch (error) {
      this.log.error('An error occurred during startup:', error);
    }
  }

  // Never gives up for good: TTLock outages and temporary login rejections clear up without a restart
  private async startTTLockApiWithRetry(): Promise<boolean> {
    let attempt = 0;
    while (!this.isShuttingDown) {
      try {
        await this.startTTLockApi();
        if (this.isShuttingDown) {
          // Shutdown started during the login and its cleanup has run; stop what this attempt set up
          await this.stopTTLockApi();
          return false;
        }
        if (attempt > 0) {
          this.log.info('TTLock API startup recovered after retries');
        }
        return true;
      } catch (error) {
        if (this.isShuttingDown) {
          // startTTLockApi has logged the error; do not wait for a retry that will not run
          return false;
        }
        attempt++;
        const category = error instanceof TTLockApiError ? error.category : undefined;
        const loginRejected = category === TTLockApiErrorCategory.AuthInvalid;
        const delayMs = loginRejected || category === TTLockApiErrorCategory.BudgetExhausted
          ? STARTUP_RETRY_SLOW_MS
          : Math.min(STARTUP_RETRY_MAX_MS, Math.pow(2, Math.min(attempt, 8)) * 1000);
        const delay = delayMs === STARTUP_RETRY_SLOW_MS ? '1 h' : `${Math.floor(delayMs / 1000)}s`;
        this.log.error(
          `TTLock API startup attempt ${attempt} failed; retrying in ${delay}: ` +
          (error instanceof Error ? error.message : String(error)) +
          (loginRejected
            ? '. TTLock rejected the login; check the client ID, client secret, username and password in the plugin settings.'
            : ''),
        );
        await this.sleepUnlessShuttingDown(delayMs);
      }
    }
    return false;
  }

  private sleepUnlessShuttingDown(ms: number): Promise<void> {
    return new Promise(resolve => {
      const wake = () => {
        clearTimeout(timer);
        this.startupRetry = undefined;
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.startupRetry = { timer, wake };
    });
  }

  private setupPeriodicDiscovery(discoveredDeviceIds: Set<string>): void {
    this.log.debug('Setting up periodic device discovery');
    this.setupDeviceEventEmitter('periodicDiscovery', discoveredDeviceIds);

    const discoveryTask = async () => {
      await this.periodicDeviceDiscovery(discoveredDeviceIds);
    };

    const deferredDiscoveryTask = deferAndCombine(discoveryTask, this.config.advancedOptions.waitTimeUpdate);
    this.discoveryRetryTask = async () => {
      await discoveryTask();
      this.scheduleDiscoveryRetry();
    };

    this.discoveryInterval = setInterval(() => {
      try {
        this.taskQueue.addTask(deferredDiscoveryTask);
      } catch (error) {
        this.log.error('Error scheduling periodic device discovery:', error);
      }
    }, this.config.discoveryOptions.discoveryPollingInterval);

    this.log.debug('Periodic device discovery setup completed');
  }

  // A cached lock that discovery has not found has no handlers (HomeKit gets No Response for its writes) and is not
  // polled. Until a discovery has completed and found every lock known from the last run, run it again soon rather
  // than after the discovery interval. A lock deleted from the TTLock account is never found, so missing locks are
  // looked for only a few times; the regular discovery looks for them after that.
  private scheduleDiscoveryRetry(): void {
    if (this.isShuttingDown || this.discoveryRetryTimer || !this.discoveryRetryTask || !this.discoveryRetryNeeded()) {
      return;
    }
    const notFound = this.getLocksNotFound();
    if (this.discoveryCompleted) {
      if (this.missingLockRetries >= DISCOVERY_RETRY_DELAYS_MS.length) {
        this.log.info(
          `Discovery has not found or could not read ${notFound.length} lock(s) known from the last run (${notFound.join(', ')}); ` +
          'the regular discovery keeps looking for them',
        );
        return;
      }
      this.missingLockRetries++;
    }
    const lastDelayMs = DISCOVERY_RETRY_DELAYS_MS[DISCOVERY_RETRY_DELAYS_MS.length - 1] ?? 0;
    const delayMs = Math.min(
      DISCOVERY_RETRY_DELAYS_MS[this.discoveryRetryAttempt] ?? lastDelayMs,
      this.config.discoveryOptions.discoveryPollingInterval,
    );
    this.discoveryRetryAttempt++;
    const delay = delayMs >= 60 * 1000 ? `${Math.round(delayMs / 60000)} min` : `${Math.round(delayMs / 1000)}s`;
    this.log.info(
      (this.discoveryCompleted
        ? `Discovery did not find or could not read ${notFound.length} lock(s) known from the last run (${notFound.join(', ')})`
        : 'Device discovery did not complete') +
      `; trying again in ${delay}`,
    );
    const retryTask = this.discoveryRetryTask;
    this.discoveryRetryTimer = setTimeout(() => {
      this.discoveryRetryTimer = undefined;
      // The regular discovery may have done it meanwhile
      if (this.discoveryRetryNeeded()) {
        this.taskQueue.addTask(retryTask);
      }
    }, delayMs);
  }

  // Discovery is background work, but until one has completed since startup HomeKit cannot lock, unlock or change
  // access codes at all, so until then it may use the API calls kept in reserve for those
  private discoveryPriority(): ApiCallPriority {
    return this.discoveryCompleted ? 'background' : 'user';
  }

  private discoveryRetryNeeded(): boolean {
    return !this.discoveryCompleted || this.getLocksNotFound().length > 0;
  }

  // Cached locks without handlers: discovery has not found them since Homebridge started
  private getLocksNotFound(): string[] {
    return this.getTTLockDeviceIds().filter(deviceId => !this.homekitDevicesById.has(deviceId));
  }

  private async discoverDevices() {
    try {
      if (this.deviceManager) {
        try {
          const deviceCount = this.getTTLockAccessoryCount();
          // lock/list, then lock/detail, lock/queryOpenState and lock/listKeyboardPwd for every lock
          const callsForDiscovery = 1 + (3 * deviceCount);
          if (this.usageTracker) {
            const reserved = await this.usageTracker.beginBatch(callsForDiscovery, 'initialDiscovery', this.discoveryPriority());
            if (!reserved) {
              this.log.info('Skipping initial device discovery due to API usage budget');
              return;
            }
          }
        } catch (error) {
          this.log.debug('Error reserving budget for initial discovery', error);
        }
        this.discoveryStartedAt = performance.now();
        try {
          await this.deviceManager.discoverDevices(undefined, this.discoveryPriority());
        } finally {
          await this.usageTracker?.endBatch();
        }
        await this.waitForDiscoveredDevices();
        this.discoveryCompleted = true;
      }
    } catch (error) {
      if (this.isShuttingDown) {
        this.log.debug(`Device discovery stopped by shutdown: ${error instanceof Error ? error.message : String(error)}`);
      } else {
        this.log.error('Error during discoverDevices:', error);
      }
    }
  }

  private async periodicDeviceDiscovery(discoveredDeviceIds: Set<string>): Promise<void> {
    this.log.debug('Starting periodic device discovery');
    if (this.periodicDeviceDiscovering) {
      this.log.debug('Periodic device discovery already in progress');
      return;
    }
    if (this.isShuttingDown) {
      this.log.debug('Platform is shutting down, skipping periodic device discovery');
      return;
    }
    this.periodicDeviceDiscovering = true;
    let discoverySucceeded = false;
    let skippedForBudget = false;
    const locksBefore = this.getTTLockDeviceIds().join(',');
    discoveredDeviceIds.clear();
    this.log.debug('Cleared discoveredDeviceIds set before discovery.');
    try {
      if (this.deviceManager) {
        // Discovery takes only identity from a lock that is already polled, so it does not read its state: that would
        // cost an API call and a gateway request that can make another lock's poll find the gateway busy
        const skipStateFor = new Set(Array.from(this.homekitDevicesById)
          .filter(([, device]) => !device.ttlockDevice.offline)
          .map(([deviceId]) => deviceId));
        const priority = this.discoveryPriority();
        try {
          const deviceCount = this.getTTLockAccessoryCount();
          // lock/list, lock/detail and lock/listKeyboardPwd for every lock, and lock/queryOpenState for the locks whose
          // state discovery reads
          const callsForDiscovery = 1 + (2 * deviceCount) + Math.max(0, deviceCount - skipStateFor.size);
          if (this.usageTracker) {
            const reserved = await this.usageTracker.beginBatch(callsForDiscovery, 'periodicDiscovery', priority);
            if (!reserved) {
              this.log.info('Skipping periodic device discovery due to API usage budget');
              skippedForBudget = true;
              return;
            }
          }
        } catch (error) {
          this.log.debug('Error reserving budget for periodic discovery', error);
        }
        this.discoveryStartedAt = performance.now();
        try {
          await this.deviceManager.discoverDevices(skipStateFor, priority);
        } finally {
          await this.usageTracker?.endBatch();
        }
        await this.waitForDiscoveredDevices();
        discoverySucceeded = true;
        this.discoveryCompleted = true;
      }
    } catch (error) {
      if (this.isShuttingDown) {
        this.log.debug(`Periodic device discovery stopped by shutdown: ${error instanceof Error ? error.message : String(error)}`);
      } else {
        this.log.error('Error during periodic device discovery:', error);
      }
    } finally {
      if (this.isShuttingDown) {
        // Shutdown stops the requests and drops the locks found after it started, so every lock would look gone
        this.log.debug('Skipping offline accessory reconciliation because Homebridge is shutting down');
      } else if (discoverySucceeded) {
        this.handleOfflineDevices(discoveredDeviceIds);
      } else if (!skippedForBudget) {
        // Nothing failed when it was skipped for the budget
        this.log.warn('Skipping offline accessory reconciliation because periodic discovery did not complete successfully');
      }
      this.periodicDeviceDiscovering = false;
      this.log.debug('Finished periodic device discovery');
    }
    await this.reschedulePollingIfLocksChanged(locksBefore);
  }

  private async processDevice(device: TTLockDevice): Promise<void> {
    this.log.debug(`Processing device: ${device.sys_info.device_id}`);
    try {
      const now = new Date();
      device.last_seen = now;
      device.offline = false;
      const accessory = this.findPlatformAccessory(device.sys_info.device_id);
      if (device.discovery_incomplete) {
        this.keepIncompleteDevice(device, accessory, now);
      } else if (accessory) {
        await this.updateExistingDevice(accessory, device, now);
      } else {
        await this.addNewDevice(device);
      }
    } catch (error) {
      this.log.error(`Error processing device [${device.sys_info.device_id}]:`, error);
    }
  }

  // TTLock lists the lock, but its details could not be read. A lock already in HomeKit stays as it is and counts as
  // seen, so it is not aged out; a new one is added by a discovery that reads its details.
  private keepIncompleteDevice(
    device: TTLockDevice,
    accessory: PlatformAccessory<TTLockAccessCodeAccessoryContext> | undefined,
    now: Date,
  ): void {
    const { alias, device_id: deviceId } = device.sys_info;
    if (accessory) {
      this.log.info(`Keeping [${alias}] [${deviceId}] as it is: TTLock lists it, but its details could not be read`);
      this.updateAccessoryStatus(accessory, now, false);
    } else {
      this.log.info(`Not adding [${alias}] [${deviceId}] yet: its details could not be read. The next discovery tries again.`);
    }
  }

  private handleOfflineDevices(discoveredDeviceIds: Set<string>): void {
    const now = new Date();
    this.configuredAccessories.forEach((accessory, uuid) => {
      if (accessory.context.kind === 'manualDoor') {
        return;
      }
      const deviceId = accessory.context.deviceId;
      if (!deviceId) {
        this.log.warn(`Accessory [${accessory.displayName}] is missing a deviceId.`);
        return;
      }
      if (discoveredDeviceIds.has(deviceId)) {
        this.log.debug(`Accessory [${accessory.displayName}] was discovered and is online.`);
        this.updateAccessoryStatus(accessory, now, false);
      } else {
        this.handleOfflineAccessory(accessory as PlatformAccessory<TTLockAccessoryContext>, uuid, now);
      }
    });
  }

  private handleOfflineAccessory(
    accessory: PlatformAccessory<TTLockAccessoryContext>,
    uuid: string,
    now: Date,
  ): void {
    const timeSinceLastSeen = now.getTime() - new Date(accessory.context.lastSeen || 0).getTime();
    const offlineInterval = this.config.discoveryOptions.offlineInterval;
    if (timeSinceLastSeen > offlineInterval) {
      this.log.info(`Accessory [${accessory.displayName}] is offline and outside the offline interval. Removing.`);
      this.removeTrackedDevice(accessory.context.deviceId, accessory.UUID);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.configuredAccessories.delete(uuid);
    } else if (!accessory.context.offline) {
      this.log.debug(`Accessory [${accessory.displayName}] is offline but within the offline interval.`);
      this.updateAccessoryStatus(accessory, accessory.context.lastSeen || now, true);
    }
  }

  private findPlatformAccessory(deviceId: string): PlatformAccessory<TTLockAccessCodeAccessoryContext> | undefined {
    for (const accessory of this.configuredAccessories.values()) {
      if (accessory.context.kind !== 'manualDoor' && accessory.context.deviceId === deviceId) {
        return accessory;
      }
    }
    return undefined;
  }

  private async updateExistingDevice(
    accessory: PlatformAccessory<TTLockAccessCodeAccessoryContext>,
    device: TTLockDevice,
    now: Date,
  ): Promise<void> {
    this.log.debug(`Device [${device.sys_info.device_id}] is already configured, updating status.`);
    this.updateAccessoryStatus(accessory, now, false);
    const existingDevice = this.homekitDevicesById.get(device.sys_info.device_id);
    if (existingDevice) {
      // Discovery only refreshes identity, so it applies even while a poll or lock command is in flight
      existingDevice.updateFromDiscovery(device, this.discoveryStartedAt);
      if (existingDevice.ttlockDevice.offline && device.sys_info.state !== undefined) {
        // Discovery read the state of a lock that has not answered its last polls; nothing more is sent to it
        this.log.debug(`Device [${device.sys_info.device_id}] has not answered its last polls, but discovery read it.`);
        existingDevice.applyStateFromDiscovery(device.sys_info.state, this.discoveryStartedAt);
      } else if (existingDevice.ttlockDevice.offline) {
        // It still polls, so it recovers as soon as a poll reads it
        this.log.debug(`Device [${device.sys_info.device_id}] has not answered its last polls, and discovery could not read it.`);
      } else {
        // Its own polling keeps the state current; discovery only refreshed its identity
        this.log.debug(`Updated existing HomeKit device [${device.sys_info.device_id}] from discovery.`);
      }
    } else {
      await this.addNewDevice(device);
    }
  }

  private async addNewDevice(device: TTLockDevice): Promise<void> {
    this.log.debug(`New device [${device.sys_info.device_id}] found, adding to HomeKit.`);
    if (device.sys_info.state === undefined) {
      // Discovery could not read the state; show it as unknown until the first poll reads it
      device.sys_info.state = this.Characteristic.LockCurrentState.UNKNOWN;
    }
    await this.foundDevice(device);
  }

  private updateAccessoryStatus(
    accessory: PlatformAccessory<TTLockAccessCodeAccessoryContext>,
    lastSeen: Date,
    offline: boolean,
  ): void {
    const offlineStatusChanged = accessory.context.offline !== offline;

    accessory.context.lastSeen = lastSeen;
    accessory.context.offline = offline;

    if (offlineStatusChanged) {
      this.api.updatePlatformAccessories([accessory]);
    }
  }

  private async startTTLockApi(): Promise<void> {
    this.log.debug('Starting TTLock API');

    try {
      await this.createAndAuthenticateApi();
      this.log.debug('TTLock API started');
    } catch (error) {
      await this.stopTTLockApi();
      this.log.error(`Error starting TTLock API: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  private async stopTTLockApi(): Promise<void> {
    this.log.debug('Stopping TTLock API');

    if (this.usageTracker) {
      if (this.usageTierChangedHandler) {
        this.usageTracker.off('tierChanged', this.usageTierChangedHandler);
        this.usageTierChangedHandler = undefined;
      }
      if (this.usageMonthStartedHandler) {
        this.usageTracker.off('monthStarted', this.usageMonthStartedHandler);
        this.usageMonthStartedHandler = undefined;
      }
      await this.usageTracker.stop();
      this.usageTracker = undefined;
    }

    if (this.ttLockApi) {
      this.log.debug('Releasing TTLock API client');
      this.ttLockApi.stop();
      this.ttLockApi = undefined;
    } else {
      this.log.debug('No TTLock API client to release');
    }
  }

  private async createAndAuthenticateApi() {
    this.log.debug('Creating and authenticating TTLock API...');
    try {
      this.log.debug('Initializing UsageTracker...');
      const usageTracker = new UsageTracker(this.api, this.log, this.config.totalApiCallsPerMonth);
      await usageTracker.init();
      // Stored only after init(), which starts an hourly timer: a stopTTLockApi() during init() would drop the
      // tracker before that timer exists, and nothing would ever clear it
      this.usageTracker = usageTracker;
      this.log.debug('UsageTracker initialized');
      this.usageTierChangedHandler = () => {
        this.log.info('API usage tier changed - recalculating polling intervals...');
        void this.reschedulePolling();
      };
      this.usageTracker.on('tierChanged', this.usageTierChangedHandler);
      // The interval was paced from last month's budget
      this.usageMonthStartedHandler = () => {
        this.log.debug('New API usage month - recalculating polling intervals');
        void this.reschedulePolling();
      };
      this.usageTracker.on('monthStarted', this.usageMonthStartedHandler);
    } catch (err) {
      this.log.error('Failed to initialize usage tracker', err);
      this.usageTracker = undefined;
      this.usageTierChangedHandler = undefined;
      this.usageMonthStartedHandler = undefined;
    }

    if (this.isShuttingDown) {
      // Do not log in during shutdown; startTTLockApiWithRetry stops the tracker
      return;
    }

    this.log.debug('Initializing TTLockApi...');
    this.ttLockApi = new TTLockApi(this.log, this.config.clientId, this.config.clientSecret, this.usageTracker);
    await this.ttLockApi.authenticate(this.config.username, this.config.password);
  }

  public computeEffectivePollingInterval(deviceCount: number, userIntervalMs: number): number {
    if (!this.usageTracker) {
      return userIntervalMs;
    }
    const usage = this.usageTracker.getUsage();
    const daysRemaining = usage.daysRemaining ?? usage.daysInMonth;
    const remainingDailyAllowance = (usage.remainingDailyAllowance !== undefined)
      ? usage.remainingDailyAllowance
      : Math.floor((usage.totalAllowed - usage.used) / Math.max(1, daysRemaining));
    // Periodic discovery calls lock/list, and lock/detail and lock/listKeyboardPwd for every lock
    const discoveryCallsPerDay = (1 + 2 * deviceCount) * 86400000 / this.config.discoveryOptions.discoveryPollingInterval;
    const pollingBudgetPerDay = Math.max(0, Math.floor(remainingDailyAllowance * 0.8 - discoveryCallsPerDay));
    // A poll is lock/queryOpenState, which also returns the battery level; a lock that leaves it out takes a second call.
    // Each lock counts as one call plus the share of its recent polls that took two, and polls it has not had yet count
    // as two (see TTLockApi.estimatePollCalls), so polling never starts out faster than the budget allows. A lock
    // without a known id counts as two.
    const lockIds = this.getTTLockDeviceIds();
    const lockPollCalls = this.ttLockApi?.estimatePollCalls(lockIds) ?? 2 * lockIds.length;
    const estimatedCallsPerPoll = Math.max(1, lockPollCalls + 2 * Math.max(0, deviceCount - lockIds.length));
    const maxPollsPerDay = Math.max(1, Math.floor(pollingBudgetPerDay / estimatedCallsPerPoll));
    const basePollingIntervalSec = Math.max(1, Math.floor(86400 / maxPollsPerDay));

    const remainingFraction = usage.totalAllowed === 0 ? 0 : usage.remaining / usage.totalAllowed;
    let multiplier = 1.0;
    if (remainingFraction < 0.05) {
      multiplier = 8.0;
    } else if (remainingFraction < 0.10) {
      multiplier = 4.0;
    } else if (remainingFraction < 0.20) {
      multiplier = 2.0;
    } else if (remainingFraction < 0.50) {
      multiplier = 1.5;
    }

    const minPollSec = 30;
    const maxPollSec = 3600;
    const finalSec = Math.min(Math.max(basePollingIntervalSec * multiplier, minPollSec), maxPollSec);
    const finalMs = Math.floor(finalSec * 1000);
    return Math.max(userIntervalMs, finalMs);
  }

  private computePollingInterval(): number {
    return this.computeEffectivePollingInterval(this.getTTLockAccessoryCount(), this.config.discoveryOptions.pollingInterval);
  }

  // The interval every lock polls at, and when the first round at it started. A lock polls at its own slot of each
  // round (see getPollingSlot). With one interval for all locks the slots stay the same distance apart; locks that
  // each worked out their own interval drifted into each other's slots, and a lock whose slot falls inside another
  // lock's gateway request is skipped.
  public getPollingRound(): PollingRound {
    return this.pollingRound ?? this.startPollingRound();
  }

  private startPollingRound(): PollingRound {
    const round = { intervalMs: this.computePollingInterval(), startedAt: performance.now() };
    this.pollingRound = round;
    this.log.debug(`Polling every ${round.intervalMs}ms`);
    this.schedulePollingIntervalCheck(round, 1);
    return round;
  }

  // Once a round, just after its last slot, when every lock has been polled at the interval in use: polls show which
  // locks take a second call, and the daily allowance changes during the month. Polling is scheduled again only when
  // the interval worked out now is well off the one in use, so at most once a round. Each poll moves the calls a
  // round is paced for by only a fraction of a call (see TTLockApi.estimatePollCalls), so a lock whose battery level
  // comes and goes seldom puts the interval well off, though with one or two locks it still does now and then. After
  // startup, when every lock counts as two calls, the interval comes down in steps over about eight polls of each lock
  // as they show which locks take one.
  private schedulePollingIntervalCheck(round: PollingRound, rounds: number): void {
    this.clearPollingIntervalCheck();
    if (this.isShuttingDown) {
      return;
    }
    const slots = Math.max(1, this.getTTLockDeviceIds().length);
    const checkAt = round.startedAt + rounds * round.intervalMs + Math.floor(round.intervalMs / (2 * slots));
    this.pollingCheckTimer = setTimeout(() => {
      this.pollingCheckTimer = undefined;
      if (this.isShuttingDown || this.pollingRound !== round) {
        return;
      }
      if (this.homekitDevicesById.size === 0) {
        // Nothing polls; the next lock that starts polling starts a new round
        this.pollingRound = undefined;
        return;
      }
      const intervalMs = this.computePollingInterval();
      if (intervalMs > round.intervalMs * (1 + POLLING_INTERVAL_MAX_RISE) ||
        intervalMs < round.intervalMs * (1 - POLLING_INTERVAL_MAX_FALL)) {
        this.log.debug(`The polling interval is now ${intervalMs}ms instead of ${round.intervalMs}ms`);
        void this.reschedulePolling();
      } else {
        this.schedulePollingIntervalCheck(round, rounds + 1);
      }
    }, Math.max(0, checkAt - performance.now()));
    // Only the locks' polls keep the process running; once every lock has stopped polling, this check must not
    this.pollingCheckTimer.unref();
  }

  private clearPollingIntervalCheck(): void {
    if (this.pollingCheckTimer) {
      clearTimeout(this.pollingCheckTimer);
      this.pollingCheckTimer = undefined;
    }
  }

  // Position of a lock among all locks, used to spread their polls across the polling interval
  public getPollingSlot(deviceId: string): { index: number; count: number } {
    const deviceIds = this.getTTLockDeviceIds();
    return { index: Math.max(0, deviceIds.indexOf(deviceId)), count: Math.max(1, deviceIds.length) };
  }

  private getTTLockDeviceIds(): string[] {
    return Array.from(this.configuredAccessories.values())
      .flatMap(accessory => (accessory.context.kind !== 'manualDoor' && accessory.context.deviceId) ? [accessory.context.deviceId] : [])
      .sort();
  }

  public getTTLockAccessoryCount(): number {
    return Array.from(this.configuredAccessories.values())
      .filter(accessory => accessory.context.kind !== 'manualDoor')
      .length;
  }

  // Each lock's poll slot and the polling interval depend on all the locks, but a lock that discovery adds starts
  // polling before the locks after it are added. Once a discovery has added or removed locks, schedule them all again.
  private async reschedulePollingIfLocksChanged(locksBefore: string): Promise<void> {
    if (this.getTTLockDeviceIds().join(',') !== locksBefore) {
      await this.reschedulePolling();
    }
  }

  // A new round with the interval worked out now, for all locks at once so they keep their slots apart
  private async reschedulePolling(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.log.debug('Rescheduling polling for all devices');
    this.startPollingRound();
    for (const device of this.homekitDevicesById.values()) {
      try {
        await device.startPolling();
      } catch (err) {
        this.log.debug('Error rescheduling polling for device', err);
      }
    }
  }

  public lsc(
    serviceOrCharacteristic: Service | Characteristic | { UUID: string },
    characteristic?: Characteristic | { UUID: string },
  ): string {
    const serviceName = serviceOrCharacteristic instanceof this.api.hap.Service
      ? this.getServiceName(serviceOrCharacteristic)
      : undefined;

    const characteristicName = characteristic instanceof this.api.hap.Characteristic
      ? this.getCharacteristicName(characteristic)
      : serviceOrCharacteristic instanceof this.api.hap.Characteristic || 'UUID' in serviceOrCharacteristic
        ? this.getCharacteristicName(serviceOrCharacteristic)
        : undefined;

    const result = `[${serviceName ? serviceName : ''}` +
                   `${serviceName && characteristicName ? '.' : ''}` +
                   `${characteristicName ? characteristicName : ''}]`;
    return result;
  }

  getServiceName(service: { UUID: string }): string | undefined {
    const serviceName = lookup(this.api.hap.Service, (objectProp, value) =>
      isObjectLike(objectProp) && 'UUID' in objectProp && objectProp.UUID === value, service.UUID);
    return serviceName;
  }

  getCharacteristicName(characteristic: WithUUID<{ name?: string | null; displayName?: string | null }>): string | undefined {
    const name = characteristic.name;
    const displayName = characteristic.displayName;
    const lookupName = lookupCharacteristicNameByUUID(this.api.hap.Characteristic, characteristic.UUID);
    return name ?? displayName ?? lookupName;
  }

  registerPlatformAccessory(accessory: PlatformAccessory<TTLockAccessCodeAccessoryContext>): void {
    this.log.debug('Registering platform accessory:', accessory.displayName);

    if (!this.configuredAccessories.has(accessory.UUID)) {
      this.log.debug(`Platform Accessory ${accessory.displayName} is not in configuredAccessories, adding it.`);
      this.configuredAccessories.set(accessory.UUID, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.log.debug(`Platform Accessory ${accessory.displayName} registered with Homebridge.`);
    } else {
      this.log.debug(`Platform Accessory ${accessory.displayName} is already in configuredAccessories.`);
    }
  }

  configureAccessory(accessory: PlatformAccessory<TTLockAccessCodeAccessoryContext>): void {
    this.log.debug(`Configuring Platform Accessory: [${accessory.displayName}] UUID: ${accessory.UUID}`);

    if (accessory.context.kind === 'manualDoor') {
      this.log.debug(`Configuring cached manual door accessory: [${accessory.displayName}]`);
      this.configuredAccessories.set(accessory.UUID, accessory);
      return;
    }

    if (!accessory.context.lastSeen && !accessory.context.offline) {
      this.log.debug(`Setting initial lastSeen and offline status for Platform Accessory: [${accessory.displayName}]`);
      accessory.context.lastSeen = new Date();
      accessory.context.offline = false;
    }

    // Also for a lock moved to offlineAccessories below: it stays in HomeKit when the config is invalid or
    // initialization failed
    this.refuseWritesUntilFound(accessory);

    if (accessory.context.lastSeen) {
      const now = new Date();
      const timeSinceLastSeen = now.getTime() - new Date(accessory.context.lastSeen).getTime();
      const offlineInterval = this.config.discoveryOptions.offlineInterval;

      this.log.debug(`Platform Accessory [${accessory.displayName}] last seen ${timeSinceLastSeen}ms ago, ` +
        `offline interval is ${offlineInterval}ms, offline status: ${accessory.context.offline}`);

      if (timeSinceLastSeen > offlineInterval && accessory.context.offline === true) {
        this.log.info(
          `Platform Accessory [${accessory.displayName}] is offline and outside the offline interval, ` +
          'moving to offlineAccessories',
        );
        this.configuredAccessories.delete(accessory.UUID);
        this.offlineAccessories.set(accessory.UUID, accessory);
        return;
      } else if (timeSinceLastSeen < offlineInterval && accessory.context.offline === true) {
        this.log.debug(`Platform Accessory [${accessory.displayName}] is offline and within offline interval.`);
      } else if (accessory.context.offline === false) {
        this.log.debug(`Platform Accessory [${accessory.displayName}] is online, updating lastSeen time.`);
        this.updateAccessoryStatus(accessory, now, false);
      }
    }

    if (!this.configuredAccessories.has(accessory.UUID)) {
      this.log.debug(
        `Platform Accessory [${accessory.displayName}] with UUID [${accessory.UUID}] ` +
        'is not in configuredAccessories, adding it.',
      );
      this.configuredAccessories.set(accessory.UUID, accessory);
    } else {
      this.log.debug(
        `Platform Accessory [${accessory.displayName}] with UUID ` +
        `[${accessory.UUID}] is already in configuredAccessories.`,
      );
    }
  }

  // A cached lock has no handlers until discovery finds it and the lock sets its own, which replace these. Until then
  // HomeKit would accept a lock/unlock or access-code write and drop it, so it answers No Response instead. Reads show
  // the cached values.
  private refuseWritesUntilFound(accessory: PlatformAccessory<TTLockAccessCodeAccessoryContext>): void {
    const { Characteristic: C, HapStatusError, HAPStatus } = this.api.hap;
    const writable = [C.LockTargetState, C.AccessCodeControlPoint];
    for (const service of accessory.services) {
      for (const type of writable) {
        if (service.testCharacteristic(type)) {
          service.getCharacteristic(type).onSet(() => {
            this.log.warn(`[${accessory.displayName}] has not been found since Homebridge started, so the write was not sent.`);
            throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          });
        }
      }
    }
  }

  private async foundDevice(device: TTLockDevice): Promise<void> {
    const { sys_info: { alias: deviceAlias, device_id: deviceId } } = device;

    if (!deviceId) {
      this.log.error('Missing deviceId:', deviceAlias);
      return;
    }

    const existingDevice = this.homekitDevicesById.get(deviceId);
    if (existingDevice) {
      if (!this.configuredAccessories.has(existingDevice.homebridgeAccessory.UUID)) {
        this.log.warn(`HomeKit device [${deviceAlias}] [${deviceId}] is missing its accessory. Recreating it.`);
        this.removeTrackedDevice(deviceId, existingDevice.homebridgeAccessory.UUID);
      } else {
        this.log.info(`HomeKit device already added: [${deviceAlias}] [${deviceId}]`);
        return;
      }
    }

    this.log.info(`Adding HomeKit device: [${deviceAlias}] [${deviceId}]`);
    const homekitDevice = await this.createHomeKitDevice(device) as HomeKitDevice | undefined;
    if (homekitDevice) {
      this.homekitDevicesById.set(deviceId, homekitDevice);
      this.log.debug(`HomeKit device [${deviceAlias}] [${deviceId}] successfully added`);
    } else {
      this.log.error(`Failed to add HomeKit device for: [${deviceAlias}] [${deviceId}]`);
    }
  }

  private async createHomeKitDevice(ttlockDevice: TTLockDevice): Promise<HomeKitDevice | undefined> {
    // Never log the access codes themselves
    const { passcodes, ...sysInfo } = ttlockDevice.sys_info;
    this.log.debug('Creating HomeKit device for:', { ...sysInfo, passcodes: passcodes?.length ?? 0 });
    return await create(this, ttlockDevice);
  }

  private removeTrackedDevice(deviceId: string | undefined, accessoryUuid: string): void {
    if (!deviceId) {
      return;
    }

    const trackedDevice = this.homekitDevicesById.get(deviceId);
    if (!trackedDevice) {
      return;
    }

    if (trackedDevice.homebridgeAccessory.UUID !== accessoryUuid) {
      this.log.debug(
        `Skipping tracked device cleanup for [${deviceId}] because UUIDs do not match ` +
        `(${trackedDevice.homebridgeAccessory.UUID} !== ${accessoryUuid}).`,
      );
      return;
    }

    this.homekitDevicesById.delete(deviceId);
    trackedDevice.removeFromPlatform();
    this.log.debug(`Removed tracked HomeKit device for [${deviceId}].`);
  }
}
