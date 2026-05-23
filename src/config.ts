import { isObjectLike } from './utils.js';

export class ConfigParseError extends Error {
  constructor(
    message: string,
    public errors?: string[] | null,
    public unknownError?: unknown,
  ) {
    super(message);
    this.name = 'ConfigParseError';
    this.message = this.formatMessage(message, errors, unknownError);
    Error.captureStackTrace(this, this.constructor);
  }

  private formatMessage(
    message: string,
    errors?: string[] | null,
    unknownError?: unknown,
  ): string {
    let formattedMessage = message;
    if (errors && errors.length > 0) {
      const errorsAsString = errors.join('\n');
      formattedMessage += `:\n${errorsAsString}`;
    }
    if (unknownError instanceof Error) {
      formattedMessage += `\nAdditional Error: ${unknownError.message}`;
    } else if (unknownError) {
      formattedMessage += `\nAdditional Error: [Error details not available: ${unknownError}]`;
    }
    return formattedMessage;
  }
}

export interface TTLockAccessCodeConfigInput {
  name?: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  totalApiCallsPerMonth?: number;
  pollingInterval?: number;
  discoveryPollingInterval?: number;
  offlineInterval?: number;
  waitTimeUpdate?: number;
  externalDoors?: ExternalDoorsConfigInput;
}

export interface ExternalDoorsConfigInput {
  doorPollingInterval?: number;
  hubs?: ExternalDoorHubConfigInput[];
  doors?: ExternalDoorConfigInput[];
}

export interface ExternalDoorHubConfigInput {
  ip?: string;
  accessToken?: string;
}

export interface ExternalDoorConfigInput {
  name?: string;
  sensor?: string;
  lock?: string;
}

export type ManualDoorConfig = {
  id: string;
  name: string;
  sensor: string;
  lock: string;
};

export type ManualDoorHubConfig = {
  ip: string;
  accessToken: string;
};

export type ExternalDoorsConfig = {
  doorPollingInterval: number;
  hubs: ManualDoorHubConfig[];
  doors: ManualDoorConfig[];
};

export type TTLockAccessCodeConfig = {
  name: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  totalApiCallsPerMonth: number;
  discoveryOptions: {
    pollingInterval: number;
    discoveryPollingInterval: number;
    offlineInterval: number;
  };
  advancedOptions: {
    waitTimeUpdate: number;
  };
  externalDoors: ExternalDoorsConfig;
};

const DEFAULT_MANUAL_DOOR_POLLING_INTERVAL_SECONDS = 60;

export const defaultConfig: TTLockAccessCodeConfig = {
  name: 'TTLockAccessCode',
  clientId: '',
  clientSecret: '',
  username: '',
  password: '',
  totalApiCallsPerMonth: 30000,
  discoveryOptions: {
    pollingInterval: 300,
    discoveryPollingInterval: 12,
    offlineInterval: 7,
  },
  advancedOptions: {
    waitTimeUpdate: 100,
  },
  externalDoors: {
    doorPollingInterval: DEFAULT_MANUAL_DOOR_POLLING_INTERVAL_SECONDS * 1000,
    hubs: [],
    doors: [],
  },
};

function validateConfig(config: Record<string, unknown>): string[] {
  const errors: string[] = [];

  validateType(config, 'name', 'string', errors);
  validateType(config, 'clientId', 'string', errors);
  validateType(config, 'clientSecret', 'string', errors);
  validateType(config, 'username', 'string', errors);
  validateType(config, 'password', 'string', errors);
  validateType(config, 'totalApiCallsPerMonth', 'number', errors);
  validateType(config, 'pollingInterval', 'number', errors);
  validateType(config, 'discoveryPollingInterval', 'number', errors);
  validateType(config, 'offlineInterval', 'number', errors);
  validateType(config, 'waitTimeUpdate', 'number', errors);
  validateExternalDoorsConfig(config, errors);

  return errors;
}

function validateType(
  config: Record<string, unknown>,
  key: string,
  expectedType: string,
  errors: string[],
) {
  if (config[key] !== undefined && typeof config[key] !== expectedType) {
    errors.push(`\`${key}\` should be a ${expectedType}.`);
  }
}

function validateExternalDoorsConfig(config: Record<string, unknown>, errors: string[]): void {
  if (config.externalDoors === undefined) {
    return;
  }

  if (!isObjectLike(config.externalDoors)) {
    errors.push('`externalDoors` should be an object.');
    return;
  }

  const externalDoors = config.externalDoors;
  validateOptionalType(externalDoors, 'externalDoors', 'doorPollingInterval', 'number', errors);
  validateExternalDoorHubs(externalDoors.hubs, errors);
  validateExternalDoors(externalDoors.doors, errors);

  if (
    Array.isArray(externalDoors.doors) &&
    externalDoors.doors.length > 0 &&
    (!Array.isArray(externalDoors.hubs) || externalDoors.hubs.length === 0)
  ) {
    errors.push('`externalDoors.hubs` should include at least one DIRIGERA hub when external doors are configured.');
  }

  if (
    Array.isArray(externalDoors.doors) &&
    externalDoors.doors.length > 0 &&
    Array.isArray(externalDoors.hubs) &&
    !externalDoors.hubs.some(hub => isObjectLike(hub) && typeof hub.accessToken === 'string' && hub.accessToken.trim().length > 0)
  ) {
    errors.push('`externalDoors.hubs` should include at least one paired DIRIGERA hub when external doors are configured.');
  }
}

