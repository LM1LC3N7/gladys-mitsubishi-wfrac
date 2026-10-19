// -----------------------------------------------------------------------------
// The configuration, the persisted state and the pure device helpers.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { FEATURES, HOUR } from '../src/constants.js';
import {
  commandValue,
  keepCreatedFeatures,
  parseDeviceId,
  parseFeatureId,
  strictNumber,
} from '../src/devices.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileStore, newIds, normalizeIds, normalizeMemory, serializeMemory } from '../src/store.js';

test('addresses: IPv4 or host names, port 51443 unless given, at most 8, duplicates once', () => {
  assert.deepEqual(parseAddress('192.168.1.70'), { host: '192.168.1.70', port: 51443 });
  assert.deepEqual(parseAddress('https://AC-Salon.local:8443/x'), {
    host: 'ac-salon.local',
    port: 8443,
  });
  for (const bad of ['', '999.1.1.1', 'a b', 'user@host', 'host:0', 'host:70000', '-x-']) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  const c = normalizeConfig({
    addresses:
      '192.168.1.70, 192.168.1.70;192.168.1.71\nbad_host!,10.0.0.1 10.0.0.2 10.0.0.3 10.0.0.4 10.0.0.5 10.0.0.6 10.0.0.7',
  });
  assert.equal(c.addresses.length, 8);
  assert.equal(c.dropped, 1);
  assert.match(c.invalid, /host!/);
});

test('the options: commands only on an explicit true, interval bounded', () => {
  assert.equal(normalizeConfig().allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: 'true' }).allowCommands, true);
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: 9999 }).pollInterval, 600);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
  assert.equal(normalizeConfig({ ['__proto__']: { allow_commands: true } }).allowCommands, false);
});

test('the persisted state: validated, bounded, no inherited key', () => {
  const now = Date.UTC(2026, 9, 19);
  const ids = newIds();
  const raw = JSON.parse(
    JSON.stringify({
      ...ids,
      adapters: {
        '348e89c5a137': { registered: true, full: false, attemptAt: now - HOUR },
        BAD_KEY: { registered: true },
      },
      addresses: {
        '192.168.1.70': { scheme: 'https', pausedUntil: now + 100 * HOUR },
        '10.0.0.1': { scheme: 'ftp', pausedUntil: now - 1 },
      },
    }),
  );
  raw.adapters.__proto__ = { registered: true };
  const memory = normalizeMemory(raw, now);
  assert.deepEqual([...memory.adapters.keys()], ['348e89c5a137']);
  assert.equal(memory.adapters.get('348e89c5a137').registered, true);
  // A pause too far in the future is capped to the longest one, never dropped.
  assert.equal(memory.addresses.get('192.168.1.70').pausedUntil, now + 6 * HOUR);
  assert.equal(memory.addresses.get('10.0.0.1').scheme, undefined);
  const again = normalizeMemory(JSON.parse(JSON.stringify(serializeMemory(memory))), now);
  assert.deepEqual([...again.adapters.keys()], ['348e89c5a137']);
  // The ids live in their own file, never in the state.
  assert.equal(serializeMemory(memory).operatorId, undefined);
  assert.deepEqual(normalizeIds(ids), ids);
  assert.equal(normalizeIds({ operatorId: 'x', deviceId: 'y' }), null);
  assert.equal(normalizeIds('garbage'), null);
});

test('the ids file: ENOENT only is a first start; anything else is set aside, no new ids', async (t) => {
  // A folder of the test itself (never the system temp folder), removed after.
  const dir = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), 'tmp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const idsPath = join(dir, 'ids.json');
  const store = fileStore(join(dir, 'state.json'), idsPath);
  assert.deepEqual(await store.loadIds(), { status: 'missing' });
  const ids = newIds();
  await store.saveIds(ids);
  assert.deepEqual(await store.loadIds(), { status: 'ok', ids });
  assert.equal(existsSync(`${idsPath}.tmp`), false);
  // Half written (a power cut): set aside, and still "corrupt" at the next start.
  writeFileSync(idsPath, '{"operatorId":"11111111-2222-4333-8444-5555');
  assert.equal((await store.loadIds()).status, 'corrupt');
  assert.equal(existsSync(`${idsPath}.corrupt`), true);
  assert.equal(existsSync(idsPath), false);
  assert.equal((await store.loadIds()).status, 'corrupt');
  // Unreadable (a directory where the file should be): not a first start either.
  mkdirSync(join(dir, 'odd'));
  const odd = fileStore(join(dir, 'state.json'), join(dir, 'odd'));
  assert.equal((await odd.loadIds()).status, 'corrupt');
  // The state file is written whole (fsync, rename).
  await store.save({ adapters: {} });
  assert.deepEqual(await store.load(), { adapters: {} });
});

test('command values: strict numbers, the option values of the features only', () => {
  assert.equal(strictNumber(''), undefined);
  assert.equal(strictNumber(null), undefined);
  assert.equal(strictNumber('1e3'), undefined);
  assert.equal(strictNumber(' 1'), undefined);
  assert.equal(strictNumber('22.5'), 22.5);
  assert.deepEqual(commandValue(FEATURES.POWER, 1), { operation: true });
  assert.equal(commandValue(FEATURES.POWER, 0.5), undefined);
  assert.deepEqual(commandValue(FEATURES.MODE, 3), { mode: 4 });
  assert.deepEqual(commandValue(FEATURES.MODE, 4), { mode: 3 });
  assert.deepEqual(commandValue(FEATURES.FAN, 6), { airFlow: 1 });
  assert.equal(commandValue(FEATURES.FAN, 7), undefined);
  assert.deepEqual(commandValue(FEATURES.SWING, 1), { windUD: 0 });
  assert.deepEqual(commandValue(FEATURES.SETPOINT, 22.26), { presetTemp: 22.5 });
  assert.equal(commandValue(FEATURES.INDOOR, 20), undefined);
});

test('feature ids parsed strictly', () => {
  assert.deepEqual(parseFeatureId('ext:x:wfrac:348e89c5a137:binary'), {
    unit: '348e89c5a137',
    key: 'binary',
  });
  assert.equal(parseFeatureId('ext:x:wfrac:348e89c5a137:constructor'), undefined);
  assert.equal(parseFeatureId('ext:x:wfrac:__proto__:binary'), undefined);
  assert.equal(parseDeviceId('ext:x:wfrac:348e89c5a137'), '348e89c5a137');
});

test('a created feature the new build lacks is kept', () => {
  const built = { features: [{ external_id: 'a' }] };
  const created = {
    features: [
      { external_id: 'a' },
      { external_id: 'b', name: 'B', category: 'text', type: 'text', id: 'uuid', min: 0 },
    ],
  };
  assert.deepEqual(keepCreatedFeatures(built, created).features, [
    { external_id: 'a' },
    { name: 'B', external_id: 'b', category: 'text', type: 'text', min: 0 },
  ]);
});
