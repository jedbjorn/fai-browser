// Injected only into the user-selected tab, once per document. It never accepts selectors or scripts:
// the companion can only name a control by the numeric id this script handed out in its last observation,
// and only from a closed set of action types.
//
// Errors are returned to the worker as { error: { code, message } } with codes from the bridge contract.
(() => {
  if (globalThis.__faiPage) return;

  const MAX_CONTROLS = 100;
  const MAX_TEXT = 8000;
  const CONTROL_SELECTOR = [
    // A <details> summary toggles its section natively (an accordion).
    'a[href]', 'button', 'input', 'textarea', 'select', 'details > summary',
    '[role="button"]', '[role="link"]', '[role="combobox"]', '[role="listbox"]',
    '[role="textbox"]', '[role="checkbox"]', '[role="radio"]', '[role="option"]',
    '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="tab"]',
  ].join(',');
  const EXPLICIT_ROLES = new Set(['link', 'button', 'textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'option',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab']);
  const MENU_ITEM_ROLES = new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio']);
  const CHECKABLE_ROLES = new Set(['checkbox', 'radio', 'menuitemcheckbox', 'menuitemradio']);
  // Custom dropdowns and menus: an option or menu item is a control only inside its container (or the popup an
  // aria-expanded trigger controls), and only while rendered, so the open list is offered after the trigger click.
  const OPTION_CONTAINER = '[role="listbox"],[role="menu"],[role="combobox"],[role="tree"],[role="grid"]';

  // Same-origin frames (depth 1): read into blocks and controls like the top document. Control ids stay one
  // sequence across the document, its open shadow roots and these frames ("1".."100" in output order); a frame's
  // controls also carry `frame` (1-based index of the readable frame in document order), and act() resolves the id
  // against the last observation whatever document it is in. Cross-origin frames are never read here; they are
  // listed as the warning cross_origin_frame and as slots for the worker, which runs this script inside the ones whose
  // origin the request approved (frameSlots, pageFacts, useContext below).
  const MAX_FRAMES = 8;
  const FRAME_ELEMENT_BUDGET = 20_000;
  // A click that navigates only a frame waits at most this long for the frame's load (the tab's own NAV_CAP_MS).
  const FRAME_LOAD_CAP_MS = 3000;
  // Label and field classes, byte copies of src/guardrails.js (drift check in test/guardrails-drift.test.js):
  // PURCHASE needs `purchase` (testing only); COMMIT_OTHER needs `submit` (apply) or `delete` (cancel); the three word
  // lists need `submit`, `delete` and `sign_in`; SAFE_SUBMIT names the form submits `submit_safe` allows; payment
  // fields (PAYMENT_AUTOCOMPLETE, PAYMENT_FIELD) count as purchase.
  const PURCHASE = /^(?:order|book|reserve|transfer|check ?out|bid|renew|upgrade|pre-?order)(?:\s+now)?[\s.!]*$|\b(?:place\s+(?:an?\s+|the\s+|your\s+|my\s+)?(?:order|bid)|order\s+now|pre-?order|checkout|(?:proceed|continue|go)\s+to\s+(?:check ?out|payment)|(?:book|reserve)\s+(?:now|(?:this|it|a|an|the|your|my)\b)|pay(?:\s+now)?|buy|purchase|subscribe|donate|bid\s+now|make\s+(?:a\s+)?(?:payment|donation)|(?:complete|confirm|submit|finali[sz]e)\s+(?:(?:my|your|the|this)\s+)?(?:order|purchase|payment|booking|reservation|subscription|donation|bid|transfer)|upgrade(?:\s+(?:your|my))?\s+plan|upgrade\s+(?:now|to\s+(?:pro|premium|plus|business|enterprise|team|paid))|renew\s+(?:now|(?:(?:my|your|the)\s+)?(?:subscription|membership|plan))|start\s+(?:a\s+|your\s+|my\s+)?(?:free\s+)?trial|transfer\s+(?:now|money|funds)|withdraw|send\s+(?:money|payment)|add\s+(?:a\s+)?(?:new\s+)?(?:payment\s+method|(?:credit|debit)\s+card))\b/i;
  const COMMIT_OTHER = /\b(?:apply\s+(?:now|for|changes)|cancel\s+(?:(?:my|your|the)\s+)?(?:subscription|membership|account|plan|order))\b/i;
  const SUBMIT_WORDS = /\b(save(?!\s+(?:up\s+to\s+|over\s+|an\s+extra\s+|extra\s+)?(?:[$€£¥₹]\s?\d|\d[\d.,]*\s?(?:%|percent\b|[$€£¥₹]|(?:usd|eur|gbp)\b)))|submit|send|confirm|invite|publish)\b/i;
  const DELETE_WORDS = /\b(delete|remove)\b/i;
  const SIGN_IN_WORDS = /\b(sign ?in|log ?in)\b/i;
  const SAFE_SUBMIT = /^(?:search(?:\s+(?:for\s+)?[\p{L}\p{N}'-]+)?|find|go|filters?|apply(?:\s+filters?)?|sort(?:\s+results)?|refine(?:\s+search)?|show(?:\s+(?:more|all|results))?|(?:see|view|load)\s+more|more\s+results|update\s+results|next(?:\s+page)?|prev(?:ious)?(?:\s+page)?)[\s.!]*$/iu;
  const PAYMENT_AUTOCOMPLETE = /(?:^|\s)cc-[a-z-]+(?:\s|$)/i;
  const PAYMENT_FIELD = /(?:^|[^a-z])(?:card[\s_.-]*(?:number|num|no)|cc[\s_.-]*(?:number|num|exp\w*|csc|cvc|cvv)|(?:credit|debit)[\s_.-]*card|card[\s_.-]*(?:expir\w*|exp)|expir(?:y|ation)[\s_.-]*(?:date|month|year)|exp[\s_.-]*(?:date|month|year)|cvc|cvv2?|csc|card[\s_.-]*(?:security|verification)[\s_.-]*code|security[\s_.-]*code|iban|kartennummer|n[uú]mero[\s_.-]*de[\s_.-]*(?:la[\s_.-]*)?tarjeta)(?![a-z])/i;
  // The intent tiers (src/guardrails.js labelTier): the ambiguous words Jev may clear; byte copies (drift check).
  const AMBIGUOUS_SUBMIT = /\b(?:save|confirm|send|invite|publish)\b/gi;
  const AMBIGUOUS_PURCHASE = /^(?:order|book|reserve|upgrade)[\s.!]*$|\b(?:book|reserve)\s+(?:a|an|the)\b/gi;
  // The Approve gate (src/guardrails.js, byte copies; drift check in test/guardrails-drift.test.js).
  const SECRET_ACTION = /\b(?:generate|create|new|regenerate|roll|rotate|revoke|reveal|show|view|copy|unmask)(?:\s+[\p{L}\p{N}-]+){0,3}?\s+(?:keys?|tokens?|secrets?|passwords?|credentials?|(?:recovery|backup)\s+codes?)\b/iu;
  const COMMIT_DIALOG = /\b(?:are you sure|cannot be undone|can(?:'|’)?t be undone|permanently|delete|remove|cancel\s+(?:(?:my|your|the|this)\s+)?(?:subscription|account|membership|plan))\b/i;
  const BACK_OUT = /^(?:cancel|no|no,? thanks|keep(?:\s+\p{L}+){0,2}|go back|back|close|never ?mind|not now|dismiss|stay|return|x|×|✕|✖)[\s.!]*$/iu;
  const STEPPER = /^(?:[+−–-]\s*\d*|(?:increase|decrease|increment|decrement)(?:\s+quantity)?|plus|minus)$|\b(?:quantity|qty)\b/iu;
  const PURCHASE_PATH = /\/(?:checkout|payment|payments|billing|order|subscribe|upgrade|plans)(?:\.[a-z0-9]{1,6})?(?=[/?#;]|$)/i;
  const COMMIT_LIKE = /\b(?:pay|place\s+(?:(?:an?|the|your|my)\s+)?order|confirm|complete|continue|next|submit|buy|subscribe|purchase|check\s?out|proceed|finish)\b(?!\s+(?:(?:with|your|my|the|this)\s+)?(?:e-?mail|address|phone|password|profile|settings|identity|name)\b)/i;
  const PURCHASE_TOTAL = /(?:^|\n)[ \t]*(?:order\s+summary|(?:order\s+|grand\s+|estimated\s+)?total(?:\s+due)?|amount\s+due|due\s+today)\b[\s\S]{0,60}?(?:[$€£¥₹]\s?\d|\b(?:usd|eur|gbp)\s?\d|\b\d[\d.,]*\s?(?:[$€£¥₹]|(?:usd|eur|gbp)\b))/i;
  function purchasePage({ path, text, payment } = {}) {
    if (payment) return true;
    if (typeof path === 'string' && PURCHASE_PATH.test(path)) return true;
    return typeof text === 'string' && PURCHASE_TOTAL.test(text.slice(0, 20_000));
  }
  function purchaseExempt(label) {
    return labelSpellings(label).some(text => BACK_OUT.test(text) || STEPPER.test(text));
  }
  function purchaseControl(label, { checkout = false, navigation = false } = {}) {
    if (navigation || purchaseExempt(label)) return false;
    return checkout || labelSpellings(label).some(text => COMMIT_LIKE.test(text));
  }
  function secretAction(label) {
    return labelSpellings(label).some(text => SECRET_ACTION.test(text));
  }
  // Capabilities (configurable-guardrails.md §3.1) arrive from the worker as the user's grant intersected with the
  // command's level. Every risk class needs one capability; 'forbid' (the request's additions) needs one that
  // does not exist. Without a set from the worker, page.js keeps its original block: links, buttons, selects and
  // fills, never submits, committing labels, payment fields or consent accepts.
  const CLASS_NEEDS = {
    navigation: 'navigate', reversible: 'controls', submit_safe: 'submit_safe', submit: 'submit', delete: 'delete',
    consent_accept: 'consent_accept', sign_in: 'sign_in', purchase: 'purchase',
  };
  const KNOWN_CAPABILITIES = new Set(Object.values(CLASS_NEEDS));
  // Most restrictive first: a control that names several classes takes the first.
  const CLASS_ORDER = ['forbid', 'purchase', 'sign_in', 'delete', 'submit', 'consent_accept', 'submit_safe', 'reversible', 'navigation'];
  const DEFAULT_ALLOW = ['navigate', 'controls'];
  // Guardrail additions (src/guardrails.js): plain phrases the request forbids, received from the worker as strings
  // (never regex source) and compiled here exactly as the runtime compiles them: escaped, word-bounded,
  // case-insensitive. They only add to the hard-coded label classes above, which always apply.
  // forbidPattern is identical to src/guardrails.js (drift check in test/guardrails-drift.test.js).
  const MAX_FORBID = 40;
  const MAX_FORBID_LENGTH = 60;
  function normalizeLabel(label) {
    const lookalikes = { а: 'a', α: 'a', в: 'b', β: 'b', с: 'c', ϲ: 'c', е: 'e', ε: 'e', ё: 'e',
      һ: 'h', н: 'h', η: 'h', і: 'i', ι: 'i', ї: 'i', ј: 'j', к: 'k', κ: 'k', м: 'm', μ: 'm',
      о: 'o', ο: 'o', р: 'p', ρ: 'p', ѕ: 's', т: 't', τ: 't', у: 'y', υ: 'y', х: 'x', χ: 'x', ν: 'v' };
    return String(label ?? '').normalize('NFKD').toLowerCase().replace(/[\p{M}\p{Cf}]/gu, '')
      .replace(/[аαвβсϲеεёһнηіιїјкκмμоορрѕтτуυхχν]/gu, char => lookalikes[char] ?? char)
      .replace(/\s+/g, ' ').trim()
      .replace(/\b(?:[a-z] ){2,}[a-z]\b/g, word => word.replace(/ /g, ''));
  }

  /** Invisible formatting may join letters or separate words: refuse either safety spelling. */
  function labelSpellings(label) {
    return [...new Set([normalizeLabel(label), normalizeLabel(String(label ?? '').replace(/\p{Cf}/gu, ' '))])];
  }

  function forbidPattern(phrases) {
    const parts = [];
    for (const raw of Array.isArray(phrases) ? phrases : []) {
      for (const phrase of new Set([String(raw), normalizeLabel(raw)])) {
        const words = String(phrase).trim().split(/\s+/).filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        if (words.length) parts.push(words.join('\\s+'));
      }
    }
    return parts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;
  }
  // The intent tier of a label (src/guardrails.js labelTier, byte copy): ambiguous, hard or null.
  function labelTier(label) {
    let flagged = false;
    for (const text of labelSpellings(label)) {
      if (SIGN_IN_WORDS.test(text) || DELETE_WORDS.test(text) || COMMIT_OTHER.test(text)) return 'hard';
      // A label naming a payment object ("Save card", "Confirm billing details") is about money whatever its verb.
      const purchase = PURCHASE.test(text);
      const submit = SUBMIT_WORDS.test(text);
      if (!purchase && !submit) continue;
      if (/\b(?:cards?|payments?|billing|bank|wallet|iban)\b/i.test(text)) return 'hard';
      flagged = true;
      if (purchase && PURCHASE.test(text.replace(AMBIGUOUS_PURCHASE, ' '))) return 'hard';
      if (submit && SUBMIT_WORDS.test(text.replace(AMBIGUOUS_SUBMIT, ' '))) return 'hard';
    }
    return flagged ? 'ambiguous' : null;
  }

  // <secret-rules> Identical in src/secrets.js, extension/background.js and extension/page.js (there indented two
  // spaces inside its closure); drift check in test/secrets.test.js. Plain declarations only, every name starting with
  // SECRET_ or secret: the worker loads it as a classic script and the page script inside its closure.
  //
  // Known formats, always on (every level, testing included, and on Relaxed origins): [kind, pattern, check?]. Group
  // `pre` is the public prefix a placeholder keeps; group `lead` is text before the secret that stays (a parameter
  // name, a connection string's user); the rest of the match is the secret. Without a check, the part after the prefix
  // must mix letters and digits and not be words joined by dashes (secretFormatBody).
  const SECRET_FORMATS = [
    ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[A-Za-z0-9+/=\s:,.-]*)/g, () => true],
    ['anthropic', /(?<![\w-])(?<pre>sk-ant-(?:[a-z]+\d*-)?)[\w-]{20,}/g],
    ['openai', /(?<![\w-])(?<pre>sk-(?:proj-|svcacct-|admin-|None-)?)(?!ant-)[\w-]{20,}/g],
    ['github', /(?<![\w-])(?<pre>gh[pousr]_)[A-Za-z0-9]{30,}/g],
    ['github', /(?<![\w-])(?<pre>github_pat_)\w{40,}/g],
    ['slack', /(?<![\w-])(?<pre>xox[abposr]-)[A-Za-z0-9-]{10,}/g],
    ['slack-webhook', /(?<pre>https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9_/-]{20,}/g],
    ['discord-webhook', /(?<pre>https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/)\d+\/[\w-]{30,}/g],
    ['aws', /(?<![A-Za-z0-9])(?<pre>AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g],
    ['aws-secret', /(?<=(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}[\s,;:|"'=]{1,6})[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g],
    ['google', /(?<![\w-])(?<pre>AIza)[\w-]{35}(?![\w-])/g],
    ['google-oauth', /(?<![\w-])(?<pre>ya29\.)[\w-]{20,}/g],
    ['google-oauth', /(?<![\w-])(?<pre>GOCSPX-)[\w-]{20,}/g],
    ['gitlab', /(?<![\w-])(?<pre>gl(?:pat|ptt)-)[\w-]{20,}/g],
    ['stripe', /(?<![\w-])(?<pre>(?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{16,}/g],
    ['stripe-webhook', /(?<![\w-])(?<pre>whsec_)[A-Za-z0-9+/=]{20,}/g],
    ['npm', /(?<![\w-])(?<pre>npm_)[A-Za-z0-9]{36,}/g],
    ['pypi', /(?<![\w-])(?<pre>pypi-AgEI)[\w-]{50,}/g],
    ['huggingface', /(?<![\w-])(?<pre>hf_)[A-Za-z0-9]{30,}/g],
    ['groq', /(?<![\w-])(?<pre>gsk_)[A-Za-z0-9]{40,}/g],
    ['xai', /(?<![\w-])(?<pre>xai-)[A-Za-z0-9]{40,}/g],
    ['replicate', /(?<![\w-])(?<pre>r8_)[A-Za-z0-9]{30,}/g],
    ['sendgrid', /(?<![\w-])(?<pre>SG\.)[\w-]{16,}\.[\w-]{16,}/g],
    ['digitalocean', /(?<![\w-])(?<pre>do[por]_v1_)[a-f0-9]{64}/g],
    ['shopify', /(?<![\w-])(?<pre>shp(?:at|ss|ca|pa)_)[a-fA-F0-9]{32}/g],
    ['linear', /(?<![\w-])(?<pre>lin_api_)[A-Za-z0-9]{40}/g],
    ['postman', /(?<![\w-])(?<pre>PMAK-)[a-f0-9]{24}-[a-f0-9]{34}/g],
    ['supabase', /(?<![\w-])(?<pre>sbp_)[a-f0-9]{40}/g],
    ['atlassian', /(?<![\w-])(?<pre>ATATT)[\w=-]{50,}/g],
    ['jwt', /(?<![\w-])(?<pre>eyJ)[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{10,}/g],
    // A signed or secret URL parameter (query or fragment): the value goes, the origin, path and name stay.
    ['url-param', /(?<lead>[?&#;](?:[\w.-]*[_.-])?(?:token|key|secret|sig|signature|code|auth|session|sessionid|password|passwd|pwd|apikey|credential)=)(?!\[secret:)[^&#\s"'<>\]]{6,}/gi, () => true],
    // A connection string's password: scheme://user:PASSWORD@host.
    ['password', /(?<lead>(?<![\w+.-])[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@?#[\]]{1,100}:)(?!\[secret:)[^\s@/?#[\]]{1,200}(?=@)/gi, value => !/^(?:\*+|x+|•+)$/i.test(value)],
    ['card', /(?<![\w-])(?:\d[ -]?){12,18}\d(?![\d-])/g, value => secretCard(value)],
  ];
  // Generic and context rules (Standard and Strict; off on Relaxed origins). A candidate is a run of 20 or more key
  // characters; it counts only next to a word that says key, token, secret, password, bearer, credential or recovery
  // code (in the 60 characters before it or in the label the caller passes), or anywhere on a secret page or in Strict.
  const SECRET_CANDIDATE = /(?<![\w+/-])[\w+/-]{20,}={0,2}(?![\w+/=-])/g;
  const SECRET_CONTEXT = /(?<![A-Za-z])(?:api[\s_-]?keys?|keys?|tokens?|secrets?|passwords?|passwd|passphrase|passcode|bearer|credentials?|auth(?:orization)?|recovery[\s_-]?codes?|backup[\s_-]?codes?)(?![A-Za-z])/i;
  const SECRET_CONTEXT_CHARS = 60;
  // A base32 TOTP seed ("JBSW Y3DP EHPK 3PXP") next to setup key / authenticator wording.
  const SECRET_TOTP = /(?<![A-Za-z0-9])(?:[A-Za-z2-7]{4}[ -]?){3,15}[A-Za-z2-7]{4}(?![A-Za-z0-9])/g;
  const SECRET_TOTP_CONTEXT = /(?<![A-Za-z])(?:setup[\s_-]?key|secret[\s_-]?key|authenticator|two[\s-]?factor|2fa|mfa|totp|otp)(?![A-Za-z])/i;
  const SECRET_TOTP_CHARS = 160;
  // Recovery and backup codes in the list under such a heading.
  const SECRET_RECOVERY = /(?<![A-Za-z0-9-])(?:[A-Za-z0-9]{4,6}-[A-Za-z0-9]{4,6}|\d{4}[ -]\d{4}|[A-Za-z0-9]{8,16})(?![A-Za-z0-9-])/g;
  const SECRET_RECOVERY_CONTEXT = /(?<![A-Za-z])(?:recovery|backup)[\s_-]?(?:codes?|keys?)(?![A-Za-z])/i;
  const SECRET_RECOVERY_CHARS = 400;
  // An environment variable row: an UPPER_SNAKE name that says key, token, secret, password or DSN (or DATABASE_URL),
  // then its value.
  const SECRET_ENV = /(?<lead>(?<![A-Za-z0-9_])(?<name>[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?![A-Za-z0-9_])["']?[ \t]*(?:[=:|\t\n][ \t]*|[ \t]+)["']?)(?!\[secret:)[^\s"'|,;]{6,}/g;
  const SECRET_ENV_NAME = /(?:^|_)[A-Z0-9]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|DSN|PRIVATE|CREDENTIALS?)[A-Z0-9]*(?:_|$)|^DATABASE_URL$/;
  // "Password: X" (a temporary password, a generated one).
  const SECRET_PASSWORD_LABEL = /(?<lead>(?<![A-Za-z])(?:password|passwd|passphrase|passcode|pwd)(?![A-Za-z])\s*(?:is\s+)?[:=]\s*["']?)(?!\[secret:)[^\s"'<>]{6,64}/gi;
  // Pages that exist to show credentials: their paths and their top headings. There the generic rule needs no context.
  const SECRET_PAGE_PATH = /\/(?:api[-_]?keys|credentials|security|2fa|mfa|totp|recovery(?:[-_]codes)?|personal[-_]access[-_]tokens|access[-_]tokens|service[-_]?accounts|webhooks|secrets)(?=\/|$)|\/settings\/(?:[^/]+\/)*tokens(?=\/|$)/i;
  const SECRET_PAGE_HEADING = /(?<![A-Za-z])(?:api[\s-]keys?|access[\s-]tokens?|personal access tokens?|environment variables|recovery codes|backup codes|secret keys?|signing secrets?|credentials|two-factor authentication|authenticator app)(?![A-Za-z])/i;
  // Kinds whose placeholder names only the kind; the generic kind names nothing.
  const SECRET_BARE = new Set(['password', 'private-key', 'totp', 'recovery-code', 'url-param']);
  // Every rule needs one of these (a digit in the value, a private-key header, a parameter, a URL password, a label's
  // colon, an UPPER_SNAKE name): text without any is skipped at once.
  const SECRET_HINT = /\d|PRIVATE KEY|[=:@_]/;

  function secretLuhn(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let digit = Number(digits[digits.length - 1 - i]);
      if (i % 2) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
    }
    return sum % 10 === 0;
  }

  /** A payment card number: 13-19 digits, a card network's prefix, card grouping (or none) and a valid Luhn digit. */
  function secretCard(value) {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
    if (!/^(?:4|5[1-5]|2[2-7]|3[47]|3[0689]|35|6(?:011|5|4[4-9]|2))/.test(digits)) return false;
    const groups = value.split(/[ -]/).map(group => group.length);
    if (groups.length > 1) {
      const fours = groups.slice(0, -1).every(length => length === 4) && groups.at(-1) <= 4;
      const amex = groups.length === 3 && groups[0] === 4 && groups[1] === 6 && groups[2] >= 4 && groups[2] <= 5;
      if (!fours && !amex) return false;
    }
    return secretLuhn(digits);
  }

  /** Shannon entropy in bits per character. */
  function secretEntropy(token) {
    const counts = new Map();
    for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
    let bits = 0;
    for (const count of counts.values()) {
      const p = count / token.length;
      bits -= p * Math.log2(p);
    }
    return bits;
  }

  /**
   * A generic key-shaped token: letters and digits mixed, at least 3.5 bits per character, not a path ("/a/b/c", or
   * "8080/qa/i18n/page": slashes between short segments) and not words and numbers joined by dashes
   * ("screenshot-2024-01-01-at-10").
   */
  function secretKeyShaped(token) {
    const bare = token.replace(/=+$/, '');
    if (bare.length < 20 || !/[A-Za-z]/.test(bare) || !/\d/.test(bare)) return false;
    if (/^\/|\/\/|\/$|(?:^|\/)[a-z]{3,}(?:[-_][a-z]+)*\//.test(bare)) return false;
    if (bare.includes('/') && bare.split('/').every(segment => segment.length < 12)) return false;
    const parts = bare.split(/[-_./+]+/).filter(Boolean);
    if (parts.length >= 2 && parts.every(part => /^[A-Za-z]+$/.test(part) || /^\d+$/.test(part))) return false;
    return secretEntropy(bare) >= 3.5;
  }

  /** The default format check: the part after the public prefix mixes letters and digits and is not dashed words. */
  function secretFormatBody(value, match) {
    const body = value.slice((match.groups?.pre ?? '').length);
    if (!/[A-Za-z]/.test(body) || !/\d/.test(body)) return false;
    const parts = body.split(/[-_.]+/).filter(Boolean);
    return !(parts.length >= 3 && parts.every(part => /^[A-Za-z]+$/.test(part) || /^\d+$/.test(part)));
  }

  /** Whether a page is a credentials page: its path, or one of its top headings. */
  function secretPageSignal(path, headings = []) {
    if (typeof path === 'string' && SECRET_PAGE_PATH.test(path)) return true;
    return headings.some(text => typeof text === 'string' && text.length <= 120 && SECRET_PAGE_HEADING.test(text));
  }

  /**
   * The secrets in `text`: [{start, end, kind, pre}] in order, never overlapping. `options.strict` applies the generic
   * rule without context (Strict, or a secret page); `options.relaxed` keeps the known formats only; `options.context`
   * is extra label text that counts as context (a column header, a field label).
   */
  function secretFind(text, options = {}) {
    const spans = [];
    if (typeof text !== 'string' || text.length < 6 || !SECRET_HINT.test(text)) return spans;
    const push = (match, kind, check) => {
      const lead = match.groups?.lead ?? '';
      const value = match[0].slice(lead.length).replace(/\s+$/, '');
      if (!value || (check && !check(value, match))) return;
      const start = match.index + lead.length;
      spans.push({ start, end: start + value.length, kind, pre: match.groups?.pre ?? '' });
    };
    for (const [kind, pattern, check] of SECRET_FORMATS) {
      for (const match of text.matchAll(pattern)) push(match, kind, check ?? secretFormatBody);
    }
    if (!options.relaxed) {
      const extra = typeof options.context === 'string' ? options.context.slice(-200) : '';
      const before = (index, chars) => `${extra} ${text.slice(Math.max(0, index - chars), index)}`;
      for (const match of text.matchAll(SECRET_CANDIDATE)) {
        if (!secretKeyShaped(match[0])) continue;
        if (options.strict || SECRET_CONTEXT.test(before(match.index, SECRET_CONTEXT_CHARS))) push(match, 'generic');
      }
      for (const match of text.matchAll(SECRET_TOTP)) {
        const bare = match[0].replace(/[ -]/g, '');
        if (bare.length < 16 || !/[2-7]/.test(bare) || (bare !== bare.toUpperCase() && bare !== bare.toLowerCase())) continue;
        if (SECRET_TOTP_CONTEXT.test(before(match.index, SECRET_TOTP_CHARS))) push(match, 'totp');
      }
      if (SECRET_RECOVERY_CONTEXT.test(`${extra} ${text}`)) {
        for (const match of text.matchAll(SECRET_RECOVERY)) {
          if (!/\d/.test(match[0]) || (/^[A-Za-z0-9]+$/.test(match[0]) && !/[A-Za-z]/.test(match[0]) && match[0].length !== 8)) continue;
          if (SECRET_RECOVERY_CONTEXT.test(before(match.index, SECRET_RECOVERY_CHARS))) push(match, 'recovery-code');
        }
      }
      for (const match of text.matchAll(SECRET_ENV)) {
        const value = match[0].slice(match.groups.lead.length);
        if (!SECRET_ENV_NAME.test(match.groups.name) || /^[•*●·.x]+$/i.test(value)) continue;
        if (/[\d:/@.+=_-]/.test(value)) push(match, 'generic');
      }
      for (const match of text.matchAll(SECRET_PASSWORD_LABEL)) {
        const value = match[0].slice(match.groups.lead.length);
        if (/^[•*●·.x]+$/i.test(value) || !(/[\d\W_]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)))) continue;
        push(match, 'password');
      }
    }
    // Nothing inside a placeholder an earlier pass wrote (its tag or kind words) is a secret: redaction is idempotent.
    const placed = text.includes('[secret:') ? [...text.matchAll(/\[secret:[^\]]*\]/g)].map(m => [m.index, m.index + m[0].length]) : [];
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const kept = [];
    for (const span of spans) {
      if (placed.some(([start, end]) => span.start < end && span.end > start)) continue;
      const last = kept.at(-1);
      if (last && span.start < last.end) {
        // Overlap: the longer span wins; on a tie the earlier rule (a known format before the generic one).
        if (span.end - span.start > last.end - last.start) kept[kept.length - 1] = span;
        continue;
      }
      kept.push(span);
    }
    return kept;
  }

  /** A 53-bit string hash (cyrb53), base 36. Salted, it tags a value without revealing it. */
  function secretHash(value, salt = '') {
    const text = `${salt}\u0000${value}`;
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  /** The placeholder for one secret value; `id` is its number (or `~<hash>` before the worker numbers it). */
  function secretPlaceholder(id, kind, value, pre = '') {
    if (kind === 'generic') return `[secret:${id}]`;
    if (SECRET_BARE.has(kind)) return `[secret:${id} ${kind === 'url-param' ? 'param' : kind}]`;
    const body = kind === 'card' ? value.replace(/\D/g, '') : value;
    const tail = body.length - pre.length >= 16 || kind === 'card' ? body.slice(-4) : '';
    return `[secret:${id} ${kind} ${pre}…${tail} len ${body.length}]`;
  }

  /**
   * `text` with every secret replaced by its placeholder. `options` as secretFind, plus `id(value)` (the number a
   * value gets; default: `~` and its hash salted with `options.salt`).
   */
  function secretRedactText(text, options = {}) {
    const spans = secretFind(text, options);
    if (!spans.length) return text;
    const idOf = typeof options.id === 'function' ? options.id : value => `~${secretHash(value, options.salt ?? '')}`;
    let out = '';
    let at = 0;
    for (const span of spans) {
      const value = text.slice(span.start, span.end);
      out += text.slice(at, span.start) + secretPlaceholder(idOf(value), span.kind, value, span.pre);
      at = span.end;
    }
    return out + text.slice(at);
  }

  /** A URL with its secrets redacted (known formats, signed parameters, a password): origin and path stay as they are. */
  function secretRedactUrl(url, options = {}) {
    return secretRedactText(url, { ...options, relaxed: true, strict: false });
  }
  // </secret-rules>

  // Live regions announce changes (tickers, toasts, status lines); their churn must not invalidate a decision.
  const LIVE_REGION = '[aria-live]:not([aria-live="off"]),[role="status"],[role="log"],[role="timer"],[role="marquee"]';
  // An open dialog or popup: a control inside one (a date picker's grid) is reported `dialog: true`.
  const DIALOG = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]';
  // A page that marks its body or root element a dialog does not put every control in one (each would get the
  // runtime's long late-change wait).
  function inDialog(el) {
    let dialog = el.closest(DIALOG);
    while (dialog && (dialog === dialog.ownerDocument.body || dialog === dialog.ownerDocument.documentElement)) {
      dialog = dialog.parentElement?.closest(DIALOG) ?? null;
    }
    return Boolean(dialog);
  }
  const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'OBJECT']);

  // Structured page content ("blocks"): one entry per heading, paragraph, list item, table row, term, label,
  // link, button or alert, built from the same text-node walk as the visible text.
  const MAX_BLOCKS = 200;
  const MAX_BLOCK_TEXT = 300;
  // Elements whose whole subtree is a single block, even when it contains other block elements.
  const OWN_BLOCK_TYPES = {
    H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h4', H6: 'h4', TR: 'tr', DT: 'dt', LABEL: 'label',
  };
  // Text containers: a nested container of the same kind starts its own block (a sub-list, a <p> in an <li>).
  const TEXT_BLOCK_TYPES = {
    P: 'p', LI: 'li', DD: 'p', BLOCKQUOTE: 'p', PRE: 'p', FIGCAPTION: 'p', CAPTION: 'p', SUMMARY: 'p', LEGEND: 'p',
  };
  // Phrasing elements: their text belongs to the enclosing block. Anything not listed (div, section, td, ...)
  // that holds text directly becomes a generic 'p' block.
  const INLINE_TAGS = new Set([
    'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'IMG', 'INPUT',
    'INS', 'KBD', 'MARK', 'METER', 'OUTPUT', 'PROGRESS', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SAMP', 'SMALL', 'SPAN',
    'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR',
  ]);
  // Subtrees never turned into blocks: form values and option lists are reported through controls instead.
  const BLOCK_SKIP_TAGS = new Set([...SKIP_TEXT_TAGS, 'SELECT', 'OPTION', 'OPTGROUP', 'DATALIST', 'TEXTAREA']);
  const SKIP = null;
  // A rendered <select> becomes one block, "<label>: <option> | <option> | ...", placed where its options are.
  const MAX_SELECT_OPTIONS = 20;
  const MAX_SELECT_TEXT = 200;

  // Open shadow roots are read like light DOM. Finding them means looking at every element, so the scan has a
  // node budget (a 50k-element page costs a few milliseconds) and caps on roots and nesting.
  const SHADOW_SCAN_BUDGET = 50_000;
  const MAX_SHADOW_ROOTS = 64;
  const MAX_SHADOW_DEPTH = 4;

  // Control selection under MAX_CONTROLS: consent buttons, nag closers and floating choices, then other controls in
  // the viewport (those matching an instruction term first), with up to TERM_RESERVE slots kept for off-screen term
  // matches, then off-screen controls in document order.
  const TERM_RESERVE = 15;
  const MAX_TERMS = 30;
  // Visibility checks spent on counting the off-screen controls the cap left out (controlsDropped).
  const DROP_COUNT_BUDGET = 500;

  // Consent dialogs. The runtime offers only `reject` buttons and never `accept`; page.js refuses accept buttons
  // itself (risk 'destructive'). Kept in step with the runtime's consent label list.
  // English, German, French, Spanish, Italian, Portuguese and Dutch labels; "continue without accepting" is a reject.
  const CONSENT_REJECT = /reject|decline|refuse|necessary|essential|only required|без|ablehnen|nur notwendig|nur erforderlich|refuser|continuer sans accepter|rechazar|necesari|rifiut|solo necessari|rejeitar|recusar|apenas necess|weiger|alleen noodzakelijk/i;
  const CONSENT_ACCEPT = /\baccept|\bagree|\ballow|\bgot it\b|\bok(?:ay)?\b|\bakzeptier|\bzustimm|\beinverstanden|\btout accepter|\bacept|\baccett|\baceit|\bakkoord/i;
  const CONSENT_SETTINGS = /settings|manage|customi|options|preferences|einstellungen|anpassen|verwalten|paramètres|personnaliser|gérer|configur|ajustes|preferencias|impostazioni|personalizza|gestisci|definições|personalizar|gerir|instellingen|aanpassen|beheren/i;
  const CONSENT_WITHOUT_ACCEPT = /without accepting|ohne (?:zu )?(?:akzeptieren|zustimmen)|sans accepter|sin aceptar|senza accettare|sem aceitar|zonder (?:te )?accepteren/i;
  const CONSENT_CONTAINER = [
    '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', 'dialog[open]',
    ...['cookie', 'consent', 'gdpr', 'cmp', 'didomi', 'onetrust', 'usercentrics', 'cybot']
      .flatMap(word => [`[id*="${word}" i]`, `[class*="${word}" i]`]),
  ].join(',');
  // A generic dialog counts only when its text is about consent; a cookie/CMP id or class is signal enough.
  // "privacy", "partners" or "tracking" alone also appear in newsletter, offer and order-tracking popups.
  const CONSENT_WORDS = /cookie|consent|gdpr|personal data|tracking technolog/i;
  // A container named only "consent" (a consent-requests admin block, a consent form) is not a cookie banner by
  // name alone: it must also sit over the page and talk about cookies, a privacy policy or tracking technology.
  const COOKIE_WORDS = /cookie|gdpr|personal data|tracking technolog|similar technolog|privacy (?:policy|notice|statement|settings|choices|preferences)/i;
  // Names of cookie banners and consent-management platforms: signal enough without an overlay position.
  const CMP_NAME = /cookie|gdpr|\bcmp\b|cmp[-_]|[-_]cmp|didomi|onetrust|usercentrics|cybot|cookiebot|quantcast|trustarc|truste/i;
  // A whole page that is a consent wall (consent.google.com "Before you continue").
  // Titles only: a bare "cookie" or "consent" also names recipe pages and consent-request admin pages.
  const CONSENT_PAGE = /before you continue|privacy choices|cookie (?:consent|settings|preferences|choices)|consent to (?:cookies|the use)/i;
  const CONSENT_BUTTON = 'button,[role="button"],input[type="submit"],input[type="button"],a[href]';
  const MAX_CONSENT_CANDIDATES = 60;
  const MAX_CONSENT_BUTTONS = 25;
  const MAX_CONSENT_TEXT = 200;
  // Decision 2: a login wall is a password field plus a sign-in title or first heading.
  const LOGIN_TITLE = /sign in|log in|login/i;

  // Stable per-element identity. A node replaced by an identical clone gets a new identity, so a decision made
  // against the old node is rejected as stale instead of silently clicking a different element.
  const identities = new WeakMap();
  let identitySequence = 0;

  // A random id: crypto.randomUUID exists only in secure contexts; getRandomValues everywhere (plain http pages too).
  function randomId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  const documentId = randomId();
  let sequence = 0;
  let signature = '';
  let revision = '';
  let targets = new Map();
  // Instruction terms from the last observe that named them; every later observe in this document (including the
  // pre-dispatch check) orders controls the same way, so ids stay stable.
  let currentTerms = [];
  // The compiled guardrail additions from the last call that named them (null: core block only).
  let currentForbid = null;
  // The capabilities from the last call that named them.
  let currentAllow = new Set(DEFAULT_ALLOW);
  // The domain roots the user approved for the session ("example.com"), from the last call that named them: a link or
  // allowed URL may leave this origin only for another https page under one of them that also covers this page.
  let currentSites = [];
  // The page context the worker sends with every call (useContext): facts of the other documents of the same tab that
  // this one cannot see (approved cross-origin frames, or the top document seen from such a frame). They only add
  // restrictions here: `purchase` (a purchase page), `sensitive` (a password or payment field), `secretPage` (a
  // credentials page). In an approved cross-origin frame (`frame: true`) also the tab's origin (`topOrigin`) and the
  // request's approved exact origins (`origins`): a link that leaves the frame or navigates the tab is checked against
  // them, and every dispatch first checks that this frame and its ancestors are still on approved origins.
  let pageContext = { purchase: false, sensitive: false, secretPage: false, frame: false, topOrigin: null, origins: [] };
  // Risk ({ cls, form?, consentReject? }) of each offered control in the last observation, by id.
  let targetRisks = new Map();
  // The consent dialog of the last observation (detectConsent), for a located control's consent kind.
  let lastConsent = null;
  // The control locate() resolved for a point click: { el, risk, control, id, x, y, revision }. A point click
  // dispatches only that element, on that revision, when the point still resolves to it; then it is spent.
  let located = null;

  class PageError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  // Readable frames of the current observation, keyed by their document: { index, el, doc, dx, dy, clip }.
  let frameByDoc = new Map();

  function intersectsViewport(rect) {
    const inTop = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
      && rect.top < innerHeight && rect.left < innerWidth;
    if (!inTop || !rect.clip) return inTop;
    const clip = rect.clip;
    return rect.bottom > clip.top && rect.top < clip.bottom && rect.right > clip.left && rect.left < clip.right;
  }

  // A rect in top-document viewport coordinates: a frame element's own rect shifted by its frame's content box, and
  // clipped (for viewport checks) by that box.
  function toTop(rect, frame) {
    if (!frame) return rect;
    const left = rect.left + frame.dx;
    const top = rect.top + frame.dy;
    return {
      x: left, y: top, left, top, right: left + rect.width, bottom: top + rect.height,
      width: rect.width, height: rect.height, clip: frame.clip,
    };
  }

  function boxOf(el) {
    return toTop(el.getBoundingClientRect(), frameByDoc.get(el.ownerDocument));
  }

  function styleOf(el) {
    return (el.ownerDocument?.defaultView ?? window).getComputedStyle(el);
  }

  function sameLeaseOrigin(frameEl) {
    try {
      return frameEl.contentWindow?.origin === window.origin && window.origin !== 'null';
    } catch {
      return false;
    }
  }

  // Same-origin iframes of the top document (not nested), rendered and within the element budget. A frame whose
  // document cannot be read is cross-origin; visible ones are counted for the cross_origin_frame warning and listed
  // as slots (crossOriginSlots) for the worker.
  function collectFrames() {
    const frames = new Map();
    const crossOrigin = [];
    for (const el of document.querySelectorAll('iframe,frame')) {
      if (frames.size >= MAX_FRAMES) break;
      const rect = el.getBoundingClientRect();
      if (!rendered(el, rect)) continue;
      let doc = null;
      try {
        doc = el.contentDocument;
      } catch {
        doc = null;
      }
      // The lease covers the top document's origin only: a frame is read when its document has that origin
      // (about:blank and srcdoc frames inherit it), never because a relaxed document.domain made it reachable.
      if (doc && !sameLeaseOrigin(el)) doc = null;
      if (!doc) {
        if (rect.width >= 2 && rect.height >= 2) crossOrigin.push(el);
        continue;
      }
      if (!doc.body || doc.getElementsByTagName('*').length > FRAME_ELEMENT_BUDGET) continue;
      const dx = rect.left + el.clientLeft;
      const dy = rect.top + el.clientTop;
      frames.set(doc, {
        index: frames.size + 1, el, doc, dx, dy,
        clip: { left: dx, top: dy, right: dx + el.clientWidth, bottom: dy + el.clientHeight },
      });
    }
    // Cross-origin frames inside the readable same-origin frames: listed as slots too (never read here).
    for (const frame of frames.values()) {
      for (const el of frame.doc.querySelectorAll('iframe,frame')) {
        if (crossOrigin.length >= MAX_SLOTS) break;
        if (sameLeaseOrigin(el) || !rendered(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width >= 2 && rect.height >= 2) crossOrigin.push(el);
      }
    }
    return { frames, crossOrigin };
  }

  // --- Approved cross-origin frames (docs/REFERENCE.md "Frames") ------------------------------------------------
  // This script never reads a cross-origin frame. It lists each one it sees as a slot for the worker: where the frame
  // sits (`path`, its position in window.frames from the top document down; a frame identifies itself by the same path,
  // framePath), its content box in top-viewport CSS px and the origin its element names (`declared`, the src
  // attribute: a hint for the warning, never trusted for access). The worker reads a frame only when the frame's own
  // origin, as its isolated content script reports it, is one the request approved, and runs this same script there.
  const MAX_SLOTS = 16;
  const MAX_FRAME_DEPTH = 4;

  // The index of a frame element's window among `view.frames`, or -1.
  function frameIndexIn(view, el) {
    try {
      const child = el.contentWindow;
      if (!child) return -1;
      for (let i = 0; i < Math.min(view.frames.length, 200); i++) if (view.frames[i] === child) return i;
    } catch {
      // A window that went away.
    }
    return -1;
  }

  // This document's path from the top window (the indexes in each ancestor's window.frames), or null past
  // MAX_FRAME_DEPTH or when a step cannot be found. [] in the top document. Cross-origin WindowProxy access allows
  // exactly this: parent, top, length and indexed frames.
  function framePath() {
    const path = [];
    let view = window;
    try {
      while (view !== view.top) {
        if (path.length >= MAX_FRAME_DEPTH) return null;
        const parent = view.parent;
        let index = -1;
        for (let i = 0; i < Math.min(parent.length, 200); i++) {
          if (parent[i] === view) {
            index = i;
            break;
          }
        }
        if (index < 0) return null;
        path.unshift(index);
        view = parent;
      }
    } catch {
      return null;
    }
    return path;
  }

  // The origin a frame element names (its src), or null for none, about:, data: or blob: frames.
  function declaredOrigin(el) {
    try {
      const url = new URL(el.getAttribute('src') || 'about:blank', el.baseURI);
      return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
    } catch {
      return null;
    }
  }

  // The frame elements the last crossOriginSlots call listed (redactionRects boxes every other unread one itself).
  let slotted = new WeakSet();

  // The cross-origin frame slots of this observation: [{ path, box: {x, y, width, height}, clip, declared }] in this
  // document's viewport (the worker shifts a nested frame's slots by its own box). `path` is relative to the top window:
  // this document's own path plus the frame's index (through a readable same-origin frame for one nested in it).
  function crossOriginSlots(elements) {
    slotted = new WeakSet();
    const own = framePath();
    if (!own) return [];
    const slots = [];
    for (const el of elements.slice(0, MAX_SLOTS)) {
      const doc = el.ownerDocument;
      const frame = frameByDoc.get(doc);
      let path = null;
      if (doc === document) {
        const index = frameIndexIn(window, el);
        if (index >= 0) path = [...own, index];
      } else if (frame) {
        const outer = frameIndexIn(window, frame.el);
        const index = frameIndexIn(doc.defaultView, el);
        if (outer >= 0 && index >= 0) path = [...own, outer, index];
      }
      if (!path || path.length > MAX_FRAME_DEPTH) continue;
      // The content box (inside border and padding): where the frame's own viewport starts, and its size, which the
      // worker matches against the frame's own innerWidth and innerHeight.
      const rect = toTop(el.getBoundingClientRect(), frame);
      const style = styleOf(el);
      const pad = side => parseFloat(style[`padding${side}`]) || 0;
      const left = rect.left + el.clientLeft + pad('Left');
      const top = rect.top + el.clientTop + pad('Top');
      const width = el.clientWidth - pad('Left') - pad('Right');
      const height = el.clientHeight - pad('Top') - pad('Bottom');
      let clip = { left, top, right: left + width, bottom: top + height };
      if (frame) {
        clip = { left: Math.max(clip.left, frame.clip.left), top: Math.max(clip.top, frame.clip.top),
          right: Math.min(clip.right, frame.clip.right), bottom: Math.min(clip.bottom, frame.clip.bottom) };
      }
      slots.push({ path, box: { x: left, y: top, width, height }, clip, declared: declaredOrigin(el) });
      slotted.add(el);
    }
    return slots;
  }

  // Facts of this document alone (never the context it was sent): what the worker unions across the tab's documents.
  function ownPageFacts(text) {
    return {
      purchase: purchasePage({ path: location.pathname, text, payment: pagePayment() }),
      sensitive: pageSensitiveOwn(),
      secretPage: secretMode().ownPage === true,
    };
  }

  // The worker's page context (see pageContext). Anything malformed is the empty context.
  function useContext(context) {
    const origins = Array.isArray(context?.origins)
      ? context.origins.filter(origin => typeof origin === 'string' && /^https?:\/\/[^/\s]+$/.test(origin)).slice(0, 20) : [];
    const topOrigin = typeof context?.topOrigin === 'string' && /^https?:\/\/[^/\s]+$/.test(context.topOrigin) ? context.topOrigin : null;
    const next = {
      purchase: context?.purchase === true, sensitive: context?.sensitive === true, secretPage: context?.secretPage === true,
      frame: context?.frame === true && window !== window.top, topOrigin, origins,
    };
    if (JSON.stringify(next) === JSON.stringify(pageContext)) return;
    pageContext = next;
    secretState = null;
    secretScanned = null;
  }

  // True when `origin` is on the approved site of an approved frame: one of the request's exact origins, or an https
  // origin on the default port under an approved domain root.
  function approvedOrigin(origin) {
    if (pageContext.origins.includes(origin)) return true;
    try {
      const url = new URL(origin);
      return url.protocol === 'https:' && !url.port
        && currentSites.some(root => url.hostname === root || url.hostname.endsWith(`.${root}`));
    } catch {
      return false;
    }
  }

  // In an approved cross-origin frame, before anything runs: this frame and every ancestor the browser names
  // (location.ancestorOrigins, Chromium) must still be on approved origins, else nothing runs (fail closed).
  function assertFrameApproved() {
    if (!pageContext.frame) return;
    if (window.origin === 'null' || !approvedOrigin(location.origin)) {
      throw new PageError('cross_origin', 'This frame is no longer on an approved origin');
    }
    const ancestors = location.ancestorOrigins;
    for (let i = 0; ancestors && i < ancestors.length; i++) {
      const origin = ancestors[i];
      // An ancestor the browser names only as 'null' (an opaque origin) is not an approved page either.
      if (origin === 'null' || (origin !== pageContext.topOrigin && !approvedOrigin(origin))) {
        throw new PageError('cross_origin', 'This frame is no longer inside approved pages');
      }
    }
  }

  // Frame controls are spliced in where their iframe sits among the top document's controls.
  function withFrames(list, selector) {
    for (const frame of frameByDoc.values()) {
      const inner = Array.from(frame.doc.querySelectorAll(selector));
      if (!inner.length) continue;
      let at = list.length;
      for (let i = 0; i < list.length; i++) {
        const el = list[i];
        if (el.ownerDocument === document && el.getRootNode() === document
          && (frame.el.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          at = i;
          break;
        }
      }
      list.splice(at, 0, ...inner);
    }
    return list;
  }

  // A custom dropdown container (role=listbox holding role=option items) is not a control itself: its options are.
  function optionContainer(el) {
    return el.tagName !== 'SELECT' && el.getAttribute('role') === 'listbox' && Boolean(el.querySelector('[role="option"]'));
  }

  // Options and menu items count inside a listbox/menu, or inside the popup an expanded trigger names with
  // aria-controls or aria-owns. Native <option> elements are reported through their <select>.
  function offeredOption(el) {
    if (el.tagName === 'OPTION') return false;
    const scope = el.getRootNode();
    // An explicit collapsed state overrides a popup's leftover rendered boxes (e.g. a closing animation).
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 6; node = node.parentElement, depth++) {
      if (node.getAttribute('aria-expanded') === 'false') return false;
      if (!node.id) continue;
      const id = CSS.escape(node.id);
      const triggers = scope.querySelectorAll(`[aria-expanded][aria-controls~="${id}"],[aria-expanded][aria-owns~="${id}"]`);
      if (triggers.length && !Array.from(triggers).some(trigger => trigger.getAttribute('aria-expanded') === 'true')) return false;
    }
    if (el.parentElement?.closest(OPTION_CONTAINER)) return true;
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 6; node = node.parentElement, depth++) {
      if (!node.id) continue;
      const id = CSS.escape(node.id);
      if (scope.querySelector(`[aria-expanded="true"][aria-controls~="${id}"],[aria-expanded="true"][aria-owns~="${id}"]`)) return true;
    }
    return false;
  }

  // The document's HTTP status from Navigation Timing (Chrome 109+), only while the URL is still the loaded one
  // (a same-document route change keeps the old entry). Null when unknown.
  function httpStatus() {
    try {
      const entry = performance.getEntriesByType('navigation')[0];
      const status = entry?.responseStatus;
      if (!Number.isInteger(status) || status <= 0) return null;
      if (entry.name && entry.name.split('#')[0] !== location.href.split('#')[0]) return null;
      return status;
    } catch {
      return null;
    }
  }

  // Rendered: has a box and is not hidden by display/visibility/content-visibility. Says nothing about the viewport.
  function rendered(el, rect = el.getBoundingClientRect()) {
    if (!(rect.width > 0 && rect.height > 0)) return false;
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
    const style = styleOf(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function visible(el) {
    const rect = boxOf(el);
    return intersectsViewport(rect) && rendered(el, rect);
  }

  // The parent across shadow boundaries: a shadow root's top-level element continues at its host.
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const parent = el.parentNode;
    return parent && parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? parent.host ?? null : null;
  }

  // Open shadow roots in pre-order (a nested root right after the root holding its host), within the budget.
  function collectShadowRoots() {
    const roots = [];
    let budget = SHADOW_SCAN_BUDGET;
    const scan = (elements, depth) => {
      for (let i = 0; i < elements.length; i++) {
        if (--budget < 0 || roots.length >= MAX_SHADOW_ROOTS) return;
        const root = elements[i].shadowRoot;
        if (root) {
          roots.push(root);
          if (depth < MAX_SHADOW_DEPTH) scan(root.querySelectorAll('*'), depth + 1);
        }
      }
    };
    if (document.body) scan(document.body.getElementsByTagName('*'), 1);
    return roots;
  }

  // Elements matching `selector` in the document and in the shadow roots, in document order: a root's matches
  // are spliced in right after its host (before the host's light-DOM children).
  function queryAll(selector, roots) {
    const lists = new Map([[document, Array.from(document.querySelectorAll(selector))]]);
    for (const root of roots) lists.set(root, Array.from(root.querySelectorAll(selector)));
    // Insertion points are searched in each tree's own matches only (compareDocumentPosition across shadow trees
    // is implementation-defined), so the search runs on an unspliced copy. Roots go in reverse pre-order, so a
    // nested root's matches are already in its parent root's list when that list is spliced, and whatever already
    // follows the preceding light-DOM match belongs to a later host: inserting right after that match keeps
    // document order.
    const own = new Map(Array.from(lists, ([key, list]) => [key, list.slice()]));
    for (let i = roots.length - 1; i >= 0; i--) {
      const root = roots[i];
      const inner = lists.get(root);
      const tree = root.host.getRootNode();
      const outer = lists.get(tree);
      const pristine = own.get(tree);
      if (!inner.length || !outer || !pristine) continue;
      let low = 0;
      let high = pristine.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (root.host.compareDocumentPosition(pristine[middle]) & Node.DOCUMENT_POSITION_FOLLOWING) high = middle;
        else low = middle + 1;
      }
      const at = low > 0 ? outer.indexOf(pristine[low - 1]) + 1 : 0;
      outer.splice(at, 0, ...inner);
    }
    return lists.get(document);
  }

  function normalizeTerms(terms) {
    if (!Array.isArray(terms)) return null;
    const out = [];
    for (const term of terms) {
      if (typeof term !== 'string') continue;
      const value = term.trim().toLowerCase().slice(0, 40);
      if (value.length >= 3 && !out.includes(value)) out.push(value);
      if (out.length >= MAX_TERMS) break;
    }
    return out;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit && EXPLICIT_ROLES.has(explicit)) return explicit;
    switch (el.tagName) {
      case 'A': return 'link';
      case 'BUTTON': return 'button';
      case 'SELECT': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'TEXTAREA': return 'textbox';
      case 'INPUT':
        if (el.type === 'checkbox') return 'checkbox';
        if (el.type === 'radio') return 'radio';
        if (['button', 'reset', 'image', 'submit'].includes(el.type)) return 'button';
        return 'textbox';
      default: return 'button';
    }
  }

  function cleanText(raw) {
    return String(raw ?? '').replace(/\s+/g, ' ').trim();
  }

  // The element an id names in the element's own tree (its shadow root, else its document).
  function byId(el, id) {
    const root = el.getRootNode?.();
    return (typeof root?.getElementById === 'function' ? root : el.ownerDocument).getElementById(id);
  }

  // The name of each element aria-labelledby points at: its aria-label, else its text, else an image's alt.
  function labelledByName(el) {
    const ids = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 5);
    return ids.map(id => {
      const ref = byId(el, id);
      if (!ref) return '';
      return cleanText(ref === el ? '' : ref.getAttribute('aria-label')) || cleanText(ref.textContent)
        || cleanText(ref.getAttribute('alt'));
    }).filter(Boolean).join(' ').slice(0, 300);
  }

  // A name from content for an element without text: the aria-label, image alt, SVG <title> or title attribute of
  // its descendants (an icon button whose only name sits on a nested icon or link), in document order.
  function contentName(el) {
    const parts = [];
    let budget = 200;
    const walk = (node, depth) => {
      for (const child of node.children ?? []) {
        if (--budget < 0 || parts.length >= 4) return;
        const tag = child.tagName.toLowerCase();
        const image = tag === 'img' || tag === 'area' || (tag === 'input' && child.type === 'image');
        const own = cleanText(child.getAttribute('aria-label'))
          || (image ? cleanText(child.getAttribute('alt')) : '')
          || (tag === 'svg' ? cleanText(child.querySelector(':scope > title')?.textContent) : '')
          || cleanText(child.getAttribute('title'));
        if (own) parts.push(own);
        else if (depth < 6) walk(child, depth + 1);
      }
    };
    walk(el, 0);
    return parts.join(' ');
  }

  const TOOLTIP_ATTRIBUTES = ['data-tooltip', 'data-tooltip-text', 'data-tip', 'data-title', 'data-original-title'];

  // The text of the elements aria-describedby names (a tooltip element), at most 80 characters, else ''.
  function describedByText(el) {
    const ids = String(el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean).slice(0, 3);
    const text = cleanText(ids.map(id => {
      const ref = byId(el, id);
      return ref && ref !== el ? cleanText(ref.getAttribute('aria-label')) || cleanText(ref.textContent) : '';
    }).filter(Boolean).join(' '));
    return text.length <= 80 ? text : '';
  }

  // The accessible name, in the order of the accessible-name computation: aria-labelledby, aria-label, the field's
  // <label> (for= or wrapping), a button input's value, an image input's alt, the text, names on descendant icons,
  // then title, placeholder, alt and a form field's name; for an element with none of these, a tooltip attribute or
  // its aria-describedby text. Empty only when none of these exist; observe() then gives the control a short
  // descriptor instead (describeUnnamed).
  function labelOf(el) {
    const tag = el.tagName;
    const field = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const sources = [
      () => labelledByName(el),
      () => el.getAttribute('aria-label'),
      () => (field ? el.labels?.[0]?.textContent : ''),
      () => (tag === 'INPUT' && ['button', 'reset', 'submit'].includes(el.type) ? el.value : ''),
      () => (tag === 'INPUT' && el.type === 'image' ? el.alt : ''),
      () => el.innerText,
      () => el.textContent,
      () => contentName(el),
      () => el.title,
      () => el.placeholder || el.getAttribute('aria-placeholder'),
      () => el.getAttribute('alt'),
      () => (field ? el.name : ''),
      // Last resorts for an icon button: its tooltip attribute, then the text its aria-describedby points at.
      () => TOOLTIP_ATTRIBUTES.map(name => el.getAttribute(name)).find(value => cleanText(value)),
      () => describedByText(el),
    ];
    for (const source of sources) {
      const name = cleanText(source());
      if (name) return name.slice(0, 180);
    }
    return '';
  }

  // What a control with no name is called: "unlabelled", its kind ("button", "date field"), its position among the
  // unnamed controls of that kind with the same context ("1 of 2") and the context: the name of the nearest container,
  // labelled field, legend or heading around it (the date field a stepper button belongs to), else the nearest heading
  // before it. The descriptor is written by this script, but its context is page text like any label.
  const FIELD_KIND = Object.freeze({
    date: 'date field', 'datetime-local': 'date field', month: 'month field', week: 'week field', time: 'time field',
    email: 'email field', tel: 'phone field', number: 'number field', search: 'search field', url: 'URL field',
  });
  const CONTEXT_SELECTOR = 'input:not([type="hidden"]),textarea,select,[role="textbox"],[role="combobox"],legend,label,'
    + 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"]';

  function kindOf(el, role) {
    if (el.tagName === 'INPUT' && Object.hasOwn(FIELD_KIND, el.type)) return FIELD_KIND[el.type];
    if (role === 'textbox') return 'text field';
    return role;
  }

  // Named fields, legends, labels and headings inside `node` (the first CONTEXT_NAMES of them within a walk of
  // CONTEXT_WALK elements), cached per node for one observe so controls that share ancestors share the walk.
  const CONTEXT_WALK = 400;
  const CONTEXT_NAMES = 30;
  function contextNames(node, cache) {
    if (cache.has(node)) return cache.get(node);
    const names = [];
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    let visited = 0;
    for (let near = walker.nextNode(); near && visited < CONTEXT_WALK && names.length < CONTEXT_NAMES; near = walker.nextNode()) {
      visited++;
      if (!near.matches(CONTEXT_SELECTOR)) continue;
      const text = /^(?:LEGEND|LABEL|H[1-6])$/.test(near.tagName) || near.getAttribute('role') === 'heading';
      const name = text ? cleanText(near.textContent) : labelOf(near);
      if (name) names.push({ near, name });
    }
    cache.set(node, names);
    return names;
  }

  // The first headings of a document with their text, once per observe.
  function headingsOf(doc, cache) {
    if (!cache.has(doc)) {
      cache.set(doc, Array.from(doc.querySelectorAll(HEADING_SELECTOR)).slice(0, 200)
        .map(heading => ({ heading, text: cleanText(heading.textContent) })));
    }
    return cache.get(doc);
  }

  function contextOf(el, cache) {
    const doc = el.ownerDocument;
    let node = parentOf(el);
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++, node = parentOf(node)) {
      if (node === doc.body || node === doc.documentElement) break;
      const own = cleanText(node.getAttribute('aria-label')) || labelledByName(node);
      if (own) return own;
      const found = contextNames(node, cache).find(({ near }) => near !== el && !el.contains(near) && !near.contains(el));
      if (found) return found.name;
    }
    let heading = '';
    for (const entry of headingsOf(doc, cache)) {
      if (!(entry.heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      heading = entry.text || heading;
    }
    return heading;
  }

  // Direction of an unnamed button (stepper or carousel arrows), from what is reliable: words among the tokens of its
  // own and its descendants' class, id, name, data-* and SVG <use> references ("chevron-left" -> chevron + left; never
  // whole class names), and its place in a pair of unnamed buttons left and right of one field or one short text. An
  // SVG path's shape is never read.
  const PREVIOUS_TOKENS = new Set(['prev', 'previous', 'back', 'backward', 'backwards', 'earlier']);
  const NEXT_TOKENS = new Set(['next', 'forward', 'forwards', 'fwd', 'later']);
  const DECREASE_TOKENS = new Set(['decrement', 'decrease', 'minus', 'subtract']);
  const INCREASE_TOKENS = new Set(['increment', 'increase', 'plus']);
  // left/right count only next to an icon-shape word in the same attribute ("float-right" says nothing).
  const SHAPE_TOKENS = new Set(['chevron', 'arrow', 'caret', 'angle', 'triangle', 'nav', 'navigate', 'navigation']);
  // Words of another function (a trash, clear, edit or calendar icon): such a button gets no direction, and a pair
  // with one gets no position claim either. A direction word on the same button wins ("date-nav-next").
  const OTHER_TOKENS = new Set(['trash', 'bin', 'delete', 'remove', 'erase', 'close', 'clear', 'cancel', 'dismiss',
    'edit', 'pencil', 'pen', 'calendar', 'search', 'menu', 'settings', 'share', 'copy', 'info', 'help', 'swap',
    'filter', 'sort', 'favorite', 'favourite', 'star', 'heart', 'like', 'cart', 'eye', 'visibility']);
  const TOKEN_ATTRIBUTES = ['class', 'id', 'name', 'href', 'xlink:href'];
  const FLANK_FIELD = 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"])'
    + ':not([type="image"]):not([type="checkbox"]):not([type="radio"]),textarea,select,[role="textbox"],'
    + '[role="combobox"],[role="spinbutton"]';

  function attributeTokens(value) {
    return String(value ?? '').slice(0, 200).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
      .split(/[^a-z0-9]+/).filter(Boolean);
  }

  // 'previous' | 'next' | 'decrease' | 'increase' from attribute tokens, 'other' (only words of another function), or
  // '' (none, or directions that disagree).
  function tokenDirection(el) {
    const found = new Set();
    let other = false;
    let budget = 30;
    const read = node => {
      const values = TOKEN_ATTRIBUTES.map(name => node.getAttribute(name)).filter(Boolean);
      for (const attribute of node.attributes) {
        if (attribute.name.startsWith('data-')) values.push(`${attribute.name.slice(5)} ${attribute.value}`);
      }
      for (const value of values) {
        const tokens = attributeTokens(value);
        const shaped = tokens.some(token => SHAPE_TOKENS.has(token));
        for (const token of tokens) {
          if (PREVIOUS_TOKENS.has(token) || (shaped && token === 'left')) found.add('previous');
          else if (NEXT_TOKENS.has(token) || (shaped && token === 'right')) found.add('next');
          else if (DECREASE_TOKENS.has(token)) found.add('decrease');
          else if (INCREASE_TOKENS.has(token)) found.add('increase');
          else if (OTHER_TOKENS.has(token)) other = true;
        }
      }
    };
    const walk = (node, depth) => {
      if (--budget < 0) return;
      read(node);
      if (depth < 3) for (const child of node.children) walk(child, depth + 1);
    };
    walk(el, 0);
    if (!found.size && other) return 'other';
    return found.size === 1 ? found.values().next().value : '';
  }

  function sameRow(a, b) {
    return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > Math.min(a.height, b.height) / 2;
  }

  // The field an unnamed button sits beside: within four ancestors, on the same row, nearest horizontally (a gap of
  // at most 48 px or twice the field's height), or null. `cache` holds each ancestor's first fields with their boxes
  // for one observe, so buttons that share ancestors share the query.
  function flankedField(el, rect, cache) {
    const doc = el.ownerDocument;
    let node = parentOf(el);
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++, node = parentOf(node)) {
      if (node === doc.body || node === doc.documentElement) return null;
      if (!cache.has(node)) {
        cache.set(node, Array.from(node.querySelectorAll(FLANK_FIELD)).slice(0, 20)
          .map(field => ({ field, box: boxOf(field) })));
      }
      let best = null;
      for (const { field, box } of cache.get(node)) {
        if (field.contains(el) || el.contains(field)) continue;
        if (!(box.width > 0 && box.height > 0) || !sameRow(rect, box)) continue;
        const gap = rect.x + rect.width <= box.x + 2 ? box.x - (rect.x + rect.width)
          : rect.x >= box.x + box.width - 2 ? rect.x - (box.x + box.width) : -1;
        if (gap < 0 || gap > Math.max(48, box.height * 2)) continue;
        if (!best || gap < best.gap) best = { field, box, gap };
      }
      if (best) return best;
    }
    return null;
  }

  // The short text (at most 60 characters, read from at most 40 text nodes) between two buttons inside one container
  // of up to three levels, or ''.
  function textBetween(first, second) {
    let node = parentOf(first);
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 3 && !node.contains(second)) {
      node = parentOf(node);
      depth++;
    }
    if (!node || node.nodeType !== 1 || depth >= 3) return '';
    const walker = first.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    walker.currentNode = first;
    let text = '';
    for (let count = 0, at = walker.nextNode(); at; at = walker.nextNode()) {
      if (first.contains(at)) continue;
      if (second.contains(at) || (second.compareDocumentPosition(at) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      if (++count > 40) return '';
      text += ` ${at.data}`;
      if (text.length > 400) return '';
    }
    text = cleanText(text);
    return text.length <= 60 ? text : '';
  }

  // Directions for the unnamed buttons among `items`: Map item -> { word, side, anchor }. Exactly two unnamed buttons
  // left and right of one field, or two adjacent ones on one row around a short text, are a previous/next pair
  // ("before"/"after" the field's name or that text); tokens give the word when they agree with the side, and alone
  // (side null) when there is no pair. A lone button beside a field (a calendar or clear icon) gets no direction.
  function unnamedDirections(items) {
    const buttons = items.filter(item => !item.label && item.rect && roleOf(item.el) === 'button');
    const out = new Map();
    if (!buttons.length) return out;
    const tokens = new Map(buttons.map(item => [item, tokenDirection(item.el)]));
    const pair = (first, second, anchor) => {
      const sides = [[first, 'before', ['previous', 'decrease']], [second, 'after', ['next', 'increase']]];
      if (sides.some(([item, , words]) => tokens.get(item) && !words.includes(tokens.get(item)))) return;
      for (const [item, side] of sides) {
        out.set(item, { word: tokens.get(item) || (side === 'before' ? 'previous-value' : 'next-value'), side, anchor });
      }
    };
    const byField = new Map();
    const fieldCache = new Map();
    for (const item of buttons) {
      const found = flankedField(item.el, item.rect, fieldCache);
      if (!found) continue;
      if (!byField.has(found.field)) byField.set(found.field, []);
      byField.get(found.field).push({ item, box: found.box });
    }
    for (const [field, members] of byField) {
      if (members.length !== 2) continue;
      const [a, b] = members[0].item.rect.x <= members[1].item.rect.x ? members : [members[1], members[0]];
      if (!(a.item.rect.x + a.item.rect.width <= a.box.x + 2 && b.item.rect.x >= b.box.x + b.box.width - 2)) continue;
      pair(a.item, b.item, labelOf(field));
    }
    for (let index = 0; index + 1 < buttons.length; index++) {
      const [a, b] = [buttons[index], buttons[index + 1]];
      if (out.has(a) || out.has(b) || !sameRow(a.rect, b.rect) || a.rect.x + a.rect.width > b.rect.x + 2) continue;
      if (b.rect.x - (a.rect.x + a.rect.width) > 400) continue;
      const text = textBetween(a.el, b.el);
      if (text) pair(a, b, text);
    }
    for (const item of buttons) {
      if (!out.has(item) && tokens.get(item) && tokens.get(item) !== 'other') out.set(item, { word: tokens.get(item), side: null, anchor: null });
    }
    return out;
  }

  // Calendar day cells whose name is their day number ("14", "14 €47"), in place: inside a month grid (an ancestor up
  // to three levels up whose cells of the same tag with a day number read exactly 1, 2, ... n in page order, n the
  // length of the month) under one month-and-year heading (the grid's aria-label or caption, or a heading up to four
  // levels up: "October 2026"), the label reads "Wednesday 14 October 2026 €47", so an instruction's "Wed 14 Oct" or
  // "Oct 14" matches it. A cell with its own aria-label keeps it. Whenever the page does not establish the month with
  // certainty (days of a neighbouring month in the grid, two month headings at the same level, a month name in another
  // language, a grid longer or shorter than its month) the cell keeps its number: a guessed date would be clicked
  // with confidence. The year is never taken from the clock.
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
    'November', 'December'];
  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_NUMBER = /^(\d{1,2})(?![\d.,:/])(?:\s+(.{1,40}))?$/;
  const MONTH_YEAR = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?\s+(\d{4})\b/gi;
  const MIN_MONTH_CELLS = 28;
  function nameCalendarDays(items) {
    const grids = new Map();
    const months = new Map();
    // The grid's day count when its numbered cells read 1..n in page order, else 0.
    const gridOf = el => {
      let node = parentOf(el);
      for (let depth = 0; node && node.nodeType === Node.ELEMENT_NODE && depth < 3; depth++, node = parentOf(node)) {
        const key = `${el.tagName}\u0000`;
        if (!grids.has(node)) grids.set(node, new Map());
        const counts = grids.get(node);
        if (!counts.has(key)) {
          const days = [...node.querySelectorAll(el.tagName)].map(cell => DAY_NUMBER.exec(cleanText(cell.textContent))?.[1]).filter(Boolean);
          counts.set(key, days.length >= MIN_MONTH_CELLS && days.every((day, index) => Number(day) === index + 1) ? days.length : 0);
        }
        if (counts.get(key)) return { node, length: counts.get(key) };
      }
      return null;
    };
    const monthOf = grid => {
      let node = grid;
      let bare = null;
      for (let depth = 0; node && node.nodeType === Node.ELEMENT_NODE && depth < 5; depth++, node = parentOf(node)) {
        const texts = [node.getAttribute('aria-label'),
          ...[...node.querySelectorAll('caption,h1,h2,h3,h4,h5,h6,[role="heading"]')].slice(0, 4).map(h => h.textContent)];
        const found = new Set();
        for (const text of texts) {
          for (const match of cleanText(text).matchAll(MONTH_YEAR)) {
            found.add(`${MONTH_NAMES.findIndex(name => name.slice(0, 3).toLowerCase() === match[1].slice(0, 3).toLowerCase())} ${match[2]}`);
          }
        }
        // The nearest level naming a month decides; two different months there (a row of headings over two grids)
        // leave the grid unnamed. A year-less heading ("October", Google Flights) found below still needs this level
        // to agree on the month; then the year is this level's.
        if (found.size) {
          if (found.size > 1) return null;
          const [index, year] = [...found][0].split(' ').map(Number);
          if (bare !== null && bare !== index) return null;
          return { index, year };
        }
        // A heading that is exactly one full English month name, with no year in any text at this level: the month,
        // without a year (never the clock's). Two such months at one level leave the grid unnamed.
        if (bare === null) {
          const names = new Set(texts.map(text => MONTH_NAMES.findIndex(name => name.toLowerCase() === cleanText(text).toLowerCase()))
            .filter(index => index >= 0));
          if (names.size > 1 || (names.size && texts.some(text => /\b\d{4}\b/.test(cleanText(text))))) return null;
          if (names.size) bare = [...names][0];
        }
      }
      return bare === null ? null : { index: bare, year: null };
    };
    // The weekday a grid's own header row gives the cell's column (a table head "Mon Tue ..."), else null.
    const WEEKDAY_HEAD = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]{0,6}\.?$/i;
    const weekdayOf = (grid, el) => {
      const cell = el.closest('td,th,[role="gridcell"]');
      const row = cell?.parentElement;
      const table = cell?.closest('table,[role="grid"]');
      if (!row || !table || !grid.contains(cell)) return null;
      const head = [...table.querySelectorAll('tr,[role="row"]')].find(candidate => {
        const heads = [...candidate.children].map(child => cleanText(child.textContent));
        return heads.length === 7 && heads.every(text => WEEKDAY_HEAD.test(text));
      });
      if (!head || head === row) return null;
      const text = cleanText(head.children[[...row.children].indexOf(cell)]?.textContent ?? '');
      const index = WEEKDAY_NAMES.findIndex(name => name.slice(0, 3).toLowerCase() === text.slice(0, 3).toLowerCase());
      return index >= 0 && new Set([...head.children].map(child => cleanText(child.textContent).slice(0, 3).toLowerCase())).size === 7
        ? WEEKDAY_NAMES[index] : null;
    };
    for (const item of items) {
      const match = DAY_NUMBER.exec(item.label ?? '');
      if (!match || !item.el || item.el.getAttribute('aria-label')) continue;
      const grid = gridOf(item.el);
      if (!grid) continue;
      if (!months.has(grid.node)) months.set(grid.node, monthOf(grid.node));
      const month = months.get(grid.node);
      const day = Number(match[1]);
      // The grid holds exactly the month's days.
      if (month && month.year === null) {
        // Year-less: the grid holds exactly the month's days (February 28 or 29); the weekday only from the header row.
        const lengths = month.index === 1 ? [28, 29] : [new Date(Date.UTC(2001, month.index + 1, 0)).getUTCDate()];
        if (!lengths.includes(grid.length) || day < 1 || day > grid.length) continue;
        const weekday = weekdayOf(grid.node, item.el);
        item.label = `${weekday ? `${weekday} ` : ''}${day} ${MONTH_NAMES[month.index]}${match[2] ? ` ${match[2]}` : ''}`;
        continue;
      }
      if (!month || grid.length !== new Date(Date.UTC(month.year, month.index + 1, 0)).getUTCDate()) continue;
      const date = new Date(Date.UTC(month.year, month.index, day));
      if (day < 1 || date.getUTCMonth() !== month.index) continue;
      item.label = `${WEEKDAY_NAMES[date.getUTCDay()]} ${day} ${MONTH_NAMES[month.index]} ${month.year}${match[2] ? ` ${match[2]}` : ''}`;
    }
  }

  // Gives every item of `items` ({ el, label }) without a label its descriptor, in place, and marks it `unnamed`.
  // Double quotes in the context are dropped, so the descriptor's own quotes stay unambiguous. A button with a
  // direction (unnamedDirections) says it first and ends in "(unlabelled)": `next-value button after "Departure"
  // (unlabelled)`; the others read `unlabelled button 1 of 2 next to "..."`.
  function describeUnnamed(items) {
    const groups = new Map();
    const cache = new Map();
    const directions = unnamedDirections(items);
    const unquote = text => cleanText(String(text ?? '').replace(/["\u201c\u201d]/g, ' ')).slice(0, 60);
    for (const item of items) {
      if (item.label) continue;
      const kind = kindOf(item.el, roleOf(item.el));
      const direction = directions.get(item);
      if (direction) {
        const anchor = unquote(direction.anchor) || unquote(contextOf(item.el, cache));
        const where = !anchor ? '' : direction.side && direction.anchor ? ` ${direction.side} "${anchor}"` : ` beside "${anchor}"`;
        const label = `${direction.word} ${kind}${where}`;
        const key = `\u0001${label}`;
        if (!groups.has(key)) groups.set(key, { label, members: [] });
        groups.get(key).members.push(item);
        continue;
      }
      const context = unquote(contextOf(item.el, cache));
      const key = `${kind}\u0000${context}`;
      if (!groups.has(key)) groups.set(key, { kind, context, members: [] });
      groups.get(key).members.push(item);
    }
    for (const { kind, context, label, members } of groups.values()) {
      members.forEach((item, index) => {
        const position = members.length > 1 ? ` ${index + 1} of ${members.length}` : '';
        item.label = label ? `${label}${position} (unlabelled)`
          : `unlabelled ${kind}${position}${context ? ` next to "${context}"` : ''}`;
        item.unnamed = true;
      });
    }
  }

  function severer(a, b) {
    if (!a) return b;
    if (!b) return a;
    return CLASS_ORDER.indexOf(a) <= CLASS_ORDER.indexOf(b) ? a : b;
  }

  // The most restrictive class a label names in either safety spelling, or null for an ordinary label.
  function labelClass(label) {
    let worst = null;
    for (const text of labelSpellings(label)) {
      if (PURCHASE.test(text)) worst = severer(worst, 'purchase');
      if (SIGN_IN_WORDS.test(text)) worst = severer(worst, 'sign_in');
      if (DELETE_WORDS.test(text)) worst = severer(worst, 'delete');
      // Cancelling a subscription, membership, account or order is a deletion; applying is a submission.
      if (COMMIT_OTHER.test(text)) worst = severer(worst, /\bcancel\b/.test(text) ? 'delete' : 'submit');
      if (SUBMIT_WORDS.test(text)) worst = severer(worst, 'submit');
    }
    return worst;
  }

  function forbidden(label) {
    return labelSpellings(label).some(text => Boolean(currentForbid && currentForbid.test(text)));
  }

  function permits(cls) {
    const need = CLASS_NEEDS[cls];
    return Boolean(need) && currentAllow.has(need);
  }

  // Remember the request's guardrail additions and the granted capabilities for this document. Anything but an
  // array leaves that part unchanged. A policy that cannot be compiled blocks everything (fail closed).
  function usePolicy({ forbid, allow, sites } = {}) {
    if (Array.isArray(allow)) currentAllow = new Set(allow.filter(item => KNOWN_CAPABILITIES.has(item)));
    if (Array.isArray(sites)) {
      currentSites = sites.filter(root => typeof root === 'string' && root.length <= 253
        && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(root)).slice(0, 10);
    }
    if (!Array.isArray(forbid)) return;
    const phrases = forbid.filter(item => typeof item === 'string' && item.length <= MAX_FORBID_LENGTH).slice(0, MAX_FORBID);
    currentForbid = { test: () => true };
    try {
      currentForbid = forbidPattern(phrases);
    } catch {
      currentAllow = new Set();
      throw new PageError('blocked_risky', 'Guardrail policy could not be compiled');
    }
  }

  // True for a destination on the approved site: this page's origin, or an https page on the default port under an
  // approved domain root that also covers this page (the worker re-checks every page it lands on).
  function onApprovedSite(url) {
    if (url.origin === location.origin) return true;
    const inRoot = (host, root) => host === root || host.endsWith(`.${root}`);
    return url.protocol === 'https:' && !url.port && location.protocol === 'https:' && !location.port
      && currentSites.some(root => inRoot(url.hostname, root) && inRoot(location.hostname, root));
  }

  // A link in an approved cross-origin frame: one that navigates the tab (_top, or _parent from a child of the top)
  // must stay on the tab's approved site, as a link in the top document must; one that navigates a frame must land on
  // an approved origin, so the frame stays readable.
  function frameLinkAllowed(url, frameTarget) {
    const tabWide = frameTarget === '_top' || (frameTarget === '_parent' && window.parent === window.top);
    if (!tabWide) return onApprovedSite(url) || approvedOrigin(url.origin);
    if (!pageContext.topOrigin) return false;
    if (url.origin === pageContext.topOrigin) return true;
    const top = new URL(pageContext.topOrigin);
    const inRoot = (host, root) => host === root || host.endsWith(`.${root}`);
    return url.protocol === 'https:' && !url.port && top.protocol === 'https:' && !top.port
      && currentSites.some(root => inRoot(url.hostname, root) && inRoot(top.hostname, root));
  }

  // A payment input: an autocomplete cc-* token, or a name, id, label or placeholder for a card number, expiry,
  // security code or IBAN (src/guardrails.js paymentField, applied to the element).
  function paymentField(el) {
    if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return false;
    if (['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'hidden', 'file'].includes(el.type)) return false;
    if (PAYMENT_AUTOCOMPLETE.test(String(el.getAttribute('autocomplete') || ''))) return true;
    const names = [el.name, el.id, el.getAttribute('aria-label'), el.labels?.[0]?.textContent, el.placeholder, el.title];
    return names.some(name => typeof name === 'string' && name
      && labelSpellings(name.slice(0, 200)).some(text => PAYMENT_FIELD.test(text)));
  }

  // Whether the page (the top document and its readable frames) has a password or payment field; computed once per
  // observation. A form submit on such a page is never a safe submit.
  let sensitivePage = null;
  // A password or payment field in another document of the tab (an approved frame, or the top seen from one) counts.
  function pageSensitive() {
    return pageSensitiveOwn() || pageContext.sensitive;
  }
  function pageSensitiveOwn() {
    if (sensitivePage === null) {
      sensitivePage = false;
      // Open shadow roots count too; a page too large to scan in full counts as sensitive (fail closed).
      const docs = [document, ...frameByDoc.keys(), ...collectShadowRoots()];
      let checked = 0;
      outer: for (const doc of docs) {
        for (const field of doc.querySelectorAll('input,select,textarea')) {
          if (++checked > 2000) {
            sensitivePage = true;
            break outer;
          }
          if ((field.tagName === 'INPUT' && field.type === 'password') || paymentField(field)) {
            sensitivePage = true;
            break outer;
          }
        }
      }
    }
    return sensitivePage;
  }

  // What submitting a form amounts to: signing in when it holds a password field, paying when it holds a payment
  // field, a safe submit for a SAFE_SUBMIT label (search, filter, sort, next, ...) on a page without password or
  // payment fields and a form without frames (an embedded payment or captcha widget cannot be read), else an
  // ordinary submission.
  function formClass(form, label) {
    let cls = null;
    const elements = Array.from(form.elements ?? []);
    if (elements.length > 500) return 'submit';
    for (const field of elements) {
      if (field.tagName === 'INPUT' && field.type === 'password') cls = severer(cls, 'sign_in');
      else if (paymentField(field)) cls = severer(cls, 'purchase');
    }
    if (cls) return cls;
    const safe = labelSpellings(label).some(text => SAFE_SUBMIT.test(text));
    if (!safe || pageSensitive() || form.querySelector('iframe,frame,object,embed')) return 'submit';
    return 'submit_safe';
  }

  // A single-line text field whose own names say it is a search box.
  const SEARCH_FIELD = /(?:^|[\s_.-])(?:q|query|search\w*|keywords?|find|filter)(?:$|[\s_.-])/i;
  const NOT_TEXT_INPUT = ['checkbox', 'radio', 'button', 'reset', 'image', 'submit', 'file', 'hidden', 'range', 'color'];

  // What pressing Enter in a filled text field amounts to (the host's submit_field action): its form's class
  // (formClass: sign_in or purchase with a password or payment field, submit_safe for a search field or a safe submit
  // button label, else submit), or outside any form submit_safe for a search field and submit otherwise. 'forbid' when
  // the request's additions forbid the field or its form's submit button; null for a field Enter does not submit.
  function enterClass(el) {
    if (el.tagName !== 'INPUT' || NOT_TEXT_INPUT.includes(el.type)) return null;
    if (el.type === 'password') return 'sign_in';
    if (paymentField(el)) return 'purchase';
    const names = [el.name, el.id, el.getAttribute('aria-label'), el.placeholder, el.labels?.[0]?.textContent]
      .filter(name => typeof name === 'string' && name).join(' ');
    const search = el.type === 'search' || el.getAttribute('role') === 'searchbox'
      || Boolean(el.closest('[role="search"],search')) || SEARCH_FIELD.test(` ${names.slice(0, 300)} `);
    const form = el.form;
    const submitter = form ? Array.from(form.elements ?? []).slice(0, 500)
      .find(field => (field.type === 'submit' || field.type === 'image') && !field.disabled) : null;
    const submitLabel = submitter ? labelOf(submitter) : '';
    if (forbidden(names) || (submitLabel && forbidden(submitLabel))) return 'forbid';
    if (!form) return search && !pageSensitive() ? 'submit_safe' : 'submit';
    // The submit button's own label classes count as they do for a click on it (a "Delete" button stays delete).
    const fromLabel = submitLabel ? labelClass(submitLabel) : null;
    const cls = formClass(form, search && !fromLabel ? 'Search' : submitLabel);
    return fromLabel ? severer(fromLabel, cls) : cls;
  }

  // The text of the elements aria-labelledby points at (an icon button named by a "Pay" span elsewhere).
  function labelledByText(el) {
    const ids = String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 5);
    return ids.map(id => el.ownerDocument.getElementById(id)?.textContent || '').join(' ').slice(0, 300);
  }

  // CSS generated text (::before / ::after `content`), which innerText and textContent do not include.
  function generatedText(el) {
    const view = el.ownerDocument.defaultView;
    if (!view) return '';
    const parts = [];
    for (const pseudo of ['::before', '::after']) {
      const content = view.getComputedStyle(el, pseudo).content;
      const quoted = /^["'](.*)["']$/s.exec(content || '');
      if (quoted) parts.push(quoted[1]);
    }
    return parts.join(' ').slice(0, 300);
  }

  // The risk class of one control: { cls, consentReject? }. `cls` is one of purchase | submit | delete |
  // sign_in | consent_accept | submit_safe | reversible | navigation, or 'forbid' for the request's additions.
  // `consentReject` marks a consent dialog's reject button, which is dispatched at every level.
  function riskOf(el, role, label, consentKind) {
    // A label the request's guardrail additions forbid is refused in every role, inside a consent dialog too.
    if (forbidden(label)) return { cls: 'forbid' };
    // Every independent name is evidence: an aria-label must not hide visible text or a title. The label itself
    // (a name from descendants, or a descriptor naming the context of an unnamed control) counts too.
    const names = [el.getAttribute('aria-label'), el.tagName === 'SELECT' ? label : el.labels?.[0]?.textContent,
      el.tagName === 'SELECT' ? '' : el.innerText, el.tagName === 'SELECT' ? '' : el.textContent,
      el.title, el.alt, el.tagName === 'INPUT' && ['button', 'reset', 'submit'].includes(el.type) ? el.value : '',
      labelledByText(el), generatedText(el), label];
    if (names.some(name => forbidden(name))) return { cls: 'forbid' };
    // A script link (role=link without a real <a href>) acts like a button: it needs `controls`, as in the runtime,
    // and its label classes apply, so a forged command cannot click a "Buy now" script link at a lower level.
    const scriptLink = role === 'link' && !(el.tagName === 'A' && el.hasAttribute('href'));
    // An <a href="#"> or javascript: link only runs a script: its label classes apply too (it stays navigation
    // when the label is ordinary, as the runtime treats it as a link).
    const rawHref = el.tagName === 'A' ? String(el.getAttribute('href') ?? '').trim() : '';
    const scriptHref = el.tagName === 'A' && (rawHref === '' || rawHref === '#' || /^javascript:/i.test(rawHref));
    let worst = null;
    if (scriptLink || (role === 'link' && scriptHref) || ['button', 'tab', 'option', 'textbox', 'combobox'].includes(role)
      || MENU_ITEM_ROLES.has(role)) {
      for (const name of names) worst = severer(worst, labelClass(name));
    }
    const fromLabels = worst;
    if (paymentField(el)) worst = severer(worst, 'purchase');
    if (el.tagName === 'INPUT' && el.type === 'password') worst = severer(worst, 'sign_in');
    if (worst) {
      // A button, option or menu item refused only for ambiguous label words (the intent tier, labelTier) is marked,
      // so a click the runtime cleared with Jev (action.intentCleared) may run: never a form submit, a payment or password
      // field, a consent dialog's control, a control with any name in the hard tier, or on a page with such fields.
      const ambiguous = worst === fromLabels && (worst === 'submit' || worst === 'purchase')
        && (role === 'button' || role === 'tab' || role === 'option' || MENU_ITEM_ROLES.has(role)) && !consentKind
        && !((el.type === 'submit' || el.type === 'image') && el.form)
        && names.every(name => !name || labelTier(name) !== 'hard') && !pageSensitive();
      return ambiguous ? { cls: worst, ambiguous: true } : { cls: worst };
    }
    if (consentKind) {
      // Inside a consent dialog: accepting needs consent_accept; rejecting is allowed even as a form submit or with a
      // destructive-looking label; other dialog buttons may submit but keep the label classes.
      if (consentKind === 'accept') return { cls: 'consent_accept' };
      if (role === 'link') return { cls: 'navigation' };
      if (consentKind !== 'reject' && (role === 'button' || role === 'tab')) {
        const cls = labelClass(label);
        if (cls) return { cls };
      }
      return { cls: 'reversible', consentReject: consentKind === 'reject' };
    }
    // A <button> defaults to type=submit even outside a form; only a control that can submit a form counts.
    if ((el.type === 'submit' || el.type === 'image') && el.form) return { cls: formClass(el.form, label) };
    // Defence in depth for frames, where a consent banner may not be recognised as a dialog: an accept-style button
    // inside a frame is a consent accept.
    if (el.ownerDocument !== document && (role === 'button' || role === 'tab') && consentKindOfControl(el, label) === 'accept') return { cls: 'consent_accept' };
    if (role === 'button' || role === 'tab' || role === 'option' || MENU_ITEM_ROLES.has(role)) {
      const cls = labelClass(label);
      if (cls) return { cls };
    }
    if (role === 'link') return { cls: scriptLink ? 'reversible' : 'navigation' };
    return { cls: 'reversible' };
  }

  // The `risk` reported to the runtime: the class itself, except that a safe submit reads 'submit' (the runtime
  // decides submit_safe from the label and the page's fields itself) and an addition's block reads 'destructive'.
  function wireRisk(risk) {
    if (risk.cls === 'forbid') return 'destructive';
    if (risk.cls === 'submit_safe') return 'submit';
    return risk.cls;
  }

  function dispatchable(risk) {
    // A consent reject and a nag overlay's close control (detectOverlay) are dispatched at every level.
    return Boolean(risk) && (permits(risk.cls)
      || ((risk.consentReject === true || risk.overlayDismiss === true) && risk.cls === 'reversible'));
  }

  // A click the runtime cleared with Jev (src/runtime.js intentVerdict) on a control this script marked ambiguous:
  // allowed with the capability the cleared class needs ('controls' for a selection or a view, 'submit' for a
  // submission), which the granted capabilities must hold. Never a point click, never any other action.
  function clearedClick(action, risk) {
    return action.type === 'click' && !action.point && risk?.ambiguous === true
      && (action.intentCleared === 'controls' || action.intentCleared === 'submit') && currentAllow.has(action.intentCleared);
  }

  // --- Approve gate (docs/REFERENCE.md "Approve gate") ---------------------------------------------------------
  // Page rules on top of the label classes, applied once the page text is read (applyGates): on a purchase page every
  // button or submit is a purchase (back-outs, quantity steppers and consent rejects aside), a committing button in a
  // dialog is a delete, and a credential action (or an eye toggle next to a password or secret field) is marked
  // `secret`. The worker's settings (useGates) say which classes ask the user; a gated control runs only with an
  // approval the worker minted when the user clicked Approve once (approvalHolds), rechecked here at dispatch.
  let gateSettings = { purchase: true, secret: true, level: true };
  // An eye toggle's whole name: show, hide, reveal, toggle or unmask (the password), visibility, or an eye icon.
  const EYE_TOGGLE = /^(?:(?:show|hide|reveal|toggle|unmask|view)(?:\s+(?:password|passcode|pin|key|token|secret|it))?|(?:toggle\s+)?(?:password\s+)?visibility|[👁️\s]+|eye)$/iu;

  function useGates(settings) {
    if (!settings || typeof settings !== 'object') return;
    gateSettings = { purchase: settings.purchase !== false, secret: settings.secret !== false, level: settings.level !== false };
  }

  // The gate class an approval names for a control: purchase, secret, delete or submit; null when none applies.
  function gateClass(risk) {
    if (!risk) return null;
    if (risk.cls === 'purchase') return 'purchase';
    if (risk.secret) return 'secret';
    return risk.cls === 'delete' || risk.cls === 'submit' ? risk.cls : null;
  }

  // Whether the page shows a payment field (top document, readable frames, open shadow roots); fail closed past 2000.
  function pagePayment() {
    let checked = 0;
    for (const doc of [document, ...frameByDoc.keys(), ...collectShadowRoots()]) {
      for (const field of doc.querySelectorAll('input,select,textarea')) {
        if (++checked > 2000 || paymentField(field)) return true;
      }
    }
    return false;
  }

  function gateNames(el, label) {
    return [label, el.getAttribute('aria-label'), el.title,
      el.tagName === 'INPUT' ? el.value : String(el.innerText ?? '').slice(0, 200), labelledByText(el)]
      .filter(name => typeof name === 'string' && name.trim());
  }

  // An eye toggle: a button whose whole name shows or hides (or whose class or id says eye or visibility), right next
  // to a password or secret field: the closest ancestor (three levels at most) that holds one holds at most three
  // controls, so a "Show" button elsewhere in a form is not one.
  function eyeToggle(el, names) {
    const tokens = attributeTokens(String(el.getAttribute('class') ?? '') + ' ' + String(el.id ?? ''));
    const looks = names.some(name => EYE_TOGGLE.test(cleanText(name))) || tokens.some(token => /^(?:eye|visibility|unmask)/.test(token));
    if (!looks) return false;
    for (let node = el.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
      const fields = Array.from(node.querySelectorAll('input,textarea'));
      const secret = fields.some(field => (field.tagName === 'INPUT' && field.type === 'password')
        || secretField(field, field.getAttribute('aria-label') ?? ''));
      if (secret) return node.querySelectorAll('input,textarea,select,button,a[href],[role="button"]').length <= 3;
    }
    return false;
  }

  // The checkout region of a purchase page: the control's form holds a payment field, or an ancestor (eight levels at
  // most) is named checkout, payment or billing (class, id or aria-label words).
  function checkoutRegion(el) {
    const form = el.form ?? el.closest('form');
    if (form && Array.from(form.querySelectorAll('input,select,textarea')).slice(0, 200).some(field => paymentField(field))) return true;
    for (let node = el.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
      const words = attributeTokens(`${node.getAttribute('class') ?? ''} ${node.id ?? ''} ${node.getAttribute('aria-label') ?? ''}`);
      if (words.some(word => word === 'checkout' || word === 'payment' || word === 'payments' || word === 'billing')) return true;
    }
    return false;
  }

  // Navigation and search forms keep their own class on a purchase page: a nav or search landmark, or a form with a
  // search field.
  function navigationRegion(el) {
    if (el.closest('nav,[role="navigation"],[role="search"],search')) return true;
    const form = el.form ?? el.closest('form');
    return Boolean(form?.querySelector('input[type="search"],[role="searchbox"],input[name="q"],input[name="query"],input[name="search"]'));
  }

  // The risk of one control under the page rules (see above); `risk` unchanged when no rule applies. `region` (an
  // object) receives the control's region on a purchase page: 'checkout' or 'navigation'.
  function gatedRisk(el, role, label, risk, consent, purchase, region = null) {
    if (!risk || ['forbid', 'sign_in', 'consent_accept'].includes(risk.cls) || consent || risk.overlayDismiss) return risk;
    const realLink = el.tagName === 'A' && el.hasAttribute('href') && !/^\s*(?:#|javascript:)/i.test(el.getAttribute('href') ?? '#');
    const button = role === 'button' || role === 'tab' || (role === 'link' && !realLink)
      || ((el.type === 'submit' || el.type === 'image') && Boolean(el.form));
    if (!button) return risk;
    const names = gateNames(el, label);
    const exempt = names.some(name => purchaseExempt(name));
    let next = risk;
    if (purchase && !exempt && next.cls !== 'purchase') {
      const navigation = navigationRegion(el);
      const checkout = !navigation && checkoutRegion(el);
      if (region) region.value = navigation ? 'navigation' : checkout ? 'checkout' : null;
      if (names.some(name => purchaseControl(name, { checkout, navigation }))) next = { cls: 'purchase', gate: 'purchase' };
    }
    if (!exempt && (role === 'button' || role === 'tab') && inDialog(el)) {
      const dialog = el.closest(DIALOG);
      if (dialog && COMMIT_DIALOG.test(cleanText(dialog.textContent ?? '').slice(0, 2000)) && severer(next.cls, 'delete') === 'delete') {
        next = { cls: 'delete', gate: 'delete' };
      }
    }
    if (names.some(name => secretAction(name)) || eyeToggle(el, names)) next = { ...next, secret: true };
    if (next !== risk && next.ambiguous) delete next.ambiguous;
    return next;
  }

  // Applies the page rules to every described control (observe, after the page text is read).
  function applyGates(controls, text) {
    // A purchase page in another document of the tab (an approved frame, or the top seen from one) counts here too.
    const purchase = purchasePage({ path: location.pathname, text, payment: pagePayment() }) || pageContext.purchase;
    for (const control of controls) {
      const el = targets.get(control.id);
      const risk = targetRisks.get(control.id);
      if (!el || !risk) continue;
      const region = {};
      const next = gatedRisk(el, control.role, control.label, risk, control.consent === true, purchase, region);
      if (region.value) control.region = region.value;
      if (next === risk) continue;
      targetRisks.set(control.id, next);
      control.risk = wireRisk(next);
      delete control.ambiguous;
      const gate = next.secret ? (next.cls === 'purchase' ? 'purchase' : 'secret') : next.gate;
      if (gate) control.gate = gate;
    }
    return purchase;
  }

  // The approval binding's label hash: SHA-256 of the label's UTF-8 bytes, hex, first 32 characters (128 bits). Plain
  // JavaScript (sha256Hex), never crypto.subtle: that exists only in secure contexts, and approvals work on plain http
  // pages too. Drift check against node:crypto in test/approve-gate-extension.test.js.
  async function labelDigest(label) {
    return sha256Hex(String(label ?? '')).slice(0, 32);
  }

  // SHA-256 (FIPS 180-4) of a string's UTF-8 bytes, as 64 hex characters.
  function sha256Hex(text) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
      0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6,
      0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3,
      0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
      0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
      0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814,
      0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const bytes = new TextEncoder().encode(text);
    const length = Math.ceil((bytes.length + 9) / 64) * 64;
    const data = new Uint8Array(length);
    data.set(bytes);
    data[bytes.length] = 0x80;
    const view = new DataView(data.buffer);
    view.setUint32(length - 8, Math.floor(bytes.length / 0x20000000));
    view.setUint32(length - 4, (bytes.length * 8) >>> 0);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < length; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      [a, b, c, d, e, f, g, h].forEach((value, i) => { H[i] = (H[i] + value) >>> 0; });
    }
    return H.map(value => value.toString(16).padStart(8, '0')).join('');
  }

  // The label digest of the approved target as the page reads it now (execute, before dispatch): { label, digest }.
  async function approvalDigest(approval) {
    if (!approval || typeof approval !== 'object' || typeof approval.target !== 'string') return null;
    const control = observe({ blocks: false }).controls.find(item => item.id === approval.target);
    if (!control) return null;
    const label = String(control.label ?? '');
    return { label, digest: await labelDigest(label) };
  }

  // Whether `approval` (from the worker, which minted it when the user clicked Approve once) covers this dispatch: a
  // click (or a secret fill) on the approved target, whose gate class and label are the ones the user saw (`seen`: the
  // label digest execute computed before dispatch, for the label it read). Never a sign-in or payment field, a
  // consent accept or a label the request forbids; a secret fill only into a field that takes secrets.
  function approvalHolds(approval, action, control, risk, el, seen) {
    if (!approval || typeof approval !== 'object' || action.point || action.target !== approval.target) return false;
    if (action.type === 'fill_secret') {
      if (approval.kind !== 'fill_secret' || approval.cls !== 'secret' || !secretTarget(el)) return false;
    } else if (action.type === 'upload') {
      // An upload: the user approved this file input, this file (name and size, checked by the worker) and the site.
      if (approval.kind !== 'upload' || approval.cls !== 'submit' || el.tagName !== 'INPUT' || el.type !== 'file') return false;
    } else if (action.type !== 'click' || approval.kind === 'fill_secret' || approval.kind === 'upload') {
      return false;
    } else {
      if (!risk || ['forbid', 'sign_in', 'consent_accept'].includes(risk.cls)) return false;
      if (paymentField(el) || (el.tagName === 'INPUT' && el.type === 'password')) return false;
      if (gateClass(risk) !== approval.cls) return false;
    }
    if (forbidden(control.label)) return false;
    return typeof approval.labelHash === 'string' && seen?.label === String(control.label ?? '') && seen.digest === approval.labelHash;
  }

  // What the approval window shows for one control on the expected revision: { revision, documentId, target, label,
  // labelHash, cls, total? } (`total`: the "Total ... $41.99" text on a purchase page, page text). Nothing runs.
  // `kind: 'fill_secret'`: the control must be a field that takes a secret (secretTarget); its class is then 'secret'.
  async function approvalInfo(target, expectedRevision, kind = null) {
    const observation = observe({ blocks: false });
    if (observation.revision !== expectedRevision) throw new PageError('stale', 'Stale observation: the page changed since the decision');
    const control = observation.controls.find(item => item.id === target);
    const el = targets.get(target);
    if (!control || !el?.isConnected) throw new PageError('target_unavailable', 'Target is unavailable');
    const fill = kind === 'fill_secret';
    if (fill && !secretTarget(el)) throw new PageError('blocked_risky', 'This field does not take a secret');
    const upload = kind === 'upload';
    if (upload && !(el.tagName === 'INPUT' && el.type === 'file')) throw new PageError('blocked_risky', 'This control does not take a file');
    const totalSource = String(observation.text ?? '').slice(0, 20_000);
    const total = fill || upload ? null : PURCHASE_TOTAL.exec(totalSource);
    // PURCHASE_TOTAL detects an amount using only its first digit after a currency prefix.
    // The approval card must display the rest of that amount too, e.g. $142.80 rather than $1.
    const totalText = total && total[0] + (totalSource.slice(total.index + total[0].length).match(/^\d*(?:[.,]\d+)*/)?.[0] ?? '');
    return {
      revision: observation.revision,
      documentId,
      target,
      label: control.label,
      labelHash: await labelDigest(String(control.label ?? '')),
      cls: fill ? 'secret' : upload ? 'submit' : gateClass(targetRisks.get(target)),
      origin: location.origin,
      ...(totalText ? { total: cleanText(totalText).slice(0, 120) } : {}),
    };
  }

  function blockedMessage(cls) {
    if (cls === 'purchase') return 'Purchases and payments require user action outside testing mode';
    if (cls === 'reversible' || cls === 'submit_safe' || cls === 'navigation') {
      return 'This control needs a higher permission level than the user granted';
    }
    return 'Submission or account change requires user action';
  }

  // The consent kind of a control from every independent name it has (aria-label, aria-labelledby text, visible text,
  // a button input's value, title, and the label observe() reports): any accepting name makes it an accept button, and
  // names that disagree make it 'other', so a hidden name can never turn a visible "Accept all" into a reject button
  // or hide it from the dialog.
  function consentKindOfControl(el, label = labelOf(el)) {
    const names = [el.getAttribute('aria-label'), labelledByName(el), el.innerText,
      el.tagName === 'INPUT' && ['button', 'reset', 'submit'].includes(el.type) ? el.value : '', el.title, label]
      .map(cleanText).filter(Boolean);
    const kinds = new Set(names.map(consentKindOf));
    if (kinds.has('accept')) return 'accept';
    return kinds.size === 1 ? [...kinds][0] : 'other';
  }

  function consentKindOf(label) {
    const text = label.toLowerCase();
    const accepting = CONSENT_ACCEPT.test(text) && !CONSENT_WITHOUT_ACCEPT.test(text);
    // "Accept all, including non-essential" or "Allow all and necessary" are acceptances, not rejections.
    const necessaryOnly = /^(?:accept|allow|agree(?: to)?)\s+(?:only\s+)?(?:strictly\s+)?(?:necessary|essential|required)(?:\s+cookies)?(?:\s+only)?[.!]?$/.test(text.trim())
      && /\bonly\b/.test(text);
    // "Reject and subscribe" (pay-or-consent walls) starts a subscription: never a reject button.
    const normalized = normalizeLabel(text);
    if (PURCHASE.test(normalized) || COMMIT_OTHER.test(normalized)) return accepting ? 'accept' : 'other';
    if (CONSENT_REJECT.test(text) && !/non[- ]?(essential|necessary)/.test(text)
      && (!accepting || necessaryOnly)) return 'reject';
    if (accepting) return 'accept';
    if (CONSENT_SETTINGS.test(text)) return 'settings';
    return 'other';
  }

  function shortText(el, max) {
    const raw = typeof el.innerText === 'string' ? el.innerText : el.textContent;
    return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  // The visible consent dialog, if any: { container, kinds: Map(button -> kind) }. Candidates are dialogs and
  // elements whose id or class names a cookie/consent tool (a bare "consent" name must also be fixed/sticky and
  // mention cookies, a privacy policy or tracking), outermost first; the first visible one holding an
  // accept button (and, for a generic dialog or a whole page, consent wording) wins. html/body never qualify by class (a "cookie-open" body class
  // is not a dialog), except as a whole-page consent wall.
  // A fixed or sticky element (or one inside such an ancestor) floats over the page the way a banner does; a
  // block in page flow does not.
  function overlaid(el) {
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 6; node = node.parentElement, depth++) {
      const position = styleOf(node).position;
      if (position === 'fixed' || position === 'sticky') return true;
    }
    return false;
  }

  function detectConsent(roots) {
    // `wholePage`: a consent wall fills the document, and its Reject all / Accept all buttons often sit below the
    // fold (consent.google.com at 900 px), so rendered buttons count wherever they are.
    const qualify = (container, requireWords, wholePage = false) => {
      const kinds = new Map();
      let decisive = 0;
      let accepts = 0;
      let count = 0;
      for (const button of container.querySelectorAll(CONSENT_BUTTON)) {
        if (wholePage ? !rendered(button) : !visible(button)) continue;
        if (++count > MAX_CONSENT_BUTTONS) return null;
        const kind = consentKindOfControl(button);
        const isLink = button.tagName === 'A' && !button.getAttribute('role');
        if (isLink && kind === 'other') continue;
        kinds.set(button, kind);
        if (kind !== 'other') decisive++;
        if (kind === 'accept') accepts++;
      }
      // A consent dialog always offers to accept; a container without an accept button (an admin page's
      // Approve/Reject form inside a "consent-requests" block, a review dialog) is not one, so its Reject
      // buttons never get the consent risk override.
      if (!decisive || !accepts) return null;
      if (requireWords && !requireWords.test(shortText(container, 2000))) return null;
      return { container, kinds };
    };
    let checked = 0;
    // Same-origin frames too: their buttons are offered like the page's, so an Accept all inside a frame must get
    // the consent risk override as well.
    const frameDocs = Array.from(frameByDoc.keys());
    for (const root of [document, ...roots, ...frameDocs]) {
      // Document order puts a wrapper before what it contains; a wrapper that does not qualify (invisible,
      // buttonless, too many buttons) leaves its descendants as candidates.
      for (const candidate of root.querySelectorAll(CONSENT_CONTAINER)) {
        const owner = candidate.ownerDocument;
        if (candidate === owner.body || candidate === owner.documentElement) continue;
        if (++checked > MAX_CONSENT_CANDIDATES) return null;
        const rect = boxOf(candidate);
        if (!intersectsViewport(rect) || !rendered(candidate, rect)) continue;
        // A banner fading out after a click (opacity 0 before display:none) is already dismissed.
        if (candidate.checkVisibility && !candidate.checkVisibility({ opacityProperty: true })) continue;
        const byName = !candidate.matches('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]');
        let found;
        if (!byName) found = qualify(candidate, CONSENT_WORDS);
        else if (CMP_NAME.test(`${candidate.id} ${candidate.getAttribute('class') || ''}`)) found = qualify(candidate, null);
        else if (overlaid(candidate)) found = qualify(candidate, COOKIE_WORDS);
        else continue;
        if (found) return found;
      }
    }
    const heading = document.querySelector('h1');
    // consent.google.com / consent.youtube.com and other consent.* hosts, or a "Before you continue" page.
    const consentHost = /^consent\./.test(location.hostname);
    if (consentHost || CONSENT_PAGE.test(document.title) || (heading && CONSENT_PAGE.test(heading.textContent))) {
      const found = document.body && qualify(document.body, consentHost ? null : CONSENT_WORDS, true);
      if (found) return found;
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Blocking overlays other than cookie dialogs (detectConsent keeps those). An overlay is found from any of: an open
  // dialog (role dialog/alertdialog, aria-modal, <dialog open>), a fixed or high z-index layer under the viewport centre
  // (hit-tested, so whatever sits on top counts whatever its markup), a separate full-viewport backdrop, main content
  // made inert or aria-hidden, or a fixed bottom sheet. It is classified from its own text and controls: a nag
  // (sign_in, newsletter, promo, app, permission) the runtime may dismiss, or an age gate, a task dialog (a form or a
  // confirmation the user opened) or an unknown dialog, which are never dismissed. The observation reports it as
  // `overlay` with its close controls (offered first, dispatched at every level like a consent reject), whether Escape
  // and a backdrop click are available, and marks the controls and blocks inside it `overlay: true` so decisions and
  // the digest prefer the main content. Top document and open shadow roots only.
  // ------------------------------------------------------------------------------------------------------------
  const OVERLAY_PROBES = [[0.5, 0.5], [0.5, 0.35], [0.5, 0.65], [0.3, 0.5], [0.7, 0.5], [0.5, 0.9]];
  const MAX_OVERLAY_DIALOGS = 20;
  const MAX_OVERLAY_CONTROLS = 40;
  const OVERLAY_TEXT = 200;
  const AGE_GATE = /\b(?:are you (?:over|at least|of legal)|(?:over|at least|older than) (?:1[89]|21)\b|(?:1[89]|21) ?\+|(?:1[89]|21) (?:years|or older)|legal (?:drinking |smoking )?age|date of birth|verify (?:your )?age|age verification|enter your (?:age|birth)|years old)/i;
  // A dialog about the user's own action, or one that holds a task: never a nag.
  const TASK_WORDS = /\b(?:are you sure|confirm|discard|unsaved|delete|remove|leave (?:this )?page|save changes|edit (?:your|the|this)|sort by|filters?|(?:select|choose|pick) (?:a |an |your |the )?(?:date|dates|room|seat|size|option|guests?|destination)|share (?:this|via)|report (?:this|a)|added to (?:your )?(?:cart|basket|bag|list|trip|wishlist)|your (?:cart|basket|bag))\b/i;
  const NAG_KINDS = [
    ['permission', /\b(?:(?:allow|enable|turn on|get) (?:push |browser |desktop )?notifications?|(?:use|share|access|detect) your (?:current |precise )?location|location (?:access|services|permission)|notifications? (?:about|for|on)|stay (?:up to date|in the loop) with notifications)\b/i],
    ['app', /\b(?:(?:get|download|open|use|install|try) (?:it |this |our |the )?(?:(?:free|mobile) )?app|(?:open|continue|view) in (?:the )?app|app store|google play|mobile app|better in the app|on the app)\b/i],
    ['newsletter', /\b(?:newsletter|subscribe|mailing list|e-?mail (?:updates|list|alerts|offers)|sign up for (?:our |e-?mail|emails|updates|news)|join our (?:list|community|newsletter)|(?:straight )?to your inbox)\b/i],
    ['sign_in', /\b(?:sign[ -]?in|log[ -]?in|sign[ -]?up|register|create (?:an |your |a free )?account|members?(?:hip)?(?: (?:prices?|deals?|rates?|only))?|loyalty|rewards?|genius|unlock (?:member|exclusive|secret|lower))\b/i],
    ['promo', /(?:\b\d{1,2} ?% off\b|\b(?:save|get) (?:up to )?\d{1,2} ?%|\b(?:discount|coupon|promo(?:tion)? code|limited[- ]time|special offer|exclusive (?:offer|deal)s?|free shipping|welcome offer|spin (?:the|to win)|don'?t miss (?:out)?)\b)/i],
  ];
  // A close control's name: an X glyph, close/dismiss, or a decline phrase. Anchored, so "Close and sign in" is not one
  // (and labelClass refuses it anyway).
  const CLOSE_START = /^(?:[×✕✖✗╳xX]|close\b|dismiss\b|hide\b|no,? thanks?\b|no thank you\b|not now\b|not interested\b|maybe later\b|remind me later\b|later\b|skip\b|continue without\b|continue as (?:a )?guest\b|continue (?:browsing|to (?:the )?(?:web|website|site|browser))\b|stay (?:on|in) (?:the )?(?:web|website|site|browser)\b|use (?:the )?(?:web|website|browser)\b|don'?t allow\b|i'?ll do it later\b|cancel$)/i;
  const CLOSE_ANYWHERE = /\b(?:close|dismiss)\b/i;
  // Words of the nag's own call to action: a control named with them is never a close control, wherever it says close.
  const NAG_ACTION = /\b(?:sign[ -]?(?:in|up)|log[ -]?in|register|join|subscribe|accept|agree|allow|enable|turn on|download|install|get (?:the )?app|open (?:in )?(?:the )?app|claim|redeem|unlock|shop|buy|continue to (?:sign|log|checkout|payment))\b/i;
  // A full-viewport layer this dim or plain is a backdrop: little text and no control of its own.
  const BACKDROP_MAX_TEXT = 30;

  // The overlay of the last observation (detectOverlay), for marks and for a dismissal the runtime asks for.
  let lastOverlay = null;

  function within(el, root) {
    for (let node = el; node; node = parentOf(node)) if (node === root) return true;
    return false;
  }

  function viewportArea() {
    return Math.max(1, innerWidth * innerHeight);
  }

  function coverage(rect) {
    const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    return (width * height) / viewportArea();
  }

  function zIndexOf(el) {
    const value = Number.parseInt(styleOf(el).zIndex, 10);
    return Number.isFinite(value) ? value : 0;
  }

  // The layer an element floats in: its outermost fixed ancestor below body (across shadow hosts), else an absolutely
  // positioned ancestor with a z-index that covers most of the viewport. Null for content in page flow.
  function floatingLayer(el) {
    let layer = null;
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 40; node = parentOf(node), depth++) {
      const doc = node.ownerDocument;
      if (node === doc.body || node === doc.documentElement) break;
      const position = styleOf(node).position;
      if (position === 'fixed') layer = node;
      else if (!layer && position === 'absolute' && zIndexOf(node) >= 10 && coverage(boxOf(node)) >= 0.5) layer = node;
    }
    return layer;
  }

  function hitAt(x, y) {
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  function overlayControls(root) {
    const list = [];
    const scan = scope => {
      for (const el of scope.querySelectorAll(CONTROL_SELECTOR)) {
        if (list.length >= MAX_OVERLAY_CONTROLS) return;
        if (el.type === 'hidden' || !rendered(el)) continue;
        list.push(el);
      }
      for (const el of scope.querySelectorAll('*')) if (el.shadowRoot) scan(el.shadowRoot);
    };
    scan(root);
    if (root.shadowRoot) scan(root.shadowRoot);
    return list;
  }

  // What an overlay is, from its text and controls: a nag kind, 'age_gate', 'task' or 'unknown'.
  function overlayKind(root, text, controls) {
    if (AGE_GATE.test(text)) return 'age_gate';
    let fields = 0;
    let rich = false;
    for (const el of controls) {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || ['combobox', 'grid'].includes(el.getAttribute('role') ?? '')) rich = true;
      if (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'hidden'].includes(el.type)) fields++;
    }
    if (root.querySelector('[role="grid"],[role="tablist"],table')) rich = true;
    if (rich || fields > 3 || controls.length > 25 || TASK_WORDS.test(text)) return 'task';
    for (const [kind, words] of NAG_KINDS) if (words.test(text)) return kind;
    return root.querySelector('[role="listbox"]') ? 'task' : 'unknown';
  }

  // The close controls of an overlay, best first: an X or close/dismiss name, an unnamed icon button in the panel's
  // top-right corner, then a decline phrase ("No thanks", "Not now", "Maybe later"). Never a control whose name has a
  // risk class (sign in, subscribe, buy, submit, delete) or accepts something.
  function overlayClosers(root, panel, controls) {
    const panelBox = boxOf(panel);
    const found = [];
    for (const el of controls) {
      const role = roleOf(el);
      if (role !== 'button' && role !== 'link') continue;
      if (role === 'link' && el.tagName === 'A') {
        const href = String(el.getAttribute('href') ?? '').trim();
        if (href && href !== '#' && !/^javascript:/i.test(href)) continue;
      }
      if (el.tagName === 'INPUT' && el.type === 'submit') continue;
      if (!visible(el)) continue;
      const label = labelOf(el);
      const names = [el.getAttribute('aria-label'), labelledByName(el), el.innerText, el.title, label]
        .map(cleanText).filter(Boolean);
      if (names.some(name => labelClass(name) || NAG_ACTION.test(name) && !CLOSE_START.test(name) || consentKindOf(name) === 'accept')) continue;
      let rank = -1;
      if (names.some(name => /^[×✕✖✗╳xX]$/.test(name) || /^(?:close|dismiss)\b/i.test(name))) rank = 0;
      else if (names.some(name => name.length <= 60 && CLOSE_ANYWHERE.test(name) && !NAG_ACTION.test(name))) rank = 0;
      else if (names.some(name => CLOSE_START.test(name) && name.length <= 60)) rank = 2;
      else if (!names.length || names.every(name => name.length <= 1)) {
        // An icon-only button (an SVG or image, or a single glyph) in the panel's top-right corner.
        const rect = boxOf(el);
        const corner = rect.width <= 64 && rect.height <= 64
          && rect.left >= panelBox.left + panelBox.width * 0.6 - 8 && rect.top <= panelBox.top + Math.max(80, panelBox.height * 0.25);
        if (corner) rank = 1;
      }
      if (rank >= 0) found.push({ el, rank, label });
    }
    found.sort((a, b) => a.rank - b.rank);
    return found.slice(0, 3);
  }

  // A separate backdrop element: a fixed or absolute layer over at least 90% of the viewport that does not contain the
  // panel, holds almost no text and no control, found under the points just inside the viewport's edges.
  function overlayBackdrop(panel) {
    const points = [[8, 8], [innerWidth - 8, 8], [8, innerHeight - 8], [innerWidth - 8, innerHeight - 8], [8, innerHeight / 2]];
    for (const [x, y] of points) {
      const hit = hitAt(x, y);
      if (!hit || within(panel, hit) || within(hit, panel)) continue;
      for (let node = hit, depth = 0; node && node.nodeType === 1 && depth < 4; node = parentOf(node), depth++) {
        if (node === document.body || node === document.documentElement || within(panel, node)) break;
        const position = styleOf(node).position;
        if ((position !== 'fixed' && position !== 'absolute') || coverage(boxOf(node)) < 0.9) continue;
        if (shortText(node, BACKDROP_MAX_TEXT + 1).length > BACKDROP_MAX_TEXT) break;
        if (node.querySelector(CONTROL_SELECTOR)) break;
        return { el: node, x, y };
      }
    }
    return null;
  }

  // Main content another overlay made inert or aria-hidden (a modal library's focus trap).
  function mainHidden(root) {
    const candidates = [...document.querySelectorAll('main,[role="main"]'), ...(document.body?.children ?? [])].slice(0, 40);
    return candidates.some(el => !within(root, el) && !within(el, root)
      && (el.inert || el.getAttribute('aria-hidden') === 'true') && coverage(el.getBoundingClientRect()) >= 0.3);
  }

  // The candidate overlay panels: open dialogs, and the floating layers under the probe points.
  // Whether a floating layer lies over the page rather than being it: page content outside it is underneath the point,
  // or it holds less than 60% of the page's text. An app shell fixed to the viewport is neither.
  function overlaysPage(layer, x, y) {
    const below = document.elementsFromPoint(x, y)
      .some(el => el !== document.body && el !== document.documentElement && !within(el, layer) && !within(layer, el));
    // Over page content at the point, or (a bottom sheet over the body's empty end) holding a minor share of the text.
    return below || layer.textContent.length < document.body.textContent.length * 0.6;
  }

  function overlayCandidates(roots) {
    const candidates = [];
    const add = (el, signal) => {
      const entry = candidates.find(item => item.el === el);
      if (entry) entry.signals.add(signal);
      else candidates.push({ el, signals: new Set([signal]) });
    };
    let dialogs = 0;
    for (const root of [document, ...roots]) {
      for (const el of root.querySelectorAll(DIALOG)) {
        if (++dialogs > MAX_OVERLAY_DIALOGS) break;
        const owner = el.ownerDocument;
        if (el === owner.body || el === owner.documentElement) continue;
        const rect = boxOf(el);
        if (!intersectsViewport(rect) || !rendered(el, rect)) continue;
        if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true })) continue;
        if (rect.width * rect.height < 0.02 * viewportArea()) continue;
        add(el, el.tagName === 'DIALOG' ? 'native_dialog' : el.getAttribute('aria-modal') === 'true' ? 'aria_modal' : 'dialog');
      }
    }
    for (const [fx, fy] of OVERLAY_PROBES) {
      const hit = hitAt(innerWidth * fx, innerHeight * fy);
      if (!hit) continue;
      const layer = floatingLayer(hit);
      if (!layer || !overlaysPage(layer, innerWidth * fx, innerHeight * fy)) continue;
      const rect = boxOf(layer);
      if (fy === 0.9) {
        // A bottom sheet: a fixed layer along the bottom edge, not a header, at least an eighth of the viewport.
        if (rect.top < innerHeight * 0.35 || coverage(rect) < 0.12) continue;
        add(layer, 'bottom_sheet');
      } else {
        // A header or toolbar along the top edge is page chrome, not an overlay.
        if (rect.top <= 0 && rect.height < innerHeight * 0.3) continue;
        add(layer, 'covers_centre');
      }
    }
    return candidates;
  }

  function detectOverlay(roots, consent) {
    lastOverlay = null;
    if (!document.body) return null;
    const candidates = overlayCandidates(roots);
    const consentRoot = consent?.container ?? null;
    let best = null;
    for (const candidate of candidates) {
      let panel = candidate.el;
      if (consentRoot && (within(panel, consentRoot) || within(consentRoot, panel))) continue;
      // The panel's floating layer holds its close button and backdrop; a dialog inside a layer is read from the layer.
      const layer = floatingLayer(panel);
      const root = layer && !(consentRoot && within(consentRoot, layer)) ? layer : panel;
      if (root === document.body) continue;
      // A menu, listbox or native popover is ordinary floating UI only when the candidate itself is that container.
      // Nested floating UI does not hide an outer nag/dialog, and a real dialog still goes through the rules below.
      const floatingSelector = '[role="menu"],[role="listbox"],[popover]';
      const semanticFloating = root.matches(floatingSelector) && visible(root) && floatingContainer(root);
      if (semanticFloating && !panel.matches(DIALOG) && !root.querySelector(DIALOG)) continue;
      const signals = new Set(candidate.signals);
      // A dialog under the probes: its layer was hit-tested as covering the centre too.
      for (const other of candidates) if (other !== candidate && (other.el === root || within(other.el, root))) for (const s of other.signals) signals.add(s);
      // The panel is the dialog itself when there is one inside the layer.
      if (root === layer && !panel.matches(DIALOG)) {
        const inner = root.querySelector(DIALOG);
        if (inner && rendered(inner)) panel = inner;
      }
      const backdrop = overlayBackdrop(panel);
      if (backdrop) signals.add('backdrop');
      if (mainHidden(root)) signals.add('inert_main');
      const modal = signals.has('aria_modal') || signals.has('covers_centre') || signals.has('backdrop') || signals.has('inert_main')
        || (signals.has('native_dialog') && panel.matches?.(':modal'));
      const text = shortText(root, 1500);
      const controls = overlayControls(root);
      // An empty layer (a backdrop on its own, a spinner veil) is not the overlay's panel.
      if (text.length <= BACKDROP_MAX_TEXT && !controls.length) continue;
      const kind = overlayKind(root, text, controls);
      const nag = kind !== 'task' && kind !== 'age_gate' && kind !== 'unknown';
      // A small non-modal dialog (a menu, a tooltip-like popup, a chat bubble) only counts as a nag sheet.
      if (!modal && !(nag && (signals.has('bottom_sheet') || coverage(boxOf(root)) >= 0.12))) continue;
      const closers = nag ? overlayClosers(root, panel, controls) : [];
      const entry = { root, panel, kind, nag, text, signals, closers, backdrop: nag ? backdrop : null, modal };
      // A modal overlay wins over a sheet; the first found otherwise (dialogs come first, in document order).
      if (!best || (modal && !best.modal)) best = entry;
      if (best.modal) break;
    }
    lastOverlay = best;
    return best;
  }

  // The overlay as the observation reports it: kind, text and the ids of its offered close controls.
  function overlayView(overlay, idOf) {
    if (!overlay) return null;
    const closers = [];
    for (const closer of overlay.closers) {
      const id = idOf.get(closer.el);
      if (id) closers.push({ id, label: closer.label || '×' });
    }
    const view = {
      kind: overlay.kind,
      nag: overlay.nag,
      text: overlay.text.slice(0, OVERLAY_TEXT),
      signals: [...overlay.signals],
      closers,
    };
    if (overlay.nag) {
      view.escape = true;
      view.backdrop = Boolean(overlay.backdrop);
    }
    return view;
  }

  function overlayCloser(el) {
    return Boolean(lastOverlay?.closers.some(closer => closer.el === el));
  }

  // Controls and blocks inside an overlay that is not a task dialog are marked `overlay: true`: the main content is
  // what the task is about. A task dialog's controls are the task.
  function inMarkedOverlay(el) {
    return Boolean(lastOverlay) && lastOverlay.kind !== 'task' && within(el, lastOverlay.root);
  }

  // The wire marks of one control: `overlay` inside a marked overlay, and `dismiss` for a nag's close control, whose
  // risk then takes the overlayDismiss override (dispatched at every level, as a consent reject is).
  function markOverlayControl(el, control, risk) {
    if (!lastOverlay) return;
    if (inMarkedOverlay(el)) control.overlay = true;
    if (lastOverlay.nag && overlayCloser(el) && (risk.cls === 'reversible' || risk.cls === 'navigation')) {
      control.dismiss = true;
      if (risk.cls === 'reversible') risk.overlayDismiss = true;
    }
  }

  // Ordinary floating UI is not a blocking overlay: its choices are the current task and must survive the control and
  // offer caps ahead of the page behind it. Semantic containers work wherever the portal was mounted, not only under
  // their trigger. Consent and nag overlays keep their existing, separate priority rules.
  const FLOATING_CONTAINER = `[role="menu"],[role="listbox"],[popover],${DIALOG}`;
  const MAX_FLOATING_CONTAINERS = 20;
  let floatingRoots = [];

  function expandedFloating(el) {
    const scope = el.getRootNode();
    for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 6; node = parentOf(node), depth++) {
      if (!node.id) continue;
      const id = CSS.escape(node.id);
      if (scope.querySelector(`[aria-expanded="true"][aria-controls~="${id}"],[aria-expanded="true"][aria-owns~="${id}"]`)) return true;
    }
    return false;
  }

  function floatingContainer(el) {
    if (el.matches(DIALOG)) return true;
    if (el.matches('[popover]')) {
      try {
        return el.matches(':popover-open');
      } catch {
        return false;
      }
    }
    if (expandedFloating(el)) return true;
    // Positioning alone does not say a menu is open. A validated overlay is the current task; static/offcanvas UI is not.
    return Boolean(lastOverlay && within(el, lastOverlay.root));
  }

  function detectFloating(roots, consent) {
    floatingRoots = [];
    for (const el of withFrames(queryAll(FLOATING_CONTAINER, roots), FLOATING_CONTAINER)) {
      if (floatingRoots.length >= MAX_FLOATING_CONTAINERS) break;
      if (!visible(el) || !floatingContainer(el)) continue;
      if (consent?.container && within(el, consent.container)) continue;
      // Nested menus/listboxes/popovers keep their own floating marks even inside a nag; the nag's dialog does not.
      if (lastOverlay && lastOverlay.kind !== 'task' && within(el, lastOverlay.root)
        && (el === lastOverlay.root || el.matches(DIALOG))) continue;
      floatingRoots.push(el);
    }
  }

  function inFloating(el) {
    return floatingRoots.some(root => within(el, root));
  }

  // A dismissal the runtime asks for (`dismiss_overlay` with method escape or backdrop) on the overlay of this very
  // observation, and only on a nag. Escape: a keydown/keyup for Escape at the focused element inside the overlay (else
  // its panel), and for a native <dialog> its cancel event and close(), as the browser does on Escape. Backdrop: a
  // pointer click at the point under which the separate backdrop element lies.
  async function dismissOverlay(method) {
    const overlay = lastOverlay;
    if (!overlay?.nag) throw new PageError('unsupported', 'No overlay this page script may dismiss');
    if (method === 'escape') {
      const active = document.activeElement;
      const target = active && active !== document.body && within(active, overlay.root) ? active : overlay.panel;
      let proceed;
      if (realInput()) {
        ({ proceeded: proceed } = await realInput().press(target, 'Escape'));
      } else {
        const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
        proceed = target.dispatchEvent(new KeyboardEvent('keydown', init));
        target.dispatchEvent(new KeyboardEvent('keyup', init));
      }
      const dialog = overlay.panel.tagName === 'DIALOG' ? overlay.panel : overlay.root.querySelector?.('dialog[open]');
      if (proceed && dialog?.open) {
        if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
      }
      return;
    }
    if (method === 'backdrop') {
      const backdrop = overlay.backdrop;
      if (!backdrop?.el.isConnected) throw new PageError('unsupported', 'The overlay has no separate backdrop');
      const hit = hitAt(backdrop.x, backdrop.y);
      if (!hit || !within(hit, backdrop.el)) throw new PageError('stale', 'The backdrop is no longer at that point');
      if (realInput()) {
        await realInput().click(backdrop.el, { point: { x: backdrop.x, y: backdrop.y } });
        return;
      }
      const init = { bubbles: true, cancelable: true, composed: true, clientX: backdrop.x, clientY: backdrop.y, button: 0, view: window };
      hit.dispatchEvent(new PointerEvent('pointerdown', init));
      hit.dispatchEvent(new MouseEvent('mousedown', init));
      hit.dispatchEvent(new PointerEvent('pointerup', init));
      hit.dispatchEvent(new MouseEvent('mouseup', init));
      hit.dispatchEvent(new MouseEvent('click', init));
      return;
    }
    throw new PageError('unsupported', 'Unsupported dismissal');
  }

  // ------------------------------------------------------------------------------------------------------------
  // Derived views: readable lines for content the text walk reads badly or not at all. A chart (SVG) becomes one
  // line of its labels and, when its values exist only as bar heights against numeric axis ticks, the values read
  // from that geometry ("≈€98"); a grid with row and column headers (or an ARIA grid) becomes one line per row that
  // keeps each value with its headers ("Oct 10 × Oct 17: €312"); a list row's fields are joined with " · ". Views
  // replace their source's raw text in `text` and blocks (within the same 8000-character and 200-block caps) and never
  // enter the semantic revision, which hashes the raw text: they are derived from the page, not new identity. Regions
  // the page holds only as pixels (a canvas, a chart without readable values, a chart-like image) or that a view had
  // to cut are listed in `unreadable` with the warning unreadable_region, so a later tier knows when to look.
  // Top document only (frames and shadow roots keep the plain walk).
  // ------------------------------------------------------------------------------------------------------------
  const GRID_SELECTOR = '[role="grid"],[role="table"],[role="treegrid"]';
  const ARIA_CELL_ROLES = new Set(['gridcell', 'cell', 'columnheader', 'rowheader']);
  const ROW_JOIN_HEAD = /^[–—\-:,;·|)/]/;
  const ROW_JOIN_TAIL = /[–—\-:,;·|(/]$/;
  const CHART_MIN_WIDTH = 160;
  const CHART_MIN_HEIGHT = 80;
  const MAX_CHARTS = 6;
  const MAX_CHART_ITEMS = 120;
  const CHART_TEXT = 900;
  const MAX_CHART_MARKS = 600;
  const MAX_GRIDS = 8;
  const MAX_GRID_ROWS = 400;
  const MAX_GRID_CELLS = 4000;
  const GRID_TEXT = 1500;
  const VIEW_TEXT = 2000;
  const MIN_VIEW_TEXT = 200;
  const MAX_UNREADABLE = 5;
  const UNREADABLE_MIN_AREA = 20000;
  const IMAGE_MIN_AREA = 30000;
  const CHART_WORDS = /\b(?:chart|graph|plot|diagram|map|histogram|trend|prices?|calendar|schedule|timeline|infographic|table)\b/i;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const NUMBER = /^([^\d\-−]*?)([\-−]?\d[\d,. ]*\d|\d)\s*([kKmM]?)(\D*)$/;

  function regionLabel(el) {
    const own = cleanText(el.getAttribute('aria-label')) || labelledByName(el)
      || cleanText(el.querySelector?.(':scope > title')?.textContent);
    if (own) return own.slice(0, 80);
    for (let node = el.parentElement, depth = 0; node && depth < 5 && node !== document.body; node = node.parentElement, depth++) {
      const label = cleanText(node.getAttribute('aria-label')) || labelledByName(node);
      if (label) return label.slice(0, 80);
      if (node.tagName === 'FIGURE') {
        const caption = cleanText(node.querySelector('figcaption')?.textContent);
        if (caption) return caption.slice(0, 80);
      }
    }
    return '';
  }

  function roundBox(rect) {
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  }

  // A tick label's number with its affixes ("€1,200" -> { value: 1200, prefix: '€', suffix: '' }), or null.
  function parseTick(text) {
    const match = NUMBER.exec(text.trim());
    if (!match || match[1].length > 4 || match[4].length > 6) return null;
    let digits = match[2].replace(/[\s,]/g, '').replace('−', '-');
    // "1.200" with a dot as the thousands separator.
    if (/^-?\d{1,3}(?:\.\d{3})+$/.test(digits)) digits = digits.replace(/\./g, '');
    const value = Number(digits) * ({ k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[match[3]] ?? 1);
    return Number.isFinite(value) ? { value, prefix: match[1], suffix: match[3] ? '' : match[4] } : null;
  }

  // What a chart mark is called: its aria-label or <title> (named: the chart's own reading), else a short data
  // attribute (an ISO date becomes "Oct 9"), else null.
  function markKey(el) {
    const named = cleanText(el.getAttribute('aria-label')) || cleanText(el.querySelector(':scope > title')?.textContent);
    if (named) return { key: named.slice(0, 60), named: true };
    for (const name of ['data-id', 'data-date', 'data-label', 'data-key', 'data-name', 'data-x', 'data-category']) {
      const value = cleanText(el.getAttribute(name));
      if (!value || value.length > 30) continue;
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      return { key: iso ? `${MONTHS[Number(iso[2]) - 1] ?? iso[2]} ${Number(iso[3])}` : value, named: false };
    }
    return null;
  }

  // Values of bar-like marks from their heights against numeric axis ticks: { values: [{ key, value, text }] }, or
  // { bail: reason } when the chart has a numeric axis and keyed bars but the geometry cannot be read honestly (ticks
  // not strictly monotonic or not linear, as on a log axis; bars that are stacked, repeat a key, do not share one
  // baseline, as with negative values, or reach outside the axis), or null when there is nothing to read.
  function chartGeometry(ticks, marks) {
    // Y-axis ticks: numeric labels stacked in one column (centres within 40 px), at least three of them.
    const numeric = ticks.map(tick => ({ ...tick, parsed: parseTick(tick.text) })).filter(tick => tick.parsed);
    if (numeric.length < 3) return null;
    // Columns: ticks whose centres lie within 40 px of the column's leftmost tick (right-aligned labels of different
    // widths stay in one column).
    const columns = [];
    for (const tick of numeric.slice().sort((a, b) => a.x - b.x)) {
      const column = columns.at(-1);
      if (column && tick.x - column[0].x <= 40) column.push(tick);
      else columns.push([tick]);
    }
    const axis = columns.sort((a, b) => b.length - a.length)[0];
    if (axis.length < 3) return null;
    // Bars: rendered keyed marks of bar width. Without at least three there is no geometry to read.
    const bars = marks.filter(mark => mark.rect.width >= 2 && mark.rect.width <= 120 && mark.rect.height >= 0.5
      && (!mark.el.checkVisibility || mark.el.checkVisibility({ opacityProperty: true, visibilityProperty: true })));
    if (bars.length < 3) return null;
    axis.sort((a, b) => a.y - b.y);
    const top = axis[0];
    const bottom = axis[axis.length - 1];
    const span = bottom.y - top.y;
    if (span < 20 || top.parsed.value === bottom.parsed.value) return { bail: 'axis' };
    const perPixel = (top.parsed.value - bottom.parsed.value) / span;
    const range = Math.abs(top.parsed.value - bottom.parsed.value);
    // Strictly monotonic and linear: every tick sits where a straight scale through the end ticks puts it (within 3%
    // of the range). A log or broken axis, ties and out-of-order labels fail this.
    const direction = Math.sign(top.parsed.value - bottom.parsed.value);
    for (let i = 1; i < axis.length; i++) {
      if (Math.sign(axis[i - 1].parsed.value - axis[i].parsed.value) !== direction || axis[i].y - axis[i - 1].y < 4) {
        return { bail: 'axis' };
      }
    }
    for (const tick of axis) {
      const expected = bottom.parsed.value + (bottom.y - tick.y) * perPixel;
      if (Math.abs(expected - tick.parsed.value) > range * 0.03) return { bail: 'axis' };
    }
    // One bar per key (a repeated key is a stacked or layered bar), all on one baseline (within 2 px: a bar hanging
    // below it is a negative value), tops within the axis span (5% margin).
    const keys = new Set();
    for (const bar of bars) {
      if (keys.has(bar.key)) return { bail: 'bars' };
      keys.add(bar.key);
    }
    const bottoms = new Map();
    for (const bar of bars) {
      const edge = Math.round(bar.rect.bottom / 2);
      bottoms.set(edge, (bottoms.get(edge) ?? 0) + 1);
    }
    const baseline = [...bottoms.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const margin = span * 0.05;
    for (const bar of bars) {
      if (Math.abs(Math.round(bar.rect.bottom / 2) - baseline) > 1) return { bail: 'bars' };
      if (bar.rect.top < top.y - margin || bar.rect.top > bottom.y + margin) return { bail: 'bars' };
    }
    const values = bars.map(bar => ({ key: bar.key, value: bottom.parsed.value + (bottom.y - bar.rect.top) * perPixel, x: bar.rect.left }));
    values.sort((a, b) => a.x - b.x);
    const step = range / (axis.length - 1);
    const digits = step >= 1 ? 0 : 2;
    return {
      values: values.map(entry => ({
        key: entry.key, value: entry.value, text: `≈${top.parsed.prefix}${entry.value.toFixed(digits)}${top.parsed.suffix}`,
      })),
    };
  }

  // `text` clipped to `max` characters at the last ", " so no entry is cut in half ("…" marks the cut).
  function clipList(text, max) {
    if (text.length <= max) return text;
    const cut = text.lastIndexOf(', ', max - 1);
    return `${text.slice(0, cut > max / 2 ? cut : max - 1)}…`;
  }

  // One chart: its label, the text it holds and, when it has them, values read from bar geometry.
  function chartView(svg) {
    const label = regionLabel(svg);
    const ticks = [];
    const items = [];
    for (const el of svg.querySelectorAll('desc')) {
      const text = cleanText(el.textContent);
      if (text) items.push(text.slice(0, 200));
    }
    for (const el of svg.querySelectorAll('text')) {
      if (el.parentElement?.closest('text')) continue;
      const text = cleanText(el.textContent);
      if (!text) continue;
      const box = el.getBoundingClientRect();
      ticks.push({ text, x: box.left + box.width / 2, y: box.top + box.height / 2 });
      if (items.length < MAX_CHART_ITEMS) items.push(text);
    }
    const marks = [];
    const named = [];
    let markCount = 0;
    for (const el of svg.querySelectorAll('rect,path,circle,polygon,ellipse,g[aria-label],g[data-id]')) {
      if (++markCount > MAX_CHART_MARKS) break;
      const key = markKey(el);
      if (!key) continue;
      if (key.named) named.push(key.key);
      else marks.push({ key: key.key, rect: el.getBoundingClientRect(), el });
    }
    // Named marks ("Mon 6: €121" in an aria-label or <title>) are the chart's own reading.
    const reading = named.length >= 3 ? null : chartGeometry(ticks, marks);
    const geometry = reading?.values ?? null;
    let body;
    let readable;
    if (geometry) {
      const low = geometry.reduce((a, b) => (b.value < a.value ? b : a));
      const high = geometry.reduce((a, b) => (b.value > a.value ? b : a));
      body = `${geometry.length} bars read from their heights, lowest ${low.key} ${low.text}, highest ${high.key} ${high.text}: `
        + geometry.map(entry => `${entry.key} ${entry.text}`).join(', ');
      readable = true;
    } else {
      const parts = [...new Set([...named, ...items])];
      body = parts.join(', ');
      // Values live in the marks when there are many marks and nothing names them, or when keyed bars against a
      // numeric axis could not be read honestly (reading.bail): the chart then keeps only its labels.
      readable = !reading?.bail && (named.length >= 3 || (parts.length >= 2 && markCount < 10));
    }
    const text = body ? clipList(`${label || 'Chart'}: ${body}`, CHART_TEXT) : '';
    const chartLike = Boolean(reading) || marks.length >= 3 || CHART_WORDS.test(label)
      || ticks.filter(tick => parseTick(tick.text)).length >= 3;
    return { label, text, readable, chartLike, bailed: Boolean(reading?.bail), marks: markCount };
  }

  function gridRows(grid) {
    if (grid.tagName === 'TABLE') return Array.from(grid.rows).filter(row => row.closest('table') === grid);
    return Array.from(grid.querySelectorAll('[role="row"]'))
      .filter(row => row.parentElement?.closest(`${GRID_SELECTOR},table`) === grid);
  }

  function gridCells(row) {
    if (row.tagName === 'TR') return Array.from(row.cells);
    return Array.from(row.querySelectorAll('[role="gridcell"],[role="cell"],[role="columnheader"],[role="rowheader"]'))
      .filter(cell => cell.parentElement?.closest('[role="row"]') === row);
  }

  function cellText(cell) {
    return (cleanText(cell.getAttribute('aria-label')) || cleanText(cell.textContent) || contentName(cell)).slice(0, 80);
  }

  function cellSpan(cell) {
    return Math.min(Number(cell.colSpan) || Number(cell.getAttribute('aria-colspan')) || 1, 20);
  }

  const isHeaderCell = cell => cell.tagName === 'TH' || /^(?:columnheader|rowheader)$/.test(cell.getAttribute('role') || '');
  const isRowHeader = cell => (cell.tagName === 'TH' && cell.getAttribute('scope') !== 'col') || cell.getAttribute('role') === 'rowheader';

  // One grid: per data row, the line that keeps each value with its headers, for a <table> with column and row
  // headers or an ARIA grid/table with column headers; null for a plain table (its rows keep the " | " form), and
  // { tooBig } past the row and cell budgets. The text keeps the rows that name an instruction term first, then rows in
  // document order, within GRID_TEXT characters; blocks get every row.
  function gridView(grid, terms) {
    const rows = gridRows(grid);
    if (rows.length > MAX_GRID_ROWS) return { tooBig: true };
    if (rows.length < 2) return null;
    let columns = null;
    const body = [];
    let cells = 0;
    let rowHeaders = 0;
    for (const row of rows) {
      const list = gridCells(row);
      cells += list.length;
      if (cells > MAX_GRID_CELLS) return { tooBig: true };
      if (!list.length) continue;
      if (!body.length && list.every(isHeaderCell)) {
        // The last all-header row before the data names the columns.
        columns = [];
        for (const cell of list) for (let i = 0, span = cellSpan(cell); i < span; i++) columns.push(cellText(cell));
        continue;
      }
      const header = list.find(isRowHeader) ?? null;
      if (header) rowHeaders++;
      body.push({ row, list, header });
    }
    const aria = grid.tagName !== 'TABLE';
    if (!columns || !body.length || (!aria && rowHeaders < Math.ceil(body.length / 2))) return null;
    const lines = [];
    for (const { row, list, header } of body) {
      const name = header ? cellText(header) : '';
      const parts = [];
      let index = 0;
      for (const cell of list) {
        const column = columns[index] ?? '';
        index += cellSpan(cell);
        if (cell === header) continue;
        const value = cellText(cell);
        if (!value) continue;
        if (name && column) parts.push(`${name} × ${column}: ${value}`);
        else if (column) parts.push(`${column}: ${value}`);
        else parts.push(name ? `${name}: ${value}` : value);
      }
      if (!parts.length) continue;
      const text = parts.join('; ');
      const lower = text.toLowerCase();
      lines.push({ row, text, match: terms.some(term => lower.includes(term)) });
    }
    if (!lines.length) return null;
    const label = regionLabel(grid) || cleanText(grid.querySelector(':scope > caption')?.textContent).slice(0, 80);
    // The text within `max` characters: { text, kept }.
    const render = max => {
      let budget = max - label.length - 2;
      const kept = new Set();
      for (const pass of [true, false]) {
        for (const line of lines) {
          if (line.match !== pass || line.text.length + 1 > budget) continue;
          kept.add(line);
          budget -= line.text.length + 1;
        }
      }
      const shown = lines.filter(line => kept.has(line));
      return { text: `${label || 'Table'}:\n${shown.map(line => line.text).join('\n')}`, kept: shown.length };
    };
    return { label, rowText: new Map(lines.map(line => [line.row, line.text])), rows: lines.length, render };
  }

  // The derived views of the top document: { roots: [{ el, kind, text, display, visible }] in document order (charts and keyed
  // grids, whose text replaces their raw text), rowText: Map(row element -> keyed line), unreadable: [{ kind, label?,
  // reason, bounds }] (largest first, at most MAX_UNREADABLE; only regions in the viewport, which a capture can show) }.
  function collectViews(terms) {
    const roots = [];
    const rowText = new Map();
    const unreadable = [];
    const flag = (kind, label, reason, rect) => {
      unreadable.push({ kind, ...(label ? { label: label.slice(0, 60) } : {}), reason, bounds: roundBox(rect),
        area: rect.width * rect.height });
    };
    if (!document.body) return { roots, rowText, unreadable };
    let charts = 0;
    for (const svg of document.body.getElementsByTagName('svg')) {
      if (charts >= MAX_CHARTS) break;
      // Cheap structural checks first: an icon (a path or two) is never a chart, and a page can hold hundreds of them.
      if (svg.getElementsByTagName('*').length < 4 || svg.parentElement?.closest('svg')) continue;
      const rect = svg.getBoundingClientRect();
      if (rect.width < CHART_MIN_WIDTH || rect.height < CHART_MIN_HEIGHT || !rendered(svg, rect)) continue;
      // An icon inside a control is the control's name, not a chart.
      if (svg.parentElement?.closest(CONTROL_SELECTOR)) continue;
      charts++;
      const view = chartView(svg);
      const visible = intersectsViewport(rect);
      if (view.text) roots.push({ el: svg, kind: 'chart', text: view.text, visible });
      // Only a chart-like SVG is flagged: keyed marks, a numeric axis or a chart word in its label. A decorative
      // illustration (many paths, no text) is not an unreadable region.
      if (visible && view.chartLike && !view.readable && (view.marks >= 10 || view.bailed || !view.text)
        && rect.width * rect.height >= UNREADABLE_MIN_AREA) {
        flag('chart', view.label, view.text ? 'values_in_geometry' : 'no_text', rect);
      }
    }
    for (const canvas of document.body.getElementsByTagName('canvas')) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width * rect.height < UNREADABLE_MIN_AREA || !intersectsViewport(rect) || !rendered(canvas, rect)) continue;
      if (cleanText(canvas.textContent).length >= 40) continue;
      flag('canvas', regionLabel(canvas), 'pixels_only', rect);
    }
    let images = 0;
    for (const img of document.images) {
      if (++images > 300) break;
      const rect = img.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area < IMAGE_MIN_AREA || !intersectsViewport(rect) || !rendered(img, rect)) continue;
      const alt = cleanText(img.alt || img.title);
      const caption = cleanText(img.closest('figure')?.querySelector('figcaption')?.textContent);
      if (!CHART_WORDS.test(`${alt} ${caption}`) && area < innerWidth * innerHeight * 0.25) continue;
      flag('image', alt || caption, alt ? 'alt_only' : 'no_text', rect);
    }
    let grids = 0;
    for (const grid of document.body.querySelectorAll(`table,${GRID_SELECTOR}`)) {
      if (grids >= MAX_GRIDS) break;
      if (grid.tagName === 'CANVAS' || grid.parentElement?.closest(`table,${GRID_SELECTOR}`)) continue;
      const rect = grid.getBoundingClientRect();
      if (!rendered(grid, rect)) continue;
      grids++;
      const view = gridView(grid, terms);
      if (!view) continue;
      if (view.tooBig) {
        if (intersectsViewport(rect)) flag('table', regionLabel(grid), 'too_large', rect);
        continue;
      }
      for (const [row, text] of view.rowText) rowText.set(row, text);
      roots.push({ el: grid, kind: 'grid', view, rect, visible: intersectsViewport(rect) });
    }
    roots.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    // The views in the viewport share VIEW_TEXT characters of the text, in document order, so they cannot crowd out
    // the rest of the page (Jev reads the first 6000). A view that no longer fits keeps its raw text (display null).
    let remaining = VIEW_TEXT;
    for (const root of roots) {
      if (root.kind === 'grid') {
        const max = Math.min(GRID_TEXT, remaining);
        const rendered = root.view.render(root.visible && max >= MIN_VIEW_TEXT ? max : GRID_TEXT);
        root.text = rendered.text;
        if (!root.visible) continue;
        if (max < MIN_VIEW_TEXT) {
          root.display = null;
          continue;
        }
        root.display = rendered.text;
        if (rendered.kept < root.view.rows) {
          flag('table', root.view.label, `rows_cut:${rendered.kept}/${root.view.rows}`, root.rect);
        }
      } else {
        if (!root.visible) continue;
        root.display = remaining >= MIN_VIEW_TEXT ? clipList(root.text, remaining) : null;
      }
      remaining -= root.display?.length ?? 0;
    }
    unreadable.sort((a, b) => b.area - a.area);
    return { roots, rowText, unreadable: unreadable.slice(0, MAX_UNREADABLE).map(({ area, ...rest }) => rest) };
  }

  // The row an element belongs to for grouping: the nearest list item, row or article, or an element repeated at least
  // three times among its siblings (same tag and class: a results list built from divs), within five levels; never
  // across a table row. Cached per element for one observation.
  function rowFinder() {
    const cache = new Map();
    const repeats = new Map();
    const signature = node => `${node.tagName}.${node.getAttribute('class') ?? ''}.${node.getAttribute('role') ?? ''}`;
    const repeated = node => {
      const parent = node.parentElement;
      if (!parent) return false;
      let counts = repeats.get(parent);
      if (!counts) {
        counts = new Map();
        let seen = 0;
        for (const child of parent.children) {
          if (++seen > 200) break;
          counts.set(signature(child), (counts.get(signature(child)) ?? 0) + 1);
        }
        repeats.set(parent, counts);
      }
      return (counts.get(signature(node)) ?? 0) >= 3;
    };
    // A panel is never a row, even when its siblings repeat its signature (the views of a single-page app, each a
    // <section class="panel"> with a heading and its own facts): a section-like element, or one with a heading child.
    const panel = node => /^(?:SECTION|MAIN|ASIDE|DIALOG|FIELDSET|DETAILS)$/.test(node.tagName)
      || /^(?:region|tabpanel|main|dialog|group|complementary)$/.test(node.getAttribute('role') ?? '')
      || Array.from(node.children).some(child => /^H[1-6]$/.test(child.tagName) || child.getAttribute('role') === 'heading');
    // A list item, article or listitem/article role wins over a repeated element below it (the fields of a row are
    // often repeated spans); a repeated element counts only with at least two element children (fields of its own)
    // and when it is not a panel.
    return el => {
      if (cache.has(el)) return cache.get(el);
      let found = null;
      let fallback = null;
      for (let node = el, depth = 0; node && node.nodeType === 1 && depth < 5; node = node.parentElement, depth++) {
        if (node === node.ownerDocument.body || /^(?:TR|TD|TH|TABLE|UL|OL|NAV|HEADER|FOOTER|FORM)$/.test(node.tagName)) break;
        const role = node.getAttribute('role');
        if (role === 'row' || role === 'navigation' || role === 'dialog') break;
        if (node.tagName === 'LI' || node.tagName === 'ARTICLE' || role === 'listitem' || role === 'article') {
          found = node;
          break;
        }
        if (!fallback && node.childElementCount >= 2 && node.getAttribute('class') && repeated(node) && !panel(node)) {
          fallback = node;
        }
      }
      found ??= fallback;
      cache.set(el, found);
      return found;
    };
  }

  // Which block the text directly inside an element belongs to. A decision is { block, t, kind, nav, cell? }:
  // `block` is the element the text is grouped under, `kind` is 'own' (the subtree is one block), 'text' (a
  // text container) or 'generic' (a div-like element holding text), `nav` marks a navigation landmark and
  // `cell` the table cell inside a 'tr' block. SKIP means the text is not turned into a block.
  function decideBlock(el, up) {
    if (up === undefined) {
      // The top document's body, or a same-origin frame's body.
      return el === el.ownerDocument?.body ? { block: el, t: 'p', kind: 'generic', nav: false } : SKIP;
    }
    if (up === SKIP) return SKIP;
    const tag = el.tagName.toUpperCase();
    if (BLOCK_SKIP_TAGS.has(tag) || el.getAttribute('aria-hidden') === 'true') return SKIP;
    const role = el.getAttribute('role');
    if (up.kind === 'own') {
      return up.t === 'tr' && (tag === 'TD' || tag === 'TH' || ARIA_CELL_ROLES.has(role)) ? { ...up, cell: el } : up;
    }
    const nav = up.nav || tag === 'NAV' || role === 'navigation';
    if (role === 'alert' || el.getAttribute('aria-live') === 'assertive') {
      return { block: el, t: 'alert', kind: 'own', nav };
    }
    if (OWN_BLOCK_TYPES[tag]) return { block: el, t: OWN_BLOCK_TYPES[tag], kind: 'own', nav };
    // An ARIA grid or table row is a row block like <tr>, its cells joined with " | ".
    if (role === 'row' && el.parentElement?.closest(GRID_SELECTOR)) return { block: el, t: 'tr', kind: 'own', nav };
    const button = tag === 'BUTTON' || role === 'button';
    if (button || role === 'link' || (tag === 'A' && el.hasAttribute('href'))) {
      // A link inside a paragraph or list item stays part of that text, except in navigation, where every
      // link is its own block. Elsewhere links and buttons are blocks of their own.
      if (nav || up.kind === 'generic') return { block: el, t: button ? 'button' : 'a', kind: 'own', nav };
      return up;
    }
    if (TEXT_BLOCK_TYPES[tag]) return { block: el, t: TEXT_BLOCK_TYPES[tag], kind: 'text', nav };
    if (INLINE_TAGS.has(tag) || up.kind === 'text') return nav === up.nav ? up : { ...up, nav };
    return { block: el, t: 'p', kind: 'generic', nav };
  }

  // Memoized per observation: each element is decided once, top-down from its nearest decided ancestor.
  function blockResolver() {
    const decided = new Map();
    return start => {
      const chain = [];
      let el = start;
      while (el && !decided.has(el)) {
        chain.push(el);
        if (el === el.ownerDocument?.body) break;
        el = parentOf(el);
      }
      let decision = el && decided.has(el) ? decided.get(el) : undefined;
      for (let i = chain.length - 1; i >= 0; i--) {
        decision = decideBlock(chain[i], decision);
        decided.set(chain[i], decision);
      }
      return decision ?? SKIP;
    };
  }

  // Appends one text node to its block. Table cells are joined with " | ". In a list item, text in different
  // laid-out boxes (a results row's time, airline and price: spans styled as blocks or flex items) is joined with
  // " · ", so a row reads as its fields instead of "10:45 AMeasyJet". Otherwise a space is kept where the source had
  // whitespace or a <br>, and between sibling containers (<div>A</div><div>B</div>), but not around inline markup
  // inside a word ("foo<b>bar</b>"). `blockBox` (the walk's cached nearest block-level box of an element) tells two
  // laid-out boxes apart.
  function appendToBlock(entry, decision, node, parent, content, blockBox) {
    if (entry.text.length >= MAX_BLOCK_TEXT) return;
    const raw = node.nodeValue;
    const previous = entry.parent;
    let separator = '';
    if (entry.text) {
      // Read lazily: the box lookup costs a style read, needed only for a list row or between two inline elements.
      const boxes = () => Boolean(blockBox) && parent !== previous && blockBox(parent) !== blockBox(previous);
      if (entry.t === 'tr' && decision.cell !== entry.cell) {
        separator = ' | ';
      } else if (entry.t === 'li' && !ROW_JOIN_HEAD.test(content) && !ROW_JOIN_TAIL.test(entry.text) && boxes()) {
        separator = ' · ';
      } else if (entry.trailingSpace || /^\s/.test(raw) || node.previousSibling?.nodeName === 'BR'
        || (parent !== previous && !previous.contains(parent) && !parent.contains(previous)
          && !(INLINE_TAGS.has(parent.tagName) && INLINE_TAGS.has(previous.tagName) && !boxes()))) {
        separator = ' ';
      }
    }
    entry.text += separator + content;
    // The elements that own the block's text (a few at most): a visible bar's text may all come from a hidden span.
    if (!entry.owners) entry.owners = [parent];
    else if (entry.owners.length <= MAX_TEXT_OWNERS && !entry.owners.includes(parent)) entry.owners.push(parent);
    entry.cell = decision.cell ?? null;
    entry.parent = parent;
    entry.trailingSpace = /\s$/.test(raw);
  }

  function selectLabel(select) {
    const raw = select.getAttribute('aria-label') || select.labels?.[0]?.textContent || select.title || select.name || '';
    return raw.replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function selectBlock(select) {
    const options = [];
    for (const option of select.options) {
      const label = option.label.replace(/\s+/g, ' ').trim();
      if (label) options.push(label);
      if (options.length >= MAX_SELECT_OPTIONS) break;
    }
    if (!options.length) return null;
    const label = selectLabel(select);
    return { el: select, t: 'select', text: ((label ? label + ': ' : '') + options.join(' | ')).slice(0, MAX_SELECT_TEXT) };
  }

  // One walk over the body's text nodes, then over each open shadow root's. It yields the visible-region text
  // (text nodes whose box intersects the viewport, in walk order; title and URL are reported separately and never
  // included) and, unless `withBlocks` is false, the blocks of the whole body, each marked visible when any of
  // its text is on screen. Shadow text joins its host's block when the host is inside one, else new blocks
  // follow the light-DOM ones.
  //
  // Two texts come out of the walk. `stableText` is the raw visible text the semantic revision hashes (live regions
  // left out), exactly as before derived views existed. `text`, the visible text sent on, is the same walk with the
  // derived views (collectViews) applied: a chart or keyed grid in the viewport is replaced by its view lines where it
  // sits, cells of one table row are joined with " | " and the fields of one list row with " · ". Both are capped at
  // MAX_TEXT on their own.
  function readPage(withBlocks, shadowRoots = [], frames = [], views = null, recordOf = null) {
    const parts = [];
    const stableParts = [];
    let length = 0;
    let rawLength = 0;
    let rawFull = false;
    let displayFull = false;
    let truncated = false;
    let previousParent = null;
    let displayParent = null;
    const pending = views?.roots ?? [];
    let next = 0;
    let active = null;
    const rowOf = rowFinder();
    const hidden = new Map();
    const blockish = new Map();
    const blocks = new Map(); // block element -> { el, t, text, visible, ... }, in document order
    const resolve = withBlocks ? blockResolver() : null;
    let visibleBlocks = 0;
    const isHidden = el => {
      if (!hidden.has(el)) {
        const value = SKIP_TEXT_TAGS.has(el.tagName.toUpperCase())
          || (el.checkVisibility ? !el.checkVisibility({ visibilityProperty: true }) : !el.getClientRects().length);
        hidden.set(el, value);
      }
      return hidden.get(el);
    };
    const isBlock = el => {
      if (!blockish.has(el)) blockish.set(el, !styleOf(el).display.startsWith('inline'));
      return blockish.get(el);
    };
    // The nearest element with a block-level (non-inline) display: an element itself when it is one.
    const boxes = new Map();
    const blockBox = el => {
      if (!boxes.has(el)) {
        let box = el;
        for (let depth = 0; depth < 8 && !isBlock(box); depth++) {
          const up = parentOf(box);
          if (!up) break;
          box = up;
        }
        boxes.set(el, box);
      }
      return boxes.get(el);
    };
    const selects = new Set();
    const pushDisplay = piece => {
      if (displayFull) return;
      if (length + piece.length > MAX_TEXT) {
        parts.push(piece.slice(0, MAX_TEXT - length));
        length = MAX_TEXT;
        displayFull = true;
        return;
      }
      parts.push(piece);
      length += piece.length;
    };
    // A view root reached by the walk (its first text node, or the first node after it): its lines go into the text
    // when it is in the viewport, and a chart becomes a block where it sits. Raw text inside it stays out of `text`.
    const flush = node => {
      while (next < pending.length && (node === null
        || pending[next].el.compareDocumentPosition(node) & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY))) {
        const view = pending[next++];
        // A view without display text (over the shared budget, or off screen) leaves its raw text in place.
        if (view.visible && view.display) {
          active = view.el;
          pushDisplay((parts.length ? '\n' : '') + view.display);
          if (displayFull) truncated = true;
          displayParent = view.el;
        } else if (!view.visible) {
          active = view.el;
        }
        if (withBlocks && view.kind === 'chart') {
          blocks.set(view.el, { el: view.el, t: 'chart', text: clipList(view.text, MAX_BLOCK_TEXT), visible: view.visible });
          if (view.visible) visibleBlocks++;
        }
      }
    };
    // Returns true when the walk is complete (no root after this one needs walking).
    // `frame` is the same-origin frame the root belongs to (its rects are shifted into the top viewport), or null.
    const walk = (root, frame = null) => {
      const doc = frame ? frame.doc : document;
      const range = doc.createRange();
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const light = root === document.body;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const content = node.nodeValue.replace(/\s+/g, ' ').trim();
        const parent = node.parentElement;
        if (!content || !parent) continue;
        if (light && next < pending.length) flush(node);
        const derived = light && active !== null && active.contains(node);
        if (withBlocks && parent.tagName === 'OPTION') {
          // The first option text places the select's block; option text itself is never a block.
          const select = parent.closest('select');
          if (select && !selects.has(select)) {
            selects.add(select);
            const rect = toTop(select.getBoundingClientRect(), frame);
            const entry = rendered(select, rect) ? selectBlock(select) : null;
            if (entry) {
              entry.visible = intersectsViewport(rect);
              if (entry.visible) visibleBlocks++;
              blocks.set(select, entry);
            }
          }
        }
        if (isHidden(parent)) continue;
        let entry = null;
        if (withBlocks) {
          const decision = resolve(parent);
          if (decision !== SKIP) {
            entry = blocks.get(decision.block);
            if (!entry) {
              entry = { el: decision.block, t: decision.t, text: '', visible: false };
              blocks.set(decision.block, entry);
            }
            appendToBlock(entry, decision, node, parent, content, blockBox);
          }
        }
        const full = rawFull && displayFull;
        if (full) {
          // The visible text is full; keep walking only to place blocks, and skip layout reads that cannot
          // change anything.
          if (visibleBlocks > MAX_BLOCKS) return true;
          if (!entry || entry.visible) continue;
        }
        range.selectNodeContents(node);
        if (!intersectsViewport(toTop(range.getBoundingClientRect(), frame))) continue;
        if (entry && !entry.visible) {
          entry.visible = true;
          visibleBlocks++;
        }
        if (full) continue;
        if (!rawFull) {
          // The raw text, as the revision has always hashed it.
          const separator = !rawLength ? '' : parent !== previousParent && isBlock(parent) ? '\n' : ' ';
          previousParent = parent;
          const piece = separator + content;
          const live = parent.closest(LIVE_REGION);
          if (rawLength + piece.length > MAX_TEXT) {
            if (!live) stableParts.push(piece.slice(0, MAX_TEXT - rawLength));
            rawFull = true;
            truncated = true;
            if (!withBlocks) return true;
          } else {
            rawLength += piece.length;
            if (!live) stableParts.push(piece);
          }
        }
        if (!displayFull && !derived) {
          let separator = !parts.length ? '' : parent !== displayParent && isBlock(parent) ? '\n' : ' ';
          if (separator === '\n' && displayParent && light) {
            // One table row's cells on one line; one list row's fields on one line.
            const cell = parent.closest('td,th');
            const previousCell = displayParent.closest?.('td,th');
            if (cell && previousCell && cell !== previousCell && cell.parentElement === previousCell.parentElement) separator = ' | ';
            else if (!cell) {
              const row = rowOf(parent);
              // A repeated card's "Label: value" lines stay separate lines (distinctFacts), as its blocks do.
              if (row && row === rowOf(displayParent) && !(FACT_LINE.test(content) && !rowElement(row))) separator = ' · ';
            }
          }
          // Two records (detectRecords) never share a line: one card's last button is not the next card's name.
          if (separator === ' ' && recordOf && displayParent?.nodeType === Node.ELEMENT_NODE
            && recordOf(parent) !== recordOf(displayParent)) separator = '\n';
          displayParent = parent;
          pushDisplay(separator + content);
          if (displayFull) truncated = true;
        }
      }
      if (light) flush(null);
      return false;
    };
    if (!document.body) return { text: '', stableText: '', truncated: false, blocks, resolve };
    // The body, then open shadow roots, then same-origin frames, until the visible text and blocks are full.
    const roots = [[document.body, null], ...shadowRoots.map(root => [root, null]),
      ...frames.map(frame => [frame.doc.body, frame])];
    for (const [root, frame] of roots) if (root && walk(root, frame)) break;
    return { text: parts.join(''), stableText: stableParts.join(''), truncated, blocks, resolve };
  }

  // Row grouping: consecutive blocks inside one results row (rowFinder) become one 'li' block with their texts joined
  // by " · " ("10:25 AM – 11:40 AM · Air France · Nonstop · €121"), when there are at least two, none is a heading,
  // label, select, table row or alert, and the joined text fits MAX_BLOCK_TEXT. The block keeps the first ref.
  const UNGROUPED = new Set(['h1', 'h2', 'h3', 'h4', 'label', 'select', 'tr', 'alert', 'chart']);
  // A "Label: value" block. Two or more of them with different labels in a repeated element (not a list item or
  // article) are separate facts of a card ("Q2 revenue: $388,400", "Q3 revenue: $412,900"), not one row's fields.
  const FACT_LINE = /^\s*([\p{L}][\p{L}\p{N} '’-]{0,40}):\s+\S/u;
  const ROW_ELEMENT = /^(?:LI|ARTICLE)$/;
  const rowElement = row => ROW_ELEMENT.test(row.tagName) || /^(?:listitem|article)$/.test(row.getAttribute('role') ?? '');
  function distinctFacts(row, group) {
    if (rowElement(row)) return false;
    const labels = group.map(entry => FACT_LINE.exec(entry.text)?.[1].trim().toLowerCase()).filter(Boolean);
    return labels.length >= 2 && new Set(labels).size >= 2;
  }
  function groupRows(entries) {
    const rowOf = rowFinder();
    const out = [];
    let i = 0;
    while (i < entries.length) {
      const row = UNGROUPED.has(entries[i].t) ? null : rowOf(entries[i].el);
      let j = i + 1;
      if (row) {
        while (j < entries.length && !UNGROUPED.has(entries[j].t) && rowOf(entries[j].el) === row) j++;
      }
      const group = entries.slice(i, j);
      const text = group.map(entry => entry.text.trim()).filter(Boolean).join(' · ');
      if (group.length >= 2 && text.length <= MAX_BLOCK_TEXT && !distinctFacts(row, group)) {
        const merged = { el: row, t: 'li', text, visible: group.some(entry => entry.visible) };
        const ref = group.find(entry => entry.ref !== undefined)?.ref;
        if (ref !== undefined) merged.ref = ref;
        out.push(merged);
      } else {
        out.push(...group);
      }
      i = j;
    }
    return out;
  }

  // Visually hidden status text (a screen-reader-only block: 1px box or a clip that hides it, on the block or up to
  // three ancestors): marked `hidden: true`, so the runtime never reads it as a loading placeholder anyone sees
  // (Google Flights keeps a hidden "Loading results" next to the rendered rows). Checked only for short texts that
  // start like a placeholder, so the layout reads stay few. A block whose element is visible counts as hidden when
  // every element that owns its text is (Google Flights' toolbar: two buttons and a hidden "Fetching results" span,
  // read as one block of the bar).
  const MAX_TEXT_OWNERS = 4;
  function textHidden(entry) {
    if (visuallyHidden(entry.el)) return true;
    const owners = entry.owners;
    return Boolean(owners?.length) && owners.length <= MAX_TEXT_OWNERS
      && owners.every(owner => owner !== entry.el && visuallyHidden(owner));
  }
  const PLACEHOLDER_LIKE = /^\s*(?:(?:still |now )?loading\b|fetching\b|retrieving\b|please wait\b|one moment\b|updating\b|…$|\.{3,}$)/i;
  function visuallyHidden(el) {
    let node = el;
    for (let depth = 0; node && node.nodeType === Node.ELEMENT_NODE && depth < 4; depth++, node = parentOf(node)) {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 1 && rect.height <= 1) return true;
      const style = styleOf(node);
      if (/inset\(\s*50%/.test(style.clipPath) || (style.position === 'absolute' && /^rect\(\s*(?:0|1)px/.test(style.clip))) {
        return true;
      }
    }
    return false;
  }

  // Final block list: refs to offered controls, keyed grid rows (collectViews), grouped result rows, then visible
  // blocks before off-screen ones (document order within each group), capped at MAX_BLOCKS.
  function finishBlocks(blocks, resolve, views = null, records = null) {
    const idOf = new Map();
    for (const [id, el] of targets) idOf.set(el, id);
    // A label points at the control it labels, wherever that control is; a select block at its select.
    for (const entry of blocks.values()) {
      if (entry.t === 'label' && idOf.has(entry.el.control)) entry.ref = idOf.get(entry.el.control);
      else if (entry.t === 'select' && idOf.has(entry.el)) entry.ref = idOf.get(entry.el);
    }
    // Otherwise a block refers to the first offered control it is or contains.
    for (const [id, el] of targets) {
      const decision = resolve(BLOCK_SKIP_TAGS.has(el.tagName.toUpperCase()) ? el.parentElement : el);
      const entry = decision !== SKIP ? blocks.get(decision.block) : null;
      if (entry && entry.ref === undefined) entry.ref = id;
    }
    if (views?.rowText.size) {
      for (const entry of blocks.values()) if (views.rowText.has(entry.el)) entry.text = views.rowText.get(entry.el);
    }
    const visible = [];
    const offscreen = [];
    for (const entry of groupRows(Array.from(blocks.values()))) (entry.visible ? visible : offscreen).push(entry);
    let ordered = visible.concat(offscreen);
    // Over the cap, the blocks inside a record after its first go first: the record entry carries their text.
    if (records?.records.length) ordered = recordBlockBudget(ordered, records.recordOf, MAX_BLOCKS);
    const result = [];
    const recordIndex = records?.records.length ? new Map(records.records.map(record => [record.id, record])) : null;
    for (const entry of ordered.slice(0, MAX_BLOCKS)) {
      if (recordIndex) {
        const record = recordIndex.get(records.recordOf(entry.el)?.id);
        if (record) (record.blocks ??= []).push(result.length);
        // A grouped row around several records (a grid row of tiles) belongs to each record it holds.
        else if (entry.el?.contains) {
          for (const member of records.members) {
            const held = entry.el !== member && entry.el.contains(member) ? recordIndex.get(records.recordOf(member)?.id) : null;
            if (held) (held.blocks ??= []).push(result.length);
          }
        }
      }
      const block = { t: entry.t, text: entry.text.slice(0, MAX_BLOCK_TEXT).trim() };
      if (entry.ref !== undefined) block.ref = entry.ref;
      if (!entry.visible) block.offscreen = true;
      if (block.text.length <= 100 && PLACEHOLDER_LIKE.test(block.text) && entry.el && textHidden(entry)) {
        block.hidden = true;
      }
      if (entry.el && inMarkedOverlay(entry.el)) block.overlay = true;
      result.push(block);
    }
    return { blocks: result, blocksTruncated: ordered.length > MAX_BLOCKS };
  }

  // FNV-1a over the semantic signature: cheap, deterministic, and only used to detect change.
  function hash(value) {
    let h = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  // Picks at most MAX_CONTROLS controls. Returns [{ el, rect, label?, offscreen, consentKind? }] in output
  // order: in-viewport floating choices, other in-viewport controls, off-screen term matches, then other off-screen
  // controls, each in document order. Selection priority: consent buttons, nag closers, floating choices, in-viewport
  // term matches, other in-viewport controls (leaving up to TERM_RESERVE slots for off-screen term matches), off-screen
  // term matches, off-screen controls.
  function selectControls(candidates, terms, consent) {
    const inView = [];
    const offView = [];
    let password = false;
    for (const el of candidates) {
      const type = el.type;
      if (type === 'password') {
        if (!password && el.tagName === 'INPUT' && rendered(el)) password = true;
        // Password inputs are offered (as fill targets) only with the sign_in capability (testing mode), and, with the
        // worker's vault, one that is no sign-in field as a target for a secret handle (fill_secret, approved each time).
        if (el.tagName !== 'INPUT' || !(currentAllow.has('sign_in') || (secretSettings.vault && secretTarget(el)))) continue;
      }
      if (type === 'hidden') continue;
      // A file input is offered only for an upload (Act and Test site, each approved by the user); a styled picker
      // hides the input itself, so its label's box stands in for it.
      if (type === 'file' && (el.tagName !== 'INPUT' || !currentAllow.has('submit') || el.disabled)) continue;
      const explicitRole = el.getAttribute('role');
      if ((explicitRole === 'option' || MENU_ITEM_ROLES.has(explicitRole)) && !offeredOption(el)) continue;
      if (explicitRole === 'listbox' && optionContainer(el)) continue;
      const own = boxOf(el);
      const pickerLabel = type === 'file' && !(own.width > 0 && own.height > 0) ? Array.from(el.labels ?? []).find(label => {
        const box = boxOf(label);
        return box.width > 0 && box.height > 0;
      }) : null;
      const rect = pickerLabel ? boxOf(pickerLabel) : own;
      if (!(rect.width > 0 && rect.height > 0)) continue;
      if (intersectsViewport(rect)) {
        if (rendered(pickerLabel ?? el, rect)) inView.push({ el, rect, offscreen: false });
      } else {
        // Visibility of off-screen elements is checked only for the ones considered for a slot.
        offView.push({ el, rect, offscreen: true });
      }
    }
    const labels = new Map();
    const labelFor = item => {
      if (!labels.has(item)) labels.set(item, labelOf(item.el));
      return labels.get(item);
    };
    const matches = item => {
      if (!terms.length) return false;
      const label = labelFor(item).toLowerCase();
      return terms.some(term => label.includes(term));
    };
    const chosen = new Set();
    const take = (item, limit = MAX_CONTROLS) => {
      if (chosen.size >= limit || chosen.has(item)) return;
      chosen.add(item);
    };
    if (consent) {
      for (const item of inView) {
        const kind = consent.kinds.get(item.el);
        if (kind) take(item);
      }
    }
    // A nag overlay's close controls come next (detectOverlay ran just before), then an ordinary floating UI's choices.
    if (lastOverlay?.closers.length) for (const item of inView) if (overlayCloser(item.el)) take(item);
    for (const item of inView) if (inFloating(item.el)) take(item);
    if (terms.length) for (const item of inView) if (matches(item)) take(item);
    // Off-screen term matches, checked for visibility only until the reserve is full.
    const offMatches = [];
    if (terms.length) {
      for (const item of offView) {
        if (offMatches.length >= TERM_RESERVE) break;
        if (matches(item) && rendered(item.el, item.rect)) offMatches.push(item);
      }
    }
    for (const item of inView) take(item, MAX_CONTROLS - offMatches.length);
    for (const item of offMatches) take(item);
    let capped = false;
    let dropped = 0;
    let rest = 0;
    for (const [index, item] of offView.entries()) {
      if (chosen.has(item) || !rendered(item.el, item.rect)) continue;
      if (chosen.size >= MAX_CONTROLS) {
        capped = true;
        rest = index;
        break;
      }
      take(item);
    }
    if (capped) {
      // How many rendered off-screen controls the cap left out (checked up to a budget, the remainder counted as is).
      let checked = 0;
      for (const item of offView.slice(rest)) {
        if (chosen.has(item)) continue;
        if (++checked > DROP_COUNT_BUDGET || rendered(item.el, item.rect)) dropped++;
      }
    }
    const leftInView = inView.filter(item => !chosen.has(item)).length + offMatches.filter(item => !chosen.has(item)).length;
    if (leftInView) capped = true;
    dropped += leftInView;
    const ordered = [
      ...inView.filter(item => chosen.has(item) && inFloating(item.el)),
      ...inView.filter(item => chosen.has(item) && !inFloating(item.el)),
      ...offMatches.filter(item => chosen.has(item)),
      ...offView.filter(item => chosen.has(item) && !offMatches.includes(item)),
    ];
    for (const item of ordered) {
      item.label = labelFor(item);
      if (consent) {
        let node = item.el;
        while (node && node !== consent.container) node = parentOf(node);
        if (node) item.consentKind = consent.kinds.get(item.el) ?? 'other';
      }
    }
    // A calendar day named by its number alone reads as a date (nameCalendarDays).
    nameCalendarDays(ordered);
    // A control with no name is never sent with an empty label (describeUnnamed).
    describeUnnamed(ordered);
    return { ordered, password, capped, dropped };
  }

  function loginWall(password) {
    if (!password) return false;
    if (LOGIN_TITLE.test(document.title)) return true;
    let checked = 0;
    for (const heading of document.querySelectorAll('h1,h2,h3,[role="heading"]')) {
      if (++checked > 20) break;
      if (!rendered(heading)) continue;
      return LOGIN_TITLE.test(heading.textContent);
    }
    return false;
  }

  // Expectation texts (observe's `expectText`: the run's textIncludes, lower-cased) found in the rendered text of the
  // whole page, not only the viewport, so a run that scrolled below "departing 2026-10-12" still proves its step. A
  // text already in the viewport text costs nothing; one that is not even in the raw text content (whitespace
  // ignored) costs one string search; only the rest walk the text nodes, and the walk stops once all are found. The
  // walk joins texts as the viewport text does and skips hidden text (SKIP_TEXT_TAGS, display, visibility and
  // content-visibility, a zero opacity, aria-hidden, a screen-reader-only clip or 1px box, a zero-size box that clips
  // its overflow, a box above or left of the document's start, a frame whose element is hidden), so a page cannot
  // satisfy an expectation with text nobody sees. textAbsent never reads this (src/expectation.js).
  const MAX_EXPECT_TEXTS = 4;
  // The walk's text-node budget: past it a text counts as not found (the expectation fails safe, unverified).
  const MAX_EXPECT_NODES = 30000;
  function normalizeExpectText(texts) {
    if (!Array.isArray(texts)) return [];
    return texts.filter(text => typeof text === 'string' && text.trim() && text.length <= 200)
      .map(text => text.toLowerCase()).slice(0, MAX_EXPECT_TEXTS);
  }
  function concealedSelf(el) {
    if (SKIP_TEXT_TAGS.has(el.tagName.toUpperCase()) || el.getAttribute('aria-hidden') === 'true') return true;
    const style = styleOf(el);
    // A display: contents element has no box of its own; its children's boxes decide.
    if (style.display === 'contents') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 && rect.height <= 1) return true;
    if (/inset\(\s*50%/.test(style.clipPath) || (style.position === 'absolute' && /^rect\(\s*(?:0|1)px/.test(style.clip))) {
      return true;
    }
    return (rect.width === 0 || rect.height === 0) && (style.overflowX !== 'visible' || style.overflowY !== 'visible');
  }
  // Matching is against redacted text (secretScrubText), so an expectation cannot be used to guess a secret.
  function findTexts(texts, viewportText, roots, frames) {
    const view = secretScrubText(viewportText).toLowerCase();
    const found = texts.filter(text => view.includes(text));
    const bodies = [document.body, ...roots, ...frames.map(frame => frame.doc.body)].filter(Boolean);
    const squash = value => value.replace(/\s+/g, '');
    const raw = squash(bodies.map(root => root.textContent).join('')).toLowerCase();
    let missing = texts.filter(text => !found.includes(text) && raw.includes(squash(text)));
    if (!missing.length) return found;
    const concealed = new Map();
    const isConcealed = el => {
      if (!el) return false;
      if (!concealed.has(el)) {
        // checkVisibility walks the ancestors for display, content-visibility, visibility and a zero opacity.
        const own = el.checkVisibility
          ? !el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : !el.getClientRects().length;
        concealed.set(el, own || concealedSelf(el) || isConcealed(parentOf(el)));
      }
      return concealed.get(el);
    };
    const blockish = new Map();
    const isBlock = el => {
      if (!blockish.has(el)) blockish.set(el, !styleOf(el).display.startsWith('inline'));
      return blockish.get(el);
    };
    // A box above or left of the document's start (left: -9999px) is where no scroll reaches.
    const reach = new Map();
    const outOfReach = el => {
      if (!reach.has(el)) {
        const view = el.ownerDocument.defaultView;
        const rect = el.getBoundingClientRect();
        reach.set(el, rect.right + view.scrollX <= 0 || rect.bottom + view.scrollY <= 0);
      }
      return reach.get(el);
    };
    const longest = Math.max(...missing.map(item => item.length));
    let walked = 0;
    let text = '';
    let previousParent = null;
    for (const root of bodies) {
      // A frame's text counts only while its frame element shows in the page.
      const frame = frames.find(item => item.doc.body === root);
      if (frame && (isConcealed(frame.el) || outOfReach(frame.el))) continue;
      const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && missing.length && walked < MAX_EXPECT_NODES; node = walker.nextNode()) {
        walked++;
        const raw = node.nodeValue.replace(/\s+/g, ' ').trim();
        const parent = node.parentElement;
        if (!raw || !parent || isConcealed(parent) || outOfReach(parent)) continue;
        const content = /\d|[:=]|PRIVATE KEY/.test(raw) ? secretScrubText(raw) : raw;
        // Only the tail can hold a new match: a window as long as the longest text plus what was just added.
        text = text.slice(-longest) + (!text ? '' : parent !== previousParent && isBlock(parent) ? '\n' : ' ') + content.toLowerCase();
        previousParent = parent;
        const hits = missing.filter(item => text.includes(item));
        if (hits.length) {
          found.push(...hits);
          missing = missing.filter(item => !hits.includes(item));
        }
      }
    }
    if (walked >= MAX_EXPECT_NODES) findTexts.capped = true;
    return texts.filter(item => found.includes(item));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Repeated records: result cards, grid tiles, list items and table rows, found by structure, never by site.
  // ---------------------------------------------------------------------------------------------------------------
  //
  // A results page repeats one template. detectRecords finds sibling subtrees with the same tag and role and the same
  // descendant shape (at least RECORD_MIN of them), and near-siblings: the same template under sibling wrappers that
  // hold nothing else (a grid split into rows of two or three tiles). Each group is scored as a list of records from a
  // sample of its members: several text boxes each, a link or a heading, prices, ratings and numbers, a shared class
  // token as a weak bonus. A group inside navigation, a banner or footer landmark, a menu, a tab list, a toolbar or a
  // dialog is never a list of records, nor is a hub of plain links (footer columns: nearly all text in three or more
  // links per member, no price or rating), nor a filter panel (two or more checkboxes, radios or sliders per member).
  // Members are compared by their value skeleton as well as their markup: a sibling with other markup (a badge, extra
  // wrappers) that has the name, price and rating the similar members have is one of them, and a sibling with the
  // same tag but no name, or none of their values, is an insert (a notice, a promo) and left out. A group whose
  // members contain another group is a container when that inner group spreads over two or more of them and holds
  // most of their text with two or more inner members per member (sections of cards, a grid's rows). Inside one
  // member, an inner group of whole records (each a name and a price or rating) is a module of its own (a strip of
  // other offers between result cards), and that member leaves the outer list; any other inner group is a part of
  // each record (a card's name, score, room and price boxes; its facility bullets) and the outer one wins.
  //
  // The page's main results come first: among the lists that score at least RECORD_LIST_SHARE of the best, every
  // carousel (a strip that scrolls or snaps on the x axis, or one row wider than the viewport) ranks after the other
  // lists, then the lists inside the main landmark and after the result-count line ("8 properties found"; else after
  // the h1) rank first, then the score.
  //
  // The best lists (the top one, and at most two more scoring at least RECORD_LIST_SHARE of it) are read into one
  // compact entry per record, from the whole list, not only the viewport: an id, the title (the first heading, else
  // the main link, else the first worded field), the href and control ref of its link, and its visible fields in
  // order (aria-hidden and hidden subtrees skipped, screen-reader-only text kept only when it holds a digit, struck-
  // through prices dropped, a rating held only in an aria-label or alt kept as a field). Fields that repeat in most
  // records of a list without a digit ("See availability", "Includes taxes and fees") are template text and dropped.
  // Typed hints come from the fields: price (currency and number), rating (a number next to score/rated/stars, or
  // "4.5 out of 5", a score with its grade either side, a decimal before its review count; with several, the one
  // nearest the review count, all of them in `ratings`), reviews, counts and dates or times. A record that says
  // Sponsored/Ad/Promoted is marked `sponsored`, one that says sold out or unavailable `unavailable`; neither is
  // removed. At most MAX_RECORDS records of RECORD_TEXT characters; each list reports its member total, so a cut is
  // honest (`recordsTruncated`). Only explicit result count, sort and pagination are added as `recordState`.
  const RECORD_MIN = 3;
  const MAX_RECORDS = 60;
  const MAX_RECORD_LISTS = 3;
  const RECORD_TEXT = 300;
  const RECORD_FIELD_TEXT = 100;
  const RECORD_TITLE_TEXT = 120;
  const MAX_RECORD_FIELDS = 24;
  const RECORD_SCAN_BUDGET = 40_000;
  const RECORD_NODE_BUDGET = 800;
  const RECORD_SAMPLE = 12;
  const RECORD_SHAPE_DEPTH = 3;
  const RECORD_SHAPE_NODES = 80;
  const RECORD_SIMILARITY = 0.35;
  const RECORD_MERGE_SIMILARITY = 0.5;
  const RECORD_WRAPPER_SHARE = 0.8;
  const RECORD_CONTAINER_TEXT = 0.7;
  const RECORD_LIST_SHARE = 0.25;
  const RECORD_SCORED_GROUPS = 40;
  const RECORD_TEMPLATE_SHARE = 0.6;
  const RECORD_CORE_SHARE = 0.6;
  const RECORD_CHOICES = 'input[type="checkbox"],input[type="radio"],input[type="range"],[role="checkbox"],[role="radio"],'
    + '[role="switch"],[role="slider"],select';
  const RECORD_CORE_FEATURES = ['titled', 'priced', 'rated'];
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const RECORD_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SELECT', 'OPTION', 'OPTGROUP', 'DATALIST',
    'HEAD', 'IFRAME', 'OBJECT', 'BR', 'HR', 'INPUT', 'TEXTAREA', 'IMG', 'PICTURE', 'SOURCE', 'VIDEO', 'AUDIO', 'CANVAS',
    'META', 'LINK']);
  const RECORD_CHROME = 'nav,[role="navigation"],[role="banner"],[role="contentinfo"],[role="menu"],[role="menubar"],'
    + '[role="tablist"],[role="toolbar"],[role="dialog"],[role="alertdialog"],dialog,[aria-modal="true"]';
  const RECORD_HEADING = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  const RECORD_FIELD_TAGS = new Set(['A', 'BUTTON', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'P', 'DT', 'DD',
    'LABEL', 'FIGCAPTION', 'TIME', 'CAPTION']);
  // A number before a currency is an amount unless that currency starts the next amount ("4.7 out of 5 $ 45").
  const RECORD_PRICE =/(?:US\$|C\$|A\$|[$€£¥₹]|\b(?:USD|EUR|GBP|CHF|CAD|AUD|JPY|INR)\b)\s?\d[\d.,  ]*\d|(?:US\$|C\$|A\$|[$€£¥₹])\s?\d|\b\d[\d.,  ]*\s?(?:[€£$¥₹]|\b(?:USD|EUR|GBP|CHF|CAD|AUD|kr|zł)\b)(?!\s?\d)/gi;
  const RECORD_RATING_WORDS = /\b(?:scored|score|rated|rating|ratings|review score|guest rating|stars?)\b|★/i;
  const RECORD_REVIEWS = /(\d[\d,.  ]*)\s*(?:reviews?|ratings?|votes?|opinions?|comments?)\b/i;
  const RECORD_TIME = /\b(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:[ap]\.?m\.?)?|\b(?:1[0-2]|0?[1-9])(?:\.[0-5]\d)?\s?[ap]\.?m\.?(?![a-z])/i;
  const RECORD_DATE = /\b(?:\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|20\d{2}-\d{2}-\d{2})/i;
  // Whole date cells, not date mentions in descriptive settings text. Numeric order remains uninterpreted.
  const RECORD_DATE_CELL = /^(?:(?:\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2})(?:,?\s+\d{4})?|\d{1,2}[/.]\d{1,2}[/.](?:\d{2}|\d{4})|20\d{2}-\d{2}-\d{2}|today|yesterday)$/i;
  const RECORD_COUNT = /\b\d[\d,.]*\s(?:[a-z]{2,}|m²)|\b\d[\d,.]*\s?(?:m²|km|mi)\b/i;
  const RECORD_SPONSORED = /^(?:sponsored|ad|ads|advert|advertisement|promoted|promotion|sponsored (?:listing|result|ad)|anzeige|publicité|patrocinado|sponsorisé)\b/i;
  const RECORD_UNAVAILABLE = /\b(?:sold out|unavailable|not available|no availability|out of stock|fully booked|no (?:rooms?|seats?|tickets?) (?:left|available)|no longer available)\b/i;
  const RECORD_CTA = /^(?:see|view|show|book|reserve|buy|add|select|choose|check|more|details|learn|read|get|compare|save|shop|open|go|visit)\b/i;

  // A score with its verbal grade, either order ("8.7 Excellent", "8.4Very good", "Very good 8.4").
  const RECORD_GRADES = '(?:exceptional|superb|wonderful|excellent|fabulous|very good|good|pleasant|fair|okay|poor)';
  const RECORD_GRADE_AFTER = new RegExp(`(?<![\\d.,])(\\d{1,2}[.,]\\d)\\s*${RECORD_GRADES}\\b`, 'i');
  const RECORD_GRADE_BEFORE = new RegExp(`\\b${RECORD_GRADES}\\s*:?\\s*(\\d{1,2}[.,]\\d)(?![\\d.,]|\\s*(?:reviews?|ratings?|km|mi|m\\b))`, 'i');
  const RECORD_SCORE_COUNT = /(?<![\d.,])(\d{1,2}[.,]\d{1,2})\s*\(\s*\d[\d,.  ]*\s*(?:reviews?|ratings?|votes?|opinions?)\s*\)/i;

  function recordNumber(raw) {
    return Number(String(raw).replace(',', '.'));
  }

  // A rating in `text`: "4.5 out of 5 stars", "8.4/10", "Scored 7.8", "Rated 4.6", "4.5 stars". { value, scale? }.
  function recordRating(text) {
    const value = String(text ?? '');
    let match = /(\d{1,2}(?:[.,]\d{1,2})?)\s*out of\s*(5|10|100)\b/i.exec(value);
    if (!match) {
      match = /(\d{1,2}(?:[.,]\d{1,2})?)\s*\/\s*(5|10|100)\b/.exec(value);
      if (match && !RECORD_RATING_WORDS.test(value) && !/[.,]/.test(match[1])) match = null;
    }
    if (match) {
      const rating = recordNumber(match[1]);
      const scale = Number(match[2]);
      return rating <= scale ? { value: rating, scale } : null;
    }
    match = /\b(?:scored|score|rated|rating|review score|guest rating)\s*:?\s*(\d{1,2}(?:[.,]\d{1,2})?)(?![\d.,]*\s*(?:reviews?|ratings?|votes?))/i.exec(value);
    if (match) {
      const rating = recordNumber(match[1]);
      return rating <= 10 ? { value: rating } : null;
    }
    // A score with its verbal grade ("8.7 Excellent", "9.0 Wonderful"), the way review sites print it.
    match = RECORD_GRADE_AFTER.exec(value) ?? RECORD_GRADE_BEFORE.exec(value);
    if (match) {
      const rating = recordNumber(match[1]);
      return rating <= 10 ? { value: rating, scale: 10 } : null;
    }
    // A decimal score right before its review count ("4.31 (5,760 reviews)"): out of 5 up to 5, else out of 10.
    match = RECORD_SCORE_COUNT.exec(value);
    if (match) {
      const rating = recordNumber(match[1]);
      return rating <= 10 ? { value: rating, scale: rating <= 5 ? 5 : 10 } : null;
    }
    match = /(?<![\d.,])(\d(?:[.,]\d{1,2})?)\s*(?:stars?|★)/i.exec(value);
    if (match) {
      const rating = recordNumber(match[1]);
      return rating <= 5 ? { value: rating, scale: 5 } : null;
    }
    return null;
  }

  function recordPrices(text) {
    return Array.from(String(text ?? '').matchAll(RECORD_PRICE), match => match[0].trim());
  }

  // Inside navigation, a banner or footer landmark, a menu, a tab list, a toolbar or a dialog: page chrome, not data.
  function recordChrome(el) {
    if (el.closest(RECORD_CHROME)) return true;
    const edge = el.closest('header,footer');
    return Boolean(edge) && !edge.parentElement?.closest('article,section,li,main,[role="main"],[role="article"],[role="listitem"]');
  }

  // The descendant shape of a member: `depth:TAG` features of its first RECORD_SHAPE_NODES descendants (breadth first).
  // `depth:TAG` strings made once per page script, so a shape adds the same string rather than building one per node.
  const recordFeatures = Array.from({ length: RECORD_SHAPE_DEPTH + 1 }, () => new Map());
  function recordFeature(depth, tag) {
    const byTag = recordFeatures[depth];
    let feature = byTag.get(tag);
    if (feature === undefined) {
      feature = `${depth}:${tag}`;
      byTag.set(tag, feature);
    }
    return feature;
  }

  function recordShape(el) {
    const features = new Set();
    let seen = 0;
    let level = [el];
    for (let depth = 1; depth <= RECORD_SHAPE_DEPTH && level.length; depth++) {
      const next = [];
      for (const node of level) {
        for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
          if (++seen > RECORD_SHAPE_NODES) return features;
          features.add(recordFeature(depth, child.tagName));
          next.push(child);
        }
      }
      level = next;
    }
    return features;
  }

  function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    let shared = 0;
    for (const item of a) if (b.has(item)) shared++;
    return shared / (a.size + b.size - shared);
  }

  // The features present in at least half of the shapes.
  function majorityShape(shapes) {
    const counts = new Map();
    for (const shape of shapes) for (const feature of shape) counts.set(feature, (counts.get(feature) ?? 0) + 1);
    const out = new Set();
    for (const [feature, count] of counts) if (count * 2 >= shapes.length) out.add(feature);
    return out;
  }

  // Cheap stats of a member for scoring (no style reads): its text, text boxes, links and whether it has a heading.
  function recordStats(el, cache) {
    if (cache.has(el)) return cache.get(el);
    let text = '';
    let linkText = 0;
    const owners = new Set();
    const links = new Set();
    let nodes = 0;
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && nodes < RECORD_NODE_BUDGET; node = walker.nextNode()) {
      nodes++;
      const parent = node.parentElement;
      const content = node.nodeValue.replace(/\s+/g, ' ').trim();
      if (!content || !parent || SKIP_TEXT_TAGS.has(parent.tagName.toUpperCase())) continue;
      text += (text ? ' ' : '') + content;
      owners.add(parent);
      const link = parent.closest('a[href]');
      if (link) {
        linkText += content.length;
        links.add(link);
      }
    }
    const heading = Boolean(el.querySelector(RECORD_HEADING));
    const stats = {
      text, fields: owners.size, links: links.size, linkRatio: text ? linkText / text.length : 0, heading,
      // The value skeleton: a name (a heading or a worded link), a price, a rating (text or an aria-label/alt).
      titled: heading || linkText >= 3,
      priced: recordPrices(text).length > 0,
      rated: Boolean(recordRating(text)) || [...el.querySelectorAll('[aria-label],img[alt]')].slice(0, 20)
        .some(node => recordRating(node.getAttribute('aria-label') || node.getAttribute('alt'))),
      unavailable: RECORD_UNAVAILABLE.test(text),
      choices: el.querySelectorAll(RECORD_CHOICES).length,
      // Data rows can have both selection and state controls (for example, a star checkbox).
      // Require independent readable data cells and a standalone date/time cell; a settings row with a
      // name, description and toggles is still a filter. This exception covers dated tabular records only.
      dataRow: (el.tagName === 'TR' || el.getAttribute('role') === 'row')
        && Boolean(el.parentElement?.closest(`table,${GRID_SELECTOR}`))
        && gridCells(el).filter(cell => !cell.matches(RECORD_CHOICES) && !cell.querySelector(RECORD_CHOICES)
          && /[\p{L}\p{N}]/u.test(cell.textContent ?? '')).length >= 2
        && gridCells(el).some(cell => {
          if (cell.matches(RECORD_CHOICES) || cell.querySelector(RECORD_CHOICES)) return false;
          const text = cleanText(cell.textContent);
          return RECORD_DATE_CELL.test(text) || Boolean(text && text.match(RECORD_TIME)?.[0] === text);
        }),
    };
    cache.set(el, stats);
    return stats;
  }

  // The value skeleton most of a group's members share: the features (titled, priced, rated) at least
  // RECORD_CORE_SHARE of them have.
  function coreSkeleton(members, stats) {
    const sample = members.slice(0, RECORD_SAMPLE * 2).map(member => recordStats(member, stats));
    return RECORD_CORE_FEATURES.filter(feature => sample.filter(item => item[feature]).length >= sample.length * RECORD_CORE_SHARE);
  }

  // The members of a same-key group that share its majority shape (at least RECORD_MIN, else none), and the shape.
  // Heterogeneous cards (a badge, an optional block, an extra wrapper): a sibling whose markup differs but that carries
  // the whole value skeleton of the similar members (a name and their price and rating) is one of them too.
  function similarMembers(members, shapes, stats) {
    const shapeOf = member => {
      if (!shapes.has(member)) shapes.set(member, recordShape(member));
      return shapes.get(member);
    };
    const all = members.map(shapeOf);
    const majority = majorityShape(all);
    const similar = members.map((member, i) => jaccard(all[i], majority) >= RECORD_SIMILARITY);
    let kept = members.filter((_, i) => similar[i]);
    if (kept.length >= RECORD_MIN - 1 && kept.length < members.length) {
      const core = coreSkeleton(kept, stats);
      if (core.includes('titled') && (core.includes('priced') || core.includes('rated'))) {
        kept = members.filter((member, i) => similar[i] || core.every(feature => recordStats(member, stats)[feature]));
      }
    }
    return { kept, majority };
  }

  // Interleaved non-members: in a list whose members mostly carry a name and a price or rating, a sibling of the same
  // tag that has no name, or none of those values (and is not marked sold out), is an insert (a notice, a promo
  // banner, a "things to do" module), not a record.
  function withoutInserts(group, stats) {
    const core = coreSkeleton(group.members, stats);
    const values = core.filter(feature => feature === 'priced' || feature === 'rated');
    if (!values.length) return group;
    const kept = group.members.filter(member => {
      const item = recordStats(member, stats);
      if (core.includes('titled') && !item.titled) return false;
      return item.unavailable || values.some(feature => item[feature]);
    });
    if (kept.length === group.members.length || kept.length < RECORD_MIN) return group;
    return { ...group, members: kept };
  }

  // A member that renders and holds text; a table row only when it has a data cell.
  function recordMember(el) {
    if (RECORD_SKIP_TAGS.has(el.tagName) || el.namespaceURI !== HTML_NS) return false;
    if (el.tagName === 'TR' && !el.querySelector('td,[role="gridcell"],[role="cell"]')) return false;
    if (!/[\p{L}\p{N}]/u.test(el.textContent ?? '')) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Candidate groups: { parent, parents?, members, majority, merged }.
  function recordGroups(shapes, stats) {
    const groups = [];
    const pool = new Map(); // grandparent -> key -> [{ parent, members }]
    if (!document.body) return groups;
    const keyOf = el => `${el.tagName}|${el.getAttribute('role') ?? ''}`;
    let scanned = 0;
    const scan = parent => {
      if (parent.childElementCount < 1 || RECORD_SKIP_TAGS.has(parent.tagName) || parent.namespaceURI !== HTML_NS) return;
      // Leaf children only (a paragraph's links and emphasis): only a wrapper key survives the leaf check below, and
      // none does when no tag holds RECORD_WRAPPER_SHARE of the children.
      const tags = new Map();
      let leaves = true;
      let widest = 0;
      let counted = 0;
      for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
        if (++counted > 400) break;
        if (child.firstElementChild) {
          leaves = false;
          break;
        }
        const count = (tags.get(child.tagName) ?? 0) + 1;
        tags.set(child.tagName, count);
        if (count > widest) widest = count;
      }
      if (leaves && widest < parent.childElementCount * RECORD_WRAPPER_SHARE) return;
      const byKey = new Map();
      let children = 0;
      for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
        if (++children > 400) break;
        const key = keyOf(child);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(child);
      }
      for (const [key, raw] of byKey) {
        // The cheap checks first: most repeats are a handful of icons or empty spacers.
        // A wrapper of nearly only this key: a grid row of tiles; a lone tile only in a row beside rows like it.
        const wrapper = raw.length >= parent.childElementCount * RECORD_WRAPPER_SHARE && (raw.length >= 2
          || keyOf(parent) === (parent.previousElementSibling && keyOf(parent.previousElementSibling))
          || keyOf(parent) === (parent.nextElementSibling && keyOf(parent.nextElementSibling)));
        if (raw.length < RECORD_MIN && !wrapper) continue;
        // Leaves only (the links, bold and italic runs of a paragraph): a member without element children has at most
        // one text box, so no subset of them reaches the two fields recordScore needs. Not pooled either, so skipped.
        if (!wrapper && raw.every(el => !el.firstElementChild)) continue;
        const members = raw.filter(recordMember);
        if (!members.length) continue;
        if (members.length >= RECORD_MIN) {
          const { kept, majority } = similarMembers(members, shapes, stats);
          if (kept.length >= RECORD_MIN) groups.push({ parent, members: kept, majority, merged: false });
        }
        // A wrapper whose element children are nearly all of this key (a grid row) may merge with its siblings.
        const grand = parent.parentElement;
        if (grand && wrapper && members.length >= raw.length * RECORD_WRAPPER_SHARE) {
          if (!pool.has(grand)) pool.set(grand, new Map());
          const byParentKey = pool.get(grand);
          const poolKey = `${keyOf(parent)}>${key}`;
          if (!byParentKey.has(poolKey)) byParentKey.set(poolKey, []);
          byParentKey.get(poolKey).push({ parent, members });
        }
      }
    };
    scan(document.body);
    for (const el of document.body.getElementsByTagName('*')) {
      if (++scanned > RECORD_SCAN_BUDGET) break;
      if (el.firstElementChild) scan(el);
    }
    // Near-siblings: the same member template under two or more sibling wrappers.
    for (const byParentKey of pool.values()) {
      for (const entries of byParentKey.values()) {
        if (entries.length < 2 || !entries.some(entry => entry.members.length >= 2)) continue;
        const members = entries.flatMap(entry => entry.members);
        if (members.length < RECORD_MIN) continue;
        const { kept, majority } = similarMembers(members, shapes, stats);
        if (kept.length < RECORD_MIN) continue;
        // The wrappers' own templates must agree (two different sections are not one list).
        const first = majorityShape(entries[0].members.map(member => shapes.get(member)));
        if (entries.some(entry => jaccard(majorityShape(entry.members.map(member => shapes.get(member))), first) < RECORD_MERGE_SIMILARITY)) continue;
        groups.push({ parent: entries[0].parent.parentElement, parents: entries.map(entry => entry.parent), members: kept, majority, merged: true });
      }
    }
    return groups;
  }

  // The list score of a group from a sample of its members (0: not a list of records).
  function recordScore(group, stats) {
    // Page chrome, and a blocking overlay's content (detectOverlay: a nag's offers are not the page's records).
    if (recordChrome(group.parent) || inMarkedOverlay(group.parent)) return 0;
    const sample = group.members.slice(0, RECORD_SAMPLE).map(member => recordStats(member, stats));
    const mean = read => sample.reduce((sum, item) => sum + read(item), 0) / sample.length;
    const fields = mean(item => Math.min(item.fields, 10));
    const length = mean(item => Math.min(item.text.length, 400));
    if (fields < 2 || length < 12) return 0;
    // A filter or settings panel: each member holds two or more choice controls (checkboxes, radios, sliders).
    if (mean(item => (item.choices >= 2 && !item.dataRow ? 1 : 0)) >= 0.5) return 0;
    const priced = mean(item => (recordPrices(item.text).length ? 1 : 0));
    const rated = mean(item => (recordRating(item.text) ? 1 : 0));
    // A hub of plain links (footer columns, a mega menu): most text, or most text boxes, in three or more links per
    // member, and nothing measured.
    const links = mean(item => item.links);
    if ((mean(item => item.linkRatio) > 0.65 || links >= fields * 0.6) && links >= 3 && priced < 0.3 && rated < 0.3) return 0;
    const linked = mean(item => (item.links > 0 ? 1 : 0));
    const numbered = mean(item => (/\d/.test(item.text) ? 1 : 0));
    const headed = mean(item => (item.heading ? 1 : 0));
    // Distinct texts: a repeat of one label ("Show on map" five times) is not a list of different records.
    const distinct = new Set(sample.map(item => item.text)).size / sample.length;
    let score = Math.sqrt(group.members.length) * Math.min(fields, 8) * distinct
      * (1 + 0.5 * linked + 1.5 * priced + rated + 0.5 * numbered + 0.5 * headed) * Math.min(1, length / 40);
    // The same class token on most members: a weak signal only.
    const tokens = new Map();
    for (const member of group.members.slice(0, RECORD_SAMPLE)) {
      for (const token of new Set(String(member.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))) {
        tokens.set(token, (tokens.get(token) ?? 0) + 1);
      }
    }
    if ([...tokens.values()].some(count => count >= sample.length * 0.8)) score *= 1.1;
    return score;
  }

  // The nearest ancestor of `el` (itself included) that is in `set`, within `stop`.
  function ancestorIn(el, set, stop = null) {
    for (let node = el, depth = 0; node && depth < 60; node = node.parentElement, depth++) {
      if (node === stop) return null;
      if (set.has(node)) return node;
    }
    return null;
  }

  // Overlapping groups: which of an outer group (members containing inner members) and an inner group wins:
  // 'outer', 'inner', 'split' (the inner group is a list of its own inside one outer member, which leaves the outer
  // list) or null (no overlap).
  function containerWins(outer, inner, stats) {
    const outerSet = new Set(outer.members);
    const perOuter = new Map();
    for (const member of inner.members) {
      const host = ancestorIn(member.parentElement, outerSet);
      if (host) perOuter.set(host, (perOuter.get(host) ?? 0) + recordStats(member, stats).text.length);
    }
    if (!perOuter.size) return null;
    const count = inner.members.filter(member => ancestorIn(member.parentElement, outerSet)).length;
    const each = count / perOuter.size;
    let covered = 0;
    let total = 0;
    for (const [host, length] of perOuter) {
      covered += length;
      total += recordStats(host, stats).text.length;
    }
    // Sections of cards, rows of tiles: inner members spread over two or more outer members and holding most of their
    // text are the records.
    if (perOuter.size >= 2 && each >= 1.5 && total > 0 && covered / total >= RECORD_CONTAINER_TEXT) return 'inner';
    // Inside one outer member: a list of whole records (each with a name and a price or rating) is a module inserted
    // in the outer list (a carousel of other offers between result cards, one section's cards), and the member that
    // holds it is no record of the outer list. A record's own parts (its header, score, room and price boxes) do not
    // each carry a value: there the record is the outer member.
    if (perOuter.size === 1 && count >= RECORD_MIN) {
      const core = coreSkeleton(inner.members, stats);
      if (core.includes('titled') && (core.includes('priced') || core.includes('rated'))) return 'split';
    }
    return 'outer';
  }

  function overlaps(a, b) {
    const setA = new Set(a.members);
    const setB = new Set(b.members);
    return a.members.some(member => ancestorIn(member, setB)) || b.members.some(member => ancestorIn(member, setA));
  }

  // A carousel: a horizontally scrolled strip (an ancestor within three levels of the members that scrolls on the x
  // axis, or snaps on it), or members laid out in one row wider than the viewport. Carousels are secondary lists.
  function recordCarousel(group) {
    const rects = group.members.map(member => member.getBoundingClientRect());
    const first = rects[0];
    const oneRow = rects.every(rect => Math.abs(rect.top - first.top) < Math.max(8, first.height / 4));
    if (oneRow) {
      const left = Math.min(...rects.map(rect => rect.left));
      const right = Math.max(...rects.map(rect => rect.right));
      if (right - left > window.innerWidth) return true;
    }
    let node = group.parents ? group.parents[0].parentElement : group.parent;
    for (let depth = 0; node && node !== document.body && depth < 3; node = node.parentElement, depth++) {
      const style = styleOf(node);
      if (/auto|scroll/.test(style.overflowX ?? '') && node.scrollWidth > node.clientWidth + 1) return true;
      const snap = String(style.scrollSnapType ?? 'none');
      if (snap !== 'none' && /\b(?:x|inline|both)\b/.test(snap)) return true;
    }
    return false;
  }

  // The page's result-count line ("8 properties found", "1,204 results"): the first short rendered text that says so
  // outside page chrome, or null.
  // The count names the results ("1,204 results", "7 tours") or says they were found ("6 rentals found").
  const RECORD_RESULT_COUNT = /(?:^|[\s:(])\d[\d,.  ]*\+?\s+(?:(?:results?|properties|stays|hotels|homes|rentals|places|items|products|listings|offers|deals|matches|jobs|vacancies|flights|cars|trips|tours|events|tickets|activities|restaurants|courses|articles|posts|options)\b|\p{L}+s\s+(?:found|available|matching|match)\b)/iu;
  function resultCountElement() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let nodes = 0;
    for (let node = walker.nextNode(); node && nodes < 20_000; node = walker.nextNode(), nodes++) {
      const parent = node.parentElement;
      // A count holds a digit: the cheap test first.
      if (!parent || !/\d/.test(node.nodeValue) || SKIP_TEXT_TAGS.has(parent.tagName.toUpperCase())
        || !RECORD_RESULT_COUNT.test(node.nodeValue)) continue;
      if ((parent.textContent ?? '').replace(/\s+/g, ' ').trim().length > 80 || recordChrome(parent)) continue;
      // A filter option's count ("412 places" beside a checkbox) is no result count; a sort control elsewhere under
      // the results container does not suppress the page's own count.
      const container = parent.parentElement;
      if (parent.closest('label,fieldset,form,select') || (container?.querySelector(RECORD_CHOICES)
        && cleanText(container.textContent) === cleanText(parent.textContent))) continue;
      if (!rendered(parent)) continue;
      return parent;
    }
    return null;
  }

  function recordResultCount(el) {
    if (!el) return null;
    const text = cleanText(el.textContent);
    const match = RECORD_RESULT_COUNT.exec(text);
    if (!match) return null;
    const raw = /(\d[\d,.  ]*\+?)/.exec(match[0])?.[1] ?? '';
    const value = Number(raw.replace(/\D/g, ''));
    if (!Number.isSafeInteger(value) || value < 0) return null;
    const qualifier = text.slice(0, match.index).trim();
    const approximate = raw.includes('+')
      || /\b(?:about|around|approximately|approx\.?|roughly|nearly|over|under|more than|less than|at least|at most|up to)\s*$/i.test(qualifier);
    return { value, ...(approximate ? { approximate: true } : {}) };
  }

  // Only explicit state from the primary list's own module: a select named as a sort, aria-sort on a column, and
  // previous/next controls in its pagination landmark (or with rel=next/prev). A secondary module lends no state.
  function recordResultState(countEl, idOf, group, secondary) {
    const state = {};
    const resultCount = recordResultCount(countEl);
    if (resultCount) state.resultCount = resultCount;
    const first = group?.members?.[0];
    let scope = document;
    if (first && countEl) {
      for (let node = first.parentElement; node; node = node.parentElement) {
        if (!node.contains(countEl)) continue;
        scope = node;
        break;
      }
    } else if (first) {
      scope = first.closest('section,article,main,[role="region"],[role="main"]') ?? document;
    }
    // A count above the list can make the scope include independent result modules. Exclude their controls while
    // keeping shared surrounding controls (for example, a sort and pager beside the primary list's section).
    const otherModules = secondary.map(({ group: other }) => {
      let container = other.members[0]?.parentElement;
      while (container && !other.members.every(member => container.contains(member))) container = container.parentElement;
      return container?.closest('section,article,aside,main,[role="region"],[role="main"]');
    }).filter(module => module && !module.contains(first));
    const all = selector => [...scope.querySelectorAll(selector)]
      .filter(el => !otherModules.some(module => module.contains(el)));
    const sorted = all('[aria-sort="ascending"],[aria-sort="descending"]')[0];
    if (sorted && rendered(sorted)) {
      const label = cleanText(sorted.textContent).slice(0, 80);
      if (label) state.sort = { label, direction: sorted.getAttribute('aria-sort') };
    } else {
      for (const select of all('select')) {
        if (!rendered(select) || !/\bsort(?:ed)?\s*(?:by)?\b/i.test(labelOf(select))) continue;
        const label = cleanText(select.selectedOptions?.[0]?.textContent).slice(0, 80);
        if (label) state.sort = { label };
        break;
      }
    }
    const navigation = all('nav,[role="navigation"]')
      .filter(nav => /pagination/i.test(nav.getAttribute('aria-label') ?? '') || nav.querySelector('[rel="next"],[rel="prev"]'));
    const candidates = new Set(all('[rel="next"],[rel="prev"]'));
    for (const nav of navigation) for (const el of nav.querySelectorAll('a,button,[role="button"]')) candidates.add(el);
    const pagination = {};
    for (const el of candidates) {
      if (!rendered(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const rel = el.getAttribute('rel');
      const label = labelOf(el);
      const kind = rel === 'next' ? 'next' : rel === 'prev' ? 'previous'
        : /^next(?:\s+page)?$/i.test(label) ? 'next' : /^previous(?:\s+page)?$/i.test(label) ? 'previous' : null;
      if (!kind || pagination[kind]) continue;
      pagination[kind] = idOf.get(el) ?? true;
    }
    for (const nav of navigation) {
      const current = nav.querySelector('[aria-current="page"]');
      const currentNumber = Number(cleanText(current?.textContent));
      if (current && /^\d+$/.test(cleanText(current.textContent))) pagination.current = currentNumber;
      const match = /\bpage\s+(\d+)\s+of\s+(\d+)\b/i.exec(cleanText(nav.textContent));
      if (match) {
        pagination.current = Number(match[1]);
        pagination.total = Number(match[2]);
      }
    }
    if (Object.keys(pagination).length) state.pagination = pagination;
    return Object.keys(state).length ? state : null;
  }

  // Main-results signals of a list (0-2): inside the main landmark (when the page has one), and after the page's
  // result-count line (else its main heading, h1).
  function recordMainSignals(group, marks) {
    const first = group.members[0];
    let signals = 0;
    if (marks.main && marks.main.contains(first)) signals++;
    const anchor = marks.count ?? marks.h1;
    if (anchor && !anchor.contains(first) && (anchor.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)) signals++;
    return signals;
  }

  // The lists of records on the page, best first: [{ group, score }].
  function recordLists() {
    const shapes = new Map();
    const stats = new Map();
    const scored = recordGroups(shapes, stats).map(group => withoutInserts(group, stats))
      .map(group => ({ group, score: recordScore(group, stats) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, RECORD_SCORED_GROUPS);
    const lost = new Set();
    const changed = new Set();
    for (const a of scored) {
      for (const b of scored) {
        if (a === b || lost.has(a) || lost.has(b)) continue;
        // a outer, b inner: some member of b sits inside a member of a.
        const outerSet = new Set(a.group.members);
        if (!b.group.members.some(member => ancestorIn(member.parentElement, outerSet))) continue;
        const verdict = containerWins(a.group, b.group, stats);
        if (verdict === null) continue;
        if (verdict === 'split') {
          a.group = { ...a.group, members: a.group.members.filter(member => !b.group.members.some(inner => member.contains(inner))) };
          changed.add(a);
          if (a.group.members.length < RECORD_MIN) lost.add(a);
          continue;
        }
        lost.add(verdict === 'outer' ? b : a);
      }
    }
    for (const entry of changed) if (!lost.has(entry)) entry.score = recordScore(entry.group, stats);
    const live = scored.filter(entry => !lost.has(entry) && entry.score > 0);
    if (!live.length) return [];
    const top = Math.max(...live.map(entry => entry.score));
    // Among the lists that score at least RECORD_LIST_SHARE of the best: every carousel after the other lists, then
    // the lists with more main-results signals first, then the higher score.
    const marks = { main: document.querySelector('main,[role="main"]'), h1: document.querySelector('h1'), count: resultCountElement() };
    const ranked = live.filter(entry => entry.score >= top * RECORD_LIST_SHARE).map(entry => {
      entry.carousel = recordCarousel(entry.group) ? 1 : 0;
      entry.main = recordMainSignals(entry.group, marks);
      // The same signals, one by one, for the wire (recordLists): whether the list sits inside the main landmark and
      // after the result-count line itself (not the h1 fallback). Structural facts only, never page text.
      const first = entry.group.members[0];
      entry.inMain = Boolean(marks.main && marks.main.contains(first));
      entry.afterCount = Boolean(marks.count && !marks.count.contains(first)
        && (marks.count.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING));
      entry.countElement = marks.count;
      return entry;
    }).sort((a, b) => (a.carousel - b.carousel) || (b.main - a.main) || (b.score - a.score));
    const accepted = [];
    for (const entry of ranked) {
      if (accepted.length >= MAX_RECORD_LISTS) break;
      if (accepted.some(other => overlaps(other.group, entry.group))) continue;
      accepted.push(entry);
    }
    // The best list is list 0.
    return accepted;
  }

  // The visible fields of one record in order: [{ text, owner, aria?, struck? }].
  function recordFields(member) {
    const fields = [];
    const owners = new Map();
    const hiddenCache = new Map();
    let nodes = 0;
    const ownerOf = parent => {
      if (owners.has(parent)) return owners.get(parent);
      let found = member;
      for (let el = parent; el && el !== member; el = el.parentElement) {
        const role = el.getAttribute('role');
        if (RECORD_FIELD_TAGS.has(el.tagName) || role === 'heading' || role === 'link' || role === 'button' || role === 'cell'
          || role === 'gridcell') {
          found = el;
          break;
        }
        const display = styleOf(el).display;
        if (display && !display.startsWith('inline') && display !== 'contents') {
          found = el;
          break;
        }
      }
      owners.set(parent, found);
      return found;
    };
    const srOnly = el => {
      if (!hiddenCache.has(el)) hiddenCache.set(el, visuallyHidden(el));
      return hiddenCache.get(el);
    };
    const struckOf = parent => {
      if (parent.closest('s,del,strike')) return true;
      for (let el = parent, depth = 0; el && depth < 3 && el !== member.parentElement; el = el.parentElement, depth++) {
        if (String(styleOf(el).textDecorationLine ?? '').includes('line-through')) return true;
      }
      return false;
    };
    const push = (text, owner, extra = {}) => {
      const last = fields.at(-1);
      if (last && last.owner === owner && !extra.aria && !last.aria && last.struck === Boolean(extra.struck)) {
        last.text = `${last.text} ${text}`;
        return;
      }
      fields.push({ text, owner, struck: Boolean(extra.struck), aria: Boolean(extra.aria) });
    };
    const visit = node => {
      if (++nodes > RECORD_NODE_BUDGET) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const content = node.nodeValue.replace(/\s+/g, ' ').trim();
        const parent = node.parentElement;
        if (!content || !parent) return;
        // Screen-reader-only text ("Opens in new window") is left out unless it holds a value ("Price: €310").
        if (srOnly(parent) && !/\d/.test(content)) return;
        push(content, ownerOf(parent), { struck: struckOf(parent) });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return;
      // A rating held only in an accessible name (stars drawn as glyphs, an image or an SVG): its label is the field.
      const label = cleanText(el.getAttribute('aria-label') || (el.tagName === 'IMG' ? el.getAttribute('alt') : '')
        || (el.getAttribute('role') === 'img' ? el.getAttribute('title') : ''));
      if (label && /\d/.test(label) && RECORD_RATING_WORDS.test(label) && recordRating(label)
        && !/\d/.test(el.textContent ?? '')) {
        fields.push({ text: label, owner: el, aria: true, struck: false });
        return;
      }
      if (SKIP_TEXT_TAGS.has(el.tagName.toUpperCase()) || RECORD_SKIP_TAGS.has(el.tagName)) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      for (const child of el.childNodes) visit(child);
    };
    for (const child of member.childNodes) visit(child);
    // Repeats: the same text twice in a row, or a short number repeated right after the field that holds it.
    const out = [];
    for (const field of fields) {
      field.text = cleanText(field.text);
      const last = out.at(-1);
      if (!field.text) continue;
      if (last && (last.text === field.text || (field.text.length <= 12 && last.text.includes(field.text)))) continue;
      out.push(field);
      if (out.length >= MAX_RECORD_FIELDS * 2) break;
    }
    return out;
  }

  // The title element of a record: its first heading with text, else its main link (the most worded link that is not
  // a call to action and holds no price), else null.
  function recordTitleElement(member, fields) {
    for (const heading of member.querySelectorAll(RECORD_HEADING)) {
      if (fields.some(field => heading === field.owner || heading.contains(field.owner))) return heading;
    }
    let best = null;
    let bestLetters = 0;
    for (const link of [member.matches('a[href]') ? member : null, ...member.querySelectorAll('a[href]')]) {
      if (!link) continue;
      const text = fields.filter(field => link === field.owner || link.contains(field.owner)).map(field => field.text).join(' ');
      if (!text || text.length > RECORD_TITLE_TEXT || RECORD_CTA.test(text) && text.split(/\s+/).length <= 3) continue;
      if (recordPrices(text).length || link === member) continue;
      const letters = (text.match(/\p{L}/gu) ?? []).length;
      if (letters >= 2 && letters > bestLetters) {
        best = link;
        bestLetters = letters;
      }
    }
    return best;
  }

  function recordHints(texts) {
    const hints = {};
    const prices = texts.flatMap(recordPrices);
    if (prices.length) {
      hints.price = prices[0];
      const distinct = [...new Map(prices.map(price => [price.replace(/\D/g, ''), price])).values()];
      if (distinct.length > 1) hints.prices = distinct.slice(0, 4);
    }
    const reviewsAt = texts.findIndex(text => RECORD_REVIEWS.test(text));
    if (reviewsAt >= 0) hints.reviews = Number(RECORD_REVIEWS.exec(texts[reviewsAt])[1].replace(/\D/g, ''));
    // Several ratings (a star class and a guest score): the rating is the one stated nearest the review count; every
    // distinct one is listed in `ratings`, so the core can match a bound to its scale.
    const ratings = [];
    texts.forEach((text, at) => {
      const rating = recordRating(text);
      if (rating && !ratings.some(item => item.value === rating.value && item.scale === rating.scale)) ratings.push({ ...rating, at });
    });
    if (ratings.length) {
      const best = reviewsAt < 0 ? ratings[0]
        : ratings.reduce((a, b) => (Math.abs(b.at - reviewsAt) < Math.abs(a.at - reviewsAt) ? b : a));
      hints.rating = best.value;
      if (best.scale) hints.scale = best.scale;
      if (ratings.length > 1) hints.ratings = ratings.slice(0, 4).map(({ value, scale }) => (scale ? { value, scale } : { value }));
    }
    const when = texts.filter(text => RECORD_TIME.test(text) || RECORD_DATE.test(text)).slice(0, 3);
    if (when.length) hints.when = when;
    const counts = texts.filter(text => RECORD_COUNT.test(text) && !recordPrices(text).length && !recordRating(text)
      && !RECORD_REVIEWS.test(text) && !when.includes(text)).slice(0, 3);
    if (counts.length) hints.counts = counts;
    return hints;
  }

  // One record entry (before the list's template fields are dropped and the text is capped).
  function readRecord(member, idOf) {
    const fields = recordFields(member);
    const struck = fields.filter(field => field.struck && recordPrices(field.text).length).length;
    const kept = fields.filter(field => !(field.struck && recordPrices(field.text).length));
    const titleEl = recordTitleElement(member, kept);
    const inTitle = field => Boolean(titleEl) && (titleEl === field.owner || titleEl.contains(field.owner));
    let title = kept.filter(inTitle).map(field => field.text).join(' ');
    let rest = kept.filter(field => !inTitle(field));
    if (!title) {
      const first = rest.findIndex(field => (field.text.match(/\p{L}/gu) ?? []).length >= 3 && !recordPrices(field.text).length
        && !recordRating(field.text) && !RECORD_SPONSORED.test(field.text));
      if (first >= 0) {
        title = rest[first].text;
        rest = rest.filter((_, i) => i !== first);
      }
    }
    const link = titleEl ? titleEl.closest('a[href]') ?? titleEl.querySelector('a[href]') : null;
    const anchor = link ?? (member.matches('a[href]') ? member : member.querySelector('a[href]'));
    const record = { title: title.slice(0, RECORD_TITLE_TEXT), fields: rest.map(field => field.text) };
    if (anchor && /^https?:/i.test(anchor.href)) record.href = anchor.href.slice(0, 500);
    const ref = anchor ? idOf.get(anchor) : undefined;
    if (ref !== undefined) record.ref = ref;
    const all = [record.title, ...record.fields];
    if (all.some(text => RECORD_SPONSORED.test(text) && text.length <= 40)
      || /^(?:sponsored|ad|promoted)$/i.test(member.getAttribute('aria-label') ?? '')) record.sponsored = true;
    if (all.some(text => RECORD_UNAVAILABLE.test(text))) record.unavailable = true;
    if (struck) record.struck = struck;
    if (!intersectsViewport(member.getBoundingClientRect())) record.offscreen = true;
    return record;
  }

  // Template text of a list: a field without a digit that most of its records repeat.
  function dropTemplateFields(records) {
    if (records.length < 4) return;
    const counts = new Map();
    for (const record of records) {
      for (const text of new Set(record.fields.map(field => field.toLowerCase()))) counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    const template = new Set([...counts].filter(([text, count]) => count >= Math.max(3, records.length * RECORD_TEMPLATE_SHARE)
      && !/\d/.test(text) && text.length <= 60 && !RECORD_SPONSORED.test(text) && !RECORD_UNAVAILABLE.test(text)).map(([text]) => text));
    if (!template.size) return;
    for (const record of records) record.fields = record.fields.filter(field => !template.has(field.toLowerCase()));
  }

  // The record's fields within RECORD_TEXT (title and fields joined by " · "): the longest fields without a value go
  // first, then fields from the end; each field at most RECORD_FIELD_TEXT characters.
  function capRecord(record) {
    record.fields = [...new Set(record.fields.map(field => field.slice(0, RECORD_FIELD_TEXT)))]
      .filter(field => field !== record.title).slice(0, MAX_RECORD_FIELDS);
    const length = () => [record.title, ...record.fields].filter(Boolean).join(' · ').length;
    const valued = field => recordPrices(field).length > 0 || Boolean(recordRating(field)) || RECORD_SPONSORED.test(field)
      || RECORD_UNAVAILABLE.test(field);
    while (length() > RECORD_TEXT) {
      let drop = -1;
      for (let i = 0; i < record.fields.length; i++) {
        if (valued(record.fields[i])) continue;
        if (drop < 0 || record.fields[i].length > record.fields[drop].length) drop = i;
      }
      if (drop < 0) drop = record.fields.length - 1;
      if (drop < 0) break;
      record.fields.splice(drop, 1);
    }
    if (record.title.length > RECORD_TEXT) record.title = record.title.slice(0, RECORD_TEXT);
  }

  // The page's records: { records, lists, state, truncated, recordOf(el) -> { id?, member } | null }.
  function detectRecords(idOf) {
    const empty = { records: [], lists: [], state: null, truncated: false, recordOf: () => null, members: [] };
    let lists;
    try {
      lists = recordLists();
    } catch {
      return empty;
    }
    if (!lists.length) return empty;
    const memberOf = new Map();
    const records = [];
    const out = [];
    lists.forEach(({ group, carousel, inMain, afterCount }, list) => {
      const read = [];
      for (const member of group.members) {
        memberOf.set(member, { member, list, id: null });
        if (records.length + read.length >= MAX_RECORDS) continue;
        const record = readRecord(member, idOf);
        if (!record.title && record.fields.length < 2) continue;
        read.push({ member, record });
      }
      dropTemplateFields(read.map(entry => entry.record));
      for (const { member, record } of read) {
        capRecord(record);
        const hints = recordHints([record.title, ...record.fields]);
        if (Object.keys(hints).length) record.hints = hints;
        const id = `r${records.length + 1}`;
        memberOf.get(member).id = id;
        records.push({ id, list, ...record });
      }
      // Position signals, each only when true: inside the main landmark, after the result-count line, a carousel.
      out.push({ list, total: group.members.length, kept: read.length,
        ...(inMain ? { main: true } : {}), ...(afterCount ? { afterCount: true } : {}), ...(carousel ? { carousel: true } : {}) });
    });
    const cache = new Map();
    const recordOf = el => {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
      if (cache.has(el)) return cache.get(el);
      const chain = [];
      let found = null;
      for (let node = el, depth = 0; node && depth < 60; node = node.parentElement, depth++) {
        if (cache.has(node)) {
          found = cache.get(node);
          break;
        }
        chain.push(node);
        if (memberOf.has(node)) {
          found = memberOf.get(node);
          break;
        }
      }
      for (const node of chain) cache.set(node, found);
      return found;
    };
    const members = [...memberOf.values()].filter(entry => entry.id).map(entry => entry.member);
    const state = recordResultState(lists[0].countElement, idOf, lists[0].group, lists.slice(1));
    return { records, lists: out, state, truncated: out.some(entry => entry.total > entry.kept), recordOf, members };
  }

  // finishBlocks over the cap with records: the blocks inside a record after its first one (the record entry carries
  // their text; past MAX_RECORDS the list's total says it was cut) go first, from the end, so the cap keeps the rest
  // of the page.
  function recordBlockBudget(ordered, recordOf, max) {
    if (ordered.length <= max) return ordered;
    const anchors = new Set();
    const inside = ordered.map(entry => {
      const found = recordOf(entry.el);
      if (!found) return false;
      if (!anchors.has(found.member)) {
        anchors.add(found.member);
        return false;
      }
      return true;
    });
    let excess = ordered.length - max;
    const drop = new Set();
    for (let i = ordered.length - 1; i >= 0 && excess > 0; i--) {
      if (!inside[i]) continue;
      drop.add(i);
      excess--;
    }
    return ordered.filter((_, i) => !drop.has(i));
  }

  // The wire description and risk of one selected control: { control, risk }. `item` is a selectControls entry
  // ({ el, rect, label, offscreen, consentKind, unnamed }).
  // ---------------------------------------------------------------------------------------------------------------
  // Secret redaction (src/secrets.js, docs/REFERENCE.md "Secret redaction"): the primary barrier. Every string this
  // script returns (observe, execute, settleAndObserve, locate, error messages) is scrubbed here, so a raw key,
  // token, password, private key, card number or one-time code never reaches the worker or the daemon. The live page
  // is never touched: the scan reads the DOM and the redaction works on the extracted strings only.
  // ---------------------------------------------------------------------------------------------------------------
  //
  // Each secret becomes a placeholder tagged `~<salted hash>`; the worker numbers the tags per session ([secret:3 ...]).
  // The scan (secretScan) walks the text of the document, its open shadow roots and readable frames once per
  // observation and registers the values found with their DOM context (the 60 characters before them, a column
  // header, a row's first cell, a dt, a preceding label or aria-label), the recovery codes under a "Recovery codes"
  // heading, the values in an environment variable row, private-key bodies split over several nodes, and on a secret
  // page (or in Strict) every code/pre/kbd run of 16 or more characters. Each reported string then loses the
  // registered values and anything the rules find in the string itself. secretNodes() lists the elements that held a
  // value (for the screenshot redaction to come, which will black out their rects).
  const SECRET_SCAN_NODES = 30_000;
  const SECRET_MAX_NODES = 400;
  // Text before a node that can lead a value in the next one: password wording ("Password: ") or an UPPER_SNAKE name.
  const SECRET_LEAD_HINT = /[Pp]ass(?:word|wd|code|phrase)|PASS|pwd|PWD|[A-Z0-9]_[A-Z0-9]/;
  const SECRET_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  // Reported fields that are never page text: protocol ids and fixed words.
  const SECRET_SKIP_KEYS = new Set(['revision', 'documentId', 'id', 'role', 'type', 'risk', 'kind', 'linkTarget', 'labelHash', 'gate', 'cls']);
  // Reported fields that hold a URL (secretScrubText's URL form).
  const SECRET_URL_KEYS = new Set(['url', 'href', 'fromUrl', 'toUrl', 'origin']);
  const SECRET_CODE = 'code,pre,kbd,samp';
  // Text worth a close look: a token of 8 or more characters with a digit, digit or base32 groups (a card, a code, a
  // TOTP seed), password wording, a URL or a parameter.
  const SECRET_SCAN_HINT = /(?<!\S)(?=\S*\d)\S{8,}|\d{4}[ -]\d{4}|(?<![A-Za-z0-9])[A-Za-z2-7]{4} [A-Za-z2-7]{4} [A-Za-z2-7]{4}|pass(?:word|wd|code|phrase)|pwd|:\/\/|=/i;
  const SECRET_HEADING = 'h1,h2,h3,h4,h5,h6,[role="heading"],caption,legend,label,dt,th,strong,b';
  // A text field that holds a password whatever its current type (a show-password toggle makes it type=text).
  const SECRET_PASSWORD_FIELD = /(?:^|[^a-z])(?:pass(?:word|wd|code|phrase)?|pwd)(?![a-z])/i;
  const SECRET_FIELD_LABEL = /(?<![a-z])(?:api[\s_-]?key|secret|token|private[\s_-]?key|password|credential)(?![a-z])/i;
  const SECRET_PEM_BODY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----([\s\S]*?)(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
  // The salt for this document's tags when the worker sent none (a test bridge): the worker's lease salt keeps tags
  // stable across documents.
  const secretDocumentSalt = randomId();
  // From the worker (useSecrets): Strict mode, the user's Relaxed origins (known formats only), the lease salt and
  // `vault` (the worker keeps the values it is handed for secret handles; a bridge without the worker never asks).
  let secretSettings = { strict: false, relaxed: [], salt: null, vault: false };
  // Secret handles (docs/REFERENCE.md "Secret handles"): the values this script redacted from page text or a read-only
  // field since the last reported result, by tag: { value, kind, pre }. Handed to the worker under VAULT_KEY with the
  // next reported result (only when the worker asks for it), never to anything else. Payment cards and URL parameters
  // are never handed over.
  const VAULT_KEY = '__faiVault';
  const VAULT_SKIP_KINDS = new Set(['card', 'url-param']);
  const VAULT_MAX = 50;
  const secretVaultSink = new Map();
  // Fields this script filled with a secret (fill_secret) and the values it put there: a filled field is a secret
  // field from then on (never reported, boxed on screenshots), and the value is redacted wherever the page echoes it.
  const secretFilledFields = new WeakSet();
  const secretFilledValues = new Map();
  // A field that takes a secret (fill_secret): a password input, or a single-line text input whose label, name, id,
  // placeholder or autocomplete says key, token, secret, password or credential.
  const SECRET_TARGET_WORDS = /(?<![a-z])(?:api[\s_-]?keys?|keys?|tokens?|secrets?|passwords?|passwd|passphrase|credentials?)(?![a-z])/i;
  const SECRET_TARGET_DENY = /(?<![a-z])(?:search|query|comments?|messages?|notes?|descriptions?|subject|email|e-mail|user(?:name)?|login|one[\s_-]?time|otp|codes?)(?![a-z])/i;
  // This observation's scan inputs (roots and frames) and its scan, rebuilt lazily after each observeRaw().
  let secretInputs = { roots: [], frames: [] };
  let secretState = null;
  let secretScanned = null;

  function useSecrets(settings) {
    if (!settings || typeof settings !== 'object') return;
    secretSettings = {
      strict: settings.mode === 'strict',
      relaxed: Array.isArray(settings.relaxed) ? settings.relaxed.filter(origin => typeof origin === 'string') : [],
      salt: typeof settings.salt === 'string' && settings.salt ? settings.salt : null,
      vault: settings.vault === true,
    };
    secretState = null;
    secretScanned = null;
  }

  function secretSalt() {
    return secretSettings.salt ?? secretDocumentSalt;
  }

  // The page's mode: relaxed (a Relaxed origin: known formats only), a secret page (path or top heading), strict
  // (Strict mode or a secret page: the generic rule without context, code runs masked).
  function secretMode() {
    if (secretState) return secretState;
    const relaxed = secretSettings.relaxed.includes(location.origin);
    let page = false;
    if (!relaxed) {
      const headings = [];
      for (const doc of [document, ...secretInputs.frames.map(frame => frame.doc)]) {
        for (const heading of doc.querySelectorAll('h1,h2,h3,[role="heading"]')) {
          headings.push(cleanText(heading.textContent).slice(0, 120));
          if (headings.length >= 40) break;
        }
      }
      page = secretPageSignal(location.pathname, headings);
    }
    // A credentials page elsewhere in the tab (pageContext) makes this document strict too; `ownPage` is this one's.
    const ownPage = page;
    if (!relaxed && pageContext.secretPage) page = true;
    secretState = { relaxed, page, ownPage, strict: !relaxed && (secretSettings.strict || page) };
    return secretState;
  }

  // Label text around an element that says what its value is: its column header and row label in a table, the dt
  // before a dd, aria-label/title and the text of the previous sibling up to three levels up.
  function secretLabelContext(el) {
    const parts = [];
    const cell = el.closest('td,th,[role="cell"],[role="gridcell"]');
    if (cell?.parentElement) {
      const row = cell.parentElement;
      const index = Array.prototype.indexOf.call(row.children, cell);
      const table = cell.closest('table,[role="table"],[role="grid"]');
      const header = table?.querySelector('thead tr') ?? table?.querySelector('tr');
      if (header && header !== row && index >= 0) parts.push(header.children[index]?.textContent ?? '');
      if (row.firstElementChild && row.firstElementChild !== cell) parts.push(row.firstElementChild.textContent);
    }
    const dd = el.closest('dd');
    if (dd?.previousElementSibling) parts.push(dd.previousElementSibling.textContent);
    for (let node = el, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
      for (const name of ['aria-label', 'title']) {
        const value = node.getAttribute?.(name);
        if (value) parts.push(value);
      }
      const previous = node.previousElementSibling;
      if (previous) parts.push(String(previous.textContent ?? '').slice(-80));
    }
    return cleanText(parts.join(' ')).slice(-240);
  }

  // The scan: { values: [[value, placeholder]] (longest first), pem: [bodies], nodes: [{ el, kind }] }.
  function secretScan() {
    if (secretScanned) return secretScanned;
    const { relaxed, strict } = secretMode();
    const salt = secretSalt();
    const values = new Map();
    const nodes = [];
    const pem = [];
    let overflow = false;
    const register = (value, kind, el, pre = '') => {
      if (typeof value !== 'string' || value.length < 6 || value.startsWith('[secret:')) return;
      if (!values.has(value)) {
        values.set(value, [secretPlaceholder(`~${secretHash(value, salt)}`, kind === 'filled' ? 'generic' : kind, value, pre), kind, pre]);
      }
      if (nodes.some(node => node.el === el)) return;
      // Past the cap the screenshot cannot box every holder: it withholds the frame (redactionRects `incomplete`).
      if (nodes.length < SECRET_MAX_NODES) nodes.push({ el, kind, tag: secretHash(value, salt) });
      else overflow = true;
    };
    const bodies = [document.body, ...secretInputs.roots, ...secretInputs.frames.map(frame => frame.doc.body)].filter(Boolean);
    let walked = 0;
    for (const root of bodies) {
      // A private key split over several nodes (one per line): its body, matched by substring in every string.
      const whole = root.textContent ?? '';
      if (whole.includes('PRIVATE KEY')) {
        for (const match of whole.matchAll(SECRET_PEM_BODY)) {
          const body = match[1].replace(/\s+/g, '');
          if (body.length >= 16) pem.push(body);
        }
      }
      if (relaxed) continue;
      const doc = root.ownerDocument ?? root;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let tail = '';
      let recovery = 0;
      for (let node = walker.nextNode(); node && walked < SECRET_SCAN_NODES; node = walker.nextNode()) {
        walked++;
        const parent = node.parentElement;
        if (!parent || SECRET_SKIP_TAGS.has(parent.tagName)) continue;
        const content = cleanText(node.nodeValue);
        if (!content) continue;
        // A short line that says recovery or backup codes opens a recovery-code list; a heading saying anything else
        // closes it.
        if (content.length <= 120 && SECRET_RECOVERY_CONTEXT.test(content)) recovery = 80;
        else if (recovery > 0) recovery = parent.closest(SECRET_HEADING) ? 0 : recovery - 1;
        // Most text holds nothing secret-shaped (SECRET_SCAN_HINT); only the rest is looked at closely. A line of a
        // private key is left to the key's own placeholder (secretScrubText).
        const pemLine = pem.length > 0 && pem.some(body => body.includes(content.replace(/\s+/g, '')));
        // Its holder is still boxed on screenshots, under the key's own tag.
        if (pemLine && content.replace(/\s+/g, '').length >= 16 && !nodes.some(node => node.el === parent)) {
          const body = pem.find(item => item.includes(content.replace(/\s+/g, '')));
          if (nodes.length < SECRET_MAX_NODES) nodes.push({ el: parent, kind: 'private-key', tag: secretHash(body, salt) });
          else overflow = true;
        }
        if (!pemLine && content.length >= 6 && SECRET_SCAN_HINT.test(content)) {
          let spans = secretFind(content, { strict, context: tail });
          // The label around the element (a column header, a dt, an aria-label) is read only for a key-shaped
          // value the text before it did not explain.
          if (!strict && !spans.some(span => span.kind === 'generic')
            && [...content.matchAll(SECRET_CANDIDATE)].some(match => secretKeyShaped(match[0]))) {
            spans = secretFind(content, { strict, context: `${secretLabelContext(parent)} ${tail}` });
          }
          for (const span of spans) register(content.slice(span.start, span.end), span.kind, parent, span.pre);
          // A value this script filled as a secret, echoed by the page (a preview of the field).
          for (const value of secretFilledValues.keys()) if (content.includes(value)) register(value, 'filled', parent);
          // A label in the text before this node ("Temporary password: ", then the value in its own element): the
          // rules that need their lead text run on both together, and only what falls inside this node counts.
          if (!spans.length && SECRET_LEAD_HINT.test(tail)) {
            const lead = `${tail} `;
            for (const span of secretFind(`${lead}${content}`, { strict })) {
              if (span.start >= lead.length) {
                register(content.slice(span.start - lead.length, span.end - lead.length), span.kind, parent, span.pre);
              }
            }
          }
          if (recovery > 0) {
            for (const match of content.matchAll(SECRET_RECOVERY)) {
              if (/\d/.test(match[0])) register(match[0], 'recovery-code', parent);
            }
          }
          // An environment variable row: the cells after a secret-named first cell.
          const cell = parent.closest('td,[role="cell"],[role="gridcell"]');
          const first = cell?.parentElement?.firstElementChild;
          if (first && first !== cell && SECRET_ENV_NAME.test(cleanText(first.textContent))) {
            for (const match of content.matchAll(/[^\s"'|,;]{6,}/g)) {
              if (/[\d:/@.+=_-]/.test(match[0])) register(match[0], 'generic', parent);
            }
          }
        }
        // Strict (or a secret page): every long run in code, pre, kbd or samp that no rule above named, unless it is
        // words joined by dashes, dots or underscores (a header name such as X-RateLimit-Remaining, a file path).
        if (strict && content.length >= 16 && parent.closest(SECRET_CODE)) {
          const named = secretFind(content, { strict });
          for (const match of content.matchAll(/\S{16,}/g)) {
            const end = match.index + match[0].length;
            const parts = match[0].split(/[-_./:]+/).filter(Boolean);
            if (parts.length >= 2 && parts.every(part => /^[A-Za-z]+$/.test(part) || /^\d+$/.test(part))) continue;
            if (!named.some(span => span.start < end && span.end > match.index)) register(match[0], 'generic', parent);
          }
        }
        tail = `${tail} ${content}`.slice(-SECRET_CONTEXT_CHARS);
      }
    }
    // `incomplete`: the walk hit its node budget or the holder cap, so some text was never looked at closely.
    // Filled secrets are redacted on every page, Relaxed origins included.
    for (const value of secretFilledValues.keys()) {
      if (!values.has(value)) values.set(value, [secretPlaceholder(`~${secretHash(value, salt)}`, 'generic', value), 'filled', '']);
    }
    secretScanned = { values: [...values].map(([value, [placeholder, kind, pre]]) => [value, placeholder, kind, pre])
      .sort((a, b) => b[0].length - a[0].length), pem, nodes,
      incomplete: overflow || walked >= SECRET_SCAN_NODES };
    return secretScanned;
  }

  /**
   * The elements that held a secret in the current observation: [{ el, kind, tag, rect }] (rect in top-document CSS
   * px). redactionRects() boxes them on every screenshot.
   */
  function secretNodes() {
    return secretScan().nodes.filter(node => node.el.isConnected).map(node => {
      const frame = frameByDoc.get(node.el.ownerDocument);
      return { ...node, rect: frame ? toTop(boxOf(node.el), frame) : boxOf(node.el) };
    });
  }

  // --- Screenshot redaction (docs/REFERENCE.md "Screenshot redaction") -----------------------------------------
  // The worker asks for the boxes to black out right before captureVisibleTab and again right after; the offscreen
  // document fills them on the captured pixels. The page itself is never changed: no style, no attribute, no element.
  // Between the two queries a watch (a MutationObserver and scroll, resize and input listeners, all in this isolated
  // world, so the page cannot see them) marks the frame dirty when anything could have moved or shown a secret.
  const REDACT_PAD = 4;
  const REDACT_MAX_RECTS = 400;
  const REDACT_FIELD_BUDGET = 3000;
  const REDACT_WATCH_MS = 5000;
  // Cross-origin frames of payment and sign-in widgets: always boxed, whatever the mode.
  const REDACT_WIDGET_HOST = /(?:^|\.)(?:stripe\.com|stripe\.network|braintreegateway\.com|braintree-api\.com|pay\.google\.com|accounts\.google\.com|paypal\.com|paypalobjects\.com|adyen\.com|adyenpayments\.com|checkout\.com|squareup\.com|squarecdn\.com|klarna\.com|klarnaservices\.com|recurly\.com|chargebee\.com|appleid\.apple\.com|apple-pay-gateway\.apple\.com|login\.microsoftonline\.com|login\.live\.com|okta\.com|auth0\.com|authorize\.net|worldpay\.com|mollie\.com|razorpay\.com|hcaptcha\.com|paddle\.com|fastspring\.com|2checkout\.com|cybersource\.com|globalpay\.com|bluesnap\.com)$/i;
  // Attribute changes that can show or hide text (a show-password toggle flips `type`).
  const REDACT_ATTRIBUTES = ['type', 'hidden', 'open', 'style', 'class', 'aria-hidden', 'value'];
  let redactWatch = null;

  function redactDisarm() {
    if (!redactWatch) return null;
    const watch = redactWatch;
    redactWatch = null;
    clearTimeout(watch.timer);
    for (const off of watch.off) {
      try {
        off();
      } catch {
        // A frame went away.
      }
    }
    return watch;
  }

  function redactArm(docs, roots) {
    redactDisarm();
    const watch = { dirty: false, off: [], timer: null };
    const mark = () => { watch.dirty = true; };
    const observer = new MutationObserver(records => {
      if (watch.dirty) return;
      for (const record of records) {
        if (record.type !== 'attributes' || ['type', 'hidden', 'open', 'value'].includes(record.attributeName)) {
          watch.dirty = true;
          return;
        }
        // A style or class change matters only where text worth a look (or a field) sits under it.
        const target = record.target;
        const text = target.textContent ?? '';
        if (text.length > 50_000 || SECRET_SCAN_HINT.test(text) || target.querySelector?.('input,textarea')) {
          watch.dirty = true;
          return;
        }
      }
    });
    const options = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: REDACT_ATTRIBUTES };
    for (const node of [...docs, ...roots]) {
      try {
        observer.observe(node, options);
      } catch {
        // A frame went away.
      }
    }
    watch.off.push(() => observer.disconnect());
    for (const doc of docs) {
      const view = doc.defaultView;
      if (!view) continue;
      for (const type of ['scroll', 'input']) {
        view.addEventListener(type, mark, { capture: true, passive: true });
        watch.off.push(() => view.removeEventListener(type, mark, { capture: true }));
      }
    }
    watch.timer = setTimeout(redactDisarm, REDACT_WATCH_MS);
    redactWatch = watch;
  }

  // A field whose value must not show in a screenshot: a password field (whatever its value, whatever its current
  // type), a payment field, or a field that holds a secret (secretField).
  function redactField(el) {
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'hidden', 'file', 'range',
      'color'].includes(el.type)) return null;
    if (el.tagName === 'INPUT' && el.type === 'password') return 'password';
    if (paymentField(el)) return 'card';
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      if (!el.isContentEditable) return null;
      const text = (el.textContent ?? '').slice(0, 4000);
      const { strict, relaxed } = secretMode();
      return text.length >= 6 && secretFind(text, { strict, relaxed }).length ? 'secret' : null;
    }
    return secretField(el, el.getAttribute('aria-label') ?? el.labels?.[0]?.textContent ?? '');
  }

  function redactHost(el) {
    try {
      return new URL(el.getAttribute('src') || el.getAttribute('data') || 'about:blank', el.baseURI).hostname;
    } catch {
      return '';
    }
  }

  /**
   * The boxes the next screenshot must black out, in top-document viewport CSS px, padded by REDACT_PAD and clipped
   * to the viewport: [{x, y, width, height, kind, label?}]. Every secret holder (secretNodes), every password,
   * payment or secret field, every cross-origin frame of a payment or sign-in widget, and in Strict mode or on a
   * secret page also every canvas, every other cross-origin frame and every code or pre block. `label` is the
   * holder's tag (`[secret:~<hash>]`), which the worker numbers like the text. `arm` starts the dirty watch (the
   * query before the capture); without it the watch ends and `dirty` says whether anything changed meanwhile.
   * `incomplete`: the scan could not look at everything (node budget, holder or box cap): the frame is withheld.
   */
  function redactionRects({ arm = false } = {}) {
    const roots = collectShadowRoots();
    const { frames, crossOrigin } = collectFrames();
    frameByDoc = frames;
    secretInputs = { roots, frames: Array.from(frames.values()) };
    secretState = null;
    secretScanned = null;
    const scan = secretScan();
    const { strict } = secretMode();
    const rects = [];
    let incomplete = scan.incomplete === true;
    const add = (rect, kind, label) => {
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
      let left = rect.left ?? rect.x;
      let top = rect.top ?? rect.y;
      let right = left + rect.width;
      let bottom = top + rect.height;
      if (rect.clip) {
        left = Math.max(left, rect.clip.left);
        top = Math.max(top, rect.clip.top);
        right = Math.min(right, rect.clip.right);
        bottom = Math.min(bottom, rect.clip.bottom);
      }
      left = Math.max(0, left - REDACT_PAD);
      top = Math.max(0, top - REDACT_PAD);
      right = Math.min(innerWidth, right + REDACT_PAD);
      bottom = Math.min(innerHeight, bottom + REDACT_PAD);
      if (right <= left || bottom <= top) return;
      if (rects.length >= REDACT_MAX_RECTS) {
        incomplete = true;
        return;
      }
      const x = Math.floor(left);
      const y = Math.floor(top);
      const box = { x, y, width: Math.ceil(right - x), height: Math.ceil(bottom - y), kind };
      if (label) box.label = label;
      rects.push(box);
    };
    for (const node of scan.nodes) {
      if (node.el.isConnected) add(boxOf(node.el), node.kind, node.tag ? `[secret:~${node.tag}]` : null);
    }
    const docs = [document, ...frames.keys()];
    const trees = [...docs, ...roots];
    let fields = 0;
    for (const tree of trees) {
      for (const el of tree.querySelectorAll('input,textarea,[contenteditable]:not([contenteditable="false"])')) {
        if (++fields > REDACT_FIELD_BUDGET) {
          incomplete = true;
          break;
        }
        const kind = redactField(el);
        if (kind) add(boxOf(el), kind);
      }
    }
    const readable = new Set(Array.from(frames.values(), frame => frame.el));
    // The cross-origin frames listed as slots (frameBoxes below) are the worker's to box or place; every other frame,
    // embed or object this script does not read (past the slot or frame caps, deeper than MAX_FRAME_DEPTH, not found in
    // window.frames, an <object> or <embed>) is boxed here, whatever the mode.
    const frameBoxes = crossOrigin.length ? crossOriginSlots(crossOrigin).map(({ path, box, clip }) => ({ path, box, clip })) : [];
    for (const tree of trees) {
      for (const el of tree.querySelectorAll('iframe,frame,embed,object')) {
        if (readable.has(el)) continue;
        const widget = REDACT_WIDGET_HOST.test(redactHost(el));
        if (widget || strict || !slotted.has(el)) add(boxOf(el), widget ? 'widget' : 'frame');
      }
      if (strict) {
        for (const el of tree.querySelectorAll(`canvas,${SECRET_CODE}`)) add(boxOf(el), el.tagName === 'CANVAS' ? 'canvas' : 'code');
      }
    }
    let dirty = false;
    if (arm) redactArm(docs, roots);
    else dirty = redactDisarm()?.dirty ?? true;
    // The cross-origin frames as they sit now ({path, box, clip}): the worker places an approved frame's own boxes by
    // them and boxes every frame it did not read (numbers and paths only).
    return {
      rects,
      ...(frameBoxes.length ? { frameBoxes } : {}),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
      strict,
      ...(arm ? {} : { dirty }),
      ...(incomplete ? { incomplete: true } : {}),
    };
  }

  /**
   * One reported string, scrubbed: registered values, private-key fragments, then the rules. A URL (`url: true`) gets
   * the URL rules only (known formats, signed parameters, a password), never the generic rule: its origin and path
   * stay readable.
   */
  function secretScrubText(text, url = false) {
    if (typeof text !== 'string' || text.length < 6) return text;
    const scan = secretScan();
    const { relaxed, strict } = secretMode();
    if (url) {
      let out = text;
      for (const [value, placeholder] of scan.values) if (out.includes(value)) out = out.split(value).join(placeholder);
      return secretRedactUrl(out, { salt: secretSalt() });
    }
    let out = text;
    for (const [value, placeholder, kind, pre] of scan.values) {
      if (!out.includes(value)) continue;
      out = out.split(value).join(placeholder);
      vaultValue(value, kind, pre);
    }
    if (scan.pem.length) {
      out = out.replace(/[A-Za-z0-9+/=]{16,}/g, run => {
        const body = scan.pem.find(item => item.includes(run));
        return body ? secretPlaceholder(`~${secretHash(body, secretSalt())}`, 'private-key', run) : run;
      });
    }
    // secretRedactText, keeping each value it replaces for the vault.
    const spans = secretFind(out, { strict, relaxed });
    if (!spans.length) return out;
    let redacted = '';
    let at = 0;
    for (const span of spans) {
      const value = out.slice(span.start, span.end);
      redacted += out.slice(at, span.start) + secretPlaceholder(`~${secretHash(value, secretSalt())}`, span.kind, value, span.pre);
      vaultValue(value, span.kind, span.pre);
      at = span.end;
    }
    return redacted + out.slice(at);
  }

  // Keeps one redacted value for the worker's vault (secret handles): page text and read-only fields only, never a
  // card number, a URL parameter or a value this script filled itself.
  function vaultValue(value, kind, pre = '') {
    if (!secretSettings.vault || VAULT_SKIP_KINDS.has(kind) || kind === 'filled' || typeof value !== 'string' || value.length < 6
      || secretFilledValues.has(value)) return;
    const tag = secretHash(value, secretSalt());
    secretVaultSink.delete(tag);
    secretVaultSink.set(tag, { value, kind, pre: pre ?? '' });
    while (secretVaultSink.size > VAULT_MAX) secretVaultSink.delete(secretVaultSink.keys().next().value);
  }

  // A reported result with the values redacted since the last one, for the worker (under VAULT_KEY).
  function withVault(result) {
    if (!secretSettings.vault || !secretVaultSink.size || !result || typeof result !== 'object' || Array.isArray(result)) return result;
    const found = Array.from(secretVaultSink, ([tag, entry]) => ({ tag, value: entry.value, kind: entry.kind, pre: entry.pre,
      origin: location.origin }));
    secretVaultSink.clear();
    return { ...result, [VAULT_KEY]: found };
  }

  // Whether a field takes a secret (fill_secret): an enabled, editable password input, or a text input whose label,
  // name, id, placeholder or autocomplete says key, token, secret, password or credential. Never a textarea, a
  // contenteditable, a search, comment, email, username or one-time-code field, a payment field or anything but a
  // single-line input.
  function secretTarget(el) {
    if (!el || el.tagName !== 'INPUT' || !el.isConnected || el.readOnly || el.disabled || paymentField(el)) return false;
    const role = el.getAttribute('role');
    if (role && !['textbox', 'none', 'presentation'].includes(role)) return false;
    const autocomplete = String(el.getAttribute('autocomplete') ?? '').toLowerCase();
    if (/one-time-code|username|email/.test(autocomplete)) return false;
    if (el.closest('[role="search"],search') || el.form?.querySelector('input[type="search"]')) return false;
    // A password field of a sign-in form (the current password, next to a username or email) is never one.
    if (el.type === 'password') {
      return !/current-password/.test(autocomplete) && !el.form?.querySelector('input[type="email"],input[autocomplete~="username"],input[autocomplete~="email"]');
    }
    if (el.type !== 'text') return false;
    const words = [el.labels?.[0]?.textContent, el.getAttribute('aria-label'), labelledByText(el), el.placeholder, el.title,
      attributeTokens(el.name).join(' '), attributeTokens(el.id).join(' '), autocomplete]
      .filter(word => typeof word === 'string' && word.trim()).map(word => cleanText(word).slice(0, 120));
    if (words.some(word => SECRET_TARGET_DENY.test(word))) return false;
    return /(?:^|\s)new-password(?:\s|$)/.test(autocomplete) || words.some(word => SECRET_TARGET_WORDS.test(word));
  }

  // A read-only field that shows a secret (a new key with a copy button), or a field this script filled with one: its
  // placeholder; a shown value is kept for the vault like page text.
  function secretFieldValue(el, label) {
    const value = String(el.value ?? '');
    if (value.length < 6) return null;
    if (secretFilledFields.has(el)) return secretPlaceholder(`~${secretHash(value, secretSalt())}`, 'generic', value);
    const { strict, relaxed } = secretMode();
    const context = `${label} ${el.getAttribute('aria-label') ?? ''} ${el.name} ${el.id} ${el.placeholder ?? ''}`;
    const span = secretFind(value, { strict, relaxed, context }).find(item => item.start === 0 && item.end === value.length);
    const kind = span?.kind ?? 'generic';
    vaultValue(value, kind, span?.pre ?? '');
    return secretPlaceholder(`~${secretHash(value, secretSalt())}`, kind, value, span?.pre ?? '');
  }

  // After fill_secret: the field holds a secret from now on, and the value is redacted wherever the page shows it.
  function rememberFilledSecret(el, value) {
    secretFilledFields.add(el);
    secretFilledValues.delete(value);
    secretFilledValues.set(value, true);
    while (secretFilledValues.size > 20) secretFilledValues.delete(secretFilledValues.keys().next().value);
    secretScanned = null;
  }

  /** A reported value with every string in it scrubbed (secretScrubText), protocol fields left alone. */
  function secretScrub(value, key = '') {
    if (typeof value === 'string') return SECRET_SKIP_KEYS.has(key) ? value : secretScrubText(value, SECRET_URL_KEYS.has(key));
    if (Array.isArray(value)) return value.map(item => secretScrub(item, key));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [name, item] of Object.entries(value)) out[name] = secretScrub(item, name);
    return out;
  }

  // What a reported field (input, textarea, contenteditable) holds: 'password' for a password field (whatever its
  // current type), 'secret' for a field whose value is a secret (a read-only key with a copy button, a private key in
  // a textarea), else null. The value is read here only to classify the field; it is never reported.
  function secretField(el, label) {
    const tag = el.tagName;
    if (secretFilledFields.has(el)) return 'secret';
    if (tag === 'INPUT' && el.type === 'password') return 'password';
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return null;
    const autocomplete = el.getAttribute('autocomplete') ?? '';
    if (tag === 'INPUT' && (/(?:current|new)-password|one-time-code/.test(autocomplete)
      || (el.type === 'text' && SECRET_PASSWORD_FIELD.test(`${el.name} ${el.id}`)))) return 'password';
    const value = el.value;
    if (!value || value.length < 6) return null;
    const { relaxed, strict } = secretMode();
    const context = `${label} ${el.getAttribute('aria-label') ?? ''} ${el.name} ${el.id} ${el.placeholder ?? ''}`;
    if (secretFind(value, { strict, relaxed, context }).length) return 'secret';
    if (!relaxed && el.readOnly && value.length >= 16 && !/\s/.test(value) && SECRET_FIELD_LABEL.test(context)) return 'secret';
    return null;
  }

  // Wraps a page method so what it returns, and the message of what it throws, is scrubbed.
  function secretReported(method) {
    return (...args) => {
      const scrubError = error => {
        if (error && typeof error.message === 'string') error.message = secretScrubText(error.message);
        throw error;
      };
      let result;
      try {
        result = method(...args);
      } catch (error) {
        scrubError(error);
      }
      if (result && typeof result.then === 'function') return result.then(value => withVault(secretScrub(value)), scrubError);
      return withVault(secretScrub(result));
    };
  }

  function describeControl(id, { el, rect, label, offscreen, consentKind, unnamed }) {
    const role = roleOf(el);
    const risk = riskOf(el, role, label, consentKind);
    const control = {
      id,
      role,
      label,
      type: el.type,
      enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
      visible: true,
      risk: wireRisk(risk),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
    // Refused only for ambiguous label words (riskOf): the runtime may ask Jev what the control does.
    if (risk.ambiguous) control.ambiguous = true;
    if (offscreen) control.offscreen = true;
    if (consentKind) control.consent = true;
    // Inside an open dialog (a date picker): a click there may re-render seconds later (the runtime's late change).
    else if (inDialog(el)) control.dialog = true;
    if (inFloating(el)) control.floating = true;
    markOverlayControl(el, control, risk);
    // The label is a descriptor this script wrote (describeUnnamed): the control has no name of its own.
    if (unnamed) control.unnamed = true;
    // Whether a text box or combobox takes typed text (an input, a textarea or contenteditable); a combobox that does
    // not is a click target that opens its list.
    if (role === 'combobox' || role === 'textbox') {
      control.editable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
      // A field a click opens (a date picker's textbox): read-only, with a popup, or with no on-screen keyboard.
      const popup = el.getAttribute('aria-haspopup');
      if (el.readOnly || (popup && popup !== 'false') || el.getAttribute('inputmode') === 'none') control.opens = true;
    }
    const frame = frameByDoc.get(el.ownerDocument);
    if (frame) control.frame = frame.index;
    if (el.tagName === 'A') {
      control.href = el.href;
      control.linkTarget = el.target || el.ownerDocument.querySelector('base[target]')?.target || '';
    }
    if (role === 'tab') {
      // Tabs select a panel. Missing/invalid aria-selected is unknown, not an invented false state.
      const selected = el.getAttribute('aria-selected');
      if (selected === 'true' || selected === 'false') control.checked = selected === 'true';
    } else if (role === 'option') {
      control.checked = el.getAttribute('aria-selected') === 'true';
    } else if (CHECKABLE_ROLES.has(role)) {
      control.checked = el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true';
    } else if (['INPUT', 'TEXTAREA'].includes(el.tagName)) {
      control.filled = Boolean(el.value);
      // A filled single-line field: what pressing Enter in it would submit (enterClass), for the host's submit_field.
      const enter = control.filled ? enterClass(el) : null;
      if (enter) control.enter = enter === 'forbid' ? 'destructive' : enter;
    }
    // A field that holds a secret is never offered (the runtime drops sensitive controls); a password field shown as
    // text by a show-password toggle stays a password field (a fill target only at testing).
    const secret = el.type === 'password' && !secretFilledFields.has(el) ? null : secretField(el, label);
    if (secret) {
      control.sensitive = true;
      if (secret === 'password' && el.tagName === 'INPUT') control.type = 'password';
      // A filled secret, or a read-only field showing one, reports its placeholder, never its value; a shown value is
      // kept for the vault like page text (secret handles).
      if (secretFilledFields.has(el) || (secret === 'secret' && (el.readOnly || el.disabled))) {
        const placeholder = secretFieldValue(el, label);
        if (placeholder) control.secretValue = placeholder;
      }
    }
    // A field that takes a secret (fill_secret, approved by the user each time).
    if (!control.sensitive && secretTarget(el)) control.secretTarget = true;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
      // Field identity for the runtime's own payment-field check (src/guardrails.js paymentField). Never a value.
      const fieldInfo = { autocomplete: el.getAttribute('autocomplete'), name: el.name, inputId: el.id, placeholder: el.placeholder };
      for (const [key, value] of Object.entries(fieldInfo)) {
        if (typeof value === 'string' && value.trim()) control[key] = value.trim().slice(0, 100);
      }
    }
    if (el.tagName === 'SELECT') {
      control.selectedValue = el.value;
      control.options = Array.from(el.options).map(option => ({
        value: option.value,
        label: [...new Set([option.label, option.textContent, option.title]
          .map(label => String(label ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' / '),
        disabled: option.matches(':disabled'),
      }));
    }
    return { control, risk };
  }

  // `blocks: false` skips block extraction; the pre-dispatch check only needs the revision and the targets.
  // `terms` (lower-case instruction words) reorders controls under the cap and is remembered for this document.
  // `expectText` (the run's textIncludes) is looked for past the viewport too (findTexts): `textFound` lists the ones
  // the rendered page shows.
  function observe({ blocks: withBlocks = true, terms, forbid, allow, sites, expectText } = {}) {
    const normalized = normalizeTerms(terms);
    if (normalized) currentTerms = normalized;
    usePolicy({ forbid, allow, sites });
    assertFrameApproved();
    const roots = collectShadowRoots();
    const { frames, crossOrigin } = collectFrames();
    frameByDoc = frames;
    sensitivePage = null;
    // The secret scan of this observation is built on first use (a reported string, a field check, findTexts).
    secretInputs = { roots, frames: Array.from(frames.values()) };
    secretState = null;
    secretScanned = null;
    const consent = detectConsent(roots);
    lastConsent = consent;
    const overlay = detectOverlay(roots, consent);
    detectFloating(roots, consent);
    const candidates = withFrames(queryAll(CONTROL_SELECTOR, roots), CONTROL_SELECTOR);
    const { ordered, password, capped, dropped } = selectControls(candidates, currentTerms, consent);
    targets = new Map();
    targetRisks = new Map();
    const controls = [];
    for (const item of ordered) {
      const id = String(controls.length + 1);
      const { control, risk } = describeControl(id, item);
      if (!identities.has(item.el)) identities.set(item.el, ++identitySequence);
      controls.push(control);
      targets.set(id, item.el);
      targetRisks.set(id, risk);
    }
    // Derived views only for a full observation: the pre-dispatch check (blocks: false) needs the revision, which
    // hashes the raw text either way.
    const views = withBlocks ? collectViews(currentTerms) : null;
    // Repeated records (cards, tiles, rows) of the whole page, for a full observation only.
    const records = withBlocks ? detectRecords(new Map(Array.from(targets, ([id, el]) => [el, id]))) : null;
    const page = readPage(withBlocks, roots, Array.from(frameByDoc.values()), views, records?.records.length ? records.recordOf : null);
    const { text, stableText, truncated } = page;
    // The Approve gate's page rules need the page text (a total with an amount): applied once it is read.
    applyGates(controls, text);
    // Semantic revision: bounds, attribute-only changes, live-region churn and off-screen content are excluded,
    // so spinners, tickers and layout shifts do not invalidate every decision. Off-screen controls count by
    // identity, role and href only. Blocks are not hashed: their visible content is already covered by the text
    // and the controls.
    const semantic = JSON.stringify([
      location.href,
      document.title,
      stableText,
      controls.map(c => (c.offscreen ? [c.id, c.role, c.href]
        : [c.id, c.role, c.label, c.checked, c.filled, c.selectedValue, c.href])),
      Array.from(targets.values(), el => identities.get(el)),
    ]);
    const next = hash(semantic) + ':' + semantic.length;
    if (next !== signature) {
      signature = next;
      revision = `${documentId}:${++sequence}`;
    }
    const idOf = new Map(Array.from(targets, ([id, el]) => [el, id]));
    let consentView = null;
    if (consent) {
      const buttons = [];
      for (const [el, kind] of consent.kinds) {
        const id = idOf.get(el);
        if (id) buttons.push({ id, label: controls[Number(id) - 1].label, kind });
      }
      if (buttons.length) consentView = { text: shortText(consent.container, MAX_CONSENT_TEXT), buttons };
    }
    const overlayInfo = overlayView(overlay, idOf);
    const warnings = [];
    if (overlay && overlay.kind !== 'task') warnings.push('blocking_overlay');
    if (password) warnings.push('password_field');
    if (loginWall(password)) warnings.push('login_wall');
    if (capped) warnings.push('controls_capped');
    if (crossOrigin.length) warnings.push('cross_origin_frame');
    if (views?.unreadable.length) warnings.push('unreadable_region');
    if (withBlocks && secretMode().page) warnings.push('secret_page');
    const status = httpStatus();
    const expected = normalizeExpectText(expectText);
    findTexts.capped = false;
    const textFound = expected.length ? findTexts(expected, text, roots, Array.from(frameByDoc.values())) : null;
    return {
      revision,
      documentId,
      url: location.href,
      title: document.title,
      text,
      textTruncated: truncated,
      ...(textFound ? { textFound } : {}),
      ...(findTexts.capped ? { textCapped: true } : {}),
      ...(withBlocks ? finishBlocks(page.blocks, page.resolve, views, records) : {}),
      ...(records?.records.length ? { records: records.records, recordLists: records.lists, recordsTruncated: records.truncated,
        ...(records.state ? { recordState: records.state } : {}) } : {}),
      ...(views?.unreadable.length ? { unreadable: views.unreadable } : {}),
      controls,
      ...(capped ? { controlsDropped: dropped } : {}),
      consent: consentView,
      ...(overlayInfo ? { overlay: overlayInfo } : {}),
      warnings,
      ...(status ? { httpStatus: status } : {}),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      // How far the document scrolls (CSS px): the runtime scrolls a lazy list whose end is near (scrollToLoad).
      scroll: documentScroll(),
      // For the worker only (it removes both before anything leaves the extension): the cross-origin frames this
      // document holds, and in a page with such frames, or in a frame, this document's own page facts.
      ...frameExtras(crossOrigin, text),
    };
  }

  function frameExtras(crossOrigin, text) {
    const slots = crossOrigin.length ? crossOriginSlots(crossOrigin) : [];
    if (!slots.length && window === window.top) return {};
    return { ...(slots.length ? { frameSlots: slots } : {}), pageFacts: ownPageFacts(text) };
  }

  function documentScroll() {
    const root = document.scrollingElement ?? document.documentElement;
    return { top: Math.round(root.scrollTop), height: Math.round(root.scrollHeight) };
  }

  // Resolves after two animation frames plus `quietMs` without relevant DOM mutations, or at `capMs`.
  // Attribute-only mutations are not observed at all; live-region and off-screen mutations are ignored.
  function settle({ quietMs, capMs }) {
    return new Promise(resolve => {
      const started = performance.now();
      let done = false;
      let framesDone = false;
      let quietTimer = null;
      const relevant = record => {
        const el = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (!el || !el.isConnected) return true;
        if (el.closest(LIVE_REGION)) return false;
        const doc = el.ownerDocument;
        return el === doc.body || el === doc.documentElement || intersectsViewport(boxOf(el));
      };
      const finish = reason => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(capTimer);
        resolve({ reason, ms: Math.round(performance.now() - started) });
      };
      const armQuiet = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish('quiet'), quietMs);
      };
      const observer = new MutationObserver(records => {
        // Bound the layout reads per batch; a large batch is treated as relevant.
        if (records.length > 20 || records.some(relevant)) {
          if (framesDone) armQuiet();
        }
      });
      observer.observe(document, { subtree: true, childList: true, characterData: true });
      for (const frame of frameByDoc.values()) {
        try {
          observer.observe(frame.doc, { subtree: true, childList: true, characterData: true });
        } catch {
          // The frame navigated away or was removed.
        }
      }
      const capTimer = setTimeout(() => finish('cap'), capMs);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        framesDone = true;
        armQuiet();
      }));
    });
  }

  // The deepest element at a top-document viewport point, through open shadow roots and into readable same-origin
  // frames (their documents are checked at their own offsets). Null when nothing is there. A frame this script does
  // not read (another origin, or nested deeper than it looks) is refused: what is under the point is unknown.
  function elementAtPoint(x, y) {
    let doc = document;
    let px = x;
    let py = y;
    let el = null;
    for (let depth = 0; depth <= MAX_FRAMES; depth++) {
      let hit = doc.elementFromPoint(px, py);
      if (!hit) return el;
      while (hit.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(px, py);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      el = hit;
      if (hit.tagName !== 'IFRAME' && hit.tagName !== 'FRAME') return el;
      const frame = Array.from(frameByDoc.values()).find(entry => entry.el === hit);
      if (!frame) {
        throw new PageError('point_frame', 'The point is inside a frame this page cannot read; use an action id for a control of an approved frame');
      }
      doc = frame.doc;
      px -= frame.dx;
      py -= frame.dy;
    }
    return el;
  }

  // The control a click at the point lands on: the element there or its nearest actionable ancestor (CONTROL_SELECTOR,
  // across shadow boundaries), as selectControls would pick it; null when there is none, or it is an input kind that
  // is never a control (hidden, file) or an option/menu item outside an open list.
  function controlAtPoint(x, y) {
    let el = elementAtPoint(x, y);
    while (el && !(typeof el.matches === 'function' && el.matches(CONTROL_SELECTOR))) el = parentOf(el);
    if (!el) return null;
    if (el.type === 'hidden' || el.type === 'file') return null;
    const explicitRole = el.getAttribute('role');
    if ((explicitRole === 'option' || MENU_ITEM_ROLES.has(explicitRole)) && !offeredOption(el)) return null;
    if (explicitRole === 'listbox' && optionContainer(el)) return null;
    return rendered(el) ? el : null;
  }

  // Resolves the control under a viewport point for a point click, on the expected revision only. Returns
  // { id, control }: `id` is the control's id in the last observation when it is one of the observed controls (the
  // runtime maps it to the offered action), else null with the control described as observe() would (`id` "point"),
  // so the runtime can classify it exactly like an offered one. Remembers the element for dispatch().
  function locate(point, expectedRevision, terms, forbid, allow, sites) {
    const normalized = normalizeTerms(terms);
    if (normalized) currentTerms = normalized;
    usePolicy({ forbid, allow, sites });
    located = null;
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new PageError('unsupported', 'A point needs finite x and y');
    const observation = observe({ blocks: false });
    if (observation.revision !== expectedRevision) {
      throw new PageError('stale', 'Stale observation: the page changed since the screenshot');
    }
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      throw new PageError('point_outside', 'The point is outside the viewport');
    }
    const el = controlAtPoint(x, y);
    if (!el) throw new PageError('no_control', 'No clickable control is at that point');
    let id = null;
    for (const [key, target] of targets) {
      if (target === el) {
        id = key;
        break;
      }
    }
    let control;
    let risk;
    if (id !== null) {
      control = observation.controls.find(candidate => candidate.id === id);
      risk = targetRisks.get(id);
    } else {
      // A control the observation's cap left out: described and classified as observe() would have.
      const rect = boxOf(el);
      const item = { el, rect, label: labelOf(el), offscreen: !intersectsViewport(rect) };
      if (lastConsent) {
        let node = el;
        while (node && node !== lastConsent.container) node = parentOf(node);
        if (node) item.consentKind = lastConsent.kinds.get(el) ?? 'other';
      }
      describeUnnamed([item]);
      ({ control, risk } = describeControl('point', item));
    }
    located = { el, risk, control, id: id ?? 'point', x, y, revision: observation.revision };
    return { id, control };
  }

  function targetSummary(action, observation, pointControl = null) {
    const control = pointControl ?? observation.controls.find(c => c.id === action.target);
    if (!control) return null;
    // A password target is named so the worker keeps the filled value out of its screenshot annotations.
    return { id: control.id, role: control.role, label: control.label, ...(control.type === 'password' ? { type: 'password' } : {}) };
  }

  // Realistic input (extension/input.js, injected before this script into the same world), or null for the plain
  // dispatch below (input.js absent, or turned off with its configure({ enabled: false })).
  function realInput() {
    const input = globalThis.__faiInput;
    return input?.enabled ? input : null;
  }

  // A scroll moves the window by 70% of the viewport; when the window cannot move that way (a page whose body does not
  // scroll: a virtualized list or an app shell's content pane in its own scroll container), the scroll container under
  // the viewport's middle that can moves by 70% of its own height instead.
  async function scrollPage(sign) {
    const root = document.scrollingElement ?? document.documentElement;
    const windowCan = sign > 0 ? root.scrollTop + innerHeight < root.scrollHeight - 1 : root.scrollTop > 0;
    const scroller = windowCan ? null : innerScroller(sign);
    if (realInput()) await realInput().scroll(scroller, sign * (scroller ? scroller.clientHeight : innerHeight) * 0.7);
    else if (scroller) scroller.scrollBy({ top: sign * scroller.clientHeight * 0.7, behavior: 'instant' });
    else scrollBy({ top: sign * innerHeight * 0.7, behavior: 'instant' });
  }

  function innerScroller(sign) {
    for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.75], [0.3, 0.5], [0.7, 0.5]]) {
      for (let node = hitAt(innerWidth * fx, innerHeight * fy), depth = 0; node && node.nodeType === 1 && depth < 30; node = parentOf(node), depth++) {
        if (node === document.body || node === document.documentElement) break;
        if (!/^(?:auto|scroll|overlay)$/.test(styleOf(node).overflowY)) continue;
        const can = sign > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0;
        if (can && node.clientHeight * node.clientWidth >= 0.15 * viewportArea()) return node;
      }
    }
    return null;
  }

  // A key the host may press (src/runtime.js pressKey's wire form): { name, shift, ctrl, meta, modifier } or null.
  function pressedKey(wire) {
    const plain = ['Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'];
    if (typeof wire !== 'string') return null;
    if (plain.includes(wire)) return { name: wire, shift: false, ctrl: false, meta: false, modifier: false };
    if (wire === 'Shift+Tab') return { name: 'Tab', shift: true, ctrl: false, meta: false, modifier: false };
    const match = /^(Ctrl|Cmd)\+(Shift\+)?([A-Z0-9])$/.exec(wire);
    if (!match) return null;
    return { name: match[3].toLowerCase(), shift: Boolean(match[2]), ctrl: match[1] === 'Ctrl', meta: match[1] === 'Cmd', modifier: true };
  }

  // The focused element, through open shadow roots and same-origin frames.
  function deepActiveElement() {
    let node = document.activeElement;
    for (let depth = 0; node && depth < 10; depth++) {
      if (node.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
      else if (node.tagName === 'IFRAME') {
        try {
          const inner = node.contentDocument?.activeElement;
          if (!inner || inner === node.contentDocument.body) break;
          node = inner;
        } catch {
          break;
        }
      } else break;
    }
    return node;
  }

  function textEntry(el) {
    return Boolean(el) && (el.isContentEditable || el.tagName === 'TEXTAREA'
      || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'range', 'color'].includes(el.type)));
  }

  // Validates and dispatches one action against the expected revision. Returns whether a document navigation
  // is expected, so the worker can wait for the new document instead of settling in this one.
  async function dispatch(action, expectedRevision, approval = null) {
    const observation = observe({ blocks: false });
    // A key pressed where focus is, or a dialog's answer, does not depend on the page the host saw.
    const pageWide = (action.type === 'press' && !action.target) || action.type === 'dialog';
    if (observation.revision !== expectedRevision && !pageWide) {
      throw new PageError('stale', 'Stale observation: the page changed since the decision');
    }
    // A key, a hover and typed text need controls (reversible); a Ctrl/Cmd shortcut needs submit (full): a shortcut
    // may save or send.
    if (['press', 'hover'].includes(action.type) && !currentAllow.has('controls')) {
      throw new PageError('blocked_risky', blockedMessage('reversible'));
    }
    let el = null;
    let control = null;
    let risk = null;
    if (action.point) {
      // A point click runs only the control locate() resolved on this revision, and only while the point still
      // resolves to that element (a layout shift under the same revision is a stale decision, never another click).
      if (action.type !== 'click' || action.target !== undefined) throw new PageError('unsupported', 'A point only clicks');
      const hit = located;
      located = null;
      if (!hit || hit.revision !== expectedRevision || hit.x !== action.point.x || hit.y !== action.point.y) {
        throw new PageError('stale', 'The point was not located on this revision');
      }
      if (controlAtPoint(hit.x, hit.y) !== hit.el) throw new PageError('stale', 'The control at that point changed');
      ({ el, control, risk } = hit);
    } else if (action.target) {
      el = targets.get(action.target);
      control = observation.controls.find(c => c.id === action.target) ?? null;
      risk = targetRisks.get(action.target);
    }
    // A styled file picker hides its input: its rendered label stands in for it (selectControls).
    const shown = node => rendered(node) || (action.type === 'upload' && Array.from(node.labels ?? []).some(label => rendered(label)));
    if ((action.target || action.point) && (!el?.isConnected || !shown(el) || el.disabled || control?.enabled === false)) {
      throw new PageError('target_unavailable', 'Target is unavailable');
    }
    // Every action is checked against the granted capabilities: a control by its risk class, a targetless action
    // (scroll, wait, allowed URL) as navigation.
    if (control) {
      // An approval the worker minted for exactly this click (approvalHolds) stands in for the level; a credential
      // action asks at every level, testing included, while the user's setting says so.
      const approved = approvalHolds(approval, action, control, risk, el, approval?.seen);
      // A secret fill runs only with the user's approval for exactly this field, at every level.
      if (action.type === 'fill_secret' && !approved) {
        throw new PageError('blocked_risky', 'A secret is filled only once the user approves it in the FAI Browser window');
      }
      if (risk?.secret && gateSettings.secret && !approved) {
        throw new PageError('blocked_risky', 'This control handles a credential: it runs only once the user approves it');
      }
      // A hover, or a key pressed in a control (focus only; Space is checked below), never activates it: its class
      // does not gate them, the level (controls) does.
      if (action.type === 'upload' && !approved) {
        throw new PageError('blocked_risky', 'A file is uploaded only once the user approves it in the FAI Browser window');
      }
      const inert = action.type === 'hover' || action.type === 'press' || action.type === 'upload';
      if (!inert && !dispatchable(risk) && !clearedClick(action, risk) && !approved) throw new PageError('blocked_risky', blockedMessage(risk?.cls));
    } else if (!permits('navigation')) {
      throw new PageError('blocked_risky', blockedMessage('navigation'));
    }
    // An off-screen target is brought into view first, as a user would scroll to it (and so the evidence
    // screenshot shows it).
    if (control?.offscreen && action.type !== 'scroll') {
      if (realInput()) await realInput().reveal(el);
      else el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    const result = {
      fromUrl: location.href,
      target: targetSummary(action, observation, action.point ? control : null),
      expectNavigation: false,
    };
    switch (action.type) {
      case 'click': {
        if (!el) throw new PageError('unsupported', 'Click requires a target');
        const ownLocation = el.ownerDocument.location;
        if (el.tagName === 'A') {
          const url = new URL(el.href);
          if (url.protocol === 'javascript:') throw new PageError('blocked_risky', 'javascript: links are not allowed');
          const frameTarget = (el.target || el.ownerDocument.querySelector('base[target]')?.target || '').toLowerCase();
          if (!(pageContext.frame ? frameLinkAllowed(url, frameTarget) : onApprovedSite(url))) {
            throw new PageError('cross_origin', 'Cross-origin link requires user action');
          }
          if (frameTarget && !['_self', '_parent', '_top'].includes(frameTarget)) {
            // Opening a child tab would leave the leased tab; hand off instead of letting it open.
            throw new PageError('child_tab', 'Link opens a new tab; user handoff required');
          }
          const sameDocument = url.href.split('#')[0] === ownLocation.href.split('#')[0] && url.hash;
          // A frame link without a target (or _self) replaces only the frame: no tab navigation to wait for.
          const framed = el.ownerDocument !== document && !['_top', '_parent'].includes(frameTarget);
          result.expectNavigation = !sameDocument && !el.hasAttribute('download') && !framed;
        }
        // A control inside a same-origin frame: a navigation that replaces only the frame document is waited for
        // in execute() (the frame's load event), not by the worker, which only sees the tab's own loads.
        const frame = frameByDoc.get(el.ownerDocument);
        if (frame && !sameLeaseOrigin(frame.el)) throw new PageError('cross_origin', 'Frame outside selected origin');
        const frameNavigation = frame ? el.ownerDocument.defaultView?.navigation : null;
        let frameNavigate = null;
        const onFrameNavigate = event => { frameNavigate = event; };
        frameNavigation?.addEventListener?.('navigate', onFrameNavigate);
        // The Navigation API reports what the click actually started: a cross-document navigation (also from a
        // button handler that assigns location), a same-document route change (SPA, settled in place), or
        // nothing (a script cancelled the link).
        // A form submission navigates from a queued task, after click() returns; its submit event is synchronous.
        const navigation = globalThis.navigation;
        const form = el.form ?? null;
        let navigateEvent = null;
        let submitEvent = null;
        const onNavigate = event => { navigateEvent = event; };
        const onSubmit = event => { submitEvent = event; };
        navigation?.addEventListener?.('navigate', onNavigate);
        form?.addEventListener('submit', onSubmit);
        try {
          if (realInput()) {
            // A mouse click (input.js): pointer path, press, focus, release, click. The control is rechecked right
            // before the press; one whose label or state changed while the pointer moved is a stale decision.
            const label = labelOf(el);
            const stillValid = () => rendered(el) && !el.disabled && labelOf(el) === label;
            const { stale } = await realInput().click(el, { point: action.point ?? null, stillValid });
            if (stale) throw new PageError('stale', 'The control changed before the click');
          } else {
            // A click on a text field focuses it first, as a pointer click does (pickers open on focus or on click).
            if (['INPUT', 'TEXTAREA'].includes(el.tagName)) el.focus({ preventScroll: true });
            el.click();
          }
        } finally {
          navigation?.removeEventListener?.('navigate', onNavigate);
          form?.removeEventListener('submit', onSubmit);
          frameNavigation?.removeEventListener?.('navigate', onFrameNavigate);
        }
        // The navigate event is synchronous and the frame's load always comes later, so the bounded wait is armed
        // only for a click that really started a frame navigation.
        if (frameNavigate && !frameNavigate.defaultPrevented && !frameNavigate.destination?.sameDocument) {
          result.frameLoad = new Promise(resolve => {
            const done = () => { clearTimeout(timer); frame.el.removeEventListener('load', done); resolve(); };
            const timer = setTimeout(done, FRAME_LOAD_CAP_MS);
            frame.el.addEventListener('load', done);
          });
        }
        if (navigation?.addEventListener && !el.hasAttribute('download')) {
          const routed = location.href !== result.fromUrl || Boolean(navigation.transition);
          const crossDocument = Boolean(navigateEvent) && !navigateEvent.defaultPrevented
            && !navigateEvent.destination?.sameDocument && !routed;
          const submitted = Boolean(submitEvent) && !submitEvent.defaultPrevented
            && (el.getAttribute('formmethod') || form.method) !== 'dialog'
            && !['_blank'].includes((el.getAttribute('formtarget') || form.target || '').toLowerCase());
          result.expectNavigation = crossDocument || (submitted && !routed);
        }
        break;
      }
      case 'fill_supplied_text': {
        // A password input is a text target only with sign_in (its risk class, checked above, says the same).
        const textTarget = el && ['INPUT', 'TEXTAREA'].includes(el.tagName)
          && !['checkbox', 'radio', 'button', 'reset', 'image', 'submit', 'file'].includes(el.type)
          && (el.type !== 'password' || currentAllow.has('sign_in'));
        if (!textTarget || typeof action.text !== 'string') {
          throw new PageError('unsupported', 'Unsupported text target');
        }
        // Text the agent typed itself (not a value the user supplied): never into a password, payment or secret field,
        // at any level; secrets go through fill_secret, which the user approves.
        if (action.typed === true && (el.type === 'password' || paymentField(el) || secretTarget(el))) {
          throw new PageError('blocked_risky', 'Typed text never goes into a password, payment or secret field');
        }
        refuseLineBreak(el, action.text);
        const realm = el.ownerDocument.defaultView ?? window;
        const prototype = el.tagName === 'INPUT' ? realm.HTMLInputElement.prototype : realm.HTMLTextAreaElement.prototype;
        // Use the native setter so framework-controlled inputs (React etc.) see the change.
        const setValue = () => {
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, action.text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        // Typed key by key (input.js, which reads the value back and corrects it once); the plain set when the field
        // does not show the text afterwards.
        const typed = realInput() ? await realInput().type(el, action.text, { kept: () => fillKept(el, action.text).kept, fallback: setValue }) : null;
        if (!typed) setValue();
        // Read back after the page settles (execute): a controlled input or a picker's textbox may revert or ignore
        // the value, and a fill the field did not keep is no progress (a live Google Flights run reported the
        // Departure fill done while the field stayed empty).
        result.fillCheck = () => ({ ...fillKept(el, action.text), ...(typed?.corrected ? { corrected: true } : {}) });
        break;
      }
      case 'fill_secret': {
        // A secret handle's value (the worker resolves it; nothing else ever sees it) into a field that takes secrets
        // (secretTarget). The field is a secret field from now on: never reported, boxed on every screenshot.
        if (!secretTarget(el) || typeof action.text !== 'string' || !action.text) throw new PageError('unsupported', 'Unsupported secret target');
        refuseLineBreak(el, action.text);
        const realm = el.ownerDocument.defaultView ?? window;
        const setSecret = () => {
          Object.getOwnPropertyDescriptor(realm.HTMLInputElement.prototype, 'value').set.call(el, action.text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        // Typed like any fill (input.js; sign-in pages watch their key events most), the plain set as the fallback. The
        // rhythm is planned blind (`secret`): its timing, and so inputMs, depend on the value's length only.
        const typed = realInput() ? await realInput().type(el, action.text, { kept: () => fillKept(el, action.text).kept, fallback: setSecret, secret: true }) : null;
        if (!typed) setSecret();
        rememberFilledSecret(el, action.text);
        result.fillCheck = () => ({ ...fillKept(el, action.text), ...(typed?.corrected ? { corrected: true } : {}) });
        break;
      }
      case 'submit_field': {
        // Enter in a filled text field: allowed only as what its form submit amounts to (enterClass), at the level
        // that holds that class (submit_safe at interactive, submit at full), never into a password or payment form.
        const cls = el ? enterClass(el) : null;
        if (!cls) throw new PageError('unsupported', 'Enter does not submit this control');
        if (cls === 'forbid') throw new PageError('blocked_risky', 'Submission forbidden by the request guardrails');
        if (!permits(cls)) throw new PageError('blocked_risky', blockedMessage(cls));
        const navigation = globalThis.navigation;
        const form = el.form ?? null;
        let navigateEvent = null;
        let submitEvent = null;
        const onNavigate = event => { navigateEvent = event; };
        const onSubmit = event => { submitEvent = event; };
        navigation?.addEventListener?.('navigate', onNavigate);
        form?.addEventListener('submit', onSubmit);
        try {
          if (realInput()) {
            // A synthetic Enter never submits by itself: implicit submission is run here, unless the page handled the
            // key (a search box that routes in script) or already submitted. As the browser does it: a click on the
            // form's default button (its own handlers run), else the form's submit.
            await realInput().enter(el, () => {
              if (!form || submitEvent) return;
              const button = Array.from(form.elements ?? []).slice(0, 500)
                .find(field => (field.type === 'submit' || field.type === 'image') && !field.disabled);
              if (button) realInput().keyboardClick(button);
              else form.requestSubmit();
            });
          } else {
            el.focus({ preventScroll: true });
            const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
            const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
            el.dispatchEvent(new KeyboardEvent('keypress', init));
            el.dispatchEvent(new KeyboardEvent('keyup', init));
            // A synthetic keydown never submits by itself: the browser's implicit submission is run explicitly, unless
            // the page handled the key (a search box that routes in script).
            if (proceed && form && !submitEvent) form.requestSubmit();
          }
        } finally {
          navigation?.removeEventListener?.('navigate', onNavigate);
          form?.removeEventListener('submit', onSubmit);
        }
        const routed = location.href !== result.fromUrl || Boolean(navigation?.transition);
        const crossDocument = Boolean(navigateEvent) && !navigateEvent.defaultPrevented
          && !navigateEvent.destination?.sameDocument && !routed;
        const submitted = Boolean(submitEvent) && !submitEvent.defaultPrevented && form?.method !== 'dialog'
          && (form?.target || '').toLowerCase() !== '_blank';
        result.expectNavigation = crossDocument || (submitted && !routed);
        break;
      }
      case 'select': {
        const option = el?.tagName === 'SELECT'
          ? Array.from(el.options).find(o => o.value === action.value && !o.matches(':disabled'))
          : null;
        if (!option) throw new PageError('unsupported', 'Unsupported selection');
        const optionLabels = [option.label, option.textContent, option.title];
        if (optionLabels.some(label => forbidden(label))) {
          throw new PageError('blocked_risky', 'Selection forbidden by the request guardrails');
        }
        const optionClass = optionLabels.reduce((worst, label) => severer(worst, labelClass(label)), null);
        if (optionClass && !permits(optionClass)) throw new PageError('blocked_risky', blockedMessage(optionClass));
        const choose = () => {
          el.value = action.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        if (realInput()) await realInput().select(el, choose);
        else choose();
        break;
      }
      case 'scroll':
        await scrollPage(action.direction === 'up' ? -1 : 1);
        break;
      case 'press': {
        const key = pressedKey(action.key);
        if (!key) throw new PageError('unsupported', 'That key is not allowed');
        if (key.modifier && !currentAllow.has('submit')) throw new PageError('blocked_risky', 'A shortcut needs the Act level');
        // In the named control (focused first, as a click would), else wherever focus is.
        let at = el;
        if (at) {
          if (deepActiveElement() !== at) at.focus({ preventScroll: true });
        } else {
          at = deepActiveElement() ?? document.body;
        }
        // Space activates a focused button, checkbox or link: only one this page offered and the level allows.
        if (key.name === 'Space' && !key.modifier && at !== document.body && at !== document.documentElement && !textEntry(at)) {
          const id = [...targets.entries()].find(([, node]) => node === at)?.[0];
          const risk = id === undefined ? null : targetRisks.get(id);
          if (!risk || !dispatchable(risk) || forbidden(labelOf(at))) {
            throw new PageError('blocked_risky', 'Space would activate a control that is not cleared at this level');
          }
        }
        const mods = { shift: key.shift, ctrl: key.ctrl, meta: key.meta };
        if (realInput()) await realInput().press(at, key.name, mods);
        else {
          const init = { key: key.name === 'Space' ? ' ' : key.name, bubbles: true, cancelable: true, composed: true,
            shiftKey: key.shift, ctrlKey: key.ctrl, metaKey: key.meta };
          at.dispatchEvent(new KeyboardEvent('keydown', init));
          at.dispatchEvent(new KeyboardEvent('keyup', init));
        }
        break;
      }
      case 'upload': {
        // The approved file, delivered as a user's pick would be: the input's files, then input and change.
        if (!el || el.tagName !== 'INPUT' || el.type !== 'file') throw new PageError('unsupported', 'Upload requires a file input');
        const file = action.file;
        if (!file || typeof file.data !== 'string' || typeof file.name !== 'string') throw new PageError('unsupported', 'Upload requires a file');
        const binary = atob(file.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const realm = el.ownerDocument.defaultView ?? window;
        const transfer = new realm.DataTransfer();
        transfer.items.add(new realm.File([bytes], file.name, { type: typeof file.type === 'string' ? file.type : '' }));
        el.files = transfer.files;
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        result.upload = { name: file.name, size: bytes.length, kept: el.files?.length === 1 };
        break;
      }
      case 'hover': {
        if (!el) throw new PageError('unsupported', 'Hover requires a target');
        if (realInput()) await realInput().hover(el);
        else {
          for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: !type.endsWith('enter'), cancelable: true, composed: true }));
          }
        }
        break;
      }
      case 'dismiss_overlay':
        await dismissOverlay(action.method);
        break;
      case 'navigate_allowed_url': {
        const url = new URL(action.url);
        if (!onApprovedSite(url)) throw new PageError('cross_origin', 'Navigation outside selected origin');
        location.assign(url.href);
        result.expectNavigation = true;
        break;
      }
      default:
        throw new PageError('unsupported', 'Unsupported action');
    }
    return result;
  }

  // Dispatch plus in-page settle plus observe in one executeScript round trip. When the action is expected to
  // replace the document, return immediately; the worker waits for the load and calls settleAndObserve.
  // `terms`, when given, are the instruction terms the decision's observation was ordered with.
  // `expectText`, the run's expectation texts for the observation after the action (observe).
  async function execute(action, expectedRevision, settleOptions, terms, forbid, allow, sites, expectText, approval = null) {
    const normalized = normalizeTerms(terms);
    if (normalized) currentTerms = normalized;
    usePolicy({ forbid, allow, sites });
    // An approved action: the label digest of its target as the page reads it now; dispatch compares it with the
    // label it reads again itself.
    const seen = approval ? await approvalDigest(approval).catch(() => null) : null;
    const inputBefore = realInput()?.stats().ms ?? 0;
    const dispatched = await dispatch(action, expectedRevision, approval ? { ...approval, seen } : null);
    // The time realistic input added to this action (think time, pointer travel, typing), for the receipt.
    if (realInput()) dispatched.inputMs = realInput().stats().ms - inputBefore;
    const fillCheck = dispatched.fillCheck;
    delete dispatched.fillCheck;
    if (dispatched.expectNavigation) {
      delete dispatched.frameLoad;
      return dispatched;
    }
    if (dispatched.frameLoad) await dispatched.frameLoad;
    delete dispatched.frameLoad;
    const settled = await settle(settleOptions);
    // A fill's verdict is read once the page has settled, so a framework's re-render after the input event counts.
    if (fillCheck) dispatched.fill = fillCheck();
    return { ...dispatched, settle: settled, observation: observe({ expectText }) };
  }

  // The ways a field may show an ISO date it was given (YYYY-MM-DD): numeric orders with and without zero padding,
  // and month names (MONTH_NAMES, the calendar reader's list), short and long, with and without the year. Lower
  // case, single spaces.
  function dateForms(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!match) return [];
    const [, year, month, day] = match;
    const m = String(Number(month));
    const d = String(Number(day));
    const name = MONTH_NAMES[Number(month) - 1]?.toLowerCase();
    if (!name) return [];
    const short = name.slice(0, 3);
    const forms = [];
    for (const [mm, dd] of [[month, day], [m, d]]) {
      forms.push(`${dd}/${mm}/${year}`, `${mm}/${dd}/${year}`, `${year}/${mm}/${dd}`, `${dd}.${mm}.${year}`, `${dd}-${mm}-${year}`,
        `${mm}-${dd}-${year}`);
    }
    for (const monthName of [short, name]) {
      forms.push(`${d} ${monthName} ${year}`, `${monthName} ${d}, ${year}`, `${monthName} ${d} ${year}`, `${d} ${monthName}`,
        `${monthName} ${d}`);
    }
    return forms;
  }

  // Whether a text field holds the supplied text after a fill, read from the field itself (never from page text):
  // `kept` when its value contains the text (whitespace collapsed, case ignored), the same digits for a text of
  // digits and separators (a field that formats numbers), or the same date in another form for an ISO date;
  // `empty` when the field holds nothing at all. The value itself is never returned.
  // A line break typed into a single-line input is Enter, and Enter there submits the form: a fill would get past the
  // submit gate and the request's forbid list. Refused; submit_field is the way to submit.
  function refuseLineBreak(el, text) {
    if (el.tagName === 'INPUT' && /[\r\n]/.test(text)) {
      throw new PageError('unsupported', "Newlines can't be typed into a single-line field; use submit_field to submit");
    }
  }

  // A plain text field: what it shows is what was typed, no suggestion list completing it (a combobox, autocomplete,
  // a datalist, a popup) and no picker.
  function plainTextField(el) {
    if (el.tagName === 'INPUT' ? !['text', 'search', 'email', 'url', 'tel', 'password'].includes(el.type) : el.tagName !== 'TEXTAREA') return false;
    const popup = (el.getAttribute('aria-haspopup') || 'false').toLowerCase();
    return el.getAttribute('role') !== 'combobox' && (el.getAttribute('aria-autocomplete') || 'none').toLowerCase() === 'none'
      && !el.hasAttribute('list') && popup === 'false' && !el.readOnly;
  }

  // Whether the field shows the text (whitespace and case aside): exactly it in a plain text field (not the text with
  // something left over before or after it), else containing it (a picker's textbox completes what was typed); the
  // same digits, or the same ISO date in another form. An empty text is kept by an empty field.
  function fillKept(el, text) {
    const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const want = normalize(text);
    const have = el.isConnected ? normalize(el.value) : '';
    if (!want) return { kept: !have, empty: !have };
    const exact = plainTextField(el);
    const match = (value, wanted) => (exact ? value === wanted : value.includes(wanted));
    let kept = match(have, want);
    if (!kept && /\d/.test(want) && /^[\d\s()+.-]+$/.test(want)) kept = match(have.replace(/\D/g, ''), want.replace(/\D/g, ''));
    if (!kept) kept = dateForms(want).some(form => match(have, form));
    return { kept, empty: !have };
  }

  async function settleAndObserve(settleOptions, terms, forbid, allow, sites, expectText) {
    const normalized = normalizeTerms(terms);
    if (normalized) currentTerms = normalized;
    usePolicy({ forbid, allow, sites });
    const settled = await settle(settleOptions);
    return { settle: settled, observation: observe({ expectText }) };
  }

  // Everything a method returns is scrubbed of secrets on the way out (secretReported); calls inside this script use
  // the raw methods.
  globalThis.__faiPage = {
    observe: secretReported(observe),
    execute: secretReported(execute),
    settleAndObserve: secretReported(settleAndObserve),
    locate: secretReported(locate),
    approvalInfo: secretReported(approvalInfo),
    useSecrets,
    useGates,
    useContext,
    secretNodes,
    // Numbers and fixed words only (rects, kinds, `[secret:~<hash>]` tags): nothing to scrub.
    redactionRects,
  };
})();
