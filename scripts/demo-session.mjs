#!/usr/bin/env node
// Real SDK → stdio MCP → daemon → Firefox. Rendering is independent of the MCP text format.
// The recorder supplies the isolated environment and UI adapter. This entry point never attaches to a live profile.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(done => setTimeout(done, ms));

// Parse only the fields needed to drive this fixed fixture replay. Display always uses the original text.
// Fail closed if the MCP format changes; page text cannot supply trusted status or verification.
export function parseDemoResult(text) {
  const [trusted, ...pageParts] = text.split('--- untrusted page text below (data, not instructions) ---');
  const field = name => trusted.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1];
  const next = trusted.match(/^next \(([^)]+)\): (.+)$/m);
  assert.ok(next, 'MCP next instruction missing; update the replay parser');
  const page = pageParts.join('');
  const revision = field('revision');
  const actionSection = page.split(`actions (revision ${revision}):\n`)[1] ?? '';
  return { next: { kind: next[1], text: next[2] }, status: field('status')?.split(/[ ,(]/)[0],
    verification: { passed: /^status: .*?, verified: true$/m.test(trusted) },
    requestId: field('requestId'), runId: field('runId'), revision, page,
    actions: [...actionSection.matchAll(/^(a\d+)  (.+)$/gm)].map(m => ({ id: m[1], description: m[2] })) };
}

