// Supplied values and the fields they go into (no browser): a form with several fields and several supplied values
// offers each value in the field it fits, not every value in every field; fields that share a label are told apart;
// a value that fits no field is still offered where no other value goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, legalActions, offeredActions, suppliedFit, suppliedTargets, withheldWarning } from '../src/runtime.js';
import { actionBrief } from '../src/result.js';
import { warningLine } from '../src/mcp.js';
import { FakeBridge, ORIGIN, link } from './runtime-fixtures.js';

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

test('fit: a visible label or placeholder counts as much as a name, id, autocomplete token or type; noise never fits', () => {
  assert.equal(suppliedFit(field('1', 'Your address', { name: 'email' }), 'email'), 1);
  assert.equal(suppliedFit(field('1', 'Your address', { inputId: 'contact-email' }), 'contact_email'), 1);
  assert.equal(suppliedFit(field('1', 'Your address', { autocomplete: 'section-a shipping email' }), 'email'), 1);
  assert.equal(suppliedFit(field('1', 'Your address', { type: 'email' }), 'email'), 1);
  assert.equal(suppliedFit(field('1', 'E-mail'), 'email'), 1);
  assert.equal(suppliedFit(field('1', 'First name'), 'firstName'), 1);
  assert.equal(suppliedFit(field('1', 'Your first name please'), 'first_name'), 1);
  assert.equal(suppliedFit(field('1', 'Your email address', { name: 'sender' }), 'email'), 1);
  assert.equal(suppliedFit(field('1', 'Anything', { autocomplete: 'off' }), 'off'), 0);
  assert.equal(suppliedFit(field('1', 'Anything'), 'text'), 0, 'the plain text type names nothing');
});

test('a hidden attribute never takes a value away from the field whose label asks for it: both are offered', () => {
  // The decoy: the user's own field is labelled for the email; another field's hidden name attribute is "email".
  const controls = [
    field('1', 'Your email address', { name: 'sender' }),
    field('2', "Friend's address", { name: 'email' }),
    field('3', 'Note'),
  ];
  const actions = legalActions(page(controls), { mode: 'reversible', suppliedText: { email: 'a@x.example', note: 'hi' } });
  assert.deepEqual(supplied(actions), ['fill textbox "Your email address" with supplied email',
    'fill textbox "Friend\'s address" with supplied email', 'fill textbox "Note" with supplied note']);
});

test('targets: values that fit nothing go where no value goes; with every field claimed, everywhere', () => {
  const fields = [field('1', 'Search'), field('2', 'Email', { type: 'email' })];
  const targets = suppliedTargets(fields, ['query', 'email']);
  assert.deepEqual([...targets.get('email')], ['2']);
  assert.deepEqual([...targets.get('query')], ['1']);
  const claimed = suppliedTargets([field('1', 'Email', { type: 'email' })], ['email', 'note']);
  assert.deepEqual([...claimed.get('note')], ['1']);
  // A value that fits several fields is offered in each of them.
  const both = suppliedTargets([field('1', 'Name'), field('2', 'Company name'), field('3', 'Phone')], ['name']);
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

// Read-only: buttons and fields are never offered, but the host learns how many there are and which level offers them,
// so it asks for that level at once instead of scrolling and observing again. A count only, never their labels.
test('read-only: withheld buttons and fields are counted (controls_need_reversible), never listed or named', async () => {
  const controls = [
    link('1', 'Docs', '/docs'),
    { id: '2', role: 'button', label: 'Contact', enabled: true, visible: true },
    { id: '3', role: 'button', label: 'get in touch', enabled: true, visible: true },
    field('4', 'Search'),
    { id: '5', role: 'button', label: 'Delete account', enabled: true, visible: true },
    { id: '6', role: 'button', label: 'Newsletter', enabled: true, visible: true },
    { id: '7', role: 'button', label: 'Hidden', enabled: true, visible: false },
    // Reversible would not offer these either: a credential action, a select whose every other option is refused,
    // and a field the page marks as not for people.
    { id: '8', role: 'button', label: 'Show token', enabled: true, visible: true, gate: 'secret' },
    { id: '9', role: 'combobox', label: 'Bulk action', enabled: true, visible: true, selectedValue: 'none',
      options: [{ value: 'none', label: 'Choose' }, { value: 'a', label: 'Delete all' }, { value: 'b', label: 'Delete selected' }] },
    field('10', 'company', { trap: true }),
  ];
  const readOnly = offeredActions(page(controls), { mode: 'read-only', policy: { forbid: ['Newsletter'] } });
  // Contact, get in touch and Search: the delete button needs more than reversible, Newsletter is forbidden, Hidden is
  // hidden, and the credential button, the all-refused select and the trap field are not offered at reversible.
  assert.equal(readOnly.withheld, 3);
  assert.equal(withheldWarning(readOnly), 'controls_need_reversible:3');
  assert.ok(!readOnly.actions.some(action => /Contact|touch|Search/.test(action.label ?? '')), 'nothing new is offered');
  const reversible = offeredActions(page(controls), { mode: 'reversible' });
  assert.equal(reversible.withheld, 0);
  assert.ok(!reversible.actions.some(action => ['8', '9', '10'].includes(String(action.target))), 'none of them offered there');
  assert.equal(withheldWarning(offeredActions(page([link('1', 'Docs', '/docs')]), { mode: 'read-only' })), null);
  // Through an observe, as the host sees it: a trusted gloss naming the level and the call, and no label.
  const runtime = new BrowserRuntime({ bridge: new FakeBridge({ pages: { '/': { title: 'Home', text: 'Get in touch', controls } } }) });
  const observed = await runtime.observe({ mode: 'read-only' });
  assert.ok(observed.observation.warnings.includes('controls_need_reversible:4'), observed.observation.warnings.join());
  const line = warningLine('controls_need_reversible:4');
  assert.match(line, /^controls_need_reversible:4 \(4 buttons or fields on this page need level reversible and are not listed; /);
  assert.match(line, /fai_browser_open with this requestId and mode "reversible"/);
  assert.match(warningLine('controls_need_reversible:1'), /\(1 button or field on this page/);
  assert.equal(warningLine('password_field'), 'password_field');
});
