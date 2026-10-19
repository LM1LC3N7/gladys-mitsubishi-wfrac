// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in wfrac-state.json, readable by the container user only (0600):
//   - `operatorId` and `deviceId`: the ids this installation sends to the
//     adapters. The adapter has four account slots and frees none on its own:
//     a new operator id at every start would take a new slot at every
//     registration. Without a file that could be written, nothing registers.
//   - per adapter (by airconId): whether our operator id is registered, the
//     table was found full, and the time of the last registration attempt (one
//     per hour at most, persisted before the request: never in a loop);
//   - per address: the scheme that answered (http or https) and the end of a
//     429 pause, bounded when read back (6 h at most).
// The ids are not secrets the user typed, but they let a client write to the
// adapters: never logged.
// -----------------------------------------------------------------------------

import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/wfrac-state.json';

const OPERATOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEVICE_ID = /^gladys-[0-9a-f]{16}$/;
const AIRCON_ID = /^[a-z0-9]{4,40}$/;
const ADDRESS = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
const SCHEMES = ['http', 'https'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const time = (value, now) =>
  Number.isFinite(value) && value > 0 && value <= now + TIMINGS.rateLimitMax ? value : 0;

export function fileStore(path = STATE_FILE) {
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
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file; `failing` refuses every save. */
export function memoryStore(initial = null, { failing = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
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
  };
}

export const newIds = () => ({
  operatorId: randomUUID(),
  deviceId: `gladys-${randomBytes(8).toString('hex')}`,
});

/**
 * The persisted state, repaired and bounded. Only known keys of the expected
 * shape are kept (never an inherited or `__proto__` key); `ids` is null when
 * the file holds none.
 */
export function normalizeMemory(raw, now) {
  const operatorId = own(raw, 'operatorId');
  const deviceId = own(raw, 'deviceId');
  const ids =
    typeof operatorId === 'string' &&
    OPERATOR_ID.test(operatorId) &&
    typeof deviceId === 'string' &&
    DEVICE_ID.test(deviceId)
      ? { operatorId, deviceId }
      : null;
  const adapters = new Map();
  const rawAdapters = own(raw, 'adapters');
  if (isObject(rawAdapters)) {
    for (const key of Object.keys(rawAdapters).slice(0, LIMITS.adapters * 4)) {
      const entry = own(rawAdapters, key);
      if (!AIRCON_ID.test(key) || !isObject(entry)) {
        continue;
      }
      adapters.set(key, {
        registered: own(entry, 'registered') === true,
        full: own(entry, 'full') === true,
        attemptAt: Math.min(time(own(entry, 'attemptAt'), now), now),
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
      const until = time(own(entry, 'pausedUntil'), now);
      addresses.set(key, {
        scheme: SCHEMES.includes(scheme) ? scheme : undefined,
        pausedUntil: until > now ? until : 0,
      });
    }
  }
  return { ids, adapters, addresses };
}

/** The persisted form (plain objects of validated keys only). */
export function serializeMemory(memory) {
  return {
    ...(memory.ids ?? {}),
    adapters: Object.fromEntries(
      [...memory.adapters].map(([key, { registered, full, attemptAt }]) => [
        key,
        { registered, full, attemptAt },
      ]),
    ),
    addresses: Object.fromEntries(
      [...memory.addresses].map(([key, { scheme, pausedUntil }]) => [
        key,
        { ...(scheme ? { scheme } : {}), ...(pausedUntil ? { pausedUntil } : {}) },
      ]),
    ),
  };
}
