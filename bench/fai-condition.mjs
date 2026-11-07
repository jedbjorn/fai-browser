// Condition B glue: FAI Browser MCP server + headless Chromium with the extension, where the harness plays the user.
//
// ASSUMED PHASE 2 INTERFACE (match this, or adjust only this file):
//   1. A stdio MCP server started as `fai-browser-mcp` (on PATH, node_modules/.bin, or package.json "bin"), or the
//      command given with --fai-mcp-command / FAI_BENCH_MCP_COMMAND. It lists the tools in FAI_TOOLS below;
//      `fai_browser_run` with `origins` requests the tab itself (no separate request_tab call).
//   2. The server reaches or auto-starts the daemon. Codex passes it only the env set here:
//        FAI_BRIDGE_PORT    extension-facing port (random per run, so a real daemon on 4318 is untouched)
//        FAI_BRIDGE_SECRET  disposable pairing secret; must take precedence over .env.local
//        FAI_DAEMON_DIR     per-run state dir for the daemon's lock / socket / pid file (isolation from a user daemon)
//      FAI_HOME is isolated unless explicitly supplied; Jev benchmarks must supply their own FAI_HOME;
//      the harness never reads that file.
//   3. The extension popup (popup.html) keeps #endpoint and #secret (under Advanced; the secret is saved on change and
//      never shown back) and a pending request card per request. The harness pairs the popup during setup, before the
//      clock starts, as a user's extension would already be, then clicks the card's "Approve this tab" (#approve)
//      after picking `level` (constructor option or approve(trigger, {level})) in the card's Allow select; a level
//      the card does not offer (above the asked one, or Testing off the listed origins) is refused. Without a level
//      the card's preset (the level the agent asked for) is approved. #status then matches APPROVED_RE. While a
//      request is pending the badge text is "?", which the harness polls every 250 ms.
//   4. fai_browser_run / step / act / wait return the v1 result (docs/design/PROPOSAL.md section 5) as structuredContent or
//      as JSON text; `cost.decisions`, `cost.elapsedMs` and `trace` (absolute trace.json path) are read from it.
//   5. Daemon cleanup: processes whose environment carries this run's FAI_DAEMON_DIR are sent SIGTERM at the end,
//      as is the pid in $FAI_DAEMON_DIR/daemon.pid if present.
// Env overrides: FAI_BENCH_APPROVED_RE, FAI_BENCH_POPUP_PATH, FAI_BENCH_PENDING_BADGES.
import { spawn } from 'node:child_process';
import { headlessEnv } from '../scripts/headless-env.mjs';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { faiResultFrom } from './lib/metrics.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export const FAI_TOOLS = [
  'fai_browser_status', 'fai_browser_open', 'fai_browser_run', 'fai_browser_wait', 'fai_browser_observe', 'fai_browser_act',
  'fai_browser_stop', 'fai_browser_evidence',
];
const REQUIRED_TOOLS = ['fai_browser_wait', 'fai_browser_observe', 'fai_browser_act'];
const APPROVED_RE = new RegExp(process.env.FAI_BENCH_APPROVED_RE || 'available to the agent|approved|tab is ready|agent is using its tab', 'i');
const POPUP_PATH = process.env.FAI_BENCH_POPUP_PATH || 'popup.html';
const PENDING_BADGES = (process.env.FAI_BENCH_PENDING_BADGES ?? '?').split(',').filter(Boolean);
const sleep = ms => new Promise(done => setTimeout(done, ms));

function onPath(name) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) {
      return join(dir, name);
    }
  }
  return null;
}

