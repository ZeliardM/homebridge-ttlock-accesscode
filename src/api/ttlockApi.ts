import type { Logging } from 'homebridge';

import axios from 'axios';
import crypto from 'crypto';
import { AxiosInstance } from 'axios';

import { UsageTracker } from './usageTracker.js';
import { SimpleMutex } from '../utils.js';
import { FeatureInfo, Passcode, SysInfo, TTLockDevice } from '../devices/deviceTypes.js';

export enum TTLockApiErrorCategory {
  AuthExpired = 'AuthExpired',
  AuthInvalid = 'AuthInvalid',
  BudgetExhausted = 'BudgetExhausted',
  ClientInvalidRequest = 'ClientInvalidRequest',
  InvalidResponse = 'InvalidResponse',
  NetworkTransient = 'NetworkTransient',
  RateLimited = 'RateLimited',
  ServerTransient = 'ServerTransient',
  Unknown = 'Unknown',
}

export class TTLockApiError extends Error {
  public wasLogged = false;

  constructor(
    message: string,
    public readonly category: TTLockApiErrorCategory,
    public readonly retryable: boolean,
    public readonly endpoint?: string,
    public readonly statusCode?: number,
    public readonly errcode?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TTLockApiError';
  }

  public get authRelated(): boolean {
    return this.category === TTLockApiErrorCategory.AuthExpired || this.category === TTLockApiErrorCategory.AuthInvalid;
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

export class TTLockApi {
  private apiClient: AxiosInstance;
  public accessToken: string | null = null;
  public refreshToken: string | null = null;
  private tokenMutex = new SimpleMutex();
  private usageTracker: UsageTracker | undefined;
  private authUsername: string | null = null;
  private authPassword: string | null = null;
  private readonly requestTimeoutMs = 15000;
  private readonly maxRetries = 3;

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
          `Authentication failed: invalid token response (${JSON.stringify(response.data)})`,
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
          `Failed to refresh token: invalid response (${JSON.stringify(response.data)})`,
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

  private async makeAuthenticatedRequest<T>(endpoint: string, method: 'GET' | 'POST' = 'GET', data?: Record<string, unknown>): Promise<T> {
    const fullEndpoint = `v3/${endpoint}`;
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

    if (this.usageTracker) {
      const consumedReserved = await this.usageTracker.consumePendingReservation(1);
      if (!consumedReserved) {
        const ok = await this.usageTracker.tryReserve(1, `request:${endpoint}`);
        if (!ok) {
          throw new TTLockApiError(
            `API usage budget exhausted (${endpoint})`,
            TTLockApiErrorCategory.BudgetExhausted,
            false,
            endpoint,
          );
        }
      }
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
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

        return response.data;
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
        if (!isLastAttempt && normalized.retryable) {
          const delay = this.getRetryDelayMs(attempt);
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

  private logApiError(message: string, error: TTLockApiError): void {
    if (error.wasLogged) {
      return;
    }

    error.wasLogged = true;
    if (this.isGatewayOfflineError(error)) {
      this.log.warn(
        `${message}: gateway offline (endpoint=${error.endpoint ?? 'unknown'} errcode=${error.errcode ?? 'n/a'}). ` +
        'Will retry on next poll/discovery cycle.',
      );
      return;
    }

    this.log.error(
      `${message}: category=${error.category} retryable=${error.retryable} endpoint=${error.endpoint ?? 'unknown'} ` +
      `status=${error.statusCode ?? 'n/a'} errcode=${error.errcode ?? 'n/a'} message=${error.message}`,
    );
  }

  private isGatewayOfflineError(error: TTLockApiError): boolean {
    return error.errcode === -3002 || /gateway is offline/i.test(error.message);
  }

  private normalizeApiResponseError(payload: ApiErrorPayload, endpoint: string): TTLockApiError {
    const errcode = payload.errcode;
    const errmsg = payload.errmsg ?? 'Unknown API error';
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
    return new TTLockApiError(
      `TTLock API returned errcode=${errcode ?? 'n/a'} errmsg=${errmsg}`,
      TTLockApiErrorCategory.ClientInvalidRequest,
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
        return new TTLockApiError(
          `Rate limited on ${endpoint ?? 'request'}: ${errmsg ?? error.message}`,
          TTLockApiErrorCategory.RateLimited,
          true,
          endpoint,
          status,
          errcode,
          error,
        );
      }

      if (!error.response || error.code === 'ECONNABORTED') {
        return new TTLockApiError(
          `Network error on ${endpoint ?? 'request'}: ${error.message}`,
          TTLockApiErrorCategory.NetworkTransient,
          true,
          endpoint,
          status,
          errcode,
          error,
        );
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
    if (typeof errcode === 'number' && [10002, 10003, 10004, 10005, 10006].includes(errcode)) {
      return true;
    }
    return /token|auth|expired|invalid_grant|credential|login/i.test(message ?? '');
  }

  private looksRateLimitError(status?: number, errcode?: number, message?: string): boolean {
    if (status === 429) {
      return true;
    }
    if (typeof errcode === 'number' && [10018, 10019, 10020].includes(errcode)) {
      return true;
    }
    return /too many|rate.?limit|frequency|limit/i.test(message ?? '');
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
    const stateResponse = await this.makeAuthenticatedRequest<{ state: number }>('lock/queryOpenState', 'GET', { lockId });
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
    sysInfo.state = stateResponse.state === 0 ? 1 : stateResponse.state === 1 ? 0 : stateResponse.state;
    return sysInfo;
  }

  public async getSysInfo(lockId: string): Promise<Partial<SysInfo>> {
    this.log.debug(`Fetching sys_info for lock: ${lockId}`);
    const sysInfo: Partial<SysInfo> = {};
    const stateResponse = await this.makeAuthenticatedRequest<{ state: number }>('lock/queryOpenState', 'GET', { lockId });
    const batteryResponse = await this.makeAuthenticatedRequest<{
      electricQuantity: number;
    }>(
      'lock/queryElectricQuantity',
      'GET',
      { lockId },
    );
    sysInfo.state = stateResponse.state === 0 ? 1 : stateResponse.state === 1 ? 0 : stateResponse.state;
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

  public async lock(lockId: string): Promise<void> {
    this.log.debug(`Locking lock: ${lockId}`);
    await this.makeAuthenticatedRequest('lock/lock', 'POST', { lockId });
    this.log.debug(`Lock ${lockId} locked`);
  }

  public async unlock(lockId: string): Promise<void> {
    this.log.debug(`Unlocking lock: ${lockId}`);
    await this.makeAuthenticatedRequest('lock/unlock', 'POST', { lockId });
    this.log.debug(`Lock ${lockId} unlocked`);
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