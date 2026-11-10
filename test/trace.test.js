import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { imageSize, readRun, toAgentResult, writeRun } from '../src/trace.js';
import { prune, retentionConfig, RETENTION_DEFAULTS } from '../src/retention.js';

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEt8AAAAASUVORK5CYII=';

// Minimal JPEG header: SOI, APP0 (JFIF), SOF0 with height 20 and width 30.
function tinyJpeg() {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 20, 0x00, 30, 0x03, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-trace-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function v1Result(overrides = {}) {
  const observation = {
    revision: 'r2',
    url: 'https://example.com/about',
    title: 'About',
    text: 'Members: Ada',
    controls: [{ id: '1', role: 'link', label: 'Back', bounds: { x: 1, y: 2, width: 3, height: 4 } }],
  };
  return {
    v: 1,
    runId: 'run-1',
    status: 'completed',
    reason: 'Outcome independently verified',
    code: 'verified',
    needs: { who: 'none', message: '' },
    verification: { checked: true, passed: true, expectation: { urlIncludes: '/about' } },
    page: { url: observation.url, title: 'About', textExcerpt: 'Members: Ada', truncated: false, controls: [] },
    steps: [
      {
        i: 1,
        action: { type: 'click', ref: '2', label: 'About' },
        observation,
        screenshot: { dataUrl: `data:image/jpeg;base64,${tinyJpeg().toString('base64')}`, revision: 'r2', format: 'jpeg' },
      },
      {
        i: 2,
        action: { type: 'scroll', direction: 'down' },
        observation,
        screenshot: { dataUrl: `data:image/png;base64,${PNG_1X1}`, revision: 'r3', format: 'png' },
      },
      { i: 3, action: { type: 'wait' }, observation, screenshot: null },
    ],
    cost: { decisions: 3, inputTokens: 1, outputTokens: 1, elapsedMs: 5 },
    finalImage: { dataUrl: `data:image/png;base64,${PNG_1X1}`, revision: 'r3' },
    ...overrides,
  };
}

test('writeRun writes images as files and a trace with no base64', async t => {
  const dir = await scratch(t);
  const options = {
    allowedOrigins: ['https://example.com'],
    apiKey: 'must-not-appear',
    providerOptions: { endpoint: 'https://x', secret: 'nope' },
    onAction: () => {},
    signal: new AbortController().signal,
  };
  const written = await writeRun(v1Result(), {
    dir,
    instruction: 'Open About',
    operation: 'run',
    options,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
  });
  const raw = await readFile(written.trace, 'utf8');
  assert.ok(!raw.includes('base64'), 'trace must not embed base64');
  assert.ok(!raw.includes('data:image'), 'trace must not embed data URLs');
  assert.ok(!raw.includes('must-not-appear'));
  assert.ok(!raw.includes('nope'));
  assert.ok(!raw.includes('bounds'));

  assert.equal(written.runDir, join(dir, 'run-1'));
  assert.deepEqual(written.images, [join(dir, 'run-1', '1.jpg'), join(dir, 'run-1', '2.png'), null]);
  assert.deepEqual(await readFile(written.images[0]), tinyJpeg());
  assert.deepEqual(await readFile(written.images[1]), Buffer.from(PNG_1X1, 'base64'));

  const trace = JSON.parse(raw);
  assert.deepEqual(trace.steps[0].screenshot, {
    path: written.images[0],
    revision: 'r2',
    format: 'jpeg',
    width: 30,
    height: 20,
  });
  assert.equal(trace.steps[2].screenshot, null);
  assert.equal(trace.instruction, 'Open About');
  assert.equal(trace.startedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(trace.host.node, process.version);
  assert.deepEqual(trace.options, { allowedOrigins: ['https://example.com'], providerOptions: { endpoint: 'https://x' } });
  assert.equal(trace.page.url, 'https://example.com/about');
  assert.equal(trace.finalImage.path, join(dir, 'run-1', 'extra-1.png'));

  // The lean agent result: no screenshots (they stay in the trace and behind the evidence route), observations,
  // trace-only fields or extra keys.
  const agent = written.result;
  assert.equal(agent.trace, written.trace);
  assert.deepEqual(agent.steps[0], { i: 1, action: { type: 'click', label: 'About', toUrl: undefined }, ms: 0 });
  assert.equal(agent.steps[0].screenshot, undefined);
  assert.equal(agent.steps[0].observation, undefined);
  assert.equal(agent.instruction, undefined);
  assert.equal(agent.host, undefined);
  assert.equal(agent.finalImage, undefined);
  assert.equal(agent.needs, undefined, 'needs is omitted when nobody needs to act');
  assert.ok(!JSON.stringify(agent).includes('data:image'));

  const read = await readRun(written.runDir);
  assert.equal(read.runId, 'run-1');
  assert.equal((await readRun(written.trace)).steps.length, 3);
});

test('writeRun never escapes dir for a hostile runId', async t => {
  const dir = await scratch(t);
  const written = await writeRun(v1Result({ runId: '../escape' }), { dir });
  assert.equal(dirname(written.runDir), dir);
  assert.notEqual(written.runId, '../escape');
});

test('written traces keep the supplied value name, never the value', async t => {
  const dir = await scratch(t);
  const value = 'Alex-Secret-Value';
  const fill = { type: 'fill_supplied_text', ref: '4', label: 'Name', suppliedName: 'name', text: value };
  const result = v1Result({ steps: [{ i: 1, action: fill, observation: null, screenshot: null }] });
  const written = await writeRun(result, { dir, options: { suppliedText: { name: value } } });
  const raw = await readFile(written.trace, 'utf8');
  assert.ok(!raw.includes(value), 'trace must not contain supplied text');
  const trace = JSON.parse(raw);
  assert.equal(trace.steps[0].action.suppliedName, 'name');
  assert.equal(trace.steps[0].action.text, undefined);
  assert.deepEqual(trace.options.suppliedText, { name: '[redacted]' });
  assert.ok(!JSON.stringify(written.result).includes(value), 'stdout result must not contain supplied text');
  assert.equal(result.steps[0].action.text, value, 'the in-memory result is not mutated');
});

test('imageSize reads PNG and JPEG headers', () => {
  assert.deepEqual(imageSize(Buffer.from(PNG_1X1, 'base64')), { width: 1, height: 1 });
  assert.deepEqual(imageSize(tinyJpeg()), { width: 30, height: 20 });
  assert.deepEqual(imageSize(Buffer.from('not an image')), {});
});

async function makeRun(dir, runId, ageMs, bytes = 10) {
  const path = join(dir, runId);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'trace.json'), '{}');
  await writeFile(join(path, '1.jpg'), Buffer.alloc(bytes));
  const time = new Date(Date.now() - ageMs);
  await utimes(path, time, time);
}

