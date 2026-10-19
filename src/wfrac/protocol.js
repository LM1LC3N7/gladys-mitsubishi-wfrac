// -----------------------------------------------------------------------------
// The `airconStat` frame of the WF-RAC adapter, decoded and encoded (pure).
// Ported from pywfrac 0.1.10 (parser.py, utils.py, capabilities.py; MIT) and
// checked against its own output (test/fixtures/golden.json).
//
// A frame is base64 of two blocks, each followed by a CRC16-CCITT
// (little-endian; computed on what we send, the bridge checks it):
//   COMMAND block: 18-byte state, segment count, 4-byte segments, CRC
//   RECEIVE block: 18-byte state, segment count, 4-byte segments, CRC
// The RECEIVE block is what the unit is; its segments carry the indoor and
// outdoor temperatures. A command is a full state block: every field travels
// with its set-bit, so a frame built on an old state would revert what
// changed since (the app reads the state again right before each command).
//
// The input comes from the network: the length is bounded, every index is
// checked, and a field whose bits match no known value is undefined (never
// guessed), so that a command is refused rather than decided on a guess.
// -----------------------------------------------------------------------------

import { LIMITS, WF_MODE } from '../constants.js';
import { ERROR_KINDS, WfracError } from './http.js';

/** Outdoor thermistor table, raw byte -> °C (pywfrac utils.outdoorTempList). */
export const OUTDOOR_TEMPERATURES = [
  -50.0, -50.0, -50.0, -50.0, -50.0, -48.9, -46.0, -44.0, -42.0, -41.0, -39.0, -38.0, -37.0, -36.0,
  -35.0, -34.0, -33.0, -32.0, -31.0, -30.0, -29.0, -28.5, -28.0, -27.0, -26.0, -25.5, -25.0, -24.0,
  -23.5, -23.0, -22.5, -22.0, -21.5, -21.0, -20.5, -20.0, -19.5, -19.0, -18.5, -18.0, -17.5, -17.0,
  -16.5, -16.0, -15.5, -15.0, -14.6, -14.3, -14.0, -13.5, -13.0, -12.6, -12.3, -12.0, -11.5, -11.0,
  -10.6, -10.3, -10.0, -9.6, -9.3, -9.0, -8.6, -8.3, -8.0, -7.6, -7.3, -7.0, -6.6, -6.3, -6.0, -5.6,
  -5.3, -5.0, -4.6, -4.3, -4.0, -3.7, -3.5, -3.2, -3.0, -2.6, -2.3, -2.0, -1.7, -1.5, -1.2, -1.0,
  -0.6, -0.3, 0.0, 0.2, 0.5, 0.7, 1.0, 1.3, 1.6, 2.0, 2.2, 2.5, 2.7, 3.0, 3.2, 3.5, 3.7, 4.0, 4.2,
  4.5, 4.7, 5.0, 5.2, 5.5, 5.7, 6.0, 6.2, 6.5, 6.7, 7.0, 7.2, 7.5, 7.7, 8.0, 8.2, 8.5, 8.7, 9.0,
  9.2, 9.5, 9.7, 10.0, 10.2, 10.5, 10.7, 11.0, 11.2, 11.5, 11.7, 12.0, 12.2, 12.5, 12.7, 13.0, 13.2,
  13.5, 13.7, 14.0, 14.2, 14.4, 14.6, 14.8, 15.0, 15.2, 15.5, 15.7, 16.0, 16.2, 16.5, 16.7, 17.0,
  17.2, 17.5, 17.7, 18.0, 18.2, 18.5, 18.7, 19.0, 19.2, 19.4, 19.6, 19.8, 20.0, 20.2, 20.5, 20.7,
  21.0, 21.2, 21.5, 21.7, 22.0, 22.2, 22.5, 22.7, 23.0, 23.2, 23.5, 23.7, 24.0, 24.2, 24.5, 24.7,
  25.0, 25.2, 25.5, 25.7, 26.0, 26.2, 26.5, 26.7, 27.0, 27.2, 27.5, 27.7, 28.0, 28.2, 28.5, 28.7,
  29.0, 29.2, 29.5, 29.7, 30.0, 30.2, 30.5, 30.7, 31.0, 31.3, 31.6, 32.0, 32.2, 32.5, 32.7, 33.0,
  33.2, 33.5, 33.7, 34.0, 34.3, 34.6, 35.0, 35.2, 35.5, 35.7, 36.0, 36.3, 36.6, 37.0, 37.2, 37.5,
  37.7, 38.0, 38.3, 38.6, 39.0, 39.3, 39.6, 40.0, 40.3, 40.6, 41.0, 41.3, 41.6, 42.0, 42.3, 42.6,
  43.0,
];

