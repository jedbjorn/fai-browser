#!/usr/bin/env node
// Real-website probe: drives FAI Browser with Jev directly (no coding agent) against live sites.
//
//   node bench/real/probe.mjs --list
//   node bench/real/probe.mjs --tasks wiki-tagus,hn-comments [--mode reversible] [--variant 1] [--out DIR]
//                             [--slim on|off|<switches>]   the slim provider request switches (src/runtime.js)
//   node bench/real/probe.mjs --tasks mdn-array-at,github-license --profile on|off   (site profiles A/B)
//
// Per run: headless Chromium (real Chrome UA, 1280x900) with the extension, an isolated daemon (scratch
// FAI_DAEMON_DIR, random port, disposable pairing secret; FAI_HOME stays the package root so the daemon loads the
// Jev key itself), the start page opened, the tab request approved through the popup (bench/fai-condition.mjs),
// one observe for timing and page size, then one client.run. Everything lands in bench/real/results/<timestamp>/.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { headlessEnv } from '../../scripts/headless-env.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FaiRun } from '../fai-condition.mjs';
import { FaiBrowserClient } from '../../src/client.js';
import { slimFromText } from '../../src/runtime.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const HERE = import.meta.dirname;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1280, height: 900 };
const RUN_TIMEOUT_MS = 90_000;
const sleep = ms => new Promise(done => setTimeout(done, ms));

