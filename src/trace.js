// Trace writer: turns a runtime result into an on-disk run record with no embedded base64.
// <dir>/<runId>/trace.json plus one image file per captured step.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { agentResult, redactSecrets } from './result.js';
import { scrubSecrets } from './secrets.js';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const PACKAGE_VERSION = readPackageVersion();
const DATA_URL = /^data:image\/(png|jpeg|jpg|webp);base64,(.*)$/s;
const SECRET_KEY = /(api[-_]?key|secret|token|password|authorization|cookie)/i;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

export function hostInfo() {
  return {
    node: process.version,
    package: 'fai-browser',
    version: PACKAGE_VERSION,
    platform: process.platform,
    arch: process.arch,
  };
}

// Options as recorded in the trace: no functions, signals, or anything that looks like a credential.
export function sanitizeOptions(value, depth = 0) {
  if (depth > 6) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeOptions(item, depth + 1)).filter(item => item !== undefined);
  }
  if (value && typeof value === 'object') {
    if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) {
      return undefined;
    }
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key) || typeof item === 'function') {
        continue;
      }
      const next = sanitizeOptions(item, depth + 1);
      if (next !== undefined) {
        clean[key] = next;
      }
    }
    return clean;
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return undefined;
  }
  return value;
}

function imageFormat(screenshot) {
  const match = DATA_URL.exec(screenshot?.dataUrl || '');
  if (screenshot?.format === 'jpeg' || screenshot?.format === 'png') {
    return screenshot.format;
  }
  if (!match) {
    return undefined;
  }
  return match[1] === 'png' ? 'png' : 'jpeg';
}

// Reads width and height from PNG IHDR or a JPEG SOF marker without decoding the image.
export function imageSize(buffer) {
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return {};
  }
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return {};
}

function stripBounds(observation) {
  if (!observation || typeof observation !== 'object') {
    return observation;
  }
  if (!Array.isArray(observation.controls)) {
    return { ...observation };
  }
  return {
    ...observation,
    controls: observation.controls.map(control => {
      const { bounds, ...rest } = control || {};
      return rest;
    }),
  };
}

// Supplied form values never reach disk: a written step keeps `suppliedName`, not the value in `text`.
function redactStepAction(action) {
  if (!action || typeof action !== 'object' || !('text' in action)) {
    return action;
  }
  const { text, ...rest } = action;
  return rest;
}

// The options block records which supplied values existed, not what they were.
function redactSuppliedOptions(options) {
  const supplied = options?.suppliedText;
  if (!supplied || typeof supplied !== 'object') {
    return options;
  }
  return {
    ...options,
    suppliedText: Object.fromEntries(Object.keys(supplied).map(name => [name, '[redacted]'])),
  };
}

// Probabilities are non-enumerable on in-memory step decisions (kept out of results); the trace records them.
function traceDecision(decision) {
  if (!decision || typeof decision !== 'object') return decision;
  const copy = { ...decision };
  if (decision.probabilities && copy.probabilities === undefined) copy.probabilities = decision.probabilities;
  return copy;
}

async function writeImage(runDir, name, screenshot) {
  const match = DATA_URL.exec(screenshot?.dataUrl || '');
  if (!match) {
    return null;
  }
  const format = imageFormat(screenshot);
  const path = join(runDir, `${name}.${format === 'png' ? 'png' : 'jpg'}`);
  const bytes = Buffer.from(match[2], 'base64');
  await writeFile(path, bytes, { mode: 0o600 });
  return {
    path,
    revision: screenshot.revision,
    ...(typeof screenshot.observedRevision === 'string' ? { observedRevision: screenshot.observedRevision } : {}),
    format,
    ...imageSize(bytes),
    // The action-id badges drawn (extension/offscreen.js), in image pixels, when the capture had the offer's ids.
    ...(Array.isArray(screenshot.tags) ? { tags: screenshot.tags } : {}),
    // Secret boxes on the image (extension/offscreen.js), and `redaction: "withheld"` for a frame filled solid black.
    ...(Number.isInteger(screenshot.redactions) ? { redactions: screenshot.redactions } : {}),
    ...(screenshot.redaction === 'withheld' ? { redaction: 'withheld' } : {}),
  };
}

