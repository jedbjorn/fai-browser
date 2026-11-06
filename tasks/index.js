// The shipped task sub-skills: a STATIC import list. A task is a directory tasks/<name>/ with SKILL.md (the host
// guide the main skill points at; installed with it) and an optional index.js of reviewed engine code that exports
// `name`, `shortcutKinds` (URL transforms a site profile may name by kind; src/shortcuts.js documents the interface
// and registers them) and `vocabulary` (task nouns the core reads: `askNouns`). Task code is never loaded from
// FAI_HOME, a profile directory or any user path: a shortcut kind navigates the tab, so every kind is reviewed code
// that ships with the package, and this file is the only place the core takes it from.
import * as flights from './flights/index.js';
import * as hotels from './hotels/index.js';

/** Every shipped task module, in a fixed order. */
export const TASKS = Object.freeze([flights, hotels]);

function merged(key, pick) {
  const out = {};
  for (const task of TASKS) {
    for (const [id, value] of Object.entries(pick(task) ?? {})) {
      if (Object.hasOwn(out, id)) throw new Error(`tasks: ${key} "${id}" is defined by two tasks`);
      out[id] = value;
    }
  }
  return Object.freeze(out);
}

/** Every shortcut kind the shipped tasks define, by id (each id belongs to exactly one task). */
export const TASK_SHORTCUT_KINDS = merged('shortcut kind', task => task.shortcutKinds);

/** The nouns a two-part question may ask for, from every task (regex sources, distinct, in task order). */
export const TASK_ASK_NOUNS = Object.freeze([...new Set(TASKS.flatMap(task => task.vocabulary?.askNouns ?? []))]);

/** The task that defines a shortcut kind, or null. */
export function taskOfKind(kind) {
  return TASKS.find(task => Object.hasOwn(task.shortcutKinds ?? {}, kind)) ?? null;
}
