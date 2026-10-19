// -----------------------------------------------------------------------------
// WF-RAC local API constants, manifest keys, limits and timings.
//
// The WF-RAC Wi-Fi adapter of Mitsubishi Heavy Industries air conditioners
// answers a local API on port 51443 (plain HTTP on the oldest firmware, HTTPS
// with a self-signed certificate and old TLS on the others), as pywfrac
// (MIT, 0.1.10) and its Home Assistant integration read it:
//   POST /beaver/command/getDeviceInfo      the airconId (MAC-derived id)
//   POST /beaver/command/getAirconStat      the state, a base64 frame
//   POST /beaver/command/setAirconStat      a command frame (a full state)
//   POST /beaver/command/updateAccountInfo  registers our operator id (4 slots)
// Every request carries the envelope { apiVer, command, deviceId, operatorId,
// timestamp, contents }. The protocol is not documented by the manufacturer.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 51443;
export const API_VERSION = '1.0';
export const PATH_PREFIX = '/beaver/command/';

export const COMMANDS = {
  DEVICE_INFO: 'getDeviceInfo',
  GET_STAT: 'getAirconStat',
  SET_STAT: 'setAirconStat',
  REGISTER: 'updateAccountInfo',
};

/** The `result` codes of setAirconStat that mean "declined" (write lock of another client, or the unit). */
export const WRITE_REFUSED_CODES = new Set([1, 11, 12]);
/** setAirconStat result 2: our operator id is not registered (or the catch-all refusal). */
export const NOT_REGISTERED_CODE = 2;
/**
 * The other refusals pywfrac knows (10: internal error, 20: firmware update
 * required). 99 (the unit did not confirm within 30 s) and unknown codes may
 * have been applied: "sent, without confirmation".
 */
export const REFUSED_CODES = new Set([10, 20]);

/** Feature keys (the last part of the feature external ids): frozen. */
export const FEATURES = {
  POWER: 'binary',
  MODE: 'mode',
  SETPOINT: 'target-temperature',
  FAN: 'fan-speed',
  SWING: 'swing-vertical',
  INDOOR: 'indoor-temperature',
  OUTDOOR: 'outdoor-temperature',
  ERROR: 'error-code',
};

export const COMMAND_FEATURES = [
  FEATURES.POWER,
  FEATURES.MODE,
  FEATURES.SETPOINT,
  FEATURES.FAN,
  FEATURES.SWING,
];

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
  REGISTER: 'register',
};

/** Gladys core values (server/utils/constants.js; the SDK does not export them). */
export const AC_MODE = { AUTO: 0, COOLING: 1, HEATING: 2, DRYING: 3, FAN: 4 };
export const AC_FAN_SPEED = { AUTO: 0, LOW: 1, MID: 3, HIGH: 5, QUIET: 6 };
export const AC_SWING_VERTICAL = {
  SWING: 1,
  POSITION_1: 2,
  POSITION_2: 3,
  POSITION_3: 4,
  POSITION_4: 5,
};

/** The WF-RAC operation modes (pywfrac OperationMode). */
export const WF_MODE = { AUTO: 0, COOL: 1, HEAT: 2, FAN: 3, DRY: 4 };

/** The poll interval of the configuration, in seconds (Home Assistant: 60 s). */
export const POLL_INTERVAL = {
  min: 30,
  max: 600,
  default: 60,
};

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** An answer of the adapter is about 1 KB. */
  responseBytes: 64 * 1024,
  /** The base64 frame of a state (about 60 characters, more with segments). */
  frameChars: 2048,
  /** Variable segments read from one frame. */
  segments: 64,
  /** Adapters of one installation. */
  adapters: 8,
  /** Longest text kept from an answer (firmware versions, types). */
  textLength: 40,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One read of the polling (pywfrac: 25 s; the adapter is a small board). */
  readTimeout: 20 * SECOND,
  /** The adapter takes one connection at a time, 1 s apart at least (pywfrac, field rule). */
  requestSpacing: SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** HTTP 429: Retry-After bounded to 1 min .. 6 h, 5 min without. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 5 * MINUTE,
  /** The registration of our operator id: one attempt per adapter at most every hour. */
  registerRetry: HOUR,
  /** The "Register" button: at most every 30 s. */
  registerCooldown: 30 * SECOND,
  /** The "Test the connection" button reads the adapters at most this often. */
  testCooldown: 10 * SECOND,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the command
   * must leave by 3.5 s after the click, or the command is refused unsent;
   * the answer is awaited until 4.3 s, after which the command is "sent,
   * without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The fresh read must end 1 s (the spacing) + 0.1 s before the send deadline. */
  commandReadEndMargin: 1_100,
  commandMinRead: 300,
  /** Reads of the state after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until the state shows what it asked, or 90 s. */
  guard: 90 * SECOND,
};
