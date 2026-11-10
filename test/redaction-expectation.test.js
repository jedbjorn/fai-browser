import test from 'node:test';
import assert from 'node:assert/strict';
import { redactorFor, SUPPLIED_REDACTION_MIN_LENGTH } from '../src/runtime.js';

test('redactor replaces exact and URL-encoded supplied values of 4+ characters only', () => {
  assert.equal(SUPPLIED_REDACTION_MIN_LENGTH, 4);
  const redact = redactorFor({ city: 'New York', pin: '123', name: 'Ada', note: 'abcd' });
  assert.equal(redact('Ship to New York'), 'Ship to [supplied:city]');
  assert.equal(redact('/search?q=New%20York'), '/search?q=[supplied:city]');
  assert.equal(redact('/search?q=New+York'), '/search?q=[supplied:city]');
  assert.equal(redact('abcdabcd'), '[supplied:note][supplied:note]');
  assert.equal(redact('new york'), 'new york', 'matching is exact and case-sensitive');
  assert.equal(redact('PIN 123 for Ada'), 'PIN 123 for Ada', 'short values are not redacted');
  assert.equal(redactorFor({})('unchanged'), 'unchanged');
});

test('textAbsent reads the whole document when textIncludes passed only past the viewport', async () => {
  const { checkDeclarative, expectationTexts } = await import('../src/expectation.js');
  const exp = { textIncludes: 'Confirmed', textAbsent: 'Error' };
  assert.deepEqual(expectationTexts(exp), ['confirmed', 'error']);
  const off = { url: 'https://e.com/', title: 'T', text: 'Footer' };
  assert.equal(checkDeclarative({ ...off, textFound: ['confirmed', 'error'] }, exp), false);
  assert.equal(checkDeclarative({ ...off, textFound: ['confirmed'], textCapped: true }, exp), false);
  assert.equal(checkDeclarative({ ...off, textFound: ['confirmed'] }, exp), true);
  // textIncludes in the viewport: textAbsent stays viewport-only.
  assert.equal(checkDeclarative({ ...off, text: 'Confirmed', textFound: ['confirmed', 'error'] }, exp), true);
});
