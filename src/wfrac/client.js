// -----------------------------------------------------------------------------
// The WF-RAC local API: the four commands this integration uses, ported from
// pywfrac 0.1.10 (repository.py, MIT). Requests to one adapter go one at a
// time, 1 s apart at least (the adapter takes one connection at a time),
// commands first in the queue. Reads are never retried here (the app spaces
// its new tries); a command is never retried at all (it may have reached the
// adapter: sending it twice is not ours to decide).
//
// The answers come from the network: only own fields of plain objects are
// read, each with its exact type. A missing or mistyped value is undefined.
// The operator and device ids travel in every request (the adapter checks
// writes against them): they are never logged, nor any answer.
// -----------------------------------------------------------------------------

import { API_VERSION, COMMANDS, LIMITS, PATH_PREFIX, TIMINGS } from '../constants.js';
import { ERROR_KINDS, WfracError, request as httpRequest } from './http.js';
import { decodeStat } from './protocol.js';

const isObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** A short text from the adapter, without control characters. */
export function text(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean === '' ? undefined : clean.slice(0, LIMITS.textLength);
}

/** The airconId of the adapter (MAC-derived, e.g. "348e89c5a137"), else undefined. */
export const airconIdOf = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9]{4,40}$/.test(value) ? value : undefined;

/** Retry-After (seconds or an HTTP date) in ms, else undefined. */
export function retryAfterOf(header, now = Date.now()) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  if (/^\s*\d+\s*$/.test(value)) {
    return Number(value) * 1000;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The reason of an error for a log or a message: its kind, status or result, never the answer. */
export function errorReason(err) {
  if (err?.kind === ERROR_KINDS.HTTP || err?.kind === ERROR_KINDS.RATE_LIMITED) {
    return `HTTP ${err.status}`;
  }
  if (err?.kind === ERROR_KINDS.REFUSED) {
    return `result ${err.result}`;
  }
  return err?.kind ?? 'error';
}

const late = () => new WfracError(ERROR_KINDS.LATE, 'Too late to send');

/** The ids getDeviceInfo carries (see `call`). */
export const PROBE_IDS = Object.freeze({ operatorId: 'gladys-probe', deviceId: 'gladys-probe' });

/**
 * One job at a time; `first` jumps the queue (commands), never the job in
 * flight. `startBy`: a job still waiting at that time leaves the queue and is
 * rejected LATE (nothing was sent).
 */
export class Gate {
  constructor({ now = Date.now, timers = globalThis } = {}) {
    this.now = now;
    this.timers = timers;
    this.queue = [];
    this.busy = false;
  }

  run(fn, { first = false, startBy } = {}) {
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, startBy, timer: undefined };
      if (startBy !== undefined) {
        job.timer = this.timers.setTimeout(
          () => {
            const index = this.queue.indexOf(job);
            if (index !== -1) {
              this.queue.splice(index, 1);
              reject(late());
            }
          },
          Math.max(0, startBy - this.now()),
        );
      }
      if (first) {
        this.queue.unshift(job);
      } else {
        this.queue.push(job);
      }
      this.next();
    });
  }

  next() {
    if (this.busy || this.queue.length === 0) {
      return;
    }
    this.busy = true;
    const job = this.queue.shift();
    if (job.timer) {
      this.timers.clearTimeout(job.timer);
    }
    Promise.resolve()
      .then(() => {
        if (job.startBy !== undefined && this.now() > job.startBy) {
          throw late();
        }
        return job.fn();
      })
      .then(job.resolve, job.reject)
      .finally(() => {
        this.busy = false;
        this.next();
      });
  }
}

/** The error of a non-2xx answer. */
function statusError(response, now) {
  if (response.status === 429) {
    return new WfracError(ERROR_KINDS.RATE_LIMITED, 'HTTP 429', {
      status: 429,
      retryAfter: retryAfterOf(response.headers?.['retry-after'], now),
    });
  }
  return new WfracError(ERROR_KINDS.HTTP, `HTTP ${response.status}`, { status: response.status });
}

