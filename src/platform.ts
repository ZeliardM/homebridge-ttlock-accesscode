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
import DeviceManager from './devices/deviceManager.js';
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
import { UsageTracker } from './api/usageTracker.js';
import { deviceEventEmitter } from './devices/deviceManager.js';
import type { TTLockAccessCodeConfig } from './config.js';
import type { TTLockDevice } from './devices/deviceTypes.js';
import type { PackageConfig } from './utils.js';

export type TTLockAccessoryContext = {
  kind?: 'ttlock';
  deviceId?: string;
  lastSeen?: Date;
  offline?: boolean;
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
  private configInvalid = false;
  private platformInitialization: Promise<void>;
  // The wait between TTLock API startup attempts; shutdown wakes it
  private startupRetry: { timer: NodeJS.Timeout; wake: () => void } | undefined;
  private usageTierChangedHandler: (() => void) | undefined;

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
      this.startupRetry?.wake();
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

    this.discoveryInterval = setInterval(() => {
      try {
        this.taskQueue.addTask(deferredDiscoveryTask);
      } catch (error) {
        this.log.error('Error scheduling periodic device discovery:', error);
      }
    }, this.config.discoveryOptions.discoveryPollingInterval);

    this.log.debug('Periodic device discovery setup completed');
  }

  private async discoverDevices() {
    try {
      if (this.deviceManager) {
        try {
          const deviceCount = this.getTTLockAccessoryCount();
          const callsForDiscovery = 1 + (2 * deviceCount);
          if (this.usageTracker) {
            const reserved = await this.usageTracker.beginBatch(callsForDiscovery, 'initialDiscovery');
            if (!reserved) {
              this.log.info('Skipping initial device discovery due to API usage budget');
              return;
            }
          }
        } catch (error) {
          this.log.debug('Error reserving budget for initial discovery', error);
        }
        this.discoveryStartedAt = performance.now();
        await this.deviceManager.discoverDevices();
        await this.waitForDiscoveredDevices();
      }
    } catch (error) {
      this.log.error('Error during discoverDevices:', error);
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
        try {
          const deviceCount = this.getTTLockAccessoryCount();
          // lock/list, lock/detail and lock/listKeyboardPwd for every lock, and lock/queryOpenState for the locks whose
          // state discovery reads
          const callsForDiscovery = 1 + (2 * deviceCount) + Math.max(0, deviceCount - skipStateFor.size);
          if (this.usageTracker) {
            const reserved = await this.usageTracker.beginBatch(callsForDiscovery, 'periodicDiscovery');
            if (!reserved) {
              this.log.info('Skipping periodic device discovery due to API usage budget');
              return;
            }
          }
        } catch (error) {
          this.log.debug('Error reserving budget for periodic discovery', error);
        }
        this.discoveryStartedAt = performance.now();
        await this.deviceManager.discoverDevices(skipStateFor);
        await this.waitForDiscoveredDevices();
        discoverySucceeded = true;
      }
    } catch (error) {
      this.log.error('Error during periodic device discovery:', error);
    } finally {
      if (discoverySucceeded) {
        this.handleOfflineDevices(discoveredDeviceIds);
      } else {
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
      if (accessory) {
        await this.updateExistingDevice(accessory, device, now);
      } else {
        await this.addNewDevice(device);
      }
    } catch (error) {
      this.log.error(`Error processing device [${device.sys_info.device_id}]:`, error);
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
      if (existingDevice.ttlockDevice.offline) {
        // Its polling stopped when it went offline: read it now and poll it again
        this.log.debug(`Device [${device.sys_info.device_id}] was offline and is now online. Reading it and starting polling.`);
        existingDevice.ttlockDevice.offline = false;
        existingDevice.updateAfterPeriodicDiscovery();
        await existingDevice.startPolling();
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
      this.log.debug('TTLock API process started successfully');
    } catch (error) {
      await this.stopTTLockApi();
      this.log.error(`Error starting TTLock API process: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
      await this.usageTracker.stop();
      this.usageTracker = undefined;
    }

    if (this.ttLockApi) {
      this.log.debug('TTLock API process found, attempting to kill the process');
      this.ttLockApi = undefined;
      this.log.debug('TTLock API process successfully killed');
    } else {
      this.log.debug('No TTLock API process found to stop');
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
    } catch (err) {
      this.log.error('Failed to initialize usage tracker', err);
      this.usageTracker = undefined;
      this.usageTierChangedHandler = undefined;
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
    const pollingBudgetPerDay = Math.floor(remainingDailyAllowance * 0.8);
    const estimatedCallsPerPoll = Math.max(1, deviceCount * 2);
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

  private async reschedulePolling(): Promise<void> {
    this.log.debug('Rescheduling polling for all devices');
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
