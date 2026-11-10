// Hotel finding: the hotels task sub-skill's code (the host guide is SKILL.md beside this file). Only the task's
// vocabulary: the nouns a hotel question asks for, read by the core through tasks/index.js.

/** The task's name, as tasks/index.js lists it. */
export const name = 'hotels';

/**
 * The task's vocabulary the core reads through tasks/index.js. `askNouns`: nouns a question asks for in a two-part
 * question ("the hotel and its price", "the price per night and total"; src/digest.js isMultiPart), as regex sources.
 * Name, price and rating are core nouns already.
 */
export const vocabulary = Object.freeze({
  askNouns: Object.freeze(['hotels?', 'propert(?:y|ies)', 'nights?', 'totals?']),
});
