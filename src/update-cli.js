// `fai-browser update [--check]` and the internal `update --finish` (docs/REFERENCE.md "Updates").
//   update --check   check for a newer release now (even with the automatic check off) and print the result
//   update           install the latest release into this git checkout (src/update-install.js), when there is one;
//                    after an interrupted update (the checkout already at the release) finish it: refresh and restart
//   update --finish  (run by the updater from the new version) refresh browser pairing and installed skills
// Each prints one JSON line; exit 0 on success or nothing to do, 1 when refused or failed. Every run that gets past
// the argument check leaves an install record (update-install.json) for the popup, except while another live updater
// owns it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from './paths.js';
import { homePaths, loadConfig } from './home.js';
import { automaticCheck, isReleaseTag, readCheckState, readInstallState, runCheck, runningUpdate, underTest, updatePaths,
  updateView, writeInstallState } from './update.js';
import { UpdateFailed, UpdateRefused, defaultSteps, firstLine, gitRunner, installUpdate, takeUpdateLock,
  updateLogger } from './update-install.js';
import { gitReleaseSource, scrubbedEnv } from './update-git.js';

function packageVersion(root = PACKAGE_ROOT) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

function configOf(paths) {
  try {
    return loadConfig(paths);
  } catch {
    return {};
  }
}

/** The refresh steps of this (new) version: browser pairing where it is installed, user-level skills. No secrets. */
export async function finishInstall({ env = process.env } = {}) {
  const { applyNativeInstall, planNativeInstall } = await import('./native.js');
  const { refreshUserSkills } = await import('./install.js');
  const result = { state: 'finished', native: [], skills: [] };
  const plan = planNativeInstall({ env });
  // Only what setup or install-native wrote before: the launcher and the manifests that exist.
  if (existsSync(plan.launcher.path)) {
    const browsers = plan.browsers.filter(browser => existsSync(browser.path));
    if (browsers.length) result.native = (await applyNativeInstall({ ...plan, browsers })).browsers.map(browser => browser.id);
  }
  result.skills = await refreshUserSkills({ home: env.HOME || undefined });
  return result;
}

function refusal(paths, error, current, target) {
  const hint = error.hint ? ` ${error.hint}` : '';
  writeInstallState(paths, { state: 'failed', from: current, to: target ?? null, step: 'check', error: error.code,
    message: `${error.message}${hint}` });
  return { value: { state: 'refused', code: error.code, message: error.message, hint: error.hint ?? null }, exitCode: 1 };
}

/** Lease state from a running daemon; [] when none answers (then nothing holds a tab). */
async function liveRequests({ home, env }) {
  const { FaiBrowserClient } = await import('./client.js');
  let client;
  try {
    client = await FaiBrowserClient.connect({ home, env, autoStart: false, clientName: 'update' });
  } catch {
    return [];
  }
  const status = await client.status();
  return status?.requests ?? [];
}

const NEXT = 'Restart your coding agent so it loads the new MCP server and skill. A Chromium-family browser reloads '
  + 'the extension by itself; Firefox updates the signed add-on by itself (not while the repository is private).';

/**
 * Run the command. `options` replace the network and process steps in tests: `fetch`, `gitSource`, `steps`, `git`,
 * `remoteOk`, `root`, `requests`, `currentVersion`.
 */
