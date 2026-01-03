import type { Logging } from 'homebridge';

import axios from 'axios';
import crypto from 'crypto';
import { AxiosInstance } from 'axios';
import type { AxiosResponse } from 'axios';

import { UsageTracker } from './usageTracker.js';
import { SimpleMutex } from '../utils.js';
import { FeatureInfo, Passcode, SysInfo, TTLockDevice } from '../devices/deviceTypes.js';

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
  private tokenMutex = new SimpleMutex();
  private usageTracker: UsageTracker | undefined;

  constructor(private log: Logging, private clientId: string, private clientSecret: string, usageTracker?: UsageTracker) {
    this.apiClient = axios.create({
      baseURL: 'https://euapi.ttlock.com/',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    this.log.debug('TTLockApi initialized');
    this.usageTracker = usageTracker;
  }

  private encryptPassword(password: string): string {
    return crypto.createHash('md5').update(password).digest('hex');
  }

  public async authenticate(username: string, password: string): Promise<void> {
    this.log.debug('Authenticating with TTLock API...');
    try {
      const encryptedPassword = this.encryptPassword(password);
      if (this.usageTracker) {
        const ok = await this.usageTracker.tryReserve(1, 'authenticate');
        if (!ok) {
          throw new Error('API usage budget exhausted (authenticate)');
        }
      }
      const response: AxiosResponse = await Promise.race([
        this.apiClient.post('oauth2/token', new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: 'password',
          username,
          password: encryptedPassword,
        }).toString()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TTLock API authentication timed out')), 15000)),
      ]) as AxiosResponse;

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
      this.log.debug('Refreshing access token...');
      if (this.usageTracker) {
        const ok = await this.usageTracker.tryReserve(1, 'refreshToken');
        if (!ok) {
          throw new Error('API usage budget exhausted (refreshToken)');
        }
      }
      const response = await this.apiClient.post('oauth2/token', new URLSearchParams({
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

    let lastError: unknown = new Error('Unknown request error');

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
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

        if ('errcode' in response.data && response.data.errcode !== 0) {
          throw new RequestFailed(`API returned error: ${response.data.errmsg || 'Unknown error'}`);
        }

        return response.data;
      } catch (error) {
        lastError = error;

        if (error instanceof RequestFailed) {
          const errorMsg = error.message;
          this.log.debug(`Attempt ${attempt + 1} failed: ${errorMsg}`);
          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000;
            this.log.debug(`Retrying in ${delay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          break;
        }

        if (axios.isAxiosError(error)) {
          if (error.response) {
            if (error.response.status === 401) {
              this.log.debug('Access token expired, refreshing token...');
              try {
                await this.refreshTokenIfNeeded();
                continue;
              } catch (error) {
                lastError = error;
                break;
              }
            }

            const rf = new RequestFailed(`Request failed: status=${error.response.status}, body=${JSON.stringify(error.response.data)}`);
            this.log.error(rf.message);

            if (error.response.status >= 500 && attempt < maxRetries) {
              const delay = Math.pow(2, attempt) * 1000;
              this.log.debug(`Server error, retrying in ${delay / 1000} seconds...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              lastError = rf;
              continue;
            }

            lastError = rf;
            break;
          }

          this.log.debug(`Network error on attempt ${attempt + 1}: ${error.message}`);
          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          break;
        }

        this.handleError('Request failed', error);
        break;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
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
      throw new Error('Invalid response format: expected list of locks');
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
        this.handleError(`Failed to fetch details for lock ${lock.lockId}`, error);
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
      this.handleError('Failed to parse featureValue', error);
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
      throw new Error('Invalid response format: expected list of passcodes');
    }

    this.log.debug(`Found ${response.list.length} passcodes for lock: ${lockId}`);
    return response.list.map((item, index) => ({
      passcode_id: item.keyboardPwdId.toString(),
      index: (index).toString(),
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