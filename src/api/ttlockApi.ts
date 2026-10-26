import type { Logging } from 'homebridge';

import axios from 'axios';
import crypto from 'crypto';
import { AxiosInstance } from 'axios';
import { inspect } from 'node:util';

import { UsageTracker } from './usageTracker.js';
import { SimpleMutex } from '../utils.js';
import { FeatureInfo, Passcode, SysInfo, TTLockDevice } from '../devices/deviceTypes.js';

export enum TTLockApiErrorCategory {
  AuthExpired = 'AuthExpired',
  AuthInvalid = 'AuthInvalid',
  BudgetExhausted = 'BudgetExhausted',
  ClientInvalidRequest = 'ClientInvalidRequest',
  // Not sent: the time allowed for the request ran out before it could be sent
  DeadlineExpired = 'DeadlineExpired',
  // The lock's gateway is offline (errcode -3002); sending the request again soon does not help
  GatewayOffline = 'GatewayOffline',
  InvalidResponse = 'InvalidResponse',
  NetworkTransient = 'NetworkTransient',
  RateLimited = 'RateLimited',
  ServerTransient = 'ServerTransient',
  Unknown = 'Unknown',
}

// The request never reached TTLock: the host name did not resolve, or the connection was refused or had no route
const NOT_SENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN']);
const TLS_CODE = /^(CERT_|ERR_TLS_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_)/;

// How a request that got no answer failed: 'notSent' never reached TTLock, 'noAnswer' may have reached it
// (timeouts, resets and anything not recognised), 'tls' failed on the certificate and never succeeds on a retry
export type NetworkFailure = 'notSent' | 'noAnswer' | 'tls';

// Error codes of an error and of everything it wraps. axios keeps the socket error as its cause, and a failed
// connect to a host with several addresses is an AggregateError with one error per address.
function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      codes.push(code);
    }
    queue.push((current as { cause?: unknown }).cause);
    if (current instanceof AggregateError) {
      queue.push(...current.errors);
    }
  }
  return codes;
}

function classifyNetworkFailure(codes: string[]): NetworkFailure {
  if (codes.some(code => TLS_CODE.test(code))) {
    return 'tls';
  }
  if (codes.length > 0 && codes.every(code => NOT_SENT_CODES.has(code))) {
    return 'notSent';
  }
  return 'noAnswer';
}

export class TTLockApiError extends Error {
  public wasLogged = false;
  // The gateway was busy or could not reach the lock; the request is safe to send again
  public gatewayTransient = false;
  // Set when the request got no answer from TTLock
  public networkFailure?: NetworkFailure;
  // How long TTLock asked to wait before trying again (Retry-After on HTTP 429)
  public retryAfterMs?: number;
  // Only the code of the underlying error is kept. An axios error holds the request it failed on, which carries
  // the client secret, the password hash or the access token, and a logged error must never print those.
  public readonly causeCode: string | undefined;

  constructor(
    message: string,
    public readonly category: TTLockApiErrorCategory,
    public readonly retryable: boolean,
    public readonly endpoint?: string,
    public readonly statusCode?: number,
    public readonly errcode?: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'TTLockApiError';
    this.causeCode = errorCodes(cause)[0] ?? (cause instanceof Error ? cause.name : undefined);
  }

  public get authRelated(): boolean {
    return this.category === TTLockApiErrorCategory.AuthExpired || this.category === TTLockApiErrorCategory.AuthInvalid;
  }

  // Loggers format extra arguments with util.inspect; keep a logged error to this one line
  [inspect.custom](): string {
    return `${this.name}: ${this.message} (category=${this.category} endpoint=${this.endpoint ?? 'n/a'} ` +
      `status=${this.statusCode ?? 'n/a'} errcode=${this.errcode ?? 'n/a'} cause=${this.causeCode ?? 'n/a'})`;
  }
}

type AuthResponse = {
  access_token?: string;
  refresh_token?: string;
  errcode?: number;
  errmsg?: string;
};

type ApiErrorPayload = {
  errcode?: number;
  errmsg?: string;
};

type RequestOptions = {
  // Retry gateway busy / lock unreachable errors (only lock commands; a failed poll waits for the next poll)
  retryGatewayErrors?: boolean;
  // Only retry if the retry, including its timeout, could finish within this many ms of the first attempt
  deadlineMs?: number;
  // Runs before every attempt; throw to abort the request without sending it
  beforeAttempt?: (() => void) | undefined;
};

