import { LogLevel } from 'homebridge';
import type {
  Characteristic,
  Logger,
  Logging,
} from 'homebridge';

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class SimpleMutex {
  private _locked = false;
  private _waiting: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    while (this._locked) {
      await new Promise<void>(resolve => this._waiting.push(resolve));
    }
    this._locked = true;
    return () => {
      this._locked = false;
      if (this._waiting.length > 0) {
        const next = this._waiting.shift();
        if (next) {
          next();
        }
      }
    };
  }
}

export function deferAndCombine<T, U>(
  fn: ((requestCount: number) => Promise<T>) | (() => Promise<T>),
  timeout: number,
  runNowFn?: (arg: U) => void,
): (arg?: U) => Promise<T> {
  let requests: { resolve: (value: T) => void; reject: (reason?: unknown) => void }[] = [];
  let timer: NodeJS.Timeout | null = null;

  const processRequests = () => {
    const currentRequests = requests;
    requests = [];
    let result: Promise<T>;
    if (fn.length === 0) {
      result = (fn as () => Promise<T>)();
    } else {
      result = (fn as (requestCount: number) => Promise<T>)(currentRequests.length);
    }
    result
      .then(value => currentRequests.forEach(req => req.resolve(value)))
      .catch(error => currentRequests.forEach(req => req.reject(error)))
      .finally(() => {
        timer = null;
      });
  };

  return (arg?: U) => {
    if (runNowFn && arg !== undefined) {
      runNowFn(arg);
    }

    return new Promise<T>((resolve, reject) => {
      requests.push({ resolve, reject });

      if (!timer) {
        timer = setTimeout(processRequests, timeout);
      }
    });
  };
}

export function isObjectLike(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null || typeof candidate === 'function';
}

export async function loadPackageConfig(logger: Logging): Promise<{ name: string; version: string; engines: { node: string } }> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const packageConfigPath = path.join(__dirname, '..', 'package.json');
  const log: Logger = prefixLogger(logger, '[Package Config]');
  log.debug('Loading package configuration from:', packageConfigPath);

  try {
    const packageConfigData = await fs.readFile(packageConfigPath, 'utf8');
    return JSON.parse(packageConfigData);
  } catch (error) {
    log.error(`Error reading package.json: ${error}`);
    throw error;
  }
}

export function lookup<T>(
  object: unknown,
  compareFn: undefined | ((objectProp: unknown, search: T) => boolean),
  value: T,
): string | undefined {
  const compare = compareFn ?? ((objectProp: unknown, search: T): boolean => objectProp === search);

  if (isObjectLike(object)) {
    return Object.keys(object).find(key => compare(object[key], value));
  }
  return undefined;
}

export function lookupCharacteristicNameByUUID(
  characteristic: typeof Characteristic,
  uuid: string,
): string | undefined {
  return Object.keys(characteristic).find(key => {
    const candidate = (characteristic as unknown as {[key: string]: {UUID: string} | undefined})[key];
    return candidate?.UUID === uuid;
  });
}

export function prefixLogger(logger: Logger, prefix: string | (() => string)): Logging {
  const methods: Array<'info' | 'warn' | 'error' | 'debug' | 'log'> = ['info', 'warn', 'error', 'debug', 'log'];
  const clonedLogger: Logging = methods.reduce((acc: Logging, method) => {
    acc[method] = (...args: unknown[]) => {
      const prefixString = typeof prefix === 'function' ? prefix() : prefix;
      if (method === 'log') {
        const [level, message, ...parameters] = args;
        logger[method](level as LogLevel, `${prefixString} ${message}`, ...parameters);
      } else {
        const [message, ...parameters] = args;
        logger[method](`${prefixString} ${message}`, ...parameters);
      }
    };
    return acc;
  }, {} as Logging);

  (clonedLogger as { prefix: string | (() => string) }).prefix = typeof logger.prefix === 'string' ? `${prefix} ${logger.prefix}` : prefix;

  return clonedLogger;
}

export function satisfiesVersion(currentVersion: string, requiredVersion: string): boolean {
  const parseVersionParts = (version: string): [number, number, number] => {
    const [major = '0', minor = '0', patch = '0'] = version.replace('^', '').replace('v', '').split('.');
    return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0];
  };

  const versions = requiredVersion.split('||').map(v => v.trim());
  const [currentMajor, currentMinor, currentPatch] = parseVersionParts(currentVersion);

  return versions.some(version => {
    const [requiredMajor, requiredMinor, requiredPatch] = parseVersionParts(version);

    if (currentMajor > requiredMajor) {
      return true;
    }
    if (currentMajor < requiredMajor) {
      return false;
    }
    if (currentMinor > requiredMinor) {
      return true;
    }
    if (currentMinor < requiredMinor) {
      return false;
    }
    return currentPatch >= requiredPatch;
  });
}
