import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { AUTOMATIC_POPUPS_POLICY } from '../src/automatic-popups.js';
import { call } from './helpers/fake-hub.js';
import { EXTENSION_ID, FakeExtension, SECRET } from './helpers/fake-extension.js';
import { ORIGIN } from './runtime-fixtures.js';

test('popup scope crosses the authenticated extension transport only and legacy reapproval removes it', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-popup-grants-'));
  const daemon = createDaemon({ home, env: { FAI_BRIDGE_SECRET: SECRET, FAI_EXTENSION_ID: EXTENSION_ID }, port: 0 });
  await daemon.listen();
  const ext = await FakeExtension.connect({ port: daemon.port });
  t.after(async () => {
    ext.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  assert.equal((await ext.hello()).ok, true);
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  const request = { origins: [ORIGIN], mode: 'read-only', reason: 'Read this page' };
  const forged = await api('POST', '/v1/requests', { ...request, automaticPopups: AUTOMATIC_POPUPS_POLICY });
  assert.equal(forged.status, 400, 'the host cannot mint the scope');
  const created = await api('POST', '/v1/requests', request);
  assert.equal(created.status, 201);
  const approval = { requestId: created.body.requestId, tabId: 1, origin: ORIGIN, level: 'read-only' };
  const granted = await ext.request('lease', { ...approval, automaticPopups: AUTOMATIC_POPUPS_POLICY });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  assert.equal(granted.data.grant.automaticPopups, AUTOMATIC_POPUPS_POLICY);
  assert.equal(granted.data.grant.level, 'read-only');
  const status = await api('GET', '/v1/status');
  assert.equal(status.body.requests.find(item => item.requestId === approval.requestId).grant.automaticPopups,
    AUTOMATIC_POPUPS_POLICY);
  const legacy = await ext.request('lease', approval);
  assert.equal(legacy.ok, true, JSON.stringify(legacy));
  assert.equal(legacy.data.grant.automaticPopups, undefined);
  const unknown = await ext.request('lease', { ...approval, automaticPopups: 'necessary-newsletter-v2' });
  assert.equal(unknown.data.grant.automaticPopups, undefined);
  const invited = await ext.request('invite', { tabId: 2, origin: ORIGIN, level: 'read-only',
    automaticPopups: AUTOMATIC_POPUPS_POLICY, text: 'Read this page' });
  assert.equal(invited.ok, true, JSON.stringify(invited));
  assert.equal(invited.data.grant.automaticPopups, AUTOMATIC_POPUPS_POLICY);
  assert.ok(invited.data.invite.inviteId);
});
