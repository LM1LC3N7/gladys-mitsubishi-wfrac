// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and fake adapters behind the transport. Timers and Date are mocked:
// the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { WfracApp } from '../src/app.js';
import { ACTIONS, HOUR, MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { decodeStat } from '../src/wfrac/protocol.js';
import {
  AIRCON_ID,
  AIRCON_ID2,
  HOST,
  HOST2,
  NOW,
  adapter,
  fakeAdapters,
  settle,
} from './helpers/fakeAdapter.js';

const CONFIG = { addresses: HOST };
const ALLOWED = { addresses: HOST, allow_commands: true };
const device = (id = AIRCON_ID) => `ext:test-integration:wfrac:${id}`;
const feature = (key, id = AIRCON_ID) => `${device(id)}:${key}`;

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

async function setup(
  t,
  {
    config = CONFIG,
    server = fakeAdapters(),
    store = memoryStore(),
    create = true,
    logs = [],
    timers = true,
  } = {},
) {
  if (timers) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  }
  const gladys = createFakeGladys({ config });
  const app = new WfracApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => Date.now(),
    store,
    timezone: 'Europe/Paris',
  });
  registerHandlers(gladys, app);
  const advance = async (ms, step = SECOND) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  const connecting = gladys.connect();
  await settle();
  await advance(5 * SECOND, 500);
  await connecting;
  t.after(() => app.stop());
  if (create) {
    for (const d of [...gladys.fake.discoveredDevices]) {
      await gladys.fake.deviceCreated(d);
    }
    await settle();
  }
  const send = async (key, value, { id = AIRCON_ID, wait = 6 * SECOND } = {}) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device(id));
    const target = d.features.find((f) => f.external_id === feature(key, id));
    const ack = gladys.fake.setValue(d, target, value);
    await settle();
    await advance(wait, 100);
    return ack;
  };
  return { gladys, app, server, store, advance, logs, send };
}

const last = (gladys, key, id) => gladys.fake.lastState(feature(key, id));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const transportOf = (gladys, id = AIRCON_ID) =>
  gladys.fake.transports.filter((x) => x.device_external_id === device(id)).at(-1)?.transport;
const sets = (server) => server.commands('setAirconStat');
const lastFrame = (server) => decodeStat(sets(server).at(-1).body.contents.airconStat);

test('without an address, the status asks for it and nothing is requested', async (t) => {
  const server = fakeAdapters();
  const { gladys } = await setup(t, { config: {}, server });
  assert.equal(server.requests.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /adresse IP/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /IP address/);
  assert.equal(server.requests.length, 0);
});

test('first read: the scheme is found, one request at a time and 1 s apart', async (t) => {
  const server = fakeAdapters();
  const store = memoryStore();
  const { gladys } = await setup(t, { server, store });
  assert.deepEqual(
    server.requests.map((r) => `${r.scheme} ${r.command}`),
    ['http getDeviceInfo', 'https getDeviceInfo', 'https getAirconStat'],
  );
  for (let i = 1; i < server.requests.length; i += 1) {
    assert.ok(server.requests[i].at - server.requests[i - 1].at >= SECOND, 'spacing');
  }
  const envelope = server.requests[2].body;
  assert.equal(envelope.apiVer, '1.0');
  assert.match(envelope.operatorId, /^[0-9a-f-]{36}$/);
  assert.match(envelope.deviceId, /^gladys-[0-9a-f]{16}$/);
  assert.equal(envelope.timestamp, Math.round(NOW / 1000) + 2);
  assert.deepEqual(envelope.contents, { airconId: AIRCON_ID });
  assert.equal(store.data.addresses[HOST].scheme, 'https');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /^Connecté : 1 adaptateur sur 1 répond\./);
});

