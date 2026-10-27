import { API, Logging } from 'homebridge';

import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { SimpleMutex } from '../utils.js';

// Who an API call is for. 'user': locking, unlocking and access codes from HomeKit, and the logins they need.
// 'background': polls and discovery, which leave the last calls of the month (the user reserve) to 'user' calls.
export type ApiCallPriority = 'user' | 'background';

// The user reserve: the larger of these
const USER_RESERVE_MIN_CALLS = 50;
const USER_RESERVE_FRACTION = 0.01;

const USAGE_FILE_READ_ATTEMPTS = 2;
const USAGE_FILE_READ_RETRY_DELAY_MS = 1000;

type StoredUsage = {
  year: number;
  month: number;
  totalAllowed: number;
  used: number;
  lastUpdatedISO?: string;
};

// What a usage file must hold to be used; totalAllowed always comes from the config
function isStoredUsage(value: unknown): value is Pick<StoredUsage, 'year' | 'month' | 'used'> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { year, month, used } = value as Record<string, unknown>;
  return Number.isInteger(year) && Number.isInteger(month) && (month as number) >= 1 && (month as number) <= 12 &&
    typeof used === 'number' && Number.isFinite(used) && used >= 0;
}

function daysInMonthOf(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// EPERM or EACCES on moving or replacing the usage file most often means that it or its folder belongs to another user
// (Homebridge once run as root, for example), though an immutable file or some mounts refuse it too
function ownershipHint(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES'
    ? '. The usage file or its folder may belong to another user, which must be fixed for API usage to be saved'
    : '';
}

export class UsageTracker extends EventEmitter {
  private storageFilePath: string | undefined;
  private state: StoredUsage | null = null;
  private log: Logging;
  private api: API;
  private mutex = new SimpleMutex();
  private rolloverInterval: NodeJS.Timeout | undefined;
  private currentTier = 0;
  private pendingReserved = 0;
  // Every call saves the usage, so a failing save is logged once until it works again
  private persistFailing = false;
  // The usage file could not be read, or did not hold valid usage. It stays where it is until a save has been written,
  // and is then moved aside.
  private unusableFile: 'unreadable' | 'corrupt' | undefined;
  // Background work stopping for the user reserve is logged once a month
  private backgroundPaused = false;

  constructor(api: API, log: Logging, private readonly totalAllowed: number) {
    super();
    this.api = api;
    this.log = log;
  }

  public async init(): Promise<void> {
    const base = this.api.user.storagePath();
    const dir = path.join(base, 'ttlock-accesscode');
    const storageFilePath = path.join(dir, 'ttlock-accesscode-usage.json');
    this.log.debug(`UsageTracker storage path: ${storageFilePath}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      this.storageFilePath = storageFilePath;
    } catch (err) {
      // Usage is then counted in memory only, starting from an estimate
      this.log.error(`Could not create the folder for the API usage file ${dir}: ${errorText(err)}`);
    }

    await this.loadOrInit();
    this.scheduleRolloverCheck();
  }

  // A usage file that cannot be read or does not hold valid usage must neither turn the budget off nor start the
  // month again at 0: usage then starts from the last save left in .tmp (see useSaveLeftInTemp), or else from what an
  // evenly used month would have used by today.
  private async loadOrInit(): Promise<void> {
    const now = new Date();
    let stored = this.storageFilePath ? await this.readStoredUsage(this.storageFilePath) : undefined;
    if (this.storageFilePath) {
      stored = await this.useSaveLeftInTemp(this.storageFilePath, stored, now);
    }
    if (stored === null) {
      this.log.debug('Usage file not found, initializing new usage state');
      this.state = this.newMonthState(now, 0);
    } else if (stored === undefined) {
      const used = Math.ceil(this.totalAllowed * (now.getDate() - 1) / daysInMonthOf(now));
      this.log.warn(`Counting API usage from an estimate of ${used} of ${this.totalAllowed} calls used so far this month`);
      this.state = this.newMonthState(now, used);
    } else if (this.isNewMonth(stored, now)) {
      this.log.debug('Usage file month mismatch, resetting usage for new month');
      this.state = this.newMonthState(now, 0);
    } else {
      this.state = this.newMonthState(now, stored.used);
    }
    await this.persist();
    // Starting from 0 instead would report a tier change at the first call after every restart
    this.currentTier = this.computeTier();
  }

  // The stored usage; null when there is no usage file yet, undefined when it cannot be read or does not hold valid
  // usage. Such a file may still hold this month's count, so it stays where it is: only once a save has been written
  // is it moved aside and the save put in its place. If saves fail too (EMFILE, EIO), the next start reads it again.
  private async readStoredUsage(filePath: string): Promise<Pick<StoredUsage, 'year' | 'month' | 'used'> | null | undefined> {
    let data: string | null;
    try {
      data = await this.readUsageFile(filePath);
    } catch (err) {
      this.unusableFile = 'unreadable';
      this.log.error(
        `Could not read the API usage file ${filePath}: ${errorText(err)}; it is left in place until API usage can be ` +
        'saved, and then moved aside',
      );
      return undefined;
    }
    if (data === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = undefined;
    }
    if (isStoredUsage(parsed)) {
      return parsed;
    }
    this.unusableFile = 'corrupt';
    this.log.error(
      `The API usage file ${filePath} does not hold valid usage; it is left in place until API usage can be saved, and ` +
      'then moved aside',
    );
    return undefined;
  }

  // A save is written to .tmp in full before it is renamed into place, so a .tmp that is still there holds a whole save
  // that did not get into place: Homebridge stopped between moving an unusable usage file aside and the rename, or the
  // rename failed. It is used when it holds this month's usage and the usage file is missing, cannot be read, does not
  // hold valid usage, or counts fewer calls this month.
  private async useSaveLeftInTemp(
    filePath: string,
    stored: Pick<StoredUsage, 'year' | 'month' | 'used'> | null | undefined,
    now: Date,
  ): Promise<Pick<StoredUsage, 'year' | 'month' | 'used'> | null | undefined> {
    const tempPath = `${filePath}.tmp`;
    let saved: unknown;
    try {
      saved = JSON.parse(await fs.readFile(tempPath, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        this.log.debug(`Not using the API usage saved in ${tempPath}: ${errorText(err)}`);
      }
      return stored;
    }
    if (!isStoredUsage(saved) || this.isNewMonth(saved, now)) {
      this.log.debug(`Not using the API usage saved in ${tempPath}: it does not hold valid usage for this month`);
      return stored;
    }
    if (stored && !this.isNewMonth(stored, now) && stored.used >= saved.used) {
      return stored;
    }
    const usageFile = stored === null ? 'was not found' :
      stored === undefined ? 'could not be used' : 'counts fewer calls this month';
    this.log.warn(
      `The API usage file ${filePath} ${usageFile}; counting API usage from the last save, left in ${tempPath}: ` +
      `${saved.used} of ${this.totalAllowed} calls used so far this month`,
    );
    return saved;
  }

  // The file's content, or null when there is none. A file that is there but could not be read this time (EIO,
  // EMFILE) is read once more before giving up on it.
  private async readUsageFile(filePath: string): Promise<string | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fs.readFile(filePath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
          return null;
        }
        if (attempt >= USAGE_FILE_READ_ATTEMPTS) {
          throw err;
        }
        this.log.debug(`Could not read the API usage file ${filePath}, trying again: ${errorText(err)}`);
        await new Promise(resolve => setTimeout(resolve, USAGE_FILE_READ_RETRY_DELAY_MS));
      }
    }
  }

  private newMonthState(now: Date, used: number): StoredUsage {
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      totalAllowed: this.totalAllowed,
      used,
      lastUpdatedISO: now.toISOString(),
    };
  }

  private isNewMonth(usage: Pick<StoredUsage, 'year' | 'month'>, now: Date): boolean {
    return usage.year !== now.getFullYear() || usage.month !== now.getMonth() + 1;
  }

  private async persist(): Promise<void> {
    if (!this.storageFilePath || !this.state) {
      return;
    }
    const tempPath = `${this.storageFilePath}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(this.state), 'utf8');
      const asidePath = await this.moveUnusableFileAside(this.storageFilePath);
      try {
        await fs.rename(tempPath, this.storageFilePath);
      } catch (err) {
        if (asidePath) {
          await this.moveAsideFileBack(asidePath, this.storageFilePath);
        }
        const hint = ownershipHint(err);
        throw hint ? new Error(`${errorText(err)}${hint}`, { cause: err }) : err;
      }
      if (asidePath) {
        const what = this.unusableFile === 'unreadable' ? 'could not be read' : 'did not hold valid usage';
        this.unusableFile = undefined;
        this.log.info(`Moved the API usage file that ${what} to ${asidePath}`);
      }
      if (this.persistFailing) {
        this.persistFailing = false;
        this.log.info('Saving API usage data works again');
      }
    } catch (err) {
      if (this.persistFailing) {
        this.log.debug(`Failed to persist usage data: ${errorText(err)}`);
      } else {
        this.persistFailing = true;
        this.log.error(`Failed to persist usage data; it is still counted while Homebridge runs: ${errorText(err)}`);
      }
    }
  }

  // Called once the save that replaces the file has been written, so a save that cannot be written leaves the file in
  // place. When the file cannot be moved, the save is not put in its place either. Returns where the file was moved.
  private async moveUnusableFileAside(filePath: string): Promise<string | undefined> {
    const kind = this.unusableFile;
    if (!kind) {
      return undefined;
    }
    const asidePath = `${filePath}.${kind}-${Date.now()}`;
    try {
      await fs.rename(filePath, asidePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        throw new Error(
          `could not move the API usage file aside to ${asidePath}: ${errorText(err)}${ownershipHint(err)}`,
          { cause: err },
        );
      }
      // It is gone already
      this.unusableFile = undefined;
      return undefined;
    }
    return asidePath;
  }

  // The save could not be put in place after the unusable file was moved aside. Put the file back, so the usage path
  // is not left empty and the next save moves it aside again. If it stays aside, the next start reads the save left in
  // .tmp, and the next save goes straight into place.
  private async moveAsideFileBack(asidePath: string, filePath: string): Promise<void> {
    try {
      await fs.rename(asidePath, filePath);
    } catch (err) {
      this.unusableFile = undefined;
      this.log.error(
        `The API usage file was moved to ${asidePath} and could not be moved back after the save failed: ` +
        errorText(err),
      );
    }
  }

  public getUsage() {
    if (!this.state) {
      throw new Error('UsageTracker not initialized');
    }
    const now = new Date();
    // Until the first call of a new month starts its budget, report that budget rather than last month's
    const newMonth = this.isNewMonth(this.state, now);
    const used = newMonth ? 0 : this.state.used;
    const totalAllowed = newMonth ? this.totalAllowed : this.state.totalAllowed;
    const remaining = Math.max(0, totalAllowed - used);
    const daysInMonth = daysInMonthOf(now);
    const currentDay = now.getDate();
    const daysRemaining = Math.max(1, daysInMonth - (currentDay - 1));
    const userReserve = this.userReserve;
    // What polls and discovery may use per day: they stop at the user reserve
    const remainingDailyAllowance = daysRemaining > 0 ? Math.floor(Math.max(0, remaining - userReserve) / daysRemaining) : 0;
    return {
      used,
      totalAllowed,
      daysInMonth,
      remaining,
      daysRemaining,
      remainingDailyAllowance,
      userReserve,
      lastUpdatedISO: this.state.lastUpdatedISO,
    };
  }

  public async tryReserve(n = 1, reason?: string, priority: ApiCallPriority = 'background'): Promise<boolean> {
    if (!this.state) {
      throw new Error('UsageTracker not initialized');
    }
    const release = await this.mutex.acquire();
    try {
      await this.rolloverIfNeededLocked();
      if (this.fitsLocked(n, priority)) {
        this.state.used += n;
        this.state.lastUpdatedISO = new Date().toISOString();
        await this.persist();
        if (reason) {
          this.log.debug(`Reserved ${n} calls (${reason}). New used=${this.state.used}`);
        }
        this.updateTier();
        return true;
      }
      this.log.debug('Not enough calls remaining, returning false');
      return false;
    } finally {
      release();
    }
  }

  public async beginBatch(n = 1, reason?: string, priority: ApiCallPriority = 'background'): Promise<boolean> {
    if (!this.state) {
      throw new Error('UsageTracker not initialized');
    }
    const release = await this.mutex.acquire();
    try {
      await this.rolloverIfNeededLocked();
      if (this.fitsLocked(n, priority)) {
        this.state.used += n;
        this.pendingReserved += n;
        this.state.lastUpdatedISO = new Date().toISOString();
        await this.persist();
        if (reason) {
          this.log.debug(`Reserve ${n} calls (${reason}). New used=${this.state.used}`);
        }
        this.updateTier();
        return true;
      }
      return false;
    } finally {
      release();
    }
  }

  public async consumePendingReservation(n = 1): Promise<boolean> {
    const release = await this.mutex.acquire();
    try {
      // A new month drops last month's reservations, so this call is counted in the new month
      await this.rolloverIfNeededLocked();
      if (this.pendingReserved >= n) {
        this.pendingReserved -= n;
        return true;
      }
      return false;
    } finally {
      release();
    }
  }

  // At the end of a discovery: the calls it reserved but did not make (it failed or found fewer locks) are no longer
  // counted. Left in the pool, polls would make them without the reserve check. A reserved call is taken from the pool
  // only right before it is sent, so these were never attempted.
  public async endBatch(): Promise<void> {
    const release = await this.mutex.acquire();
    try {
      await this.rolloverIfNeededLocked();
      if (this.releasePendingLocked()) {
        await this.persist();
        this.updateTier();
      }
    } finally {
      release();
    }
  }

  private releasePendingLocked(): boolean {
    if (!this.state || this.pendingReserved === 0) {
      return false;
    }
    const unused = this.pendingReserved;
    this.state.used = Math.max(0, this.state.used - unused);
    this.pendingReserved = 0;
    this.state.lastUpdatedISO = new Date().toISOString();
    this.log.debug(`Released ${unused} reserved calls that were not made. New used=${this.state.used}`);
    return true;
  }

  // Polls and discovery stop short of the user reserve, so HomeKit can still lock, unlock and change access codes once
  // they have used up the rest of the month's calls
  private fitsLocked(n: number, priority: ApiCallPriority): boolean {
    if (!this.state) {
      return false;
    }
    const remaining = this.state.totalAllowed - this.state.used;
    if (priority === 'user') {
      return remaining >= n;
    }
    if (remaining - n >= this.userReserve) {
      return true;
    }
    // A discovery that does not fit while polls still do is not the pause; the platform logs the skipped discovery
    if (remaining - 1 >= this.userReserve) {
      return false;
    }
    if (!this.backgroundPaused) {
      this.backgroundPaused = true;
      this.log.warn(
        `Only ${Math.max(0, remaining)} of ${this.state.totalAllowed} API calls are left this month. Polling and discovery ` +
        'pause until the month ends, so that the rest stay available for locking, unlocking and access codes.',
      );
    }
    return false;
  }

  private get userReserve(): number {
    return Math.max(USER_RESERVE_MIN_CALLS, Math.ceil(this.totalAllowed * USER_RESERVE_FRACTION));
  }

  // The month's budget starts at its first call, not at the next hourly check: until then, calls would count against
  // (and be refused by) last month's budget. Discovery reservations left from last month go with it.
  private async rolloverIfNeededLocked(now = new Date()): Promise<void> {
    if (!this.state || !this.isNewMonth(this.state, now)) {
      return;
    }
    this.state = this.newMonthState(now, 0);
    this.pendingReserved = 0;
    this.backgroundPaused = false;
    await this.persist();
    this.currentTier = this.computeTier();
    this.log.info(`New month: API usage starts again at 0 of ${this.state.totalAllowed} calls`);
    // Polling is paced from the budget left, so the platform recalculates it
    this.emit('monthStarted', { usage: this.getUsage() });
  }

  private updateTier(): void {
    const newTier = this.computeTier();
    if (newTier !== this.currentTier) {
      const old = this.currentTier;
      this.currentTier = newTier;
      this.log.debug(`Usage tier changed: ${old} -> ${newTier}`);
      this.emit('tierChanged', { old, new: newTier, usage: this.getUsage() });
    }
  }

  private computeTier(): number {
    if (!this.state) {
      return 0;
    }
    const remaining = Math.max(0, this.state.totalAllowed - this.state.used);
    const remainingFraction = this.state.totalAllowed === 0 ? 0 : remaining / this.state.totalAllowed;
    if (remainingFraction < 0.05) {
      return 4;
    }
    if (remainingFraction < 0.10) {
      return 3;
    }
    if (remainingFraction < 0.20) {
      return 2;
    }
    if (remainingFraction < 0.50) {
      return 1;
    }
    return 0;
  }

  // A backstop for a month without calls; the month also starts at its first call
  private scheduleRolloverCheck(): void {
    this.rolloverInterval = setInterval(() => void this.checkRollover(), 60 * 60 * 1000);
    this.rolloverInterval.unref();
  }

  private async checkRollover(): Promise<void> {
    if (!this.state) {
      return;
    }
    const release = await this.mutex.acquire();
    try {
      await this.rolloverIfNeededLocked();
    } finally {
      release();
    }
  }

  public async stop(): Promise<void> {
    // Before waiting for the mutex, so a save that hangs cannot keep the timer
    if (this.rolloverInterval) {
      clearInterval(this.rolloverInterval);
      this.rolloverInterval = undefined;
    }
    const release = await this.mutex.acquire();
    try {
      // A discovery cut off by shutdown ends after this, too late to save its release. Shutdown stops the TTLock API
      // first, so no request takes from the reservation any more.
      this.releasePendingLocked();
      await this.persist();
    } finally {
      release();
    }
  }
}
