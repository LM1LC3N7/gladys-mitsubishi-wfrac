# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-19

### Added

- Mitsubishi Heavy Industries air conditioners with the WF-RAC Wi-Fi adapter,
  over the local API of the adapter (port 51443, plain HTTP or HTTPS found on
  its own): one device per adapter, up to 8, with on/off, mode, setpoint (bounded to
  the range of the unit for its mode), fan speed, vertical vane, indoor and
  outdoor temperatures and the error code of the unit. Never tested with a
  real device.
- Commands off by default ("Allow the commands"). With them allowed, Gladys
  registers one identifier, kept in `/data`, on each adapter (four slots):
  once, then at most once an hour after a refusal; never when the identifier
  cannot be kept; never again on a full table without the "Register Gladys on
  the adapters" button.
- Each command reads the unit again and is decided on that read, leaves
  within 3.5 s of the click or is refused unsent, checks the option again
  right before sending, and is never retried; a command that may have been
  received is answered "sent, without confirmation" and the unit is read
  again after 5 and 20 s. One command at a time per adapter, one request at a
  time to it, 1 s apart.
- Reads every 60 s (30 s to 10 min); failures retried after 30 s, 1, 2 then
  5 min, never sooner than the interval; HTTP 429 pauses bounded to 1 min –
  6 h, kept in `/data`, for every path.
- "Test the connection" button; status, Discovery list, states and badges
  published again after a reconnection to Gladys; a device published again
  keeps every feature already created.
- The identifier of Gladys in a file of its own (`/data/wfrac-ids.json`),
  written once; an unreadable one is set aside and never replaced on its own
  (the status says so, the "Register" button makes a new one).
- Frames checked by their CRC: no command on a frame that does not match;
  setpoints outside 10-33 °C and thermistor floors are unknown.
- A command is refused while the previous one on another setting of the same
  unit is not visible yet; a mode change brings the setpoint into the new
  mode's range; the fresh read must answer result 0 with its airconId.
- HTTPS tried first; the first request to an address carries placeholder
  ids. The same adapter typed twice is read once.
- Docs (French, English) with the 60 s lock, plain HTTP, fan-only range and
  uninstalling, cover, `THIRD_PARTY_NOTICES.md` (pywfrac and the Home
  Assistant integration, MIT), shipped in the image with `LICENSE`.

[Unreleased]: https://github.com/LM1LC3N7/gladys-mitsubishi-wfrac/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-mitsubishi-wfrac/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-mitsubishi-wfrac/releases/tag/v0.1.1
