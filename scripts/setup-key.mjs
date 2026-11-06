#!/usr/bin/env node
// Replace only the Jev key in .env.local. The settings helpers live in src/settings.js; they are re-exported here
// for older callers.
import { resolve } from 'node:path';
import { envFilePath } from '../src/paths.js';
import { promptKey, saveKey, saveSettings } from '../src/settings.js';

export { promptKey, saveKey, saveSettings };

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  process.umask(0o077);
  try {
    if (process.argv.length > 2) {
      throw new Error('This script accepts no arguments; enter the key only at the hidden prompt');
    }
    await saveKey(await promptKey());
    console.log(`Saved TypeSafe key to ${envFilePath()} with permissions 0600. The daemon reloads it automatically.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
