#!/usr/bin/env node
// Builds the Firefox add-on from extension/: copies it (less FIREFOX_EXCLUDED_FILES) to dist/firefox/ (or --out <dir>) and writes a Firefox
// manifest. The Chromium extension (extension/ as is, loaded unpacked) is never changed; only this copy differs.
//   npm run build:firefox                      dist/firefox/
//   node scripts/build-firefox.mjs --out <dir> another directory (the Firefox smoke uses a temporary one)
//   node scripts/build-firefox.mjs --gecko-id fai-browser@local   the pre-0.3.0 dev ID (the native host accepts both)
//
// What the Firefox manifest changes (see docs/REFERENCE.md "Firefox"):
// - background: an event page (`scripts`) instead of a service worker: compat.js first (the Firefox fallbacks,
//   chrome.offscreen among them), then psl-data.js and frames.js (a service worker loads them with importScripts),
//   then background.js.
// - browser_specific_settings.gecko.id = fai-browser@jedbjorn.github.io (src/native.js GECKO_ID, the ID the add-on is
//   signed under on AMO; the native host manifest's allowed_extensions also keep the old dev ID fai-browser@local) and
//   strict_min_version FIREFOX_MIN_VERSION, and update_url (src/launcher/release.js UPDATE_URL: the updates.json of the
//   latest GitHub release) so a self-distributed signed add-on updates itself; dev-ID builds get no update_url.
// - action.default_area = navbar: the FAI Browser button sits on the toolbar from the first start instead of the
//   extensions menu, because approving a request is a click on it.
// - no `key`, `minimum_chrome_version` or `offscreen` permission (Chrome only).
// - content_security_policy.extension_pages without Firefox's MV3 default `upgrade-insecure-requests`, which turns the
//   worker's ws://127.0.0.1 WebSocket into wss:// (refused: the service speaks plain HTTP on loopback only) and leaves
//   only the HTTP long-poll. Chrome's default policy has no such directive; script-src stays 'self'.
// - no host_permissions: Firefox match patterns do not take ports (a pattern with a port
//   matches no URL), so http://127.0.0.1:4318/* would grant nothing, and the portless http://127.0.0.1/* would let the
//   add-on into every local page. Neither is needed: the WebSocket needs no host permission and the service answers the
//   HTTP long-poll with CORS for the extension's own origin.
// - optional_host_permissions also list http://*/*: Firefox ends activeTab at the tab's first navigation, so the
//   approval click asks for the request's exact origins (compat.js); a plain-http test site must be askable too.
//   <all_urls> is listed only so the user can opt in (about:addons, FAI Browser, Permissions, "Access your data for all
//   websites"): Firefox's captureVisibleTab needs activeTab or <all_urls>, so without it there is no screenshot after
//   the leased tab's first navigation. The add-on never asks for it.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { GECKO_ID } from '../src/native.js';
import { UPDATE_URL } from '../src/launcher/release.js';

export { GECKO_ID };
// 140, the oldest supported ESR: everything the add-on uses is there (scripting.executeScript `func`/`args`,
// storage.session, action.getUserSettings, optional_host_permissions, tabGroups from 139, data_collection_permissions
// from 140), so `web-ext lint` reports no API the minimum version lacks except chrome.offscreen, which compat.js
// provides. Tested in Firefox 159 (npm run smoke:firefox).
export const FIREFOX_MIN_VERSION = '140.0';
// Chrome-only permissions dropped from the Firefox manifest (compat.js covers what they did).
const CHROME_ONLY_PERMISSIONS = new Set(['offscreen']);
export const FIREFOX_EXTENSION_PAGES_CSP = "script-src 'self'; object-src 'none'";
export const FIREFOX_OPTIONAL_HOSTS = ['https://*/*', 'http://*/*', '<all_urls>'];
export const FIREFOX_BACKGROUND_SCRIPTS = ['compat.js', 'psl-data.js', 'frames.js', 'background.js'];
// Chromium-only files left out of the Firefox build: trusted-input.js needs chrome.debugger, which Firefox lacks
// (background.js loads it only with importScripts, absent in the Firefox event page). input.js is shared.
export const FIREFOX_EXCLUDED_FILES = ['trusted-input.js'];

/**
 * The Firefox manifest for the Chromium manifest `chrome` (a parsed extension/manifest.json); a new object. `geckoId`
 * overrides the add-on ID (default GECKO_ID).
 */
export function firefoxManifest(chrome, { geckoId = GECKO_ID, updateUrl = geckoId === GECKO_ID ? UPDATE_URL : null } = {}) {
  const manifest = structuredClone(chrome);
  if (manifest.action) manifest.action = { ...manifest.action, default_area: 'navbar' };
  delete manifest.key;
  delete manifest.minimum_chrome_version;
  manifest.background = { scripts: [...FIREFOX_BACKGROUND_SCRIPTS] };
  manifest.content_security_policy = { ...manifest.content_security_policy, extension_pages: FIREFOX_EXTENSION_PAGES_CSP };
  delete manifest.host_permissions;
  manifest.optional_host_permissions = [...new Set([...(manifest.optional_host_permissions ?? []), ...FIREFOX_OPTIONAL_HOSTS])];
  manifest.permissions = (manifest.permissions ?? []).filter(permission => !CHROME_ONLY_PERMISSIONS.has(permission));
  manifest.browser_specific_settings = {
    gecko: {
      id: geckoId,
      strict_min_version: FIREFOX_MIN_VERSION,
      // Nothing is sent to the developer: page data goes only to the FAI service on this computer.
      data_collection_permissions: { required: ['none'] },
      ...(updateUrl ? { update_url: updateUrl } : {}),
    },
  };
  return manifest;
}

/** Copies extension/ to `out` (emptied first) and writes the Firefox manifest there. Resolves `out`. */
export async function buildFirefox({ root = resolve(import.meta.dirname, '..'), out, geckoId = GECKO_ID } = {}) {
  const target = resolve(out ?? join(root, 'dist', 'firefox'));
  const source = join(root, 'extension');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const excluded = new Set(FIREFOX_EXCLUDED_FILES.map(name => join(source, name)));
  await cp(source, target, { recursive: true, filter: path => !excluded.has(path) });
  const chrome = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(firefoxManifest(chrome, { geckoId }), null, 2)}\n`);
  return target;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'gecko-id': { type: 'string' } } });
  const out = await buildFirefox({ out: values.out, geckoId: values['gecko-id'] });
  console.log(`Firefox add-on built in ${out}`);
  console.log('Load it: open about:debugging#/runtime/this-firefox, click Load Temporary Add-on and pick its manifest.json.');
}