export async function updateCommand(flags, { home, env: rawEnv = process.env, ...options } = {}) {
  // No FAI secret (the Jev key, a pairing-secret override, a client token) reaches anything this command starts.
  const env = scrubbedEnv(rawEnv);
  if (flags.finish) return { value: await finishInstall({ env }), exitCode: 0 };
  const paths = homePaths({ home, env });
  const root = options.root ?? PACKAGE_ROOT;
  const current = options.currentVersion ?? packageVersion(root);
  const enabled = automaticCheck({ env, config: configOf(paths), override: true }).enabled;
  const installable = existsSync(join(root, '.git'));
  const record = fields => {
    if (!runningUpdate(paths) || runningUpdate(paths) === process.pid) writeInstallState(paths, { from: current, ...fields });
  };
  if (flags.tag !== undefined && !isReleaseTag(flags.tag)) {
    record({ state: 'failed', to: null, step: 'check', error: 'bad_release', message: '--tag must be a release tag like v1.2.3.' });
    return { value: { state: 'refused', code: 'bad_release', message: '--tag must be a release tag like v1.2.3' }, exitCode: 1 };
  }
  // The user asked: one check now (a result younger than a minute is reused), even with the automatic check off.
  // Under node --test nothing reaches GitHub or a remote unless the test supplies its own.
  const test = underTest(rawEnv);
  const fetchImpl = options.fetch ?? (test ? async () => { throw new Error('offline under test'); } : undefined);
  const gitSource = options.gitSource ?? (test || !installable ? null : gitReleaseSource({ root, env, remoteOk: options.remoteOk }));
  await runCheck({ paths, currentVersion: current, fetch: fetchImpl, force: true, gitSource });
  const view = updateView({ paths, currentVersion: current, enabled, installable });
  if (flags.check) return { value: { update: view }, exitCode: view.status === 'error' ? 1 : 0 };

  const running = runningUpdate(paths);
  if (running && running !== process.pid) {
    // Another live updater owns the record; leave it alone.
    return { value: { state: 'refused', code: 'update_running', message: `An update (pid ${running}) is running.` }, exitCode: 1 };
  }
  const last = readInstallState(paths);
  // An update stopped after the move (the checkout is already the release): finish it.
  // (`to` is this version, so the move happened; interrupted, or the refresh or restart failed with no rollback.)
  const resume = !view.available && last?.state === 'failed' && last.to === current
    && (last.error === 'interrupted' || ['finish', 'restart'].includes(last.step));
  if (!view.available && !resume) {
    const failed = ['error', 'rate_limited', 'never'].includes(view.status);
    // not_found: no published release (none yet, or the repository is not visible to this check).
    const state = failed ? 'check_failed' : view.status === 'not_found' ? 'no_release' : 'up_to_date';
    record(failed ? { state: 'failed', to: null, step: 'check', error: view.error ?? 'check_failed',
      message: 'Could not check for a new release; try again later.' }
      : { state: 'up_to_date', to: current, step: 'check', message: state === 'no_release' ? 'No published release found.'
        : `FAI Browser ${current} is the latest release.` });
    return { value: { state, update: view }, exitCode: failed ? 1 : 0 };
  }
  const latest = resume ? null : readCheckState(paths).latest;
  if (flags.tag !== undefined && !resume && flags.tag !== latest.tag) {
    return refusal(paths, new UpdateRefused('release_changed', `The latest release is now ${latest.tag}, not ${flags.tag}.`,
      'Open the popup again to see it.'), current, latest.version);
  }
  const target = resume ? current : latest.version;
  const log = updateLogger(paths);
  let release;
  try {
    release = await takeUpdateLock(paths);
  } catch (error) {
    if (error instanceof UpdateRefused) return { value: { state: 'refused', code: error.code, message: error.message }, exitCode: 1 };
    record({ state: 'failed', to: target, step: 'check', error: 'lock_failed', message: `Could not take the update lock: ${firstLine(error)}` });
    return { value: { state: 'failed', code: 'lock_failed', message: firstLine(error) }, exitCode: 1 };
  }
  const steps = options.steps ?? defaultSteps({ root, env, home });
  try {
    const requests = options.requests ?? await liveRequests({ home, env });
    if (resume) return await resumeInstall({ paths, current, requests, steps, log });
    if (!latest.commit) {
      throw new UpdateRefused('release_unverified', `Could not confirm which commit ${latest.tag} names.`,
        'Try again in a while (node src/cli.js update).');
    }
    writeInstallState(paths, { pid: process.pid, state: 'running', from: current, to: latest.version, step: 'check',
      message: `Installing ${latest.version}.` });
    await log('update_start', { from: current, to: latest.version, source: view.source });
    const result = await installUpdate({ root, target: latest, currentVersion: current, requests, log, paths, steps, env,
      git: options.git ?? gitRunner({ cwd: root, env }), ...(options.remoteOk ? { remoteOk: options.remoteOk } : {}) });
    const warned = result.warnings.length ? ` Warning: ${result.warnings.join('; ')}.` : '';
    writeInstallState(paths, { state: 'succeeded', from: current, to: latest.version, step: 'done',
      message: `Updated to ${latest.version}. Restart your coding agent to load the new MCP server and skill.${warned}` });
    return { value: { ...result, next: NEXT, log: updatePaths(paths).log }, exitCode: 0 };
  } catch (error) {
    if (error instanceof UpdateRefused) {
      await log('update_refused', { code: error.code });
      return refusal(paths, error, current, target);
    }
    const failed = error instanceof UpdateFailed ? error : new UpdateFailed('internal', firstLine(error));
    // Before the move nothing changed: report the real reason. After it: rolled back, or the rollback's own failure.
    const state = failed.moved && failed.rolledBack ? 'rolled_back' : 'failed';
    const message = !failed.moved ? `${failed.message}. Nothing was changed.`
      : failed.rolledBack ? `${failed.message}. Rolled back to ${current}.`
        : `${failed.message}. Rollback failed: ${failed.rollbackError}; see ${updatePaths(paths).log}.`;
    writeInstallState(paths, { state, from: current, to: target, step: failed.step, error: 'update_failed', message });
    await log('update_failed', { state, step: failed.step, moved: failed.moved });
    return { value: { state, code: 'update_failed', step: failed.step, message, log: updatePaths(paths).log }, exitCode: 1 };
  } finally {
    await release();
  }
}

/** Finish an update that stopped after the move: the new version's refresh and a restart (no lease may be held). */
async function resumeInstall({ paths, current, requests, steps, log }) {
  const { refuseLeases } = await import('./update-install.js');
  refuseLeases(requests);
  writeInstallState(paths, { pid: process.pid, state: 'running', from: current, to: current, step: 'finish',
    message: `Finishing the update to ${current}.` });
  await log('update_resume', { version: current });
  let step = 'finish';
  try {
    await steps.finish();
    step = 'restart';
    await steps.restart(current);
  } catch (error) {
    if (error instanceof UpdateRefused) throw error;
    const message = `Finishing the update to ${current} failed at ${step}: ${firstLine(error)}. Run node src/cli.js update again.`;
    writeInstallState(paths, { state: 'failed', from: current, to: current, step, error: 'update_failed', message });
    await log('update_failed', { state: 'failed', step, resumed: true });
    return { value: { state: 'failed', code: 'update_failed', step, message, log: updatePaths(paths).log }, exitCode: 1 };
  }
  writeInstallState(paths, { state: 'succeeded', from: current, to: current, step: 'done',
    message: `Finished the update to ${current}. Restart your coding agent to load the new MCP server and skill.` });
  await log('update_done', { to: current, resumed: true });
  return { value: { state: 'succeeded', resumed: true, to: current, next: NEXT, log: updatePaths(paths).log }, exitCode: 0 };
}
