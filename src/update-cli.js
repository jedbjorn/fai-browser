// `fai-browser update [--check]` and the internal `update --finish` (docs/REFERENCE.md "Updates").
//   update --check   check GitHub for a newer release now (even with the automatic check off) and print the result
//   update           install the latest release into this git checkout (src/update-install.js), when there is one
//   update --finish  (run by the updater from the new version) refresh browser pairing and installed skills
// Each prints one JSON line; exit 0 on success or nothing to do, 1 when refused or failed.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from './paths.js';
import { homePaths, loadConfig } from './home.js';
import { automaticCheck, isReleaseTag, readCheckState, runCheck, runningUpdate, updatePaths, updateView,
  writeInstallState } from './update.js';
import { UpdateFailed, UpdateRefused, installUpdate, takeUpdateLock, updateLogger } from './update-install.js';

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

/**
 * Run the command. `options` replace the network and process steps in tests: `fetch`, `steps`, `git`, `remoteOk`,
 * `root`, `requests`, `currentVersion`.
 */
export async function updateCommand(flags, { home, env = process.env, ...options } = {}) {
  if (flags.finish) return { value: await finishInstall({ env }), exitCode: 0 };
  const paths = homePaths({ home, env });
  const root = options.root ?? PACKAGE_ROOT;
  const current = options.currentVersion ?? packageVersion(root);
  const enabled = automaticCheck({ env, config: configOf(paths), override: true }).enabled;
  if (flags.tag !== undefined && !isReleaseTag(flags.tag)) {
    return { value: { state: 'refused', code: 'bad_release', message: '--tag must be a release tag like v1.2.3' }, exitCode: 1 };
  }
  // The user asked: one check now (a result younger than a minute is reused), even with the automatic check off.
  await runCheck({ paths, currentVersion: current, fetch: options.fetch, force: true });
  const view = updateView({ paths, currentVersion: current, enabled });
  if (flags.check) return { value: { update: view }, exitCode: view.status === 'error' ? 1 : 0 };
  if (!view.available) {
    const failed = ['error', 'rate_limited', 'never'].includes(view.status);
    return { value: { state: failed ? 'check_failed' : 'up_to_date', update: view }, exitCode: failed ? 1 : 0 };
  }
  const running = runningUpdate(paths);
  if (running) return { value: { state: 'refused', code: 'update_running', message: `An update (pid ${running}) is running.` }, exitCode: 1 };
  const latest = readCheckState(paths).latest;
  if (flags.tag !== undefined && flags.tag !== latest.tag) {
    return refusal(paths, new UpdateRefused('release_changed', `The latest release is now ${latest.tag}, not ${flags.tag}.`,
      'Open the popup again to see it.'), current, latest.version);
  }
  const log = updateLogger(paths);
  let release;
  try {
    release = await takeUpdateLock(paths);
  } catch (error) {
    return { value: { state: 'refused', code: error.code, message: error.message }, exitCode: 1 };
  }
  try {
    if (!latest.commit) {
      throw new UpdateRefused('release_unverified', `Could not confirm which commit ${latest.tag} names.`,
        'Try again in a while (node src/cli.js update).');
    }
    const requests = options.requests ?? await liveRequests({ home, env });
    writeInstallState(paths, { pid: process.pid, state: 'running', from: current, to: latest.version, step: 'check',
      message: `Installing ${latest.version}.` });
    await log('update_start', { from: current, to: latest.version });
    const result = await installUpdate({ root, target: latest, currentVersion: current, requests, log, paths,
      ...(options.git ? { git: options.git } : {}), ...(options.steps ? { steps: options.steps } : {}),
      ...(options.remoteOk ? { remoteOk: options.remoteOk } : {}) });
    writeInstallState(paths, { state: 'succeeded', from: current, to: latest.version, step: 'done',
      message: `Updated to ${latest.version}. Restart your coding agent to load the new MCP server and skill.` });
    return { value: { ...result, next: 'Restart your coding agent so it loads the new MCP server and skill. '
      + 'A Chromium-family browser reloads the extension by itself; Firefox updates the signed add-on by itself.',
      log: updatePaths(paths).log }, exitCode: 0 };
  } catch (error) {
    if (error instanceof UpdateRefused) {
      await log('update_refused', { code: error.code });
      return refusal(paths, error, current, latest.version);
    }
    const failed = error instanceof UpdateFailed ? error : new UpdateFailed('internal', String(error?.message ?? error));
    const state = failed.rolledBack ? 'rolled_back' : 'failed';
    const message = failed.rolledBack
      ? `${failed.message}. Rolled back to ${current}.`
      : `${failed.message}. Rollback failed: ${failed.rollbackError ?? 'unknown'}; see ${updatePaths(paths).log}.`;
    writeInstallState(paths, { state, from: current, to: latest.version, step: failed.step, error: 'update_failed', message });
    await log('update_failed', { state, step: failed.step });
    return { value: { state, code: 'update_failed', step: failed.step, message, log: updatePaths(paths).log }, exitCode: 1 };
  } finally {
    await release();
  }
}
