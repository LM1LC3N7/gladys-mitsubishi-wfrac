# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the two projects below. The ported
parts were rewritten, not copied; the changes are described below. Both
projects carry the same MIT notice.

## pywfrac

<https://github.com/blues-sechseck/pywfrac> (package `pywfrac`, version
0.1.10, tag `v0.1.10`, commit c47f709), the library of the Home Assistant
integration below. MIT License (`LICENSE` of the repository).

## Mitsubishi-WF-RAC-Integration

<https://github.com/blues-sechseck/Mitsubishi-WF-RAC-Integration> (the Home
Assistant custom integration `mitsubishi_wf_rac`, read at commit d94efed,
including its `docs/wf-rac-module-reference.md`). MIT License (`LICENSE` of the
repository).

## The MIT notice of both projects

```
MIT License

Copyright (c) 2022 jeatheak
Copyright (c) 2026 blues-sechseck

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## What was ported

- From pywfrac `parser.py`, `utils.py` and `capabilities.py`, in
  `src/wfrac/protocol.js`: the layout of the `airconStat` frame (command block
  and receive block, segment count, 4-byte segments, the `[1, 255, 255, 255,
255]` trailer), the CRC16-CCITT (0x1021, initial 0xFFFF), the read and write
  masks of power, mode, fan (`AirFlow`), vertical and horizontal vanes,
  setpoint, 3D auto, cool/hot judge, occupancy and self-clean bits, the error
  code (`M`/`E` families), the model byte, the indoor and outdoor thermistor
  tables (256 entries each) and their segments (tag 0x80, sub 16 and 32), and
  the setpoint ranges per mode and model (`setpoint_range`, the ZT "range 2").
- From pywfrac `repository.py`, in `src/wfrac/client.js` and
  `src/wfrac/http.js`: the local API on port 51443 (`POST
/beaver/command/<command>`, plain HTTP or HTTPS with a self-signed
  certificate and an old TLS stack), the envelope (`apiVer`, `command`,
  `deviceId`, `operatorId`, `timestamp`, `contents`), the commands
  `getDeviceInfo`, `getAirconStat` (with `airconId`), `setAirconStat` and
  `updateAccountInfo` (`accountId`, `airconId`, `remote: 0`, `timezone`), the
  meaning of the `result` codes (1/11/12: declined, write lock; 2: not
  registered, or a full account table on registration; 10, 20, 99), one
  request at a time and one second between requests, the scheme found by
  trying one then the other.
- From the Home Assistant integration (`config_flow.py`, `coordinator.py`,
  `climate.py`) and its module reference: the 60-second polling, one operator
  id and one device id per installation, the four account slots that only the
  manufacturer's app frees, the 60-second write lock of the last writer, the
  mapping of the modes, fan steps and vanes to a climate entity.

Changed: commands are off by default and refused unless allowed in the
configuration; registration only while they are allowed, with the ids safely
kept in `/data`, once per adapter, then at most once an hour after a refusal
(never in a loop), and never again on a full table without the button; the
state is read again right before each command and the frame built on that
read only (a field that decodes to no known value is unknown and refuses the
command, where pywfrac falls back to a default); the command is sent within
3.5 s of the click or refused unsent, never retried (no wait for the write
lock, no registration and retry inside a command); the receive block's CRC is
not checked (the adapters' own does not match, pywfrac does not check it
either); no horizontal vane, 3D auto, self-clean, Home Leave mode, external
room temperature, operation data, energy or firmware check.