export type TTLockSetupLock = {
  battery?: number | undefined;
  id: string;
  mac?: string | undefined;
  name: string;
  passcodeSupported: boolean;
};

export class TTLockApi {
  private apiClient: AxiosInstance;
  public accessToken: string | null = null;
  public refreshToken: string | null = null;
  private tokenMutex = new SimpleMutex();
  private usageTracker: UsageTracker | undefined;
  private authUsername: string | null = null;
  private authPassword: string | null = null;
  private readonly requestTimeoutMs = 15000;
  // These endpoints reach the lock through its gateway over Bluetooth and can take 15s+
  private readonly gatewayRequestTimeoutMs = 25000;
  private readonly maxRetries = 3;
  // A request that TTLock asks to wait longer than this before retrying is not retried: the wait would hold up
  // the lock's other requests. The next poll or discovery tries again.
  private readonly maxRetryDelayMs = 10000;
  // A lock command is not retried unless the retry could finish within this long of the first attempt,
  // so a lock never moves long after it was asked to
  private readonly lockCommandDeadlineMs = 45000;
  private static readonly gatewayEndpoints = ['lock/queryOpenState', 'lock/queryElectricQuantity', 'lock/lock', 'lock/unlock'];
  // Error codes TTLock returns for a rejected or expired token and for too many requests
  private static readonly authErrcodes = [10002, 10003, 10004, 10005, 10006];
  private static readonly rateLimitErrcodes = [10018, 10019, 10020];

  constructor(private log: Logging, private clientId: string, private clientSecret: string, usageTracker?: UsageTracker) {
    this.apiClient = axios.create({
      baseURL: 'https://euapi.ttlock.com/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: this.requestTimeoutMs,
    });
    this.log.debug('TTLockApi initialized');
    this.usageTracker = usageTracker;
  }

  private encryptPassword(password: string): string {
    return crypto.createHash('md5').update(password).digest('hex');
  }

  public async authenticate(username: string, password: string): Promise<void> {
    this.authUsername = username;
    this.authPassword = password;
    await this.authenticateWithPassword(username, password);
  }

  private async authenticateWithPassword(username: string, password: string): Promise<void> {
    this.log.debug('Authenticating with TTLock API...');
    try {
      const encryptedPassword = this.encryptPassword(password);
      if (this.usageTracker) {
        const ok = await this.usageTracker.tryReserve(1, 'authenticate');
        if (!ok) {
          throw new TTLockApiError(
            'API usage budget exhausted (authenticate)',
            TTLockApiErrorCategory.BudgetExhausted,
            false,
            'oauth2/token',
          );
        }
      }

      const response = await this.apiClient.post<AuthResponse>('oauth2/token', new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'password',
        username,
        password: encryptedPassword,
      }).toString());

