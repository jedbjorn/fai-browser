// Several browsers paired with one daemon at once (issue #9): each extension connection has its own browser
// identity, commands go to the browser that holds the lease, a new tab request goes to the browser the user used
// last (or the one the agent names), and no connection ever closes another browser's.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHub } from '../src/bridge.js';
import { EXTENSION_ID, EXTENSION_ORIGIN, FakeExtension, SECRET } from './helpers/fake-extension.js';

const ORIGIN = 'https://example.com';
const FIREFOX_ORIGIN = 'moz-extension://0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, message = 'condition not met', ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await sleep(5);
  }
}

// A daemon-mode hub on its own server, with a recorded event and log stream; hello replies keep sessions.
async function hubServer(t, options = {}) {
  const logs = [];
  const events = [];
  const hub = createHub({ secret: SECRET, extensionId: EXTENSION_ID, log: (event, fields) => logs.push({ event, ...fields }),
    ...options });
  const server = http.createServer((req, res) => {
    if (hub.handleHttp(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (!hub.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  hub.onEvent(event => {
    events.push(event);
    if (event.type === 'hello') event.reply({ mode: 'daemon', endSession: false });
  });
  t.after(async () => {
    hub.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  });
  const port = server.address().port;
  const connect = async ({ origin = EXTENSION_ORIGIN, browser } = {}) => {
    const path = browser ? `/ext/ws?browser=${browser}` : '/ext/ws';
    const ext = await FakeExtension.connect({ port, origin, path });
    t.after(() => ext.close());
    return ext;
  };
  return { hub, port, logs, events, connect };
}

const closes = ext => ext.client.events.filter(event => event.type === 'close');

test('issue #9: two paired browsers (Chromium and Firefox) stay connected side by side, no 4000 ping-pong', async t => {
  const setup = await hubServer(t);
  const chromium = await setup.connect();
  await chromium.hello();
  const firefox = await setup.connect({ origin: FIREFOX_ORIGIN });
  await firefox.hello();
  await sleep(150);
  assert.deepEqual(closes(chromium), [], 'the first browser is not replaced by the second');
  assert.deepEqual(closes(firefox), []);
  assert.equal(setup.logs.filter(entry => entry.event === 'extension_ws_close').length, 0);
  // Both still answer on their own socket.
  chromium.send('ping');
  await chromium.client.message(message => message.type === 'pong');
  firefox.send('ping');
  await firefox.client.message(message => message.type === 'pong');
});
