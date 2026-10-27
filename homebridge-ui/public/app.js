;(function () {
  const PLATFORM_NAME = 'TTLockAccessCode';
  const PLUGIN_NAME = 'homebridge-ttlock-accesscode';
  const QUALIFIED_PLATFORM_NAME = `${PLUGIN_NAME}.${PLATFORM_NAME}`;
  const PLATFORM_NAME_ALIASES = new Set([PLATFORM_NAME, QUALIFIED_PLATFORM_NAME]);
  const DEFAULTS = {
    name: 'TTLockAccessCode',
    totalApiCallsPerMonth: 30000,
    pollingInterval: 300,
    discoveryPollingInterval: 12,
    offlineInterval: 7,
    waitTimeUpdate: 100,
  };
  const ACCOUNT_FIELDS = ['clientId', 'clientSecret', 'username', 'password'];
  // The range each number field is saved in
  const NUMBER_FIELDS = new Map([
    ['totalApiCallsPerMonth', { minimum: 30000 }],
    ['pollingInterval', { minimum: 30, maximum: 2147483 }],
    ['discoveryPollingInterval', { minimum: 1, maximum: 596 }],
    ['offlineInterval', { minimum: 1 }],
    ['waitTimeUpdate', { minimum: 0, maximum: 60000 }],
  ]);

  const app = document.getElementById('app');
  const hb = window.homebridge;
  const state = {
    credentialTestFingerprint: '',
    pluginConfig: [],
    platformConfig: null,
    modal: null,
    updateTimer: null,
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getErrorMessage(err) {
    if (!err) {
      return 'Unknown error';
    }
    if (typeof err === 'string') {
      return err;
    }
    if (err.message) {
      return err.message;
    }
    if (err.error) {
      return err.error;
    }
    return JSON.stringify(err);
  }

  function notify(type, message, title) {
    if (hb?.toast?.[type]) {
      hb.toast[type](message, title);
    }
  }

  function platformValue(field) {
    const value = state.platformConfig?.[field];
    return value === undefined || value === null ? '' : String(value);
  }

  // A blank value (a cleared field, or text the browser cannot read as a number) takes the default, not the minimum
  function parseNumber(value, fallback, minimum, maximum = Infinity) {
    const text = String(value ?? '').trim();
    if (text === '') {
      return fallback;
    }
    const numberValue = Number(text);
    if (!Number.isFinite(numberValue)) {
      return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.floor(numberValue)));
  }

  function parsePlatformNumber(field, value) {
    const { minimum, maximum } = NUMBER_FIELDS.get(field);
    return parseNumber(value, DEFAULTS[field], minimum, maximum);
  }

  function isAccountReady() {
    return ACCOUNT_FIELDS.every((field) => platformValue(field).trim().length > 0);
  }

  // The client secret and password are used exactly as typed: spaces at either end can be part of them
  function accountPayload() {
    return {
      clientId: platformValue('clientId').trim(),
      clientSecret: platformValue('clientSecret'),
      username: platformValue('username').trim(),
      password: platformValue('password'),
    };
  }

  function accountFingerprint() {
    return JSON.stringify(accountPayload());
  }

  function isCurrentAccountTested() {
    return isAccountReady() && state.credentialTestFingerprint === accountFingerprint();
  }

  function markAccountCredentialsChanged() {
    state.credentialTestFingerprint = '';
    updateCredentialTestUi();
  }

  function ensurePlatformConfig(pluginConfig) {
    const blocks = Array.isArray(pluginConfig) ? pluginConfig : [];
    let platformConfig = blocks.find((block) => PLATFORM_NAME_ALIASES.has(block.platform));

    if (!platformConfig) {
      platformConfig = {
        platform: PLATFORM_NAME,
        name: DEFAULTS.name,
        clientId: '',
        clientSecret: '',
        username: '',
        password: '',
        totalApiCallsPerMonth: DEFAULTS.totalApiCallsPerMonth,
        pollingInterval: DEFAULTS.pollingInterval,
        discoveryPollingInterval: DEFAULTS.discoveryPollingInterval,
        offlineInterval: DEFAULTS.offlineInterval,
        waitTimeUpdate: DEFAULTS.waitTimeUpdate,
      };
      blocks.push(platformConfig);
    }

    platformConfig.platform = PLATFORM_NAME;
    platformConfig.name = platformConfig.name || DEFAULTS.name;
    platformConfig.totalApiCallsPerMonth = platformConfig.totalApiCallsPerMonth ?? DEFAULTS.totalApiCallsPerMonth;
    platformConfig.pollingInterval = platformConfig.pollingInterval ?? DEFAULTS.pollingInterval;
    platformConfig.discoveryPollingInterval = platformConfig.discoveryPollingInterval ?? DEFAULTS.discoveryPollingInterval;
    platformConfig.offlineInterval = platformConfig.offlineInterval ?? DEFAULTS.offlineInterval;
    platformConfig.waitTimeUpdate = platformConfig.waitTimeUpdate ?? DEFAULTS.waitTimeUpdate;

    state.pluginConfig = blocks;
    state.platformConfig = platformConfig;
  }

  function fieldHtml(field, label, options = {}) {
    const required = options.required === true;
    const type = options.type || 'text';
    const value = escapeHtml(platformValue(field));
    const note = options.note ? `<div class="field-note">${escapeHtml(options.note)}</div>` : '';
    const min = options.min !== undefined ? `min="${escapeHtml(options.min)}"` : '';
    const max = options.max !== undefined ? `max="${escapeHtml(options.max)}"` : '';
    const autoComplete = type === 'password' ? 'new-password' : 'off';

    return `
      <div class="${options.wide ? 'wide' : ''}">
        <label class="form-label" for="platform-${field}">
          ${escapeHtml(label)}${required ? '<span class="required-mark">*</span>' : ''}
        </label>
        <input
          id="platform-${field}"
          class="form-control ${options.secret ? 'secret-value' : ''}"
          data-platform-field="${field}"
          type="${type}"
          value="${value}"
          autocomplete="${autoComplete}"
          ${min}
          ${max}
        />
        ${note}
      </div>
    `;
  }

  function render() {
    app.innerHTML = `
      <div class="ui-shell">
        <header class="topbar">
          <div>
            <h2>TTLock Access Code</h2>
          </div>
        </header>
        ${renderPlatform()}
        ${renderAccount()}
        ${renderPolling()}
        ${renderAdvanced()}
      </div>
    `;
  }

  function renderPlatform() {
    return `
      <section class="panel platform-panel">
        <div class="field-grid single">
          ${fieldHtml('name', 'Platform Name')}
        </div>
      </section>
    `;
  }

  function renderAccount() {
    const ready = isAccountReady();
    const tested = isCurrentAccountTested();
    const statusLabel = tested ? 'Verified' : (ready ? 'Ready' : 'Incomplete');
    const statusClass = tested ? 'ready' : (ready ? 'neutral' : 'blocked');
    return `
      <section class="panel">
        <div class="section-heading">
          <div>
            <h3>TTLock Account</h3>
            <p>Credentials are used for polling, lock control, and access codes.</p>
          </div>
          <span id="account-status" class="status-pill ${statusClass}">${statusLabel}</span>
        </div>
        <div class="field-grid">
          ${fieldHtml('clientId', 'Client ID', { required: true })}
          ${fieldHtml('clientSecret', 'Client Secret', { required: true, type: 'password', secret: true })}
          ${fieldHtml('username', 'Username', { required: true })}
          ${fieldHtml('password', 'Password', { required: true, type: 'password', secret: true })}
        </div>
        <div class="button-row">
          <button
            type="button"
            id="test-ttlock-button"
            class="btn btn-primary"
            data-action="test-ttlock"
            ${ready && !tested ? '' : 'disabled'}
          >
            Test Credentials
          </button>
        </div>
      </section>
    `;
  }

  function renderPolling() {
    return `
      <section class="panel">
        <div class="section-heading">
          <div>
            <h3>Polling And API Usage</h3>
          </div>
        </div>
        <div class="field-grid polling-grid">
          ${fieldHtml('totalApiCallsPerMonth', 'Monthly API Calls', {
    type: 'number',
    min: 30000,
    note: 'Total number of TTLock API calls allowed per month. Used to automatically adjust lock polling.',
  })}
          ${fieldHtml('pollingInterval', 'Lock Polling Interval (Seconds)', {
    type: 'number',
    min: 30,
    max: 2147483,
    note: 'How often to check TTLock device status in the background.',
  })}
          ${fieldHtml('discoveryPollingInterval', 'Discovery Polling Interval (Hours)', {
    type: 'number',
    min: 1,
    max: 596,
    note: 'How often to discover new TTLock devices in the background.',
  })}
          ${fieldHtml('offlineInterval', 'Offline Device Removal Interval (Days)', {
    type: 'number',
    min: 1,
    note: 'How long an undiscovered TTLock device is kept before removing its cached accessory.',
  })}
        </div>
      </section>
    `;
  }

  function renderAdvanced() {
    return `
      <details class="panel advanced-panel">
        <summary>
          <div>
            <h3>Advanced</h3>
          </div>
        </summary>
        <div class="advanced-body">
          <div class="field-grid single">
            ${fieldHtml('waitTimeUpdate', 'Wait Time Update (Milliseconds)', {
    type: 'number',
    min: 0,
    max: 60000,
    note: 'How long periodic device discovery waits before it starts, so discoveries requested together run once. ' +
      'Lock polls and commands do not wait for it.',
  })}
          </div>
        </div>
      </details>
    `;
  }

  function scheduleUpdate() {
    clearTimeout(state.updateTimer);
    state.updateTimer = setTimeout(() => {
      updateConfig().catch((err) => notify('error', getErrorMessage(err), 'Config Update Failed'));
    }, 350);
  }

  function updateCredentialTestUi() {
    const ready = isAccountReady();
    const tested = isCurrentAccountTested();
    const button = document.getElementById('test-ttlock-button');
    const status = document.getElementById('account-status');

    if (button) {
      button.disabled = !ready || tested;
    }

    if (status) {
      status.textContent = tested ? 'Verified' : (ready ? 'Ready' : 'Incomplete');
      status.className = `status-pill ${tested ? 'ready' : (ready ? 'neutral' : 'blocked')}`;
    }
  }

  async function flushUpdate() {
    clearTimeout(state.updateTimer);
    await updateConfig();
  }

  async function updateConfig() {
    await hb.updatePluginConfig(getSanitizedPluginConfig());
  }

  function getSanitizedPluginConfig() {
    return state.pluginConfig.map((block) => {
      if (block !== state.platformConfig) {
        return block;
      }
      return sanitizePlatformConfig(block);
    });
  }

  function sanitizePlatformConfig(block) {
    return {
      platform: PLATFORM_NAME,
      name: String(block.name || DEFAULTS.name).trim() || DEFAULTS.name,
      clientId: String(block.clientId || '').trim(),
      // As typed, like accountPayload sends them to TTLock
      clientSecret: String(block.clientSecret || ''),
      username: String(block.username || '').trim(),
      password: String(block.password || ''),
      totalApiCallsPerMonth: parsePlatformNumber('totalApiCallsPerMonth', block.totalApiCallsPerMonth),
      pollingInterval: parsePlatformNumber('pollingInterval', block.pollingInterval),
      discoveryPollingInterval: parsePlatformNumber('discoveryPollingInterval', block.discoveryPollingInterval),
      offlineInterval: parsePlatformNumber('offlineInterval', block.offlineInterval),
      waitTimeUpdate: parsePlatformNumber('waitTimeUpdate', block.waitTimeUpdate),
      // Drops the removed IKEA DIRIGERA door settings: the Homebridge UI merges this block into the saved one,
      // so a key is only removed when it is sent as undefined
      externalDoors: undefined,
    };
  }

  // committed is true once the field is left: a number field then shows the value that is saved
  function setPlatformField(target, committed = false) {
    const field = target.getAttribute('data-platform-field');
    if (!field) {
      return false;
    }
    const isNumber = NUMBER_FIELDS.has(field);
    state.platformConfig[field] = committed && isNumber ? parsePlatformNumber(field, target.value) : target.value;
    if (ACCOUNT_FIELDS.includes(field)) {
      markAccountCredentialsChanged();
    }
    scheduleUpdate();
    return isNumber;
  }

  function handleInput(event) {
    const target = event.target;
    if (target?.matches?.('[data-platform-field]')) {
      setPlatformField(target);
    }
  }

  function handleChange(event) {
    const target = event.target;
    let shouldRender = false;

    if (target?.matches?.('[data-platform-field]')) {
      shouldRender = setPlatformField(target, true);
    }

    if (shouldRender) {
      render();
    }
  }

  function handleClick(event) {
    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget || actionTarget.disabled) {
      if (event.target.classList.contains('modal-backdrop-custom')) {
        closeModal();
      }
      return;
    }

    const action = actionTarget.getAttribute('data-action');

    switch (action) {
      case 'close-modal':
        closeModal();
        break;
      case 'test-ttlock':
        testTTLockCredentials();
        break;
    }
  }

  async function testTTLockCredentials() {
    openModal('Testing TTLock Credentials', loadingHtml('Authenticating with TTLock...'), '');
    try {
      await flushUpdate();
      const locks = await hb.request('/ttlock-locks', accountPayload());
      state.credentialTestFingerprint = accountFingerprint();
      notify('success', `TTLock credentials were accepted. ${locks.length} lock(s) found.`, 'Credentials Verified');
      closeModal();
      render();
    } catch (err) {
      openModal('TTLock Authentication Failed', `<p>${escapeHtml(getErrorMessage(err))}</p>`);
    }
  }

  function openModal(title, body, footer) {
    closeModal();

    const modal = document.createElement('div');
    const defaultFooter = `
      <div class="button-row">
        <button type="button" class="btn btn-secondary" data-action="close-modal">Close</button>
      </div>
    `;
    modal.className = 'modal-backdrop-custom';
    modal.innerHTML = `
      <div class="modal-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="modal-header-custom">
          <h4>${escapeHtml(title)}</h4>
          <button type="button" class="btn-close" aria-label="Close" data-action="close-modal"></button>
        </div>
        <div class="modal-body-custom">
          ${body}
          ${footer || defaultFooter}
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    state.modal = modal;
  }

  function closeModal() {
    state.modal?.remove();
    state.modal = null;
  }

  function loadingHtml(message) {
    return `
      <div class="spinner-inline">
        <span class="spinner-border spinner-border-sm" role="status"></span>
        <span>${escapeHtml(message)}</span>
      </div>
    `;
  }

  function renderError(message) {
    app.innerHTML = `
      <div class="ui-shell">
        <section class="panel">
          <h3>Setup UI Error</h3>
          <p>${escapeHtml(message)}</p>
        </section>
      </div>
    `;
  }

  async function hydrateSessionData() {
    if (await verifySavedAccount().catch(() => false)) {
      render();
    }
  }

  async function verifySavedAccount() {
    if (!isAccountReady()) {
      return false;
    }

    const fingerprint = accountFingerprint();
    await hb.request('/ttlock-test-auth', accountPayload());
    if (fingerprint !== accountFingerprint()) {
      return false;
    }

    state.credentialTestFingerprint = fingerprint;
    return true;
  }

  async function init() {
    if (!hb) {
      renderError('The Homebridge custom UI API is not available in this window.');
      return;
    }

    try {
      const pluginConfig = await hb.getPluginConfig();
      ensurePlatformConfig(pluginConfig);
      render();
      void hydrateSessionData();
    } catch (err) {
      renderError(getErrorMessage(err));
    }
  }

  app.addEventListener('input', handleInput);
  app.addEventListener('change', handleChange);
  document.addEventListener('click', handleClick);

  init();
})();
