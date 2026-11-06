# Publishing a Firefox release

FAI Browser distributes a Mozilla-signed, unlisted Firefox add-on through GitHub Releases. Chromium users load
`extension/` unpacked. The npm package remains private; this process does not publish it to npm.

The permanent Firefox add-on ID is `fai-browser@jedbjorn.github.io`. Installed copies use the latest release's
`updates.json` at `https://github.com/jedbjorn/fai-browser/releases/latest/download/updates.json`.

## Prepare

1. Update `package.json`, `package-lock.json` and `extension/manifest.json` to the same new version, and update
   `CHANGELOG.md`. AMO signs each version once.
2. Run `npm ci` and `npm test` with Chromium installed (see [CONTRIBUTING](../CONTRIBUTING.md)). Test files run one at a
   time so browser performance checks do not compete with other test browsers. On a shared machine, use the memory
   limits in the contributor guide and avoid concurrent browser or benchmark jobs.
3. Run `npm run test:browserless`, `npm run lint:firefox`, `npm run package` and `npm run sign:firefox -- --dry-run`.
   Review the offline publication scan (`node scripts/secret-scan.mjs`): it reports locations and rule names, never
   matched values. Test placeholders, public hashes and contact addresses need review rather than blind removal.
4. Commit the reviewed source and confirm the tree is clean. Never sign from a dirty tree or commit `dist/`.

## Sign and publish

Configure repository Actions secrets `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` with the credentials belonging to the
Firefox account that owns the add-on. The [Release workflow](../.github/workflows/release.yml) exposes them only to
the AMO signing step. Never paste credentials into an issue, commit or command argument.

Tag the clean release commit as `vX.Y.Z` and push the tag. The workflow verifies both versions, runs browserless tests
and Firefox lint, builds a reproducible ZIP, signs through AMO, then publishes the signed XPI, unsigned ZIP,
`updates.json` and `SHA256SUMS`. A draft or prerelease is not offered as the latest automatic update.

For local signing, store the same two variables in the environment or `amo.env` in the FAI settings directory with
mode `0600`; `npm run sign:firefox -- --yes` reads them without printing their values. Follow with
`node scripts/update-manifest.mjs`, check `SHA256SUMS` from `dist/`, and upload the four files to the matching tag's
GitHub Release. Use the same committed source for the release and signed package.

After publishing, verify the release assets and checksums, then run `node src/cli.js launch --print` to check its XPI
URL. `npm run smoke:launcher -- --xpi dist/fai-browser-firefox-X.Y.Z.xpi` exercises the signed install in a disposable
profile. The [Pages workflow](../.github/workflows/pages.yml) deploys `site/` from `main`; it requires GitHub Pages to
use GitHub Actions as its build source.
