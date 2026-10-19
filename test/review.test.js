// -----------------------------------------------------------------------------
// The points of the first review (I1-I5, M1-M15), one test or more each,
// end to end against the SDK's fake Gladys and fake adapters.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { WfracApp } from '../src/app.js';
import { ACTIONS, HOUR, MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore, newIds, normalizeMemory } from '../src/store.js';
import { decodeStat } from '../src/wfrac/protocol.js';
import {
  AIRCON_ID,
  AIRCON_ID2,
  HOST,
  HOST2,
  NOW,
  adapter,
  fakeAdapters,
  golden,
  settle,
} from './helpers/fakeAdapter.js';

const CONFIG = { addresses: HOST };
const ALLOWED = { addresses: HOST, allow_commands: true };
const device = (id = AIRCON_ID) => `ext:test-integration:wfrac:${id}`;
const feature = (key, id = AIRCON_ID) => `${device(id)}:${key}`;
const base = () => decodeStat(golden.frames.on_cool.payload);

async function setup(
  t,
  { config = CONFIG, server = fakeAdapters(), store = memoryStore(), logs = [] } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  const gladys = createFakeGladys({ config });
  const app = new WfracApp({
    gladys,
    logger: Object.fromEntries(
      ['debug', 'info', 'warn', 'error'].map((l) => [l, (...a) => logs.push(a.join(' '))]),
    ),
    transport: (options) => server.transport(options),
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
  for (const d of [...gladys.fake.discoveredDevices]) {
    await gladys.fake.deviceCreated(d);
  }
  await settle();
  /** Sends and waits until the ack is there (as a scene does). */
  const sendNow = async (key, value, id = AIRCON_ID) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device(id));
    const target = d.features.find((f) => f.external_id === feature(key, id));
    let done;
    const ack = gladys.fake.setValue(d, target, value).then((a) => {
      done = a;
      return a;
    });
    for (let i = 0; i < 100 && done === undefined; i += 1) {
      await advance(100, 100);
    }
    return ack;
  };
  return { gladys, app, server, store, advance, logs, sendNow };
}

const sets = (server) => server.commands('setAirconStat');
const lastFrame = (server) => decodeStat(sets(server).at(-1).body.contents.airconStat);
const reads = (server, host) =>
  server.requests.filter((r) => r.host === host && r.command === 'getAirconStat').length;
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};

test('I1 two config saves at once, the second reading /data slowly: one read chain', async (t) => {
  const server = fakeAdapters({ [HOST]: adapter(), [HOST2]: adapter({ airconId: AIRCON_ID2 }) });
  const store = memoryStore();
  const load = store.load.bind(store);
  let calls = 0;
  store.load = async () => {
    calls += 1;
    if (calls === 3) {
      await new Promise((resolve) => setTimeout(resolve, 2 * SECOND));
    }
    return load();
  };
  const { gladys, app, advance } = await setup(t, { server, store });
  const two = { addresses: `${HOST}, ${HOST2}` };
  const a = gladys.fake.configUpdated(two);
  const b = gladys.fake.configUpdated(two);
  await settle();
  await advance(10 * SECOND, 500);
  await Promise.all([a, b]);
  const before = reads(server, HOST2);
  await advance(10 * MINUTE, 5 * SECOND);
  const during = reads(server, HOST2) - before;
  assert.ok(during >= 9 && during <= 11, `${during} reads in 10 minutes`);
  assert.equal(app.units.size, 2);
});

test('I1 a unit replaced by a restart never reads again', async (t) => {
  const server = fakeAdapters();
  const { app, advance } = await setup(t, { server });
  const old = app.units.get(HOST);
  await app.start({ addresses: HOST });
  await advance(5 * SECOND, 500);
  assert.notEqual(app.units.get(HOST), old);
  const before = reads(server, HOST);
  await app.tick(old);
  old.timer = undefined;
  app.schedule(old);
  assert.equal(old.timer, undefined);
  await advance(3 * MINUTE, 5 * SECOND);
  // Only the new unit's chain: one read a minute.
  assert.ok(reads(server, HOST) - before <= 4);
});