test('one device per adapter, the air-conditioning features of the core and their states', async (t) => {
  const { gladys } = await setup(t);
  const [d] = gladys.fake.discoveredDevices;
  assert.equal(d.external_id, device());
  assert.equal(d.name, 'Climatiseur Mitsubishi A137');
  assert.equal(d.model, 'MHI WF-RAC WF-RAC-HTTPS');
  assert.deepEqual(
    d.features.map((f) => [
      f.external_id.slice(d.external_id.length + 1),
      f.category,
      f.type,
      f.unit,
      f.read_only,
      f.min,
      f.max,
    ]),
    [
      ['binary', 'air-conditioning', 'binary', undefined, false, 0, 1],
      ['mode', 'air-conditioning', 'mode', undefined, false, 0, 4],
      ['target-temperature', 'air-conditioning', 'target-temperature', 'celsius', false, 16, 30],
      ['fan-speed', 'air-conditioning', 'fan-speed', undefined, false, 0, 6],
      ['swing-vertical', 'air-conditioning', 'swing-vertical', undefined, false, 1, 5],
      ['indoor-temperature', 'temperature-sensor', 'decimal', 'celsius', true, -50, 60],
      ['outdoor-temperature', 'temperature-sensor', 'decimal', 'celsius', true, -50, 60],
      ['error-code', 'text', 'text', undefined, true, 0, 0],
    ],
  );
  assert.deepEqual(
    d.features[1].supported_options.map((o) => [o.value, o.label]),
    [
      [0, 'Automatique'],
      [1, 'Froid'],
      [2, 'Chauffage'],
      [3, 'Déshumidification'],
      [4, 'Ventilation seule'],
    ],
  );
  assert.deepEqual(
    d.features[3].supported_options.map((o) => o.value),
    [0, 6, 1, 3, 5],
  );
  // The live capture on_cool: on, cooling, 26 °C, fan auto.
  assert.equal(last(gladys, 'binary'), 1);
  assert.equal(last(gladys, 'mode'), 1);
  assert.equal(last(gladys, 'target-temperature'), 26);
  assert.equal(last(gladys, 'fan-speed'), 0);
  assert.equal(last(gladys, 'swing-vertical'), 2);
  assert.equal(typeof last(gladys, 'indoor-temperature'), 'number');
  assert.equal(typeof last(gladys, 'outdoor-temperature'), 'number');
  assert.equal(last(gladys, 'error-code'), 'Aucune erreur');
  assert.equal(transportOf(gladys), DEVICE_TRANSPORTS.LOCAL);
});

test('read only by default: no registration, every command refused unsent', async (t) => {
  const { gladys, server, send } = await setup(t);
  assert.equal(server.commands('updateAccountInfo').length, 0);
  const ack = await send('binary', 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Autoriser les commandes/);
  assert.equal(sets(server).length, 0);
  assert.equal(server.commands('updateAccountInfo').length, 0);
  assert.equal(last(gladys, 'binary'), 1);
});

test('allowed: registered once with one kept operator id, never again after a restart', async (t) => {
  const server = fakeAdapters();
  const store = memoryStore();
  const { app, advance } = await setup(t, { config: ALLOWED, server, store });
  const registrations = server.commands('updateAccountInfo');
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].body.contents, {
    accountId: store.data.operatorId,
    airconId: AIRCON_ID,
    remote: 0,
    timezone: 'Europe/Paris',
  });
  assert.equal(store.data.adapters[AIRCON_ID].registered, true);
  await advance(3 * HOUR, MINUTE);
  assert.equal(server.commands('updateAccountInfo').length, 1);
  // A restart (same /data): same ids, no new registration.
  const operatorId = store.data.operatorId;
  await app.start(ALLOWED);
  await advance(5 * SECOND, 500);
  assert.equal(app.units.get(HOST).online, true);
  assert.equal(store.data.operatorId, operatorId);
  assert.equal(server.commands('updateAccountInfo').length, 1);
  assert.ok(server.requests.every((r) => r.body.operatorId === operatorId));
});

