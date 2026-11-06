// A loopback static server for a fixture directory: "/dir/" serves dir/index.html, "/x" x.html when x is missing.
// Query strings and fragments are ignored; anything else is a 404.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function startStaticSite(root) {
  const server = http.createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(root, path));
    let found = null;
    if (file === root || file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      const options = path.endsWith('/') ? [join(file, 'index.html')] : [file, `${file}.html`, join(file, 'index.html')];
      for (const option of options) {
        if (await isFile(option)) {
          found = option;
          break;
        }
      }
    }
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Not found</title><h1>Not found</h1>');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(found)] ?? 'application/octet-stream' });
    res.end(await readFile(found));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise(resolve => server.close(resolve)) };
}