/** Indoor thermistor table, raw byte -> °C (pywfrac utils.indoorTempList). */
export const INDOOR_TEMPERATURES = [
  -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0, -30.0,
  -30.0, -30.0, -29.0, -28.0, -27.0, -26.0, -25.0, -24.0, -23.0, -22.5, -22.0, -21.0, -20.0, -19.5,
  -19.0, -18.0, -17.5, -17.0, -16.5, -16.0, -15.0, -14.5, -14.0, -13.5, -13.0, -12.5, -12.0, -11.5,
  -11.0, -10.5, -10.0, -9.5, -9.0, -8.6, -8.3, -8.0, -7.5, -7.0, -6.5, -6.0, -5.6, -5.3, -5.0, -4.5,
  -4.0, -3.6, -3.3, -3.0, -2.6, -2.3, -2.0, -1.6, -1.3, -1.0, -0.5, 0.0, 0.3, 0.6, 1.0, 1.3, 1.6,
  2.0, 2.3, 2.6, 3.0, 3.2, 3.5, 3.7, 4.0, 4.3, 4.6, 5.0, 5.3, 5.6, 6.0, 6.3, 6.6, 7.0, 7.2, 7.5,
  7.7, 8.0, 8.3, 8.6, 9.0, 9.2, 9.5, 9.7, 10.0, 10.3, 10.6, 11.0, 11.2, 11.5, 11.7, 12.0, 12.3,
  12.6, 13.0, 13.2, 13.5, 13.7, 14.0, 14.2, 14.5, 14.7, 15.0, 15.3, 15.6, 16.0, 16.2, 16.5, 16.7,
  17.0, 17.2, 17.5, 17.7, 18.0, 18.2, 18.5, 18.7, 19.0, 19.2, 19.5, 19.7, 20.0, 20.2, 20.5, 20.7,
  21.0, 21.2, 21.5, 21.7, 22.0, 22.2, 22.5, 22.7, 23.0, 23.2, 23.5, 23.7, 24.0, 24.2, 24.5, 24.7,
  25.0, 25.2, 25.5, 25.7, 26.0, 26.2, 26.5, 26.7, 27.0, 27.2, 27.5, 27.7, 28.0, 28.2, 28.5, 28.7,
  29.0, 29.2, 29.5, 29.7, 30.0, 30.2, 30.5, 30.7, 31.0, 31.3, 31.6, 32.0, 32.2, 32.5, 32.7, 33.0,
  33.2, 33.5, 33.7, 34.0, 34.2, 34.5, 34.7, 35.0, 35.3, 35.6, 36.0, 36.2, 36.5, 36.7, 37.0, 37.2,
  37.5, 37.7, 38.0, 38.3, 38.6, 39.0, 39.2, 39.5, 39.7, 40.0, 40.3, 40.6, 41.0, 41.2, 41.5, 41.7,
  42.0, 42.3, 42.6, 43.0, 43.2, 43.5, 43.7, 44.0, 44.3, 44.6, 45.0, 45.3, 45.6, 46.0, 46.2, 46.5,
  46.7, 47.0, 47.3, 47.6, 48.0, 48.3, 48.6, 49.0, 49.3, 49.6, 50.0, 50.3, 50.6, 51.0, 51.3, 51.6,
  52.0,
];

