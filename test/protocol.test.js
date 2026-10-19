// -----------------------------------------------------------------------------
// The frame codec against pywfrac's own output (test/fixtures/golden.json,
// made by test/fixtures/generate.py from the library's live captures), and
// against hostile input.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INDOOR_TEMPERATURES,
  OUTDOOR_TEMPERATURES,
  crc16,
  decodeStat,
  encodeCommand,
  modelRange,
  setpointRange,
} from '../src/wfrac/protocol.js';
import { ERROR_KINDS } from '../src/wfrac/http.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/golden.json', import.meta.url), 'utf8'));
const frames = Object.entries(golden.frames);

const CHANGES = {
  power_off: { operation: false },
  power_on: { operation: true },
  mode_heat: { mode: 2 },
  mode_auto: { mode: 0 },
  setpoint_22_5: { presetTemp: 22.5 },
  fan_high: { airFlow: 4 },
  fan_auto: { airFlow: 0 },
  swing_ud_auto: { windUD: 0 },
  swing_ud_3: { windUD: 3 },
};

test('the tables are the 256 entries of pywfrac', () => {
  assert.equal(OUTDOOR_TEMPERATURES.length, 256);
  assert.equal(INDOOR_TEMPERATURES.length, 256);
  assert.equal(OUTDOOR_TEMPERATURES[100], 2.7);
  assert.equal(INDOOR_TEMPERATURES[50], -7.5);
});

test('CRC16-CCITT (0x1021, init 0xFFFF): the check value of "123456789"', () => {
  assert.equal(crc16([...Buffer.from('123456789')]), 0x29b1);
});

for (const [name, frame] of frames) {
  test(`decode ${name} as pywfrac does`, () => {
    const state = decodeStat(frame.payload);
    const f = frame.fields;
    assert.equal(state.operation, f.operation);
    assert.equal(state.mode, f.mode);
    assert.equal(state.airFlow, f.airFlow);
    assert.equal(state.windUD, f.windUD);
    assert.equal(state.windLR, f.windLR);
    assert.equal(state.presetTemp, f.presetTemp);
    assert.equal(state.entrust, f.entrust);
    assert.equal(state.coolHotJudge, f.coolHotJudge);
    assert.equal(state.modelNr, f.modelNr);
    assert.equal(state.modelNrRaw, f.modelNrRaw);
    assert.equal(state.vacant, f.vacant);
    assert.equal(state.selfClean, f.selfClean);
    assert.equal(state.indoorTemperature, f.indoorTemp);
    assert.equal(state.outdoorTemperature, f.outdoorTemp);
    assert.equal(state.errorCode, f.errorCode);
    assert.equal(state.compressorRunning, f.compressorRunning);
  });

  test(`encode the commands of ${name} byte for byte as pywfrac`, () => {
    const state = decodeStat(frame.payload);
    for (const [change, expected] of Object.entries(frame.commands)) {
      assert.equal(encodeCommand(state, CHANGES[change]), expected, change);
    }
  });
}

test('a command frame decodes back to the state it carries', () => {
  const state = decodeStat(golden.frames.on_cool.payload);
  const frame = encodeCommand(state, { presetTemp: 24.5, airFlow: 2 });
  const back = decodeStat(frame);
  assert.equal(back.presetTemp, 24.5);
  assert.equal(back.airFlow, 2);
  assert.equal(back.mode, state.mode);
  assert.equal(back.operation, true);
});

test('hostile frames are refused, never guessed', () => {
  const valid = golden.frames.on_cool.payload;
  const bytes = [...Buffer.from(valid, 'base64')];
  const bad = [
    undefined,
    null,
    42,
    '',
    'AAAA',
    'not base64!!',
    'A'.repeat(4096),
    Buffer.from(bytes.slice(0, 30)).toString('base64'),
    // Receive segment count pointing past the end.
    Buffer.from([...bytes.slice(0, 43), 9, ...bytes.slice(44)]).toString('base64'),
    // Too many segments.
    Buffer.from([...bytes.slice(0, 43), 200, ...bytes.slice(44)]).toString('base64'),
    // Command segment count pointing past the end.
    Buffer.from([...bytes.slice(0, 18), 200, ...bytes.slice(19)]).toString('base64'),
  ];
  for (const input of bad) {
    assert.throws(
      () => decodeStat(input),
      (err) => err.kind === ERROR_KINDS.PROTOCOL,
      String(input).slice(0, 20),
    );
  }
});

test('an unknown mode or fan nibble is unknown, and a command on it is refused', () => {
  const bytes = [...Buffer.from(golden.frames.on_cool.payload, 'base64')];
  const start = bytes[18] * 4 + 21;
  const count = bytes[start + 18];
  const end = start + 19 + count * 4;
  const block = bytes.slice(start, end);
  block[2] = (block[2] & ~60) | 0x14; // no such mode
  block[3] = (block[3] & ~15) | 0x0b; // no such fan step
  const crc = crc16(block);
  const frame = Buffer.from([...bytes.slice(0, start), ...block, crc & 0xff, crc >> 8]).toString(
    'base64',
  );
  const state = decodeStat(frame);
  assert.equal(state.mode, undefined);
  assert.equal(state.airFlow, undefined);
  assert.throws(() => encodeCommand(state, { operation: false }), /no mode/);
  assert.throws(() => encodeCommand({ ...state, mode: 1, airFlow: 0 }, { presetTemp: 22.3 }));
  assert.throws(() => encodeCommand({ ...state, mode: 1, airFlow: 0 }, { mode: 9 }));
});

test('setpoint ranges per mode, as pywfrac ModelCapabilities.setpoint_range', () => {
  assert.deepEqual(setpointRange(1, 1), [16, 30]);
  assert.deepEqual(setpointRange(2, 1), [18, 30]);
  assert.deepEqual(setpointRange(0, 1), [18, 30]);
  assert.deepEqual(setpointRange(3, 1), [16, 30]);
  assert.deepEqual(setpointRange(2, 3), [10, 30]);
  assert.deepEqual(setpointRange(1, 3), [16, 33]);
  assert.deepEqual(setpointRange(4, 3), [16, 33]);
  assert.deepEqual(modelRange(1), [16, 30]);
  assert.deepEqual(modelRange(3), [10, 33]);
});
