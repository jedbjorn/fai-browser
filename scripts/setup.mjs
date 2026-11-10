#!/usr/bin/env node
// One-time local setup. Saves the pairing secret to .env.local in the settings directory (src/paths.js: FAI_HOME,
// else ~/.config/fai-browser, ~/Library/Application Support/fai-browser on macOS), installs the native messaging host
// for every detected browser so the extension pairs by itself, starts the FAI service, and offers to register FAI
// Browser with each coding agent found on PATH. Settings from an older checkout-local install are moved first.
// Last, when an official Firefox is installed, it offers to set up the FAI Browser profile for it (src/launcher/
// launch.js: a separate profile with the signed add-on, paired); otherwise it prints the launcher command.
// Your coding agent drives the browser; no key is needed.
//   npm run setup                                  everything above; asks before registering each coding agent
//   npm run setup -- --yes                          register every detected coding agent without asking
//   npm run setup -- --no-register                  skip coding-agent registration
//   npm run setup -- --no-firefox                   skip the offer to set up the FAI Browser profile for Firefox
//   npm run setup -- --extension-id <32 a-p chars> override the pinned ID (only for a re-keyed manifest)
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { PINNED_EXTENSION_ID } from '../src/bridge.js';
import { FaiBrowserClient } from '../src/client.js';
import { PACKAGE_ROOT } from '../src/paths.js';
import { homePaths, loadConfig } from '../src/home.js';
import { readEnvFile, saveSettings } from '../src/settings.js';
import { migrateLegacyHome } from '../src/migrate.js';
import { applyNativeInstall, planNativeInstall } from '../src/native.js';
import { InstallError, detectHosts, registerHost } from '../src/install.js';
import { offerFirefoxProfile } from '../src/launcher/offer.js';

async function ask(question, { yes = false } = {}) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(question)).trim();
    return answer ? /^y(?:es)?$/i.test(answer) : yes;
  } finally {
    prompt.close();
  }
}

// Reload a running FAI service, or start one. Setup still succeeds if this fails; the next client call retries.
async function refreshService(paths) {
  try {
    const client = await FaiBrowserClient.connect({ home: paths.home, autoStart: false, clientName: 'setup' });
    await client.reload();
    return { ok: true, text: 'FAI service running (reloaded the settings).' };
  } catch {
    // Not running (or not reachable): start it below.
  }
  try {
    const client = await FaiBrowserClient.connect({ home: paths.home, autoStart: true, clientName: 'setup' });
    const health = await client.health();
    return { ok: true, text: `FAI service started (pid ${health.pid}).` };
  } catch (error) {
    return { ok: false, text: `Could not start the FAI service (${error.message}). The extension starts it when it pairs.` };
  }
}

function nativeHost() {
  const plan = planNativeInstall();
  if (!plan.browsers.length) return { plan, written: null };
  return applyNativeInstall(plan).then(written => ({ plan, written }));
}

async function main() {
  const { values: flags, positionals } = parseArgs({
    options: {
      'extension-id': { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      'no-register': { type: 'boolean' },
      'no-firefox': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: true,
  });
  if (positionals.length) {
    throw new Error('Setup takes no positional arguments');
  }
  const extensionId = flags['extension-id'] ?? PINNED_EXTENSION_ID;
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new Error('--extension-id must be the 32 character extension ID');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run setup in an interactive terminal');
  }

  const paths = homePaths();
  const migrated = await migrateLegacyHome(paths);
  if (migrated.moved.length) console.log(`Moved ${migrated.moved.join(' and ')} from the checkout to ${paths.home}.`);
  if (migrated.left.length) console.log(`Left in place (delete when no longer needed): ${migrated.left.join(', ')}`);

  // Refuse to go on over a malformed config.json (the daemon would not start with it).
  loadConfig(paths);
  const saved = readEnvFile(paths.envFile);
  if (saved.FAI_EXTENSION_ID && saved.FAI_EXTENSION_ID !== extensionId) {
    console.log(`Replacing saved extension ID ${saved.FAI_EXTENSION_ID} with ${extensionId}.`);
  }
  const secret = saved.FAI_BRIDGE_SECRET || randomBytes(32).toString('hex');
  const values = { FAI_EXTENSION_ID: extensionId, FAI_BRIDGE_SECRET: secret };
  await saveSettings(values, paths.envFile);
  console.log(`Settings saved in ${paths.home} (mode 0600).`);

  let native;
  try {
    native = await nativeHost();
  } catch (error) {
    native = { plan: null, written: null, error };
  }
  if (native.written) {
    console.log(`Browser pairing installed for ${native.written.browsers.map(browser => browser.name).join(', ')}.`);
  } else {
    console.log(native.error
      ? `Could not install browser pairing (${native.error.message}).`
      : 'No supported browser found for automatic pairing (Chrome, Chromium, Brave, Edge, Vivaldi, Firefox).');
    console.log('  Install it for one by name: node src/cli.js install-native --browser chrome');
    console.log('  Or pair by hand: node src/cli.js pair prints the secret for the extension\'s Advanced section.');
  }
  console.log((await refreshService(paths)).text);

  const agents = [];
  if (!flags['no-register']) {
    for (const found of detectHosts()) {
      const yes = flags.yes || await ask(`Register FAI Browser with ${found.name}? [Y/n]: `, { yes: true });
      if (!yes) continue;
      try {
        await registerHost(found.host, { claudePath: found.path });
        agents.push(found.name);
        console.log(`  Registered with ${found.name}.`);
      } catch (error) {
        console.log(`  Could not register with ${found.name}: ${error.message}`);
        if (error instanceof InstallError && error.snippet) console.log(error.snippet);
      }
    }
  }

  let launched = false;
  if (!flags['no-firefox']) {
    console.log('');
    launched = await offerFirefoxProfile({ ask: question => ask(question, { yes: true }) }) === 'launched';
  }
  const firefox = !launched && native.written?.browsers?.some(browser => browser.id === 'firefox');
  const steps = [
    ...(launched ? ['FAI Browser (Firefox with the FAI profile) is open; start it again any time with node src/cli.js launch or from your applications menu.'] : []),
    `${launched ? 'Chromium-family browsers (optional): ' : ''}Load the extension: open chrome://extensions (or brave://, edge://), turn on Developer mode, click Load unpacked and pick ${join(PACKAGE_ROOT, 'extension')}`,
    ...(firefox ? [`Firefox instead: run npm run build:firefox, open about:debugging#/runtime/this-firefox, click Load Temporary Add-on and pick ${join(PACKAGE_ROOT, 'dist', 'firefox', 'manifest.json')} (gone at the next Firefox restart; README "Browsers" has the permanent options)`] : []),
    'Pin FAI Browser: puzzle-piece menu, then the pin. You approve every agent request by clicking it.',
    agents.length ? `Restart ${agents.join(', ')} so it loads FAI Browser.`
      : 'Connect your coding agent: node src/cli.js install --host claude|codex|opencode, then restart it.',
  ];
  console.log('\nNext:');
  steps.forEach((step, index) => console.log(`  ${index + 1}. ${step}`));
  if (native.written) console.log('The extension pairs by itself: nothing to copy or paste.');
}

process.umask(0o077);
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
