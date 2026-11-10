// Machinery pass, item 3: consent labels in German, French, Spanish, Italian, Portuguese and Dutch. The accept,
// reject, settings and "without accepting" sets in extension/page.js are identical to the runtime constants (drift
// check); page.js classifies each language's buttons, so the one reject button is the mechanical step and accept
// buttons stay refused. CHROMIUM_PATH overrides the browser binary.
import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { CONSENT_ACCEPT, CONSENT_REJECT, CONSENT_SETTINGS, CONSENT_WITHOUT_ACCEPT } from '../src/oversight.js';

const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;
const PAGE_SOURCE = await readFile(PAGE_SCRIPT, 'utf8');

test('page.js consent label sets match the runtime constants (drift check)', () => {
  for (const [name, value] of Object.entries({ CONSENT_REJECT, CONSENT_ACCEPT, CONSENT_SETTINGS, CONSENT_WITHOUT_ACCEPT })) {
    const match = PAGE_SOURCE.match(new RegExp(`const ${name} = (\\/.+\\/[a-z]*);`));
    assert.ok(match, `extension/page.js defines ${name}`);
    assert.equal(match[1], String(value), name);
  }
});

const LANGUAGES = {
  de: { reject: ['Alle ablehnen', 'Nur notwendige Cookies', 'Ablehnen'], accept: ['Alle akzeptieren', 'Zustimmen', 'Allen zustimmen'], settings: ['Einstellungen', 'Cookies verwalten'] },
  fr: { reject: ['Tout refuser', 'Refuser', 'Continuer sans accepter'], accept: ['Accepter', 'Tout accepter'], settings: ['Paramètres', 'Personnaliser'] },
  es: { reject: ['Rechazar', 'Rechazar todo', 'Solo necesarias'], accept: ['Aceptar', 'Aceptar todo'], settings: ['Configuración', 'Preferencias'] },
  it: { reject: ['Rifiuta', 'Rifiuta tutti'], accept: ['Accetta', 'Accetta tutti'], settings: ['Impostazioni', 'Personalizza'] },
  pt: { reject: ['Rejeitar', 'Rejeitar todos'], accept: ['Aceitar', 'Aceitar todos'], settings: ['Definições', 'Personalizar'] },
  nl: { reject: ['Weigeren', 'Alleen noodzakelijk'], accept: ['Accepteren', 'Alles accepteren'], settings: ['Instellingen', 'Aanpassen'] },
};

let browser;
test.before(async () => {
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(), args: ['--no-sandbox'],
    });
  } catch {
    browser = null;
  }
});
test.after(() => browser?.close());

const BANNER_TEXT = {
  de: 'Wir verwenden Cookies, um unsere Website zu verbessern.',
  fr: 'Nous utilisons des cookies pour améliorer notre site.',
  es: 'Utilizamos cookies para mejorar nuestro sitio.',
  it: 'Utilizziamo i cookie per migliorare il sito.',
  pt: 'Utilizamos cookies para melhorar o nosso site.',
  nl: 'Wij gebruiken cookies om onze website te verbeteren.',
};

for (const [language, sets] of Object.entries(LANGUAGES)) {
  test(`page.js classifies a ${language} cookie dialog: reject offered, accept refused, settings marked`, async t => {
    if (!browser) return t.skip('no Chromium');
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    t.after(() => page.close());
    const buttons = [sets.settings[0], sets.reject[0], sets.accept[0]]
      .map(label => `<button type="button">${label}</button>`).join('');
    const html = `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><title>Start</title></head><body>`
      + '<main><h1>Start</h1><p>Inhalt</p></main>'
      + `<div id="cookie-banner" role="dialog" style="position:fixed;bottom:0;left:0;right:0;background:#fff">`
      + `<p>${BANNER_TEXT[language]}</p>${buttons}</div></body></html>`;
    await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('https://example.com/');
    await page.addScriptTag({ path: PAGE_SCRIPT });
    const observation = await page.evaluate(() => __faiPage.observe());
    assert.ok(observation.consent, 'the dialog is detected');
    const kinds = Object.fromEntries(observation.consent.buttons.map(button => [button.label, button.kind]));
    assert.equal(kinds[sets.reject[0]], 'reject');
    assert.equal(kinds[sets.accept[0]], 'accept');
    assert.equal(kinds[sets.settings[0]], 'settings');
    const accept = observation.controls.find(control => control.label === sets.accept[0]);
    assert.equal(accept.risk, 'consent_accept', 'accept is its own class, refused below full by the page script');
  });
}

test('page.js treats "Continuer sans accepter" as the reject next to "Tout accepter"', async t => {
  if (!browser) return t.skip('no Chromium');
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  t.after(() => page.close());
  const html = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Accueil</title></head><body>'
    + '<div class="cmp-banner" style="position:fixed;top:0;left:0;right:0;background:#fff">'
    + '<p>Ce site utilise des cookies.</p><a href="#" role="button">Continuer sans accepter</a>'
    + '<button type="button">Tout accepter</button></div></body></html>';
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://example.com/');
  await page.addScriptTag({ path: PAGE_SCRIPT });
  const observation = await page.evaluate(() => __faiPage.observe());
  const kinds = Object.fromEntries(observation.consent.buttons.map(button => [button.label, button.kind]));
  assert.deepEqual(kinds, { 'Continuer sans accepter': 'reject', 'Tout accepter': 'accept' });
});
