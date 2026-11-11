// Supplied values and the fields they go into (no browser): a form with several fields and several supplied values
// offers each value in the field it fits, not every value in every field; fields that share a label are told apart;
// a value that fits no field is still offered where no other value goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { legalActions, suppliedFit, suppliedTargets } from '../src/runtime.js';
import { actionBrief } from '../src/result.js';
import { ORIGIN } from './runtime-fixtures.js';

const field = (id, label, extra = {}) => ({ id, role: 'textbox', label, type: 'text', enabled: true, visible: true, ...extra });
const page = controls => ({ revision: 'r1', url: `${ORIGIN}/`, title: 'Contact', text: 'Write to us', controls });
const supplied = actions => actions.filter(action => action.type === 'fill_supplied_text').map(actionBrief);

test('a contact form named by placeholders: each supplied value goes into its own field only', () => {
  // The trait from the field report: no <label>, the placeholder names each field, and the name attribute says the same.
  const controls = [
    field('1', 'Name', { name: 'name', placeholder: 'Name', autocomplete: 'name' }),
    field('2', 'Email', { type: 'email', name: 'email', placeholder: 'Email', autocomplete: 'email' }),
    field('3', 'Message', { type: 'textarea', name: 'message', placeholder: 'Message' }),
  ];
  const actions = legalActions(page(controls), { mode: 'reversible', suppliedText: { name: 'Ada', email: 'a@x.example', message: 'Hi' } });
  assert.deepEqual(supplied(actions), ['fill textbox "Name" with supplied name', 'fill textbox "Email" with supplied email',
    'fill textbox "Message" with supplied message']);
});

test('fit: own name, id, autocomplete and type beat label words; noise tokens never match', () => {
  assert.equal(suppliedFit(field('1', 'Your address', { name: 'email' }), 'email'), 3);
  assert.equal(suppliedFit(field('1', 'Your address', { inputId: 'contact-email' }), 'contact_email'), 3);
  assert.equal(suppliedFit(field('1', 'Your address', { autocomplete: 'section-a shipping email' }), 'email'), 3);
  assert.equal(suppliedFit(field('1', 'Your address', { type: 'email' }), 'email'), 3);
  assert.equal(suppliedFit(field('1', 'E-mail'), 'email'), 2);
  assert.equal(suppliedFit(field('1', 'First name'), 'firstName'), 2);
  assert.equal(suppliedFit(field('1', 'Your first name please'), 'first_name'), 1);
  assert.equal(suppliedFit(field('1', 'Anything', { autocomplete: 'off' }), 'off'), 0);
  assert.equal(suppliedFit(field('1', 'Anything'), 'text'), 0, 'the plain text type names nothing');
});

test('targets: values that fit nothing go where no value goes; with every field claimed, everywhere', () => {
  const fields = [field('1', 'Search'), field('2', 'Email', { type: 'email' })];
  const targets = suppliedTargets(fields, ['query', 'email']);
  assert.deepEqual([...targets.get('email')], ['2']);
  assert.deepEqual([...targets.get('query')], ['1']);
  const claimed = suppliedTargets([field('1', 'Email', { type: 'email' })], ['email', 'note']);
  assert.deepEqual([...claimed.get('note')], ['1']);
  // Two fields fit equally (both called "Name"): the value is offered in both.
  const both = suppliedTargets([field('1', 'Name'), field('2', 'Name')], ['name']);
  assert.deepEqual([...both.get('name')], ['1', '2']);
});

test('fields that share a label are told apart by their own placeholder, name, id or type', () => {
  const controls = [
    field('1', 'Name', { placeholder: 'First' }),
    field('2', 'Name', { placeholder: 'Last' }),
    field('3', 'Phone', { name: 'phone_home' }),
    field('4', 'Phone', { name: 'phone_work' }),
    field('5', 'Code', { type: 'tel' }),
    field('6', 'Code', { inputId: 'promo' }),
    field('7', 'Comment'),
  ];
  const actions = legalActions(page(controls), { mode: 'reversible', suppliedText: { comment: 'x' }, agentText: true });
  const labels = actions.filter(action => action.type === 'fill').map(action => action.label);
  assert.deepEqual(labels, ['Name (First)', 'Name (Last)', 'Phone (phone_home)', 'Phone (phone_work)', 'Code (tel field)',
    'Code (promo)', 'Comment']);
  // The supplied fill keeps the field's own label when it is unique.
  assert.deepEqual(supplied(actions), ['fill textbox "Comment" with supplied comment']);
});