/** Segment count 1 + segment code 0xFF: "no variable data" (the official app's trailer). */
const NOTHING_TO_SEND = [1, 255, 255, 255, 255];

/** Command (write) masks, keyed by the WF-RAC values (pywfrac CMD_*_MASKS). */
const CMD_MODE = new Map([
  [0, 32],
  [1, 40],
  [2, 48],
  [3, 44],
  [4, 36],
]);
const CMD_AIRFLOW = new Map([
  [0, 15],
  [1, 8],
  [2, 9],
  [3, 10],
  [4, 14],
]);
/** WindDirectionUD -> [byte 2 mask, byte 3 mask]. */
const CMD_WIND_UD = new Map([
  [0, [192, 128]],
  [1, [128, 128]],
  [2, [128, 144]],
  [3, [128, 160]],
  [4, [128, 176]],
]);
/** WindDirectionLR -> [byte 12 mask, byte 11 mask]. */
const CMD_WIND_LR = new Map([
  [0, [3, 16]],
  [1, [2, 16]],
  [2, [2, 17]],
  [3, [2, 18]],
  [4, [2, 19]],
  [5, [2, 20]],
  [6, [2, 21]],
  [7, [2, 22]],
]);
/** Receive (read) masks (pywfrac RCV_*_MASKS). */
const RCV_MODE = new Map([
  [0, 0],
  [1, 8],
  [2, 16],
  [3, 12],
  [4, 4],
]);
const RCV_AIRFLOW = new Map([
  [0, 7],
  [1, 0],
  [2, 1],
  [3, 2],
  [4, 6],
]);

/** value -> key of a Map, else undefined. */
const keyOf = (map, value) => {
  for (const [key, mask] of map) {
    if (mask === value) {
      return key;
    }
  }
  return undefined;
};

const protocolError = (message) => new WfracError(ERROR_KINDS.PROTOCOL, message);

/** CRC16-CCITT (polynomial 0x1021, initial 0xFFFF, no reflection), as pywfrac. */
export function crc16(bytes) {
  let crc = 0xffff;
  for (const value of bytes) {
    const byte = value & 0xff;
    for (let bit = 0; bit < 8; bit += 1) {
      let xor = ((byte >> (7 - bit)) & 1) === 1;
      if (((crc >> 15) & 1) === 1) {
        xor = !xor;
      }
      crc = (crc << 1) & 0xffff;
      if (xor) {
        crc ^= 0x1021;
      }
    }
  }
  return crc;
}

const withCrc = (bytes) => {
  const crc = crc16(bytes);
  return [...bytes, crc & 0xff, (crc >> 8) & 0xff];
};

/**
 * The capabilities a frame tells (pywfrac capabilities.py): only the setpoint
 * ranges are used. ModelNrRaw 3 (ZT 2025) has the wider "range 2".
 */
export const hasRange2 = (modelNrRaw) => modelNrRaw === 3;

/**
 * Lowest and highest setpoint (°C) a mode accepts (pywfrac
 * ModelCapabilities.setpoint_range): 18-30, cooling from 16; range-2 models
 * heat from 10 and cool or dry up to 33. Fan only has no setpoint of its own:
 * the union of the regulating modes.
 */
export function setpointRange(mode, modelNrRaw) {
  const range2 = hasRange2(modelNrRaw);
  const of = (m) => {
    let low = m === WF_MODE.COOL ? 16 : 18;
    let high = 30;
    if (range2) {
      if (m === WF_MODE.HEAT) {
        low = 10;
      } else if (m === WF_MODE.COOL || m === WF_MODE.DRY || m === WF_MODE.AUTO) {
        low = 16;
      }
      if (m === WF_MODE.COOL || m === WF_MODE.DRY) {
        high = 33;
      }
    }
    return [low, high];
  };
  if (mode === WF_MODE.FAN || mode === undefined) {
    const ranges = [WF_MODE.AUTO, WF_MODE.COOL, WF_MODE.HEAT, WF_MODE.DRY].map(of);
    return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))];
  }
  return of(mode);
}

