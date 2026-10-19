// -----------------------------------------------------------------------------
// One WF-RAC adapter (one indoor unit) -> one Gladys device and its states,
// and the change a Gladys command asks for (pure).
//
// `ext:<selector>:wfrac:<airconId>`: keyed by the airconId the adapter gives
// (derived from its MAC address), never by the IP address (it may change) nor
// a name. The feature keys (the last part of their external ids) and the
// option values are published forever: never rename them.
//
// The air-conditioning features of the core, as MELCloud and the other
// climate integrations: on/off (`air-conditioning/binary`, not a switch; a
// voice assistant or bridge that maps it may still reach it with a "turn
// everything off": accepted for an air conditioner, as MELCloud), mode,
// setpoint, fan speed, vertical vane; indoor and outdoor temperatures; the
// error code of the unit as a text. Units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on `air-conditioning` and
// `temperature-sensor`. A device published again never loses a feature: those
// of the device already created in Gladys are kept as they are.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  AC_FAN_SPEED,
  AC_MODE,
  AC_SWING_VERTICAL,
  COMMAND_FEATURES,
  FEATURES,
  WF_MODE,
} from './constants.js';
import {
  DEVICE_NAME,
  ERROR_TEXTS,
  FAN_NAMES,
  FEATURE_NAMES,
  MODE_NAMES,
  SWING_NAMES,
  word,
} from './i18n.js';
import { modelRange } from './wfrac/protocol.js';

/** WF-RAC mode -> [name, Gladys AC_MODE], in display order. */
export const MODES = [
  ['AUTO', WF_MODE.AUTO, AC_MODE.AUTO],
  ['COOL', WF_MODE.COOL, AC_MODE.COOLING],
  ['HEAT', WF_MODE.HEAT, AC_MODE.HEATING],
  ['DRY', WF_MODE.DRY, AC_MODE.DRYING],
  ['FAN', WF_MODE.FAN, AC_MODE.FAN],
];
/** WF-RAC AirFlow (auto plus four steps) -> Gladys AC_FAN_SPEED. */
export const FANS = [
  ['AUTO', 0, AC_FAN_SPEED.AUTO],
  ['QUIET', 1, AC_FAN_SPEED.QUIET],
  ['LOW', 2, AC_FAN_SPEED.LOW],
  ['MEDIUM', 3, AC_FAN_SPEED.MID],
  ['HIGH', 4, AC_FAN_SPEED.HIGH],
];
/** WF-RAC WindDirectionUD (0: swing, 1-4: highest to lowest) -> Gladys AC_SWING_VERTICAL. */
export const SWINGS = [
  ['SWING', 0, AC_SWING_VERTICAL.SWING],
  ['POSITION_1', 1, AC_SWING_VERTICAL.POSITION_1],
  ['POSITION_2', 2, AC_SWING_VERTICAL.POSITION_2],
  ['POSITION_3', 3, AC_SWING_VERTICAL.POSITION_3],
  ['POSITION_4', 4, AC_SWING_VERTICAL.POSITION_4],
];

const toGladys = (table, value) => table.find((row) => row[1] === value)?.[2];
const fromGladys = (table, value) => table.find((row) => row[2] === value)?.[1];
export const modeName = (wfMode) => MODES.find((row) => row[1] === wfMode)?.[0];

const command = (definition) => ({
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...definition,
});
const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const temperature = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -50,
  max: 60,
});

const options = (table, names, language) =>
  table.map(([name, , value], index) => ({
    value,
    label: word(names[name], language),
    sort_order: index,
  }));

/** The features, by key, in display order (the setpoint bounds depend on the model). */
export function definitions(modelNrRaw, language) {
  const [min, max] = modelRange(modelNrRaw);
  return {
    [FEATURES.POWER]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.BINARY,
      min: 0,
      max: 1,
    }),
    [FEATURES.MODE]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.MODE,
      min: AC_MODE.AUTO,
      max: AC_MODE.FAN,
      supported_options: options(MODES, MODE_NAMES, language),
    }),
    [FEATURES.SETPOINT]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.TARGET_TEMPERATURE,
      unit: U.CELSIUS,
      min,
      max,
    }),
    [FEATURES.FAN]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.FAN_SPEED,
      min: AC_FAN_SPEED.AUTO,
      max: AC_FAN_SPEED.QUIET,
      supported_options: options(FANS, FAN_NAMES, language),
    }),
    [FEATURES.SWING]: command({
      category: C.AIR_CONDITIONING,
      type: T.AIR_CONDITIONING.SWING_VERTICAL,
      min: AC_SWING_VERTICAL.SWING,
      max: AC_SWING_VERTICAL.POSITION_4,
      supported_options: options(SWINGS, SWING_NAMES, language),
    }),
    [FEATURES.INDOOR]: temperature,
    [FEATURES.OUTDOOR]: temperature,
    [FEATURES.ERROR]: sensor({
      category: C.TEXT,
      type: T.TEXT.TEXT,
      min: 0,
      max: 0,
      keep_history: false,
    }),
  };
}

