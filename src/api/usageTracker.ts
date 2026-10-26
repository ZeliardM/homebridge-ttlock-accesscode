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

export class UsageTracker extends EventEmitter {
  private storageFilePath?: string;
  private state: StoredUsage | null = null;
  private log: Logging;
  private api: API;
  private mutex = new SimpleMutex();
  private rolloverInterval: NodeJS.Timeout | undefined;
  private currentTier = 0;
  private pendingReserved = 0;
  // Every call saves the usage, so a failing save is logged once until it works again
  private persistFailing = false;
  // Background work stopping for the user reserve is logged once a month
  private backgroundPaused = false;

  constructor(api: API, log: Logging, private totalAllowed: number) {
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
  // month again at 0: usage then starts from what an evenly used month would have used by today.
  private async loadOrInit(): Promise<void> {
    const now = new Date();
    const stored = this.storageFilePath ? await this.readStoredUsage(this.storageFilePath) : undefined;
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
  // usage. Such a file is moved aside: it stays there to look at, and the next save starts a new one.
  private async readStoredUsage(filePath: string): Promise<Pick<StoredUsage, 'year' | 'month' | 'used'> | null | undefined> {
    let data: string;
    try {
      data = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        return null;
      }
      this.log.error(`Could not read the API usage file ${filePath}: ${errorText(err)}`);
      return undefined;
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
    const asidePath = `${filePath}.corrupt-${Date.now()}`;
    try {
      await fs.rename(filePath, asidePath);
      this.log.error(`The API usage file ${filePath} does not hold valid usage; moved it to ${asidePath}`);
    } catch (err) {
      this.log.error(`The API usage file ${filePath} does not hold valid usage and could not be moved aside: ${errorText(err)}`);
    }
    return undefined;
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
      await fs.rename(tempPath, this.storageFilePath);
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

  public async increment(n = 1, reason?: string): Promise<void> {
    if (!this.state) {
      throw new Error('UsageTracker not initialized');
    }
    const release = await this.mutex.acquire();
    try {
      await this.rolloverIfNeededLocked();
      this.state.used += n;
      this.state.lastUpdatedISO = new Date().toISOString();
      await this.persist();
      if (reason) {
        this.log.debug(`Usage incremented by ${n} (${reason}). New used=${this.state.used}`);
      }
      this.updateTier();
    } finally {
      release();
    }
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

  public canReserve(n = 1): boolean {
    if (!this.state) {
      throw new Error('UsageTracker not initialized');
    }
    const remaining = this.state.totalAllowed - this.state.used;
    return remaining >= n;
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

  public async updateTotalAllowed(newTotal: number): Promise<void> {
    if (!this.state) {
      throw new Error('UsageTracker not initialized');
    }
    const release = await this.mutex.acquire();
    try {
      this.totalAllowed = newTotal;
      this.state.totalAllowed = newTotal;
      await this.persist();
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
      await this.persist();
    } finally {
      release();
    }
  }
}
