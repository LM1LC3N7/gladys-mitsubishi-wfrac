// -----------------------------------------------------------------------------
// Fake WF-RAC adapters behind the transport the integration is given. The
// first state is a live capture of pywfrac (on_cool, an SRK35ZS-WF); the rest
// follows the behaviour pywfrac and the module reference describe (made up,
// never captured from a unit of ours): getDeviceInfo, getAirconStat,
// setAirconStat (applied when our operator id is registered), updateAccountInfo
// (four slots). Records every request. No network. Delays use setTimeout, so
// the mocked clock drives them.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { WfracError, ERROR_KINDS } from '../../src/wfrac/http.js';
import {
  INDOOR_TEMPERATURES,
  OUTDOOR_TEMPERATURES,
  decodeStat,
  encodeCommand,
} from '../../src/wfrac/protocol.js';

export const golden = JSON.parse(
  readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'),
);

export const HOST = '192.168.1.70';
export const HOST2 = '192.168.1.71';
export const AIRCON_ID = '348e89c5a137';
export const AIRCON_ID2 = '348e89c5b248';
export const NOW = Date.UTC(2026, 9, 19, 18, 0, 0);

/** A frame of `state`, with its indoor and outdoor temperature segments. */
export function render(state) {
  const bytes = [...Buffer.from(encodeCommand(state), 'base64')];
  const start = bytes[18] * 4 + 21;
  const outdoor = OUTDOOR_TEMPERATURES.indexOf(state.outdoorTemperature ?? 29);
  const indoor = INDOOR_TEMPERATURES.indexOf(state.indoorTemperature ?? 23.5);
  const segments = [2, 0x80, 16, outdoor, 0, 0x80, 32, indoor, 0];
  // The CRC of the receive block is not checked (see protocol.js): any two bytes.
  return Buffer.from([...bytes.slice(0, start + 18), ...segments, 0, 0]).toString('base64');
}

const answer = (status, body = '', headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One adapter. The test may set on it: `down` (nothing answers), `silent`
 * (connected, no answer), `scheme` ('http' | 'https'), `delays` (command ->
 * ms), `statuses` (command -> HTTP status, or { status, body, headers }),
 * `bodies` (command -> raw body), `results` (command -> forced `result`),
 * `applies` (false: a command changes nothing), `full` (no slot left).
 */
export function adapter(over = {}) {
  return {
    scheme: 'https',
    airconId: AIRCON_ID,
    state: decodeStat(golden.frames.on_cool.payload),
    registered: new Set(),
    full: false,
    delays: {},
    statuses: {},
    bodies: {},
    results: {},
    expires: 0,
    ...over,
  };
}

export function fakeAdapters(byHost = { [HOST]: adapter() }) {
  const server = {
    adapters: byHost,
    /** { scheme, host, port, path, command, body, timeoutMs, at } */
    requests: [],
    commands: (name) => server.requests.filter((r) => r.command === name),
    async transport({ scheme, host, port, path, body, timeoutMs }) {
      const command = path.replace('/beaver/command/', '');
      const parsed = JSON.parse(body);
      server.requests.push({
        scheme,
        host,
        port,
        path,
        command,
        body: parsed,
        timeoutMs,
        at: Date.now(),
      });
      const unit = server.adapters[host];
      if (
        !unit ||
        unit.down ||
        unit.unreachable?.[command] ||
        port !== 51443 ||
        scheme !== unit.scheme
      ) {
        throw new WfracError(ERROR_KINDS.UNREACHABLE, 'Unreachable: ECONNREFUSED');
      }
      const delay = unit.delays[command] ?? unit.delays.all;
      if (unit.silent || (delay ?? 0) >= timeoutMs) {
        await wait(timeoutMs);
        throw new WfracError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout');
      }
      if (delay) {
        await wait(delay);
      }
      const forced = unit.statuses[command];
      if (forced) {
        return typeof forced === 'object'
          ? answer(forced.status, forced.body ?? 'error', forced.headers)
          : answer(forced, 'error');
      }
      if (Object.hasOwn(unit.bodies, command)) {
        return answer(200, unit.bodies[command]);
      }
      const stat = () => ({
        airconId: unit.airconId,
        airconStat: render(unit.state),
        logStat: 0,
        updatedBy: 'local',
        expires: unit.expires,
        firmType: 'WF-RAC-HTTPS',
        wireless: { firmVer: '025' },
        mcu: { firmVer: '200' },
        numOfAccount: unit.registered.size,
      });
      const result = (normal) => unit.results[command] ?? normal;
      switch (command) {
        case 'getDeviceInfo':
          return answer(200, {
            command,
            apiVer: '1.0',
            result: 0,
            contents: { airconId: unit.airconId, macAddress: unit.airconId, apMode: 0 },
          });
        case 'getAirconStat':
          return answer(200, { command, apiVer: '1.0', result: result(0), contents: stat() });
        case 'setAirconStat': {
          if (!unit.registered.has(parsed.operatorId)) {
            return answer(200, { command, apiVer: '1.0', result: 2, contents: stat() });
          }
          const code = result(0);
          if (code === 0 && unit.applies !== false) {
            const next = decodeStat(parsed.contents.airconStat);
            unit.state = {
              ...next,
              indoorTemperature: unit.state.indoorTemperature,
              outdoorTemperature: unit.state.outdoorTemperature,
            };
            unit.expires = Math.round(Date.now() / 1000) + 60;
          }
          return answer(200, { command, apiVer: '1.0', result: code, contents: stat() });
        }
        case 'updateAccountInfo': {
          const id = parsed.contents.accountId;
          if (!unit.registered.has(id) && (unit.full || unit.registered.size >= 4)) {
            return answer(200, { command, apiVer: '1.0', result: 2, contents: {} });
          }
          unit.registered.add(id);
          return answer(200, { command, apiVer: '1.0', result: result(0), contents: {} });
        }
        default:
          return answer(400, { result: 2 });
      }
    },
  };
  return server;
}

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