test('I2 a command whose previous one is not visible yet: refused, never merged', async (t) => {
  const server = fakeAdapters();
  const inner = server.transport;
  // Writes are applied (result 0) but shown by the reads 10 s later only.
  server.transport = async (options) => {
    const unit = server.adapters[HOST];
    if (options.path.endsWith('setAirconStat')) {
      const before = unit.state;
      const answer = await inner(options);
      const after = unit.state;
      unit.state = before;
      setTimeout(() => {
        unit.state = after;
      }, 10 * SECOND);
      return answer;
    }
    return inner(options);
  };
  const { sendNow, advance } = await setup(t, { config: ALLOWED, server });
  assert.equal((await sendNow('mode', 2)).success, true);
  const second = await sendNow('target-temperature', 22);
  assert.equal(second.success, false);
  assert.match(second.error, /précédente n'est pas encore visible/);
  assert.equal(sets(server).length, 1);
  await advance(15 * SECOND, SECOND);
  assert.equal(server.adapters[HOST].state.mode, 2, 'the mode of the first command is kept');
  // Once visible, the next one goes, built on that read.
  const third = await sendNow('target-temperature', 22);
  assert.equal(third.success, true, third.error);
  assert.equal(lastFrame(server).mode, 2);
  assert.equal(lastFrame(server).presetTemp, 22);
});

test('I3 (H3) range 2, heating at 10 °C, then cooling: the setpoint brought to 16 °C', async (t) => {
  const server = fakeAdapters({
    [HOST]: adapter({ state: { ...base(), modelNrRaw: 3, modelNr: 2, mode: 2, presetTemp: 10 } }),
  });
  const { sendNow } = await setup(t, { config: ALLOWED, server });
  const ack = await sendNow('mode', 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(lastFrame(server).mode, 1);
  assert.equal(lastFrame(server).presetTemp, 16);
});

test('I3 (H3b) range 2, cooling at 33 °C, then heating: the setpoint brought to 30 °C', async (t) => {
  const server = fakeAdapters({
    [HOST]: adapter({ state: { ...base(), modelNrRaw: 3, modelNr: 2, mode: 1, presetTemp: 33 } }),
  });
  const { sendNow } = await setup(t, { config: ALLOWED, server });
  assert.equal((await sendNow('mode', 2)).success, true);
  assert.equal(lastFrame(server).presetTemp, 30);
  assert.equal(lastFrame(server).mode, 2);
});

test('I4 a frame whose CRC does not match: shown, logged, never acted on', async (t) => {
  const server = fakeAdapters();
  const inner = server.transport;
  let corrupt = false;
  server.transport = async (options) => {
    const answer = await inner(options);
    if (corrupt && options.path.endsWith('getAirconStat')) {
      const body = JSON.parse(answer.body);
      const d = [...Buffer.from(body.contents.airconStat, 'base64')];
      d[d[18] * 4 + 21 + 4] ^= 0x02; // setpoint 26 °C -> 26.5 °C
      body.contents.airconStat = Buffer.from(d).toString('base64');
      return { ...answer, body: JSON.stringify(body) };
    }
    return answer;
  };
  const logs = [];
  const { sendNow, advance } = await setup(t, { config: ALLOWED, server, logs });
  corrupt = true;
  await advance(61 * SECOND, SECOND);
  assert.ok(logs.some((l) => /CRC does not match/.test(l)));
  const ack = await sendNow('fan-speed', 5);
  assert.match(ack.error, /Trame non vérifiable .*: non envoyée/);
  assert.equal(sets(server).length, 0);
});

test('I4 (H4) a setpoint byte of 63.5 °C: unknown, never published nor written back', async (t) => {
  const server = fakeAdapters({ [HOST]: adapter({ state: { ...base(), presetTemp: 63.5 } }) });
  const { gladys, sendNow } = await setup(t, { config: ALLOWED, server });
  assert.equal(gladys.fake.lastState(feature('target-temperature')), undefined);
  const ack = await sendNow('fan-speed', 5);
  assert.equal(ack.success, false);
  assert.equal(sets(server).length, 0);
});

test('I5 (H5) the state file lost: the ids file keeps the same operator id, no second slot', async (t) => {
  const server = fakeAdapters();
  const store = memoryStore();
  const { app, advance } = await setup(t, { config: ALLOWED, server, store });
  const first = store.ids.operatorId;
  assert.equal(server.adapters[HOST].registered.size, 1);
  app.stop();
  store.data = null;
  const app2 = new WfracApp({
    gladys: createFakeGladys({ config: ALLOWED }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    transport: server.transport,
    now: () => Date.now(),
    store,
    timezone: 'Europe/Paris',
  });
  t.after(() => app2.stop());
  const started = app2.start(ALLOWED);
  await advance(10 * SECOND, 500);
  await started;
  assert.equal(store.ids.operatorId, first);
  assert.equal(server.adapters[HOST].registered.size, 1);
});

test('I5 an unreadable ids file: set aside, no new ids, the status says so; the button makes new ones', async (t) => {
  const server = fakeAdapters();
  const store = memoryStore(null, { ids: { operatorId: 'broken' } });
  const { gladys, advance, sendNow } = await setup(t, { config: ALLOWED, server, store });
  assert.deepEqual(store.idsSetAside, { operatorId: 'broken' });
  assert.equal(server.commands('updateAccountInfo').length, 0);
  assert.match(message(gladys).fr, /identifiant de Gladys dans \/data est illisible/);
  assert.equal((await sendNow('binary', 0)).success, false);
  const button = gladys.fake.action(ACTIONS.REGISTER);
  await advance(5 * SECOND, 500);
  const answer = await button;
  assert.match(answer.data.message.fr, /Nouvel identifiant créé.*enregistré/);
  assert.match(store.ids.operatorId, /^[0-9a-f-]{36}$/);
  assert.equal(server.commands('updateAccountInfo').length, 1);
});

test('M1 (H6) no follow-up read while the adapter is offline: its backoff stands', async (t) => {
  const server = fakeAdapters();
  const { sendNow, advance } = await setup(t, { config: ALLOWED, server });
  server.adapters[HOST].delays.setAirconStat = 10 * SECOND;
  assert.match((await sendNow('binary', 0)).error, /sans confirmation/);
  server.adapters[HOST].down = true;
  const mark = server.requests.length;
  await advance(25 * SECOND, SECOND);
  const first = server.requests[mark]?.at;
  const within = server.requests.slice(mark).filter((r) => r.at > first + 2 * SECOND);
  assert.equal(within.length, 0);
});

test('M2 (H8) the test button keeps the delay of a failed adapter and says it', async (t) => {
  const server = fakeAdapters();
  const { gladys, advance } = await setup(t, { server });
  server.adapters[HOST].down = true;
  await advance(61 * SECOND, SECOND);
  const mark = server.requests.length;
  let last;
  for (let i = 0; i < 3; i += 1) {
    const b = gladys.fake.action(ACTIONS.TEST_CONNECTION);
    await advance(11 * SECOND, 500);
    last = await b;
  }
  assert.ok(server.requests.length - mark <= 2);
  assert.match(last.data.message.fr, /nouvel essai dans \d+ s/);
});

test('M3 (H7) registration answered 2 with free slots: not "full", tried again later', async (t) => {
  const server = fakeAdapters();
  server.adapters[HOST].results.updateAccountInfo = 2;
  const { gladys, store } = await setup(t, { config: ALLOWED, server });
  assert.equal(store.data.adapters[AIRCON_ID].full, false);
  assert.doesNotMatch(message(gladys).fr, /plus de place/);
});

test('M4 (H9) a fresh read answered result 1: no command built on it', async (t) => {
  const server = fakeAdapters();
  const { sendNow } = await setup(t, { config: ALLOWED, server });
  server.adapters[HOST].results.getAirconStat = 1;
  const ack = await sendNow('target-temperature', 24);
  assert.match(ack.error, /pas pu être relu juste avant \(result 1\)/);
  assert.equal(sets(server).length, 0);
});

test('M4 a fresh read without its airconId: no command', async (t) => {
  const server = fakeAdapters();
  const { sendNow } = await setup(t, { config: ALLOWED, server });
  const inner = server.transport;
  server.transport = async (options) => {
    const answer = await inner(options);
    if (options.path.endsWith('getAirconStat')) {
      const body = JSON.parse(answer.body);
      delete body.contents.airconId;
      return { ...answer, body: JSON.stringify(body) };
    }
    return answer;
  };
  const ack = await sendNow('target-temperature', 24);
  assert.equal(ack.success, false);
  assert.equal(sets(server).length, 0);
});

test('M5 (H10) one adapter typed under two addresses: one device, read once', async (t) => {
  const one = adapter();
  const server = fakeAdapters({ [HOST]: one, 'wfrac.lan': one });
  const { gladys, advance } = await setup(t, {
    server,
    config: { addresses: `${HOST}, wfrac.lan` },
  });
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.match(message(gladys).fr, /Même adaptateur saisi deux fois/);
  const before = server.requests.filter((r) => r.host === 'wfrac.lan').length;
  await advance(5 * MINUTE, 10 * SECOND);
  assert.equal(server.requests.filter((r) => r.host === 'wfrac.lan').length, before);
});

test('M9 fan only: the setpoint takes the union of the regulating modes', async (t) => {
  const server = fakeAdapters({ [HOST]: adapter({ state: { ...base(), mode: 3 } }) });
  const { sendNow } = await setup(t, { config: ALLOWED, server });
  assert.equal((await sendNow('target-temperature', 16)).success, true);
  const ack = await sendNow('target-temperature', 31);
  assert.match(ack.error, /entre 16 et 30 °C : non envoyée/);
});

test('M15 the ack never waits for /data', async (t) => {
  const server = fakeAdapters();
  const store = memoryStore();
  const { sendNow } = await setup(t, { config: ALLOWED, server, store });
  store.save = () => new Promise(() => {});
  server.adapters[HOST].registered.clear();
  const ack = await sendNow('binary', 0);
  assert.match(ack.error, /ne connaît pas Gladys/);
  server.adapters[HOST].statuses.setAirconStat = { status: 429 };
  server.adapters[HOST].registered.add(store.ids.operatorId);
  const limited = await sendNow('binary', 0);
  assert.equal(limited.success, false);
});

test('ids written once: a second start reads them, never writes new ones', async (t) => {
  const ids = newIds();
  const store = memoryStore(null, { ids });
  let written = 0;
  const save = store.saveIds.bind(store);
  store.saveIds = (value) => {
    written += 1;
    return save(value);
  };
  const { app, advance } = await setup(t, { config: ALLOWED, store });
  await app.start(ALLOWED);
  await advance(5 * SECOND, 500);
  assert.equal(written, 0);
  assert.deepEqual(store.ids, ids);
});

// --- Approval round 1 ----------------------------------------------------------

test('R2 (P1) a resend of the value already shown does not block the other commands', async (t) => {
  const server = fakeAdapters();
  const unit = server.adapters[HOST];
  const { sendNow, advance } = await setup(t, { config: ALLOWED, server });
  unit.delays.setAirconStat = 10 * SECOND;
  assert.match((await sendNow('target-temperature', 24)).error, /sans confirmation/);
  delete unit.delays.setAirconStat;
  await advance(25 * SECOND, SECOND);
  const back = await sendNow('target-temperature', 26);
  assert.equal(back.success, true, back.error);
  await advance(10 * SECOND, SECOND);
  const fan = await sendNow('fan-speed', 5);
  assert.equal(fan.success, true, fan.error);
  assert.equal(lastFrame(server).airFlow, 4);
});

async function slowRead(t, configs) {
  const server = fakeAdapters({ [HOST]: adapter(), [HOST2]: adapter({ airconId: AIRCON_ID2 }) });
  const both = `${HOST}, ${HOST2}`;
  const { gladys, app, advance } = await setup(t, {
    server,
    config: { addresses: both, allow_commands: true },
  });
  server.adapters[HOST].delays.getAirconStat = 20 * SECOND;
  for (let i = 0; i < 120 && !app.units.get(HOST).running; i += 1) {
    await advance(SECOND, SECOND);
  }
  assert.ok(app.units.get(HOST).running, 'a read in flight');
  const saves = [];
  for (const allow of configs) {
    saves.push(
      gladys.fake.configUpdated({ addresses: both, allow_commands: allow, poll_interval: 120 }),
    );
    await settle();
  }
  await advance(2 * SECOND, 500);
  const d = gladys.fake.devices.find((x) => x.external_id === device(AIRCON_ID2));
  const ack = gladys.fake.setValue(
    d,
    d.features.find((f) => f.external_id === feature('binary', AIRCON_ID2)),
    0,
  );
  await settle();
  await advance(6 * SECOND, 100);
  const answer = await ack;
  await advance(20 * SECOND, SECOND);
  await Promise.all(saves);
  return { server, app, answer };
}

test('R1 (P2) commands turned off with a restart, a slow read elsewhere: refused at once', async (t) => {
  const { server, app, answer } = await slowRead(t, [false]);
  assert.equal(answer.success, false);
  assert.match(answer.error, /Autoriser les commandes/);
  assert.equal(sets(server).length, 0);
  assert.equal(app.config.allowCommands, false);
});

test('R1 (P2b) "commands off" behind a queued restart: an older save never turns them on', async (t) => {
  const { server, app, answer } = await slowRead(t, [true, false]);
  assert.equal(answer.success, false);
  assert.equal(sets(server).length, 0);
  assert.equal(app.config.allowCommands, false);
});

test('R1 commands turned on again later: they work', async (t) => {
  const { server, app, advance } = await setup(t, { config: ALLOWED });
  await app.configUpdated(CONFIG);
  assert.equal(app.config.allowCommands, false);
  const on = app.configUpdated(ALLOWED);
  await advance(2 * SECOND, 500);
  await on;
  assert.equal(app.config.allowCommands, true);
  void server;
});

test('P3 a pause read back is capped on its own start, saved once: restarts never move it', async (t) => {
  const store = memoryStore({
    adapters: {},
    addresses: { [HOST]: { scheme: 'https', pausedAt: NOW, pausedUntil: NOW + 30 * 24 * HOUR } },
  });
  const { app } = await setup(t, { store });
  assert.equal(app.pausedUntil(app.units.get(HOST)), NOW + 6 * HOUR);
  assert.equal(store.data.addresses[HOST].pausedUntil, NOW + 6 * HOUR);
  const at = (h) => normalizeMemory(store.data, NOW + h * HOUR).addresses.get(HOST).pausedUntil;
  assert.equal(at(5), NOW + 6 * HOUR);
  assert.equal(at(10), 0);
  const legacy = { addresses: { [HOST]: { pausedUntil: NOW + 30 * 24 * HOUR } } };
  assert.ok(
    normalizeMemory(legacy, NOW + 10 * HOUR).addresses.get(HOST).pausedUntil <= NOW + 6 * HOUR,
  );
});

test('a frame whose CRC does not match is named in the status', async (t) => {
  const server = fakeAdapters();
  const inner = server.transport;
  server.transport = async (options) => {
    const answer = await inner(options);
    if (options.path.endsWith('getAirconStat')) {
      const body = JSON.parse(answer.body);
      const d = [...Buffer.from(body.contents.airconStat, 'base64')];
      d[d[18] * 4 + 21 + 4] ^= 0x02;
      body.contents.airconStat = Buffer.from(d).toString('base64');
      return { ...answer, body: JSON.stringify(body) };
    }
    return answer;
  };
  const { gladys } = await setup(t, { server });
  assert.match(message(gladys).fr, /CRC ne correspond pas.*192\.168\.1\.70/);
});