test('prune deletes oldest runs first and honors keep', async t => {
  const dir = await scratch(t);
  for (const [index, runId] of ['a', 'b', 'c', 'd', 'e'].entries()) {
    await makeRun(dir, runId, (5 - index) * 60_000);
  }
  const result = await prune(dir, { maxRuns: 2, keep: ['a'] });
  assert.deepEqual(result.pruned.map(run => run.runId), ['b', 'c', 'd']);
  assert.deepEqual((await readdir(dir)).sort(), ['a', 'e']);
  assert.equal(result.remaining.runs, 2);
});

test('prune enforces size and age limits', async t => {
  const dir = await scratch(t);
  await makeRun(dir, 'old', 10 * 24 * 3600_000);
  await makeRun(dir, 'big1', 3 * 60_000, 1000);
  await makeRun(dir, 'big2', 2 * 60_000, 1000);
  await makeRun(dir, 'new', 60_000, 1000);
  const result = await prune(dir, { maxBytes: 2100 });
  assert.deepEqual(result.pruned.map(run => [run.runId, run.reason]), [['old', 'size+age'], ['big1', 'size']]);
  const ageOnly = await scratch(t);
  await makeRun(ageOnly, 'stale', 8 * 24 * 3600_000);
  await makeRun(ageOnly, 'fresh', 60_000);
  const aged = await prune(ageOnly, {});
  assert.deepEqual(aged.pruned.map(run => [run.runId, run.reason]), [['stale', 'age']]);
  assert.deepEqual((await readdir(dir)).sort(), ['big2', 'new']);
});

test('prune never touches non-run entries, symlinks or anything outside dir', async t => {
  const base = await scratch(t);
  const dir = join(base, 'artifacts');
  const outside = join(base, 'outside');
  await mkdir(dir);
  await makeRun(base, 'outside', 30 * 24 * 3600_000);
  await mkdir(join(dir, 'manual-active-tab', 'nested'), { recursive: true });
  await writeFile(join(dir, 'notes.txt'), 'keep me');
  await symlink(outside, join(dir, 'link-to-outside'));
  await makeRun(dir, 'run-old', 30 * 24 * 3600_000);
  const result = await prune(dir, { maxRuns: 0 });
  assert.deepEqual(result.pruned.map(run => run.runId), ['run-old']);
  assert.deepEqual((await readdir(dir)).sort(), ['link-to-outside', 'manual-active-tab', 'notes.txt']);
  assert.ok((await stat(join(outside, 'trace.json'))).isFile());
  assert.deepEqual(await prune(join(base, 'missing'), {}), { pruned: [], remaining: { runs: 0, bytes: 0 } });
});

test('retention config merges defaults, options and environment', () => {
  assert.deepEqual(retentionConfig(undefined, {}), { ...RETENTION_DEFAULTS });
  assert.equal(retentionConfig(false, {}), null);
  assert.deepEqual(
    retentionConfig({ maxRuns: 5, maxBytes: 100 }, { FAI_RETENTION_MAX_RUNS: '7' }),
    { maxRuns: 7, maxBytes: 100, maxAgeMs: RETENTION_DEFAULTS.maxAgeMs },
  );
  assert.throws(() => retentionConfig({ maxRuns: -1 }, {}), /non-negative/);
  assert.throws(() => retentionConfig({ maxRunz: 1 }, {}), /Unknown retention/);
  assert.throws(() => retentionConfig(undefined, { FAI_RETENTION_MAX_BYTES: 'lots' }), /FAI_RETENTION_MAX_BYTES/);
});

test('toAgentResult drops page controls from traces written before the digest', () => {
  const old = toAgentResult({ v: 1, page: { url: 'u', title: 't', textExcerpt: 'x', truncated: false, controls: [] },
    steps: [], host: {} });
  assert.deepEqual(old.page, { url: 'u', title: 't', digest: [], textExcerpt: 'x', truncated: false });
});
