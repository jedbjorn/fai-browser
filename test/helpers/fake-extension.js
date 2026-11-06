// Test stand-in for the extension side of protocol v3: a raw RFC 6455 client (masked frames, built with the
// server's own encoder) plus a small FakeExtension that speaks the v3 message schema.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { FrameParser, OPCODES, closePayload, encodeFrame } from '../../src/ws.js';
import { ORIGIN, PAGES, blocksFor } from '../runtime-fixtures.js';

export const EXTENSION_ID = 'a'.repeat(32);
export const SECRET = 'secret-pairing-token-123456789';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

/**
 * Opens a raw WebSocket. Resolves {status} when the server answers without upgrading, else a client with
 * send(obj), sendRaw(buffer), frame(opcode, payload, opts), next(predicate, ms), waitClose(ms), destroy().
 */
export function connectRaw({
  port,
  path = '/ext/ws',
  origin = EXTENSION_ORIGIN,
  protocols = ['fai-browser.v3', `fai-auth.${SECRET}`],
  headers = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...(origin ? { Origin: origin } : {}),
        ...(protocols.length ? { 'Sec-WebSocket-Protocol': protocols.join(', ') } : {}),
        ...headers,
      },
    });
    request.on('response', response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body, upgraded: false }));
    });
    request.on('upgrade', (response, socket, head) => resolve(rawClient(response, socket, head)));
    request.on('error', reject);
    request.end();
  });
}

function rawClient(response, socket, head) {
  const parser = new FrameParser({ requireMask: false });
  const events = [];
  const waiters = new Set();
  let closed = false;
  let closing = false;
  const settle = () => {
    for (const waiter of [...waiters]) waiter.check();
  };
  const onData = chunk => {
    try {
      for (const event of parser.push(chunk)) {
        if (event.type === 'message') {
          try {
            event.data = JSON.parse(event.text);
          } catch {
            event.data = undefined;
          }
        }
        events.push(event);
        // Answer a server close like a browser does: echo the code and end the socket.
        if (event.type === 'close' && !closing) {
          closing = true;
          socket.end(encodeFrame(OPCODES.close, closePayload(event.code === 1005 ? undefined : event.code), { mask: true }));
        }
      }
    } catch (error) {
      events.push({ type: 'parse_error', error });
    }
    settle();
  };
  socket.on('data', onData);
  socket.on('close', () => {
    closed = true;
    settle();
  });
  socket.on('error', () => {});
  if (head?.length) onData(head);
  const client = {
    upgraded: true,
    status: response.statusCode,
    headers: response.headers,
    socket,
    events,
    get closed() {
      return closed;
    },
    sendRaw(buffer) {
      socket.write(buffer);
    },
    frame(opcode, payload, options = {}) {
      socket.write(encodeFrame(opcode, payload, { mask: true, ...options }));
    },
    send(value) {
      client.frame(OPCODES.text, Buffer.from(JSON.stringify(value)));
    },
    close(code = 1000, reason = '') {
      closing = true;
      client.frame(OPCODES.close, closePayload(code, reason));
    },
    // Resolves the first event (from the start of the connection) matching `predicate`, consuming it.
    next(predicate = () => true, ms = 2000) {
      return new Promise((resolve, reject) => {
        const waiter = {
          check() {
            const index = events.findIndex(event => predicate(event));
            if (index >= 0) {
              waiters.delete(waiter);
              clearTimeout(waiter.timer);
              resolve(events.splice(index, 1)[0]);
            } else if (closed && !waiter.allowClosed) {
              waiters.delete(waiter);
              clearTimeout(waiter.timer);
              reject(new Error('socket closed while waiting'));
            }
          },
        };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error('timed out waiting for a frame'));
        }, ms);
        waiters.add(waiter);
        waiter.check();
      });
    },
    message(predicate = () => true, ms) {
      return client.next(event => event.type === 'message' && predicate(event.data), ms).then(event => event.data);
    },
    waitClose(ms = 2000) {
      return new Promise((resolve, reject) => {
        if (closed) return resolve();
        const timer = setTimeout(() => reject(new Error('socket did not close')), ms);
        socket.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    destroy() {
      socket.destroy();
    },
  };
  return client;
}

/**
 * An observation as the extension's page script returns it, for a page of runtime-fixtures' PAGES (or any page
 * object with title, text and controls), including `blocks`, `blocksTruncated`, control bounds and the pass 3
 * contract fields: `consent` (null or {text, buttons:[{id, label, kind}]}), `warnings` (password_field,
 * login_wall, controls_capped) and `select` blocks for controls with options.
 */
export function fixtureObservation(path = '/', { revision = `doc:1`, pages = PAGES, tabId } = {}) {
  const page = pages[path];
  return {
    consent: page.consent ? structuredClone(page.consent) : null,
    warnings: [...(page.warnings ?? [])],
    revision,
    documentId: 'doc',
    ...(tabId === undefined ? {} : { tabId }),
    url: page.url ?? ORIGIN + path,
    title: page.title,
    text: page.text,
    textTruncated: false,
    blocks: blocksFor(page),
    blocksTruncated: page.blocksTruncated ?? false,
    controls: page.controls.map((control, index) => ({
      visible: true,
      bounds: { x: 10, y: 10 + index * 30, width: 120, height: 24 },
      ...control,
    })),
    viewport: { width: 1280, height: 800, dpr: 1 },
  };
}

/** A v3 extension on top of the raw client: ref'd requests, auto-answering commands, recorded pushes. */
export class FakeExtension {
  constructor(client) {
    this.client = client;
    this.ref = 0;
  }

  static async connect(options) {
    const client = await connectRaw(options);
    if (!client.upgraded) throw new Error(`upgrade rejected with ${client.status}`);
    return new FakeExtension(client);
  }

  send(type, body = {}) {
    this.client.send({ v: 3, type, ...body });
  }

  // Sends a ref'd message and resolves the reply {ok, data|error}.
  async request(type, body = {}) {
    const ref = String(++this.ref);
    this.client.send({ v: 3, type, ref, ...body });
    return this.client.message(message => message.type === 'reply' && message.ref === ref);
  }

  /** `extra`: further hello fields, such as `settings: {budget}` (an extension with the budget setting). */
  hello(session = null, extra = {}) {
    return this.request('hello', { ext: { version: '0.3.0', protocol: 3 }, session, ...extra });
  }

  lease({ requestId = null, tabId = 1, origin = 'https://example.com', title = 'Fixture' } = {}) {
    return this.request('lease', { requestId, tabId, origin, title });
  }

  command(ms) {
    return this.client.message(message => message.type === 'command', ms).then(message => message.command);
  }

  result(id, result) {
    this.send('result', { id, result });
  }

  error(id, code, message = code) {
    this.send('result', { id, error: { code, message, recoverable: false } });
  }

  close() {
    this.client.destroy();
  }
}
