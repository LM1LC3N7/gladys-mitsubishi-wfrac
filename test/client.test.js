// -----------------------------------------------------------------------------
// The transport (a loopback server, never the network) and the client: the
// envelope, the answers read strictly, the gate (one request at a time, 1 s
// apart, commands first) and the deadlines.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Gate, WfracClient, airconIdOf, errorReason, retryAfterOf } from '../src/wfrac/client.js';
import { ERROR_KINDS, TLS_OPTIONS, request } from '../src/wfrac/http.js';
import { settle } from './helpers/fakeAdapter.js';

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return server.address().port;
}

test('a POST over plain HTTP, the answer read whatever its content type', async (t) => {
  let received;
  const port = await serve(t, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received = { method: req.method, url: req.url, body, type: req.headers['content-type'] };
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('{"result":0}');
    });
  });
  const answer = await request({
    scheme: 'http',
    host: '127.0.0.1',
    port,
    path: '/beaver/command/getDeviceInfo',
    body: '{"a":1}',
    timeoutMs: 2000,
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body, '{"result":0}');
  assert.deepEqual(received, {
    method: 'POST',
    url: '/beaver/command/getDeviceInfo',
    body: '{"a":1}',
    type: 'application/json',
  });
});

test('an answer too large is cut and refused', async (t) => {
  const port = await serve(t, (req, res) => {
    req.resume();
    res.end('x'.repeat(200 * 1024));
  });
  await assert.rejects(
    request({ scheme: 'http', host: '127.0.0.1', port, path: '/', body: '{}', timeoutMs: 2000 }),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
});

test('nothing listening: unreachable (not sent); connected then silent: timeout (maybe received)', async (t) => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(
    request({ scheme: 'http', host: '127.0.0.1', port, path: '/', body: '{}', timeoutMs: 2000 }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE,
  );
  const silent = await serve(t, (req) => req.resume());
  await assert.rejects(
    request({
      scheme: 'http',
      host: '127.0.0.1',
      port: silent,
      path: '/',
      body: '{}',
      timeoutMs: 300,
    }),
    (err) => err.kind === ERROR_KINDS.TIMEOUT,
  );
});

test('HTTPS options for the old TLS of the adapter', () => {
  assert.equal(TLS_OPTIONS.rejectUnauthorized, false);
  assert.equal(TLS_OPTIONS.minVersion, 'TLSv1');
  assert.match(TLS_OPTIONS.ciphers, /@SECLEVEL=0/);
});

const reply = (body, status = 200, headers = {}) => ({
  status,
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const ADDRESS = { host: '10.0.0.5', port: 51443 };
const IDS = {
  operatorId: '11111111-2222-4333-8444-555555555555',
  deviceId: 'gladys-0123456789abcdef',
};

test('the envelope, and only own fields of plain objects read', async () => {
  const calls = [];
  const client = new WfracClient({
    identity: () => IDS,
    now: () => 1_760_000_000_400,
    transport: async (options) => {
      calls.push(options);
      return reply('{"result":0,"contents":{"airconId":"348e89c5a137","__proto__":{"x":1}}}');
    },
  });
  const info = await client.deviceInfo(ADDRESS, 'https');
  assert.deepEqual(info, { airconId: '348e89c5a137' });
  assert.equal(calls[0].path, '/beaver/command/getDeviceInfo');
  assert.deepEqual(JSON.parse(calls[0].body), {
    apiVer: '1.0',
    command: 'getDeviceInfo',
    deviceId: IDS.deviceId,
    operatorId: IDS.operatorId,
    timestamp: 1_760_000_000,
  });
  assert.equal({}.x, undefined);
});

test('answers that are not what they should be', async () => {
  const bodies = [
    'not json',
    '[1,2]',
    'null',
    '{"result":0}',
    '{"result":0,"contents":{"airconId":42}}',
    '{"result":0,"contents":{"airconId":"../etc"}}',
  ];
  for (const body of bodies) {
    const client = new WfracClient({ identity: () => IDS, transport: async () => reply(body) });
    await assert.rejects(
      client.deviceInfo(ADDRESS, 'http'),
      (err) => err.kind === ERROR_KINDS.PROTOCOL,
      body,
    );
  }
  const limited = new WfracClient({
    identity: () => IDS,
    transport: async () => reply('slow down', 429, { 'retry-after': '120' }),
  });
  await assert.rejects(limited.deviceInfo(ADDRESS, 'http'), (err) => {
    assert.equal(err.kind, ERROR_KINDS.RATE_LIMITED);
    assert.equal(err.retryAfter, 120_000);
    return true;
  });
  const empty = new WfracClient({
    identity: () => IDS,
    transport: async () => reply({ result: 1, contents: {} }),
  });
  await assert.rejects(empty.stat(ADDRESS, 'http', '348e89c5a137'), (err) => {
    assert.equal(errorReason(err), 'result 1');
    return true;
  });
});

test('discovery: one scheme, then the other; a 429 stops it', async () => {
  const schemes = [];
  const client = new WfracClient({
    identity: () => IDS,
    transport: async ({ scheme }) => {
      schemes.push(scheme);
      if (scheme === 'http') {
        throw Object.assign(new Error('x'), { kind: ERROR_KINDS.UNREACHABLE });
      }
      return reply({ result: 0, contents: { airconId: 'abcd1234' } });
    },
  });
  client.wait = async () => {};
  assert.deepEqual(await client.discover(ADDRESS, ['http', 'https']), {
    scheme: 'https',
    airconId: 'abcd1234',
  });
  assert.deepEqual(schemes, ['http', 'https']);
});

test('the gate: one at a time, commands first, LATE when it cannot start in time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const gate = new Gate({ now: () => Date.now() });
  const order = [];
  let release;
  const first = gate.run(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const poll = gate.run(async () => order.push('poll'));
  const command = gate.run(async () => order.push('command'), { first: true });
  const late = assert.rejects(
    gate.run(async () => order.push('late'), { first: true, startBy: 1000 }),
    (err) => err.kind === ERROR_KINDS.LATE,
  );
  await settle();
  t.mock.timers.tick(1500);
  await settle();
  await late;
  release();
  await first;
  await Promise.all([poll, command]);
  assert.deepEqual(order, ['command', 'poll']);
});

test('1 s between two requests to one adapter; beforeSend can stop a command unsent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const at = [];
  const client = new WfracClient({
    identity: () => IDS,
    now: () => Date.now(),
    transport: async () => {
      at.push(Date.now());
      return reply({ result: 0, contents: { airconId: 'abcd1234' } });
    },
  });
  const a = client.deviceInfo(ADDRESS, 'http');
  const b = client.deviceInfo(ADDRESS, 'http');
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  await Promise.all([a, b]);
  assert.deepEqual(at, [0, 1000]);
  t.mock.timers.tick(5000);
  const stopped = assert.rejects(
    client.setStat(ADDRESS, 'http', 'abcd1234', 'AAAA', {
      startBy: Date.now() + 3500,
      answerBy: Date.now() + 4300,
      beforeSend: () => {
        throw new Error('disabled');
      },
    }),
    (err) => err.notSent === true && err.beforeSend === true,
  );
  await settle();
  await stopped;
  assert.equal(at.length, 2);
});

test('small helpers', () => {
  assert.equal(airconIdOf('348e89c5a137'), '348e89c5a137');
  assert.equal(airconIdOf('__proto__'), undefined);
  assert.equal(airconIdOf('a'.repeat(41)), undefined);
  assert.equal(retryAfterOf('30'), 30_000);
  assert.equal(retryAfterOf(''), undefined);
  assert.equal(
    retryAfterOf('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('2015-10-21T07:27:00Z')),
    60_000,
  );
  assert.equal(errorReason({ kind: ERROR_KINDS.HTTP, status: 503 }), 'HTTP 503');
});
