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
  totalApiCallsPerMonth: 100000,
  discoveryOptions: {
    pollingInterval: 90,
    discoveryPollingInterval: 6,
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

export function parseConfig(config: Record<string, unknown>): TTLockAccessCodeConfig {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new ConfigParseError('Error parsing config', errors);
  }

  if (!isObjectLike(config)) {
    throw new ConfigParseError('Error parsing config');
  }

  const parsedConfig = { ...defaultConfig, ...config } as TTLockAccessCodeConfigInput;

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
  };
}