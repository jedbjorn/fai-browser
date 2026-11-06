import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getEncoding, Tiktoken } from 'js-tiktoken';

const KIMI_MODEL_URL = 'https://huggingface.co/moonshotai/Kimi-K2-Instruct/resolve/fd1984e2b7a3350dbf7305fe73a4ede25c14de50/tiktoken.model';
const DEFAULT_CACHE_DIR = join(import.meta.dirname, '.cache');

const KIMI_SPECIAL_TOKENS = {
  '[BOS]': 163584,
  '[EOS]': 163585,
  '<|im_end|>': 163586,
  '<|im_user|>': 163587,
  '<|im_assistant|>': 163588,
  '<|start_header_id|>': 163590,
  '<|end_header_id|>': 163591,
  '[EOT]': 163593,
  '<|im_system|>': 163594,
  '<|tool_calls_section_begin|>': 163595,
  '<|tool_calls_section_end|>': 163596,
  '<|tool_call_begin|>': 163597,
  '<|tool_call_argument_begin|>': 163598,
  '<|tool_call_end|>': 163599,
  '<|im_middle|>': 163601,
  '[UNK]': 163838,
  '[PAD]': 163839,
};

const CONTRACTIONS = "'s|'S|'t|'T|'re|'rE|'Re|'RE|'ve|'vE|'Ve|'VE|'m|'M|'ll|'lL|'Ll|'LL|'d|'D";
const KIMI_PATTERN = [
  '[\\p{Script=Han}]+',
  `[^\\r\\n\\p{L}\\p{N}]?(?:(?!\\p{Script=Han})[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}])*(?:(?!\\p{Script=Han})[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}])+(${CONTRACTIONS})?`,
  `[^\\r\\n\\p{L}\\p{N}]?(?:(?!\\p{Script=Han})[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}])+(?:(?!\\p{Script=Han})[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}])*(${CONTRACTIONS})?`,
  '\\p{N}{1,3}',
  ' ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*',
  '\\s*[\\r\\n]+',
  '\\s+(?!\\S)',
  '\\s+',
].join('|');

function baselineTokenizer() {
  return {
    id: 'chars4', label: 'Chars / 4', status: 'available', exact: false,
    note: 'Rough baseline: Math.ceil(UTF-16 code units / 4), not a model tokenizer.',
    count: text => Math.ceil(text.length / 4),
  };
}

function openAITokenizer() {
  const encoding = getEncoding('o200k_base');
  return {
    id: 'openaiO200k', label: 'OpenAI o200k_base', status: 'available', exact: true,
    encoding: 'o200k_base', implementation: 'js-tiktoken 1.0.21',
    note: 'Exact o200k_base encoding counts; the closest public encoding for current Sol/Astra-era OpenAI GPT models. No chat or tool envelope is added.',
    count: text => encoding.encode(text).length,
  };
}

function pendingTokenizer(id, label, model) {
  return {
    id, label, model, status: 'not measured in this run', exact: true, count: null,
    note: 'No official offline tokenizer is published for current Claude models. An optional owner run of bench/tokens/count-anthropic.mjs can use the count_tokens endpoint.',
  };
}

export function parseKimiModel(model) {
  const pieces = [];
  const specialTokens = { ...KIMI_SPECIAL_TOKENS };
  const lines = model.trimEnd().split('\n');
  for (let rank = 0; rank < lines.length; rank += 1) {
    const line = lines[rank];
    const separator = line.lastIndexOf(' ');
    if (separator < 1 || Number(line.slice(separator + 1)) !== rank) {
      throw new Error(`Unexpected Kimi vocabulary entry at rank ${rank}`);
    }
    pieces.push(line.slice(0, separator));
  }
  for (let id = lines.length; id < lines.length + 256; id += 1) {
    const token = `<|reserved_token_${id}|>`;
    if (!(token in specialTokens) && !Object.values(KIMI_SPECIAL_TOKENS).includes(id)) specialTokens[token] = id;
  }
  return { pat_str: KIMI_PATTERN, special_tokens: specialTokens, bpe_ranks: pieces.join(' ') };
}

async function kimiTokenizer(cacheDir) {
  const path = join(cacheDir, 'kimi-k2-tiktoken.model');
  let model;
  try {
    model = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(KIMI_MODEL_URL, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Kimi tokenizer download failed: HTTP ${response.status}`);
    model = await response.text();
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path, model);
  }
  const encoding = new Tiktoken(parseKimiModel(model));
  return {
    id: 'kimiK2', label: 'Kimi K2 tiktoken', status: 'available', exact: true,
    encoding: 'moonshotai/Kimi-K2-Instruct tiktoken.model', implementation: 'js-tiktoken 1.0.21',
    source: KIMI_MODEL_URL,
    note: 'Exact published Kimi K2 BPE counts using the official pattern translated from Python regex to JavaScript. No chat template, BOS/EOS or tool envelope is added.',
    count: text => encoding.encode(text, 'all').length,
  };
}

export async function createTokenizers({ cacheDir = DEFAULT_CACHE_DIR, includeKimi = true } = {}) {
  const tokenizers = [baselineTokenizer(), openAITokenizer()];
  if (includeKimi) tokenizers.push(await kimiTokenizer(cacheDir));
  tokenizers.push(
    pendingTokenizer('claudeSonnet55', 'Claude Sonnet 5.5', 'claude-sonnet-5-5'),
    pendingTokenizer('claudeOpus55', 'Claude Opus 5.5', 'claude-opus-5-5'),
  );
  return tokenizers;
}

export function publicTokenizers(tokenizers) {
  return tokenizers.map(({ count, ...metadata }) => metadata);
}
