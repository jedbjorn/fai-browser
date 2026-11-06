// The product tree a corpus session runs: `--tree <path>` (or FAI_BENCH_TREE) points the runners at another checkout,
// for example a worktree of an earlier tag, whose src/ (daemon, SDK client, receipt shaping, step caps) and extension/
// are used while the runner, the corpus and the grader stay this checkout's. Default: this checkout. Read from argv at
// load time so the modules that need the tree's caps (bench/long/lib.mjs) can resolve them before parsing flags.
// Only bench/long/run.mjs honours it fully; bench/qa/run.mjs still shapes receipts with this checkout's src/.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE_ROOT = resolve(import.meta.dirname, '..', '..');
const flag = process.argv.indexOf('--tree');
const chosen = flag >= 0 ? process.argv[flag + 1] : process.env.FAI_BENCH_TREE;
export const TREE = chosen ? resolve(chosen) : HERE_ROOT;
export const OTHER_TREE = TREE !== HERE_ROOT;
if (OTHER_TREE && !existsSync(join(TREE, 'src', 'daemon-main.js'))) throw new Error(`--tree ${TREE}: no src/daemon-main.js`);

/** Import `rel` (e.g. 'src/result.js') from the selected tree. */
export function treeImport(rel) {
  return import(pathToFileURL(join(TREE, rel)).href);
}