/** The widest range of a model (the bounds of the setpoint feature). */
export const modelRange = (modelNrRaw) => setpointRange(undefined, modelNrRaw);

/**
 * Decode an `airconStat` (base64) into the state of the unit. Throws a
 * PROTOCOL WfracError for anything that is not a well-formed frame (length,
 * base64, segment counts within the frame).
 */
export function decodeStat(input) {
  if (typeof input !== 'string' || input.length < 8 || input.length > LIMITS.frameChars) {
    throw protocolError('No usable airconStat');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input) || input.length % 4 !== 0) {
    throw protocolError('airconStat is not base64');
  }
  const data = [...Buffer.from(input, 'base64')];
  if (data.length < 19) {
    throw protocolError('airconStat too short');
  }
  const start = data[18] * 4 + 21;
  if (data.length < start + 19 + 2) {
    throw protocolError('airconStat too short');
  }
  const count = data[start + 18];
  const end = start + 19 + count * 4;
  if (count > LIMITS.segments || data.length < end + 2) {
    throw protocolError('airconStat segments out of bounds');
  }
  // The CRC of the receive block is not checked: the adapters' own does not
  // match a CRC16 of the block as the app computes it (pywfrac does not check
  // it either); the bounds above and the strict field decoding stand instead.
  const block = data.slice(start, end);
  const state = decodeState(block.slice(0, 18));
  for (let i = 19; i + 3 < block.length; i += 4) {
    const [tag, sub, value] = [block[i], block[i + 1], block[i + 2]];
    if (tag === 0x80 && sub === 16) {
      state.outdoorTemperature = OUTDOOR_TEMPERATURES[value];
    } else if (tag === 0x80 && sub === 32) {
      state.indoorTemperature = INDOOR_TEMPERATURES[value];
    }
  }
  return state;
}

/** The 18-byte state block of the receive half (pywfrac _parse_basic_settings). */
export function decodeState(content) {
  const b = (i) => content[i] & 0xff;
  const modeBits = b(2) & 60;
  const fanBits = b(3) & 15;
  const udBits = b(3) & 240;
  const modelNrRaw = b(0) & 127;
  const modelNr = modelNrRaw === 3 ? 2 : [0, 1, 2].includes(modelNrRaw) ? modelNrRaw : -1;
  const code = b(6) & 127;
  const setpointByte = b(4);
  let windLR;
  if ((b(12) & 3) === 1) {
    windLR = 0;
  } else {
    const position = b(11) & 31;
    windLR = position <= 6 ? position + 1 : undefined;
  }
  return {
    operation: (b(2) & 3) === 1,
    mode: keyOf(RCV_MODE, modeBits),
    airFlow: keyOf(RCV_AIRFLOW, fanBits),
    windUD:
      (b(2) & 192) === 64
        ? 0
        : [0, 16, 32, 48].includes(udBits)
          ? [0, 16, 32, 48].indexOf(udBits) + 1
          : undefined,
    windLR,
    presetTemp: setpointByte < 128 ? setpointByte / 2 : undefined,
    entrust: (b(12) & 12) === 4,
    coolHotJudge: (b(8) & 8) === 0,
    modelNrRaw,
    modelNr,
    vacant: (b(10) & 1) !== 0,
    compressorRunning: (b(9) & 2) !== 0,
    selfClean: modelNr === 1 || modelNr === 2 ? (b(15) & 1) !== 0 : false,
    errorCode: b(6) & 0x80 ? `M${String(code).padStart(2, '0')}` : code === 0 ? '00' : `E${code}`,
    indoorTemperature: undefined,
    outdoorTemperature: undefined,
  };
}

