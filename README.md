# gladys-mitsubishi-wfrac

A [Gladys Assistant](https://gladysassistant.com) external integration for the
**Mitsubishi Heavy Industries** (MHI) air conditioners fitted with the
**WF-RAC** Wi-Fi adapter (Smart M-Air app), over the local API of the adapter:
on/off, mode, setpoint, fan speed, vertical vane, indoor and outdoor
temperatures, error code. Not for Mitsubishi Electric units (MELCloud is in
the Gladys core).

**Never tested with a real device.** Unofficial, not affiliated with
Mitsubishi Heavy Industries.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Commands are **off by default**. With them allowed, Gladys registers one
  identifier (kept in `/data`) on each adapter, which has only four slots:
  once, then at most once an hour after a refusal, never on a full table
  without the "Register" button.
- Each command reads the unit again and is decided on that read, leaves
  within 3.5 s of the click or is refused unsent, and is never retried; a
  command that may have been received is answered "sent, without
  confirmation".
- The local API has no password, and the HTTPS of the adapter is not
  verified (self-signed certificate, old TLS): keep the adapters on a trusted
  network.

## How it works

```
index.js            SDK wiring only
src/handlers.js     the SDK handlers -> the app (shared with the tests)
src/app.js          polling, devices, states, badges, status, registration, commands
src/devices.js      one adapter -> one Gladys device; command values (pure)
src/wfrac/protocol.js  the airconStat frame, decoded and encoded (pure)
src/wfrac/client.js    getDeviceInfo, getAirconStat, setAirconStat, updateAccountInfo
src/wfrac/http.js      one POST over HTTP or HTTPS, bounded in time and size
src/store.js        /data/wfrac-ids.json (written once), wfrac-state.json
src/publisher.js    states to Gladys within 300 per minute
```

The frame codec is checked byte for byte against pywfrac's own output on its
live captures (`test/fixtures/golden.json`, made by
`test/fixtures/generate.py`).

## Development

```bash
npm install
npm run format:check
npm run lint
npm test                 # Node 22 and 24
npm run audit            # npm audit --omit=dev
npm run cover            # regenerates cover.png (plain Node)
npx --yes github:GladysAssistant/integration-store .   # store checks
```

## Credits and license

The protocol is ported from [pywfrac](https://github.com/blues-sechseck/pywfrac)
0.1.10 and
[Mitsubishi-WF-RAC-Integration](https://github.com/blues-sechseck/Mitsubishi-WF-RAC-Integration)
(jeatheak, blues-sechseck, MIT): see `THIRD_PARTY_NOTICES.md`. This
integration is licensed under the Apache License 2.0 (`LICENSE`).
