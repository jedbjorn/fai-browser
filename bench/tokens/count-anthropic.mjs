#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarize, writeResults } from './measure.mjs';

const DIRECTORY = import.meta.dirname;
const MODELS = [
  { id: 'claudeSonnet55', model: 'claude-sonnet-5-5' },
  { id: 'claudeOpus55', model: 'claude-opus-5-5' },
];
const hash = text => createHash('sha256').update(text).digest('hex');
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));

async function countTokens(key, model, text) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': key,
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) {
      const result = await response.json();
      if (!Number.isInteger(result.input_tokens)) throw new Error('Anthropic response has no integer input_tokens');
      return result.input_tokens;
    }
    if (attempt === 3 || (response.status !== 429 && response.status < 500)) {
      throw new Error(`Anthropic count_tokens failed for ${model}: HTTP ${response.status}`);
    }
    await pause(1000 * 2 ** attempt);
  }
  throw new Error('Unreachable retry state');
}

export async function mergeAnthropic({ input, outDir, key }) {
  if (!key) throw new Error('Owner run only: set ANTHROPIC_API_KEY in the environment');
  const data = JSON.parse(await readFile(input, 'utf8'));
  if (data.corpus !== 'real') throw new Error('Anthropic merging expects real-corpus measurement strings');
  const cachePath = join(outDir, 'pages', 'anthropic-counts.json');
  await mkdir(join(outDir, 'pages'), { recursive: true });
  let cache = {};
  try {
    cache = JSON.parse(await readFile(cachePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const strings = new Map();
  for (const page of data.pages) {
    for (const measured of Object.values(page.samples)) {
      if (measured.text) strings.set(hash(measured.text), measured.text);
    }
  }
  for (const { model } of MODELS) {
    cache[model] ??= {};
    for (const [digest, text] of strings) {
      if (Number.isInteger(cache[model][digest])) continue;
      cache[model][digest] = await countTokens(key, model, text);
      await writeFile(cachePath, JSON.stringify(cache, null, 2) + '\n');
      await pause(100);
    }
  }

  for (const { id, model } of MODELS) {
    const tokenizer = data.tokenizers.find(entry => entry.id === id);
    if (!tokenizer) throw new Error(`Missing tokenizer metadata: ${id}`);
    tokenizer.status = 'available';
    tokenizer.note = `Exact Anthropic /v1/messages/count_tokens count for ${model}, using one user message containing the measured string. Includes that endpoint's minimal message envelope.`;
    for (const page of data.pages) {
      for (const measured of Object.values(page.samples)) {
        measured.tokens[id] = measured.text ? cache[model][hash(measured.text)] : 0;
      }
    }
  }
  data.summary = summarize(data.pages, data.tokenizers);
  data.generatedAt = new Date().toISOString();
  const results = await writeResults(data, outDir);
  return { models: MODELS.map(({ model }) => model), pages: data.pages.length, uniqueStrings: strings.size, results };
}

async function cli() {
  let input = join(DIRECTORY, 'pages', 'measurement-strings.json');
  let outDir = DIRECTORY;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input') input = resolve(args[++i]);
    else if (args[i] === '--out') outDir = resolve(args[++i]);
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  const result = await mergeAnthropic({ input, outDir, key: process.env.ANTHROPIC_API_KEY });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await cli();
