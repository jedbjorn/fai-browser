#!/usr/bin/env node
// A separate, unscored public search-page probe. It never uses a personal browser or submits a form.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { headlessEnv } from '../../scripts/headless-env.mjs';

const searches = [
  { site: 'Amazon', url: 'https://www.amazon.com/s?k=MacBook+Air+M5&rh=p_n_condition-type%3A2224371011' },
  { site: 'eBay', url: 'https://www.ebay.com/sch/i.html?_nkw=MacBook+Air+M5&LH_ItemCondition=1000&_sop=15' },
];
const blockers = [
  ['bot_wall', /captcha|robot check|verify (?:that )?you are human|are you a robot|unusual traffic|automated access|pardon our interruption|pardon the interruption|security measure/i],
  ['consent_wall', /before you continue|consent to continue|accept all cookies/i],
  ['login_wall', /sign in to continue|log in to continue/i],
];
const out = resolve(process.argv[2] ?? 'bench/showcase/results-live-search-2026-11-06.json');
const rows = [];
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    env: headlessEnv(), args: ['--no-sandbox', '--lang=en-US'] });
  for (const search of searches) {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    const denied = [];
    try {
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const commerce = /\/(?:gp\/(?:cart|buy)|cart|checkout|signin|ap\/(?:signin|register)|bid|bids|purchase)(?:\/|\?|$)/i.test(url.pathname);
        const navigationAway = request.isNavigationRequest() && !/(?:^|\.)(?:amazon|ebay)\.com$/.test(url.hostname);
        if (!['GET', 'HEAD'].includes(request.method()) || commerce || navigationAway) {
          denied.push({ method: request.method(), host: url.hostname, path: url.pathname });
          await route.abort();
        } else await route.continue();
      });
      const page = await context.newPage();
      const response = await page.goto(search.url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      await page.waitForTimeout(1500);
      const text = await page.locator('body').innerText({ timeout: 5000 });
      const title = await page.title();
      const blocker = blockers.find(([, pattern]) => pattern.test(title) || pattern.test(text));
      const candidates = blocker ? [] : await page.locator('a[href]').evaluateAll(links => links
        .filter(link => /MacBook\s+Air/i.test(link.innerText) && /M5/i.test(link.innerText))
        .slice(0, 8).map(link => ({ title: link.innerText.trim().slice(0, 240), url: link.href,
          surroundingText: (link.closest('li, [data-component-type="s-search-result"]')?.innerText ?? '').slice(0, 650) })));
      rows.push({ site: search.site, searchedAt: new Date().toISOString(), requestedUrl: search.url, finalUrl: page.url(),
        httpStatus: response?.status() ?? null, title, outcome: blocker?.[0] ?? (response?.ok() ? 'search_page_observed_ungraded' : 'http_error'),
        readableChars: text.length, evidenceExcerpt: blocker ? text.slice(0, 1200) : undefined,
        listingCandidates: candidates, deniedRequests: denied });
    } catch (error) {
      rows.push({ site: search.site, searchedAt: new Date().toISOString(), requestedUrl: search.url,
        outcome: 'navigation_error', reason: error.message.split('\n')[0], deniedRequests: denied });
    } finally { await context.close(); }
  }
} finally { await browser?.close(); }
await mkdir(resolve(out, '..'), { recursive: true });
await writeFile(out, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(),
  task: 'price-compare-live: new MacBook Air M5, Amazon vs eBay',
  protocol: 'Isolated logged-out Chromium; direct public search URLs only; no forms, login, cart, bid, checkout or purchase. Non-GET/HEAD requests and commerce navigation blocked.',
  scoring: 'Unscored public-site availability probe, separate from local A/B agent benchmark. Listing candidates require manual verification of new condition, model, price, delivery and availability; no best-deal claim.',
  results: rows }, null, 2) + '\n');
console.log(JSON.stringify({ out, results: rows.map(({ site, outcome, httpStatus, listingCandidates }) => ({ site, outcome, httpStatus, candidates: listingCandidates?.length })) }));