// Replaces any remaining {dataUrl:'data:image/...'} object outside steps with a file reference,
// and any stray data: string with a marker, so the trace can never carry base64.
async function externalizeImages(value, runDir, counter) {
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      out.push(await externalizeImages(item, runDir, counter));
    }
    return out;
  }
  if (value && typeof value === 'object') {
    if (typeof value.dataUrl === 'string' && DATA_URL.test(value.dataUrl)) {
      counter.n++;
      const file = await writeImage(runDir, `extra-${counter.n}`, value);
      counter.paths.push(file.path);
      return file;
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = await externalizeImages(item, runDir, counter);
    }
    return out;
  }
  if (typeof value === 'string' && value.startsWith('data:')) {
    return '[omitted data URL]';
  }
  return value;
}

function safeRunId(runId) {
  return typeof runId === 'string' && RUN_ID.test(runId) ? runId : randomUUID();
}

/**
 * Writes <dir>/<runId>/trace.json and step images from a v1 runtime result.
 * Returns {runId, runDir, trace, images, result} where result is the agent-facing (stdout) object.
 * Supplied form text is dropped: steps keep `action.suppliedName` and options keep only suppliedText keys.
 */
export async function writeRun(result, {
  dir,
  instruction,
  operation,
  options = {},
  startedAt,
  finishedAt,
} = {}) {
  if (!dir) {
    throw new Error('writeRun requires a dir');
  }
  const runId = safeRunId(result.runId);
  const runDir = join(resolve(dir), runId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });

  const images = [];
  const traceSteps = [];
  for (const [index, step] of (result.steps || []).entries()) {
    const number = Number.isInteger(step.i) ? step.i : index + 1;
    const screenshot = step.screenshot ? await writeImage(runDir, String(number), step.screenshot) : null;
    images.push(screenshot ? screenshot.path : null);
    traceSteps.push({
      ...step,
      i: number,
      decision: traceDecision(step.decision),
      action: redactStepAction(step.action),
      observation: stripBounds(step.observation),
      screenshot,
    });
  }

  const tracePath = join(runDir, 'trace.json');
  const counter = { n: 0, paths: [] };
  // Everything the result leaves out for the host stays here: the full final observation (text, blocks and
  // controls, without bounds) and how the answer candidates were ranked.
  const diagnostics = {};
  if (result.observation) diagnostics.finalObservation = stripBounds(result.observation);
  if (result.answerDetail) diagnostics.answerDetail = result.answerDetail;
  // The run's fact memory: the relevant lines of every page state it saw (bounded, supplied values redacted).
  if (Array.isArray(result.facts) && result.facts.length) diagnostics.facts = result.facts.map(entry => structuredClone(entry));
  if (result.errorDetail) diagnostics.errorDetail = result.errorDetail;
  // Per-request usage (non-enumerable on the result, from older runs): numbers and fixed codes only.
  if (Array.isArray(result.cost?.requests)) {
    diagnostics.cost = { ...result.cost, requests: result.cost.requests.map(entry => ({ ...entry })) };
  }
  const trace = await externalizeImages({
    ...result,
    ...diagnostics,
    runId,
    steps: traceSteps,
    page: stripBounds(result.page),
    trace: tracePath,
    instruction,
    operation,
    options: sanitizeOptions(redactSuppliedOptions(options)),
    startedAt,
    finishedAt,
    host: hostInfo(),
  }, runDir, counter);
  // Values filled into password inputs (sign_in) never reach disk or the agent result, wherever the page echoed them.
  redactSecrets(trace, result.secrets);
  // Secrets a page showed (src/secrets.js): the extension redacted them; this pass is the trace's own guarantee.
  const safe = scrubSecrets(trace);
  await writeFile(tracePath, JSON.stringify(safe, null, 2), { mode: 0o600 });

  return {
    runId,
    runDir,
    trace: tracePath,
    images,
    result: toAgentResult(safe),
  };
}

// The agent-facing shape (CLI stdout and daemon results, summarized as text by MCP): the lean result from result.js. No
// per-step observations, screenshots, decision probabilities, page controls or trace-only diagnostics; those stay
// in trace.json and are served by the evidence route.
export function toAgentResult(trace) {
  return agentResult(trace);
}

/** Reads a trace by run directory or trace.json path. */
export async function readRun(path) {
  let file = resolve(path);
  if ((await stat(file)).isDirectory()) {
    file = join(file, 'trace.json');
  }
  const trace = JSON.parse(await readFile(file, 'utf8'));
  return { ...trace, runDir: dirname(file) };
}
