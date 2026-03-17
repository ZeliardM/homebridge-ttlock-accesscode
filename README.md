<p align="center" style="text-align:center;">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150" style="display:block; margin:auto;">

</p>

<span align="center">

# Homebridge TTLock Access Code Plug-In

</span>

<p align="center">
  <a href="https://github.com/ZeliardM/homebridge-ttlock-accesscode/blob/latest/LICENSE"><img src="https://img.shields.io/npm/l/homebridge-ttlock-accesscode?color=yellow" alt="mit license"></a>
  <a href="https://www.npmjs.com/package/homebridge-ttlock-accesscode/v/latest"><img src="https://img.shields.io/npm/v/homebridge-ttlock-accesscode/latest?label=npm%40latest&color=blue" alt="latest npm version"></a>
  <a href="https://www.npmjs.com/package/homebridge-ttlock-accesscode/v/beta"><img src="https://img.shields.io/npm/v/homebridge-ttlock-accesscode/beta?label=npm%40beta&color=red" alt="beta npm version"></a>
  <a href="https://www.npmjs.com/package/homebridge-ttlock-accesscode/v/latest"><img src="https://img.shields.io/npm/dt/homebridge-ttlock-accesscode?color=brightgreen" alt="npm downloads total"></a>
  <a href="https://www.paypal.me/ZeliardM/USD/"><img src="https://img.shields.io/badge/donate-paypal-orange" alt="donate paypal"></a>
  <a href="https://github.com/sponsors/ZeliardM"><img src="https://img.shields.io/badge/donate-github-orange" alt="donate github"></a>
</p>

This is a [Homebridge](https://github.com/homebridge/homebridge) plug-in based for integrating TTLock smart locks with the TTLock Cloud API.

This plug-in lets you control TTLock locks in the Apple Home app with lock/unlock status, control, and access code management if supported.

## Requirements
- Homebridge Supported Versions: 1.8.0 and 2.0.0-beta.0 or later.
- Node.js Supported Versions: 20, 22, and 24.
- TTLock Smart Lock.
- TTLock Gateway for non-Wi-Fi locks.
- Remote Unlock enabled in the TTLock mobile app.
- TTLock Open API account with an approved OAUTH2.0 App.

## Current Supported and Tested Devices
- I have tested this plug-in with a G2 Gateway setup and TTLock lock access code features in Apple Home. More lock models and gateway setups are expected to work, but may vary by TTLock firmware and account setup.

## Features
- Get the status of your TTLock devices.
- Lock and unlock your TTLock devices.
- Manage passcodes for your TTLock devices in Apple Home.
- Automatic API usage protection with adaptive polling.
- Periodic discovery and offline recovery handling.

## Installation
- Install from the Homebridge UI or with npm.
- After installing, configure your TTLock credentials and API App values, then restart Homebridge.

```bash
npm install -g homebridge-ttlock-accesscode
```

## Configuration Notes
- Create an account in the [TTLock Cloud API](https://euopen.ttlock.com/register)
- Create your OAUTH2.0 App, approval may take a few days.
- Use your TTLock mobile app username/password and OAUTH2.0 App client_id and client_secret in the plugin settings.
- For non-Wi-Fi locks, make sure your gateway is online and near the lock.
- The default settings are tuned for TTLock's monthly API limits.
- Polling is automatically slowed when monthly allowance gets lower.

## Access Code Notes
- Access code support is exposed through the Apple Home App.
- Existing passcodes are loaded from TTLock and mapped into the Apple Home App.
- Add/Delete/List/Read flows are handled through the Apple Home App.

## Example Configuration
```json
{
  "bridge": {
    "name": "Homebridge",
    "username": "11:22:33:AA:BB:CC",
    "port": 12345,
    "pin": "001-02-003"
  },
  "description": "This is an example configuration file.",
  "platforms": [
    {
      "platform": "TTLockAccessCode",
      "name": "TTLockAccessCode",
      "clientId": "YourClientID",
      "clientSecret": "YourClientSecret",
      "username": "YourUsername",
      "password": "YourPassword",
      "totalApiCallsPerMonth": 30000,
      "pollingInterval": 300,
      "discoveryPollingInterval": 12,
      "offlineInterval": 7,
      "waitTimeUpdate": 100
    }
  ],
  "accessories": []
}
```

## Known Limitations
- Apple HomeKey is not supported by TTLock readers.
- Gateway-dependent locks will return gateway-offline conditions if the gateway is unavailable.
- TTLock Cloud API limits and behavior can change without notice.