test('a setpoint: read again, then one full frame from that read', async (t) => {
  const { gladys, server, send } = await setup(t, { config: ALLOWED });
  const before = server.requests.length;
  const ack = await send('target-temperature', 22.5);
  assert.equal(ack.success, true, ack.error);
  const sent = server.requests.slice(before).map((r) => r.command);
  assert.deepEqual(sent.slice(0, 2), ['getAirconStat', 'setAirconStat']);
  const frame = lastFrame(server);
  assert.equal(frame.presetTemp, 22.5);
  assert.equal(frame.mode, 1);
  assert.equal(frame.operation, true);
  assert.equal(server.adapters[HOST].state.presetTemp, 22.5);
  // The checks after the command show it.
  assert.equal(last(gladys, 'target-temperature'), 22.5);
  assert.ok(server.commands('getAirconStat').length >= 3);
});

test('a command is decided on the state just read, not the one in memory', async (t) => {
  const { server, send } = await setup(t, { config: ALLOWED });
  // Changed from the remote since the last poll: heating, 21 °C.
  const unit = server.adapters[HOST];
  unit.state = { ...unit.state, mode: 2, presetTemp: 21 };
  const ack = await send('fan-speed', 5);
  assert.equal(ack.success, true, ack.error);
  const frame = lastFrame(server);
  assert.equal(frame.airFlow, 4);
  assert.equal(frame.mode, 2);
  assert.equal(frame.presetTemp, 21);
});

test('already so: nothing sent', async (t) => {
  const { server, send } = await setup(t, { config: ALLOWED });
  const ack = await send('binary', 1);
  assert.equal(ack.success, true);
  assert.equal(sets(server).length, 0);
});

test('on/off, mode and vane commands', async (t) => {
  const { server, send } = await setup(t, { config: ALLOWED });
  assert.equal((await send('binary', 0, { wait: 25 * SECOND })).success, true);
  assert.equal(lastFrame(server).operation, false);
  assert.equal((await send('mode', 2, { wait: 25 * SECOND })).success, true);
  assert.equal(lastFrame(server).mode, 2);
  assert.equal((await send('swing-vertical', 1, { wait: 25 * SECOND })).success, true);
  assert.equal(lastFrame(server).windUD, 0);
  assert.equal(lastFrame(server).operation, false);
});

test('values checked strictly; the setpoint bounded to the range of the mode just read', async (t) => {
  const { server, send } = await setup(t, { config: ALLOWED });
  for (const [key, value] of [
    ['binary', 2],
    ['binary', ''],
    ['binary', null],
    ['mode', 7],
    ['fan-speed', 2],
    ['swing-vertical', 0],
    ['target-temperature', 'NaN'],
    ['target-temperature', 99],
    ['indoor-temperature', 20],
  ]) {
    const ack = await send(key, value, { wait: SECOND });
    assert.equal(ack.success, false, `${key}=${value}`);
  }
  // Cooling: 16-30 °C.
  let ack = await send('target-temperature', 15);
  assert.match(ack.error, /entre 16 et 30 °C en mode froid/);
  // Heating: from 18 °C.
  server.adapters[HOST].state.mode = 2;
  ack = await send('target-temperature', 17);
  assert.match(ack.error, /entre 18 et 30 °C en mode chauffage/);
  assert.equal(sets(server).length, 0);
  ack = await send('target-temperature', 18.2);
  assert.equal(ack.success, true, ack.error);
  assert.equal(lastFrame(server).presetTemp, 18);
});

test('a slow fresh read: refused unsent, well within the 5 s of Gladys', async (t) => {
  const { gladys, server, advance } = await setup(t, { config: ALLOWED });
  server.adapters[HOST].delays.getAirconStat = 3 * SECOND;
  const d = gladys.fake.devices[0];
  const target = d.features.find((f) => f.external_id === feature('target-temperature'));
  const started = Date.now();
  let answeredAt;
  const ack = gladys.fake.setValue(d, target, 24).then((a) => {
    answeredAt = Date.now();
    return a;
  });
  await settle();
  await advance(6 * SECOND, 100);
  const result = await ack;
  assert.equal(result.success, false);
  assert.match(result.error, /non envoyée/);
  assert.ok(answeredAt - started <= 3_500, `${answeredAt - started} ms`);
  assert.equal(sets(server).length, 0);
});

