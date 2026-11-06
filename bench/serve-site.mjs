#!/usr/bin/env node
// Static server for the deterministic benchmark site in fixtures/site/. Loopback only, random port by default.
//   node bench/serve-site.mjs [--port N]     prints the origin and serves until Ctrl+C
//   import { startSite } from './serve-site.mjs'
// Any non-GET/HEAD request (for example submitting the contact form) gets 405 and is counted in stats.forbidden,
// so the runner can flag a run that tried to submit something.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

export const SITE_ROOT = resolve(import.meta.dirname, '..', 'fixtures', 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript' };

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// Maps a URL path to a file inside SITE_ROOT: "/" and "/dir/" to index.html, "/slow" to slow.html.
async function resolveFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const candidate = normalize(join(SITE_ROOT, decoded));
  if (candidate !== SITE_ROOT && !candidate.startsWith(SITE_ROOT + sep)) {
    return null;
  }
  const options = decoded.endsWith('/')
    ? [join(candidate, 'index.html')]
    : [candidate, `${candidate}.html`, join(candidate, 'index.html')];
  for (const option of options) {
    if (await isFile(option)) {
      return option;
    }
  }
  return null;
}

export async function startSite({ port = 0, host = '127.0.0.1', log = null } = {}) {
  const stats = { requests: 0, notFound: 0, forbidden: [], paths: {} };
  const server = http.createServer(async (req, res) => {
    stats.requests += 1;
    const path = new URL(req.url, 'http://x').pathname;
    stats.paths[path] = (stats.paths[path] || 0) + 1;
    log?.(`${req.method} ${path}`);
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      stats.forbidden.push({ method: req.method, path, at: new Date().toISOString() });
      req.resume();
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      return res.end('Submissions are disabled on the benchmark site.\n');
    }
    if (path === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    const file = await resolveFile(path);
    if (!file) {
      stats.notFound += 1;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found\n');
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, done);
  });
  const origin = `http://${host}:${server.address().port}`;
  return {
    origin,
    stats,
    close: () => new Promise(done => {
      server.closeAllConnections?.();
      server.close(() => done());
    }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '0' }, quiet: { type: 'boolean' } } });
  const site = await startSite({
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
