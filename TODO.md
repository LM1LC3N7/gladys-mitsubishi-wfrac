# TODO — Mitsubishi Heavy Industries WF-RAC v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 (post #275, lot 8) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-19): local API of the WF-RAC adapter
      (port 51443, HTTP or HTTPS found by trying), up to 8 adapters, one
      device per adapter: on/off, mode, setpoint, fan speed, vertical vane
      (commands behind `allow_commands`, off), indoor and outdoor
      temperatures, error code; registration of one kept operator id;
      polling and backoff, 429 pause persisted, test and register buttons,
      docs en/fr, cover. The frame codec matches pywfrac byte for byte on its
      live captures; everything else tested against fake adapters only.
- [ ] **Milestone 2 — real device**: run against a real adapter (see "To
      check"), keep anonymized frames as fixtures.
- [ ] **Milestone 3 — more**: horizontal vane (only where the unit reports it,
      §6.7 of the module reference), 3D auto, energy (the `Electric` segment:
      check that it is a cumulative index before any `energy-sensor`), an
      "Unregister" button (`deleteAccountInfo`, frees our slot), mDNS
      discovery (`_beaver._tcp`), operation data (compressor frequency,
      humidity) through status requests — they take the 60 s write lock,
      which must stay free for the app.

## To check on a real device

- **Measure** the latency of `getAirconStat` and `setAirconStat` (pywfrac
  allows 25 s, as the polling here, and its comments speak of 10-20 s; the
  module reference says well under a second). Commands refuse when the fresh
  read does not end within 2.4 s: how often does that happen?
- The horizontal vane and 3D auto bits every command writes (byte 12 and 11,
  pywfrac's `CMD_WIND_LR_MASKS`, `Entrust`): on a legacy-bus unit (byte 12
  read as 1) each command sets them to "auto" / off; does the unit follow, and
  is there a set-bit that would leave them alone?
- The shifted window of the receive CRC ([start - 2, end - 2)) on other
  firmware branches (seven captures of one SRK35ZS-WF and the Home Assistant
  fixture only).
- Whether the app shows and can remove a client registered with `remote: 0`
  (how a user frees the slot of an uninstalled Gladys).
- HTTPS with Node 22/24 (OpenSSL 3): does the handshake pass with
  `minVersion: 'TLSv1'`, `DEFAULT:@SECLEVEL=0` and legacy renegotiation on
  the `WF-RAC-HTTPS` and `WCBN4612L` branches?
- The `airconId` format (12 hex characters?) and whether it is stable.
- The answer of `setAirconStat`: does the returned state already show the
  command? (Not used to confirm: the guard waits for a later read.)
- The `updateAccountInfo` answer on a table that already holds our id (in
  place, result 0?), and `timezone` (the container's zone, `UTC` by default).
- Whether HTTP 429 ever happens (strings in the firmware) and its
  `Retry-After`.
- WCBN4612L: the module reference says it takes the zeros of a status request
  literally; this integration sends no status request, only full frames.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-mitsubishi-wfrac:0.1.0`); the first patch release
  gives 0.1.1. `test/manifest.test.js` checks the four agree.
- **Own client, no Python at runtime**: pywfrac 0.1.10 (MIT, tag v0.1.10,
  c47f709) and the Home Assistant integration
  blues-sechseck/Mitsubishi-WF-RAC-Integration (MIT, d94efed) ported to the
  parts this integration needs; both `LICENSE` files checked (MIT, jeatheak
  2022, blues-sechseck 2026). Cloned read only in `_ref/pywfrac` and
  `_ref/wfrac-ha`. Credited in README, docs and `THIRD_PARTY_NOTICES.md`
  (full MIT notice), shipped in the image with `LICENSE` (the standard
  Apache-2.0 text without any name). Runtime dependency: the SDK only.
- **Golden vectors**: `test/fixtures/generate.py` runs pywfrac's own
  `parser.py` (loaded without its package `__init__`, which needs aiohttp)
  on the library's seven live captures; `golden.json` holds the decoded
  fields and nine command frames per capture. The JS codec matches all 63
  frames byte for byte.
- **Receive CRC checked** (review I4): in the frames the adapters send, the
  receive CRC covers the window shifted two bytes back, `[start - 2, end -
2)` (the command CRC, then the receive block without its last two bytes):
  it matches on all seven live captures and the Home Assistant fixture; in
  the frames the app and this integration send, it covers the receive block
  itself. Either is accepted ("verified"); pywfrac does not check it. A frame
  that matches neither is still shown (logged when it starts: `crc`), but no
  command is decided on it ("frame not verifiable: not sent"). Bounds
  (segment counts within the frame, 64 segments, 2048 base64 characters)
  stand too. The CRC of what we send is computed as pywfrac does. The fake
  adapters write the shifted CRC.
- **Strict decoding**: a mode, fan or vane nibble that matches no known value
  is `undefined` (pywfrac falls back to "auto"); a command needing it is
  refused ("incomplete state"). The setpoint is decoded only between 10 and
  33 °C (the widest range of the models), else unknown; the flat floor of the
  thermistor tables (outdoor bytes 0-4 = -50 °C, indoor bytes 0-15 = -30 °C:
  sensor absent or cut) is unknown, never published.
- **Features** (core `DEVICE_FEATURE_UNITS_BY_CATEGORY`, °C only):
  `air-conditioning` binary, mode (`AC_MODE`: auto, cooling, heating, drying,
  fan), target-temperature (bounds 16-30, 10-33 for ZT "range 2" models,
  frozen at creation), fan-speed (`AC_FAN_SPEED`: auto, quiet = step 1, low =
  2, mid = 3, high = 4), swing-vertical (`AC_SWING_VERTICAL`: swing = auto,
  positions 1-4); `temperature-sensor/decimal` indoor and outdoor (from the
  receive segments, tables of pywfrac); `text/text` error code ("00" shown
  as "No error"). On/off is `air-conditioning/binary`, as MELCloud in the
  core: the brief accepts that "turn everything off" reaches an air
  conditioner (it reaches it only through what targets air conditioning or
  maps it, e.g. a voice assistant). No horizontal vane in v1 (7 positions do not fit the core's
  5, and legacy-bus units never report it).
- **One device per adapter**, id `wfrac:<airconId>` (lower case), never the
  IP nor a name; another airconId answering at an address becomes a new
  device, the old one shows unreachable.
- **Registration** (the adapter's four account slots, never freed on their
  own): one operator id (UUID) and one device id (`gladys-` + 16 hex) per
  installation, in a file of their own, `/data/wfrac-ids.json`, written once
  at the first start (temporary file, fsync, rename; review I5). Only ENOENT
  is a first start: any other read error or invalid content sets the file
  aside as `.corrupt` (still "corrupt" at the next start), makes no new ids
  and says so in the status; the "Register Gladys on the adapters" button,
  with the commands allowed, makes new ones on demand (the old slot stays
  taken: the docs say how to free it). If the first write fails, no
  registration at all. The state file is written with fsync then rename.
  Registered only while `allow_commands` is on, after a good read, once per
  adapter; the attempt time is persisted before the request; after a refusal
  or a `setAirconStat` result 2, at most once an hour. Registration result 2
  counts as "full" only when the last `getAirconStat` reported
  `numOfAccount` 4 (review M3: result 2 is also the catch-all refusal); a
  full table is never retried on its own — the button (30 s cooldown) tries
  once more. Re-registering our own id takes no new slot (module reference
  §2.5). No `deleteAccountInfo` in v1.
- **Requests**: one at a time per adapter (a `Gate`), 1 s apart counted from
  the end of each request, a failed one included (pywfrac, field rule);
  commands jump the queue but never cut the request in flight. Envelope
  `timestamp` from our clock (the adapter has no RTC).
- **Polling**: `getAirconStat` every 60 s (30 s – 10 min, Home Assistant's
  60 s), 25 s per read (pywfrac); `getDeviceInfo` at the start and after any
  failure (scheme discovery: the known one first, else HTTPS then HTTP; the
  scheme is kept in `/data`). `getDeviceInfo` carries placeholder ids
  (`gladys-probe`), never ours: it may go in plain text to a device not known
  yet (review M6). One discovery at a time across the adapters; an airconId
  already read under another address is read once only (review M5, status
  note). Failures: 30 s, 1, 2, 5 min, never shorter than the interval; no
  follow-up read and no test-button read inside that delay (the button says
  when the next try comes; reviews M1, M2). Commands never fall back to the
  other scheme.
- **Lifecycle** (review I1): start, `connected` and configuration changes run
  one after the other (the SDK hands every message over at once); a unit
  replaced by a restart never reads nor schedules again.
- **429**: `Retry-After` bounded to 1 min – 6 h, 5 min without; every path
  (polling, buttons, commands); persisted per address, bounded at reading;
  neither a reconnection to Gladys nor a restart clears it.
- **Command rules** (lot 6 and waves 2/3 lessons): value checked strictly
  (finite number or an exact numeric text; `null`, `''` refused; option
  values of the feature only; setpoint rounded to 0.5 °C); `allow_commands`
  on arrival, after the fresh read and in `beforeSend` right before the
  transport; the unit read again (`getAirconStat`, ending by 2.4 s) and the
  frame built from that read only; setpoint bounded to the range of the mode
  just read (pywfrac `setpoint_range`) and to the created feature's bounds;
  not sent when already so (unless a guard holds); sent by 3.5 s or refused
  unsent; answered by 4.3 s. Outcomes: result 0 → success; 1/11/12 → "declined
  (write lock of another app, or the unit), try again in a minute", not
  retried; 2 → "Gladys not known by the adapter", registration allowed again
  within the hour; 10/20 → refused; 99, unknown or missing result, silence,
  5xx, broken answer → **"sent, without confirmation"**, guard set; nothing
  accepted the connection → "not sent"; other 4xx → refused; 429 → pause.
  Reads 5 s and 20 s after every command. One command at a time per adapter.
  The ack never waits for Gladys (publications in the background) nor for
  /data (pause and registration saved in the background; review M15).
- **Review round 1 (2026-10-19)**: the fresh read of a command needs result 0
  and the adapter's airconId (M4) and a verified CRC (I4). A command is
  refused, unsent, when another field of the same unit has an active guard
  whose value read now still equals its start value with no move seen (the
  previous command is not visible yet: the frame would undo it; never merged
  with the memory; I2). A mode change brings the setpoint read into the new
  mode's range ∩ the feature's bounds and sends it with the mode (frame and
  guard; I3). In fan only the setpoint range is the union of the regulating
  modes, 16-30 °C (33 °C for range 2; M9). TLS comment exact (security level
  0, legacy renegotiation; M7); the 60 s lock explained in the docs and its
  message without "remote" (an IR remote takes no lock; M8); uninstall
  (M11) and "turn everything off" (M13) documented.
- **Guards** (waves 2/3 lessons): per adapter and field, start and wanted
  values; lifted only by a read that moved then shows the wanted value, or
  after 90 s; never by an unknown value.
- **Hostile answers**: 64 KB at most; only own fields of plain objects
  (`Object.getPrototypeOf === Object.prototype`, `Object.hasOwn`); the
  airconId `[A-Za-z0-9]{4,40}`; the persisted file read back key by key with
  patterns (no `__proto__`); texts stripped of control characters and cut to 40. Logs carry error kinds, HTTP statuses and result codes only — never the
  ids nor an answer.
- **HTTPS**: certificate not checked, TLS 1.0+, OpenSSL security level 0
  (pywfrac uses 1), legacy renegotiation allowed. Docs say it protects
  nothing against impersonation and never present the link as protected;
  over plain HTTP everything travels in plain text, our ids included (except
  in `getDeviceInfo`).
- **Reconnection to Gladys** (`connected`): republishes status, Discovery,
  states (published-state memory forgotten) and badges (lot 6 lesson); never
  clears the pauses, registrations nor the client; new addresses or interval
  restart the polling. A device published again keeps every created feature.
- **gladys_version >= 5.1.0** (as the sibling local modules); **category
  `climate`**, transport `local`.
- **Not checked here (PIPELINE step 1, main session)**: duplicates in the
  store, the core and the forum were checked when the batch was reserved
  (post #275). No Docker on this PC: the image was not built locally. The
  store validator (`npx github:GladysAssistant/integration-store .`) cannot
  be run from a module session: it runs at publication (main session).