const CONSENT_RE = /\b(accept all|reject all|accept cookies|cookie (settings|preferences|policy)|we use cookies|manage (cookies|preferences)|before you continue|consent)\b/i;
const BOT_RE = /(captcha|are you a robot|unusual traffic|access denied|verify you are (a )?human|press (&|and) hold|request blocked|not a robot|bot detection|please enable js|checking your browser|bot or not|if you're a human|human side)/i;

function parseArgs(argv) {
  const args = { tasks: null, mode: null, variant: 0, out: null, list: false, label: '', regrade: null, landingOnly: false, slim: null, profile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--tasks') args.tasks = argv[++i].split(',');
    else if (a === '--mode') args.mode = argv[++i];
    else if (a === '--variant') args.variant = Number(argv[++i]);
    else if (a === '--out') args.out = resolve(argv[++i]);
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--regrade') args.regrade = resolve(argv[++i]);
    else if (a === '--landing-only') args.landingOnly = true;
    else if (a === '--slim') args.slim = slimFromText(argv[++i]);
    else if (a === '--profile') {
      args.profile = argv[++i];
      if (args.profile !== 'on' && args.profile !== 'off') throw new Error('--profile must be on or off');
    }
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

class RealRun extends FaiRun {
  // Same launch as FaiRun.setup (copied extension with <all_urls>, popup pairing), plus a real UA and viewport,
  // and no MCP warm-up: the probe talks to the daemon through the SDK client.
  async setup() {
    const { cp, readFile: rf, writeFile: wf } = await import('node:fs/promises');
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
    // --profile on|off: the curated profiles (repo domains/) from a scratch copy; counters go to the daemon's state dir.
    if (this.domainsDir) {
      await cp(join(ROOT, 'domains'), this.domainsDir, { recursive: true, filter: source => !/stats\.json$/.test(source) });
      this.env.FAI_DOMAINS_DIR = this.domainsDir;
    }
    const extension = join(this.scratch, 'extension');
    await cp(join(ROOT, 'extension'), extension, { recursive: true });
    const manifest = JSON.parse(await rf(join(extension, 'manifest.json'), 'utf8'));
    manifest.host_permissions = ['<all_urls>'];
    await wf(join(extension, 'manifest.json'), JSON.stringify(manifest));
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
    this.context = await chromium.launchPersistentContext(join(this.scratch, 'profile'), {
      executablePath: this.chromiumPath,
      headless: true, env: headlessEnv(),
      userAgent: UA,
      viewport: VIEWPORT,
      locale: 'en-US',
      args: ['--no-sandbox', '--ozone-platform=x11', `--user-agent=${UA}`, '--lang=en-US',
        '--disable-blink-features=AutomationControlled',
        `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    this.worker = this.context.serviceWorkers()[0] || await this.context.waitForEvent('serviceworker');
    this.extensionId = await this.worker.evaluate(() => chrome.runtime.id);
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.cdp = await this.context.browser().newBrowserCDPSession();
  }

  async open(url) {
    const started = performance.now();
    let gotoError = null;
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (error) {
      gotoError = error.message.split('\n')[0];
    }
    await this.page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
    await sleep(1500);
    await this.page.bringToFront();
    this.origin = new URL(this.page.url()).origin;
    this.startUrl = this.page.url();
    return { ms: Math.round(performance.now() - started), gotoError };
  }

  // Diagnostics only: record the {code, message} of every error the extension sends to the daemon (the trace keeps
  // only the code). Patches WebSocket.prototype.send inside the service worker; nothing on disk changes.
  async instrument() {
    await this.worker.evaluate(() => {
      if (globalThis.__probeErrors) return;
      globalThis.__probeErrors = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        try {
          if (typeof data === 'string' && data.includes('"error"')) {
            const walk = value => {
              if (!value || typeof value !== 'object') return;
              if (value.error && typeof value.error === 'object' && value.error.code) {
                globalThis.__probeErrors.push({ at: Date.now(), code: value.error.code, message: String(value.error.message ?? '').slice(0, 300) });
              }
              for (const child of Object.values(value)) walk(child);
            };
            walk(JSON.parse(data));
          }
        } catch {}
        return send.call(this, data);
      };
    }).catch(() => {});
  }

  async errors() {
    return this.worker.evaluate(() => globalThis.__probeErrors ?? []).catch(() => null);
  }

  async badge() {
    return this.worker.evaluate(() => chrome.action.getBadgeText({})).catch(() => null);
  }
}

// Independent page census with Playwright (not through FAI): what the scanner may miss.
async function census(page) {
  return page.evaluate(({ consent, bot }) => {
    const all = document.querySelectorAll('*');
    let shadowHosts = 0;
    let shadowControls = 0;
    const sel = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="combobox"],[role="textbox"]';
    for (const el of all) {
      if (el.shadowRoot) {
        shadowHosts++;
        shadowControls += el.shadowRoot.querySelectorAll(sel).length;
      }
    }
    const inView = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
        && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const controls = [...document.querySelectorAll(sel)];
    const iframes = [...document.querySelectorAll('iframe')];
    const text = document.body?.innerText ?? '';
    return {
      url: location.href,
      title: document.title,
      ua: navigator.userAgent,
      webdriver: navigator.webdriver,
      brands: navigator.userAgentData?.brands?.map(b => b.brand) ?? null,
      controlsTotal: controls.length,
      controlsInViewport: controls.filter(inView).length,
      shadowHosts,
      shadowControls,
      iframes: iframes.length,
      iframesVisible: iframes.filter(inView).length,
      iframeSrcs: iframes.slice(0, 8).map(f => (f.src || '').slice(0, 120)),
      textChars: text.length,
      consentHint: (text.match(consent) || [null])[0],
      botHint: (text.match(bot) || [null])[0],
      textHead: text.slice(0, 600),
    };
  }, { consent: CONSENT_RE, bot: BOT_RE }).catch(error => ({ error: error.message }));
}

function grade(re, result, finalObservation) {
  const test = text => re.test(String(text ?? ''));
  const digest = result?.page?.digest ?? [];
  const candidates = result?.answer?.candidates ?? [];
  const trail = result?.trail ?? [];
  const blocks = finalObservation?.blocks ?? [];
  const controls = finalObservation?.controls ?? [];
  const digestText = digest.map(b => (typeof b === 'string' ? b : b.text)).join('\n') + '\n' + (result?.page?.textExcerpt ?? '');
  return {
    inDigest: test(digestText),
    inTopCandidate: test(candidates[0]?.text),
    inCandidates: candidates.some(c => test(c.text)),
    inTrail: trail.some(t => (t.lines ?? []).some(line => test(typeof line === 'string' ? line : line?.text))),
    inFinalBlocks: test(blocks.map(b => b.text).join('\n')),
    inFinalText: test(finalObservation?.text),
    inControlOptions: test(controls.map(c => [c.label, ...(c.options ?? []).map(o => o.label)].join(' ')).join('\n')),
    // Receipt v2: the auto-confirmed answer, graded on its own. A set verdict.answer that fails is a false automation.
    verdictAnswer: result?.verdict?.answer ? test(result.verdict.answer.text) : null,
  };
}

/** Receipt v2 fields for the summary: verdict kind, oversight, next kind, auto-answer and false automation. */
function receiptSummary(rec) {
  const verdict = rec.result?.verdict;
  return {
    verdictKind: verdict?.kind ?? null,
    oversight: verdict?.oversight ?? null,
    nextKind: rec.result?.next?.kind ?? null,
    autoAnswer: Boolean(verdict?.answer),
    falseAutomation: Boolean(verdict?.answer) && rec.grade?.verdictAnswer === false,
    why: verdict?.why ?? null,
    decisions: rec.result?.cost?.decisions ?? null,
    requests: rec.result?.cost?.requests?.length ?? null,
    stepsPassed: rec.stepResults ? rec.stepResults.filter(step => step.passed).length : null,
    fastSteps: rec.result?.site?.fastSteps ?? 0,
    siteFellBack: rec.result?.site?.fellBack?.reason ?? null,
  };
}

function suggestClass(rec) {
  const r = rec.result;
  const c = rec.census ?? {};
  if (!rec.leaseOk) return c.botHint ? 'bot_block' : 'other';
  if (rec.landingOriginChanged) return 'cross_origin_redirect';
  if (r?.status === 'completed' && rec.grade?.inDigest) return 'none';
  if (c.botHint) return 'bot_block';
  if (r?.code === 'blocked_risky') return 'submit_blocked';
  if (r?.code === 'consent_banner') return 'consent_banner';
  if (r?.code === 'login') return 'login_wall';
  if (r?.code === 'blocked') return 'bot_block';
  if (r?.code === 'cross_origin' || r?.code === 'origin_changed') return 'cross_origin_redirect';
  if (rec.observe?.controls >= 100) return 'controls_cap?';
  if (c.consentHint) return 'consent_banner?';
  if (r?.code === 'time_budget' || r?.code === 'timeout') return 'slow_settle?';
  if (r?.status === 'completed' && !rec.grade?.inDigest) return rec.grade?.inFinalText || rec.grade?.inFinalBlocks ? 'digest_miss' : 'other';
  return 'jev_wrong_turn?';
}

async function runOne(task, { mode, variant, outDir, slim = null, client: _ }) {
  const runMode = mode ?? task.mode ?? 'read-only';
  const instruction = variant > 0 ? task.variants?.[variant - 1] ?? task.instruction : task.instruction;
  const tag = `${task.id}.${runMode}.v${variant}`;
  const runDir = join(outDir, tag);
  await mkdir(runDir, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'fai-real-'));
  const log = [];
  const say = line => {
    log.push(`${new Date().toISOString()} ${line}`);
    console.error(`[${tag}] ${line}`);
  };
  const rec = { task: task.id, mode: runMode, variant, instruction, startUrl: task.startUrl, startedAt: new Date().toISOString() };
  const run = new RealRun({ server: { command: 'false', args: [] }, origin: new URL(task.startUrl).origin, startUrl: task.startUrl, scratch, log: say });
  if (args.profile) run.domainsDir = join(scratch, 'domains');
  const t0 = performance.now();
  let client;
  let requestId;
  try {
    await run.setup();
    rec.open = await run.open(task.startUrl);
    // `preConsent` (a button label, e.g. "Reject all"): answer a consent wall on its own consent.* host with Playwright
    // before the tab request, as a user's browser that already answered it would arrive. Headless Chromium cannot
    // grant the extension the second origin (Chrome site access stays on the tab's origin), so the session could not
    // follow the wall's redirect back to the site.
    if (task.preConsent && /^consent\./.test(new URL(run.page.url()).hostname)) {
      await run.page.getByRole('button', { name: task.preConsent }).first().click({ timeout: 10_000 })
        .then(() => run.page.waitForURL(url => !/^consent\./.test(url.hostname), { timeout: 15_000 }))
        .then(() => sleep(2000))
        .catch(error => say(`preConsent: ${error.message.split('\n')[0]}`));
      run.origin = new URL(run.page.url()).origin;
      run.startUrl = run.page.url();
      rec.preConsent = { answered: !/^consent\./.test(new URL(run.page.url()).hostname) };
    }
    rec.landingUrl = run.page.url();
    rec.landingOriginChanged = new URL(rec.landingUrl).origin !== new URL(task.startUrl).origin;
    rec.census = await census(run.page);
    await run.page.screenshot({ path: join(runDir, 'landing.png') }).catch(() => {});
    say(`landed ${rec.landingUrl} in ${rec.open.ms} ms; controls ${rec.census.controlsInViewport}/${rec.census.controlsTotal}, shadow ${rec.census.shadowHosts}, iframes ${rec.census.iframes}, consent=${rec.census.consentHint} bot=${rec.census.botHint}`);

    client = await FaiBrowserClient.connect({ env: { ...process.env, ...run.env }, clientName: 'real-probe', startTimeoutMs: 10_000 });
    await run.pair();
    await run.instrument();
    // Origins requested: the landing origin (where the tab is at approval, e.g. consent.google.com after a
    // redirect), the start URL's origin and the task's extra `origins`, as an agent following the skill would ask.
    // --landing-only requests the landing origin alone (the earlier behaviour).
    const origins = args.landingOnly ? [run.origin]
      : [...new Set([run.origin, new URL(task.startUrl).origin, ...(task.origins ?? [])])];
    rec.origins = origins;
    const allowedUrls = (task.allowedUrls ?? []).filter(u => origins.includes(new URL(u).origin));
    rec.allowedUrlsDropped = (task.allowedUrls ?? []).length - allowedUrls.length;
    ({ requestId } = await client.requestTab({ origins, mode: runMode, reason: `real probe: ${task.id}` }));
    for (let i = 0; i < 40 && (await run.badge()) !== '?'; i++) await sleep(125);
    const approval = await run.approve('probe', { level: runMode });
    const tab = await client.waitForTab(requestId, { timeoutMs: 15_000 });
    rec.approval = { ok: approval?.ok ?? false, ms: approval?.ms, status: approval?.status, state: tab.state };
    rec.leaseOk = tab.state === 'active';
    say(`approval ${rec.approval.ok} state ${tab.state}`);
    if (!rec.leaseOk) throw new Error(`lease not active: ${tab.state}`);

    // One observe for timing and page size (no provider call).
    const obsStart = performance.now();
    try {
      const obs = await client.observe({ requestId, mode: runMode, allowedUrls, outputDir: join(runDir, 'artifacts'), prune: false, capture: false });
      rec.observe = { ms: Math.round(performance.now() - obsStart), actions: obs.actions?.length, digest: obs.page?.digest?.length, trace: obs.trace };
      if (obs.trace && existsSync(obs.trace)) {
        const t = JSON.parse(await readFile(obs.trace, 'utf8'));
        const o = t.page?.controls ? t.page : t.observation ?? t.finalObservation ?? null;
        if (o) Object.assign(rec.observe, { controls: o.controls?.length, blocks: o.blocks?.length, blocksTruncated: o.blocksTruncated, textChars: o.text?.length, textTruncated: o.textTruncated });
        else rec.observe.traceKeys = Object.keys(t);
      }
    } catch (error) {
      rec.observe = { ms: Math.round(performance.now() - obsStart), error: `${error.code ?? ''} ${error.message}` };
    }
    say(`observe ${JSON.stringify(rec.observe)}`);

    // A task with `steps` runs as one step list (its instruction is only the task summary and is not sent); its
    // `timeoutMs` (optional) replaces the 90 s run timeout.
    const timeoutMs = task.timeoutMs ?? RUN_TIMEOUT_MS;
    const body = {
      requestId, mode: runMode, timeoutMs, capture: 'each', prune: false, outputDir: join(runDir, 'artifacts'),
    };
    if (task.steps) body.steps = task.steps.map(step => structuredClone(step));
    else body.instruction = instruction;
    if (task.maxActions || !task.steps) body.maxActions = task.maxActions ?? 6;
    if (task.expectation) body.expectation = task.expectation;
    if (task.answerQuestion) body.answerQuestion = task.answerQuestion;
    if (allowedUrls.length) body.allowedUrls = allowedUrls;
    if (slim !== null && slim !== undefined) body.slim = slim;
    if (args.profile) body.profiles = args.profile;
    rec.runBody = { ...body, requestId: undefined };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('probe timeout')), timeoutMs + 15_000);
    const runStart = performance.now();
    try {
      const response = await client.run(body, { signal: abort.signal });
      rec.result = response.result;
    } catch (error) {
      rec.runError = `${error.code ?? ''} ${error.message}`;
    } finally {
      clearTimeout(timer);
    }
    rec.runMs = Math.round(performance.now() - runStart);
    const r = rec.result;
    // Site profile receipt block (fast steps, where it fell back) and the profile's stats for this run.
    if (r?.site) rec.site = r.site;
    // A step list: per-step outcome (codes only; answers stay in result).
    if (Array.isArray(r?.stepResults)) {
      rec.stepResults = r.stepResults.map(step => ({ i: step.i, status: step.status, code: step.code, passed: step.passed,
        ...(step.held ? { held: step.held } : {}), answered: Boolean(step.answer) }));
    }
    if (run.domainsDir) {
      const { originSlug } = await import('../../src/domains.js');
      const slug = originSlug(new URL(task.startUrl).origin);
      const { cp } = await import('node:fs/promises');
      if (slug) await cp(join(run.daemonDir, 'domain-stats', `${slug}.json`), join(runDir, 'profile-stats.json')).catch(() => {});
    }
    if (r?.trace && existsSync(r.trace)) {
      const t = JSON.parse(await readFile(r.trace, 'utf8'));
      rec.steps = (t.steps ?? []).map(s => ({
        i: s.i, type: s.action?.type, label: String(s.action?.label ?? '').slice(0, 100), toUrl: s.action?.toUrl,
        confidence: s.decision?.confidence, done: s.decision?.done, settle: s.settle, ms: s.ms, error: s.error, interrupted: s.interrupted,
      }));
      rec.finalDecision = t.finalDecision ? { actionId: t.finalDecision.actionId, confidence: t.finalDecision.confidence, done: t.finalDecision.done, by: t.finalDecision.by } : null;
      const fo = t.finalObservation;
      rec.final = fo ? { url: fo.url, title: fo.title, controls: fo.controls?.length, blocks: fo.blocks?.length, blocksTruncated: fo.blocksTruncated, textChars: fo.text?.length } : null;
      rec.grade = grade(new RegExp(task.answerPattern, 'i'), r, fo);
    } else if (r) {
      rec.grade = grade(new RegExp(task.answerPattern, 'i'), r, null);
    }
    rec.extensionErrors = await run.errors();
    rec.finalCensus = await census(run.page);
    await run.page.screenshot({ path: join(runDir, 'final.png') }).catch(() => {});
    say(`result ${r?.status}/${r?.code} in ${rec.runMs} ms; steps ${rec.steps?.length ?? r?.steps?.length}; grade ${JSON.stringify(rec.grade)}`);
  } catch (error) {
    rec.error = error.message;
    say(`error: ${error.message}`);
  } finally {
    if (client && requestId) await client.release(requestId).catch(() => {});
    await run.teardown();
    const { cp } = await import('node:fs/promises');
    await cp(join(run.daemonDir, 'logs', 'daemon.log'), join(runDir, 'daemon.log')).catch(() => {});
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
  rec.elapsedMs = Math.round(performance.now() - t0);
  rec.suggestedClass = suggestClass(rec);
  rec.summary = {
    lease: Boolean(rec.leaseOk), status: rec.result?.status ?? null, code: rec.result?.code ?? null,
    actions: rec.steps?.length ?? rec.result?.steps?.length ?? 0, runMs: rec.runMs ?? null,
    observeMs: rec.observe?.ms ?? null, blocks: rec.observe?.blocks ?? null, controls: rec.observe?.controls ?? null,
    inDigest: rec.grade?.inDigest ?? false, inCandidates: rec.grade?.inCandidates ?? false, suggestedClass: rec.suggestedClass,
    ...receiptSummary(rec),
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(rec, null, 2));
  await writeFile(join(runDir, 'log.txt'), log.join('\n') + '\n');
  return rec;
}

const args = parseArgs(process.argv.slice(2));
const suite = JSON.parse(await readFile(join(HERE, 'tasks.json'), 'utf8'));
if (args.list) {
  for (const t of suite.tasks) console.log(`${t.id}\t${t.mode}\t${t.startUrl}`);
  process.exit(0);
}
if (args.regrade) {
  // Recompute grades and the summary of an earlier results directory from run.json and the saved traces.
  const { readdir } = await import('node:fs/promises');
  const rows = [];
  for (const name of (await readdir(args.regrade)).sort()) {
    const file = join(args.regrade, name, 'run.json');
    if (!existsSync(file)) continue;
    const rec = JSON.parse(await readFile(file, 'utf8'));
    const task = suite.tasks.find(t => t.id === rec.task);
    const re = new RegExp(task.answerPattern, 'i');
    let fo = null;
    if (rec.result?.trace && existsSync(rec.result.trace)) fo = JSON.parse(await readFile(rec.result.trace, 'utf8')).finalObservation;
    if (rec.result) rec.grade = grade(re, rec.result, fo);
    if (rec.observe?.trace && existsSync(rec.observe.trace)) {
      const o = JSON.parse(await readFile(rec.observe.trace, 'utf8')).page;
      if (o?.controls) Object.assign(rec.observe, { controls: o.controls.length, blocks: o.blocks?.length, blocksTruncated: o.blocksTruncated, textChars: o.text?.length, textTruncated: o.textTruncated });
      delete rec.observe.traceKeys;
    }
    rec.suggestedClass = suggestClass(rec);
    Object.assign(rec.summary, {
      observeMs: rec.observe?.ms ?? null, blocks: rec.observe?.blocks ?? null, controls: rec.observe?.controls ?? null,
      inDigest: rec.grade?.inDigest ?? false, inCandidates: rec.grade?.inCandidates ?? false, suggestedClass: rec.suggestedClass,
      ...receiptSummary(rec),
    });
    await writeFile(file, JSON.stringify(rec, null, 2));
    rows.push({ task: rec.task, mode: rec.mode, variant: rec.variant, ...rec.summary, elapsedMs: rec.elapsedMs });
  }
  await writeFile(join(args.regrade, 'summary.json'), JSON.stringify(rows, null, 2));
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}
const tasks = args.tasks ? suite.tasks.filter(t => args.tasks.includes(t.id)) : suite.tasks;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = args.out ?? join(HERE, 'results', stamp + (args.label ? `-${args.label}` : ''));
await mkdir(outDir, { recursive: true });
const rows = [];
for (const task of tasks) {
  const rec = await runOne(task, { mode: args.mode, variant: args.variant, outDir, slim: args.slim });
  rows.push({ task: rec.task, mode: rec.mode, variant: rec.variant, ...rec.summary, elapsedMs: rec.elapsedMs });
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(rows, null, 2));
}
console.log(JSON.stringify({ outDir, rows }, null, 2));
