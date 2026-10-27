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
import DeviceManager, { HOMEKIT_WRITE_TIME_LIMIT_MS, LOCK_COMMAND_TIME_LIMIT_MS, runHomeKitWrite } from './deviceManager.js';
import { TTLockApiError, TTLockApiErrorCategory } from '../api/ttlockApi.js';
import { prefixLogger } from '../utils.js';
import type TTLockAccessCodePlatform from '../platform.js';
import type {
  CharacteristicDescriptor,
  DescriptorContext,
  SysInfo,
  TTLockDevice,
} from './deviceTypes.js';
import type { TTLockAccessoryContext } from '../platform.js';

// A lock whose state is not known yet is read this soon after polling starts, a few seconds apart per position, instead
// of at its slot up to a whole polling interval later
const UNKNOWN_STATE_POLL_DELAY_MS = 2000;
const UNKNOWN_STATE_POLL_STAGGER_MS = 5000;
// That read is skipped while the gateway is busy with another request; it is tried this many times in all
const UNKNOWN_STATE_POLL_ATTEMPTS = 5;

export default abstract class HomeKitDevice {
  readonly log: Logger;
  protected deviceManager: DeviceManager | undefined;
  public homebridgeAccessory: PlatformAccessory<TTLockAccessoryContext>;
  public isUpdating = false;
  protected previousSnapshot?: TTLockDevice;
  // The next scheduled poll. Each scheduled poll sets the next one when it is done.
  private pollingTimer: NodeJS.Timeout | undefined;
  private unknownStatePollTimer: NodeJS.Timeout | undefined;
  // Raised whenever polling stops or is scheduled again, so a poll still running from before sets no timer
  private pollingGeneration = 0;
  private pollingIntervalMs = 0;
  // performance.now() when the next scheduled poll is due
  private nextPollDueAt = 0;
  protected updateEmitter = new EventEmitter();
  // Every failed poll since the lock last answered, for the log
  private consecutivePollFailures = 0;
  // The failed polls among them that say the lock cannot be reached (see countsTowardOffline). After this many the
  // lock shows No Response in HomeKit. Polling goes on, so it recovers as soon as the lock answers again.
  private unansweredPolls = 0;
  private readonly maxUnansweredPolls = 3;

  private static locks: Map<string, Promise<unknown>> = new Map();
  private pendingChanges: Map<string, { pendingValue: CharacteristicValue; count: number }> = new Map();
  private removedFromPlatform = false;
  // performance.now() when this lock's last HomeKit write started or ended
  private lastWriteAt = 0;
  // HomeKit writes waiting for the device lock; a poll does not make them wait longer than it has to
  private writesWaiting = 0;

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
    this.deviceManager = platform.deviceManager;
    this.log = prefixLogger(platform.log, `[${this.name}]`);
    this.homebridgeAccessory = this.initializeAccessory();
    this.homebridgeAccessory.on(PlatformAccessoryEvent.IDENTIFY, () => this.identify());

