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
- Homebridge Supported Versions: 1.11.2 or later, including Homebridge 2.x.
- Node.js Supported Versions: 22, 24, and 26.
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
- After installing, configure your TTLock credentials and API App values in the Homebridge UI, then restart Homebridge.

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
- The last 1% of the monthly allowance (at least 50 calls) is kept for locking, unlocking and access codes. When only that is left, polling and discovery pause until the month ends.
- The Homebridge UI can test your TTLock credentials and shows how many locks the account can see.

## Access Code Notes
- Access code support is exposed through the Apple Home App.
- Permanent access codes, and period access codes while their period runs, are loaded from TTLock and shown in the Apple Home App. One-time, erase and cyclic codes, and period codes outside their period, are not shown.
- Access codes added from the Apple Home App are permanent codes.
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

## Upgrading From 2.x
- Version 3 removes the optional IKEA DIRIGERA doors (`externalDoors`) and the lock and unlock block that went with them.
- Door accessories created by earlier versions are removed from HomeKit when Homebridge starts, together with any automations that used them.
- An `externalDoors` setting left in the config is ignored and logs a warning at startup. Remove it to stop the warning; saving a change in the plugin settings also removes it.

## Known Limitations
- Apple HomeKey is not supported by TTLock readers.
- A lock that does not answer three polls in a row, for example because its gateway is offline, shows No Response in Apple Home. Polling continues, and the lock shows its state again as soon as a poll reaches it.
- After Homebridge starts, a lock answers No Response to lock, unlock and access code requests until the plugin has found it in TTLock.
- Lock and unlock are answered at once and sent to TTLock in the background. If a command fails, or cannot be sent in time to finish within 60 seconds of the request, Apple Home goes back to the lock's last known state. A command that could not be sent in time is not sent later.
- Adding or deleting an access code goes through the gateway and can take longer than the roughly 9 seconds Apple Home waits. Apple Home may then report a failure even though the change was made; open the lock's access codes again to see the current list. A change that cannot be sent within those 9 seconds is not sent.
- TTLock Cloud API limits and behavior can change without notice.
