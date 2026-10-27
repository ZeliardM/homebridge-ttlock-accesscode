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

// plugin-ui-utils writes any error that is not a RequestError to the log with console.error, and a raw
// error can carry the request with the client secret, password hash or access token. Pass on the message only.
function toRequestError(error) {
  return error instanceof RequestError ? error : requestError(error instanceof Error ? error.message : String(error), 500);
}

// trim: false for the client secret and password, which are used exactly as typed (spaces at either end can be
// part of them); a value of only spaces still counts as missing
function getRequiredString(payload, field, label, { trim = true } = {}) {
  const value = String(payload?.[field] ?? '');
  if (!value.trim()) {
    throw requestError(`${label} is required.`);
  }
  return trim ? value.trim() : value;
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
  const clientSecret = getRequiredString(payload, 'clientSecret', 'TTLock Client Secret', { trim: false });
  const username = getRequiredString(payload, 'username', 'TTLock username');
  const password = getRequiredString(payload, 'password', 'TTLock password', { trim: false });
  const { TTLockApi } = await importBuiltModule(['api', 'ttlockApi.js']);
  const api = new TTLockApi(new StreamLogger(), clientId, clientSecret);
  await api.authenticate(username, password);
  return api;
}

class TTLockAccessCodeUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/ttlock-test-auth', this.testTTLockAuth.bind(this));
    this.onRequest('/ttlock-locks', this.listTTLockLocks.bind(this));

    this.ready();
  }

  async testTTLockAuth(payload) {
    try {
      await createTTLockApi(payload);
      return { ok: true };
    } catch (error) {
      throw toRequestError(error);
    }
  }

  async listTTLockLocks(payload) {
    try {
      const api = await createTTLockApi(payload);
      return await api.listLocksForSetup();
    } catch (error) {
      throw toRequestError(error);
    }
  }
}

new TTLockAccessCodeUiServer();
