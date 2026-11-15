import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { pipeOrSocket } from './helpers/pipe-or-socket.js';

test('shared endpoint helper: isolated pipe/socket endpoints carry data on this platform', async t => {
  const one = await pipeOrSocket(t, '4242.sock');
  const two = await pipeOrSocket(t, '4242.sock');
  assert.notEqual(one.path, two.path);
  const server = createServer(socket => socket.end('hello from the host'));
  await new Promise((resolve, reject) => server.once('error', reject).listen(one.path, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const text = await new Promise((resolve, reject) => {
    let answer = '';
    const socket = connect(one.path);
    socket.setEncoding('utf8');
    socket.on('data', chunk => { answer += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolve(answer));
  });
  assert.equal(text, 'hello from the host');
});
