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
}

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
};

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

// Node fires a timer given more than 2^31-1 ms (about 24.8 days) after 1 ms instead, so the intervals that drive
// timers stay below that: 2147483 seconds for lock polling and 596 hours for discovery
const MAX_POLLING_INTERVAL_SECONDS = 2147483;
const MAX_DISCOVERY_POLLING_INTERVAL_HOURS = 596;
const MAX_WAIT_TIME_UPDATE_MS = 60000;

// Wrong types are errors. Numbers out of range are clamped with a warning instead, so a hand-edited value does not
// stop the plugin.
export function parseConfig(
  config: Record<string, unknown>,
  warn: (message: string) => void = () => undefined,
): TTLockAccessCodeConfig {
  if (!isObjectLike(config)) {
    throw new ConfigParseError('Error parsing config');
  }

  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new ConfigParseError('Error parsing config', errors);
  }

  const parsedConfig = config as TTLockAccessCodeConfigInput;

  const clamp = (key: keyof TTLockAccessCodeConfigInput, value: number, min: number, max = Infinity): number => {
    const clamped = Math.min(Math.max(value, min), max);
    if (clamped !== value) {
      const limit = value < min ? `below the minimum of ${min}` : `above the maximum of ${max}`;
      warn(`\`${key}\` is ${value}, ${limit}; using ${clamped}.`);
    }
    return clamped;
  };

  const totalApiCallsPerMonth = clamp(
    'totalApiCallsPerMonth',
    parsedConfig.totalApiCallsPerMonth ?? defaultConfig.totalApiCallsPerMonth,
    1,
  );
  const pollingInterval = clamp(
    'pollingInterval',
    parsedConfig.pollingInterval ?? defaultConfig.discoveryOptions.pollingInterval,
    30,
    MAX_POLLING_INTERVAL_SECONDS,
  );
  const discoveryPollingInterval = clamp(
    'discoveryPollingInterval',
    parsedConfig.discoveryPollingInterval ?? defaultConfig.discoveryOptions.discoveryPollingInterval,
    1,
    MAX_DISCOVERY_POLLING_INTERVAL_HOURS,
  );
  const offlineInterval = clamp(
    'offlineInterval',
    parsedConfig.offlineInterval ?? defaultConfig.discoveryOptions.offlineInterval,
    1,
  );
  const waitTimeUpdate = clamp(
    'waitTimeUpdate',
    parsedConfig.waitTimeUpdate ?? defaultConfig.advancedOptions.waitTimeUpdate,
    0,
    MAX_WAIT_TIME_UPDATE_MS,
  );

  return {
    name: parsedConfig.name ?? defaultConfig.name,
    clientId: parsedConfig.clientId ?? defaultConfig.clientId,
    clientSecret: parsedConfig.clientSecret ?? defaultConfig.clientSecret,
    username: parsedConfig.username ?? defaultConfig.username,
    password: parsedConfig.password ?? defaultConfig.password,
    totalApiCallsPerMonth,
    discoveryOptions: {
      pollingInterval: pollingInterval * 1000,
      discoveryPollingInterval: discoveryPollingInterval * 60 * 60 * 1000,
      offlineInterval: offlineInterval * 24 * 60 * 60 * 1000,
    },
    advancedOptions: {
      waitTimeUpdate,
    },
  };
}
