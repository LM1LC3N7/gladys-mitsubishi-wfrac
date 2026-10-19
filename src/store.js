// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), readable by the container user only (0600), in two files:
//   - wfrac-ids.json: `operatorId` and `deviceId`, the ids this installation
//     sends to the adapters. Written once, at the first start (temporary
//     file, fsync, rename). The adapter has four account slots and frees none
//     on its own: new ids would take a new slot at the next registration, so
//     only a missing file (ENOENT) makes new ones. A file that cannot be read
//     or holds no valid ids is set aside as .corrupt and nothing new is made
//     on its own (the app says so; its "Register" button makes new ids).
//   - wfrac-state.json, rewritten as it changes (fsync, rename): per adapter
//     (by airconId) whether our operator id is registered, the table was found
//     full, the time of the last registration attempt (one per hour at most,
//     persisted before the request: never in a loop); per address the scheme
//     that answered (http or https) and the start and end of a 429 pause
//     (6 h at most from its start, capped on that fixed start when read
//     back, and saved once when capped: restarts never move it).
// A set-aside ids file is read again at each start and restored when it
// holds valid ids (a passing read error).
// The ids are not secrets the user typed, but they let a client write to the
// adapters: never logged.
// -----------------------------------------------------------------------------

import { randomBytes, randomUUID } from 'node:crypto';
import { open, readFile, rename } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/wfrac-state.json';
export const IDS_FILE = '/data/wfrac-ids.json';

const OPERATOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEVICE_ID = /^gladys-[0-9a-f]{16}$/;
const AIRCON_ID = /^[a-z0-9]{4,40}$/;
const ADDRESS = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
const SCHEMES = ['http', 'https'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const time = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

/** A file written whole or not at all: temporary file, fsync, rename. */
async function writeDurably(path, text) {
  const temporary = `${path}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

/** The ids of a parsed file, else null. */
export function normalizeIds(raw) {
  const operatorId = own(raw, 'operatorId');
  const deviceId = own(raw, 'deviceId');
  return typeof operatorId === 'string' &&
    OPERATOR_ID.test(operatorId) &&
    typeof deviceId === 'string' &&
    DEVICE_ID.test(deviceId)
    ? { operatorId, deviceId }
    : null;
}

export function fileStore(path = STATE_FILE, idsPath = IDS_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(() => writeDurably(path, text));
      chain = write.catch(() => {});
      return write;
    },
    /** -> { status: 'ok', ids } | { status: 'missing' } | { status: 'corrupt', reason }. */
    async loadIds() {
      let text;
      try {
        text = await readFile(idsPath, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') {
          // A file set aside earlier: read again (a passing read error), and
          // restored when it holds valid ids; else still no new ids.
          let aside;
          try {
            aside = await readFile(`${idsPath}.corrupt`, 'utf8');
          } catch (asideErr) {
            return asideErr.code === 'ENOENT'
              ? { status: 'missing' }
              : { status: 'corrupt', reason: asideErr.code ?? 'unreadable' };
          }
          let restored;
          try {
            restored = normalizeIds(JSON.parse(aside));
          } catch {
            restored = null;
          }
          if (restored) {
            await rename(`${idsPath}.corrupt`, idsPath).catch(() => {});
            return { status: 'ok', ids: restored };
          }
          return { status: 'corrupt', reason: 'set aside earlier' };
        }
        await rename(idsPath, `${idsPath}.corrupt`).catch(() => {});
        return { status: 'corrupt', reason: err.code ?? 'unreadable' };
      }
      let ids;
      try {
        ids = normalizeIds(JSON.parse(text));
      } catch {
        ids = null;
      }
      if (!ids) {
        await rename(idsPath, `${idsPath}.corrupt`).catch(() => {});
        return { status: 'corrupt', reason: 'invalid content' };
      }
      return { status: 'ok', ids };
    },
    async saveIds(ids) {
      await writeDurably(idsPath, JSON.stringify(ids));
    },
  };
}

/**
 * For the tests: the same JSON round trips as the files; `failing` refuses
 * every save; `ids`: the content of the ids file (undefined: no file,
 * 'corrupt': unreadable).
 */
export function memoryStore(initial = null, { failing = false, ids } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    ids,
    saves: 0,
    failing,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failing) {
        throw new Error('EROFS');
      }
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
    async loadIds() {
      if (this.ids === undefined) {
        return { status: 'missing' };
      }
      const valid = normalizeIds(this.ids);
      if (!valid) {
        this.idsSetAside = this.ids;
        return { status: 'corrupt', reason: 'invalid content' };
      }
      return { status: 'ok', ids: valid };
    },
    async saveIds(value) {
      if (this.failing) {
        throw new Error('EROFS');
      }
      this.ids = JSON.parse(JSON.stringify(value));
    },
  };
}

export const newIds = () => ({
  operatorId: randomUUID(),
  deviceId: `gladys-${randomBytes(8).toString('hex')}`,
});

/**
 * The persisted state, repaired and bounded. Only known keys of the expected
 * shape are kept (never an inherited or `__proto__` key).
 */
export function normalizeMemory(raw, now) {
  /** Whether a value was bounded: the caller saves once, so it never moves again. */
  let repaired = false;
  const adapters = new Map();
  const rawAdapters = own(raw, 'adapters');
  if (isObject(rawAdapters)) {
    for (const key of Object.keys(rawAdapters).slice(0, LIMITS.adapters * 4)) {
      const entry = own(rawAdapters, key);
      if (!AIRCON_ID.test(key) || !isObject(entry)) {
        continue;
      }
      const attemptAt = time(own(entry, 'attemptAt'));
      if (attemptAt > now) {
        repaired = true;
      }
      adapters.set(key, {
        registered: own(entry, 'registered') === true,
        full: own(entry, 'full') === true,
        // An attempt "in the future" (a clock set back) counts as now.
        attemptAt: Math.min(attemptAt, now),
      });
    }
  }
  const addresses = new Map();
  const rawAddresses = own(raw, 'addresses');
  if (isObject(rawAddresses)) {
    for (const key of Object.keys(rawAddresses).slice(0, LIMITS.adapters * 4)) {
      const entry = own(rawAddresses, key);
      if (!ADDRESS.test(key) || !isObject(entry)) {
        continue;
      }
      const scheme = own(entry, 'scheme');
      const until = time(own(entry, 'pausedUntil'));
      const at = time(own(entry, 'pausedAt'));
      // A pause lasts 6 h at most from the time it was set: capped on that
      // fixed time, so restarts never move it. Without a valid start (or one
      // "in the future"), it is not one this integration set: dropped.
      let pausedUntil = 0;
      let pausedAt = 0;
      if (until > now && at > 0 && at <= now) {
        pausedAt = at;
        pausedUntil = Math.min(until, at + TIMINGS.rateLimitMax);
      }
      if (until > 0 && pausedUntil !== until && until > now) {
        repaired = true;
      }
      addresses.set(key, {
        scheme: SCHEMES.includes(scheme) ? scheme : undefined,
        pausedUntil: pausedUntil > now ? pausedUntil : 0,
        pausedAt: pausedUntil > now ? pausedAt : 0,
      });
    }
  }
  return { adapters, addresses, repaired };
}

/** The persisted form (plain objects of validated keys only). */
export function serializeMemory(memory) {
  return {
    adapters: Object.fromEntries(
      [...memory.adapters].map(([key, { registered, full, attemptAt }]) => [
        key,
        { registered, full, attemptAt },
      ]),
    ),
    addresses: Object.fromEntries(
      [...memory.addresses].map(([key, { scheme, pausedUntil, pausedAt }]) => [
        key,
        {
          ...(scheme ? { scheme } : {}),
          ...(pausedUntil ? { pausedUntil, pausedAt } : {}),
        },
      ]),
    ),
  };
}
