// -----------------------------------------------------------------------------
// The integration: the WF-RAC adapters typed in the configuration (their IP
// addresses), one read of each adapter every poll interval, one Gladys device
// per adapter and its states, the transport badges, the "Test the connection"
// and "Register Gladys on the adapters" buttons, and the commands (on/off,
// mode, setpoint, fan speed, vertical vane), refused unless the configuration
// allows them. index.js only wires the SDK handlers.
//
// Registration: writing needs our operator id in the adapter's account table
// (four slots, never freed on their own; reading needs nothing). One operator
// id per installation, kept in /data; registered only while the commands are
// allowed, once per adapter, then at most once an hour after a refusal, and
// never without the id safely kept (a new id at every start would take a new
// slot every time). A full table is never retried on its own.
//
// The commands follow the rules learnt on the previous modules:
//   - decided on a fresh read of the unit only, never on the state kept in
//     memory, and refused when a value the frame carries is missing;
//   - the "Allow the commands" option is checked on arrival and again right
//     before sending;
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s;
//   - a command that may have reached the adapter (silence, a 5xx, a broken
//     answer) is never answered "not sent": "sent, without confirmation",
//     then spaced reads of the unit;
//   - the ack never waits for a publication to Gladys;
//   - one command at a time per adapter, one request at a time to it; never
//     retried.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import {
  FEATURES,
  LIMITS,
  NOT_REGISTERED_CODE,
  REFUSED_CODES,
  SECOND,
  TIMINGS,
  WF_MODE,
  WRITE_REFUSED_CODES,
} from './constants.js';
import {
  alreadySo,
  buildDevice,
  commandValue,
  deviceStates,
  modeName,
  parseDeviceId,
  parseFeatureId,
  unitIds,
  unitKey,
} from './devices.js';
import { ERRORS, MODE_NAMES, T, age, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, newIds, normalizeMemory, serializeMemory } from './store.js';
import { Gate, WfracClient, errorReason } from './wfrac/client.js';
import { ERROR_KINDS } from './wfrac/http.js';
import { FRAME_FIELDS, encodeCommand, setpointRange } from './wfrac/protocol.js';

const both = (en, fr) => ({ en, fr });
const join = (...texts) => both(texts.map((t) => t.en).join(' '), texts.map((t) => t.fr).join(' '));

