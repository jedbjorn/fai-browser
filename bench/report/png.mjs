// Renders index.html to PNG with headless Chromium through playwright-core: a full page at 1600 px wide and a
// 1080x1350 social crop (header, headline cards and the grouped bars). Returns null when no browser is available.
import { existsSync } from 'node:fs';
import { headlessEnv } from '../../scripts/headless-env.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadChromium() {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    return null;
  }
  const candidates = [process.env.CHROMIUM_PATH, safe(() => chromium.executablePath()), '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  const executablePath = candidates.find(path => existsSync(path));
  return executablePath ? { chromium, executablePath } : null;
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

export async function renderPng(outDir, { htmlFile = 'index.html' } = {}) {
  const found = await loadChromium();
  if (!found) {
    return null;
  }
  const browser = await found.chromium.launch({ executablePath: found.executablePath, headless: true, env: headlessEnv() });
  try {
    const url = pathToFileURL(join(outDir, htmlFile)).href;
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'light' });
    const page = await context.newPage();
    // Static page: block anything that is not the file itself, so a stray external URL cannot load.
    await page.route('**/*', route => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
    await page.goto(url, { waitUntil: 'load' });
    const full = join(outDir, 'report-1600.png');
    await page.screenshot({ path: full, fullPage: true });

    await page.setViewportSize({ width: 1080, height: 1350 });
    await page.evaluate(() => document.documentElement.classList.add('social'));
    const social = join(outDir, 'report-social-1080x1350.png');
    await page.screenshot({ path: social, clip: { x: 0, y: 0, width: 1080, height: 1350 } });
    await context.close();
    return { full, social };
  } finally {
    await browser.close();
  }
}
