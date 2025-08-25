import type { Logging } from 'homebridge';
import axios, { AxiosInstance } from 'axios';
import { Mutex } from 'async-mutex';
import crypto from 'crypto';
import qs from 'qs';

import { BatteryLevel, Lock, LockDetails, LockIdList, LockState, PasscodeList } from '../types/index.js';

class RequestFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestFailed';
  }
}

export class TTLockApi {
  private apiClient: AxiosInstance;
  public accessToken: string | null = null;
  public refreshToken: string | null = null;
  private tokenMutex = new Mutex();

  constructor(private log: Logging, private clientId: string, private clientSecret: string) {
    this.apiClient = axios.create({
      baseURL: 'https://euapi.ttlock.com/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    this.log.debug('TTLockApi instance created');
  }

  private encryptPassword(password: string): string {
    return crypto.createHash('md5').update(password).digest('hex');
  }

  public async authenticate(username: string, password: string): Promise<void> {
    this.log.debug('Authenticating with TTLock API');
    try {
      const encryptedPassword = this.encryptPassword(password);
      const response = await this.apiClient.post('oauth2/token', qs.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'password',
        username,
        password: encryptedPassword,
      }));

      if (response.data.access_token && response.data.refresh_token) {
        this.accessToken = response.data.access_token;
        this.refreshToken = response.data.refresh_token;
        this.log.info('Authenticated with TTLock API');
      } else {
        this.log.error('Authentication response did not contain tokens:', response.data);
        throw new Error('Authentication failed: No tokens received');
      }
    } catch (error) {
      this.handleError('Failed to authenticate with TTLock API', error);
      throw error;
    }
  }

  private async refreshTokenIfNeeded(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error('No refresh token available. Please call authenticate() first.');
    }

    const release = await this.tokenMutex.acquire();
    try {
      this.log.debug('Refreshing access token');
      const response = await this.apiClient.post('oauth2/token', qs.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      }));

      if (response.data.access_token && response.data.refresh_token) {
        this.accessToken = response.data.access_token;
        this.refreshToken = response.data.refresh_token;
        this.log.debug('Access token refreshed');
      } else {
        throw new Error('Failed to refresh token: Invalid response');
      }
    } catch (error) {
      this.handleError('Failed to refresh access token', error);
      throw error;
    } finally {
      release();
    }
  }

  private async makeAuthenticatedRequest<T>(endpoint: string, method: 'GET' | 'POST' = 'GET', data?: Record<string, unknown>): Promise<T> {
    const maxRetries = 3;

    if (!this.accessToken) {
      throw new Error('Not authenticated. Please call authenticate() first.');
    }

    const requestData = {
      ...data,
      clientId: this.clientId,
      accessToken: this.accessToken,
      date: Date.now(),
    };

    const fullEndpoint = `v3/${endpoint}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.apiClient.request({
          url: fullEndpoint,
          method,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
          params: method === 'GET' ? requestData : undefined,
          data: method === 'POST' ? qs.stringify(requestData) : undefined,
        });

        if (response.data.errcode && response.data.errcode !== 0) {
          throw new RequestFailed(`API returned error: ${response.data.errmsg || 'Unknown error'}`);
        }

        return response.data;
      } catch (error) {
        if (error instanceof RequestFailed) {
          const errorMsg = error.message;
          this.log.debug(`Attempt ${attempt + 1} failed: ${errorMsg}`);
          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000;
            this.log.debug(`Retrying in ${delay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        } else if (axios.isAxiosError(error) && error.response) {
          if (error.response.status === 401) {
            this.log.debug('Access token expired, refreshing token...');
            await this.refreshTokenIfNeeded();
            continue;
          }
          this.log.error(`Request failed: status=${error.response.status}, body=${JSON.stringify(error.response.data)}`);
          throw new RequestFailed(`Request failed: status=${error.response.status}, body=${JSON.stringify(error.response.data)}`);
        }
        this.handleError('Request failed', error);
        throw error;
      }
    }
    throw new Error('Max retries reached');
  }

  private handleError(message: string, error: unknown): void {
    if (axios.isAxiosError(error)) {
      this.log.error(`${message}: ${error.response?.data || error.message}`);
    } else if (error instanceof Error) {
      this.log.error(`${message}: ${error.message}`);
    } else {
      this.log.error(`${message}: ${JSON.stringify(error)}`);
    }
  }

  public async getLocks(): Promise<LockIdList> {
    this.log.debug('Fetching list of locks');
    const response = await this.makeAuthenticatedRequest<{
      list: { lockId: string }[];
      pageNo: number;
      pageSize: number;
      pages: number;
      total: number;
    }>('lock/list', 'GET', { pageNo: 1, pageSize: 1000 });

    if (!response.list || !Array.isArray(response.list)) {
      this.log.error('Invalid response format: expected list of locks');
      throw new Error('Invalid response format: expected list of locks');
    }

    this.log.info(`Found ${response.list.length} locks`);
    return response.list.map((item) => ({
      lockId: item.lockId.toString(),
    }));
  }

  public async getLockDetails(lockId: string): Promise<LockDetails> {
    this.log.debug(`Fetching details for lock: ${lockId}`);
    const data = await this.makeAuthenticatedRequest<LockDetails>('lock/detail', 'GET', { lockId });
    return {
      lockId: data.lockId.toString(),
      lockAlias: data.lockAlias,
      lockMac: data.lockMac,
      modelNum: data.modelNum,
      hardwareRevision: data.hardwareRevision,
      firmwareRevision: data.firmwareRevision,
    };
  }

  public async getLockState(lockId: string): Promise<LockState> {
    this.log.debug(`Fetching state for lock: ${lockId}`);
    const data = await this.makeAuthenticatedRequest<LockState>('lock/queryOpenState', 'GET', { lockId });
    return {
      state: data.state === 0 ? 1 : data.state === 1 ? 0 : data.state,
    };
  }

  public async mapToLock(
    lockDetails: LockDetails,
    lockState: LockState,
    lockBattery: BatteryLevel,
    lockPasscodes: PasscodeList,
  ): Promise<Lock> {
    this.log.debug(`Mapping lock details to Lock object for lock: ${lockDetails.lockId}`);
    return {
      id: lockDetails.lockId.toString(),
      alias: lockDetails.lockAlias,
      mac: lockDetails.lockMac,
      model: lockDetails.modelNum,
      hardwareRevision: lockDetails.hardwareRevision,
      firmwareRevision: lockDetails.firmwareRevision,
      state: lockState.state,
      battery: lockBattery.battery,
      passCodes: lockPasscodes,
      offline: false,
      lastSeen: new Date(),
    };
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

  public async getBatteryLevel(lockId: string): Promise<BatteryLevel> {
    this.log.debug(`Fetching battery level for lock: ${lockId}`);
    const data = await this.makeAuthenticatedRequest<{ electricQuantity: number }>('lock/queryElectricQuantity', 'GET', { lockId });
    return {
      battery: data.electricQuantity,
    };
  }

  public async getPasscodes(lockId: string): Promise<PasscodeList> {
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
      throw new Error('Invalid response format: expected list of passcodes');
    }

    this.log.debug(`Found ${response.list.length} passcodes for lock: ${lockId}`);
    return response.list.map((item, index) => ({
      id: item.keyboardPwdId.toString(),
      index: (index).toString(),
      lockId: item.lockId.toString(),
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