/** A 2xx answer: `{ result, contents }` (own fields only). */
function parseAnswer(response) {
  let data;
  try {
    data = JSON.parse(response.body);
  } catch {
    throw new WfracError(ERROR_KINDS.PROTOCOL, 'Not JSON');
  }
  if (!isObject(data)) {
    throw new WfracError(ERROR_KINDS.PROTOCOL, 'Not a JSON object');
  }
  const result = own(data, 'result');
  return {
    result: Number.isInteger(result) ? result : undefined,
    contents: isObject(own(data, 'contents')) ? own(data, 'contents') : undefined,
  };
}

export class WfracClient {
  /**
   * @param {{ transport?: Function, now?: () => number, timers?: object,
   *   identity: () => { operatorId: string, deviceId: string } }} options
   */
  constructor({ transport = httpRequest, now = Date.now, timers = globalThis, identity }) {
    this.transport = transport;
    this.now = now;
    this.timers = timers;
    this.identity = identity;
    /** addressKey -> { gate, nextAt } */
    this.channels = new Map();
  }

  channel({ host, port }) {
    const key = `${host}:${port}`;
    let channel = this.channels.get(key);
    if (!channel) {
      channel = { gate: new Gate({ now: this.now, timers: this.timers }), nextAt: 0 };
      this.channels.set(key, channel);
    }
    return channel;
  }

  /**
   * A command session: holds the adapter's gate from the fresh read to the end
   * of the command, so no other request runs in between. First in the queue;
   * refused LATE when it cannot start by `startBy`. Inside, requests pass `held`.
   */
  session(address, fn, { startBy }) {
    return this.channel(address).gate.run(fn, { first: true, startBy });
  }

  wait(ms) {
    return new Promise((resolve) => this.timers.setTimeout(resolve, ms));
  }

  /**
   * One request. `deadline`: it must start (after the 1 s spacing) by then, or
   * it is refused unsent (LATE); its timeout is what is left, at least `minMs`.
   * `answerBy` replaces the timeout of a command. `beforeSend()` runs right
   * before the transport: what it throws is rethrown marked `notSent`.
   */
  call(
    address,
    {
      scheme,
      command,
      contents,
      timeoutMs = TIMINGS.readTimeout,
      deadline,
      startBy,
      answerBy,
      minMs = 200,
      held = false,
      first = false,
      beforeSend,
    },
  ) {
    const channel = this.channel(address);
    const job = async () => {
      const wait = channel.nextAt - this.now();
      if (wait > 0) {
        await this.wait(wait);
      }
      if (startBy !== undefined && this.now() > startBy) {
        throw late();
      }
      let timeout = timeoutMs;
      if (answerBy !== undefined) {
        timeout = answerBy - this.now();
      } else if (deadline !== undefined) {
        timeout = deadline - this.now();
      }
      if (timeout < minMs) {
        throw late();
      }
      if (beforeSend) {
        try {
          beforeSend();
        } catch (err) {
          throw Object.assign(err, { notSent: true, beforeSend: true });
        }
      }
      // getDeviceInfo is sent while the scheme (and the device answering) is
      // not known yet, plain HTTP included: it carries placeholder ids (the
      // adapter does not evaluate its body), never ours.
      const { operatorId, deviceId } =
        command === COMMANDS.DEVICE_INFO ? PROBE_IDS : this.identity();
      const envelope = {
        apiVer: API_VERSION,
        command,
        deviceId,
        operatorId,
        // The adapter has no clock: it takes its time from this field.
        timestamp: Math.round(this.now() / 1000),
        ...(contents ? { contents } : {}),
      };
      try {
        return await this.transport({
          scheme,
          host: address.host,
          port: address.port,
          path: `${PATH_PREFIX}${command}`,
          body: JSON.stringify(envelope),
          timeoutMs: timeout,
        });
      } finally {
        // Counted from the end of every request, a failed one included.
        channel.nextAt = this.now() + TIMINGS.requestSpacing;
      }
    };
    return held ? job() : channel.gate.run(job, { first, startBy });
  }

