## What and why

<!-- One or two sentences. Link the issue. -->

## Type

- [ ] Fix
- [ ] Feature
- [ ] Docs
- [ ] Guardrail / Approve gate / secret redaction / pairing (needs the safety section below)
- [ ] Site profile or task sub-skill
- [ ] Refactor / tooling

## Checklist

- [ ] Tests added or updated; I ran the affected test files (memory-capped, see CONTRIBUTING.md)
- [ ] `npm test` is green, or the failures are explained below
- [ ] Docs updated: `docs/REFERENCE.md`, `docs/guide/`, `CHANGELOG.md`, `src/index.d.ts` as needed
- [ ] If I touched a byte-copied block (`<secret-rules>`, `<site-match>`, guardrail patterns, level table), I synced the copies and the drift tests pass
- [ ] No secrets, tokens, pairing secrets, personal paths or real-site page captures in the diff (`node scripts/secret-scan.mjs`)
- [ ] New fixtures are fake (no real accounts, names, cards or keys)

## Safety impact

<!-- Delete if not relevant. Does the agent gain any capability (action class, looser pattern, new level, new data in results)?
     Which test shows the new boundary? What does the user see on the approval card? -->

## How I tested

<!-- Commands, browser and version, fixture pages. -->