    try {
      this.previousSnapshot = JSON.parse(JSON.stringify(this.ttlockDevice));
    } catch {
      this.previousSnapshot = { ...this.ttlockDevice };
    }
  }

  private initializeAccessory(): PlatformAccessory<TTLockAccessoryContext> {
    const uuid = this.platform.api.hap.uuid.generate(this.id);
    const existingAccessory = this.platform.configuredAccessories.get(uuid) as PlatformAccessory<TTLockAccessoryContext> | undefined;
    let accessory: PlatformAccessory<TTLockAccessoryContext>;
    if (!existingAccessory) {
      this.log.debug(`Creating new Platform Accessory [${this.id}] [${uuid}] category: ${this.categoryName}`);
      accessory = new this.platform.api.platformAccessory(this.name, uuid, this.category);
      accessory.context.kind = 'ttlock';
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

  private updateAccessory(accessory: PlatformAccessory<TTLockAccessoryContext>): void {
    const currentDisplayName = accessory.displayName;
    const deviceName = this.name;
    let displayNameChanged = false;

    if (!currentDisplayName && deviceName) {
      accessory.displayName = deviceName;
      displayNameChanged = true;
    }

    accessory.context.deviceId = this.id;
    accessory.context.kind = 'ttlock';
    accessory.context.lastSeen = this.ttlockDevice.last_seen;
    accessory.context.offline = this.ttlockDevice.offline;
    this.platform.configuredAccessories.set(accessory.UUID, accessory);

    if (displayNameChanged) {
      this.platform.api.updatePlatformAccessories([accessory]);
    }
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
    // Wait for the previous holder to settle either way. Its error belongs to its own caller;
    // chaining with a plain then() would hand it to every later caller and never free the key.
    const currentPromise = previousPromise.catch(() => undefined).then(async () => {
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

  // Not while the lock is offline: it is still polled and its commands are still sent, so it recovers by itself
  protected shouldSkipUpdate(): boolean {
    return this.removedFromPlatform || this.platform.isShuttingDown;
  }

  // True when the lock was read; false when it could not be asked. Read at once: polls of a lock run one at a time
  // under its device lock, so there is nothing to combine, and a wait here would hold up the lock's commands.
  private async getSysInfo(): Promise<boolean> {
    if (!this.deviceManager) {
      this.log.warn('Device manager not available');
      return false;
    }
    const deviceId = this.ttlockDevice.sys_info?.device_id;
    if (!deviceId) {
      this.log.warn('No device_id in sys_info');
      return false;
    }
    const updatedSysInfo = await this.deviceManager.getSysInfo(deviceId, () => this.writesWaiting > 0);
    Object.assign(this.ttlockDevice.sys_info, updatedSysInfo);
    this.log.debug(`Updated sys_info: ${updatedSysInfo.alias ?? deviceId}`);
    return true;
  }

  // True when the poll was skipped because the lock or its gateway was busy with another request
  protected async refreshAndUpdateCharacteristics(forceUpdate: boolean): Promise<boolean> {
    const deviceKey = this.ttlockDevice.sys_info.device_id;
    if (!forceUpdate && HomeKitDevice.locks.has(deviceKey)) {
      this.log.debug('Skipping poll; active update lock');
      return true;
    }
    let skipped = false;
    await this.withLock(deviceKey, async () => {
      if (this.shouldSkipUpdate()) {
        await this.stopPolling();
        return;
      }
      this.isUpdating = true;
      try {
        if (!await this.getSysInfo()) {
          return;
        }
        this.markDeviceReachable();
        await this.updateAllServicesAndCharacteristics(forceUpdate);
        this.previousSnapshot = JSON.parse(JSON.stringify(this.ttlockDevice));
      } catch (error) {
        if (this.platform.isShuttingDown) {
          // Not a failed poll: shutdown stopped the client, so the request was not sent or its answer no longer matters
          this.log.debug(`Poll stopped by shutdown: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (error instanceof TTLockApiError && error.skipped) {
          // Not a failed poll: another request was using the gateway, and the next poll reads the lock
          this.log.debug('Poll skipped: the gateway is busy with another request');
          skipped = true;
          return;
        }
        this.recordPollFailure(error);
      } finally {
        this.isUpdating = false;
        this.updateEmitter.emit('updateComplete');
      }
    });
    return skipped;
  }

  public async startPolling(): Promise<void> {
    if (this.shouldSkipUpdate()) {
      await this.stopPolling();
      return;
    }
    this.clearPollingTimers();
    const effectiveInterval = this.computePollingInterval();
    this.pollingIntervalMs = effectiveInterval;
    // Spread the locks' polls across the interval: locks sharing a gateway that are polled at the same
    // moment make the gateway answer "busy". Every lock still gets its first poll within one interval.
    const { index, count } = this.platform.getPollingSlot(this.ttlockDevice.sys_info.device_id);
    const firstPollDelay = Math.floor((effectiveInterval * (index + 1)) / count);
    this.log.debug(`Starting polling with interval ${effectiveInterval}ms, first poll in ${firstPollDelay}ms`);
    this.schedulePoll(performance.now() + firstPollDelay, this.pollingGeneration);
    // HomeKit shows the lock as Unknown (discovery could not read its state, or TTLock did not know it): read it soon
    // rather than at the slot. Still staggered, because locks that share a gateway and are polled together find it busy.
    if (!this.isLockStateKnown()) {
      const unknownStatePollDelay = UNKNOWN_STATE_POLL_DELAY_MS + index * UNKNOWN_STATE_POLL_STAGGER_MS;
      if (unknownStatePollDelay < firstPollDelay) {
        this.log.debug(`Lock state unknown; reading it in ${unknownStatePollDelay}ms`);
        this.scheduleUnknownStatePoll(
          unknownStatePollDelay,
          UNKNOWN_STATE_POLL_ATTEMPTS,
          count * UNKNOWN_STATE_POLL_STAGGER_MS,
          this.pollingGeneration,
        );
      }
    }
  }

  // A read skipped because the gateway or the lock was busy is tried again after retryDelay, which keeps each lock in
  // its own stagger lane, as long as that is before the lock's regular slot
  private scheduleUnknownStatePoll(delay: number, attemptsLeft: number, retryDelay: number, generation: number): void {
    this.unknownStatePollTimer = setTimeout(() => {
      this.unknownStatePollTimer = undefined;
      void this.refreshInBackground(false).then(skipped => {
        if (!skipped || attemptsLeft <= 1 || generation !== this.pollingGeneration || this.shouldSkipUpdate() ||
          this.isLockStateKnown() || performance.now() + retryDelay >= this.nextPollDueAt) {
          return;
        }
        this.log.debug(`Lock state still unknown and the poll was skipped; reading it again in ${retryDelay}ms`);
        this.scheduleUnknownStatePoll(retryDelay, attemptsLeft - 1, retryDelay, generation);
      });
    }, delay);
  }

  private computePollingInterval(): number {
    return this.platform.computeEffectivePollingInterval(
      this.platform.getTTLockAccessoryCount(),
      this.platform.config.discoveryOptions.pollingInterval,
    );
  }

  // When a scheduled poll is done, the interval is worked out again before the next one is set: polls show which
  // locks take a second call, and the daily allowance changes during the month. The next poll is due one interval
  // after this one was due, not after it finished, so every lock keeps its slot.
  private schedulePoll(dueAt: number, generation: number): void {
    this.nextPollDueAt = dueAt;
    this.pollingTimer = setTimeout(() => {
      this.pollingTimer = undefined;
      void this.refreshInBackground(false).then(() => {
        if (generation !== this.pollingGeneration || this.shouldSkipUpdate()) {
          // Polling stopped or was scheduled again while the poll ran
          return;
        }
        const interval = this.computePollingInterval();
        if (interval !== this.pollingIntervalMs) {
          this.log.debug(`Polling interval is now ${interval}ms`);
          this.pollingIntervalMs = interval;
        }
        let nextDueAt = dueAt + interval;
        const now = performance.now();
        if (nextDueAt < now) {
          // The poll took longer than the interval: skip the polls it ran over
          nextDueAt += Math.ceil((now - nextDueAt) / interval) * interval;
        }
        this.schedulePoll(nextDueAt, generation);
      });
    }, Math.max(0, dueAt - performance.now()));
  }

  private isLockStateKnown(): boolean {
    const { SECURED, UNSECURED } = this.platform.Characteristic.LockCurrentState;
    const state = this.ttlockDevice.sys_info.state;
    return state === SECURED || state === UNSECURED;
  }

  private clearPollingTimers(): void {
    this.pollingGeneration++;
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    if (this.unknownStatePollTimer) {
      clearTimeout(this.unknownStatePollTimer);
      this.unknownStatePollTimer = undefined;
    }
  }

  public async stopPolling(waitForCurrentUpdate = false): Promise<void> {
    this.clearPollingTimers();
    if (waitForCurrentUpdate && this.isUpdating) {
      await new Promise<void>(resolve => {
        this.updateEmitter.once('updateComplete', resolve);
      });
    }
  }

  public removeFromPlatform(): void {
    this.removedFromPlatform = true;
    void this.stopPolling();
    // Release anything still waiting on this lock
    this.updateEmitter.emit('updateComplete');
  }

  // Discovery reads every lock before it reports any of them, so the state, battery and passcodes it read can be
  // older than the last poll or HomeKit write. Take only identity from it; polls keep the state current.
  // Updated in place: polls, write contexts and in-flight writes hold this sys_info object.
  public updateFromDiscovery(device: TTLockDevice, discoveryStartedAt: number): void {
    const sysInfo = this.ttlockDevice.sys_info;
    sysInfo.alias = device.sys_info.alias;
    sysInfo.mac = device.sys_info.mac;
    sysInfo.model = device.sys_info.model;
    sysInfo.hw_ver = device.sys_info.hw_ver;
    sysInfo.fw_ver = device.sys_info.fw_ver;
    this.ttlockDevice.feature_info = device.feature_info;
    this.ttlockDevice.last_seen = device.last_seen;
    // Picks up codes changed in the TTLock app, unless HomeKit changed codes after discovery read them
    if (Array.isArray(device.sys_info.passcodes) && !this.isUpdating && this.lastWriteAt < discoveryStartedAt) {
      sysInfo.passcodes = device.sys_info.passcodes;
    }
  }

  // Discovery read the state of a lock that has not answered its last polls, so the lock answers again: show it now
  // rather than at its next poll. Not awaited, so discovery does not wait for a lock command in flight.
  public applyStateFromDiscovery(state: number, discoveryStartedAt: number): void {
    void this.withLock(this.makeLockKey(), async () => {
      // A poll that answered since, or a HomeKit write since discovery started, is newer than what discovery read
      if (this.shouldSkipUpdate() || !this.ttlockDevice.offline || this.lastWriteAt >= discoveryStartedAt) {
        return;
      }
      // Not the battery level: lock/list's is TTLock's cached value, and the battery level comes from polls only
      this.ttlockDevice.sys_info.state = state;
      this.markDeviceReachable();
      await this.updateAllServicesAndCharacteristics(true);
      this.previousSnapshot = JSON.parse(JSON.stringify(this.ttlockDevice));
    }).catch(error => this.log.error('Applying the state discovery read failed:', error));
  }

  // Nothing awaits these refreshes, and an unhandled rejection makes Homebridge shut down.
  private async refreshInBackground(forceUpdate: boolean): Promise<boolean> {
    try {
      return await this.refreshAndUpdateCharacteristics(forceUpdate);
    } catch (error) {
      this.log.error('Background refresh failed:', error);
      return false;
    }
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
        this.seedCharacteristicValue(service, descriptor, this.buildDescriptorContext(), 'Seed error');
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

  protected seedCharacteristicValue(
    service: Service,
    descriptor: CharacteristicDescriptor,
    context: DescriptorContext,
    errorPrefix: string,
  ): void {
    try {
      const characteristic = service.getCharacteristic(descriptor.type);
      characteristic.updateValue(descriptor.getInitial(context));
    } catch (error) {
      this.log.error(`${errorPrefix} for ${descriptor.name ?? descriptor.type.UUID}`, error);
    }
  }

  protected buildDescriptorContext(): DescriptorContext {
    return {
      platform: this.platform,
      device: this.ttlockDevice.sys_info,
      alias: this.name,
    };
  }

  private async genericOnGet(service: Service, descriptor: CharacteristicDescriptor): Promise<CharacteristicValue> {
    // The cached values may be long out of date; HomeKit shows No Response until a poll reads the lock again
    if (this.ttlockDevice.offline) {
      throw this.communicationFailure();
    }
    const context = this.buildDescriptorContext();
    try {
      const characteristic = service.getCharacteristic(descriptor.type);
      let value = characteristic.value;
      if (value === undefined || value === null) {
        value = descriptor.getInitial(context);
        characteristic.updateValue(value);
      }
      return value as CharacteristicValue;
    } catch (error) {
      this.log.error(`OnGet error for ${descriptor.name ?? descriptor.type.UUID}`, error);
      return this.defaultValueForCharacteristic(descriptor.type);
    }
  }

  private async genericOnSet(service: Service, descriptor: CharacteristicDescriptor, value: CharacteristicValue): Promise<void | string> {
    if (!descriptor.applySet) {
      return;
    }
    const refusal = descriptor.checkSet?.(value, this.buildDescriptorContext());
    if (refusal) {
      // Nothing is sent to TTLock. Bounce HomeKit back to the real state: HAP stores the requested value after
      // this handler returns, so the revert has to come after that or it is overwritten.
      setImmediate(() => this.revertTargetIfNeeded(service, descriptor, value));
      return;
    }
    if (descriptor.applySetInBackground) {
      // HomeKit shows "No Response" after about 10s, and lock commands through a gateway can take longer.
      // Answer now; if the command does not take effect, put the target back to the lock's real state.
      // The revert waits a tick as well: a command that fails at once could otherwise finish before HAP stores the value.
      // The command's time limit starts now, so time spent waiting behind a poll counts too.
      void runHomeKitWrite(LOCK_COMMAND_TIME_LIMIT_MS, () => this.executeDescriptorSet(service, descriptor, value))
        .catch(error => {
          // A failed write was logged when it failed and comes back as a HAP status
          if (!(error instanceof this.platform.api.hap.HapStatusError)) {
            this.log.error(`OnSet error for ${descriptor.name ?? descriptor.type.UUID}`, error);
          }
        })
        .then(() => setImmediate(() => this.revertTargetIfNeeded(service, descriptor, value, true)));
      return;
    }
    // HomeKit waits for the answer, so nothing may be sent once it has stopped waiting. A write that fails is
    // answered with No Response, not with success.
    const result = await runHomeKitWrite(
      HOMEKIT_WRITE_TIME_LIMIT_MS,
      () => this.executeDescriptorSet(service, descriptor, value),
    );
    if (result !== undefined) {
      return result;
    }
  }

  private revertTargetIfNeeded(
    service: Service,
    descriptor: CharacteristicDescriptor,
    requested: CharacteristicValue,
    logRevert = false,
  ): void {
    // Read the lock's state as it is now, not as it was when the command started
    const current = descriptor.getCurrent(this.buildDescriptorContext());
    if (current === requested) {
      return;
    }
    if (logRevert) {
      this.log.warn(`${descriptor.name ?? descriptor.type.UUID} did not change to ${requested}; reverting HomeKit to ${current}`);
    }
    service.getCharacteristic(descriptor.type).updateValue(current);
  }

  private async executeDescriptorSet(
    service: Service,
    descriptor: CharacteristicDescriptor,
    value: CharacteristicValue,
  ): Promise<void | string> {
    const lockKey = this.makeLockKey();
    this.writesWaiting++;
    // withLock always runs the action, so the count always goes down again
    return await this.withLock(lockKey, async () => {
      this.writesWaiting--;
      if (this.shouldSkipUpdate()) {
        this.log.debug(
          `Not sending the ${descriptor.name ?? descriptor.type.UUID} write: the lock was removed or Homebridge is shutting down`,
        );
        throw this.communicationFailure();
      }
      if (!this.deviceManager) {
        throw new Error('Device manager undefined');
      }
      // Built now, not when HomeKit asked: the write may have waited for the device lock, and it must read and
      // update the lock's sys_info as it is when the write runs
      const context = this.buildDescriptorContext();
      try {
        this.isUpdating = true;
        this.lastWriteAt = performance.now();
        const result = await descriptor.applySet!(value, context);
        let postSetValue: CharacteristicValue;
        let descriptorsToUpdate: CharacteristicDescriptor[] = [];
        if (descriptor.syncGroup) {
          descriptorsToUpdate = this.services
            .find(entry => entry.service === service)!
            .descriptors.filter(d => d.syncGroup === descriptor.syncGroup);
        } else {
          descriptorsToUpdate = [descriptor];
        }
        for (const desc of descriptorsToUpdate) {
          postSetValue = desc.getCurrent(context);
          const characteristic = service.getCharacteristic(desc.type);
          if (desc.syncHomeKitValueAfterSet) {
            this.updateValue(
              service,
              characteristic,
              context.alias,
              postSetValue,
            );
          } else {
            this.log.info(`Set ${this.platform.lsc(service, characteristic)} on ${context.alias} to ${postSetValue}`);
          }
        }
        this.previousSnapshot = JSON.parse(JSON.stringify(this.ttlockDevice));
        return result;
      } catch (error) {
        if (error instanceof TTLockApiError && error.category === TTLockApiErrorCategory.DeadlineExpired) {
          this.log.warn(
            `Did not send the ${descriptor.name ?? descriptor.type.UUID} write to TTLock (${error.endpoint ?? 'request'}): ` +
            'HomeKit had stopped waiting for it',
          );
        } else if (error instanceof TTLockApiError) {
          // TTLock's answer in one line, no stack trace; only at debug when the request has logged it already
          const message = `Could not set ${descriptor.name ?? descriptor.type.UUID}: ${error.message}`;
          if (error.wasLogged) {
            this.log.debug(message);
          } else {
            this.log.warn(message);
          }
        } else {
          this.log.error(`OnSet error for ${descriptor.name ?? descriptor.type.UUID}`, error);
        }
        // Tell HomeKit the write failed. A lock command was answered already; it is reverted instead.
        throw this.communicationFailure();
      } finally {
        this.lastWriteAt = performance.now();
        this.isUpdating = false;
        this.updateEmitter.emit('updateComplete');
      }
    });
  }

  // The lock answered (a poll read it, or TTLock carried out a command): it is reachable and seen now
  protected markDeviceReachable(): void {
    const failures = this.consecutivePollFailures;
    const unanswered = this.unansweredPolls;
    const wasOffline = this.ttlockDevice.offline;
    const now = new Date();
    this.consecutivePollFailures = 0;
    this.unansweredPolls = 0;
    this.ttlockDevice.last_seen = now;
    this.homebridgeAccessory.context.lastSeen = now;
    this.setOfflineState(false);
    // Only polls that did not reach the lock say communication was lost; a poll refused for the API budget, a login
    // or a rate limit never reached it
    if (unanswered > 0) {
      this.log.info(
        `Recovered communication with the lock after ${unanswered} unanswered poll${unanswered === 1 ? '' : 's'}` +
        (wasOffline ? '; HomeKit no longer shows it as No Response' : ''),
      );
    } else if (failures > 0) {
      this.log.debug(`Polls work again after ${failures} failed poll${failures === 1 ? '' : 's'}`);
    }
  }

  // A run of failed polls is logged once: a warning for the first one and debug after that, and a warning when
  // HomeKit starts showing No Response. The first poll that did not reach the lock is a warning too, when polls
  // refused for the API budget, a login or a rate limit came first. The recovery is logged once (markDeviceReachable).
  private recordPollFailure(error: unknown): void {
    const unanswered = this.countsTowardOffline(error);
    this.consecutivePollFailures++;
    if (unanswered) {
      this.unansweredPolls++;
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (this.consecutivePollFailures === 1 || (unanswered && this.unansweredPolls === 1)) {
      this.log.warn(`Poll failed: ${reason}`);
    } else {
      this.log.debug(`Poll failed (${this.consecutivePollFailures} in a row): ${reason}`);
    }
    if (error instanceof Error && !(error instanceof TTLockApiError) && error.stack) {
      // Not an answer from TTLock, so keep where it came from
      this.log.debug(error.stack);
    }
    // Failures that do not count neither add to the count nor reset it: three polls the lock did not answer still
    // count as three with refused polls in between
    if (unanswered && this.unansweredPolls >= this.maxUnansweredPolls) {
      if (!this.ttlockDevice.offline) {
        this.log.warn(
          `No answer from the lock in ${this.unansweredPolls} polls; HomeKit shows it as No Response. ` +
          'Polling continues, so it recovers when the lock answers again.',
        );
      }
      this.setOfflineState(true);
    }
  }

  // Whether a failed poll says the lock cannot be reached. Gateway errors (offline, busy, could not reach the lock),
  // network and server errors and bad answers do. A used-up API budget, a rejected login and a rate limit are about
  // the whole plugin, not this lock, and a request that ran out of time was not sent.
  private countsTowardOffline(error: unknown): boolean {
    if (!(error instanceof TTLockApiError)) {
      return true;
    }
    switch (error.category) {
      case TTLockApiErrorCategory.AuthExpired:
      case TTLockApiErrorCategory.AuthInvalid:
      case TTLockApiErrorCategory.BudgetExhausted:
      case TTLockApiErrorCategory.DeadlineExpired:
      case TTLockApiErrorCategory.RateLimited:
        return false;
      default:
        return true;
    }
  }

  // Only for this run: the cached accessory's own offline flag says whether TTLock still lists the lock, which
  // decides whether it is removed after offlineInterval. A lock that TTLock lists but cannot reach is kept.
  private setOfflineState(offline: boolean): void {
    this.ttlockDevice.offline = offline;
  }

  // HomeKit shows the lock as No Response
  protected communicationFailure(): HapStatusError {
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  protected async updateAllServicesAndCharacteristics(forceUpdate: boolean): Promise<void> {
    for (const entry of this.services) {
      for (const descriptor of entry.descriptors) {
        const context = this.buildDescriptorContext();
        try {
          const previousContext: DescriptorContext = {
            platform: this.platform,
            device: (this.previousSnapshot?.sys_info as SysInfo) ?? {} as SysInfo,
            alias: this.name,
          };

          const characteristic = entry.service.getCharacteristic(descriptor.type);
          if (descriptor.debouncePolls && descriptor.debouncePolls > 1) {
            const hkValue: CharacteristicValue = characteristic.value !== null && characteristic.value !== undefined
              ? characteristic.value as CharacteristicValue
              : descriptor.getInitial(context) as CharacteristicValue;
            const nextDeviceValue = descriptor.getCurrent(context) as CharacteristicValue;
            const debounceKey = `${entry.service.UUID}:${descriptor.type.UUID}`;
            const effectiveNext = this.resolveWithDebounce(
              debounceKey,
              hkValue,
              nextDeviceValue,
              descriptor.debouncePolls,
              forceUpdate,
            );
            this.updateIfChanged(
              entry.service,
              characteristic,
              context.alias,
              hkValue,
              effectiveNext,
              descriptor.name,
              forceUpdate,
            );
          } else {
            const previousValue = this.previousSnapshot
              ? descriptor.getCurrent(previousContext)
              : descriptor.getInitial(context);
            const nextValue = descriptor.getCurrent(context);
            this.updateIfChanged(
              entry.service,
              characteristic,
              context.alias,
              previousValue as CharacteristicValue,
              nextValue as CharacteristicValue,
              descriptor.name,
              forceUpdate,
            );
          }
        } catch (error) {
          this.log.error(`Update diff error for ${descriptor.name ?? descriptor.type.UUID}`, error);
        }
      }
    }
  }

  protected resolveWithDebounce(
    key: string,
    currentHomeKitValue: CharacteristicValue,
    nextDeviceValue: CharacteristicValue,
    debouncePolls: number,
    force = false,
  ): CharacteristicValue {
    if (force) {
      this.pendingChanges.delete(key);
      return nextDeviceValue;
    }
    if (currentHomeKitValue === nextDeviceValue) {
      this.pendingChanges.delete(key);
      return nextDeviceValue;
    }
    const pending = this.pendingChanges.get(key);
    if (pending && pending.pendingValue === nextDeviceValue) {
      pending.count++;
      if (pending.count >= debouncePolls) {
        this.pendingChanges.delete(key);
        return nextDeviceValue;
      }
      return currentHomeKitValue;
    }
    this.pendingChanges.set(key, { pendingValue: nextDeviceValue, count: 1 });
    return currentHomeKitValue;
  }

  protected defaultValueForCharacteristic(type: WithUUID<new () => Characteristic>): CharacteristicValue {
    const C = this.platform.Characteristic;
    switch (type.UUID) {
      case C.LockCurrentState.UUID:
        return C.LockCurrentState.UNKNOWN;
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
    const currentValue = characteristic.value as Nullable<CharacteristicValue>;
    const needsInit = currentValue === undefined || currentValue === null;
    const homeKitValueChanged = needsInit || currentValue !== nextValue;
    const snapshotChanged = previousValue !== nextValue;
    const shouldUpdate = force || needsInit || snapshotChanged;

    if (shouldUpdate) {
      if (label && homeKitValueChanged) {
        this.log.debug(`Updating ${label}: ${previousValue} -> ${nextValue}`);
      }
      this.updateValue(
        service,
        characteristic,
        alias,
        nextValue as unknown as Nullable<CharacteristicValue>,
        homeKitValueChanged,
      );
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
    logUpdate = true,
  ): void {
    if (logUpdate) {
      this.log.info(`Updating ${this.platform.lsc(service, characteristic)} on ${deviceAlias} to ${value}`);
    }
    characteristic.updateValue(value);
  }

  public abstract initialize(): Promise<void>;
  public abstract identify(): void;
}
