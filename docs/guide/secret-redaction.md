# Secret redaction

An agent that reads a settings page must never hold a value you would then have to rotate. FAI Browser **redacts** secrets
instead of blocking the page: the agent keeps reading and acting (actions are dispatched by control id, so a link whose URL lost
a token still works); only the value is gone. It is deterministic (no model decides), always on, at every level including Test
site. There is no "off". Full rules: [REFERENCE.md: Secret redaction](../REFERENCE.md#secret-redaction).

## What the agent sees

```text
Your API key: [secret:3 openai sk-proj-…Ab12 len 164]            known format: public prefix, last four, length
Card on file:  [secret:5 card …4242 len 16]                       card numbers: last four only
Password:      [secret:6 password]                                 kind only
Link:          https://example.com/cb?state=ok&token=[secret:7 param]    the value goes; origin, path, other params stay
```

- `N` is stable per value for the tab lease, so the agent can refer to "the key `secret:3`" across pages.
- A second pass never changes a placeholder.
- The live page is never modified (redaction works on extracted strings), so a site cannot detect it.

## What is found

- **Known formats**, always: Anthropic, OpenAI, GitHub, Slack, Discord, AWS, Google, GitLab, Stripe, npm, PyPI, Hugging Face, Groq,
  xAI, Replicate, SendGrid, DigitalOcean, Shopify, Linear, Postman, Supabase, Atlassian tokens and more; JWTs; PEM private-key
  blocks (even split over several elements); connection-string passwords; Luhn-valid card numbers; sensitive URL parameters
  (`token`, `key`, `secret`, `sig`, `code`, `auth`, `session`, `password`, `X-Amz-*` and the like).
- **Context rules** (Standard mode): a long mixed letters-and-digits run with high entropy next to a word like key, token, secret,
  password, bearer or recovery code (in the text before it, a column header, a row's first cell, an aria-label ...); TOTP seeds near
  "setup key" / "authenticator"; recovery-code lists; values of `API_KEY=` style environment rows.
- **Secret pages** (`warnings: ["secret_page"]`): paths like `/settings/tokens`, `/api-keys`, `/security`, `/2fa`, `/webhooks`, or
  headings like "API keys" and "Recovery codes". There the rule needs no context and every long token in `code`/`pre`/`kbd`/`samp` is masked too.
- **Fields:** a field that holds a secret is reported `sensitive` and never offered; password fields are fill targets only at Test
  site; input values are never reported at all.

## Where it runs

The extension is the primary barrier: the page script scrubs everything it returns (text, blocks, control labels, select options,
link hrefs, the page URL); the worker scrubs the URLs and titles it reports. The **daemon runs the same rules again**
(defense in depth) on every observation and action result, traces, the daemon log, every HTTP response and every MCP message.
An expectation's `textIncludes` is matched against the redacted text, so it cannot be used to guess a value.

## Screenshots

Every screenshot is redacted **on its pixels** before it leaves the extension. Right before capture the extension asks the page for the
boxes to fill: elements holding found secrets, every password field, every payment field, every field that holds a secret, and cross-origin frames of payment and
sign-in widgets (Stripe, Braintree, PayPal, Google, Microsoft, Okta and others); in Strict mode or on a secret page also every canvas, other cross-origin
frame and code block. The page is asked again right after capture, with a watch armed in between; if anything changed in a way
that could expose something, the capture fails closed (no image rather than a leaky one).

## Settings

Popup, Permissions, **Secret redaction** (stored in the extension, not `config.json`):

- **Standard** (default) or **Strict** (context-free generic rule on every page; code runs masked everywhere).
- **Relaxed origins:** exact origins where only the known formats apply, for a docs site whose examples look like keys.

## Secret handles

Redaction keeps a secret from the agent. A **handle** lets the agent *use* one without seeing it, with your say-so each time.
Typical job: copy a new API key from one site into another site's settings field.

1. A site shows a new key; redaction replaces it with `[secret:3 ...]` and the extension keeps the real value in memory (never storage, never the daemon, 50 values, 30 minutes after last seen; card numbers and URL parameters are never kept).
2. The next observation lists the handle (`secrets [{handle, kind, origin, label}]`) and offers:
   - `fill_secret "API key" <- secret:3 (openai key from platform.openai.com)`: pastes into **one** field that takes a secret (a non-sign-in password field, or a single-line text field whose label says key, token, secret, password or credential). Never a textarea, search, message, email, username, one-time-code or payment field.
   - `copy_secret secret:3 to the clipboard`.
3. Acting on it opens the approval window: *"Paste secret:3 (openai key from platform.openai.com) into 'API key' on vercel.com"*, with a warning if the origins differ. It always asks, at every level, whatever the Approve-gate settings.
4. After a fill, the field is a secret field: never offered again, boxed on screenshots, and the page's own echo of the value is redacted.

The value appears nowhere in the API. A run (Jev) is never offered a secret action. Secret handles do not fill password
sign-in forms, including in Test site mode; a sign-in task may require a user handoff.

## Limits

Be aware of these; they are also in [SECURITY.md](../../SECURITY.md).

- Text drawn on a **canvas**, text inside **images**, **cross-origin frames** (never read anyway) and **closed shadow roots** are not scanned.
- A value with no known format, shorter than about 20 characters, with no context word nearby (a short password in plain prose) is not found.
- A value split across elements, drawn on a canvas or shown only in an image is never vaulted for handles.
- `copy_secret` puts the value on the OS clipboard (after you approve); local programs, including the agent's shell, can read the clipboard until something else is copied. The approval card says so.
- A page that reads a field you approved can send the value anywhere. Approve fills only on sites that should have the secret.
- Redaction targets credentials, not personal data. A bank page is readable at Read level.

Audit your own pages: `node scripts/secret-sweep.mjs [--strict]` observes every fixture page and lists every placeholder.
Found a miss? Report a live credential privately ([SECURITY.md](../../SECURITY.md)); a missed format with a fake value goes in a
**Site compatibility** issue or a pull request adding a rule and a fake to `fixtures/secrets/fakes.js`.
