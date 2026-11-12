#!/usr/bin/env node
// Native messaging host (see src/native.js for the manifests that let a browser start it). The browser starts this
// process for the FAI Browser extension only and speaks the native messaging protocol on stdin/stdout: each message
// is a 32-bit length in native byte order (little-endian on every supported platform) followed by that much UTF-8
// JSON. Stdout carries protocol frames only; nothing is ever logged, and the secret only ever goes to stdout.
//
// Requests:
//   {"type":"ping"}  -> {"ok":true,"version"}                       (never starts anything)
//   {"type":"pair"}  -> {"ok":true,"endpoint","secret","version"}   starts the FAI service when it is not running
// Any failure is {"ok":false,"error":<code>,"message"} without a secret.
//
// The caller check: a Chromium-family browser passes the caller's origin ("chrome-extension://<id>/") as the first
// argument, Firefox passes the manifest path and the add-on ID. Anything other than the paired extension is refused,
// on top of the browser's own allowed_origins / allowed_extensions check.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT, installedByInstaller } from './paths.js';
import { homePaths } from './home.js';
import { PINNED_EXTENSION_ID } from './bridge.js';
import { readEnvFile } from './settings.js';
import { GECKO_IDS } from './native.js';

const MAX_MESSAGE = 64 * 1024;

function version() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

/** True when the browser's arguments name the paired extension. */
export function callerAllowed(args, { extensionId = PINNED_EXTENSION_ID } = {}) {
  const list = Array.isArray(args) ? args.map(String) : [];
  if (list.includes(`chrome-extension://${extensionId}/`)) return true;
  // Firefox: argv = [manifest path, add-on ID].
  return list.length >= 2 && GECKO_IDS.includes(list[1]);
}

/** One length-prefixed frame. */
export function encodeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Splits `buffer` into complete messages: `{ messages, rest }`; throws on an oversized or malformed frame. */
export function decodeMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (length > MAX_MESSAGE) throw new Error('message_too_large');
    if (buffer.length - offset - 4 < length) break;
    messages.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString('utf8')));
    offset += 4 + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

/** How to (re)run setup for this copy: the Windows installer's, or a checkout's. */
function setupHint() {
  return installedByInstaller() ? 'Run the FAI Browser install command again (README, Windows)'
    : 'Run npm run setup in the fai-browser folder';
}

/**
 * Answer one request. `ensure` starts or finds the FAI service (src/client.js ensureDaemon); injected by tests.
 */
export async function handleMessage(message, { env = process.env, ensure } = {}) {
  const type = message?.type;
  if (type === 'ping') return { ok: true, version: version() };
  if (type !== 'pair') return { ok: false, error: 'unsupported', message: 'Unknown request' };
  const paths = homePaths({ env });
  let port;
  try {
    const ensureDaemon = ensure ?? (await import('./client.js')).ensureDaemon;
    // On Windows ensureDaemon starts the service outside this helper's job, which Firefox kills when the helper exits.
    ({ port } = await ensureDaemon({ env, autoStart: true }));
  } catch (error) {
    return { ok: false, error: error?.code === 'port_in_use' ? 'port_in_use' : 'service_unavailable',
      message: `The FAI service could not start. ${setupHint()} (log: ${paths.logFile}).` };
  }
  let secret;
  try {
    // FAI_BRIDGE_SECRET in the environment wins, as it does for the service itself.
    secret = env.FAI_BRIDGE_SECRET || readEnvFile(paths.envFile).FAI_BRIDGE_SECRET;
  } catch {
    secret = null;
  }
  if (!secret) {
    return { ok: false, error: 'not_set_up', message: `No pairing secret yet. ${setupHint()}.` };
  }
  return { ok: true, endpoint: `http://127.0.0.1:${port}`, secret, version: version() };
}

function extensionIdFor(env) {
  try {
    return readEnvFile(homePaths({ env }).envFile).FAI_EXTENSION_ID || PINNED_EXTENSION_ID;
  } catch {
    return PINNED_EXTENSION_ID;
  }
}

/** Serve stdin until it closes. */
export function serve({ args = process.argv.slice(2), env = process.env, input = process.stdin, output = process.stdout,
  ensure } = {}) {
  const allowed = callerAllowed(args, { extensionId: extensionIdFor(env) });
  let buffer = Buffer.alloc(0);
  let chain = Promise.resolve();
  // Resolves once the frame is flushed, so exiting afterwards never truncates it.
  const reply = value => new Promise(resolve => output.write(encodeMessage(value), () => resolve()));
  input.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    let decoded;
    try {
      decoded = decodeMessages(buffer);
    } catch {
      chain = chain.then(() => reply({ ok: false, error: 'bad_message', message: 'Malformed message' }));
      input.destroy();
      return;
    }
    buffer = decoded.rest;
    for (const message of decoded.messages) {
      chain = chain.then(async () => {
        if (!allowed) {
          await reply({ ok: false, error: 'forbidden', message: 'This host answers the FAI Browser extension only' });
          return;
        }
        await reply(await handleMessage(message, { env, ensure }).catch(() => ({ ok: false, error: 'internal', message: 'Internal error' })));
      });
    }
  });
  return new Promise(resolve => {
    input.on('end', () => chain.then(resolve));
    input.on('close', () => chain.then(resolve));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await serve();
  // A detached FAI service started for this request must not keep the host alive.
  process.exit(0);
}