// Returns {command, args} for the MCP server, or {missing: reason}.
export async function resolveFaiMcp(explicit = process.env.FAI_BENCH_MCP_COMMAND) {
  if (explicit) {
    const [command, ...args] = explicit.split(' ').filter(Boolean);
    const found = isAbsolute(command) ? existsSync(command) : Boolean(onPath(command)) || existsSync(resolve(command));
    if (!found) {
      return { missing: `--fai-mcp-command ${explicit}: ${command} not found` };
    }
    return { command: isAbsolute(command) || onPath(command) ? command : resolve(command), args };
  }
  const local = join(ROOT, 'node_modules', '.bin', 'fai-browser-mcp');
  if (existsSync(local)) {
    return { command: local, args: [] };
  }
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const bin = typeof pkg.bin === 'object' ? pkg.bin['fai-browser-mcp'] : null;
  if (bin && existsSync(join(ROOT, bin))) {
    return { command: process.execPath, args: [join(ROOT, bin)] };
  }
  const global = onPath('fai-browser-mcp');
  if (global) {
    return { command: global, args: [] };
  }
  return {
    missing: 'fai-browser-mcp not found (no package.json bin entry, node_modules/.bin or PATH entry). '
      + 'The Phase 2 MCP server is not built yet; pass --fai-mcp-command to point at it.',
  };
}

