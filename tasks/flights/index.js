// Flight finding: the flights task sub-skill's code (the host guide is SKILL.md beside this file). Only the task's
// vocabulary: the nouns a flight question asks for, read by the core through tasks/index.js.

/** The task's name, as tasks/index.js lists it. */
export const name = 'flights';

/**
 * The task's vocabulary the core reads through tasks/index.js. `askNouns`: nouns a question asks for in a two-part
 * question ("its departure time, airline and price"; src/digest.js isMultiPart), as regex sources.
 */
export const vocabulary = Object.freeze({
  askNouns: Object.freeze(['airlines?', 'carriers?', 'fares?']),
});
