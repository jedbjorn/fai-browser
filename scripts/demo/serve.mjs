// Explicit routes only: never expose the checkout, a profile or a settings file.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../..');
const routes = new Map(['index.html', 'cart.html', 'checkout.html', 'confirmed.html', 'keys.html', 'deploy.html', 'style.css', 'shop.js']
  .map(name => [`/${name}`, `fixtures/demo/${name}`]));
routes.set('/', 'fixtures/demo/index.html');
routes.set('/fakes.js', 'fixtures/secrets/fakes.js');
export async function startFixtures({ shopPort = 8765, keysPort = 8766 } = {}) {
  let payments = 0;
  const welcome = new Map();
  const servers = [];
  try {
    for (const port of [shopPort, keysPort]) {
      const server = http.createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const host = String(req.headers.host ?? '');
        if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(host)) {
          res.writeHead(403); return res.end('Loopback fixtures only');
        }
        const pathname = new URL(req.url, `http://${host}`).pathname;
        if (pathname === '/__demo__/pay' && req.method === 'POST' && port === shopPort) {
          if (req.headers.origin !== `http://${host}`) { res.writeHead(403); return res.end(); }
          payments++;
          res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"fixture":true}');
        }
        if (pathname === '/__demo__/state' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ payments }));
        }
        if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
        if (welcome.has(pathname)) {
          const { body, type } = welcome.get(pathname);
          res.writeHead(200, { 'Content-Type': type }); return res.end(req.method === 'HEAD' ? undefined : body);
        }
        const file = routes.get(pathname);
        if (!file) { res.writeHead(404); return res.end('Fixture not found'); }
        try {
          const body = await readFile(resolve(root, file));
          res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
          res.end(req.method === 'HEAD' ? undefined : body);
        } catch { res.writeHead(500); res.end('Fixture unavailable'); }
      });
      await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
      servers.push(server);
    }
  } catch (error) { for (const server of servers) server.close(); throw error; }
  return { shop: `http://127.0.0.1:${shopPort}`, keys: `http://127.0.0.1:${keysPort}`, deploy: `http://localhost:${keysPort}`,
    setWelcome: (html, icon) => {
      welcome.set('/welcome.html', { body: html, type: 'text/html; charset=utf-8' });
      welcome.set('/fai-browser.png', { body: icon, type: 'image/png' });
    },
    payments: () => payments, close: () => Promise.all(servers.map(s => new Promise(done => { s.closeAllConnections(); s.close(done); }))) };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const site = await startFixtures();
  console.log(`Demo fixtures: ${site.shop} · ${site.keys}/keys.html · ${site.deploy}/deploy.html`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await site.close(); process.exit(); });
}
