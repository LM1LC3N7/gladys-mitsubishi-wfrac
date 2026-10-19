# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its only
runtime dependency (HTTP and HTTPS go through `node:http` / `node:https`). It
reads the WF-RAC Wi-Fi adapters of Mitsubishi Heavy Industries air
conditioners over their local, undocumented API (port 51443) and shows each
on one Gladys device; commands behind an off-by-default option. Protocol
ported from pywfrac 0.1.10 (MIT). Never tested with a real device, not
affiliated with Mitsubishi Heavy Industries.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` (Node 22 and 24) and `audit` before every
commit.

## Architecture

```
index.js                  SDK bootstrap only
src/handlers.js           every SDK handler -> the app (shared with the tests)
src/app.js                WfracApp: polling, failures, 429 pause, registration, devices,
                          states, badges, status, the buttons, the commands, guards
src/wfrac/protocol.js     the airconStat frame (pywfrac parser.py), pure
src/wfrac/client.js       the four commands, the envelope, parsing, the Gate (1 s spacing)
src/wfrac/http.js         the only network access (bounded), error kinds, TLS options
src/devices.js            -> the Gladys devices, states and command values (pure)
src/publisher.js          states within 300/min
src/store.js              wfrac-ids.json (written once) + wfrac-state.json
src/config.js             config_schema normalized (addresses, allow_commands, interval, language)
src/constants.js          commands, result codes, feature keys, core enums, limits, timings
src/i18n.js               runtime texts (en/fr)
test/helpers/             the fake adapters behind the transport; Gladys is the SDK's fake
test/fixtures/            golden.json: pywfrac's own decode/encode of its live captures
scripts/cover.mjs         cover.png generator
```

## Rules

- **External ids are forever**: device `wfrac:<airconId>` (lower case),
  features `binary`, `mode`, `target-temperature`, `fan-speed`,
  `swing-vertical`, `indoor-temperature`, `outdoor-temperature`,
  `error-code`, and the option values (core `AC_MODE`, `AC_FAN_SPEED`,
  `AC_SWING_VERTICAL`). A republished device never loses a feature.
- Manifest keys (`addresses`, `allow_commands`, `poll_interval`, `language`,
  the actions `test_connection` and `register`) are frozen.
- **Registration** (`updateAccountInfo`): the adapter has four slots and
  frees none. One operator id per installation, kept in `/data`; never
  register without it kept, nor while the commands are off; once per
  adapter, then at most once an hour (attempt persisted before the request);
  a full table only through the button. Never in a loop.
- **Commands**: refused unless `allow_commands` (checked on arrival and again
  right before sending); decided on a fresh `getAirconStat` only, refused
  when a frame field is unknown; never sent after 3.5 s; a silence, a 5xx, a
  broken answer, result 99 or an unknown result is "sent, without
  confirmation"; never retried (no wait for the 60 s write lock); one at a
  time per adapter; the ack never waits for Gladys.
- **One request at a time per adapter, 1 s apart** (the Gate), a failed one
  included.
- **Answers are hostile**: own fields of plain objects only, exact types,
  64 KB at most, frames bounded; never log an answer nor the ids. No command
  on a frame whose CRC does not match (adapters: window `[start - 2, end -
2)`; ours: the block), nor on a read without result 0 and its airconId.
- **Ids**: `/data/wfrac-ids.json`, written once; only ENOENT makes new ids,
  anything else is set aside (`.corrupt`) and only the button replaces it.
  `getDeviceInfo` carries placeholder ids.
- **Lifecycle**: start, `connected` and configuration changes run in one
  chain (`serialized`); a replaced unit never reads again.
- Never call the link to the adapter protected or secure: its HTTPS is not
  verified (self-signed certificate, old TLS accepted).
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network (a loopback server at most).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
