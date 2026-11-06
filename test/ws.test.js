// RFC 6455 server (src/ws.js): handshake, framing rules, control frames, timers, and interop with Node's WebSocket.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { acceptKey, acceptUpgrade, encodeFrame, FrameParser, OPCODES } from '../src/ws.js';
import { createHub } from '../src/bridge.js';
import { EXTENSION_ID, EXTENSION_ORIGIN, SECRET, connectRaw } from './helpers/fake-extension.js';

// An echo server on an ephemeral port. Text messages are echoed back; closes are recorded.
async function echoServer(t, options = {}) {
  const connections = [];
  const closes = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const connection = acceptUpgrade(req, socket, head, { protocol: 'echo.v1', ...options });
    if (!connection) return;
    connections.push(connection);
    connection.on('message', text => connection.sendText(text));
    connection.on('close', info => closes.push(info));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    for (const connection of connections) connection.terminate();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  });
  const connect = (extra = {}) => connectRaw({ port: server.address().port, path: '/', protocols: ['echo.v1'], ...extra });
  return { server, connections, closes, connect };
}

const closeFrame = event => event.type === 'close';

// The server emits 'close' when its side of the socket is gone, slightly after the client sees the close.
async function closed(closes, count = 1) {
  for (let i = 0; i < 200 && closes.length < count; i++) await new Promise(resolve => setTimeout(resolve, 5));
  return closes[count - 1];
}

test('handshake: RFC accept vector, chosen subprotocol, no extensions', async t => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  const { connect } = await echoServer(t);
  const client = await connect({ headers: { 'Sec-WebSocket-Extensions': 'permessage-deflate' } });
  assert.equal(client.status, 101);
  assert.equal(client.headers['sec-websocket-protocol'], 'echo.v1');
  assert.equal(client.headers['sec-websocket-extensions'], undefined, 'permessage-deflate is never negotiated');
  client.destroy();
});

test('handshake: invalid version or key is rejected without upgrading', async t => {
  const { connect, connections } = await echoServer(t);
  const version = await connect({ headers: { 'Sec-WebSocket-Version': '12' } });
  assert.equal(version.upgraded, false);
  assert.equal(version.status, 426);
  const key = await connect({ headers: { 'Sec-WebSocket-Key': 'short' } });
  assert.equal(key.status, 400);
  assert.equal(connections.length, 0);
});

test('text messages round-trip masked in, unmasked out, with 7, 16 and 64-bit lengths', async t => {
  const { connect } = await echoServer(t);
  const client = await connect();
  for (const size of [5, 125, 126, 300, 65_535, 70_000]) {
    const text = 'x'.repeat(size - 2) + 'é';
    client.frame(OPCODES.text, Buffer.from(text));
    const event = await client.next(e => e.type === 'message' || e.type === 'parse_error');
    assert.equal(event.type, 'message', `size ${size}`);
    assert.equal(event.text, text);
  }
  client.destroy();
});

test('fragmented messages are reassembled, with a ping between fragments', async t => {
  const { connect } = await echoServer(t);
  const client = await connect();
  client.frame(OPCODES.text, Buffer.from('{"a":'), { fin: false });
  client.frame(OPCODES.ping, Buffer.from('mid'));
  client.frame(OPCODES.continuation, Buffer.from('"frag'), { fin: false });
  client.frame(OPCODES.continuation, Buffer.from('ment"}'), { fin: true });
  const pong = await client.next(e => e.type === 'pong');
  assert.equal(pong.payload.toString(), 'mid');
  const message = await client.next(e => e.type === 'message');
  assert.deepEqual(JSON.parse(message.text), { a: 'fragment' });
  client.destroy();
});

test('frames split across TCP writes are parsed', async t => {
  const { connect } = await echoServer(t);
  const client = await connect();
  const frame = encodeFrame(OPCODES.text, Buffer.from('split-frame-payload'), { mask: true });
  for (const byte of frame) client.sendRaw(Buffer.from([byte]));
  assert.equal((await client.next(e => e.type === 'message')).text, 'split-frame-payload');
  client.destroy();
});

const violations = [
  ['unmasked client frame', client => client.frame(OPCODES.text, Buffer.from('hi'), { mask: false }), 1002],
  ['RSV bit set', client => client.frame(OPCODES.text, Buffer.from('hi'), { rsv: 4 }), 1002],
  ['unknown opcode', client => client.frame(3, Buffer.from('hi')), 1002],
  ['fragmented control frame', client => client.frame(OPCODES.ping, Buffer.from('hi'), { fin: false }), 1002],
  ['oversized control frame', client => client.frame(OPCODES.ping, Buffer.alloc(126)), 1002],
  ['continuation without a message', client => client.frame(OPCODES.continuation, Buffer.from('hi')), 1002],
  ['binary message', client => client.frame(OPCODES.binary, Buffer.from([1, 2, 3])), 1003],
  ['invalid UTF-8', client => client.frame(OPCODES.text, Buffer.from([0xc3, 0x28])), 1007],
  ['oversize message', client => client.frame(OPCODES.text, Buffer.alloc(2048, 0x61)), 1009],
  ['oversize fragmented message', client => {
    client.frame(OPCODES.text, Buffer.alloc(800, 0x61), { fin: false });
    client.frame(OPCODES.continuation, Buffer.alloc(800, 0x61), { fin: true });
  }, 1009],
];