// Minimal MCP stdio client: initialize, tools/list, optional tools/call. Used for preflight and to warm the daemon.
export async function mcpProbe(server, { env = {}, call = null, timeoutMs = 20_000 } = {}) {
  const child = spawn(server.command, server.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: probeEnvironment(env),
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const pending = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!text) {
        continue;
      }
      try {
        const message = JSON.parse(text);
        if (message.id != null && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      } catch {
        // log noise on stdout; ignore
      }
    }
  });
  let exited = null;
  child.on('exit', code => {
    exited = code;
    for (const done of pending.values()) {
      done({ error: { message: `server exited with ${code}` } });
    }
    pending.clear();
  });
  child.on('error', error => {
    exited = error.message;
  });
  child.stdin.on('error', () => {});
  let nextId = 0;
  const request = (method, params) => new Promise((done, fail) => {
    if (exited !== null) {
      fail(new Error(`server exited (${exited}) before ${method}`));
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      fail(new Error(`${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, message => {
      clearTimeout(timer);
      if (message.error) {
        fail(new Error(`${method}: ${message.error.message}`));
      } else {
        done(message.result);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fai-bench-preflight', version: '1' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = (await request('tools/list', {})).tools?.map(tool => tool.name) ?? [];
    let called = null;
    if (call) {
      called = await request('tools/call', { name: call.name, arguments: call.arguments ?? {} });
    }
    return { ok: true, tools, called };
  } catch (error) {
    return { ok: false, error: error.message, exited, stderr: stderr.trim().slice(-1500) };
  } finally {
    child.stdin.end();
    setTimeout(() => child.kill('SIGTERM'), 500).unref();
  }
}

export async function preflightFai({ mcpCommand } = {}) {
  const server = await resolveFaiMcp(mcpCommand);
  if (server.missing) {
    return { ok: false, reason: server.missing };
  }
  try {
    await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
  } catch (error) {
    return { ok: false, reason: `playwright-core is needed to drive Chromium with the extension: ${error.message}` };
  }
  const chromium = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
  if (!existsSync(chromium)) {
    return { ok: false, reason: `Chromium not found at ${chromium}; set CHROMIUM_PATH` };
  }
  const scratch = join(process.env.TMPDIR || '/tmp', `fai-bench-preflight-${process.pid}`);
  const probe = await mcpProbe(server, { env: isolatedEnv(scratch, await freePort(), 'preflight-only-secret-0123456789') });
  await killDaemons(scratch);
  await rm(scratch, { recursive: true, force: true });
  if (!probe.ok) {
    return { ok: false, reason: `fai-browser-mcp did not answer tools/list: ${probe.error}${probe.stderr ? `\n${probe.stderr}` : ''}` };
  }
  const missing = REQUIRED_TOOLS.filter(name => !probe.tools.includes(name));
  if (!probe.tools.includes('fai_browser_open') && !probe.tools.includes('fai_browser_run')) missing.push('fai_browser_open or fai_browser_run');
  if (missing.length) {
    return { ok: false, reason: `fai-browser-mcp lacks required tools: ${missing.join(', ')} (has: ${probe.tools.join(', ')})` };
  }
  const envFile = join(process.env.FAI_HOME ? resolve(process.env.FAI_HOME) : ROOT, '.env.local');
  return {
    ok: true,
    server,
    tools: probe.tools,
    missingOptionalTools: FAI_TOOLS.filter(name => !probe.tools.includes(name)),
    warning: probe.tools.includes('fai_browser_open') || existsSync(envFile) ? null : 'No .env.local found: fai_browser_run/step need the Jev key (npm run setup).',
  };
}

// Preserve an explicit benchmark settings root without forwarding the whole parent environment.
export function probeEnvironment(env = {}, inherited = process.env) {
  return { PATH: inherited.PATH, HOME: inherited.HOME,
    ...(inherited.FAI_HOME ? { FAI_HOME: inherited.FAI_HOME } : {}), ...env };
}

export function isolatedEnv(daemonDir, port, secret, inherited = process.env) {
  return { FAI_BRIDGE_PORT: String(port), FAI_BRIDGE_SECRET: secret, FAI_DAEMON_DIR: daemonDir, FAI_BENCH: '1',
    FAI_HOME: inherited.FAI_HOME || join(daemonDir, 'settings') };
}

function freePort() {
  return new Promise((done, fail) => {
    const server = net.createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

// SIGTERMs every process of ours whose environment names this daemon dir (MCP servers and daemons it spawned).
async function killDaemons(daemonDir) {
  const killed = [];
  const needle = `FAI_DAEMON_DIR=${daemonDir}\0`;
  try {
    const pidFile = join(daemonDir, 'daemon.pid');
    if (existsSync(pidFile)) {
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      if (pid > 1) {
        try {
          process.kill(pid, 'SIGTERM');
          killed.push(pid);
        } catch {
          // already gone
        }
      }
    }
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) {
        continue;
      }
      try {
        const environ = await readFile(`/proc/${entry}/environ`, 'latin1');
        if (environ.includes(needle)) {
          process.kill(Number(entry), 'SIGTERM');
          killed.push(Number(entry));
        }
      } catch {
        // not ours or exited
      }
    }
  } catch {
    // /proc unavailable: best effort only
  }
  return killed;
}

// The popup script one approval runs: fill the pairing fields, then approve the pending request card at `level` (its
// Allow select; null keeps the card's preset). Returns {clicked, via: 'card'|'message', level, label} ('message': no
// card, a harness companion session started with the worker's start message), {clicked: false}, or {clicked: false, refused, status} when the level is not offered. Exported for test/bench-approval.test.js.
export function approveExpression({ level = null, endpoint, secret }) {
  return `(() => {
    const level = ${JSON.stringify(level ?? null)};
    const set = (id, value) => {
      const field = document.getElementById(id);
      if (!field) return;
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      // The popup saves a typed pairing secret on change (and never shows it back).
      field.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('endpoint', ${JSON.stringify(endpoint)});
    set('secret', ${JSON.stringify(secret)});
    const status = document.querySelector('#status');
    if (status) status.textContent = '';
    const visible = el => el && !el.hidden && !el.disabled && el.offsetParent !== null;
    // Today's popup: a pending request card with its own Allow select and "Approve this tab" button.
    const card = [...document.querySelectorAll('.request-card')].find(el => visible(el.querySelector('.approve-request')));
    if (card) {
      const select = card.querySelector('select.level-select');
      if (level) {
        if (!select || ![...select.options].some(option => option.value === level)) {
          return { clicked: false, refused: true, status: 'level ' + level + ' is not offered on the request card' };
        }
        select.value = level;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const approve = card.querySelector('.approve-request');
      approve.click();
      return { clicked: true, via: 'card', level: select?.value ?? null, label: approve.textContent.trim() };
    }
    // No card: a harness companion (bench/companion.js) has no requests. Start a session on the active tab with the
    // worker's own start message, as the removed Phase 1 button did, at \`level\` (read-only without one).
    if (document.querySelector('#requests-empty') && !document.querySelector('.request-card')) {
      const chosen = level ?? 'read-only';
      chrome.runtime.sendMessage({ type: 'start', level: chosen, endpoint: ${JSON.stringify(endpoint)},
        secret: ${JSON.stringify(secret)} }).then(reply => {
        if (status) status.textContent = reply?.error ?? 'Selected tab is available to the agent.';
      });
      return { clicked: true, via: 'message', level: chosen, label: 'start' };
    }
    return { clicked: false };
  })()`;
}

// One browser + daemon per run. The harness opens the start page, then approves tab requests like a user would.
export class FaiRun {
  // `level`: the level the harness picks in the popup for every approval (a task's declared mode); null approves the
  // card's preset, which is the level the agent asked for.
  // `extraEnv`: added to the isolated env (bench/live --fai-home sets FAI_HOME for a checkout without .env.local).
  // `autoApproveActions`: gated action kinds the harness may approve (secret/upload/purchase); empty by default.
  constructor({ server, origin, startUrl, scratch, chromiumPath, log, level = null, extraEnv = null,
    autoApproveActions = [], testingOrigin = null }) {
    Object.assign(this, { server, origin, startUrl, scratch, level, extraEnv, autoApproveActions, testingOrigin, log: log || (() => {}) });
    this.chromiumPath = chromiumPath || process.env.CHROMIUM_PATH || '/usr/bin/chromium';
    this.secret = randomBytes(24).toString('hex');
    this.daemonDir = join(scratch, 'daemon');
    this.approvals = [];
    this.actionGate = [];
    this.approving = null;
    this.actionApproving = false;
    this.t0 = null;
    this.badgeTimer = null;
    this.lastApprovedBadge = null;
  }

  async setup() {
    await mkdir(this.daemonDir, { recursive: true });
    this.port = await freePort();
    this.endpoint = `http://127.0.0.1:${this.port}`;
    this.env = { ...isolatedEnv(this.daemonDir, this.port, this.secret), ...(this.extraEnv ?? {}) };

    // Same launch as scripts/browser-smoke.mjs: a copied extension whose test manifest grants <all_urls>, because
    // headless action.openPopup grants no activeTab. The shipped manifest is unchanged.
    const extension = join(this.scratch, 'extension');
    await cp(join(ROOT, 'extension'), extension, { recursive: true });
    const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
    manifest.host_permissions = ['<all_urls>'];
    await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
    this.context = await chromium.launchPersistentContext(join(this.scratch, 'profile'), {
      executablePath: this.chromiumPath,
      headless: true, env: headlessEnv(),
      args: ['--no-sandbox', '--ozone-platform=x11', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    this.worker = this.context.serviceWorkers()[0] || await this.context.waitForEvent('serviceworker');
    this.extensionId = await this.worker.evaluate(() => chrome.runtime.id);
    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.page.goto(this.startUrl);
    await this.page.bringToFront();
    this.cdp = await this.context.browser().newBrowserCDPSession();
    // The harness already opened the task page. Keep tab approval in its popup instead of opening another task
    // window and an armed-toolbar prompt; both are user settings, and the popup still enforces the requested level.
    await this.worker.evaluate(() => chrome.storage.local.set({ openRightAway: false, approvalWindow: false }));
    if (this.testingOrigin) {
      await this.worker.evaluate(async origin => {
        const { permissions = {} } = await chrome.storage.local.get(['permissions']);
        const testingOrigins = [...new Set([...(permissions.testingOrigins ?? []), origin])];
        await chrome.storage.local.set({ permissions: { ...permissions, testingOrigins } });
      }, this.testingOrigin);
    }

    // Warm the daemon before the clock starts: a user's daemon is normally already running.
    const warm = await mcpProbe(this.server, { env: this.env, call: { name: 'fai_browser_status', arguments: {} } });
    this.warm = warm.ok ? { ok: true } : { ok: false, error: warm.error };
    // Pair the extension with this run's daemon before the clock starts, so a request made inside fai_browser_run
    // reaches the popup and shows the pending badge without a request_tab trigger.
    this.paired = await this.pair().then(() => true, error => {
      this.log(`pairing before the run failed (${error.message}); approval falls back to the first trigger`);
      return false;
    });
  }

  async pair() {
    const evaluate = await this.openPopup();
    try {
      await evaluate(`(() => {
        for (const [id, value] of [['endpoint', ${JSON.stringify(this.endpoint)}], ['secret', ${JSON.stringify(this.secret)}]]) {
          const field = document.getElementById(id);
          if (!field) continue;
          field.value = value;
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`);
      await sleep(300);
    } finally {
      await evaluate('window.close()').catch(() => {});
      await this.waitPopupClosed().catch(() => {});
    }
  }

  // Called by the runner when the host clock starts.
  start() {
    this.t0 = performance.now();
    this.badgeTimer = setInterval(() => {
      this.pollBadge();
      this.pollActionGate();
    }, 250);
  }

  async actionEntries() {
    if (!this.worker) return [];
    return this.worker.evaluate(async () => {
      const { approvals = [] } = await chrome.storage.session.get(['approvals']);
      // The extension publishes only pending cards; its public approval view intentionally omits internal status.
      return approvals.map(({ id, cls, kind, status, label }) => ({ id, cls, kind, status: status ?? 'pending', label }));
    }).catch(() => []);
  }

  async pendingActions() {
    return (await this.actionEntries()).filter(entry => entry.status === 'pending');
  }

  async pollActionGate() {
    if (this.actionApproving || !this.autoApproveActions.length) return;
    this.actionApproving = true;
    try {
      const pending = (await this.pendingActions()).filter(entry =>
        this.autoApproveActions.includes(entry.kind) || this.autoApproveActions.includes(entry.cls));
      for (const entry of pending) {
        const page = this.context.pages().find(candidate => candidate.url().includes(`/approve.html?id=${entry.id}`));
        if (!page || await page.locator('#approve').count() === 0) continue;
        await page.locator('#approve').click();
        this.actionGate.push({ ...entry, decision: 'approved', atMs: Math.round(performance.now() - (this.t0 ?? performance.now())) });
        this.log(`action approval: ${entry.kind ?? entry.cls} approved once`);
      }
    } catch {
      // The approval window may close between discovery and the click; the next poll sees any remaining request.
    } finally {
      this.actionApproving = false;
    }
  }

  // Codex JSONL observer: approve right after each completed fai_browser_request_tab call.
  onLine({ text }) {
    if (!text.includes('fai_browser_request_tab')) {
      return;
    }
    try {
      const event = JSON.parse(text);
      if (event.type === 'item.completed' && event.item?.tool === 'fai_browser_request_tab' && event.item.status !== 'failed') {
        this.approve('request_tab');
      }
    } catch {
      // ignore
    }
  }

  async pollBadge() {
    if (this.approving || !this.worker) {
      return;
    }
    try {
      const badge = await this.worker.evaluate(() => chrome.action.getBadgeText({}));
      if (PENDING_BADGES.includes(badge) && this.lastApprovedBadge !== badge) {
        this.approve('badge');
      } else if (!PENDING_BADGES.includes(badge)) {
        this.lastApprovedBadge = null;
      }
    } catch {
      // worker restarting; try again next tick
    }
  }

  approve(trigger, { level = this.level } = {}) {
    // Serialize approvals: a trigger that arrives while another approval runs waits for it, then re-checks.
    const attempt = (this.approving || Promise.resolve()).then(() => this.approveOnce(trigger, level));
    const tracked = attempt.catch(() => {}).finally(() => {
      if (this.approving === tracked) {
        this.approving = null;
      }
    });
    this.approving = tracked;
    return attempt;
  }

  async approveOnce(trigger, level = this.level) {
    if (trigger === 'badge') {
      const badge = await this.worker.evaluate(() => chrome.action.getBadgeText({})).catch(() => null);
      if (!PENDING_BADGES.includes(badge)) {
        return null;
      }
    }
    const started = performance.now();
    const record = { trigger, atMs: Math.round(started - (this.t0 ?? started)), ok: false, attempts: 0, status: null, level };
    for (let attempt = 1; attempt <= 6 && !record.ok; attempt++) {
      record.attempts = attempt;
      try {
        if (!this.page.url().startsWith(this.origin)) {
          await this.page.goto(this.startUrl);
        }
        await this.page.bringToFront();
        const outcome = await this.clickApprove(level);
        record.status = outcome.status;
        record.ok = outcome.ok;
        if (outcome.via) record.via = outcome.via;
        if (outcome.level) record.picked = outcome.level;
        if (outcome.refused) {
          // The level is not offered on this card (testing on an unlisted origin): retrying cannot help.
          break;
        }
        if (outcome.alreadyActive) {
          record.note = 'start button hidden (session already active)';
          break;
        }
      } catch (error) {
        record.status = error.message;
      }
      if (!record.ok) {
        await sleep(500);
      }
    }
    record.ms = Math.round(performance.now() - started);
    if (record.ok) {
      this.lastApprovedBadge = PENDING_BADGES[0] ?? null;
    }
    this.approvals.push(record);
    this.log(`approval via ${trigger}: ${record.ok ? 'ok' : 'failed'} in ${record.ms} ms (${record.status})`);
    return record;
  }

  async popupTargets() {
    return (await this.cdp.send('Target.getTargets')).targetInfos
      .filter(target => target.url === `chrome-extension://${this.extensionId}/${POPUP_PATH}`);
  }

  async waitPopupClosed() {
    const deadline = Date.now() + 3000;
    while ((await this.popupTargets()).length && Date.now() < deadline) {
      await sleep(50);
    }
  }

  // Opens the popup over the leased tab (as the toolbar click would) and returns an evaluate(expression) function.
  async openPopup() {
    await this.waitPopupClosed();
    const deadline = Date.now() + 3000;
    let target;
    while (!target && Date.now() < deadline) {
      try {
        await this.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab) throw new Error('No active browser tab');
          await chrome.action.openPopup({ windowId: tab.windowId });
        });
      } catch (error) {
        if (!String(error.message).includes('Failed to open popup')) throw error;
      }
      target = (await this.popupTargets())[0];
      if (!target) await sleep(100);
    }
    if (!target) throw new Error('popup did not open');
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    let id = 0;
    const evaluate = expression => new Promise((done, fail) => {
      const messageId = ++id;
      const timer = setTimeout(() => {
        this.cdp.off('Target.receivedMessageFromTarget', listener);
        fail(new Error('popup CDP timeout'));
      }, 5000);
      const listener = event => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id !== messageId) return;
        clearTimeout(timer);
        this.cdp.off('Target.receivedMessageFromTarget', listener);
        const exception = message.result?.exceptionDetails;
        if (message.error) fail(new Error(message.error.message));
        else if (exception) fail(new Error(exception.exception?.description || exception.text));
        else done(message.result.result?.value);
      };
      this.cdp.on('Target.receivedMessageFromTarget', listener);
      const params = { expression, awaitPromise: true, returnByValue: true };
      this.cdp.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id: messageId, method: 'Runtime.evaluate', params }),
      }).catch(error => {
        clearTimeout(timer);
        this.cdp.off('Target.receivedMessageFromTarget', listener);
        fail(error);
      });
    });
    await evaluate(`(async () => {
      for (let i = 0; i < 50 && !document.querySelector('#status')?.textContent; i++) await new Promise(r => setTimeout(r, 20));
    })()`);
    return evaluate;
  }

  async clickApprove(level = this.level) {
    const evaluate = await this.openPopup();
    try {
      const clicked = await evaluate(approveExpression({ level, endpoint: this.endpoint, secret: this.secret }));
      if (clicked?.refused) {
        return { ok: false, refused: true, status: clicked.status };
      }
      if (!clicked?.clicked) {
        const status = await evaluate("document.querySelector('#status')?.textContent || ''");
        return { ok: APPROVED_RE.test(status), alreadyActive: true, status };
      }
      const deadline = Date.now() + 5000;
      let status = '';
      while (Date.now() < deadline) {
        status = await evaluate("document.querySelector('#status')?.textContent || ''");
        if (APPROVED_RE.test(status)) {
          return { ok: true, status, via: clicked.via, level: clicked.level };
        }
        await sleep(50);
      }
      return { ok: false, status: status || 'no status after click' };
    } finally {
      await evaluate('window.close()').catch(() => {});
      await this.waitPopupClosed().catch(() => {});
    }
  }

  async teardown() {
    clearInterval(this.badgeTimer);
    await this.approving?.catch(() => {});
    await this.context?.close().catch(() => {});
    const killed = await killDaemons(this.daemonDir);
    if (killed.length) {
      this.log(`stopped ${killed.length} FAI process(es) for this run`);
    }
  }
}

