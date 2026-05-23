import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format } from 'node:util';

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class StreamLogger {
  info(...args) {
    this.write(process.stdout, args);
  }

  warn(...args) {
    this.write(process.stderr, args);
  }

  error(...args) {
    this.write(process.stderr, args);
  }

  debug(...args) {
    if (process.env.DEBUG) {
      this.write(process.stdout, args);
    }
  }

  write(stream, args) {
    stream.write(`${format(...args)}\n`);
  }
}

function requestError(message, status = 400) {
  return new RequestError(message, { status });
}

function getRequiredString(payload, field, label) {
  const value = String(payload?.[field] ?? '').trim();
  if (!value) {
    throw requestError(`${label} is required.`);
  }
  return value;
}

async function importBuiltModule(modulePath) {
  const moduleFile = path.join(__dirname, '..', 'dist', ...modulePath);
  try {
    return await import(pathToFileURL(moduleFile).href);
  } catch {
    throw requestError(`Could not load ${modulePath.join('/')}. Run npm run build before using this setup action.`, 500);
  }
}

async function createTTLockApi(payload) {
  const clientId = getRequiredString(payload, 'clientId', 'TTLock Client ID');
  const clientSecret = getRequiredString(payload, 'clientSecret', 'TTLock Client Secret');
  const username = getRequiredString(payload, 'username', 'TTLock username');
  const password = getRequiredString(payload, 'password', 'TTLock password');
  const { TTLockApi } = await importBuiltModule(['api', 'ttlockApi.js']);
  const api = new TTLockApi(new StreamLogger(), clientId, clientSecret);
  await api.authenticate(username, password);
  return api;
}

async function createDirigeraClient(payload) {
  const gatewayIP = getRequiredString(payload, 'gatewayIP', 'DIRIGERA gateway IP');
  const { createDirigeraClient } = await import('dirigera');

  return createDirigeraClient({
    gatewayIP,
    accessToken: payload?.accessToken,
  });
}

class TTLockAccessCodeUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/ttlock-test-auth', this.testTTLockAuth.bind(this));
    this.onRequest('/ttlock-locks', this.listTTLockLocks.bind(this));
    this.onRequest('/dirigera-authenticate', this.authenticateDirigera.bind(this));
    this.onRequest('/dirigera-open-close-sensors', this.listDirigeraOpenCloseSensors.bind(this));

    this.ready();
  }

  async testTTLockAuth(payload) {
    await createTTLockApi(payload);
    return { ok: true };
  }

  async listTTLockLocks(payload) {
    const api = await createTTLockApi(payload);
    return api.listLocksForSetup();
  }

  async authenticateDirigera(payload) {
    const client = await createDirigeraClient(payload);
    const accessToken = await client.authenticate({ verbose: false });
    return { accessToken };
  }

  async listDirigeraOpenCloseSensors(payload) {
    const accessToken = getRequiredString(payload, 'accessToken', 'DIRIGERA access token');
    const client = await createDirigeraClient({ ...payload, accessToken });
    const sensors = await client.openCloseSensors.list();

    return sensors.map((sensor) => ({
      batteryPercentage: sensor.attributes?.batteryPercentage,
      id: sensor.id,
      isOpen: sensor.attributes?.isOpen,
      isReachable: Boolean(sensor.isReachable),
      manufacturer: sensor.attributes?.manufacturer || '',
      model: sensor.attributes?.model || '',
      name: sensor.attributes?.customName || sensor.attributes?.model || sensor.id,
      roomName: sensor.room?.name || '',
    }));
  }
}

new TTLockAccessCodeUiServer();
