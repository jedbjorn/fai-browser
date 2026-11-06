// bench/real/tasks.json expectations must prove the task's own page: a Strasbourg results page must not pass the
// Lisbon Booking task, and the Google Flights start page must not pass the LIS-LHR task.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkDeclarative } from '../src/expectation.js';

const { tasks } = JSON.parse(await readFile(new URL('../bench/real/tasks.json', import.meta.url), 'utf8'));
const task = id => tasks.find(entry => entry.id === id);

test('booking-lisbon: the instruction names the Lisbon results page; a Strasbourg results page fails', () => {
  const booking = task('booking-lisbon');
  assert.match(booking.instruction, /Lisbon search results/);
  const results = city => ({
    url: `https://www.booking.com/searchresults.html?ss=${city}`, title: 'Booking.com', text: `${city}: 412 properties found`,
  });
  assert.equal(checkDeclarative(results('Lisbon'), booking.expectation), true);
  assert.equal(checkDeclarative(results('Strasbourg'), booking.expectation), false);
});

test('gflights-lis-lhr: the start page fails, the LIS-LHR results page passes', () => {
  const flights = task('gflights-lis-lhr');
  const start = {
    url: 'https://www.google.com/travel/flights?hl=en', title: 'Google Flights - Find Cheap Flight Options',
    text: 'Find cheap flights from Lisbon to anywhere\nParis\nLondon\nfrom €55\nHeathrow',
  };
  const results = {
    url: 'https://www.google.com/travel/flights?q=Flights%20from%20LIS%20to%20LHR%20on%202026-11-10%20one%20way&hl=en',
    title: 'Lisbon to London | Google Flights', text: 'Top flights\nfrom €105',
  };
  assert.equal(checkDeclarative(start, flights.expectation), false);
  assert.equal(checkDeclarative(results, flights.expectation), true);
});
