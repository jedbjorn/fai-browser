#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { headlessEnv } from '../../scripts/headless-env.mjs';

const OUT = join(import.meta.dirname, 'pages');
const PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#e5e7eb"/><path d="M0 150l80-70 60 50 45-40 135 90H0z" fill="#9ca3af"/><circle cx="245" cy="48" r="24" fill="#9ca3af"/></svg>',
)}`;
const BLOCKERS = [
  { reason: 'captcha or bot wall', pattern: /\b(captcha|robot check|verify you are human|are you a robot|unusual traffic|automated access|bot detection)\b/i },
  { reason: 'regional gate', pattern: /\bselect your country\b/i },
  { reason: 'login wall', pattern: /\b(sign in to continue|log in to continue|login to continue|create an account to continue)\b/i },
  { reason: 'consent wall', pattern: /\b(accept all cookies|accept cookies|cookie consent|consent to continue|before you continue to)\b/i },
];

async function loadPage(page, definition, url) {
  const styles = new Map();
  const pending = new Set();
  const listener = response => {
    if (response.request().resourceType() !== 'stylesheet' || !response.ok()) return;
    const promise = response.text().then(text => styles.set(response.url(), text)).catch(() => {});
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  };
  page.on('response', listener);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (response && !response.ok()) throw new Error(`HTTP ${response.status()}`);
    await page.waitForTimeout(2000);
    if (definition.followFirst) {
      const href = await page.locator(definition.followFirst).first().getAttribute('href', { timeout: 10_000 });
      if (!href) throw new Error('No article link found');
      await page.goto(new URL(href, page.url()).href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForTimeout(2000);
    }
    await Promise.allSettled([...pending]);
    const inspection = await page.evaluate(() => ({
      title: document.title,
      text: document.body?.innerText.slice(0, 250_000) ?? '',
      htmlChars: document.documentElement.outerHTML.length,
    }));
    const blocker = BLOCKERS.find(({ pattern }) => pattern.test(inspection.title) || pattern.test(inspection.text));
    if (blocker) throw new Error(blocker.reason);
    if (inspection.htmlChars < 1000 || inspection.text.trim().length < 100) throw new Error('Page has too little readable content');
    return { styles, title: inspection.title, status: response?.status() ?? null };
  } finally {
    page.off('response', listener);
  }
}

async function serialize(page, styles) {
  return page.evaluate(async ({ cssEntries, placeholder }) => {
    const cleanCss = css => css
      .replace(/@import\s+(?:url\()?[^;]+;?/gi, '')
      .replace(/url\([^)]*\)/gi, 'none');
    for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
      const css = cssEntries.find(([url]) => url === link.href)?.[1];
      if (css === undefined) link.remove();
      else {
        const style = document.createElement('style');
        style.textContent = cleanCss(css);
        link.replaceWith(style);
      }
    }
    for (const style of document.querySelectorAll('style')) style.textContent = cleanCss(style.textContent);
    document.querySelectorAll('script, noscript, iframe, frame, object, embed, portal, base').forEach(node => node.remove());
    document.querySelectorAll('link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"]').forEach(node => node.remove());
    for (const image of document.images) {
      const rect = image.getBoundingClientRect();
      const width = Math.round(rect.width || image.naturalWidth || Number(image.getAttribute('width')) || 0);
      const height = Math.round(rect.height || image.naturalHeight || Number(image.getAttribute('height')) || 0);
      image.removeAttribute('srcset');
      image.removeAttribute('sizes');
      image.removeAttribute('loading');
      image.src = placeholder;
      if (width > 0) image.width = width;
      if (height > 0) image.height = height;
    }
    document.querySelectorAll('source').forEach(node => {
      node.removeAttribute('src');
      node.removeAttribute('srcset');
    });
    for (const media of document.querySelectorAll('video, audio')) {
      media.removeAttribute('src');
      media.removeAttribute('poster');
    }
    await Promise.resolve();
    return `<!doctype html>\n${document.documentElement.outerHTML}\n`;
  }, { cssEntries: [...styles], placeholder: PLACEHOLDER });
}

async function captureDefinition(browser, definition, force) {
  const directory = join(OUT, definition.id);
  if (!force) {
    try {
      await readFile(join(directory, 'index.html'), 'utf8');
      return { id: definition.id, status: 'existing' };
    } catch {}
  } else {
    await rm(directory, { recursive: true, force: true });
  }
  const urls = [definition.url, ...(definition.alternates ?? [])];
  const failures = [];
  for (const url of urls) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    try {
      const page = await context.newPage();
      const loaded = await loadPage(page, definition, url);
      const html = await serialize(page, loaded.styles);
      const meta = {
        id: definition.id,
        kind: definition.kind,
        url: page.url(),
        requestedUrl: url,
        capturedAt: new Date().toISOString(),
        userAgent: await page.evaluate(() => navigator.userAgent),
        title: loaded.title,
        status: loaded.status,
        htmlBytes: Buffer.byteLength(html),
      };
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'index.html'), html);
      await writeFile(join(directory, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
      return { id: definition.id, status: 'captured', url: meta.url, htmlBytes: meta.htmlBytes };
    } catch (error) {
      failures.push({ url, reason: error.message });
    } finally {
      await context.close();
    }
  }
  return { id: definition.id, status: 'skipped', failures };
}

export async function capture({ pageIds, force = false } = {}) {
  const definitions = JSON.parse(await readFile(join(import.meta.dirname, 'real-pages.json'), 'utf8'));
  const selected = pageIds ? definitions.filter(definition => pageIds.includes(definition.id)) : definitions;
  if (!selected.length || (pageIds && selected.length !== pageIds.length)) throw new Error('Unknown page id requested');
  let browser;
  const results = [];
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
      env: headlessEnv(), args: ['--no-sandbox', '--lang=en-US'],
    });
    for (const definition of selected) {
      process.stderr.write(`capturing ${definition.id}\n`);
      const result = await captureDefinition(browser, definition, force);
      results.push(result);
      process.stderr.write(`${result.id}: ${result.status}\n`);
    }
  } finally {
    if (browser) await browser.close();
  }
  return results;
}

async function cli() {
  const args = process.argv.slice(2);
  let pageIds;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pages') pageIds = args[++i].split(',').filter(Boolean);
    else if (args[i] === '--force') force = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  const results = await capture({ pageIds, force });
  process.stdout.write(JSON.stringify({ captured: results.filter(result => ['captured', 'existing'].includes(result.status)).length,
    skipped: results.filter(result => result.status === 'skipped').length, results }, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await cli();
