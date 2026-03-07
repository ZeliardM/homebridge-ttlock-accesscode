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

<div align="center">

>## PLEASE READ!!!
>HomeKey Support is not physically possible with TTLock Readers, but Access Code Features are working in HomeKit.

</div>

This is a [Homebridge](https://github.com/homebridge/homebridge) plug-in based for integrating TTLock smart locks with the TTLock Cloud API.

## Features

- Get the status of your TTLock devices.
- Lock and unlock your TTLock devices.
- Manage passcodes for your TTLock devices.

## Requirements

1. TTLock Smart Lock
2. A Gateway (If your lock does not have built-in Wi-Fi, I purchased a TTLock G2 Gateway off Amazon.)
3. Remote Unlock must be enabled through the TTLock App locally within bluetooth or Wi-Fi rnage of your lock.
4. You must create a TTLock Open API Account. This is not the username and password that will be used in the setting in the plug-in, this is for creating an OAUTH2.0 App with the TTLock Cloud API for the plug-in to get access to your TTLock Devices.

## Setup

1. Create an account in the [TTLock Cloud API](https://euopen.ttlock.com/register). 
2. Create your OAUTH2.0 App, give it a name, icon, select the 'App' option, and a short description.</br>
*This may take a few days to be approved by their Development Team.*
3. Once approved, you will need the *client_id* and *client_secret* from the app.
4. Setup the TTLock Mobile App, create an account in the Mobile App, setup and install your lock(s).</br>
*If your Lock is not Wi-Fi Capable, make sure you setup your Gateway as well and have it close enough to your Lock for the Gateway to pick up the Lock in the Mobile App.*
5. Once you have your Mobile App Username and Password, and the client_id and client_secret, you can setup the plug-in in Homebridge.

## IMPORTANT
I have only tested this with a G2 Gateway.