// Summarizes FAI results seen in the Codex tool calls, then fills in from trace.json where a path is given.
export async function faiEvidence(calls) {
  const byRun = new Map();
  let final = null;
  for (const call of calls) {
    if (!call.tool?.startsWith('fai_browser_')) {
      continue;
    }
    const result = faiResultFrom(call.result);
    // Direct receipts have a requestId, not a runId. Track the actual last task receipt separately
    // from per-run cost aggregation; an unreadable task result must not reuse earlier success.
    if (['fai_browser_open', 'fai_browser_act', 'fai_browser_observe', 'fai_browser_run',
      'fai_browser_step', 'fai_browser_wait', 'fai_browser_stop'].includes(call.tool)) {
      final = result ? { runId: result.runId ?? null, requestId: result.requestId ?? null, tool: call.tool,
        status: result.status, code: result.code,
        verified: typeof result.verification?.passed === 'boolean' ? result.verification.passed : null } : null;
    }
    if (result?.runId) {
      byRun.set(result.runId, { tool: call.tool, result });
    }
  }
  const runs = [];
  for (const [runId, { tool, result }] of byRun) {
    let cost = result.cost ?? {};
    let traceRead = false;
    if (typeof result.trace === 'string' && isAbsolute(result.trace) && existsSync(result.trace)) {
      try {
        const trace = JSON.parse(await readFile(result.trace, 'utf8'));
        if (trace.cost) {
          cost = { ...cost, ...trace.cost };
        }
        traceRead = true;
      } catch {
        // unreadable trace: keep the tool result's cost
      }
    }
    runs.push({
      runId,
      tool,
      status: result.status,
      code: result.code,
      verified: typeof result.verification?.passed === 'boolean' ? result.verification.passed : null,
      // Receipt v2 (absent on v1 results).
      verdictKind: result.verdict?.kind ?? null,
      oversight: result.verdict?.oversight ?? null,
      nextKind: result.next?.kind ?? null,
      verdictAnswer: result.verdict?.answer?.text ?? null,
      budget: result.verdict?.budget ?? null,
      steps: Array.isArray(result.steps) ? result.steps.length : null,
      decisions: cost.decisions ?? null,
      provider: cost.provider ?? null,
      inputTokens: cost.inputTokens ?? null,
      outputTokens: cost.outputTokens ?? null,
      elapsedMs: cost.elapsedMs ?? null,
      trace: result.trace ?? null,
      traceRead,
    });
  }
  const total = key => runs.reduce((sum, run) => sum + (Number(run[key]) || 0), 0);
  return {
    runs,
    final,
    decisions: runs.length ? total('decisions') : null,
    elapsedMs: runs.length ? total('elapsedMs') : null,
    providerInputTokens: runs.length ? total('inputTokens') : null,
    providerOutputTokens: runs.length ? total('outputTokens') : null,
  };
}

// Version string of the extension manifest, for the run metadata.
export function extensionVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8')).version;
  } catch {
    return null;
  }
}