      if (response.data.access_token && response.data.refresh_token) {
        this.accessToken = response.data.access_token;
        this.refreshToken = response.data.refresh_token;
        this.log.info('Authenticated with TTLock API');
      } else {
        throw new TTLockApiError(
          'Authentication failed: no token in response ' +
          `(errcode=${response.data.errcode ?? 'n/a'} errmsg=${response.data.errmsg ?? 'n/a'})`,
          TTLockApiErrorCategory.AuthInvalid,
          false,
          'oauth2/token',
          undefined,
          response.data.errcode,
        );
      }
    } catch (error) {
      const normalized = this.normalizeError(error, 'oauth2/token');
      this.logApiError('Failed to authenticate with TTLock API', normalized);
      throw normalized;
    }
  }

  private async refreshTokenIfNeededLocked(): Promise<void> {
    if (!this.refreshToken) {
      throw new TTLockApiError(
        'No refresh token available. Full re-authentication required.',
        TTLockApiErrorCategory.AuthInvalid,
        false,
        'oauth2/token',
      );
    }

    try {
      this.log.debug('Refreshing access token...');
      if (this.usageTracker) {
        const ok = await this.usageTracker.tryReserve(1, 'refreshToken');
        if (!ok) {
          throw new TTLockApiError(
            'API usage budget exhausted (refreshToken)',
            TTLockApiErrorCategory.BudgetExhausted,
            false,
            'oauth2/token',
          );
        }
      }

      const response = await this.apiClient.post<AuthResponse>('oauth2/token', new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      }).toString());

      if (response.data.access_token && response.data.refresh_token) {
        this.accessToken = response.data.access_token;
        this.refreshToken = response.data.refresh_token;
        this.log.debug('Access token refreshed');
      } else {
        throw new TTLockApiError(
          'Failed to refresh token: no token in response ' +
          `(errcode=${response.data.errcode ?? 'n/a'} errmsg=${response.data.errmsg ?? 'n/a'})`,
          TTLockApiErrorCategory.AuthInvalid,
          false,
          'oauth2/token',
          undefined,
          response.data.errcode,
        );
      }
    } catch (error) {
      throw this.normalizeError(error, 'oauth2/token');
    }
  }

  private async recoverAuthentication(failedToken: string | null, endpoint: string): Promise<void> {
    const release = await this.tokenMutex.acquire();
    try {
      if (this.accessToken && this.accessToken !== failedToken) {
        this.log.debug(`Token already refreshed by a concurrent request for endpoint ${endpoint}`);
        return;
      }

      try {
        await this.refreshTokenIfNeededLocked();
        this.log.debug(`Recovered authentication via refresh token for endpoint ${endpoint}`);
        return;
      } catch (refreshError) {
        const normalizedRefreshError = this.normalizeError(refreshError, endpoint);
        this.log.warn(`Refresh token flow failed for endpoint ${endpoint}: ${normalizedRefreshError.message}`);
      }

      if (!this.authUsername || !this.authPassword) {
        throw new TTLockApiError(
          'No stored credentials available for full re-authentication',
          TTLockApiErrorCategory.AuthInvalid,
          false,
          endpoint,
        );
      }

      await this.authenticateWithPassword(this.authUsername, this.authPassword);
      this.log.info(`Recovered authentication via full credential re-login for endpoint ${endpoint}`);
    } finally {
      release();
    }
  }

  private async makeAuthenticatedRequest<T>(
    endpoint: string,
    method: 'GET' | 'POST' = 'GET',
    data?: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<T> {
    const fullEndpoint = `v3/${endpoint}`;
    const timeout = TTLockApi.gatewayEndpoints.includes(endpoint) ? this.gatewayRequestTimeoutMs : this.requestTimeoutMs;
    const startedAt = Date.now();
    let authRecoveryAttempted = false;
    let lastError: TTLockApiError | undefined;

    if (!this.accessToken && this.authUsername && this.authPassword) {
      await this.authenticateWithPassword(this.authUsername, this.authPassword);
    }
    if (!this.accessToken) {
      throw new TTLockApiError(
        'Not authenticated and credentials are unavailable',
        TTLockApiErrorCategory.AuthInvalid,
        false,
        endpoint,
      );
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Outside the try: a guard that refuses the request must not be retried
      options.beforeAttempt?.();
      // Every attempt is a real API call, so every attempt counts against the budget
      await this.reserveApiCall(endpoint, attempt === 0);

      let attemptedToken: string | null = this.accessToken;
      try {
        attemptedToken = this.accessToken;
        const requestData = {
          ...data,
          clientId: this.clientId,
          accessToken: this.accessToken,
          date: Date.now(),
        };

        const response = await this.apiClient.request({
          url: fullEndpoint,
          method,
          timeout,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
          params: method === 'GET' ? requestData : undefined,
          data: method === 'POST'
            ? new URLSearchParams(
              Object.entries(requestData).reduce<Record<string, string>>(
                (acc, [key, value]) => {
                  acc[key] = String(value);
                  return acc;
                },
                {},
              ),
            ).toString()
            : undefined,
        });

        if (this.isObject(response.data) && 'errcode' in response.data && response.data.errcode !== 0) {
          const payload = response.data as ApiErrorPayload;
          throw this.normalizeApiResponseError(payload, endpoint);
        }
        // A body that is not JSON comes back as a string; reading fields from it would give undefined values
        if (!this.isObject(response.data)) {
          throw new TTLockApiError(
            `Unreadable response from TTLock for ${endpoint}`,
            TTLockApiErrorCategory.InvalidResponse,
            false,
            endpoint,
            response.status,
          );
        }

        return response.data as T;
      } catch (error) {
        const normalized = this.normalizeError(error, endpoint);
        lastError = normalized;

        if (normalized.authRelated && !authRecoveryAttempted) {
          authRecoveryAttempted = true;
          this.log.warn(`Auth failure for ${endpoint}; attempting internal re-authentication`);
          await this.recoverAuthentication(attemptedToken, endpoint);
          continue;
        }

        const isLastAttempt = attempt >= this.maxRetries;
        const retryable = normalized.retryable || (normalized.gatewayTransient && options.retryGatewayErrors === true);
        const delay = Math.max(this.getRetryDelayMs(attempt), normalized.retryAfterMs ?? 0);
        const pastDeadline = options.deadlineMs !== undefined &&
          Date.now() - startedAt + delay + timeout > options.deadlineMs;
        if (!isLastAttempt && retryable && !pastDeadline && delay <= this.maxRetryDelayMs) {
          this.log.warn(
            `Retryable TTLock API error on ${endpoint}; category=${normalized.category}; ` +
            `attempt=${attempt + 1}/${this.maxRetries + 1}; retrying in ${delay}ms`,
          );
          await this.sleep(delay);
          continue;
        }

        if (!this.isGatewayOfflineError(normalized)) {
          this.logApiError(`Request failed for ${endpoint}`, normalized);
        }
        throw normalized;
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new TTLockApiError('Max retries reached', TTLockApiErrorCategory.Unknown, false, endpoint);
  }

  private async reserveApiCall(endpoint: string, firstAttempt: boolean): Promise<void> {
    if (!this.usageTracker) {
      return;
    }
    // Discovery reserves its calls up front; only the first attempt of a request may use that reservation
    if (firstAttempt && await this.usageTracker.consumePendingReservation(1)) {
      return;
    }
    const reason = firstAttempt ? `request:${endpoint}` : `retry:${endpoint}`;
    if (!await this.usageTracker.tryReserve(1, reason)) {
      throw new TTLockApiError(
        `API usage budget exhausted (${endpoint})`,
        TTLockApiErrorCategory.BudgetExhausted,
        false,
        endpoint,
      );
    }
  }

  private logApiError(message: string, error: TTLockApiError): void {
    if (error.wasLogged) {
      return;
    }

    error.wasLogged = true;
    if (error.gatewayTransient) {
      this.log.warn(
        `${message}: ${error.message} (endpoint=${error.endpoint ?? 'unknown'} errcode=${error.errcode ?? 'n/a'}).`,
      );
      return;
    }
    if (this.isGatewayOfflineError(error)) {
      this.log.warn(
        `${message}: gateway offline (endpoint=${error.endpoint ?? 'unknown'} errcode=${error.errcode ?? 'n/a'}). ` +
        'Will retry on next poll/discovery cycle.',
      );
      return;
    }

    const network = error.networkFailure ? ` network=${error.networkFailure} code=${error.causeCode ?? 'n/a'}` : '';
    this.log.error(
      `${message}: category=${error.category} retryable=${error.retryable} endpoint=${error.endpoint ?? 'unknown'} ` +
      `status=${error.statusCode ?? 'n/a'} errcode=${error.errcode ?? 'n/a'}${network} message=${error.message}`,
    );
  }

  private isGatewayOfflineError(error: TTLockApiError): boolean {
    return error.category === TTLockApiErrorCategory.GatewayOffline;
  }

  // Known error codes decide first; the message text is only a fallback for codes not handled here
  private normalizeApiResponseError(payload: ApiErrorPayload, endpoint: string): TTLockApiError {
    const errcode = payload.errcode;
    const errmsg = payload.errmsg ?? 'Unknown API error';
    if (errcode === -3002) {
      return this.gatewayOfflineError(errmsg, endpoint, errcode);
    }
    // -3003: the gateway is busy. errcode 1 ("failed or means no") on a gateway endpoint: the gateway could not
    // reach the lock this time. Gateway endpoints are reads or idempotent lock/unlock, so sending them again is safe.
    if (errcode === -3003 || (errcode === 1 && TTLockApi.gatewayEndpoints.includes(endpoint))) {
      const error = new TTLockApiError(
        errcode === -3003 ? `TTLock gateway busy: ${errmsg}` : `TTLock gateway could not reach the lock: ${errmsg}`,
        TTLockApiErrorCategory.ServerTransient,
        false,
        endpoint,
        undefined,
        errcode,
      );
      error.gatewayTransient = true;
      return error;
    }
    if (this.looksAuthError(undefined, errcode, errmsg)) {
      return new TTLockApiError(
        `TTLock authentication error: ${errmsg}`,
        TTLockApiErrorCategory.AuthExpired,
        false,
        endpoint,
        undefined,
        errcode,
      );
    }
    if (this.looksRateLimitError(undefined, errcode, errmsg)) {
      return new TTLockApiError(
        `TTLock rate limit error: ${errmsg}`,
        TTLockApiErrorCategory.RateLimited,
        true,
        endpoint,
        undefined,
        errcode,
      );
    }
    if (/gateway is offline/i.test(errmsg)) {
      return this.gatewayOfflineError(errmsg, endpoint, errcode);
    }
    return new TTLockApiError(
      `TTLock API returned errcode=${errcode ?? 'n/a'} errmsg=${errmsg}`,
      TTLockApiErrorCategory.ClientInvalidRequest,
      false,
      endpoint,
      undefined,
      errcode,
    );
  }

  // Not gatewayTransient: retrying within a lock command's time limit does not bring a gateway back
  private gatewayOfflineError(errmsg: string, endpoint: string, errcode: number | undefined): TTLockApiError {
    return new TTLockApiError(
      `TTLock gateway offline: ${errmsg}`,
      TTLockApiErrorCategory.GatewayOffline,
      false,
      endpoint,
      undefined,
      errcode,
    );
  }

  private normalizeError(error: unknown, endpoint?: string): TTLockApiError {
    if (error instanceof TTLockApiError) {
      return error;
    }

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const responseData = error.response?.data as ApiErrorPayload | undefined;
      const errcode = this.isObject(responseData) ? responseData.errcode : undefined;
      const errmsg = this.isObject(responseData) ? responseData.errmsg : undefined;

      if (this.looksAuthError(status, errcode, errmsg)) {
        return new TTLockApiError(
          `Authentication failed for ${endpoint ?? 'request'}: ${errmsg ?? error.message}`,
          TTLockApiErrorCategory.AuthExpired,
          false,
          endpoint,
          status,
          errcode,
          error,
        );
      }

      if (this.looksRateLimitError(status, errcode, errmsg)) {
        const retryAfterMs = status === 429 ? this.parseRetryAfterMs(error.response?.headers?.['retry-after']) : undefined;
        const rateLimited = new TTLockApiError(
          `Rate limited on ${endpoint ?? 'request'}: ${errmsg ?? error.message}` +
          (retryAfterMs !== undefined ? ` (TTLock asked to wait ${Math.ceil(retryAfterMs / 1000)}s)` : ''),
          TTLockApiErrorCategory.RateLimited,
          true,
          endpoint,
          status,
          errcode,
          error,
        );
        if (retryAfterMs !== undefined) {
          rateLimited.retryAfterMs = retryAfterMs;
        }
        return rateLimited;
      }

      if (!error.response || error.code === 'ECONNABORTED') {
        const networkFailure = classifyNetworkFailure(errorCodes(error));
        const networkError = networkFailure === 'tls'
          ? new TTLockApiError(
            `TLS error on ${endpoint ?? 'request'}: ${error.message} (check the system clock and CA certificates)`,
            TTLockApiErrorCategory.NetworkTransient,
            false,
            endpoint,
            status,
            errcode,
            error,
          )
          : new TTLockApiError(
            `Network error on ${endpoint ?? 'request'}: ${error.message}`,
            TTLockApiErrorCategory.NetworkTransient,
            true,
            endpoint,
            status,
            errcode,
            error,
          );
        networkError.networkFailure = networkFailure;
        return networkError;
      }

      if (status !== undefined && status >= 500) {
        return new TTLockApiError(
          `Server error on ${endpoint ?? 'request'}: status=${status}`,
          TTLockApiErrorCategory.ServerTransient,
          true,
          endpoint,
          status,
          errcode,
          error,
        );
      }

      if (status !== undefined && status >= 400) {
        return new TTLockApiError(
          `Client error on ${endpoint ?? 'request'}: status=${status}`,
          TTLockApiErrorCategory.ClientInvalidRequest,
          false,
          endpoint,
          status,
          errcode,
          error,
        );
      }

      return new TTLockApiError(
        `Unknown axios error on ${endpoint ?? 'request'}: ${error.message}`,
        TTLockApiErrorCategory.Unknown,
        false,
        endpoint,
        status,
        errcode,
        error,
      );
    }

    if (error instanceof Error) {
      const isTimeout = /timed out|timeout/i.test(error.message);
      return new TTLockApiError(
        error.message,
        isTimeout ? TTLockApiErrorCategory.NetworkTransient : TTLockApiErrorCategory.Unknown,
        isTimeout,
        endpoint,
        undefined,
        undefined,
        error,
      );
    }

    return new TTLockApiError(
      `Unknown error: ${JSON.stringify(error)}`,
      TTLockApiErrorCategory.Unknown,
      false,
      endpoint,
      undefined,
      undefined,
      error,
    );
  }

  private looksAuthError(status?: number, errcode?: number, message?: string): boolean {
    if (status === 401 || status === 403) {
      return true;
    }
    if (typeof errcode === 'number' && TTLockApi.authErrcodes.includes(errcode)) {
      return true;
    }
    // Only wording that names a token problem. Words like 'auth', 'login' or 'expired' also appear in lock and
    // passcode errors, and treating those as auth errors costs a token refresh, a login and a retry each time.
    return /invalid.?token|token.*(expired|invalid)|invalid_grant|access.?token/i.test(message ?? '');
  }

  private looksRateLimitError(status?: number, errcode?: number, message?: string): boolean {
    if (status === 429) {
      return true;
    }
    if (typeof errcode === 'number' && TTLockApi.rateLimitErrcodes.includes(errcode)) {
      return true;
    }
    // Not a bare 'limit', which also appears in other errors (for example a limit on passcodes); rate limited
    // requests are retried, and a passcode add must not be sent again for that
    return /too many requests|rate.?limit|too frequent/i.test(message ?? '');
  }

  // Retry-After is a number of seconds or an HTTP date
  private parseRetryAfterMs(value: unknown): number | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return undefined;
    }
    const text = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(text)) {
      return Math.round(Number(text) * 1000);
    }
    const date = Date.parse(text);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
  }

  private getRetryDelayMs(attempt: number): number {
    const baseDelay = Math.min(8000, Math.pow(2, attempt) * 1000);
    const jitter = Math.floor(Math.random() * 250);
    return baseDelay + jitter;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  public async listLocksForSetup(): Promise<TTLockSetupLock[]> {
    const response = await this.makeAuthenticatedRequest<{
      list: { electricQuantity?: number; featureValue?: string; lockAlias?: string; lockId: string | number; lockMac?: string }[];
      pageNo: number;
      pageSize: number;
      pages: number;
      total: number;
    }>('lock/list', 'GET', { pageNo: 1, pageSize: 1000 });

    if (!response.list || !Array.isArray(response.list)) {
      this.log.error('Invalid response format: expected list of locks');
      throw new TTLockApiError(
        'Invalid response format: expected list of locks',
        TTLockApiErrorCategory.InvalidResponse,
        false,
        'lock/list',
      );
    }

    const locks: TTLockSetupLock[] = [];
    for (const lock of response.list) {
      const featureInfo = await this.getFeatureInfo(lock.featureValue ?? '');
      const id = lock.lockId.toString();
      locks.push({
        battery: lock.electricQuantity,
        id,
        mac: lock.lockMac,
        name: lock.lockAlias || id,
        passcodeSupported: featureInfo.passcode,
      });
    }
    return locks;
  }

  public async getDevices(): Promise<TTLockDevice[]> {
    const response = await this.makeAuthenticatedRequest<{
      list: { electricQuantity: number; featureValue: string; lockAlias: string; lockId: string; lockMac: string }[];
      pageNo: number;
      pageSize: number;
      pages: number;
      total: number;
    }>('lock/list', 'GET', { pageNo: 1, pageSize: 1000 });

    if (!response.list || !Array.isArray(response.list)) {
      this.log.error('Invalid response format: expected list of locks');
      throw new TTLockApiError(
        'Invalid response format: expected list of locks',
        TTLockApiErrorCategory.InvalidResponse,
        false,
        'lock/list',
      );
    }

    const lockList: TTLockDevice[] = [];
    for (const lock of response.list) {
      try {
        const ttlockDevice: TTLockDevice = {} as TTLockDevice;
        ttlockDevice.feature_info = await this.getFeatureInfo(lock.featureValue);
        ttlockDevice.sys_info = await this.getDeviceDetails(lock.lockId) as SysInfo;
        ttlockDevice.sys_info.alias = lock.lockAlias;
        ttlockDevice.sys_info.battery = lock.electricQuantity;
        ttlockDevice.sys_info.device_id = lock.lockId.toString();
        ttlockDevice.sys_info.mac = lock.lockMac;
        if (ttlockDevice.feature_info.passcode) {
          ttlockDevice.sys_info.passcodes = await this.getPasscodes(lock.lockId);
        }
        ttlockDevice.offline = false;
        ttlockDevice.last_seen = new Date();
        lockList.push(ttlockDevice);
      } catch (error) {
        const normalized = this.normalizeError(error, 'lock/detail|lock/queryOpenState');
        this.logApiError(`Failed to fetch details for lock ${lock.lockId}`, normalized);
        continue;
      }
    }
    return lockList;
  }

  async getDeviceDetails(lockId: string): Promise<Partial<SysInfo>> {
    const sysInfo: Partial<SysInfo> = {};
    const detailResponse = await this.makeAuthenticatedRequest<{
      firmwareRevision: string;
      hardwareRevision: string;
      modelNum: string;
    }>('lock/detail', 'GET', { lockId });
    const stateResponse = await this.queryStateForDiscovery(lockId);
    if (!detailResponse.firmwareRevision || !detailResponse.hardwareRevision || !detailResponse.modelNum) {
      throw new TTLockApiError(
        `Invalid lock/detail response for lockId=${lockId}`,
        TTLockApiErrorCategory.InvalidResponse,
        false,
        'lock/detail',
      );
    }
    sysInfo.fw_ver = detailResponse.firmwareRevision.split('.').slice(0, 3).join('.');
    sysInfo.hw_ver = detailResponse.hardwareRevision;
    sysInfo.model = detailResponse.modelNum;
    const state = this.toHomeKitLockState(stateResponse?.state);
    if (state !== undefined) {
      sysInfo.state = state;
    }
    return sysInfo;
  }

  // lock/queryOpenState state: 0 locked, 1 unlocked, 2 unknown. HomeKit LockCurrentState: 0 UNSECURED, 1 SECURED,
  // 2 JAMMED, 3 UNKNOWN. Anything but 0 or 1 is UNKNOWN, never JAMMED; undefined when TTLock sent no state at all.
  private toHomeKitLockState(state: unknown): number | undefined {
    if (state === 0) {
      return 1;
    }
    if (state === 1) {
      return 0;
    }
    return typeof state === 'number' ? 3 : undefined;
  }

  // A busy gateway or a lock it briefly cannot reach must not drop the lock until the next discovery (12h by
  // default). Return undefined instead, so the lock is kept and the next poll fills in its state.
  private async queryStateForDiscovery(lockId: string): Promise<{ state: number } | undefined> {
    try {
      return await this.makeAuthenticatedRequest<{ state: number }>('lock/queryOpenState', 'GET', { lockId });
    } catch (error) {
      const temporary = error instanceof TTLockApiError && (
        error.gatewayTransient ||
        error.category === TTLockApiErrorCategory.GatewayOffline ||
        error.category === TTLockApiErrorCategory.NetworkTransient ||
        error.category === TTLockApiErrorCategory.RateLimited ||
        error.category === TTLockApiErrorCategory.ServerTransient
      );
      if (!temporary) {
        throw error;
      }
      this.log.warn(`Could not read the state of lock ${lockId} during discovery (${error.message}); keeping the lock`);
      return undefined;
    }
  }

  public async getSysInfo(lockId: string): Promise<Partial<SysInfo>> {
    this.log.debug(`Fetching sys_info for lock: ${lockId}`);
    const sysInfo: Partial<SysInfo> = {};
    const stateResponse = await this.makeAuthenticatedRequest<{
      state: number;
      electricQuantity?: number;
    }>('lock/queryOpenState', 'GET', { lockId });
    const state = this.toHomeKitLockState(stateResponse.state);
    if (state === undefined) {
      // Showing a state TTLock did not send would be a guess; keep the last known one
      throw new TTLockApiError(
        `lock/queryOpenState returned no lock state for lockId=${lockId}`,
        TTLockApiErrorCategory.InvalidResponse,
        false,
        'lock/queryOpenState',
      );
    }
    // lock/queryOpenState also returns electricQuantity; only make the extra call if it is missing
    const batteryResponse = typeof stateResponse.electricQuantity === 'number'
      ? { electricQuantity: stateResponse.electricQuantity }
      : await this.makeAuthenticatedRequest<{
        electricQuantity: number;
      }>(
        'lock/queryElectricQuantity',
        'GET',
        { lockId },
      );
    sysInfo.state = state;
    sysInfo.battery = batteryResponse.electricQuantity;
    return sysInfo;
  }

  async getFeatureInfo(featureValue: string): Promise<FeatureInfo> {
    this.log.debug('Calculating feature info');
    const featureInfo: FeatureInfo = {} as FeatureInfo;
    try {
      if (!featureValue || typeof featureValue !== 'string') {
        featureInfo.passcode = false;
        return featureInfo;
      }
      const hex = featureValue.replace(/[^0-9a-fA-F]/g, '') || '0';
      const value = BigInt(`0x${hex}`);
      featureInfo.passcode = ((value >> 0n) & 1n) === 1n;
      return featureInfo;
    } catch (error) {
      const normalized = this.normalizeError(error, 'feature/parse');
      this.logApiError('Failed to parse featureValue', normalized);
      featureInfo.passcode = false;
      return featureInfo;
    }
  }

  // beforeAttempt runs before every attempt, including retries, so a safety check can stop a retry
  public async lock(lockId: string, beforeAttempt?: () => void): Promise<void> {
    this.log.debug(`Locking lock: ${lockId}`);
    await this.makeAuthenticatedRequest('lock/lock', 'POST', { lockId }, this.lockCommandOptions(beforeAttempt));
    this.log.debug(`Lock ${lockId} locked`);
  }

  public async unlock(lockId: string, beforeAttempt?: () => void): Promise<void> {
    this.log.debug(`Unlocking lock: ${lockId}`);
    await this.makeAuthenticatedRequest('lock/unlock', 'POST', { lockId }, this.lockCommandOptions(beforeAttempt));
    this.log.debug(`Lock ${lockId} unlocked`);
  }

  private lockCommandOptions(beforeAttempt?: () => void): RequestOptions {
    return { retryGatewayErrors: true, deadlineMs: this.lockCommandDeadlineMs, beforeAttempt };
  }

  public async getPasscodes(lockId: string): Promise<Passcode[]> {
    this.log.debug(`Fetching passcodes for lock: ${lockId}`);
    const response = await this.makeAuthenticatedRequest<{
      list: {
        keyboardPwdId: string;
        lockId: string;
        keyboardPwd: string;
      }[];
      pageNo: number;
      pageSize: number;
      pages: number;
      total: number;
    }>('lock/listKeyboardPwd', 'GET', { lockId, pageNo: 1, pageSize: 1000, orderBy: 0 });

    if (!response.list || !Array.isArray(response.list)) {
      this.log.error('Invalid response format: expected list of passcodes');
      throw new TTLockApiError(
        'Invalid response format: expected list of passcodes',
        TTLockApiErrorCategory.InvalidResponse,
        false,
        'lock/listKeyboardPwd',
      );
    }

    this.log.debug(`Found ${response.list.length} passcodes for lock: ${lockId}`);
    return response.list.map((item, index) => ({
      passcode_id: item.keyboardPwdId.toString(),
      index: index.toString(),
      lock_id: item.lockId.toString(),
      passcode: item.keyboardPwd,
    }));
  }

  public async addPasscode(lockId: string, passcode: string): Promise<{ keyboardPwdId: string }> {
    this.log.debug(`Adding passcode to lock: ${lockId}`);
    const response = await this.makeAuthenticatedRequest<{ keyboardPwdId: string }>('keyboardPwd/add', 'POST', {
      lockId,
      keyboardPwd: passcode,
      keyboardPwdType: 2,
      addType: 2,
    });
    this.log.debug(`Passcode added to lock: ${lockId}`);
    return response;
  }

  public async deletePasscode(lockId: string, passcodeId: string): Promise<void> {
    this.log.debug(`Deleting passcode for lock: ${lockId}`);
    await this.makeAuthenticatedRequest('keyboardPwd/delete', 'POST', {
      lockId,
      keyboardPwdId: passcodeId,
      deleteType: 2,
    });
    this.log.debug(`Passcode deleted for lock: ${lockId}`);
  }
}