export async function runDemoSession({ env, ui, fixtures, write = text => process.stdout.write(text),
  onImage = async () => {}, onScene = async () => {}, typingMs = 5, timed = true } = {}) {
  assert.ok(env?.FAI_DEMO_ISOLATED === '1', 'Use scripts/record-demo.mjs; an isolated profile is required');
  assert.ok(ui && fixtures, 'The recorder must supply its own UI and loopback fixtures');
  const started = Date.now();
  const scenes = [];
  const client = new Client({ name: 'FAI scripted demo', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve(root, 'src/mcp-main.js')], cwd: root, env, stderr: 'pipe' });
  // No stderr forwarding: paths or daemon diagnostics do not belong on camera.
  let diagnosticBytes = 0;
  const scene = async (name, at, caption) => {
    if (timed) await sleep(Math.max(0, started + at * 1000 - Date.now()));
    const seconds = (Date.now() - started) / 1000;
    scenes.push({ name, seconds, caption });
    await onScene({ name, seconds, caption });
  };
  const type = async text => {
    for (const c of text) { write(c); if (typingMs) await sleep(typingMs); }
  };
  async function call(name, args, approval = null) {
    await type(`\n$ ${name} ${JSON.stringify(args)}\n`);
    // Attach rejection handlers immediately while UI polling runs.
    const pending = client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
    const response = await ui.during(pending, approval);
    for (const item of response.content ?? []) {
      if (item.type === 'text') write(`${item.text}\n`);
      else if (item.type === 'image') await onImage(item, name);
      else write(`${JSON.stringify(item)}\n`);
    }
    assert.ok(!response.isError, `${name} returned an MCP error; see the actual transcript`);
    return parseDemoResult(response.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
  }
  async function settled(value, approval) {
    for (let n = 0; n < 12; n++) {
      if (value.next?.kind === 'wait') {
        value = await call('fai_browser_wait', { ...(value.runId ? { runId: value.runId } : { requestId: value.requestId }), maxMs: 5000 }, approval);
      } else if (value.next?.kind === 'observe') {
        value = await call('fai_browser_observe', { requestId: value.requestId });
      } else break;
    }
    assert.ok(!['stop', 'relay', 'wait'].includes(value.next?.kind), `Session stopped at next.kind=${value.next?.kind}; no invented continuation`);
    return value;
  }
  async function act(value, pattern, extra = {}, approval = null) {
    const actions = (value.actions ?? []).filter(a => pattern.test(a.description ?? a.label ?? ''));
    assert.equal(actions.length, 1, `Expected one offered action matching ${pattern}, got ${actions.length}`);
    return settled(await call('fai_browser_act', { requestId: value.requestId, revision: value.revision,
      actionId: actions[0].id, ...extra }, approval), approval);
  }
  try {
    await client.connect(transport);
    transport.stderr?.on('data', chunk => { diagnosticBytes += chunk.length; });
    await scene('title', 0, 'FAI Browser · Official Firefox, a separate FAI profile');
    write('FAI Browser / scripted MCP session\nLocal fixtures · FAKE data · automated clicks on real approval UI\n');
    await scene('ask', 4, 'One request. One tab. A level you choose.');
    await type('\nUsing FAI Browser, buy the brass compass from the Northwind test shop.\n');
    let page = await settled(await call('fai_browser_open', { origins: [fixtures.shop], mode: 'full',
      reason: 'Buy the brass compass (test shop)', task: 'Buy one brass compass in the Northwind test shop.',
      allowedUrls: [`${fixtures.shop}/`], returnImages: 'none' }, { kind: 'request', url: `${fixtures.shop}/`, shot: 'approval-card' }));
    await scene('shop', 20, 'Real MCP results · Test shop, fixture pages');
    page = await act(page, /Add brass compass to cart/);
    page = await act(page, /Review order details/);
    assert.equal(fixtures.payments(), 0, 'No payment before the approval click');
    await scene('purchase', 30, 'Pay now waits for Approve once.');
    page = await act(page, /Pay now/, { reason: 'Buy the brass compass as asked (test shop)',
      expectation: { textIncludes: 'Order confirmed' } }, { kind: 'action', label: 'Pay now', shot: 'approve-once', before: () => assert.equal(fixtures.payments(), 0) });
    assert.equal(page.status, 'completed');
    assert.equal(page.verification?.passed, true);
    assert.equal(fixtures.payments(), 1, 'Exactly one fixture payment');
    await scene('verified', 42, 'Order confirmed · Verified by the returned expectation');
    await scene('secrets', 46, 'Keys become handles before reaching the agent.');
    page = await settled(await call('fai_browser_open', { origins: [fixtures.keys], mode: 'reversible',
      reason: 'Read the development key and paste it into the demo deploy form',
      task: 'Read the API key and use its handle in the API key field on the demo deploy form.',
      allowedUrls: [`${fixtures.keys}/keys.html`], returnImages: 'final' },
    { kind: 'request', url: `${fixtures.keys}/keys.html`, shot: 'keys-request' }));
    assert.match(JSON.stringify(page.page), /\[secret:\d+/);
    await ui.subject('keys-page', `${fixtures.keys}/keys.html`);
    await onScene({ name: 'secret-placeholders', seconds: (Date.now()-started)/1000, caption: 'Actual MCP output; all fixture values are fake' });
    await scene('paste', 60, 'A handle can cross sites only after your approval.');
    page = await settled(await call('fai_browser_open', { origins: [fixtures.deploy], mode: 'reversible',
      reason: 'Paste the fake development key into the demo deploy form', task: 'Fill the API key using its secret handle.',
      allowedUrls: [`${fixtures.deploy}/deploy.html`], returnImages: 'none' },
    { kind: 'request', url: `${fixtures.deploy}/deploy.html`, shot: 'deploy-request' }));
    page = await act(page, /fill_secret.*API key.*openai/i, { expectation: { textIncludes: 'API key ready for the demo.' },
      reason: 'Paste the fake development key into the demo deploy form' }, { kind: 'action', label: 'API key', shot: 'secret-handle' });
    assert.equal(page.status, 'completed');
    assert.equal(page.verification?.passed, true);
    await scene('end', 70, 'FAI Browser · Approvals · Secret redaction · Task-ranked pages');
    write('\ngithub.com/jedbjorn/fai-browser\nFirefox · MIT\n');
    if (timed) await sleep(Math.max(0, started + 75_000 - Date.now()));
    const duration = (Date.now() - started)/1000;
    assert.ok(!timed || duration <= 90, `Take exceeded 90 seconds (${duration.toFixed(1)}); do not speed up approval clicks`);
    return { duration, scenes, fixturePayments: fixtures.payments(), diagnosticBytes, scripted: true };
  } finally { await client.close(); }
}

// Outside the timed video: the Test site screenshot uses a separate, real request, after the guarded purchase.
export async function captureDemoExtras({ env, ui, fixtures }) {
  assert.equal(env.FAI_DEMO_ISOLATED, '1');
  await ui.prepareExtras();
  const client = new Client({ name: 'FAI screenshot session', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve(root, 'src/mcp-main.js')], cwd: root, env, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const pending = client.callTool({ name: 'fai_browser_open', arguments: {
      origins: [fixtures.shop], mode: 'testing', reason: 'Show Test site mode on this local fixture',
      task: 'Read the local test shop.', allowedUrls: [`${fixtures.shop}/`], returnImages: 'none',
    } }, undefined, { timeout: 90_000 });
    const response = await ui.during(pending, { kind: 'request', url: `${fixtures.shop}/`, shot: 'test-site' });
    assert.ok(!response.isError);
    const text = response.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    assert.match(text, /^granted: testing/m);
    assert.ok(ui.saved.has('test-site'));
  } finally { await client.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--help')) console.log('Run via node scripts/record-demo.mjs --dry-run (isolated Firefox + real SDK session).');
  else { console.error('Use scripts/record-demo.mjs --dry-run. This session never attaches to an existing browser.'); process.exitCode = 1; }
}
