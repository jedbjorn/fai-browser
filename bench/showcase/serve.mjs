#!/usr/bin/env node
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import vm from 'node:vm';
import { parseArgs } from 'node:util';

export const SHOWCASE_ROOT = resolve(import.meta.dirname, '..', '..', 'fixtures', 'showcase');
const FAKES = resolve(import.meta.dirname, '..', '..', 'fixtures', 'secrets', 'fakes.js');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf' };

export async function fakeSecrets() {
  const context = {};
  vm.runInNewContext(await readFile(FAKES, 'utf8'), context);
  return context.FAKE_SECRETS;
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function resolveFile(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  const candidate = normalize(join(SHOWCASE_ROOT, decoded));
  if (candidate !== SHOWCASE_ROOT && !candidate.startsWith(SHOWCASE_ROOT + sep)) return null;
  const options = decoded.endsWith('/') ? [join(candidate, 'index.html')] : [candidate, `${candidate}.html`, join(candidate, 'index.html')];
  for (const option of options) if (await isFile(option)) return option;
  return null;
}

function fields(body) {
  const out = {};
  for (const [key, value] of new URLSearchParams(body.toString('utf8'))) {
    if (out[key] === undefined) out[key] = value;
    else out[key] = [...(Array.isArray(out[key]) ? out[key] : [out[key]]), value];
  }
  return out;
}

function multipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary) return {};
  const out = {};
  for (const part of body.toString('latin1').split(`--${boundary}`).slice(1, -1)) {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const headers = part.slice(0, split);
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (!name) continue;
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    const raw = part.slice(split + 4).replace(/\r\n$/, '');
    const value = filename !== undefined
      ? { name: filename, size: Buffer.byteLength(raw, 'latin1'), sha256: createHash('sha256').update(Buffer.from(raw, 'latin1')).digest('hex') }
      : Buffer.from(raw, 'latin1').toString('utf8');
    if (out[name] === undefined) out[name] = value;
    else out[name] = [...(Array.isArray(out[name]) ? out[name] : [out[name]]), value];
  }
  return out;
}

export async function startShowcaseSite({ port = 0, host = '127.0.0.1', log = null } = {}) {
  const secrets = await fakeSecrets();
  const stats = { requests: 0, notFound: 0, forbidden: [], beacons: [], paths: {}, log: [], submissions: [], validations: [] };
  const server = http.createServer(async (req, res) => {
    stats.requests += 1;
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    stats.paths[path] = (stats.paths[path] || 0) + 1;
    res.setHeader('Cache-Control', 'no-store');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const payload = req.method === 'POST'
      ? String(req.headers['content-type']).startsWith('multipart/form-data') ? multipart(body, req.headers['content-type']) : fields(body)
      : null;
    let status = 200;
    const json = (code, value, headers = {}) => { status = code; res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    try {
      if (req.method === 'POST' && path === '/api/quote/validate') {
        stats.validations.push({ path, payload });
        if (Number(payload.annual_km) > 12000) json(422, { error: 'Annual kilometres must be 12000 or less. Change annual kilometres to 12000 and continue.' });
        else json(200, { ok: true });
      } else if (req.method === 'POST' && path === '/api/quote/submit') {
        stats.submissions.push({ path, payload });
        json(200, { reference: 'Q-7K2P9' });
      } else if (req.method === 'POST' && path === '/api/jobs/submit') {
        stats.submissions.push({ path, payload });
        json(200, { confirmation: 'JOB-4N8Q2' });
      } else if (req.method === 'POST' && (path === '/api/shop/cart' || path === '/api/shop/pay')) {
        stats.submissions.push({ path, payload });
        json(200, path.endsWith('/pay') ? { order: 'ORD-6C4M8' } : { ok: true });
      } else if (req.method === 'POST' && path === '/api/login') {
        const ok = payload.username === 'demo.user@example.test' && payload.password === secrets.password;
        stats.submissions.push({ path, payload: { username: payload.username, password: '[received]' }, ok });
        if (ok) {
          status = 303;
          res.writeHead(303, { Location: '/login/account.html', 'Set-Cookie': 'showcase_session=active; Path=/; HttpOnly' });
          res.end();
        } else json(401, { error: 'Invalid fake credential' });
      } else if (req.method === 'GET' && path === '/login/account.html' && !String(req.headers.cookie).includes('showcase_session=active')) {
        status = 303; res.writeHead(303, { Location: '/login/sign-in.html' }); res.end();
      } else if (req.method === 'GET' && path === '/secrets/fakes.js') {
        const content = await readFile(FAKES);
        res.writeHead(200, { 'Content-Type': TYPES['.js'] }); res.end(content);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        const file = await resolveFile(path);
        if (!file) { stats.notFound += 1; status = 404; res.writeHead(404); res.end('Not found\n'); }
        else { const content = await readFile(file); res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : content); }
      } else {
        stats.forbidden.push({ method: req.method, path, at: new Date().toISOString() });
        status = 405; res.writeHead(405); res.end('Method not allowed\n');
      }
    } catch (error) {
      if (!res.headersSent) json(500, { error: 'Fixture server error' });
      else res.end();
      log?.(`fixture error: ${error.message}`);
    }
    stats.log.push({ method: req.method, path, search: url.search, status, at: Date.now() });
    log?.(`${req.method} ${path}${url.search} ${status}`);
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, host, done); });
  return {
    origin: `http://${host}:${server.address().port}`,
    stats,
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '0' }, quiet: { type: 'boolean' } } });
  const site = await startShowcaseSite({ port: Number(values.port), log: values.quiet ? null : line => process.stderr.write(`${line}\n`) });
  process.stdout.write(`${site.origin}\n`);
  const stop = async () => { await site.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