for (const [name, misbehave, code] of violations) {
  test(`protocol violation closes the connection: ${name} -> ${code}`, async t => {
    const { connect, closes } = await echoServer(t, { maxMessageBytes: 1024 });
    const client = await connect();
    misbehave(client);
    const close = await client.next(closeFrame);
    assert.equal(close.code, code);
    assert.equal(client.events.some(event => event.type === 'message'), false);
    client.close(code);
    await client.waitClose();
    assert.equal((await closed(closes))?.code, code);
  });
}

test('close handshake echoes the peer code', async t => {
  const { connect, closes } = await echoServer(t);
  const client = await connect();
  client.close(4002, 'bye');
  assert.equal((await client.next(closeFrame)).code, 4002);
  await client.waitClose();
  assert.deepEqual(await closed(closes), { code: 4002, reason: 'bye' });

  // A close without a status code is answered with an empty close frame.
  const second = await connect();
  second.frame(OPCODES.close, Buffer.alloc(0));
  assert.equal((await second.next(closeFrame)).code, 1005);
  await second.waitClose();
  assert.equal((await closed(closes, 2)).code, 1005);
});

test('server close(code) reaches the client and finishes after the reply', async t => {
  const { connect, connections, closes } = await echoServer(t);
  const client = await connect();
  await new Promise(resolve => setTimeout(resolve, 20));
  connections[0].close(4000, 'replaced');
  const close = await client.next(closeFrame);
  assert.equal(close.code, 4000);
  assert.equal(close.reason, 'replaced');
  client.close(4000);
  await client.waitClose();
  assert.equal((await closed(closes)).code, 4000);
});

test('ping is answered with the same payload; the server pings on its interval', async t => {
  const { connect } = await echoServer(t, { pingIntervalMs: 40 });
  const client = await connect();
  client.frame(OPCODES.ping, Buffer.from('hello'));
  assert.equal((await client.next(e => e.type === 'pong')).payload.toString(), 'hello');
  await client.next(e => e.type === 'ping', 500);
  client.destroy();
});

test('a socket with no inbound frame for idleTimeoutMs is terminated', async t => {
  const { connect, closes } = await echoServer(t, { idleTimeoutMs: 120, pingIntervalMs: 10_000 });
  const client = await connect();
  const started = Date.now();
  await client.waitClose(2000);
  assert.ok(Date.now() - started >= 100);
  assert.equal((await closed(closes)).code, 1006);
});

test('FrameParser decodes server frames for clients and rejects masked server frames', () => {
  const parser = new FrameParser({ requireMask: false });
  const [event] = parser.push(encodeFrame(OPCODES.text, Buffer.from('ok')));
  assert.deepEqual(event, { type: 'message', text: 'ok' });
  assert.throws(() => new FrameParser({ requireMask: false }).push(encodeFrame(OPCODES.text, 'x', { mask: true })),
    error => error.closeCode === 1002);
});

// --- authentication before the upgrade (through the hub) -------------------------------------------------

async function hubServer(t) {
  const hub = createHub({ secret: SECRET, extensionId: EXTENSION_ID });
  const server = http.createServer((req, res) => {
    if (!hub.handleHttp(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  server.on('upgrade', (req, socket, head) => {
    if (!hub.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    hub.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  });
  return { hub, port: server.address().port };
}

test('upgrade is refused with 403 before any socket exists for a bad Origin or secret', async t => {
  const { hub, port } = await hubServer(t);
  const cases = [
    { origin: 'https://evil.test' },
    { origin: null },
    { protocols: ['fai-browser.v3', `fai-auth.${'x'.repeat(SECRET.length)}`] },
    { protocols: ['fai-browser.v3', `fai-auth.${SECRET}extra`] },
    { protocols: ['fai-browser.v3'] },
    { protocols: [] },
  ];
  for (const options of cases) {
    const result = await connectRaw({ port, ...options });
    assert.equal(result.upgraded, false, JSON.stringify(options));
    assert.equal(result.status, 403, JSON.stringify(options));
  }
  const missingProtocol = await connectRaw({ port, protocols: [`fai-auth.${SECRET}`] });
  assert.equal(missingProtocol.status, 400);
  assert.equal(hub.extension().connected, false, 'no rejected attempt may count as a connection');
  const accepted = await connectRaw({ port });
  assert.equal(accepted.status, 101);
  assert.equal(accepted.headers['sec-websocket-protocol'], 'fai-browser.v3');
  accepted.destroy();
});

test('interop: Node\'s built-in WebSocket client connects, negotiates fai-browser.v3 and exchanges messages', async t => {
  const { hub, port } = await hubServer(t);
  hub.onEvent(event => {
    if (event.type === 'hello') event.reply({ mode: 'daemon', endSession: false });
  });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ext/ws`, {
    protocols: ['fai-browser.v3', `fai-auth.${SECRET}`],
    headers: { Origin: EXTENSION_ORIGIN },
  });
  t.after(() => socket.close());
  const messages = [];
  socket.onmessage = event => messages.push(JSON.parse(event.data));
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('WebSocket failed to open'));
  });
  assert.equal(socket.protocol, 'fai-browser.v3');
  assert.equal(socket.extensions, '');
  socket.send(JSON.stringify({ v: 3, type: 'hello', ref: '1', ext: { version: '0.3.0', protocol: 3 }, session: null }));
  socket.send(JSON.stringify({ v: 3, type: 'ping' }));
  for (let i = 0; i < 100 && messages.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(messages[0], { v: 3, type: 'reply', ref: '1', ok: true, data: { mode: 'daemon', endSession: false } });
  assert.deepEqual(messages[1], { v: 3, type: 'requests', requests: [] });
  assert.deepEqual(messages[2], { v: 3, type: 'pong' });
  assert.equal(hub.extension().transport, 'websocket');
  assert.equal(hub.extension().version, '0.3.0');
});