test('a poll in flight: the command waits, then is refused unsent if it cannot leave in time', async (t) => {
  const { gladys, server, advance } = await setup(t, { config: ALLOWED });
  server.adapters[HOST].delays.getAirconStat = 15 * SECOND;
  await advance(61 * SECOND, SECOND);
  // The next poll is in flight for 15 s.
  const d = gladys.fake.devices[0];
  const target = d.features.find((f) => f.external_id === feature('binary'));
  const ack = gladys.fake.setValue(d, target, 0);
  await settle();
  await advance(5 * SECOND, 100);
  const result = await ack;
  assert.match(result.error, /trop lentement/);
  assert.equal(sets(server).length, 0);
});

test('silence after sending: "sent, without confirmation", and the next one is sent anyway', async (t) => {
  const { server, send } = await setup(t, { config: ALLOWED });
  const unit = server.adapters[HOST];
  unit.delays.setAirconStat = 10 * SECOND;
  const ack = await send('target-temperature', 24, { wait: 12 * SECOND });
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans confirmation/);
  assert.equal(sets(server).length, 1);
  assert.ok(sets(server)[0].timeoutMs <= 4_300);
  // The unit did not apply it; the guard keeps "already so" from answering.
  delete unit.delays.setAirconStat;
  unit.state.presetTemp = 26;
  const again = await send('target-temperature', 26, { wait: 3 * SECOND });
  assert.equal(again.success, true, again.error);
  assert.equal(sets(server).length, 2);
});

