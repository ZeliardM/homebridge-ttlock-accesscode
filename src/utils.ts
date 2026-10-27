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

  // True while held, and while anyone waits for it
  get locked(): boolean {
    return this._locked;
  }

  async acquire(): Promise<() => void> {
    if (this._locked) {
      // Release hands the mutex straight to the next waiter, so waiters get it in order and nobody can take it
      // in between
      await new Promise<void>(resolve => this._waiting.push(resolve));
    } else {
      this._locked = true;
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this._waiting.shift();
      if (next) {
        next();
      } else {
        this._locked = false;
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
  let running = false;

  const schedule = () => {
    if (!timer && !running) {
      timer = setTimeout(processRequests, timeout);
    }
  };

  const processRequests = () => {
    timer = null;
    running = true;
    const currentRequests = requests;
    requests = [];
    let result: Promise<T>;
    try {
      if (fn.length === 0) {
        result = (fn as () => Promise<T>)();
      } else {
        result = (fn as (requestCount: number) => Promise<T>)(currentRequests.length);
      }
    } catch (error) {
      result = Promise.reject(error);
    }
    // One run at a time: requests that arrive while fn is running wait for it to settle, then get their own run.
    result
      .then(value => currentRequests.forEach(req => req.resolve(value)))
      .catch(error => currentRequests.forEach(req => req.reject(error)))
      .finally(() => {
        running = false;
        if (requests.length > 0) {
          schedule();
        }
      });
  };

  return (arg?: U) => {
    if (runNowFn && arg !== undefined) {
      runNowFn(arg);
    }

    return new Promise<T>((resolve, reject) => {
      requests.push({ resolve, reject });
      schedule();
    });
  };
}

export function isObjectLike(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null || typeof candidate === 'function';
}

export interface PackageConfig {
  name: string;
  version: string;
  engines: { homebridge: string; node: string };
}

export async function loadPackageConfig(logger: Logging): Promise<PackageConfig> {
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

  // Each alternative is a caret range (a bare version is read as one): at least that version, within the same major
  // version, or the same minor version for 0.x. So "^22 || ^24" accepts 22.x and 24.x, but not 23 or 25.
  return versions.some(version => {
    const [requiredMajor, requiredMinor, requiredPatch] = parseVersionParts(version);

    if (currentMajor !== requiredMajor) {
      return false;
    }
    if (requiredMajor === 0 && currentMinor !== requiredMinor) {
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