/** The time zone the adapter is told at registration (it keeps it per account). */
export function systemTimezone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && /^[A-Za-z0-9_+\-/]{1,40}$/.test(zone) ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** An adapter as nothing was read yet. */
const freshUnit = (address) => ({
  address,
  key: addressKey(address),
  /** The airconId of the adapter (from getDeviceInfo), kept across failures. */
  airconId: undefined,
  /** Whether getDeviceInfo was read since the adapter last failed (another one may answer). */
  verified: false,
  scheme: undefined,
  /** The last state read (protocol.js decodeStat), and what came with it. */
  state: undefined,
  firmType: undefined,
  firmware: undefined,
  online: undefined,
  failures: 0,
  wait: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

export class WfracApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'mitsubishi-wfrac' }),
    transport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
    timezone = systemTimezone(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.timezone = timezone;
    /** The ids sent to the adapters; `idsKept`: safely in /data (else no registration). */
    this.identity = newIds();
    this.idsKept = false;
    this.client = new WfracClient({ transport, now, timers, identity: () => this.identity });
    this.discoveryGate = new Gate({ now, timers });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** addressKey -> unit */
    this.units = new Map();
    this.generation = 0;
    this.started = false;
    this.lifecycle = Promise.resolve();
    this.idsLoaded = false;
    this.idsCorrupt = false;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastTestAt = -Infinity;
    this.lastRegisterAt = -Infinity;
    /** unit key -> the command in flight (one at a time per adapter). */
    this.inFlight = new Map();
    /** `${unit key}:${field}` -> { from, expected, moved, until }: sent, not seen yet. */
    this.guards = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * Starts, connections and configuration changes run one after the other:
   * the SDK hands every message over without waiting for the previous one,
   * and two starts at once would leave two read chains behind.
   */
  serialized(fn) {
    const run = this.lifecycle.then(fn, fn);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  start(raw = {}) {
    return this.serialized(() => this.doStart(raw));
  }

  async doStart(raw) {
    this.stop();
    await Promise.all([...this.units.values()].map((u) => u.running));
    this.config = normalizeConfig(raw);
    this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
    if (!this.idsLoaded) {
      await this.loadIds();
    }
    this.units = new Map(this.config.addresses.map((a) => [addressKey(a), freshUnit(a)]));
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    await this.publishAll();
    // The first reads run on their own: an adapter slow to answer never holds the start.
    for (const unit of this.units.values()) {
      this.tick(unit).catch(() => this.logger.error('WF-RAC refresh failed'));
    }
  }

  /**
   * The ids of /data/wfrac-ids.json (a file of their own, written once). Only
   * a missing file (ENOENT) is a first start: new ids are written. A file that
   * cannot be read or holds no valid ids is set aside (.corrupt) and no new
   * ids are made: they would take another of the adapter's four slots. The
   * status says so; the "Register" button makes new ids on demand.
   */
  async loadIds() {
    let loaded;
    try {
      loaded = await this.store.loadIds();
    } catch (err) {
      loaded = { status: 'corrupt', reason: err.code ?? 'error' };
    }
    if (loaded.status === 'ok') {
      this.identity = loaded.ids;
      this.idsKept = true;
      this.idsCorrupt = false;
      this.idsLoaded = true;
      return;
    }
    if (loaded.status === 'corrupt') {
      this.idsKept = false;
      this.idsCorrupt = true;
      this.idsLoaded = true;
      this.logger.warn(
        `The identifier file in /data is unreadable (${loaded.reason}): set aside, no registration on the adapters`,
      );
      return;
    }
    await this.writeNewIds();
  }

  async writeNewIds() {
    const ids = newIds();
    try {
      await this.store.saveIds(ids);
      this.identity = ids;
      this.idsKept = true;
      this.idsCorrupt = false;
      this.idsLoaded = true;
      return true;
    } catch (err) {
      this.idsKept = false;
      this.logger.warn(
        `Cannot keep the integration identifier in /data (${err.code ?? err.message}): no registration on the adapters`,
      );
      return false;
    }
  }

  stop() {
    this.generation += 1;
    for (const unit of this.units.values()) {
      this.clearTimer(unit);
      for (const handle of unit.followUps) {
        this.timers.clearTimeout(handle);
      }
      unit.followUps.clear();
    }
    this.publisher.stop();
  }

  clearTimer(unit) {
    if (unit.timer) {
      this.timers.clearTimeout(unit.timer);
      unit.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badges) and the last states. The pauses and registrations stay.
   */
  connected(raw = {}) {
    return this.serialized(() => this.doConnected(raw));
  }

  async doConnected(raw) {
    if (!this.started) {
      this.started = true;
      await this.doStart(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.doStart(raw);
      return;
    }
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.publishAll();
  }

  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      next.pollInterval !== this.config.pollInterval ||
      JSON.stringify(next.addresses) !== JSON.stringify(this.config.addresses)
    );
  }

  /** New addresses or interval restart; the option and the language apply at once. */
  configUpdated(raw = {}) {
    return this.serialized(() => this.doConfigUpdated(raw));
  }

  async doConfigUpdated(raw) {
    if (this.needsRestart(raw)) {
      await this.doStart(raw);
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`WF-RAC commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
      if (this.config.allowCommands) {
        // Registration now, rather than at the next read.
        for (const unit of this.units.values()) {
          this.client
            .channel(unit.address)
            .gate.run(() => this.maybeRegister(unit))
            .then(() => this.updateStatus())
            .catch((err) => this.logger.warn(`Registration failed: ${errorReason(err)}`));
        }
      }
    }
    if (this.config.language !== previous.language || previous.invalid !== this.config.invalid) {
      await this.publishAll();
    } else {
      await this.updateStatus();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** Saves the memory; resolves false when /data refused it. */
  async saveMemory() {
    // Bounded: entries of adapters no longer configured go first.
    const current = new Set(
      [...this.units.values()].filter((u) => u.airconId).map((u) => unitKey(u.airconId)),
    );
    for (const key of [...this.memory.adapters.keys()]) {
      if (this.memory.adapters.size <= LIMITS.adapters * 2) {
        break;
      }
      if (!current.has(key)) {
        this.memory.adapters.delete(key);
      }
    }
    const addresses = new Set(this.units.keys());
    for (const key of [...this.memory.addresses.keys()]) {
      if (this.memory.addresses.size <= LIMITS.adapters * 2) {
        break;
      }
      if (!addresses.has(key)) {
        this.memory.addresses.delete(key);
      }
    }
    try {
      await this.store.save(serializeMemory(this.memory));
      return true;
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err.code ?? err.message}`);
      return false;
    }
  }

  addressMemory(unit) {
    let entry = this.memory.addresses.get(unit.key);
    if (!entry) {
      entry = { scheme: undefined, pausedUntil: 0 };
      this.memory.addresses.set(unit.key, entry);
    }
    return entry;
  }

  registration(airconId) {
    return (
      this.memory.adapters.get(unitKey(airconId)) ?? {
        registered: false,
        full: false,
        attemptAt: 0,
      }
    );
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  pausedUntil(unit) {
    return this.memory.addresses.get(unit.key)?.pausedUntil ?? 0;
  }

  paused(unit) {
    return this.now() < this.pausedUntil(unit);
  }

  /** The next read: after the pause (never sooner than the interval), after a backoff, else the interval. */
  schedule(unit) {
    this.clearTimer(unit);
    if (!this.current(unit)) {
      return;
    }
    const wait = this.paused(unit)
      ? Math.max(this.pausedUntil(unit) - this.now(), this.interval)
      : unit.online === false
        ? unit.wait
        : this.interval;
    const generation = this.generation;
    const delay = Math.max(0, wait ?? this.interval);
    unit.nextAt = this.now() + delay;
    unit.timer = this.timers.setTimeout(() => {
      unit.timer = undefined;
      if (generation === this.generation && this.current(unit)) {
        this.tick(unit).catch(() => this.logger.error('WF-RAC refresh failed'));
      }
    }, delay);
  }

  /** Whether a unit is still one of the configuration (a restart replaces them all). */
  current(unit) {
    return this.units.get(unit.key) === unit;
  }

  /** One read at a time per adapter: a tick during a read joins it. */
  tick(unit) {
    if (!this.current(unit)) {
      return Promise.resolve();
    }
    if (!unit.running) {
      unit.running = this.run(unit).finally(() => {
        unit.running = undefined;
      });
    }
    return unit.running;
  }

  async run(unit) {
    const generation = this.generation;
    if (!this.current(unit) || unit.duplicateOf) {
      return;
    }
    if (this.paused(unit)) {
      await this.updateStatus();
      this.schedule(unit);
      return;
    }
    try {
      await this.read(unit, generation);
      if (unit.duplicateOf) {
        await this.updateStatus();
        return;
      }
      if (generation === this.generation) {
        await this.client.channel(unit.address).gate.run(() => this.maybeRegister(unit));
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(unit, err);
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(unit);
    }
  }

  /** getDeviceInfo when not verified (finding the scheme), then getAirconStat. */
  async read(unit, generation) {
    const memory = this.addressMemory(unit);
    if (!unit.verified) {
      // HTTPS first: the ids travel in plain text over HTTP (getDeviceInfo
      // carries placeholder ids anyway, see client.js).
      const known = memory.scheme ?? unit.scheme;
      const schemes = known ? [known, known === 'http' ? 'https' : 'http'] : ['https', 'http'];
      // One discovery at a time across the adapters: the same adapter typed
      // under two addresses is found before both read it.
      const { scheme, airconId } = await this.discoveryGate.run(() =>
        this.client.discover(unit.address, schemes),
      );
      if (generation !== this.generation || !this.current(unit)) {
        return;
      }
      const owner = [...this.units.values()].find(
        (u) => u !== unit && u.airconId && unitKey(u.airconId) === unitKey(airconId),
      );
      if (owner) {
        // The same adapter under another address: read once, through the first.
        unit.duplicateOf = owner.key;
        this.logger.warn(`WF-RAC ${unit.key}: same adapter as ${owner.key}, not read twice`);
        return;
      }
      if (unit.airconId && unitKey(unit.airconId) !== unitKey(airconId)) {
        // Another adapter answers at this address: what was read of the first is dropped.
        this.logger.warn(`WF-RAC ${unit.key}: another adapter answers at this address`);
        unit.state = undefined;
      }
      unit.airconId = airconId;
      unit.scheme = scheme;
      unit.verified = true;
      if (memory.scheme !== scheme) {
        memory.scheme = scheme;
        await this.saveMemory();
      }
    }
    const read = await this.client.stat(unit.address, unit.scheme, unit.airconId);
    if (generation !== this.generation) {
      return;
    }
    this.applyRead(unit, read);
    unit.online = true;
    unit.failures = 0;
    unit.wait = undefined;
  }

  applyRead(unit, read) {
    unit.state = read.state;
    unit.firmType = read.firmType ?? unit.firmType;
    unit.firmware = read.firmware ?? unit.firmware;
    unit.numOfAccount = read.numOfAccount ?? unit.numOfAccount;
    if (!read.state.verified && unit.unverified !== true) {
      // Logged when it starts: shown, but no command is decided on such a frame.
      this.logger.warn(`WF-RAC ${unit.key}: frame CRC does not match (crc), commands refused`);
    }
    unit.unverified = !read.state.verified;
    this.observe(unit);
  }

  async failed(unit, err) {
    const reason = errorReason(err);
    unit.verified = false;
    if (err.kind === ERROR_KINDS.RATE_LIMITED) {
      await this.pause(unit, err);
      this.logger.warn(`WF-RAC ${unit.key}: ${reason}, pause`);
      return;
    }
    // Never read again sooner than the interval.
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(unit.failures, TIMINGS.backoff.length - 1)],
    );
    unit.failures += 1;
    unit.online = false;
    unit.wait = wait;
    this.logger.warn(`WF-RAC ${unit.key}: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  /**
   * A 429: every path waits (polling, buttons, commands), kept in /data. The
   * pause holds in memory at once; the save runs in the background (an ack
   * never waits for /data).
   */
  pause(unit, err) {
    const wait = Math.min(
      TIMINGS.rateLimitMax,
      Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
    );
    const memory = this.addressMemory(unit);
    memory.pausedUntil = Math.max(memory.pausedUntil, this.now() + wait);
    this.saveMemory().catch(() => {});
  }

  // --- Registration ------------------------------------------------------------

  /**
   * Registers our operator id on an adapter, inside its gate (one request at a
   * time): only while the commands are allowed, with the ids safely kept, when
   * not registered nor found full, at most once an hour. The attempt is
   * persisted before the request: a crash or a restart never repeats it sooner.
   * `force` (the button): the hour and a full table do not stop it.
   */
  async maybeRegister(unit, { force = false } = {}) {
    if (
      !this.config.allowCommands ||
      !this.idsKept ||
      !unit.airconId ||
      !unit.scheme ||
      this.paused(unit)
    ) {
      return undefined;
    }
    const key = unitKey(unit.airconId);
    const record = { ...this.registration(unit.airconId) };
    if (
      !force &&
      (record.registered || record.full || this.now() - record.attemptAt < TIMINGS.registerRetry)
    ) {
      return undefined;
    }
    record.attemptAt = this.now();
    this.memory.adapters.set(key, record);
    if (!(await this.saveMemory())) {
      return undefined;
    }
    let result;
    try {
      result = await this.client.register(unit.address, unit.scheme, unit.airconId, this.timezone, {
        held: true,
      });
    } catch (err) {
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        await this.pause(unit, err);
      }
      this.logger.warn(`WF-RAC ${unit.key}: registration failed (${errorReason(err)})`);
      return { error: errorReason(err) };
    }
    record.registered = result === 0;
    // Result 2 is also the adapter's catch-all refusal: "full" only when the
    // last read counted four accounts (then never retried on its own).
    record.full = result === NOT_REGISTERED_CODE && unit.numOfAccount === 4;
    this.memory.adapters.set(key, record);
    await this.saveMemory();
    if (record.registered) {
      this.logger.info(`WF-RAC ${unit.key}: Gladys registered on the adapter`);
    } else if (record.full) {
      this.logger.warn(`WF-RAC ${unit.key}: the account table of the adapter is full`);
    } else {
      this.logger.warn(`WF-RAC ${unit.key}: registration refused (result ${result})`);
    }
    return { result, full: record.full };
  }

  /** The "Register Gladys on the adapters" button. */
  async registerAll() {
    if (!this.config.allowCommands) {
      return T.register.disabled;
    }
    if (this.now() - this.lastRegisterAt < TIMINGS.registerCooldown) {
      return T.register.cooldown;
    }
    this.lastRegisterAt = this.now();
    const notes = [];
    if (this.idsCorrupt) {
      // The user asks for it: new ids (the slot of the old ones stays taken).
      if (!(await this.writeNewIds())) {
        return T.noIds;
      }
      notes.push(T.register.newIds);
    }
    if (!this.idsKept) {
      return T.noIds;
    }
    const units = [...this.units.values()].filter((u) => u.airconId && u.scheme);
    if (units.length === 0) {
      return T.register.none;
    }
    const lines = await Promise.all(
      units.map(async (unit) => {
        const name = this.nameOf(unit);
        if (this.paused(unit)) {
          return ERRORS.paused(age(this.pausedUntil(unit) - this.now()));
        }
        const outcome = await this.client
          .channel(unit.address)
          .gate.run(() => this.maybeRegister(unit, { force: true }))
          .catch((err) => ({ error: errorReason(err) }));
        if (outcome?.result === 0) {
          return T.register.ok(name);
        }
        if (outcome?.full) {
          return T.register.full(name);
        }
        return T.register.failed(
          name,
          outcome?.error ?? (outcome ? `result ${outcome.result}` : 'error'),
        );
      }),
    );
    await this.updateStatus();
    return join(...notes, ...lines);
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((d) => d?.external_id === externalId);
  }

  unitOf(key) {
    return [...this.units.values()].find((u) => u.airconId && unitKey(u.airconId) === key);
  }

  nameOf(unit) {
    const created = unit.airconId
      ? this.createdDevice(unitIds(this.gladys, unit.airconId).device)
      : undefined;
    return typeof created?.name === 'string' && created.name !== ''
      ? `${created.name.slice(0, 60)} (${unit.key})`
      : unit.key;
  }

  /** Whether the state of a unit is current (it answered at the last read, its id checked). */
  live(unit) {
    return Boolean(unit?.online === true && unit.verified && unit.airconId && unit.state);
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const devices = [...this.units.values()]
      .filter((u) => u.airconId && u.state)
      .map((unit) =>
        buildDevice(this.gladys, unit, {
          language: this.config.language,
          created: this.createdDevice(unitIds(this.gladys, unit.airconId).device),
        }),
      );
    if (devices.length === 0) {
      return;
    }
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    for (const unit of this.units.values()) {
      if (!this.live(unit)) {
        continue;
      }
      const ids = unitIds(this.gladys, unit.airconId);
      for (const { device_feature_external_id: id, ...value } of deviceStates(
        ids,
        unit.state,
        this.config.language,
      )) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    }
  }

  /** Our created devices, with the unit that reads them (if any). */
  ourDevices() {
    const list = [];
    for (const device of this.gladys.devices ?? []) {
      const key = parseDeviceId(device?.external_id);
      if (key && unitIds(this.gladys, key).device === device.external_id) {
        list.push({ device, unit: this.unitOf(key) });
      }
    }
    return list;
  }

  async publishBadge() {
    const entries = [];
    const reading = [...this.units.values()].some((u) => u.online === undefined);
    for (const { device, unit } of this.ourDevices()) {
      if (!unit && reading) {
        continue;
      }
      const local = this.live(unit) || (unit && this.paused(unit) && unit.state);
      if (unit && unit.online === undefined && !local) {
        continue;
      }
      entries.push({
        external_id: device.external_id,
        transport: local ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  async updateStatus() {
    const [connected, message] = this.status();
    await this.setStatus(connected, message);
  }

  /** The connection status of the configuration screen. */
  status() {
    const notes = [];
    if (this.config.invalid) {
      notes.push(T.invalid(this.config.invalid));
    }
    if (this.config.dropped > 0) {
      notes.push(T.dropped(this.config.dropped));
    }
    const units = [...this.units.values()];
    if (units.length === 0) {
      return [false, join(T.noAddress, ...notes)];
    }
    const counted = units.filter((u) => !u.duplicateOf);
    const paused = counted.filter((u) => this.paused(u));
    const down = counted.filter((u) => u.online === false && !this.paused(u));
    const up = counted.filter((u) => u.online === true);
    if (paused.length > 0) {
      notes.unshift(T.rateLimited(paused.map((u) => this.nameOf(u)).join(', ')));
    }
    if (down.length > 0) {
      notes.unshift(T.unreachable(down.map((u) => this.nameOf(u)).join(', ')));
    }
    const duplicates = units.filter((u) => u.duplicateOf);
    if (duplicates.length > 0) {
      notes.push(T.duplicate(duplicates.map((u) => `${u.key} = ${u.duplicateOf}`).join(', ')));
    }
    if (this.idsCorrupt) {
      notes.push(T.idsCorrupt);
    } else if (this.config.allowCommands && !this.idsKept) {
      notes.push(T.noIds);
    }
    if (this.config.allowCommands) {
      const full = up.filter((u) => this.registration(u.airconId).full);
      if (full.length > 0) {
        notes.push(T.tableFull(full.map((u) => this.nameOf(u)).join(', ')));
      }
    }
    if (up.length === 0) {
      if (down.length === 0 && paused.length === 0) {
        return [false, join(T.connecting, ...notes)];
      }
      return [false, join(...notes)];
    }
    return [true, join(T.connected(up.length, counted.length), ...notes)];
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the devices of the last reads, sent again. */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button --------------------------------------------------

  async testConnection() {
    if (this.units.size === 0) {
      return this.status()[1];
    }
    if (this.now() - this.lastTestAt < TIMINGS.testCooldown) {
      return join(T.test.cooldown, this.status()[1]);
    }
    this.lastTestAt = this.now();
    // A read of every adapter now (a read in progress is joined; a paused one
    // is not read). An adapter that failed keeps its delay: never read sooner.
    const waiting = [];
    const reads = Promise.all(
      [...this.units.values()].map((unit) => {
        if (unit.online === false && unit.nextAt > this.now()) {
          waiting.push(T.test.waiting(this.nameOf(unit), age(unit.nextAt - this.now())));
          return undefined;
        }
        return this.tick(unit);
      }),
    );
    // The answer within the button's time (90 s), even behind slow adapters.
    let timer;
    await Promise.race([
      reads,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(resolve, TIMINGS.testAnswerBy);
      }),
    ]);
    this.timers.clearTimeout(timer);
    return join(this.status()[1], ...waiting);
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target) {
      throw this.refusal(ERRORS.readOnly);
    }
    const change = commandValue(target.key, value);
    if (change === undefined) {
      throw this.refusal(
        [FEATURES.INDOOR, FEATURES.OUTDOOR, FEATURES.ERROR].includes(target.key)
          ? ERRORS.readOnly
          : ERRORS.badValue,
      );
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (this.inFlight.has(target.unit)) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const promise = this.command(target, change, received);
    this.inFlight.set(target.unit, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(target.unit) === promise) {
        this.inFlight.delete(target.unit);
      }
    }
  }

  /** The checks before sending, on the latest configuration and state of the unit. */
  checkBeforeSend(generation, target) {
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    const unit = this.unitOf(target.unit);
    if (unit && this.paused(unit)) {
      throw this.refusal(ERRORS.paused(age(this.pausedUntil(unit) - this.now())));
    }
    if (generation !== this.generation || !this.live(unit) || !unit.scheme) {
      throw this.refusal(ERRORS.unknownUnit);
    }
    if (!this.idsKept) {
      throw this.refusal(ERRORS.noIds);
    }
    if (this.registration(unit.airconId).full) {
      throw this.refusal(ERRORS.tableFull);
    }
    return unit;
  }

  async command(target, change, received) {
    const generation = this.generation;
    const sendBy = received + TIMINGS.commandSendBy;
    const readBy = sendBy - TIMINGS.commandReadEndMargin;
    const unit = this.checkBeforeSend(generation, target);
    if (readBy - this.now() < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }
    // One session holds the adapter from the fresh read to the end of the
    // command: no other request runs in between. Still waiting when the read
    // could no longer finish in time (a slow poll in flight): refused unsent.
    try {
      return await this.client.session(
        unit.address,
        () =>
          this.commandSession(target, change, {
            generation,
            unit,
            received,
            sendBy,
            readBy,
          }),
        { startBy: readBy - TIMINGS.commandMinRead },
      );
    } catch (err) {
      if (err.kind === ERROR_KINDS.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      throw err;
    }
  }

  /** The command inside its session (the gate is held: requests pass `held`). */
  async commandSession(target, change, { generation, unit, received, sendBy, readBy }) {
    // The state just before acting, never the one in memory.
    let fresh;
    try {
      fresh = await this.client.stat(unit.address, unit.scheme, unit.airconId, {
        deadline: readBy,
        held: true,
        minMs: TIMINGS.commandMinRead,
        // A command is decided only on result 0 with its airconId.
        strict: true,
      });
    } catch (err) {
      if (err.kind === ERROR_KINDS.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        this.pause(unit, err);
        this.updateStatus().catch(() => {});
      }
      throw this.refusal(ERRORS.unknownState(errorReason(err)));
    }
    if (generation !== this.generation || this.unitOf(target.unit) !== unit) {
      throw this.refusal(ERRORS.unknownUnit);
    }
    this.applyRead(unit, fresh);
    // Shown in the background: the ack never waits for Gladys.
    this.publishAll().catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));

    const state = fresh.state;
    if (!state.verified) {
      throw this.refusal(ERRORS.unverified);
    }
    if (FRAME_FIELDS.some((field) => state[field] === undefined)) {
      throw this.refusal(ERRORS.incompleteState);
    }
    // A previous command on another field, not visible yet: the frame built
    // on this read would undo it. Refused; never merged with the memory.
    for (const [key, guard] of this.guards) {
      const field = key.slice(target.unit.length + 1);
      if (
        key.startsWith(`${target.unit}:`) &&
        !Object.hasOwn(change, field) &&
        this.guardActive(key) &&
        !guard.moved &&
        state[field] === guard.from
      ) {
        throw this.refusal(ERRORS.previousPending);
      }
    }
    if (change.presetTemp !== undefined) {
      this.checkSetpoint(unit, state, change.presetTemp);
    }
    if (change.mode !== undefined && change.mode !== state.mode) {
      // The setpoint as read may lie outside the range of the new mode: it is
      // brought into that range (and the feature's bounds), and sent with it.
      const [min, max] = this.setpointBounds(unit, change.mode, state.modelNrRaw);
      const presetTemp = Math.min(max, Math.max(min, state.presetTemp));
      if (presetTemp !== state.presetTemp) {
        change = { ...change, presetTemp };
      }
    }
    const fields = Object.keys(change);
    const guarded = fields.some((field) => this.guardActive(`${target.unit}:${field}`));
    if (alreadySo(state, change) && !guarded) {
      // Already so: nothing sent (the adapter takes its 60 s write lock on every write).
      return;
    }
    let frame;
    try {
      frame = encodeCommand(state, change);
    } catch {
      throw this.refusal(ERRORS.incompleteState);
    }
    // The option may have been turned off during the read: checked again.
    this.checkBeforeSend(generation, target);
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    const plans = fields.map((field) => [
      `${target.unit}:${field}`,
      { from: state[field], expected: change[field] },
    ]);
    this.logger.info(`WF-RAC ${unit.key}: ${target.key} -> ${JSON.stringify(change)}`);
    let answer;
    try {
      answer = await this.client.setStat(unit.address, unit.scheme, unit.airconId, frame, {
        startBy: sendBy,
        answerBy: received + TIMINGS.commandAnswerBy,
        held: true,
        // The very last check, right before the transport: option, unit, pause, registration.
        beforeSend: () => this.checkBeforeSend(generation, target),
      });
    } catch (err) {
      if (err.beforeSend) {
        throw err;
      }
      const reason = errorReason(err);
      this.logger.warn(`WF-RAC ${unit.key}: ${target.key} failed (${reason})`);
      if (err.kind === ERROR_KINDS.LATE) {
        throw this.refusal(ERRORS.tooSlow);
      }
      if (err.kind === ERROR_KINDS.UNREACHABLE || err.notSent) {
        // Nothing accepted the connection, or the error came before the transport.
        throw this.refusal(ERRORS.notSent(reason));
      }
      if (err.kind === ERROR_KINDS.RATE_LIMITED) {
        this.pause(unit, err);
        this.updateStatus().catch(() => {});
        throw this.refusal(ERRORS.refused(reason));
      }
      if (err.kind === ERROR_KINDS.HTTP && err.status < 500) {
        this.followUp(unit);
        throw this.refusal(ERRORS.refused(reason));
      }
      // A 5xx, a silence, a broken answer or any other error after the
      // transport started: it may have reached the adapter.
      this.guard(plans);
      this.followUp(unit);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    const { result } = answer;
    if (result === 0) {
      this.markRegistered(unit);
      this.guard(plans);
      this.followUp(unit);
      return;
    }
    if (WRITE_REFUSED_CODES.has(result)) {
      this.followUp(unit);
      throw this.refusal(ERRORS.locked);
    }
    if (result === NOT_REGISTERED_CODE) {
      this.markNotRegistered(unit);
      throw this.refusal(ERRORS.notRegistered);
    }
    if (REFUSED_CODES.has(result)) {
      this.followUp(unit);
      throw this.refusal(ERRORS.refused(`result ${result}`));
    }
    // 99, an unknown code or no code: it may have been applied.
    this.guard(plans);
    this.followUp(unit);
    throw this.refusal(
      ERRORS.sentUnconfirmed(result === undefined ? 'no result' : `result ${result}`),
    );
  }

  /**
   * The setpoint against the range of the mode just read (the model's own
   * table), within the bounds of the created feature too.
   */
  checkSetpoint(unit, state, value) {
    const [min, max] = this.setpointBounds(unit, state.mode, state.modelNrRaw);
    if (value < min || value > max) {
      const name = modeName(state.mode);
      throw this.refusal(
        ERRORS.outOfRange(
          min,
          max,
          state.mode === WF_MODE.FAN || name === undefined ? undefined : MODE_NAMES[name],
        ),
      );
    }
  }

  /**
   * The range of a mode (fan only: the union of the regulating modes, the
   * setpoint applying to the next one), within the created feature's bounds.
   */
  setpointBounds(unit, mode, modelNrRaw) {
    let [min, max] = setpointRange(mode, modelNrRaw);
    const ids = unitIds(this.gladys, unit.airconId);
    const feature = this.createdDevice(ids.device)?.features?.find(
      (f) => f?.external_id === ids.feature(FEATURES.SETPOINT),
    );
    if (Number.isFinite(feature?.min) && Number.isFinite(feature?.max)) {
      min = Math.max(min, feature.min);
      max = Math.min(max, feature.max);
    }
    return [min, max];
  }

  markRegistered(unit) {
    const record = this.registration(unit.airconId);
    if (!record.registered || record.full) {
      this.memory.adapters.set(unitKey(unit.airconId), {
        ...record,
        registered: true,
        full: false,
      });
      this.saveMemory().catch(() => {});
    }
  }

  /** In memory at once; saved in the background (the ack never waits for /data). */
  markNotRegistered(unit) {
    const record = this.registration(unit.airconId);
    this.memory.adapters.set(unitKey(unit.airconId), { ...record, registered: false });
    this.saveMemory().catch(() => {});
  }

  /**
   * Spaced reads of the unit after a command: its effect, then a check. None
   * while the unit is offline or paused: its backoff stands.
   */
  followUp(unit) {
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        unit.followUps.delete(handle);
        if (
          generation === this.generation &&
          this.current(unit) &&
          unit.online !== false &&
          !this.paused(unit)
        ) {
          this.tick(unit).catch(() => this.logger.error('WF-RAC refresh failed'));
        }
      }, delay);
      unit.followUps.add(handle);
    }
  }

  // --- Guards ----------------------------------------------------------------

  /**
   * After a command that may have been applied, until the unit shows it: a new
   * command is always sent, never answered "already so" on a state that may
   * not show the previous one yet. The start state is kept: a read equal to it
   * lifts nothing until a move was seen.
   */
  guard(plans) {
    for (const [key, plan] of plans) {
      this.guards.set(key, { ...plan, moved: false, until: this.now() + TIMINGS.guard });
    }
  }

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /** A read of a unit, through its guards: never lifted on an unknown value. */
  observe(unit) {
    if (!unit.airconId || !unit.state) {
      return;
    }
    const prefix = `${unitKey(unit.airconId)}:`;
    for (const key of [...this.guards.keys()]) {
      if (!key.startsWith(prefix) || !this.guardActive(key)) {
        continue;
      }
      const value = unit.state[key.slice(prefix.length)];
      if (value === undefined) {
        continue;
      }
      const guard = this.guards.get(key);
      if (value !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && value === guard.expected) {
        this.guards.delete(key);
      }
    }
  }
}
