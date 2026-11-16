// Browser Chat settings (spec #84 "Browser Chat settings", decision #30): FAI's own, kept by the daemon in FAI's
// settings directory (chat-settings.json), for FAI chats only. A model set here goes on a turn's command line; nothing
// here is ever written into a provider's own configuration.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PROVIDERS, argumentSafe } from './chat-providers.js';
import { renameRetrying } from './chat-store.js';

export const APPEARANCES = Object.freeze(['system', 'light', 'dark']);
export const MODEL_NAME_LIMIT = 200;

export class ChatSettingsError extends Error {
  constructor(message) {
    super(message);
    this.code = 'bad_request';
  }
}

/** No default provider (the first available one), each program's own model, the system's appearance. */
export function defaultChatSettings() {
  return { defaultProvider: null, models: Object.fromEntries(PROVIDERS.map(provider => [provider, null])), appearance: 'system' };
}

// A model name as the user typed or picked it: trimmed; empty means the program's own default.
function modelName(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ChatSettingsError('A model must be a name.');
  const name = value.trim();
  if (!name) return null;
  if (name.length > MODEL_NAME_LIMIT || !argumentSafe(name)) throw new ChatSettingsError('A model must be a plain name.');
  return name;
}

/** Validate a model name from the panel (chat_model too). Throws ChatSettingsError. */
export const checkModelName = modelName;

/**
 * `base` with the fields `patch` sets: defaultProvider (a provider or null), models ({provider: name or null}, any
 * subset), appearance. Throws ChatSettingsError on anything else.
 */
export function mergeChatSettings(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ChatSettingsError('settings must be an object.');
  const next = { ...base, models: { ...base.models } };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'defaultProvider') {
      if (value !== null && !PROVIDERS.includes(value)) throw new ChatSettingsError('Unknown provider.');
      next.defaultProvider = value;
    } else if (key === 'appearance') {
      if (!APPEARANCES.includes(value)) throw new ChatSettingsError('appearance is system, light or dark.');
      next.appearance = value;
    } else if (key === 'models') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChatSettingsError('models must be an object.');
      for (const [provider, model] of Object.entries(value)) {
        if (!PROVIDERS.includes(provider)) throw new ChatSettingsError('Unknown provider.');
        next.models[provider] = modelName(model);
      }
    } else {
      throw new ChatSettingsError(`Unknown setting ${key}.`);
    }
  }
  return next;
}

/** `file`: chat-settings.json in FAI's settings directory. */
export function createChatSettings({ file }) {
  let current = null;
  let writes = Promise.resolve();

  async function get() {
    if (current) return current;
    let saved = {};
    try {
      saved = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      // Missing or not FAI's JSON: the defaults.
    }
    // Field by field, so one bad value written by hand does not lose the rest.
    let settings = defaultChatSettings();
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [key, value] of Object.entries(saved)) {
        try {
          settings = mergeChatSettings(settings, { [key]: value });
        } catch {
          // Skipped.
        }
      }
    }
    current ??= settings;
    return current;
  }

  /** Apply `patch` (mergeChatSettings) and save it. Resolves the settings. Saves run one after another. */
  function set(patch) {
    const run = writes.then(async () => {
      const next = mergeChatSettings(await get(), patch);
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
      try {
        await renameRetrying(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      current = next;
      return next;
    });
    writes = run.catch(() => {});
    return run;
  }

  return { get, set };
}