test('unreachable when sending: "not sent"', async (t) => {
  const { server, send } = await setup(t, { config: ALLOWED });
  // The read answers, nothing accepts the command's connection.
  server.adapters[HOST].unreachable = { setAirconStat: true };
  const ack = await send('binary', 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /n'a pas pu être joint .*non envoyée/);
  assert.equal(server.adapters[HOST].state.operation, true);
});

test('a 5xx after sending: "sent, without confirmation", never "not sent"', async (t) => {
  const { server, send } = await setup(t, { config: ALLOWED });
  server.adapters[HOST].statuses.setAirconStat = 500;
  const ack = await send('binary', 0);
  assert.match(ack.error, /envoyée, sans confirmation \(HTTP 500\)/);
});

test('refusals of the adapter: write lock, not registered (registration later, not in a loop)', async (t) => {
  const { server, store, send, advance } = await setup(t, { config: ALLOWED });
  const unit = server.adapters[HOST];
  unit.results.setAirconStat = 12;
  let ack = await send('binary', 0);
  assert.match(ack.error, /moins d'une minute/);
  delete unit.results.setAirconStat;
  // The adapter forgot us (or refused with its catch-all).
  unit.registered.clear();
  ack = await send('binary', 0);
  assert.match(ack.error, /ne connaît pas Gladys/);
  assert.equal(store.data.adapters[AIRCON_ID].registered, false);
  assert.equal(server.commands('updateAccountInfo').length, 1);
  await advance(30 * MINUTE, MINUTE);
  assert.equal(server.commands('updateAccountInfo').length, 1, 'not before the hour');
  await advance(40 * MINUTE, MINUTE);
  assert.equal(server.commands('updateAccountInfo').length, 2);
  assert.equal(store.data.adapters[AIRCON_ID].registered, true);
  ack = await send('binary', 0);
  assert.equal(ack.success, true, ack.error);
});

test('a full account table: never retried on its own; the button tries once', async (t) => {
  const server = fakeAdapters({ [HOST]: adapter({ full: true }) });
  const { gladys, store, advance, send } = await setup(t, { config: ALLOWED, server });
  assert.equal(server.commands('updateAccountInfo').length, 1);
  assert.equal(store.data.adapters[AIRCON_ID].full, true);
  assert.match(message(gladys).fr, /plus de place pour Gladys/);
  await advance(3 * HOUR, 5 * MINUTE);
  assert.equal(server.commands('updateAccountInfo').length, 1);
  const ack = await send('binary', 0);
  assert.match(ack.error, /plus de place/);
  assert.equal(sets(server).length, 0);
  // A slot freed in the app, then the button.
  server.adapters[HOST].full = false;
  const button = gladys.fake.action(ACTIONS.REGISTER);
  await advance(5 * SECOND, 500);
  assert.match((await button).data.message.fr, /enregistré/);
  assert.equal(server.commands('updateAccountInfo').length, 2);
  const cooldown = await gladys.fake.action(ACTIONS.REGISTER);
  assert.match(cooldown.data.message.fr, /moins de 30 s/);
  assert.equal(server.commands('updateAccountInfo').length, 2);
});

test('the option turned off during the fresh read: refused, not sent', async (t) => {
  const { gladys, server } = await setup(t, { config: ALLOWED });
  server.adapters[HOST].delays.getAirconStat = 500;
  const d = gladys.fake.devices[0];
  const target = d.features.find((f) => f.external_id === feature('binary'));
  const ack = gladys.fake.setValue(d, target, 0);
  await settle();
  // The fresh read is in flight (500 ms) when the option is turned off.
  await gladys.fake.configUpdated(CONFIG);
  for (let i = 0; i < 50; i += 1) {
    t.mock.timers.tick(100);
    await settle();
  }
  const answer = await ack;
  assert.equal(answer.success, false);
  assert.match(answer.error, /Autoriser les commandes/);
  assert.equal(sets(server).length, 0);
});

test('/data refusing the ids: no registration at all, said in the status', async (t) => {
  const server = fakeAdapters();
  const { gladys, send } = await setup(t, {
    config: ALLOWED,
    server,
    store: memoryStore(null, { failing: true }),
  });
  assert.equal(server.commands('updateAccountInfo').length, 0);
  assert.match(message(gladys).fr, /ne peut pas garder son identifiant/);
  const ack = await send('binary', 0);
  assert.equal(ack.success, false);
  assert.equal(sets(server).length, 0);
});

test('a 429: a pause kept in /data, for every path, not lifted by a reconnection', async (t) => {
  const server = fakeAdapters();
  const store = memoryStore();
  const { gladys, app, advance, send } = await setup(t, { config: ALLOWED, server, store });
  server.adapters[HOST].statuses.getAirconStat = { status: 429, headers: { 'retry-after': '600' } };
  await advance(MINUTE, 5 * SECOND);
  const until = store.data.addresses[HOST].pausedUntil;
  assert.ok(until >= Date.now() + 9 * MINUTE);
  delete server.adapters[HOST].statuses.getAirconStat;
  const count = server.requests.length;
  await advance(5 * MINUTE, 30 * SECOND);
  assert.equal(server.requests.length, count);
  const ack = await send('binary', 0, { wait: SECOND });
  assert.match(ack.error, /pause/);
  await gladys.disconnect();
  await gladys.connect();
  await settle();
  assert.equal(server.requests.length, count);
  assert.match(message(gladys).fr, /HTTP 429/);
  await app.start(ALLOWED);
  await settle();
  assert.equal(server.requests.length, count, 'a restart keeps the pause');
  await advance(6 * MINUTE, 30 * SECOND);
  assert.ok(server.requests.length > count);
});

test('a reconnection republishes the status, the Discovery list and keeps every feature', async (t) => {
  const { gladys, server } = await setup(t, { create: false });
  const created = structuredClone(gladys.fake.discoveredDevices[0]);
  created.features.push({
    name: 'Extra',
    external_id: `${device()}:legacy-feature`,
    category: 'text',
    type: 'text',
    read_only: true,
    has_feedback: false,
    keep_history: false,
    min: 0,
    max: 0,
  });
  await gladys.fake.deviceCreated(created);
  const statuses = gladys.fake.connectionStatuses.length;
  await gladys.disconnect();
  await gladys.connect();
  await settle();
  assert.ok(gladys.fake.connectionStatuses.length > statuses);
  const again = gladys.fake.discoveredDevices[0];
  assert.ok(again.features.some((f) => f.external_id === `${device()}:legacy-feature`));
  assert.ok(server.requests.length >= 3);
});

test('the ack never waits for a publication to Gladys', async (t) => {
  const { gladys, server, send } = await setup(t, { config: ALLOWED });
  gladys.publishChangedStates = () => new Promise(() => {});
  gladys.publishDiscoveredDevices = () => new Promise(() => {});
  const ack = await send('target-temperature', 23);
  assert.equal(ack.success, true, ack.error);
  assert.equal(lastFrame(server).presetTemp, 23);
});

test('one command at a time per adapter', async (t) => {
  const { gladys, server, advance } = await setup(t, { config: ALLOWED });
  server.adapters[HOST].delays.getAirconStat = 800;
  const d = gladys.fake.devices[0];
  const f = (key) => d.features.find((x) => x.external_id === feature(key));
  const first = gladys.fake.setValue(d, f('target-temperature'), 24);
  await settle();
  const second = gladys.fake.setValue(d, f('fan-speed'), 5);
  await settle();
  await advance(6 * SECOND, 100);
  assert.equal((await first).success, true);
  const refused = await second;
  assert.equal(refused.success, false);
  assert.match(refused.error, /encore en cours/);
  assert.equal(sets(server).length, 1);
});

test('two adapters, one down: the other works, the status names the silent one', async (t) => {
  const server = fakeAdapters({
    [HOST]: adapter(),
    [HOST2]: adapter({ airconId: AIRCON_ID2, down: true }),
  });
  const { gladys, advance } = await setup(t, {
    config: { addresses: `${HOST}, ${HOST2}` },
    server,
  });
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /1 adaptateur sur 2.*Pas de réponse de : 192\.168\.1\.71/);
  // Never read sooner than the interval (60 s), then backoff.
  const before = server.requests.filter((r) => r.host === HOST2).length;
  await advance(50 * SECOND, 5 * SECOND);
  assert.equal(server.requests.filter((r) => r.host === HOST2).length, before);
  server.adapters[HOST2].down = false;
  await advance(2 * MINUTE, 5 * SECOND);
  assert.equal(gladys.fake.discoveredDevices.length, 2);
});

test('hostile answers: no prototype pollution, nothing decided on them', async (t) => {
  const server = fakeAdapters();
  server.adapters[HOST].bodies.getDeviceInfo =
    '{"result":0,"contents":{"__proto__":{"polluted":1},"airconId":"x"}}';
  const { gladys, advance } = await setup(t, { server });
  assert.equal({}.polluted, undefined);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  server.adapters[HOST].bodies.getDeviceInfo = JSON.stringify({
    result: 0,
    contents: { airconId: 'a'.repeat(5000) },
  });
  const button = gladys.fake.action(ACTIONS.TEST_CONNECTION);
  await advance(5 * SECOND, 500);
  assert.match((await button).data.message.fr, /Pas de réponse/);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  // A state that is not a frame: nothing published, nothing decided.
  delete server.adapters[HOST].bodies.getDeviceInfo;
  server.adapters[HOST].bodies.getAirconStat = JSON.stringify({
    result: 0,
    contents: { airconId: AIRCON_ID, airconStat: '%%%' },
  });
  await advance(2 * MINUTE, 5 * SECOND);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.equal({}.polluted, undefined);
});

test('the ids never appear in the logs', async (t) => {
  const logs = [];
  const store = memoryStore();
  const { send } = await setup(t, { config: ALLOWED, logs, store });
  await send('binary', 0);
  const text = logs.join('\n');
  assert.ok(!text.includes(store.data.operatorId));
  assert.ok(!text.includes(store.data.deviceId));
});
