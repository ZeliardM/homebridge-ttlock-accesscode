import { API, Logging } from 'homebridge';

import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { SimpleMutex } from '../utils.js';

type StoredUsage = {
  year: number;
  month: number;
  totalAllowed: number;
  used: number;
  lastUpdatedISO?: string;
};

export class UsageTracker extends EventEmitter {
  private storageFilePath?: string;
  private state: StoredUsage | null = null;
  private log: Logging;
  private api: API;
  private mutex = new SimpleMutex();
  private rolloverInterval?: NodeJS.Timeout;
  private currentTier = 0;
  private pendingReserved = 0;

  constructor(api: API, log: Logging, private totalAllowed: number) {
    super();
    this.api = api;
    this.log = log;
  }

  public async init(): Promise<void> {
    const base = this.api.user.storagePath();
    const dir = path.join(base, 'ttlock-accesscode');
    await fs.mkdir(dir, { recursive: true });
    this.storageFilePath = path.join(dir, 'ttlock-accesscode-usage.json');
    this.log.debug(`UsageTracker storage path: ${this.storageFilePath}`);

    await this.loadOrInit();
    this.scheduleRolloverCheck();
  }

  private async loadOrInit(): Promise<void> {
    try {
      const data = await fs.readFile(this.storageFilePath!, 'utf8');
      const parsed = JSON.parse(data) as StoredUsage;
      const now = new Date();
      if (parsed.year !== now.getFullYear() || parsed.month !== now.getMonth() + 1) {
        this.log.debug('Usage file month mismatch, resetting usage for new month');
        this.state = {
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          totalAllowed: this.totalAllowed,
          used: 0,
          lastUpdatedISO: now.toISOString(),
        };
        await this.persist();
      } else {
        if (parsed.totalAllowed !== this.totalAllowed) {
          this.log.debug('Updating stored totalAllowed to current config value');
          parsed.totalAllowed = this.totalAllowed;
        }
        parsed.lastUpdatedISO = new Date().toISOString();
        this.state = parsed;
        await this.persist();
      }
    } catch (err) {
      const errorCode = (err as NodeJS.ErrnoException | undefined)?.code;
      if (errorCode === 'ENOENT') {
        this.log.debug('Usage file not found, initializing new usage state');
        const now = new Date();
        this.state = {
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          totalAllowed: this.totalAllowed,
          used: 0,
          lastUpdatedISO: now.toISOString(),
        };
        await this.persist();
        return;
      }

      this.log.error('Failed to load usage data; refusing to reset usage state automatically', err);
      throw err;
    }
  }

  private async persist(): Promise<void> {
    if (!this.storageFilePath || !this.state) {
      return;
    }
    const tempPath = `${this.storageFilePath}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(this.state), 'utf8');
      await fs.rename(tempPath, this.storageFilePath);
    } catch (err) {
      this.log.error('Failed to persist usage data', err);
    }
  }

  public getUsage() {
    if (!this.state) {
      throw new Error('UsageTracker not initialized');
    }
    const remaining = Math.max(0, this.state.totalAllowed - this.state.used);
    const now = new Date();
    const daysInMonth = new Date(this.state.year, this.state.month, 0).getDate();
    const currentDay = now.getDate();
    const daysRemaining = Math.max(1, daysInMonth - (currentDay - 1));
    const remainingDailyAllowance = daysRemaining > 0 ? Math.floor(remaining / daysRemaining) : 0;
    return {
      used: this.state.used,
      totalAllowed: this.state.totalAllowed,
      daysInMonth,
      remaining,
      daysRemaining,
      remainingDailyAllowance,
      lastUpdatedISO: this.state.lastUpdatedISO,
    };
  }

  public async increment(n = 1, reason?: string): Promise<void> {
    if (!this.state) {
      throw new Error('UsageTracker not initialized');
    }
    const release = await this.mutex.acquire();
    try {
      this.state.used += n;
      this.state.lastUpdatedISO = new Date().toISOString();
      await this.persist();
      if (reason) {
        this.log.debug(`Usage incremented by ${n} (${reason}). New used=${this.state.used}`);
      }
      const newTier = this.computeTier();
      if (newTier !== this.currentTier) {
        const old = this.currentTier;
        this.currentTier = newTier;
        this.emit('tierChanged', { old, new: newTier, usage: this.getUsage() });
        this.log.info(`Usage tier changed: ${old} -> ${newTier}`);
      }
    } finally {
      release();
    }
  }

  public async tryReserve(n = 1, reason?: string): Promise<boolean> {
    if (!this.state) {
      throw new Error('UsageTracker not initialized');
    }
    const release = await this.mutex.acquire();
    try {
      const remaining = this.state.totalAllowed - this.state.used;
      if (remaining >= n) {
        this.state.used += n;
        this.state.lastUpdatedISO = new Date().toISOString();
        await this.persist();
        if (reason) {
          this.log.debug(`Reserved ${n} calls (${reason}). New used=${this.state.used}`);
        }
        const newTier = this.computeTier();
        if (newTier !== this.currentTier) {
          const old = this.currentTier;
          this.currentTier = newTier;
          this.emit('tierChanged', { old, new: newTier, usage: this.getUsage() });
        }
        return true;
      }
      this.log.debug('Not enough calls remaining, returning false');
      return false;
    } finally {
      release();
    }
  }

  public async beginBatch(n = 1, reason?: string): Promise<boolean> {
    if (!this.state) {
      throw new Error('UsageTracker not initialized');
    }
    const release = await this.mutex.acquire();
    try {
      const remaining = this.state.totalAllowed - this.state.used;
      if (remaining >= n) {
        this.state.used += n;
        this.pendingReserved += n;
        this.state.lastUpdatedISO = new Date().toISOString();
        await this.persist();
        if (reason) {
          this.log.debug(`Reserve ${n} calls (${reason}). New used=${this.state.used}`);
        }
        const newTier = this.computeTier();
        if (newTier !== this.currentTier) {
          const old = this.currentTier;
          this.currentTier = newTier;
          this.emit('tierChanged', { old, new: newTier, usage: this.getUsage() });
          this.log.info(`Usage tier changed: ${old} -> ${newTier}`);
        }
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
      if (this.pendingReserved >= n) {
        this.pendingReserved -= n;
        return true;
      }
      return false;
    } finally {
      release();
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

  public async resetForNewMonth(): Promise<void> {
    if (!this.state) {
      throw new Error('UsageTracker not initialized');
    }
    const release = await this.mutex.acquire();
    try {
      const now = new Date();
      this.state.year = now.getFullYear();
      this.state.month = now.getMonth() + 1;
      this.state.used = 0;
      this.state.totalAllowed = this.totalAllowed;
      this.state.lastUpdatedISO = now.toISOString();
      await this.persist();
      this.log.info('UsageTracker: month reset performed');
    } finally {
      release();
    }
  }

  private scheduleRolloverCheck(): void {
    this.rolloverInterval = setInterval(() => void this.checkRollover(), 60 * 60 * 1000);
  }

  private async checkRollover(): Promise<void> {
    if (!this.state) {
      return;
    }
    const now = new Date();
    if (now.getFullYear() !== this.state.year || (now.getMonth() + 1) !== this.state.month) {
      this.log.info('Detected month change - performing usage reset');
      await this.resetForNewMonth();
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

  public stop(): void {
    if (this.rolloverInterval) {
      clearInterval(this.rolloverInterval);
    }
  }
}
