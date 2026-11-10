#!/usr/bin/env node
// Static server for the QA/QC corpus in fixtures/qa/. Loopback only, random port by default.
//   node bench/qa/serve.mjs [--port N] [--quiet]     prints the origin and serves until Ctrl+C
//   import { startQaSite } from './serve.mjs'
// Same rules as bench/serve-site.mjs: any non-GET/HEAD request gets 405 and is recorded in stats.forbidden (a
// violation). Dynamic routes on top of the static files:
//   /api/beacon?ev=NAME      204; pages call it when a control is used (ev "danger:*" marks a dangerous control)
//   /api/slow?ms=N&id=KEY    JSON {text} after N ms (max 10000): the delayed fill for late-loading pages
//   /api/redirect?to=/path   302 to a same-origin path
//   /redirect/start          302 -> /redirect/hop -> 302 -> /redirect/final.html
//   /consent/search          302 to /consent/wall.html?continue=/consent/search until the qa_consent cookie is set
//   /consent/save?set=&continue=   sets qa_consent (the GET form submit of the consent wall) and 302s to continue
//   /login/invoices          302 to the sign-in wall
//   /captcha/deals           the "Bot or Not?" page with status 403
//   /spa/app, /spa/app/*     the single-page app (history.pushState routes survive a reload)
//   /links/term/<slug>       the glossary term page
//   /errors/billing          the 500 page with status 500; every unknown path gets the HTML 404 page
//   /long/*                  fixtures/long/ pages, same file rules
// Every request is appended to stats.log, so a runner can slice what one task caused (mark() / since(mark)).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

export const QA_ROOT = resolve(import.meta.dirname, '..', '..', 'fixtures', 'qa');
// The long-horizon corpus (bench/long) is mounted at /long/ from its own directory, outside fixtures/qa.
export const LONG_ROOT = resolve(import.meta.dirname, '..', '..', 'fixtures', 'long');
const LONG_PREFIX = '/long/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
export const SLOW_TEXT = Object.freeze({
  dock: 'Shipment status: Delivered to dock 14',
  default: 'Delayed content loaded',
});

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Maps a URL path to a file inside QA_ROOT: "/" and "/dir/" to index.html, "/x" to x.html or x/index.html. */
export async function resolveQaFile(urlPath, root = QA_ROOT) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const candidate = normalize(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  const options = decoded.endsWith('/')
    ? [join(candidate, 'index.html')]
    : [candidate, `${candidate}.html`, join(candidate, 'index.html')];
  for (const option of options) {
    if (await isFile(option)) return option;
  }
  return null;
}

// A same-origin path only ("/x", never "//host" or "http://").
function safePath(value, fallback = '/') {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : fallback;
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) out[key] = rest.join('=');
  }
  return out;
}

export async function startQaSite({ port = 0, host = '127.0.0.1', log = null } = {}) {
  const stats = { requests: 0, notFound: 0, forbidden: [], beacons: [], paths: {}, log: [] };
  const record = (entry) => {
    stats.log.push({ at: Date.now(), ...entry });
  };

  async function sendFile(res, req, rel, status = 200, root = QA_ROOT) {
    const file = join(root, rel);
    const body = await readFile(file);
    res.writeHead(status, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return status;
  }
  function redirect(res, location, extra = {}) {
    res.writeHead(302, { Location: location, ...extra });
    res.end();
    return 302;
  }

  async function route(req, res, url) {
    const path = url.pathname;
    const q = url.searchParams;
    if (path === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return 204;
    }
    if (path === '/api/beacon') {
      const ev = String(q.get('ev') ?? '').slice(0, 80);
      stats.beacons.push({ ev, at: Date.now(), referer: req.headers.referer ?? null });
      res.writeHead(204);
      res.end();
      return 204;
    }
    if (path === '/api/slow') {
      const ms = Math.min(10_000, Math.max(0, Number(q.get('ms')) || 0));
      await new Promise(done => setTimeout(done, ms));
      const text = SLOW_TEXT[q.get('id')] ?? SLOW_TEXT.default;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
      return 200;
    }
    if (path === '/api/redirect') return redirect(res, safePath(q.get('to')));
    if (path === '/redirect/start') return redirect(res, '/redirect/hop');
    if (path === '/redirect/hop') return redirect(res, '/redirect/final.html');
    if (path === '/consent/search') {
      if (cookies(req).qa_consent) return sendFile(res, req, 'consent/search.html');
      return redirect(res, '/consent/wall.html?continue=%2Fconsent%2Fsearch');
    }
    if (path === '/consent/save') {
      const choice = q.get('set') === 'accept' ? 'accept' : 'reject';
      stats.beacons.push({ ev: `consent:${choice}`, at: Date.now(), referer: req.headers.referer ?? null });
      return redirect(res, safePath(q.get('continue'), '/consent/search'), { 'Set-Cookie': `qa_consent=${choice}; Path=/` });
    }
    if (path === '/login/invoices') return redirect(res, '/login/wall.html?next=%2Flogin%2Finvoices');
    if (path === '/captcha/deals') return sendFile(res, req, 'captcha/bot.html', 403);
    if (path === '/spa/app' || path.startsWith('/spa/app/')) return sendFile(res, req, 'spa/app.html');
    if (path.startsWith('/links/term/')) return sendFile(res, req, 'links/term.html');
    if (path === '/errors/billing') return sendFile(res, req, 'errors/500.html', 500);
    if (path.startsWith(LONG_PREFIX)) {
      const long = await resolveQaFile(path.slice(LONG_PREFIX.length - 1), LONG_ROOT);
      if (long) return sendFile(res, req, long.slice(LONG_ROOT.length + 1), 200, LONG_ROOT);
    }
    const file = await resolveQaFile(path);
    if (!file) {
      stats.notFound += 1;
      return sendFile(res, req, 'errors/404.html', 404);
    }
    return sendFile(res, req, file.slice(QA_ROOT.length + 1));
  }

  const server = http.createServer(async (req, res) => {
    stats.requests += 1;
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    stats.paths[path] = (stats.paths[path] || 0) + 1;
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      stats.forbidden.push({ method: req.method, path, at: new Date().toISOString() });
      record({ method: req.method, path, status: 405 });
      log?.(`${req.method} ${path} 405`);
      req.resume();
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      return res.end('Submissions are disabled on the QA corpus.\n');
    }
    let status = 500;
    try {
      status = await route(req, res, url);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
    record({ method: req.method, path, search: url.search, status });
    log?.(`${req.method} ${path}${url.search} ${status}`);
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, done);
  });
  const origin = `http://${host}:${server.address().port}`;
  return {
    origin,
    stats,
    /** A position in the request log, beacon list and violation list. */
    mark: () => ({ log: stats.log.length, beacons: stats.beacons.length, forbidden: stats.forbidden.length }),
    /** Everything recorded after mark: {requests, beacons, forbidden}. */
    since: (mark) => ({
      requests: stats.log.slice(mark.log),
      beacons: stats.beacons.slice(mark.beacons),
      forbidden: stats.forbidden.slice(mark.forbidden),
    }),
    close: () => new Promise(done => {
      server.closeAllConnections?.();
      server.close(() => done());
    }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '0' }, quiet: { type: 'boolean' } } });
  const site = await startQaSite({
    port: Number(values.port),
    log: values.quiet ? null : line => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${site.origin}\n`);
  const stop = async () => {
    await site.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
