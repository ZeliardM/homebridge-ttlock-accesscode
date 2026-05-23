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
- Node.js Supported Versions: 22 and 24.
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
- Expose optional manual doors from IKEA DIRIGERA open/close sensors.
- Block linked TTLock lock/unlock commands when a manual door is open or unavailable.
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
- Manual door DIRIGERA polling is local to the hub and does not count against TTLock API usage.
- The Homebridge UI can test TTLock credentials, discover TTLock locks, pair DIRIGERA hubs, and list supported sensors.

## Access Code Notes
- Access code support is exposed through the Apple Home App.
- Existing passcodes are loaded from TTLock and mapped into the Apple Home App.
- Add/Delete/List/Read flows are handled through the Apple Home App.

## Manual Door Notes
- Manual doors are optional and are configured under `externalDoors`.
- Only IKEA DIRIGERA open/close sensors are supported at this time.
- Add paired DIRIGERA hubs under `externalDoors.hubs`.
- Add HomeKit doors under `externalDoors.doors`.
- Remove a hub or door when you no longer want those manual door accessories exposed.
- Door accessory IDs are generated from `externalDoors.doors[].name`. Renaming a door creates a new HomeKit door accessory and removes the old cached one.
- The DIRIGERA open/close sensor is not exposed as a separate HomeKit contact sensor. The plugin exposes a HomeKit Door service only.
- Manual doors cannot be opened or closed from HomeKit. HomeKit door position follows the DIRIGERA sensor state.
- Each manual door requires `sensor`, set to the DIRIGERA open/close sensor ID, and `lock`, set to the TTLock `device_id`/lock ID protected by that door.
- In the Homebridge UI, use the discovered TTLock lock list when linking a manual door.
- When a linked manual door is open, unknown, or unavailable, lock and unlock commands for that TTLock lock are ignored.

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
      "waitTimeUpdate": 100,
      "externalDoors": {
        "doorPollingInterval": 60,
        "hubs": [
          {
            "ip": "192.168.1.50",
            "accessToken": "DIRIGERA_ACCESS_TOKEN"
          }
        ],
        "doors": [
          {
            "name": "Front Door",
            "sensor": "IKEA_CONTACT_SENSOR_ID",
            "lock": "TTLOCK_LOCK_ID"
          }
        ]
      }
    }
  ],
  "accessories": []
}
```

## Known Limitations
- Apple HomeKey is not supported by TTLock readers.
- Gateway-dependent locks will return gateway-offline conditions if the gateway is unavailable.
- TTLock Cloud API limits and behavior can change without notice.
