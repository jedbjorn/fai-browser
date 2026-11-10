// The shipped task sub-skills: a STATIC import list. A task is a directory tasks/<name>/ with SKILL.md (the host
// guide the main skill points at; installed with it) and an optional index.js that exports `name` and `vocabulary`
// (task nouns the core reads: `askNouns`). Task code is never loaded from FAI_HOME or any user path: this file is the
// only place the core takes it from.
import * as flights from './flights/index.js';
import * as hotels from './hotels/index.js';

/** Every shipped task module, in a fixed order. */
export const TASKS = Object.freeze([flights, hotels]);

/** The nouns a two-part question may ask for, from every task (regex sources, distinct, in task order). */
export const TASK_ASK_NOUNS = Object.freeze([...new Set(TASKS.flatMap(task => task.vocabulary?.askNouns ?? []))]);
