;(function () {
  const PLATFORM_NAME = 'TTLockAccessCode';
  const PLUGIN_NAME = 'homebridge-ttlock-accesscode';
  const QUALIFIED_PLATFORM_NAME = `${PLUGIN_NAME}.${PLATFORM_NAME}`;
  const PLATFORM_NAME_ALIASES = new Set([PLATFORM_NAME, QUALIFIED_PLATFORM_NAME]);
  const DEFAULTS = {
    name: 'TTLockAccessCode',
    totalApiCallsPerMonth: 30000,
    pollingInterval: 300,
    doorPollingInterval: 60,
    discoveryPollingInterval: 12,
    offlineInterval: 7,
    waitTimeUpdate: 100,
  };
  const ACCOUNT_FIELDS = ['clientId', 'clientSecret', 'username', 'password'];
  const NUMBER_FIELDS = new Set([
    'totalApiCallsPerMonth',
    'pollingInterval',
    'discoveryPollingInterval',
    'offlineInterval',
    'waitTimeUpdate',
  ]);

  const app = document.getElementById('app');
  const hb = window.homebridge;
  const state = {
    credentialTestFingerprint: '',
    lockDiscoveryComplete: false,
    pluginConfig: [],
    platformConfig: null,
    locks: [],
    modal: null,
    sensorHubIpById: {},
    sensorsByHub: {},
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

  function externalDoors() {
    return state.platformConfig.externalDoors;
  }

  function parseNumber(value, fallback, minimum) {
    const numberValue = Number(String(value ?? '').trim());
    if (!Number.isFinite(numberValue)) {
      return fallback;
    }
    return Math.max(minimum, Math.floor(numberValue));
  }

  function isAccountReady() {
    return ACCOUNT_FIELDS.every((field) => platformValue(field).trim().length > 0);
  }

  function accountPayload() {
    return {
      clientId: platformValue('clientId').trim(),
      clientSecret: platformValue('clientSecret').trim(),
      username: platformValue('username').trim(),
      password: platformValue('password').trim(),
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
    state.lockDiscoveryComplete = false;
    state.locks = [];
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
        externalDoors: {
          doorPollingInterval: DEFAULTS.doorPollingInterval,
          hubs: [],
          doors: [],
        },
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
    platformConfig.externalDoors = normalizeExternalDoorsConfig(platformConfig.externalDoors);

    state.pluginConfig = blocks;
    state.platformConfig = platformConfig;
  }

  function normalizeExternalDoorsConfig(config) {
    const externalDoorConfig = config && typeof config === 'object' ? config : {};
    return {
      doorPollingInterval: externalDoorConfig.doorPollingInterval ?? DEFAULTS.doorPollingInterval,
      hubs: Array.isArray(externalDoorConfig.hubs) ? externalDoorConfig.hubs : [],
      doors: Array.isArray(externalDoorConfig.doors) ? externalDoorConfig.doors : [],
    };
  }

  function getDoorEntries() {
    return externalDoors().doors.map((door, doorIndex) => ({ door, doorIndex }));
  }

  function getPairedHubEntries() {
    return externalDoors().hubs
      .map((hub, hubIndex) => ({ hub, hubIndex }))
      .filter((entry) => entry.hub.ip && entry.hub.accessToken);
  }

  function hubIp(hub) {
    return String(hub?.ip || '').trim();
  }

  function getSensorHubIp(sensorId) {
    const normalizedSensorId = String(sensorId || '').trim();
    if (!normalizedSensorId) {
      return '';
    }
    if (state.sensorHubIpById[normalizedSensorId]) {
      return state.sensorHubIpById[normalizedSensorId];
    }

    for (const [hubIndex, sensors] of Object.entries(state.sensorsByHub)) {
      if ((sensors || []).some((sensor) => String(sensor.id) === normalizedSensorId)) {
        return hubIp(getHub(hubIndex));
      }
    }

    return '';
  }

  function isCompleteDoor(door) {
    return ['name', 'sensor', 'lock'].every((field) => String(door?.[field] ?? '').trim());
  }

  function hasConfiguredExternalDoorPolling() {
    return getPairedHubEntries().length > 0 && getDoorEntries().some((entry) => isCompleteDoor(entry.door));
  }

  function statusPillHtml(label, statusClass) {
    return `<span class="status-pill ${statusClass}">${escapeHtml(label)}</span>`;
  }

  function getUsedLockIds(exceptDoorIndex) {
    return new Set(getDoorEntries()
      .filter((entry) => entry.doorIndex !== Number(exceptDoorIndex))
      .map((entry) => String(entry.door.lock || '').trim())
      .filter(Boolean));
  }

  function getUsedSensorIds(exceptDoorIndex) {
    return new Set(getDoorEntries()
      .filter((entry) => entry.doorIndex !== Number(exceptDoorIndex))
      .map((entry) => String(entry.door.sensor || '').trim())
      .filter(Boolean));
  }

  function getAvailableLocksForDoor(doorIndex) {
    const usedLockIds = getUsedLockIds(doorIndex);
    return state.locks.filter((lock) => !usedLockIds.has(String(lock.id)));
  }

  function canAddManualDoor() {
    return !state.lockDiscoveryComplete || getDoorEntries().length < state.locks.length;
  }

  function fieldHtml(field, label, options = {}) {
    const required = options.required === true;
    const type = options.type || 'text';
    const value = escapeHtml(platformValue(field));
    const note = options.note ? `<div class="field-note">${escapeHtml(options.note)}</div>` : '';
    const min = options.min !== undefined ? `min="${escapeHtml(options.min)}"` : '';
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
        />
        ${note}
      </div>
    `;
  }

  function externalDoorFieldHtml(field, label, options = {}) {
    const type = options.type || 'text';
    const value = escapeHtml(externalDoors()?.[field] ?? '');
    const note = options.note ? `<div class="field-note">${escapeHtml(options.note)}</div>` : '';
    const min = options.min !== undefined ? `min="${escapeHtml(options.min)}"` : '';

    return `
      <div class="${options.wide ? 'wide' : ''}">
        <label class="form-label" for="external-${field}">${escapeHtml(label)}</label>
        <input
          id="external-${field}"
          class="form-control"
          data-external-door-field="${field}"
          type="${type}"
          value="${value}"
          autocomplete="off"
          ${min}
        />
        ${note}
      </div>
    `;
  }

  function readonlyValueHtml(label, displayValue, options = {}) {
    if (!displayValue && options.hideWhenEmpty) {
      return '';
    }
    const type = options.type || 'text';
    const note = options.note ? `<div class="field-note">${escapeHtml(options.note)}</div>` : '';
    return `
      <div class="${options.wide ? 'wide' : ''}">
        <label class="form-label">${escapeHtml(label)}</label>
        <input class="form-control ${options.secret ? 'secret-value' : ''}" type="${type}" value="${escapeHtml(displayValue)}" readonly />
        ${note}
      </div>
    `;
  }

  function lockLabel(lock) {
    const parts = [lock.name || lock.id, lock.id];
    if (typeof lock.battery === 'number') {
      parts.push(`${lock.battery}%`);
    }
    return parts.filter(Boolean).join(' | ');
  }

  function lockDisplay(lockId) {
    if (!lockId) {
      return '';
    }
    const lock = state.locks.find((item) => String(item.id) === String(lockId));
    return lock ? lockLabel(lock) : `Configured lock | ${lockId}`;
  }

  function sensorLabel(sensor) {
    const stateLabel = typeof sensor.isOpen === 'boolean' ? (sensor.isOpen ? 'Open' : 'Closed') : 'Unknown';
    const reachability = sensor.isReachable ? 'Reachable' : 'Not reachable';
    const battery = typeof sensor.batteryPercentage === 'number' ? `${sensor.batteryPercentage}%` : '';
    return [sensor.name || sensor.id, sensor.roomName, stateLabel, reachability, battery].filter(Boolean).join(' | ');
  }

  function sensorDisplay(sensorId) {
    if (!sensorId) {
      return '';
    }
    const sensor = Object.values(state.sensorsByHub)
      .flat()
      .find((item) => String(item.id) === String(sensorId));
    return sensor ? sensorLabel(sensor) : `Configured sensor | ${sensorId}`;
  }

  function rememberSensorsForHub(hubIndex, sensors) {
    const hub = getHub(hubIndex);
    const ip = hubIp(hub);
    if (!ip) {
      return;
    }

    for (const sensor of sensors || []) {
      state.sensorHubIpById[String(sensor.id)] = ip;
    }
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
        ${renderExternalDoors()}
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
            <p>Credentials are used for polling, lock control, access codes, and setup discovery.</p>
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

  function renderExternalDoors() {
    return `
      <section class="panel external-doors">
        <div class="section-heading external-heading">
          <div>
            <h3>External Doors</h3>
            <p>Optional IKEA DIRIGERA integration to add contact sensors and create doors for additional Apple Home automation support.</p>
          </div>
        </div>
        ${renderDirigeraHubs()}
        ${getPairedHubEntries().length ? renderManualDoors() : ''}
      </section>
    `;
  }

  function renderDirigeraHubs() {
    const hubs = externalDoors().hubs;
    return `
      <div class="subsection">
        <div class="subsection-header">
          <div>
            <h4>DIRIGERA Hubs</h4>
          </div>
          <button type="button" class="btn btn-primary" data-action="open-add-hub">Add Hub</button>
        </div>
        ${
  hubs.length
    ? `<div class="hub-list">${hubs.map((hub, index) => renderHub(hub, index)).join('')}</div>`
    : '<div class="empty-state">Add a DIRIGERA hub before creating external doors from IKEA contact sensors.</div>'
  }
      </div>
    `;
  }

  function renderHub(hub, hubIndex) {
    const ip = String(hub.ip || '').trim();
    const title = ip ? `DIRIGERA Hub ${ip}` : `DIRIGERA Hub ${hubIndex + 1}`;
    const token = String(hub.accessToken || '').trim();
    const paired = token.length > 0;
    const status = paired
      ? statusPillHtml('Ready', 'ready')
      : statusPillHtml('Needs Pair', 'blocked');

    return `
      <div class="item-card setup-card">
        <div class="item-header">
          <div>
            <div class="item-title-row">
              <p class="item-title">${escapeHtml(title)}</p>
              ${status}
            </div>
          </div>
          <div class="hub-actions">
            ${paired ? '' : `
              <button
                type="button"
                class="btn btn-outline-primary"
                data-action="open-dirigera-auth"
                data-hub-index="${hubIndex}"
              >
                Pair
              </button>
            `}
            <button type="button" class="btn btn-outline-danger" data-action="confirm-remove-hub" data-hub-index="${hubIndex}">
              Remove
            </button>
          </div>
        </div>
        <div class="field-grid hub-grid">
          ${readonlyValueHtml('DIRIGERA Hub IP', ip)}
          ${paired
    ? readonlyValueHtml('DIRIGERA Access Token', token, {
      type: 'password',
      secret: true,
    })
    : ''}
        </div>
      </div>
    `;
  }

  function renderManualDoors() {
    const entries = getDoorEntries();
    const addDoorDisabled = isAccountReady() && canAddManualDoor() ? '' : 'disabled';

    return `
      <div class="subsection">
        <div class="subsection-header">
          <div>
            <h4>Manual Doors</h4>
          </div>
          <button
            type="button"
            id="add-door-button"
            class="btn btn-primary"
            data-action="open-add-door"
            ${addDoorDisabled}
          >
            Add Door
          </button>
        </div>
        ${
  entries.length
    ? `<div class="door-list">${entries.map(renderDoor).join('')}</div>`
    : '<div class="empty-state">Add a door, then discover a TTLock lock and DIRIGERA sensor to complete it.</div>'
  }
      </div>
    `;
  }

  function renderDoor(entry) {
    const { door, doorIndex } = entry;
    const lockText = lockDisplay(door.lock);
    const sensorText = sensorDisplay(door.sensor);
    const ready = isCompleteDoor(door);
    const pairedHubCount = getPairedHubEntries().length;
    const lockDiscoveryDisabled = isAccountReady() ? '' : 'disabled';
    const sensorDiscoveryDisabled = pairedHubCount ? '' : 'disabled';
    const status = ready
      ? statusPillHtml('Ready', 'ready')
      : statusPillHtml('Incomplete', 'blocked');

    return `
      <div class="item-card setup-card">
        <div class="item-header">
          <div>
            <div class="item-title-row">
              <p class="item-title">${escapeHtml(door.name || `Manual Door ${doorIndex + 1}`)}</p>
              ${status}
            </div>
          </div>
          <button type="button" class="btn btn-outline-danger" data-action="confirm-remove-door" data-door-index="${doorIndex}">
            Remove
          </button>
        </div>
        <div class="door-fields">
          ${readonlyValueHtml('Door Name', door.name || `Manual Door ${doorIndex + 1}`)}
          ${readonlyValueHtml('Linked TTLock Lock', lockText, { hideWhenEmpty: true })}
          ${readonlyValueHtml('Linked DIRIGERA Sensor', sensorText, { hideWhenEmpty: true })}
        </div>
        <div class="button-row door-command-row">
          ${door.lock ? '' : `
            <button
              type="button"
              class="btn btn-outline-primary"
              data-action="discover-locks-for-door"
              data-door-index="${doorIndex}"
              ${lockDiscoveryDisabled}
            >
              Discover Locks
            </button>
          `}
          ${door.sensor ? '' : `
            <button
              type="button"
              class="btn btn-outline-primary"
              data-action="discover-sensors-for-door"
              data-door-index="${doorIndex}"
              ${sensorDiscoveryDisabled}
            >
              Discover Sensors
            </button>
          `}
        </div>
      </div>
    `;
  }

  function renderPolling() {
    const showDoorPolling = hasConfiguredExternalDoorPolling();
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
    note: 'How often to check TTLock device status in the background.',
  })}
          ${showDoorPolling ? externalDoorFieldHtml('doorPollingInterval', 'Door Polling Interval (Seconds)', {
    type: 'number',
    min: 10,
    note: 'How often to locally poll configured DIRIGERA door sensors as a fallback to events.',
  }) : ''}
          ${fieldHtml('discoveryPollingInterval', 'Discovery Polling Interval (Hours)', {
    type: 'number',
    min: 1,
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
    note: 'The time to wait to combine similar commands for a device before sending a command.',
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
    updateManualDoorControlsUi();
  }

  function updateManualDoorControlsUi() {
    const addDoorButton = document.getElementById('add-door-button');
    if (addDoorButton) {
      addDoorButton.disabled = !isAccountReady() || !canAddManualDoor();
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
    const sanitized = {
      platform: PLATFORM_NAME,
      name: String(block.name || DEFAULTS.name).trim() || DEFAULTS.name,
      clientId: String(block.clientId || '').trim(),
      clientSecret: String(block.clientSecret || '').trim(),
      username: String(block.username || '').trim(),
      password: String(block.password || '').trim(),
      totalApiCallsPerMonth: parseNumber(block.totalApiCallsPerMonth, DEFAULTS.totalApiCallsPerMonth, 30000),
      pollingInterval: parseNumber(block.pollingInterval, DEFAULTS.pollingInterval, 30),
      discoveryPollingInterval: parseNumber(block.discoveryPollingInterval, DEFAULTS.discoveryPollingInterval, 1),
      offlineInterval: parseNumber(block.offlineInterval, DEFAULTS.offlineInterval, 1),
      waitTimeUpdate: parseNumber(block.waitTimeUpdate, DEFAULTS.waitTimeUpdate, 0),
    };

    const externalDoorConfig = sanitizeExternalDoorsConfig(block.externalDoors);
    if (externalDoorConfig) {
      sanitized.externalDoors = externalDoorConfig;
    } else {
      delete sanitized.externalDoors;
    }

    return sanitized;
  }

  function sanitizeExternalDoorsConfig(config) {
    const source = normalizeExternalDoorsConfig(config);
    const hubs = source.hubs
      .map(sanitizeHubConfig)
      .filter(Boolean);
    const hasPairedHub = hubs.some((hub) => hub.ip && hub.accessToken);
    const doors = hasPairedHub
      ? source.doors
        .map(sanitizeDoorConfig)
        .filter(Boolean)
      : [];

    if (!hubs.length && !doors.length) {
      return null;
    }

    const sanitized = {
      hubs,
      doors,
    };

    if (hasPairedHub && doors.length) {
      sanitized.doorPollingInterval = parseNumber(source.doorPollingInterval, DEFAULTS.doorPollingInterval, 10);
    }

    return sanitized;
  }

  function sanitizeHubConfig(hub) {
    const ip = String(hub.ip || '').trim();
    const accessToken = String(hub.accessToken || '').trim();
    const hasAnyHubData = ip || accessToken;

    if (!hasAnyHubData) {
      return null;
    }

    return {
      ip,
      accessToken,
    };
  }

  function sanitizeDoorConfig(door) {
    const sanitized = {
      name: String(door.name || '').trim(),
      sensor: String(door.sensor || '').trim(),
      lock: String(door.lock || '').trim(),
    };

    return isCompleteDoor(sanitized) ? sanitized : null;
  }

  function setPlatformField(target) {
    const field = target.getAttribute('data-platform-field');
    if (!field) {
      return false;
    }
    state.platformConfig[field] = target.value;
    if (ACCOUNT_FIELDS.includes(field)) {
      markAccountCredentialsChanged();
    }
    scheduleUpdate();
    return NUMBER_FIELDS.has(field);
  }

  function setExternalDoorField(target) {
    const field = target.getAttribute('data-external-door-field');
    if (!field) {
      return false;
    }
    externalDoors()[field] = target.value;
    scheduleUpdate();
    return true;
  }

  function getHub(index) {
    return externalDoors().hubs[Number(index)];
  }

  function getDoor(doorIndex) {
    return externalDoors().doors[Number(doorIndex)];
  }

  function handleInput(event) {
    const target = event.target;
    if (target?.matches?.('[data-platform-field]')) {
      setPlatformField(target);
      return;
    }
    if (target?.matches?.('[data-external-door-field]')) {
      setExternalDoorField(target);
      return;
    }
  }

  function handleChange(event) {
    const target = event.target;
    let shouldRender = false;

    if (target?.matches?.('[data-platform-field]')) {
      shouldRender = setPlatformField(target);
    } else if (target?.matches?.('[data-external-door-field]')) {
      shouldRender = setExternalDoorField(target);
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
    const hubIndex = actionTarget.getAttribute('data-hub-index');
    const doorIndex = actionTarget.getAttribute('data-door-index');

    switch (action) {
      case 'close-modal':
        closeModal();
        break;
      case 'test-ttlock':
        testTTLockCredentials();
        break;
      case 'open-add-hub':
        openAddHubModal();
        break;
      case 'create-hub':
        createHub();
        break;
      case 'confirm-remove-hub':
        confirmRemoveHub(hubIndex);
        break;
      case 'remove-hub':
        removeHub(hubIndex);
        break;
      case 'open-add-door':
        void openAddDoorModal();
        break;
      case 'create-door':
        createDoor();
        break;
      case 'confirm-remove-door':
        confirmRemoveDoor(doorIndex);
        break;
      case 'remove-door':
        removeDoor(doorIndex);
        break;
      case 'open-dirigera-auth':
        openDirigeraAuthModal(hubIndex);
        break;
      case 'start-dirigera-auth':
        startDirigeraAuth(hubIndex);
        break;
      case 'discover-locks-for-door':
        discoverLocksForDoor(doorIndex);
        break;
      case 'discover-sensors-for-door':
        discoverSensorsForDoor(doorIndex);
        break;
      case 'select-lock':
        selectLockForDoor(doorIndex, actionTarget.getAttribute('data-lock-id'));
        break;
      case 'select-sensor':
        selectSensorForDoor(doorIndex, actionTarget.getAttribute('data-sensor-id'), actionTarget.getAttribute('data-source-hub-index'));
        break;
    }
  }

  async function testTTLockCredentials() {
    openModal('Testing TTLock Credentials', loadingHtml('Authenticating with TTLock...'), '');
    try {
      await flushUpdate();
      state.locks = await hb.request('/ttlock-locks', accountPayload());
      state.lockDiscoveryComplete = true;
      state.credentialTestFingerprint = accountFingerprint();
      notify('success', `TTLock credentials were accepted. ${state.locks.length} lock(s) found.`, 'Credentials Verified');
      closeModal();
      render();
    } catch (err) {
      openModal('TTLock Authentication Failed', `<p>${escapeHtml(getErrorMessage(err))}</p>`);
    }
  }

  async function discoverLocksForDoor(doorIndex) {
    const door = getDoor(doorIndex);
    if (!door) {
      return;
    }

    openModal('Discovering TTLock Locks', loadingHtml('Reading locks from TTLock...'), '');
    try {
      await flushUpdate();
      state.locks = await hb.request('/ttlock-locks', accountPayload());
      state.lockDiscoveryComplete = true;
      openLockChoiceModal(doorIndex);
    } catch (err) {
      openModal('Could Not Discover Locks', `<p>${escapeHtml(getErrorMessage(err))}</p>`);
    }
  }

  function openLockChoiceModal(doorIndex) {
    const availableLocks = getAvailableLocksForDoor(doorIndex);
    const body = availableLocks.length
      ? `<div class="choice-grid">${availableLocks.map((lock) => renderLockChoice(lock, doorIndex)).join('')}</div>`
      : '<div class="empty-state">No unused TTLock locks were found for this account.</div>';

    openModal('Choose Linked TTLock Lock', body);
  }

  function renderLockChoice(lock, doorIndex) {
    const detail = [
      lock.id,
      lock.mac,
      typeof lock.battery === 'number' ? `Battery ${lock.battery}%` : '',
      lock.passcodeSupported ? 'Access codes supported' : '',
    ].filter(Boolean).join(' | ');

    return `
      <button
        type="button"
        class="choice-button"
        data-action="select-lock"
        data-door-index="${doorIndex}"
        data-lock-id="${escapeHtml(lock.id)}"
      >
        <span class="choice-title">${escapeHtml(lock.name || lock.id)}</span>
        <span class="choice-meta">${escapeHtml(detail)}</span>
      </button>
    `;
  }

  function selectLockForDoor(doorIndex, lockId) {
    const door = getDoor(doorIndex);
    if (!door || !lockId) {
      return;
    }
    if (getUsedLockIds(doorIndex).has(String(lockId))) {
      notify('error', 'This TTLock lock is already linked to another door.', 'Lock Already Used');
      closeModal();
      render();
      return;
    }

    door.lock = lockId;
    closeModal();
    scheduleUpdate();
    render();
  }

  async function discoverSensorsForDoor(doorIndex) {
    const door = getDoor(doorIndex);
    if (!door) {
      return;
    }

    openModal('Discovering DIRIGERA Sensors', loadingHtml('Reading open/close sensors from DIRIGERA...'), '');
    try {
      for (const entry of getPairedHubEntries()) {
        const sensors = await hb.request('/dirigera-open-close-sensors', {
          gatewayIP: String(entry.hub.ip).trim(),
          accessToken: String(entry.hub.accessToken).trim(),
        });
        state.sensorsByHub[String(entry.hubIndex)] = sensors;
        rememberSensorsForHub(entry.hubIndex, sensors);
      }
      openSensorChoiceModal(doorIndex);
    } catch (err) {
      openModal('Could Not Discover Sensors', `<p>${escapeHtml(getErrorMessage(err))}</p>`);
    }
  }

  function openSensorChoiceModal(doorIndex) {
    const usedSensorIds = getUsedSensorIds(doorIndex);
    const sensors = getPairedHubEntries().flatMap((entry) => {
      return (state.sensorsByHub[String(entry.hubIndex)] || [])
        .filter((sensor) => !usedSensorIds.has(String(sensor.id)))
        .map((sensor) => ({
          hubIndex: entry.hubIndex,
          sensor,
        }));
    });
    const body = sensors.length
      ? `<div class="choice-grid">${sensors.map((entry) => renderSensorChoice(entry.sensor, doorIndex, entry.hubIndex)).join('')}</div>`
      : '<div class="empty-state">No unused IKEA DIRIGERA open/close sensors were found.</div>';

    openModal('Choose Linked DIRIGERA Sensor', body);
  }

  function renderSensorChoice(sensor, doorIndex, sourceHubIndex) {
    const hub = getHub(sourceHubIndex);
    const hubLabel = hub?.ip ? `Hub ${hub.ip}` : `Hub ${Number(sourceHubIndex) + 1}`;
    return `
      <button
        type="button"
        class="choice-button"
        data-action="select-sensor"
        data-door-index="${doorIndex}"
        data-source-hub-index="${sourceHubIndex}"
        data-sensor-id="${escapeHtml(sensor.id)}"
      >
        <span class="choice-title">${escapeHtml(sensor.name || sensor.id)}</span>
        <span class="choice-meta">${escapeHtml([hubLabel, sensorLabel(sensor)].filter(Boolean).join(' | '))}</span>
        <span class="choice-meta">${escapeHtml(sensor.id)}</span>
      </button>
    `;
  }

  function selectSensorForDoor(doorIndex, sensorId, sourceHubIndex) {
    const door = getDoor(doorIndex);
    if (!door || !sensorId) {
      return;
    }
    if (getUsedSensorIds(doorIndex).has(String(sensorId))) {
      notify('error', 'This DIRIGERA sensor is already linked to another door.', 'Sensor Already Used');
      closeModal();
      render();
      return;
    }

    door.sensor = sensorId;
    if (sourceHubIndex !== null && sourceHubIndex !== undefined) {
      state.sensorHubIpById[String(sensorId)] = hubIp(getHub(sourceHubIndex));
    }
    closeModal();
    scheduleUpdate();
    render();
  }

  function openAddHubModal() {
    openModal(
      'Add DIRIGERA Hub',
      `
        <div class="field-grid single">
          <div>
            <label class="form-label" for="new-hub-ip">DIRIGERA Hub IP<span class="required-mark">*</span></label>
            <input id="new-hub-ip" class="form-control" type="text" autocomplete="off" />
          </div>
        </div>
      `,
      `<div class="button-row">
        <button type="button" class="btn btn-primary" data-action="create-hub">Create Hub</button>
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
      </div>`,
    );
    document.getElementById('new-hub-ip')?.focus();
  }

  function createHub() {
    const ip = document.getElementById('new-hub-ip')?.value?.trim();

    if (!ip) {
      notify('error', 'DIRIGERA hub IP is required.', 'Hub Not Created');
      return;
    }

    if (externalDoors().hubs.some((hub) => String(hub.ip || '').trim() === ip)) {
      notify('error', 'A DIRIGERA hub with this IP already exists.', 'Hub Not Created');
      return;
    }

    externalDoors().hubs.push({
      ip,
      accessToken: '',
    });

    closeModal();
    scheduleUpdate();
    render();
  }

  function confirmRemoveHub(hubIndex) {
    const hub = getHub(hubIndex);
    if (!hub) {
      return;
    }
    const label = hub.ip || `DIRIGERA Hub ${Number(hubIndex) + 1}`;
    const remainingPairedHubCount = getPairedHubEntries()
      .filter((entry) => entry.hubIndex !== Number(hubIndex))
      .length;
    let message = 'This removes the hub from the staged config. ';
    message += remainingPairedHubCount
      ? 'Any door sensor selected from this hub will be cleared so another sensor can be discovered.'
      : 'Since no other paired hub will remain, all manual doors will also be removed.';
    openModal(
      `Remove ${label}`,
      `<p>${escapeHtml(message)}</p>`,
      `<div class="button-row">
        <button type="button" class="btn btn-danger" data-action="remove-hub" data-hub-index="${hubIndex}">Remove Hub</button>
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
      </div>`,
    );
  }

  function removeHub(hubIndex) {
    const index = Number(hubIndex);
    const hub = getHub(index);
    if (!hub) {
      return;
    }

    const removedHubIp = hubIp(hub);
    const removedHubWasPaired = removedHubIp && String(hub.accessToken || '').trim();
    const removedSensors = state.sensorsByHub[String(index)] || [];
    externalDoors().hubs.splice(index, 1);
    reindexSensorsByHubAfterHubRemoval(index);
    cleanDoorsAfterHubRemoval(removedHubIp, removedHubWasPaired);
    forgetSensorsFromRemovedHub(removedHubIp, removedSensors);
    closeModal();
    scheduleUpdate();
    render();
  }

  function reindexSensorsByHubAfterHubRemoval(removedHubIndex) {
    const nextSensorsByHub = {};
    for (const [hubIndex, sensors] of Object.entries(state.sensorsByHub)) {
      const numericHubIndex = Number(hubIndex);
      if (numericHubIndex < removedHubIndex) {
        nextSensorsByHub[String(numericHubIndex)] = sensors;
      } else if (numericHubIndex > removedHubIndex) {
        nextSensorsByHub[String(numericHubIndex - 1)] = sensors;
      }
    }
    state.sensorsByHub = nextSensorsByHub;
  }

  function forgetSensorsFromRemovedHub(removedHubIp, removedSensors) {
    for (const sensor of removedSensors || []) {
      const sensorId = String(sensor.id);
      if (state.sensorHubIpById[sensorId] === removedHubIp) {
        delete state.sensorHubIpById[sensorId];
      }
    }
  }

  function cleanDoorsAfterHubRemoval(removedHubIp, removedHubWasPaired) {
    const remainingPairedHubs = getPairedHubEntries();
    if (!remainingPairedHubs.length) {
      externalDoors().doors = [];
      return;
    }

    for (const door of externalDoors().doors) {
      if (!door.sensor) {
        continue;
      }

      const sensorHubIp = getSensorHubIp(door.sensor);
      if ((sensorHubIp && sensorHubIp === removedHubIp) || (!sensorHubIp && removedHubWasPaired)) {
        door.sensor = '';
      }
    }
  }

  async function openAddDoorModal() {
    const hubs = getPairedHubEntries();
    if (!hubs.length) {
      notify('error', 'Add and pair a DIRIGERA hub before adding a manual door.', 'Paired Hub Required');
      return;
    }
    if (!isAccountReady()) {
      notify('error', 'Complete the TTLock account credentials before adding a door.', 'TTLock Account Required');
      return;
    }
    if (!await ensureLockInventoryForDoorCapacity()) {
      return;
    }
    if (!canAddManualDoor()) {
      notify('error', 'Each manual door must be linked to a unique TTLock lock. No unused locks are available.', 'Door Limit Reached');
      render();
      return;
    }

    openModal(
      'Add Manual Door',
      `
        <div class="field-grid">
          <div>
            <label class="form-label" for="new-door-name">Door Name<span class="required-mark">*</span></label>
            <input id="new-door-name" class="form-control" type="text" autocomplete="off" />
          </div>
        </div>
      `,
      `<div class="button-row">
        <button type="button" class="btn btn-primary" data-action="create-door">Create Door</button>
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
      </div>`,
    );
    document.getElementById('new-door-name')?.focus();
  }

  async function ensureLockInventoryForDoorCapacity() {
    if (state.lockDiscoveryComplete) {
      return true;
    }

    openModal('Checking TTLock Locks', loadingHtml('Reading locks from TTLock...'), '');
    try {
      await flushUpdate();
      state.locks = await hb.request('/ttlock-locks', accountPayload());
      state.lockDiscoveryComplete = true;
      closeModal();
      return true;
    } catch (err) {
      openModal('Could Not Read TTLock Locks', `<p>${escapeHtml(getErrorMessage(err))}</p>`);
      return false;
    }
  }

  function createDoor() {
    const name = document.getElementById('new-door-name')?.value?.trim();

    if (!name) {
      notify('error', 'Door name is required.', 'Door Not Created');
      return;
    }

    externalDoors().doors.push({
      name,
      sensor: '',
      lock: '',
    });

    closeModal();
    scheduleUpdate();
    render();
  }

  function confirmRemoveDoor(doorIndex) {
    const door = getDoor(doorIndex);
    if (!door) {
      return;
    }
    openModal(
      `Remove ${door.name || 'Manual Door'}`,
      '<p>This removes the manual door from the staged config.</p>',
      `<div class="button-row">
        <button type="button" class="btn btn-danger" data-action="remove-door" data-door-index="${doorIndex}">Remove Door</button>
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
      </div>`,
    );
  }

  function removeDoor(doorIndex) {
    externalDoors().doors.splice(Number(doorIndex), 1);
    closeModal();
    scheduleUpdate();
    render();
  }

  function openDirigeraAuthModal(hubIndex) {
    const hub = getHub(hubIndex);
    if (!hub?.ip) {
      return;
    }

    openModal(
      'Pair DIRIGERA',
      `
        <p>Click Start Pairing, then press the Action Button on the DIRIGERA hub within 60 seconds.</p>
        <p class="inline-note">When pairing succeeds, the access token is filled in below the hub IP and the Pair button is hidden.</p>
      `,
      `<div class="button-row">
        <button type="button" class="btn btn-primary" data-action="start-dirigera-auth" data-hub-index="${hubIndex}">Start Pairing</button>
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
      </div>`,
    );
  }

  async function startDirigeraAuth(hubIndex) {
    const hub = getHub(hubIndex);
    if (!hub?.ip) {
      return;
    }

    openModal('Pairing DIRIGERA', loadingHtml('Waiting for the gateway button press...'), '');
    try {
      const result = await hb.request('/dirigera-authenticate', {
        gatewayIP: String(hub.ip).trim(),
      });
      hub.accessToken = result.accessToken;
      await flushUpdate();
      notify('success', 'DIRIGERA access token is staged.', 'Gateway Paired');
      closeModal();
      render();
    } catch (err) {
      openModal('DIRIGERA Pairing Failed', `<p>${escapeHtml(getErrorMessage(err))}</p>`);
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
    const results = await Promise.allSettled([
      hydrateLocksForCurrentAccount(),
      hydrateSensorsForPairedHubs(),
    ]);

    if (results.some((result) => result.status === 'fulfilled' && result.value === true)) {
      render();
    }
  }

  async function hydrateLocksForCurrentAccount() {
    if (!isAccountReady()) {
      return false;
    }

    const fingerprint = accountFingerprint();
    const locks = await hb.request('/ttlock-locks', accountPayload());
    if (fingerprint !== accountFingerprint()) {
      return false;
    }

    state.locks = locks;
    state.lockDiscoveryComplete = true;
    state.credentialTestFingerprint = fingerprint;
    return true;
  }

  async function hydrateSensorsForPairedHubs() {
    const pairedHubs = getPairedHubEntries();
    if (!pairedHubs.length) {
      return false;
    }

    let hydrated = false;
    const results = await Promise.allSettled(pairedHubs.map(async (entry) => {
      const sensors = await hb.request('/dirigera-open-close-sensors', {
        gatewayIP: String(entry.hub.ip).trim(),
        accessToken: String(entry.hub.accessToken).trim(),
      });
      return { entry, sensors };
    }));

    for (const result of results) {
      if (result.status !== 'fulfilled') {
        continue;
      }
      const { entry, sensors } = result.value;
      const currentHub = getHub(entry.hubIndex);
      if (hubIp(currentHub) !== hubIp(entry.hub)) {
        continue;
      }
      state.sensorsByHub[String(entry.hubIndex)] = sensors;
      rememberSensorsForHub(entry.hubIndex, sensors);
      hydrated = true;
    }

    return hydrated;
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