export const KEYS = Object.values(FEATURES);

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

/** The id of an adapter in the external ids: its airconId in lower case. */
export const unitKey = (airconId) => String(airconId).toLowerCase();
export const unitIds = (gladys, airconId) => gladys.externalIds('wfrac', unitKey(airconId));

/** The airconId key and the feature key of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = /:wfrac:([a-z0-9]{4,40}):([a-z-]{1,40})$/.exec(externalId);
  return match && KEYS.includes(match[2]) ? { unit: match[1], key: match[2] } : undefined;
}

/** The airconId key of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = /:wfrac:([a-z0-9]{4,40})$/.exec(String(externalId ?? ''));
  return match ? match[1] : undefined;
}

/**
 * The Gladys device of one adapter. `created`: the device already created in
 * Gladys, whose features are kept when the new build lacks them.
 */
export function buildDevice(gladys, unit, { language, created }) {
  const ids = unitIds(gladys, unit.airconId);
  const defs = definitions(unit.state?.modelNrRaw, language);
  const params = [{ name: 'aircon_id', value: unitKey(unit.airconId) }];
  if (unit.firmType) {
    params.push({ name: 'firm_type', value: unit.firmType });
  }
  if (unit.firmware) {
    params.push({ name: 'firmware', value: unit.firmware });
  }
  const built = {
    name: word(DEVICE_NAME(unitKey(unit.airconId).slice(-4).toUpperCase()), language),
    external_id: ids.device,
    model: unit.firmType ? `MHI WF-RAC ${unit.firmType}` : 'MHI WF-RAC',
    should_poll: false,
    features: KEYS.map((key) => ({
      name: word(FEATURE_NAMES[key], language),
      external_id: ids.feature(key),
      ...defs[key],
    })),
    params,
  };
  return keepCreatedFeatures(built, created);
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return { ...built, features: [...built.features, ...kept] };
}

/** The current values of one adapter's device (undefined values are left out). */
export function deviceStates(ids, state, language) {
  const states = [];
  const add = (key, value) => {
    if (value !== undefined && value !== null) {
      states.push({ device_feature_external_id: ids.feature(key), ...value });
    }
  };
  add(FEATURES.POWER, { state: state.operation ? 1 : 0 });
  const mode = toGladys(MODES, state.mode);
  add(FEATURES.MODE, mode === undefined ? undefined : { state: mode });
  add(
    FEATURES.SETPOINT,
    Number.isFinite(state.presetTemp) ? { state: state.presetTemp } : undefined,
  );
  const fan = toGladys(FANS, state.airFlow);
  add(FEATURES.FAN, fan === undefined ? undefined : { state: fan });
  const swing = toGladys(SWINGS, state.windUD);
  add(FEATURES.SWING, swing === undefined ? undefined : { state: swing });
  const temperatureOf = (value) =>
    Number.isFinite(value) && value >= -50 && value <= 60 ? { state: value } : undefined;
  add(FEATURES.INDOOR, temperatureOf(state.indoorTemperature));
  add(FEATURES.OUTDOOR, temperatureOf(state.outdoorTemperature));
  if (typeof state.errorCode === 'string') {
    add(FEATURES.ERROR, {
      text: state.errorCode === '00' ? word(ERROR_TEXTS.none, language) : state.errorCode,
    });
  }
  return states;
}

/** A command value, strictly: a finite number, or a text that is exactly one. */
export function strictNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,3}(?:\.\d{1,3})?$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The value of a command checked on its own (before any read): the WF-RAC
 * field it sets, or undefined when the value is not one the feature takes.
 * The setpoint is rounded to the unit's 0.5 °C step; its range is checked on
 * the state read just before sending (it depends on the mode).
 */
export function commandValue(key, value) {
  if (!COMMAND_FEATURES.includes(key)) {
    return undefined;
  }
  const n = strictNumber(value);
  if (n === undefined) {
    return undefined;
  }
  switch (key) {
    case FEATURES.POWER:
      return n === 0 || n === 1 ? { operation: n === 1 } : undefined;
    case FEATURES.MODE: {
      const mode = fromGladys(MODES, n);
      return mode === undefined ? undefined : { mode };
    }
    case FEATURES.FAN: {
      const airFlow = fromGladys(FANS, n);
      return airFlow === undefined ? undefined : { airFlow };
    }
    case FEATURES.SWING: {
      const windUD = fromGladys(SWINGS, n);
      return windUD === undefined ? undefined : { windUD };
    }
    case FEATURES.SETPOINT:
      return n >= 0 && n <= 60 ? { presetTemp: Math.round(n * 2) / 2 } : undefined;
    default:
      return undefined;
  }
}

/** Whether the state already is what the change asks. */
export function alreadySo(state, change) {
  return Object.entries(change).every(([field, value]) => state[field] === value);
}