  async answer(address, options) {
    const response = await this.call(address, options);
    if (response.status < 200 || response.status > 299) {
      throw statusError(response, this.now());
    }
    return parseAnswer(response);
  }

  /** getDeviceInfo over one scheme -> { airconId }. */
  async deviceInfo(address, scheme, options = {}) {
    const { contents } = await this.answer(address, {
      ...options,
      scheme,
      command: COMMANDS.DEVICE_INFO,
    });
    const airconId = airconIdOf(own(contents, 'airconId'));
    if (!airconId) {
      throw new WfracError(ERROR_KINDS.PROTOCOL, 'No airconId');
    }
    return { airconId };
  }

  /**
   * getDeviceInfo, trying `schemes` in order (the adapter speaks plain HTTP or
   * HTTPS, depending on its firmware) -> { scheme, airconId }. A 429 stops the
   * discovery; any other failure tries the next scheme, 1 s later.
   */
  async discover(address, schemes, options = {}) {
    let first;
    for (const scheme of schemes) {
      try {
        return { scheme, ...(await this.deviceInfo(address, scheme, options)) };
      } catch (err) {
        if (err.kind === ERROR_KINDS.RATE_LIMITED) {
          throw err;
        }
        first ??= err;
      }
    }
    throw first ?? new WfracError(ERROR_KINDS.UNREACHABLE, 'No scheme');
  }

  /**
   * getAirconStat -> { state, expires, firmType, firmware, numOfAccount }.
   * `strict` (the read a command is decided on): result 0 and the airconId
   * of the adapter are required; a poll accepts a frame with another result
   * (shown, never acted on).
   */
  async stat(address, scheme, airconId, { strict = false, ...options } = {}) {
    const { result, contents } = await this.answer(address, {
      ...options,
      scheme,
      command: COMMANDS.GET_STAT,
      contents: { airconId },
    });
    const frame = own(contents, 'airconStat');
    if (typeof frame !== 'string' || (strict && result !== 0)) {
      if (result) {
        // Result 1 here: the adapter had no fresh data from the indoor unit.
        throw new WfracError(ERROR_KINDS.REFUSED, `result ${result}`, { result });
      }
      throw new WfracError(ERROR_KINDS.PROTOCOL, 'No airconStat');
    }
    const answeredId = own(contents, 'airconId');
    if (
      (strict && answeredId === undefined) ||
      (answeredId !== undefined && answeredId !== airconId)
    ) {
      throw new WfracError(ERROR_KINDS.PROTOCOL, 'Another adapter answered');
    }
    const expires = own(contents, 'expires');
    const accounts = own(contents, 'numOfAccount');
    return {
      state: decodeStat(frame),
      expires: Number.isInteger(expires) ? expires : undefined,
      firmType: text(own(contents, 'firmType')),
      firmware: text(own(own(contents, 'wireless'), 'firmVer')),
      numOfAccount:
        Number.isInteger(accounts) && accounts >= 0 && accounts <= 4 ? accounts : undefined,
    };
  }

  /**
   * setAirconStat, never retried -> { result, state } (state undefined when
   * the answer carries none that decodes). A non-2xx answer throws.
   */
  async setStat(address, scheme, airconId, frame, options) {
    const { result, contents } = await this.answer(address, {
      ...options,
      scheme,
      command: COMMANDS.SET_STAT,
      contents: { airconId, airconStat: frame },
    });
    let state;
    try {
      state = decodeStat(own(contents, 'airconStat'));
    } catch {
      state = undefined;
    }
    return { result, state };
  }

  /** updateAccountInfo: registers our operator id -> the `result` code (0: registered). */
  async register(address, scheme, airconId, timezone, options = {}) {
    const { operatorId } = this.identity();
    const { result } = await this.answer(address, {
      ...options,
      scheme,
      command: COMMANDS.REGISTER,
      contents: { accountId: operatorId, airconId, remote: 0, timezone },
    });
    if (result === undefined) {
      throw new WfracError(ERROR_KINDS.PROTOCOL, 'No result');
    }
    return result;
  }
}
