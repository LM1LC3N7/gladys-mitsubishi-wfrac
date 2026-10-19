// -----------------------------------------------------------------------------
// One POST to the adapter (node:http or node:https, no keep-alive, no redirect
// followed, bounded time and size). Every failure becomes a WfracError whose
// kind says whether the request may have reached the adapter:
//   'unreachable': nothing accepted the connection (or the TLS handshake
//                  failed): the request was not sent;
//   'timeout':     connected, then silent or cut: it may have been received.
//
// HTTPS: the adapter has a self-signed certificate (its name never matches the
// address) and an old TLS stack (mbedTLS 2.4.0, 2016), which Node refuses by
// default: the certificate is not checked and old TLS versions and ciphers
// are allowed, as pywfrac does. This protects nothing against a device that
// impersonates the adapter on the network: keep it on a trusted network.
// -----------------------------------------------------------------------------

import { constants as cryptoConstants } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { LIMITS } from '../constants.js';

/** The kinds of failure the rest of the code tells apart. */
export const ERROR_KINDS = Object.freeze({
  /** Nothing accepted the connection (or TLS failed). Nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Connected, then silent or cut: the request may have been received. */
  TIMEOUT: 'timeout',
  /** An HTTP status other than 2xx (`status` holds it). */
  HTTP: 'http',
  /** 429 (`retryAfter` in ms when the adapter gave one). */
  RATE_LIMITED: 'rate_limited',
  /** Too large, not JSON, not the expected shape. */
  PROTOCOL: 'protocol',
  /** The adapter answered with a `result` that refuses the request (`result` holds it). */
  REFUSED: 'refused',
  /** The time a command was given ran out before its request: nothing was sent. */
  LATE: 'late',
});

export class WfracError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.name = 'WfracError';
    this.kind = kind;
    for (const [key, value] of Object.entries(details)) {
      this[key] = value;
    }
  }
}

/** TLS options for the adapter's old stack (see the header). */
export const TLS_OPTIONS = Object.freeze({
  rejectUnauthorized: false,
  minVersion: 'TLSv1',
  ciphers: 'DEFAULT:@SECLEVEL=0',
  secureOptions: cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT ?? 0,
});

/**
 * @param {{ scheme: 'http' | 'https', host: string, port: number, path: string,
 *   body: string, timeoutMs: number }} options
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
export function request({ scheme, host, port, path, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body, 'utf8');
    let settled = false;
    let connected = false;
    const finish = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const failure = (err) =>
      connected
        ? new WfracError(ERROR_KINDS.TIMEOUT, `Connection lost: ${err.code ?? 'error'}`)
        : new WfracError(ERROR_KINDS.UNREACHABLE, `Unreachable: ${err.code ?? 'error'}`);
    const send = scheme === 'https' ? httpsRequest : httpRequest;
    const req = send(
      {
        host,
        port,
        method: 'POST',
        path,
        agent: false,
        ...(scheme === 'https' ? TLS_OPTIONS : {}),
        headers: {
          Connection: 'close',
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > LIMITS.responseBytes) {
            req.destroy();
            finish(reject, new WfracError(ERROR_KINDS.PROTOCOL, 'Answer too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(resolve, {
            status: res.statusCode ?? 0,
            headers: res.headers ?? {},
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', (err) => finish(reject, failure(err)));
      },
    );
    req.on('socket', (socket) => {
      // The request leaves once the connection (and the TLS handshake) is up;
      // a new socket every time (no agent), so the event is still to come.
      socket.once(scheme === 'https' ? 'secureConnect' : 'connect', () => {
        connected = true;
      });
    });
    // A plain (ref'd) timer: the exchange keeps the process alive until it ends.
    const timer = setTimeout(() => {
      req.destroy();
      finish(
        reject,
        connected
          ? new WfracError(ERROR_KINDS.TIMEOUT, 'Connected but silent: timeout')
          : new WfracError(ERROR_KINDS.UNREACHABLE, 'Unreachable: timeout'),
      );
    }, timeoutMs);
    req.on('error', (err) => finish(reject, failure(err)));
    req.end(payload);
  });
}
