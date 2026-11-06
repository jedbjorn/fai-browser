// The browser + daemon session shared by the corpus runners (bench/qa/run.mjs, bench/long/run.mjs): headless Chromium
// with a copy of the extension whose manifest grants <all_urls> (the test manifest of bench/fai-condition.mjs), an
// isolated daemon (scratch FAI_DAEMON_DIR, random FAI_BRIDGE_PORT, disposable pairing secret; FAI_HOME comes from the
// environment, by default the package root, so the daemon loads the Jev key itself and the user's daemon on 4318 is
// untouched), the SDK client and the paired popup.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { headlessEnv } from '../../scripts/headless-env.mjs';
import { ROOT } from './lib.mjs';
import { TREE, treeImport } from './tree.mjs';

export const VIEWPORT = { width: 1280, height: 900 };
export const sleep = ms => new Promise(done => setTimeout(done, ms));

/** Write domains/_templates/qa-fixture.json with {{ORIGIN}} replaced into `dir`/<origin slug>/profile.json. */
export async function writeFixtureProfile(dir, origin) {
  const { originSlug, compileProfile } = await import('../../src/domains.js');
  const text = (await readFile(join(ROOT, 'domains', '_templates', 'qa-fixture.json'), 'utf8')).replaceAll('{{ORIGIN}}', origin);
  compileProfile(JSON.parse(text));
  await mkdir(join(dir, originSlug(origin)), { recursive: true });
  await writeFile(join(dir, originSlug(origin), 'profile.json'), text);
  return dir;
}

export async function makeSession(scratch, log, domainsDir = null, { clientName = 'qa-run' } = {}) {
  const { FaiRun } = await import('../fai-condition.mjs');
  class QaSession extends FaiRun {
    // FaiRun.setup without the start page and MCP warm-up: the runner talks to the daemon through the SDK client.
    async setup() {
      await mkdir(this.daemonDir, { recursive: true });
      const net = await import('node:net');
      this.port = await new Promise((done, fail) => {
        const server = net.createServer();
        server.once('error', fail);
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          server.close(() => done(port));
        });
      });
      this.endpoint = `http://127.0.0.1:${this.port}`;
      this.env = { FAI_BRIDGE_PORT: String(this.port), FAI_BRIDGE_SECRET: this.secret, FAI_DAEMON_DIR: this.daemonDir, FAI_BENCH: '1' };
      // --profile: the daemon reads site profiles from the scratch directory holding the materialized fixture profile.
      if (domainsDir) this.env.FAI_DOMAINS_DIR = domainsDir;
      const extension = join(this.scratch, 'extension');
      await cp(join(TREE, 'extension'), extension, { recursive: true });
      const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
      manifest.host_permissions = ['<all_urls>'];
      await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
      const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
      this.context = await chromium.launchPersistentContext(join(this.scratch, 'profile'), {
        executablePath: this.chromiumPath,
        headless: true, env: headlessEnv(),
        viewport: VIEWPORT,
        locale: 'en-US',
        args: ['--no-sandbox', '--ozone-platform=x11', '--lang=en-US', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      this.worker = this.context.serviceWorkers()[0] || await this.context.waitForEvent('serviceworker');
      this.extensionId = await this.worker.evaluate(() => chrome.runtime.id);
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.cdp = await this.context.browser().newBrowserCDPSession();
    }

    async badge() {
      return this.worker.evaluate(() => chrome.action.getBadgeText({})).catch(() => null);
    }

    // A fresh tab on the start URL; every other tab (earlier tasks, child windows) is closed.
    async openTask(url) {
      const page = await this.context.newPage();
      for (const other of this.context.pages()) if (other !== page) await other.close().catch(() => {});
      await this.context.clearCookies();
      let status = null;
      try {
        const response = await page.goto(url, { waitUntil: 'load', timeout: 15_000 });
        status = response?.status() ?? null;
      } catch (error) {
        log(`goto ${url}: ${error.message.split('\n')[0]}`);
      }
      await sleep(300);
      await page.bringToFront();
      this.page = page;
      this.startUrl = page.url();
      this.origin = new URL(page.url()).origin;
      return status;
    }
  }
  const session = new QaSession({ server: { command: 'false', args: [] }, origin: 'http://127.0.0.1', startUrl: 'about:blank', scratch, log });
  await session.setup();
  // --tree: the tree's SDK client spawns that tree's src/daemon-main.js.
  const { FaiBrowserClient } = await treeImport('src/client.js');
  session.client = await FaiBrowserClient.connect({ env: { ...process.env, ...session.env }, clientName, startTimeoutMs: 15_000 });
  await session.pair();
  return session;
}