function validateExternalDoorHubs(hubs: unknown, errors: string[]): void {
  if (hubs === undefined) {
    return;
  }

  if (!Array.isArray(hubs)) {
    errors.push('`externalDoors.hubs` should be an array.');
    return;
  }

  hubs.forEach((hub, hubIndex) => {
    if (!isObjectLike(hub)) {
      errors.push(`\`externalDoors.hubs[${hubIndex}]\` should be an object.`);
      return;
    }
    validateRequiredString(hub, `externalDoors.hubs[${hubIndex}]`, 'ip', errors);
    validateDirigeraAccessToken(hub, `externalDoors.hubs[${hubIndex}]`, errors);
  });
}

function validateExternalDoors(doors: unknown, errors: string[]): void {
  if (doors === undefined) {
    return;
  }

  if (!Array.isArray(doors)) {
    errors.push('`externalDoors.doors` should be an array.');
    return;
  }

  doors.forEach((door, doorIndex) => {
    if (!isObjectLike(door)) {
      errors.push(`\`externalDoors.doors[${doorIndex}]\` should be an object.`);
      return;
    }

    validateRequiredString(door, `externalDoors.doors[${doorIndex}]`, 'name', errors);
    validateRequiredString(door, `externalDoors.doors[${doorIndex}]`, 'sensor', errors);
    validateRequiredString(door, `externalDoors.doors[${doorIndex}]`, 'lock', errors);
  });
}

function validateRequiredString(
  config: Record<string, unknown>,
  path: string,
  key: string,
  errors: string[],
): void {
  if (typeof config[key] !== 'string' || config[key].trim().length === 0) {
    errors.push(`\`${path}.${key}\` should be a non-empty string.`);
  }
}

function validateOptionalType(
  config: Record<string, unknown>,
  path: string,
  key: string,
  expectedType: string,
  errors: string[],
): void {
  if (config[key] !== undefined && typeof config[key] !== expectedType) {
    errors.push(`\`${path}.${key}\` should be a ${expectedType}.`);
  }
}

function validateDirigeraAccessToken(
  config: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (typeof config.accessToken !== 'string' || config.accessToken.trim().length === 0) {
    return;
  }

  const tokenSegments = config.accessToken.trim().split('.');
  if (tokenSegments.length !== 3 || tokenSegments.some(segment => segment.length === 0)) {
    errors.push(
      `\`${path}.accessToken\` should be the complete DIRIGERA access token generated by pairing. ` +
      'It should have three dot-separated JWT segments.',
    );
  }
}

export function generateManualDoorId(name: string, usedIds = new Set<string>()): string {
  const base = slugify(name);
  let candidate = base;
  let index = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${index}`;
    index++;
  }
  usedIds.add(candidate);
  return candidate;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'manual-door';
}

function parseExternalDoorsConfig(externalDoors?: ExternalDoorsConfigInput): ExternalDoorsConfig {
  const doorPollingInterval = Math.max(
    10,
    externalDoors?.doorPollingInterval ?? DEFAULT_MANUAL_DOOR_POLLING_INTERVAL_SECONDS,
  ) * 1000;
  const usedIds = new Set<string>();

  return {
    doorPollingInterval,
    hubs: (externalDoors?.hubs ?? []).map(hub => ({
      ip: hub.ip?.trim() ?? '',
      accessToken: hub.accessToken?.trim() ?? '',
    })),
    doors: (externalDoors?.doors ?? []).map(door => ({
      id: generateManualDoorId(door.name?.trim() ?? '', usedIds),
      name: door.name?.trim() ?? '',
      sensor: door.sensor?.trim() ?? '',
      lock: door.lock?.trim() ?? '',
    })),
  };
}

export function parseConfig(config: Record<string, unknown>): TTLockAccessCodeConfig {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new ConfigParseError('Error parsing config', errors);
  }

  if (!isObjectLike(config)) {
    throw new ConfigParseError('Error parsing config');
  }

  const parsedConfig = config as TTLockAccessCodeConfigInput;

  return {
    name: parsedConfig.name ?? defaultConfig.name,
    clientId: parsedConfig.clientId ?? defaultConfig.clientId,
    clientSecret: parsedConfig.clientSecret ?? defaultConfig.clientSecret,
    username: parsedConfig.username ?? defaultConfig.username,
    password: parsedConfig.password ?? defaultConfig.password,
    totalApiCallsPerMonth: parsedConfig.totalApiCallsPerMonth ?? defaultConfig.totalApiCallsPerMonth,
    discoveryOptions: {
      pollingInterval: (parsedConfig.pollingInterval ?? defaultConfig.discoveryOptions.pollingInterval) * 1000,
      discoveryPollingInterval: (
        (parsedConfig.discoveryPollingInterval ??
          defaultConfig.discoveryOptions.discoveryPollingInterval)
        * 60 * 60 * 1000
      ),
      offlineInterval: (parsedConfig.offlineInterval ?? defaultConfig.discoveryOptions.offlineInterval) * 24 * 60 * 60 * 1000,
    },
    advancedOptions: {
      waitTimeUpdate: parsedConfig.waitTimeUpdate ?? defaultConfig.advancedOptions.waitTimeUpdate,
    },
    externalDoors: parseExternalDoorsConfig(parsedConfig.externalDoors),
  };
}
