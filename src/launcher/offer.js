// The last step of `npm run setup`: offer the FAI Browser profile for Firefox when an official Firefox is installed,
// else name the launcher command (which can download Firefox from Mozilla).
import { homedir } from 'node:os';
import { launcherPaths } from './dirs.js';
import { findFirefox } from './detect.js';

export const OFFER_QUESTION = 'Set up the FAI Browser profile for Firefox? [Y/n]: ';
export const LAUNCH_COMMAND = 'node src/cli.js launch';

/**
 * Resolves 'launched', 'declined', 'failed' or 'no-firefox'. `ask(question)` resolves a boolean (Enter = yes);
 * `find()` returns findFirefox's result; `start()` runs the launch.
 */
export async function offerFirefoxProfile({
  ask,
  log = console.log,
  find = () => findFirefox({ home: homedir(), privateDir: launcherPaths().firefox }),
  start = async () => {
    const { launch, defaultDeps } = await import('./launch.js');
    return launch({}, defaultDeps());
  },
} = {}) {
  let found;
  try {
    found = find();
  } catch {
    found = { chosen: null, sandboxed: [] };
  }
  if (!found.chosen) {
    if (found.sandboxed?.length) {
      log(`Firefox here is a ${found.sandboxed[0].kind === 'snap' ? 'Snap' : 'Flatpak'} build, which cannot start the pairing helper.`);
    }
    log(`Get official Firefox with a separate FAI profile and the signed add-on: ${LAUNCH_COMMAND}`);
    return 'no-firefox';
  }
  if (!await ask(OFFER_QUESTION)) {
    log(`Later: ${LAUNCH_COMMAND} (${LAUNCH_COMMAND} --print shows what it does).`);
    return 'declined';
  }
  try {
    await start();
    return 'launched';
  } catch (error) {
    log(`Could not set up the FAI Browser profile: ${error.message}`);
    if (error.hint) log(`  ${error.hint}`);
    return 'failed';
  }
}
