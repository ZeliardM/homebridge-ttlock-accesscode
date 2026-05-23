import { EventEmitter } from 'node:events';

import type { Logger } from 'homebridge';

import type { ManualDoorHubConfig } from '../config.js';

export interface DirigeraDoorSensorUpdate {
  sensorId: string;
  isOpen: boolean;
  batteryPercentage?: number | undefined;
  isReachable?: boolean | undefined;
  source: 'initial' | 'event' | 'poll';
}

export interface DirigeraDoorSensorUnavailable {
  sensorId: string;
  error: string;
  source: 'initial' | 'event' | 'poll';
}

type DirigeraSensor = {
  id: string;
  isReachable?: boolean;
  attributes?: {
    batteryPercentage?: number;
    customName?: string;
    isOpen?: boolean;
    model?: string;
  };
};

export default class DirigeraApi extends EventEmitter {
  private client?: {
    openCloseSensors: {
      get: (options: { id: string }) => Promise<DirigeraSensor>;
      list: () => Promise<DirigeraSensor[]>;
    };
    startListeningForUpdates: (handler: (event: unknown) => void) => void;
    stopListeningForUpdates?: () => void;
  };

  private pollingInterval: NodeJS.Timeout | undefined;
  private sensorIds = new Set<string>();

  constructor(
    private readonly config: ManualDoorHubConfig,
    private readonly pollingIntervalMs: number,
    private readonly candidateSensorIds: Set<string>,
    private readonly log: Logger,
  ) {
    super();
  }

  public async start(): Promise<Set<string>> {
    const { createDirigeraClient } = await import('dirigera');

    this.client = await createDirigeraClient({
      gatewayIP: this.config.ip,
      accessToken: this.config.accessToken,
    });

    this.sensorIds = await this.resolveConfiguredSensors();
    if (this.sensorIds.size === 0) {
      this.log.info(`DIRIGERA connected at ${this.config.ip}; no configured manual door sensors were found on this hub`);
      return new Set();
    }

    this.log.info(`DIRIGERA connected at ${this.config.ip} for ${this.sensorIds.size} manual door sensor(s)`);
    await this.pollSensors('initial');
    this.startListeningForUpdates();
    this.startPolling();
    return new Set(this.sensorIds);
  }

  public stop(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }

    try {
      this.client?.stopListeningForUpdates?.();
    } catch (error) {
      this.log.debug('Failed to stop DIRIGERA listener:', error);
    }
  }

  private async resolveConfiguredSensors(): Promise<Set<string>> {
    if (!this.client) {
      return new Set();
    }

    const sensors = await this.client.openCloseSensors.list();
    const hubSensorIds = new Set(sensors.map(sensor => sensor.id));
    return new Set(Array.from(this.candidateSensorIds).filter(sensorId => hubSensorIds.has(sensorId)));
  }

  private startListeningForUpdates(): void {
    this.client?.startListeningForUpdates((event: unknown) => {
      if (!this.isObject(event)) {
        return;
      }
      if (event.type !== 'deviceStateChanged' || !this.isObject(event.data)) {
        return;
      }

      const sensorId = typeof event.data.id === 'string' ? event.data.id : undefined;
      if (!sensorId || !this.sensorIds.has(sensorId)) {
        return;
      }

      const isReachable = typeof event.data.isReachable === 'boolean' ? event.data.isReachable : undefined;
      const attributes = this.isObject(event.data.attributes) ? event.data.attributes : undefined;

      if (isReachable === false && typeof attributes?.isOpen !== 'boolean') {
        this.emitUnavailable(sensorId, 'DIRIGERA sensor is not reachable', 'event');
        return;
      }

      if (typeof attributes?.isOpen !== 'boolean') {
        return;
      }

      this.emitUpdate({
        sensorId,
        isOpen: attributes.isOpen,
        batteryPercentage: typeof attributes.batteryPercentage === 'number' ? attributes.batteryPercentage : undefined,
        isReachable,
        source: 'event',
      });
    });
  }

  private startPolling(): void {
    this.pollingInterval = setInterval(() => void this.pollSensors('poll'), this.pollingIntervalMs);
    this.pollingInterval.unref?.();
  }

  private async pollSensors(source: 'initial' | 'poll'): Promise<void> {
    if (!this.client) {
      return;
    }

    for (const sensorId of this.sensorIds) {
      try {
        const sensor = await this.client.openCloseSensors.get({ id: sensorId });
        const isReachable = sensor.isReachable !== false;

        if (!isReachable) {
          this.emitUnavailable(sensorId, 'DIRIGERA sensor is not reachable', source);
          continue;
        }

        if (typeof sensor.attributes?.isOpen !== 'boolean') {
          this.emitUnavailable(sensorId, 'DIRIGERA sensor did not report an open/closed state', source);
          continue;
        }

        this.emitUpdate({
          sensorId,
          isOpen: sensor.attributes.isOpen,
          batteryPercentage: sensor.attributes.batteryPercentage,
          isReachable,
          source,
        });
      } catch (error) {
        this.emitUnavailable(sensorId, error instanceof Error ? error.message : String(error), source);
      }
    }
  }

  private emitUpdate(update: DirigeraDoorSensorUpdate): void {
    this.emit('sensorUpdate', update);
  }

  private emitUnavailable(sensorId: string, error: string, source: 'initial' | 'event' | 'poll'): void {
    this.emit('sensorUnavailable', { sensorId, error, source } satisfies DirigeraDoorSensorUnavailable);
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
