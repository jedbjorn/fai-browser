import { readFile, writeFile, rename, mkdir, mkdtemp, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexInfo, readFinal } from '../bench/lib/codex.mjs';
import { validateTask, manifestHash, recoveryDecision, recoveryPrompt, pilotArgs, segmentEvidence, aggregateSegments, trustedReceipt } from '../bench/lib/pilot-recovery.mjs';
import { runPilotProcess } from '../bench/lib/pilot-process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => { await writeFile(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(path + '.tmp', path); };
async function main() {
  process.umask(0o077);
  const args = process.argv.slice(2);
  let source, session, freshApproval = false, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--new-from') source = args[++i];
    else if (args[i] === '--resume') session = args[++i];
    else if (args[i] === '--fresh-approval') freshApproval = true;
    else if (args[i] === '--dry-run') dryRun = true;
    else throw new Error('Usage: --new-from OLD_PILOT_DIR | --resume SESSION_DIR [--fresh-approval] [--dry-run]');
  }
  if (Boolean(source) === Boolean(session)) throw new Error('Choose exactly one of --new-from or --resume.');
  let ledger;
  if (source) {
    source = resolve(source);
    const plan = await json(source + '/plan.json');
    if (plan.timeoutS !== 600 || plan.effort !== 'medium') throw new Error('Importer supports only the reviewed 600-second, medium-effort pilot format.');
    const prompt = await readFile(source + '/prompt.txt', 'utf8');
    const events = (await readFile(source + '/events.jsonl', 'utf8')).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    if (segmentEvidence(events, { exitCode: 0 }).state === 'blocked') throw new Error('The source attempt ended at a guard refusal; this recovery command cannot retry it.');
    const firstOpen = events.find(e => e.item?.tool === 'fai_browser_open' && e.item.arguments)?.item.arguments;
    const callLimit = /At most (\d+) FAI calls/.exec(prompt);
    if (!callLimit) throw new Error('Original explicit call budget is missing.');
    const task = validateTask({ model: plan.modelRequested, provider: plan.providerRequested, prompt, open: firstOpen,
      maxCalls: Number(callLimit[1]) });
    await mkdir('/tmp/fai-resumable-pilot', { recursive: true, mode: 0o700 });
    session = await mkdtemp('/tmp/fai-resumable-pilot/session-');
    ledger = { schema: 1, task, taskHash: manifestHash(task), priorAttempt: { directory: source, relationship: 'Separate earlier attempt; not a resumed host or included in this attempt totals.' }, segments: [] };
    await save(session + '/checkpoint.json', ledger);
  } else { session = resolve(session); ledger = await json(session + '/checkpoint.json'); }
  if (ledger.schema !== 1 || manifestHash(ledger.task) !== ledger.taskHash) throw new Error('Checkpoint task integrity failed.');
  if (ledger.running) throw new Error('An earlier segment is still running or ended without a checkpoint. Its duration/outcome is unknown; refusing to extend its budget.');
  const decision = recoveryDecision(ledger.task, ledger.segments, { freshApproval });
  const info = await codexInfo();
  if (info.error) throw new Error(info.error);
  console.log(JSON.stringify({ session, phase: dryRun ? 'dry-run' : 'prepared', ...decision, modelRequested: ledger.task.model }));
  if (dryRun) return;
  const lockPath = session + '/running.lock';
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    // Recheck after lock acquisition so two user commands cannot consume the same checkpoint.
    const current = await json(session + '/checkpoint.json');
    if (manifestHash(current) !== manifestHash(ledger)) throw new Error('Checkpoint changed; retry against the current saved state.');
    const dir = await mkdtemp(session + '/segment-');
    const previous = ledger.segments.at(-1);
    const prompt = recoveryPrompt(ledger.task, decision, previous ? await readFinal(previous.directory + '/answer.txt') ?? '' : '');
    const argv = pilotArgs({ task: ledger.task, root, workdir: dir, finalPath: dir + '/answer.txt', features: info.features });
    await writeFile(dir + '/prompt.txt', prompt);
    const startedAt = new Date().toISOString();
    ledger.running = { directory: dir, startedAt, decision };
    await save(session + '/checkpoint.json', ledger);
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    let result;
    try { result = await runPilotProcess({ args: argv, prompt, dir, timeoutMs: decision.remainingMs, signal: controller.signal,
      onEvent(event) {
        if (event.item?.type !== 'mcp_tool_call') return;
        console.log(JSON.stringify({ event: event.type, tool: event.item.tool }));
        if (event.type === 'item.completed') {
          const receipt = trustedReceipt(event.item.result);
          if (receipt.needs) console.log('needs: ' + receipt.needs);
          if (receipt.requestId) console.log('requestId: ' + receipt.requestId);
        }
      } }); }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
    const { events, ...execution } = result;
    const segment = { directory: dir, startedAt, endedAt: new Date().toISOString(), decision, ...execution,
      ...segmentEvidence(events, { ...execution, requestId: decision.requestId ?? null }) };
    ledger.segments.push(segment); delete ledger.running;
    ledger.totals = aggregateSegments(ledger.segments);
    await save(session + '/checkpoint.json', ledger);
    console.log(JSON.stringify({ session, state: segment.state, requestId: segment.requestId, totals: ledger.totals }));
    console.log('Recovery starts a fresh host, never replays an action, and requires a fresh observation. Browser disconnect cleanup may end the request.');
    console.log('Saved answer and evidence: ' + dir);
    if (['interrupted', 'awaiting_user', 'request_ended'].includes(segment.state)) {
      console.log(`To continue an ordinary interruption: node scripts/resumable-pilot.mjs --resume ${session}`);
      console.log('If the old request ended, add --fresh-approval for a new request with the same scope.');
    } else console.log('This attempt is terminal for the recovery wrapper; no automatic retry is available.');
    process.exitCode = result.exitCode === 0 ? 0 : 1;
  } finally { await lock.close(); await unlink(lockPath); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
