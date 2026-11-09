import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PINNED_EXTENSION_ID } from '../src/bridge.js';

const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');

test('worker restart never sends saved pairing token to an invalid draft endpoint', async () => {
  const endpoints = [
    'https://example.com',
    'http://localhost:4318',
    'http://user:pass@127.0.0.1:4318',
    'not a URL',
    'http://127.0.0.1:4318',
  ];
  for (const endpoint of endpoints) {
    const requests = [];
    const sockets = [];
    const event = { addListener() {} };
    const chrome = {
      storage: {
        local: {
          async get() {
            return { endpoint, secret: 'fixture-pairing-token' };
          },
          async set() {},
        },
        session: { async get() {} },
      },
      action: { async setBadgeText() {} },
      runtime: { onMessage: event },
      tabs: { onCreated: event, onActivated: event, onRemoved: event, onUpdated: event },
    };
    vm.runInNewContext(background, {
      chrome,
      URL,
      setInterval() {},
      setTimeout() {},
      clearTimeout() {},
      WebSocket: class {
        constructor(url, protocols) {
          sockets.push({ url, protocols: [...protocols] });
        }
      },
      fetch: async (url, options) => {
        requests.push({ url, options });
        return {};
      },
    });
    // A few turns: the worker reads (and creates) its browser identity before it connects.
    for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 0, `no HTTP request on startup: ${endpoint}`);
    if (endpoint === 'http://127.0.0.1:4318') {
      // The restarted worker reconnects; its hello (session:null) tells the companion to pause the old lease.
      // The URL names this install's browser identity (several browsers may be paired, issue #9).
      assert.equal(sockets.length, 1);
      assert.match(sockets[0].url, /^ws:\/\/127\.0\.0\.1:4318\/ext\/ws\?browser=b-[A-Za-z0-9]{8,24}$/);
      assert.deepEqual(sockets[0].protocols, ['fai-browser.v3', 'fai-auth.fixture-pairing-token']);
    } else {
      assert.equal(sockets.length, 0, `Invalid saved endpoint contacted: ${endpoint}`);
    }
  }
});

test('manifest pins the extension ID and narrows host access to the companion origin', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:4318/*']);
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('alarms'));
  assert.equal(manifest.permissions.includes('tabs'), false);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  // Domain roots: the popup may request https://*.<root>/* at approval time, never <all_urls>; opening a request's
  // page needs no host permission (the toolbar icon click on it is the approval).
  // http://*/* only for "Allow on all sites" (Advanced), the one choice that requests every site at once.
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
  assert.match(manifest.key, /^[A-Za-z0-9+/]+=*$/);
  // Chrome derives the ID from the first 128 bits of SHA-256 over the DER public key, hex digits mapped to a-p.
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const id = [...digest].map(digit => String.fromCharCode(97 + parseInt(digit, 16))).join('');
  assert.equal(id, 'ikkpdnokohfcjhfidepcledkbepmkfcm');
  assert.equal(PINNED_EXTENSION_ID, id);
});