/** The fields a command frame needs from the state; a missing one refuses the command. */
export const FRAME_FIELDS = ['mode', 'airFlow', 'windUD', 'windLR', 'presetTemp'];

/** The command half: every field with its set-bit (pywfrac command_to_byte). */
function commandBlock(s) {
  const out = [0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  out[2] |= s.operation ? 3 : 2;
  out[2] |= CMD_MODE.get(s.mode);
  out[3] |= CMD_AIRFLOW.get(s.airFlow);
  const [ud2, ud3] = CMD_WIND_UD.get(s.windUD);
  out[2] |= ud2;
  out[3] |= ud3;
  const [lr12, lr11] = CMD_WIND_LR.get(s.windLR);
  out[12] |= lr12;
  out[11] |= lr11;
  out[4] |= Math.trunc(s.presetTemp / 0.5) + 128;
  // Byte 5 stays 0xFF: the unit uses its own room sensor.
  out[12] |= s.entrust ? 12 : 8;
  if (!s.coolHotJudge) {
    out[8] |= 8;
  }
  if (s.modelNr === 1) {
    out[10] |= s.vacant ? 1 : 0;
  }
  if (s.modelNr === 1 || s.modelNr === 2) {
    // Self-clean reset never sent; self-clean operation echoed as read.
    out[12] |= s.selfClean ? 144 : 128;
  }
  return out;
}

/** The receive half the official app sends along (pywfrac receive_to_bytes). */
function receiveBlock(s) {
  const out = [0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  if (s.operation) {
    out[2] |= 1;
  }
  out[2] |= RCV_MODE.get(s.mode);
  out[3] |= RCV_AIRFLOW.get(s.airFlow);
  if (s.windUD === 0) {
    out[2] |= 64;
  } else if (s.windUD >= 2 && s.windUD <= 4) {
    out[3] |= (s.windUD - 1) * 16;
  }
  if (s.windLR === 0) {
    out[12] |= 1;
  } else if (s.windLR >= 1 && s.windLR <= 7) {
    out[11] |= s.windLR - 1;
  }
  out[4] |= Math.trunc(s.presetTemp / 0.5);
  if (s.entrust) {
    out[12] |= 4;
  }
  if (!s.coolHotJudge) {
    out[8] |= 8;
  }
  out[0] |=
    Number.isInteger(s.modelNrRaw) && s.modelNrRaw >= 0 && s.modelNrRaw <= 127 ? s.modelNrRaw : 0;
  if (s.modelNr === 1) {
    out[10] |= s.vacant ? 1 : 0;
  }
  if (s.modelNr === 1 || s.modelNr === 2) {
    out[12] |= s.selfClean ? 144 : 128;
  }
  return out;
}

/**
 * The frame of a command: the state just read, with `change` applied
 * ({ operation }, { mode }, { presetTemp }, { airFlow }, { windUD }).
 * Throws when the state lacks a field the frame carries, or a value has no
 * encoding: nothing is guessed.
 */
export function encodeCommand(state, change = {}) {
  const s = { ...state, ...change };
  for (const field of FRAME_FIELDS) {
    if (s[field] === undefined) {
      throw protocolError(`The state has no ${field}`);
    }
  }
  if (
    typeof s.operation !== 'boolean' ||
    !CMD_MODE.has(s.mode) ||
    !CMD_AIRFLOW.has(s.airFlow) ||
    !CMD_WIND_UD.has(s.windUD) ||
    !CMD_WIND_LR.has(s.windLR) ||
    !Number.isFinite(s.presetTemp) ||
    s.presetTemp < 0 ||
    s.presetTemp > 63.5 ||
    !Number.isInteger(s.presetTemp * 2)
  ) {
    throw protocolError('A value has no encoding');
  }
  const command = withCrc([...commandBlock(s), ...NOTHING_TO_SEND]);
  const receive = withCrc([...receiveBlock(s), ...NOTHING_TO_SEND]);
  return Buffer.from([...command, ...receive]).toString('base64');
}
