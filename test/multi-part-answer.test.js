// Regression: host suite docs-lead-guide (rounds five and six, live-fixes2-2026-10-06-host). The host asked in one
// question who the docs lead is and the title of their guide; the top block was the byline "Migrating Ledgers to
// Version Two by Priya Raman" and the byline value cut kept only the name, so FAI auto-confirmed "Priya Raman" at
// 0.96 to 0.98: a verified answer to half the question. A question that asks for two things now confirms only a line
// that carries both (a byline kept whole); otherwise it is `answer:multi_part` and the host reads the digest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoConfirm, isMultiPart } from '../src/digest.js';

const ranked = (...pairs) => ({ method: 'provider', candidates: pairs.map(([text, confidence]) => ({ text, confidence })) });
const BYLINE = 'Migrating Ledgers to Version Two by Priya Raman';

test('isMultiPart: two asks joined by and, as well as, plus, along with, a semicolon or two question marks', () => {
  for (const question of [
    'Who is the documentation lead and what is the title of their guide?',
    'Who is the docs lead and the title of the guide they wrote?',
    'Which plan and how much does it cost per month?',
    'What is the support contact name and email?',
    'Which office does Elif lead, as well as when does it open?',
    'Who leads the Berlin office plus what are its hours?',
    'What is the deploy region along with which token scope is needed?',
    'Who wrote the guide; what is its title?',
    'Who wrote the guide? What is its title?',
    'What are the price and the date of the next release?',
    'What is the cheapest flight departing before noon on 12 January, with its departure time, airline and price?',
  ]) assert.equal(isMultiPart(question), true, question);
});

test('isMultiPart: "and" inside a noun phrase is one question', () => {
  for (const question of [
    'What are the opening hours of the sales and support office?',
    'Where is the terms and conditions page?',
    'What is the price of bed and breakfast?',
    'Who handles billing and plans?',
    'What is the title of the guide written by the documentation lead?',
    'Who wrote the migration guide?',
    'What are the opening hours of the office Elif Demir leads?',
    'Which tent is cheapest and in stock?',
    '',
  ]) assert.equal(isMultiPart(question), false, question);
});

test('a two-part question never auto-confirms the bare name cut from a byline', () => {
  const question = 'Who is the documentation lead and what is the title of their guide?';
  const { answer, why } = autoConfirm(ranked([BYLINE, 0.97], ['Priya Raman — Documentation lead', 0.02]), { question });
  assert.ok(answer, `confirmed: ${why}`);
  assert.equal(answer.text, BYLINE, 'the byline carries both parts and is kept whole');
  assert.ok(answer.basis.includes('value:byline_whole'));
  assert.equal(answer.line, undefined);
});

test('a two-part question whose top line answers one part is answer:multi_part', () => {
  const question = 'Who is the documentation lead and what is the title of their guide?';
  for (const line of ['Priya Raman — Documentation lead', 'Priya Raman', 'Migrating Ledgers to Version Two']) {
    const { answer, why } = autoConfirm(ranked([line, 0.97], ['other', 0.01]), { question });
    assert.equal(answer, null, line);
    assert.deepEqual(why, ['answer:multi_part'], line);
  }
  const price = autoConfirm(ranked(['$37 per month', 0.97], ['x', 0.01]), { question: 'Which plan and how much per month?' });
  assert.deepEqual(price.why, ['answer:multi_part'], 'the price alone does not name the plan');
  const hours = autoConfirm(ranked(['Mon–Fri 09:00–17:30', 0.97], ['x', 0.01]),
    { question: 'Which office does Elif lead and when is it open?' });
  assert.deepEqual(hours.why, ['answer:multi_part'], 'the hours alone do not name the office');
  const contact = autoConfirm(ranked(['Elif Demir — elif@example.com', 0.97], ['x', 0.01]),
    { question: 'What is the billing contact name and email?' });
  assert.deepEqual(contact.why, ['answer:multi_part']);
});

test('a line holding the item beside the asked price is kept whole, not cut to the price', () => {
  const plan = autoConfirm(ranked(['Pro | $37 per month | $370 per year | 10', 0.97], ['x', 0.01]),
    { question: 'Which plan and how much per month?' });
  assert.equal(plan.answer?.text, 'Pro | $37 per month | $370 per year | 10');
  assert.equal(plan.answer?.exact, false, 'a table row: the host replies with the plan and the monthly price');
  assert.ok(plan.answer.basis.includes('value:multi_part_line'));
  const tent = autoConfirm(ranked(['Larkspur 2P tent €129', 0.97], ['x', 0.01]),
    { question: 'Which in-stock tent is the cheapest, and what does it cost?' });
  assert.equal(tent.answer?.text, 'Larkspur 2P tent €129');
});

test('single questions with "and" in a noun phrase still confirm and cut as before', () => {
  const hours = autoConfirm(ranked(['Mon–Fri 09:00–17:30', 0.95], ['x', 0.01]),
    { question: 'What are the opening hours of the sales and support office?' });
  assert.equal(hours.answer?.text, 'Mon–Fri 09:00–17:30');
  const price = autoConfirm(ranked(['Bed and breakfast | €89 per night', 0.95], ['x', 0.01]),
    { question: 'What is the price of bed and breakfast?' });
  assert.ok(price.answer, String(price.why));
  const terms = autoConfirm(ranked(['Terms and conditions: /legal/terms', 0.95], ['x', 0.01]),
    { question: 'Where is the terms and conditions page?' });
  assert.ok(terms.answer, String(terms.why));
  const title = autoConfirm(ranked([BYLINE, 0.97], ['x', 0.01]),
    { question: 'What is the title of the guide written by the documentation lead?' });
  assert.equal(title.answer?.text, 'Migrating Ledgers to Version Two');
  const billing = autoConfirm(ranked(['Elif Demir — Billing and plans', 0.95], ['x', 0.01]),
    { question: 'Who handles billing and plans?' });
  assert.equal(billing.answer?.text, 'Elif Demir');
});

test('an instruction sentence that describes a page is not a second ask', () => {
  assert.equal(isMultiPart('The About page names the team member who handles billing and plans. The Contact page lists '
    + 'the offices and who leads each one. What are the opening hours of the office that person leads?'), false);
  assert.equal(isMultiPart('Open the docs page and read the guide title and author.'), true, 'no question: the whole text');
});
