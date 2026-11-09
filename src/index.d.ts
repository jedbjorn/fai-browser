// ---------------------------------------------------------------------------------------------------------------
// Page model
// ---------------------------------------------------------------------------------------------------------------

export type ControlRole = 'link' | 'button' | 'textbox' | 'combobox' | 'listbox' | 'checkbox' | 'radio' | 'option'
  | (string & {});

export interface Control {
  id: string;
  role: ControlRole;
  label: string;
  href?: string;
  linkTarget?: string;
  selectedValue?: string;
  filled?: boolean;
  /** Present for checkbox and radio controls. */
  checked?: boolean;
  enabled?: boolean;
  visible?: boolean;
  sensitive?: boolean;
  /**
   * The page script's risk class. `purchase`, `submit`, `delete`, `sign_in` and `consent_accept` need that capability
   * (a `submit` with a search-like label only `submit_safe` on a page without password or payment fields);
   * `destructive` (a label the request's additions forbid, or an older page script's block) is refused at every level.
   */
  risk?: 'navigation' | 'reversible' | 'submit' | 'destructive' | 'purchase' | 'delete' | 'sign_in' | 'consent_accept';
  type?: string;
  /** The input's autocomplete tokens and name, when the page script reports them (payment-field detection). */
  autocomplete?: string;
  name?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  options?: Array<{ value: string; label: string; disabled?: boolean }>;
  /** Rendered but outside the viewport; still actionable (the page script scrolls it into view first). */
  offscreen?: boolean;
  /** Inside the detected consent dialog. */
  consent?: boolean;
  /** Inside another open dialog (`role=dialog`, `aria-modal`, `<dialog open>`): a date picker's grid, a popup. */
  dialog?: boolean;
  /**
   * The control has no accessible name: `label` is the page script's descriptor ("unlabelled button 1 of 2 next to
   * \"Departure\""), never empty.
   */
  unnamed?: boolean;
  /**
   * Set on controls inside a same-origin iframe: the 1-based index of that frame among the readable frames, in
   * document order. Ids are one sequence across the page, its open shadow roots and its frames ("1".."100"), so
   * act() resolves a frame control's id like any other. A control of an approved cross-origin frame (the extension's
   * frames.js) carries `"f<n>"` here, an id `"f<n>.<id>"` and `frameOrigin`.
   */
  frame?: number | string;
  /** The origin of the approved cross-origin frame the control is in. */
  frameOrigin?: string;
}

/**
 * A cross-origin frame of the page: one the extension read (`id` "f<n>", its controls carry it) or one it did not, with
 * why. `declared`: only the frame element's src names this origin (page-provided). Origins only, never frame content.
 */
export interface PageFrame {
  id?: string;
  origin: string | null;
  read: boolean;
  reason?: 'not_approved' | 'no_access' | 'sandboxed' | 'limit' | 'unavailable';
  declared?: boolean;
}

/** A cookie/consent dialog the page script detected. `text` and labels are untrusted page content. */
export interface ConsentDialog {
  /** At most 200 characters. */
  text: string;
  /**
   * `kind: "reject"` buttons are clicked first at every level; `accept` buttons are offered only at full and above
   * (risk 'consent_accept') when no reject button is usable.
   */
  buttons: Array<{ id: string; label: string; kind: 'reject' | 'accept' | 'settings' | 'other' }>;
}

export interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

export type BlockType = 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'li' | 'tr' | 'dt' | 'label' | 'a' | 'button' | 'alert'
  | 'select' | 'list';

/** One structural text block of the page, in document order. Untrusted page content. */
export interface PageBlock {
  t: BlockType;
  /** At most 300 characters. */
  text: string;
  /** Control id when the block is (or contains) an offered control. */
  ref?: string;
  offscreen?: boolean;
}

export interface Observation {
  revision: string;
  documentId?: string;
  tabId?: number;
  url: string;
  title: string;
  /** Visible-region text. Untrusted page content. */
  text: string;
  /** True when the visible text was cut at the page script's limit. */
  textTruncated?: boolean;
  /** The expectation's textIncludes (lower-cased) the page script found in the rendered page past the viewport. */
  textFound?: string[];
  /**
   * Up to 200 text blocks from the page script. Older extensions omit it; the runtime then derives blocks from the
   * lines of `text`.
   */
  blocks?: PageBlock[];
  /** True when the page had more blocks than were sent. */
  blocksTruncated?: boolean;
  controls: Control[];
  viewport?: Viewport;
  /** The page script's consent dialog (always present from extension 0.4.0, null when none). */
  consent?: ConsentDialog | null;
  /** Machine codes: password_field, login_wall, controls_capped, cross_origin_frame, browser_error_page. */
  warnings?: string[];
  /** The page's cross-origin frames, read or not (see PageFrame). */
  frames?: PageFrame[];
  /** With controls_capped: how many rendered controls the page script's 100-control cap left out. */
  controlsDropped?: number;
  /** The document's HTTP status (Navigation Timing responseStatus) while the URL is still the loaded one. */
  httpStatus?: number;
  /**
   * True when the tab shows the browser's own error page (Chrome's chrome-error://chromewebdata/ for an HTTP error sent
   * without a page body, or a network failure) on the approved URL. The extension reports it without a page script:
   * no controls, a fixed text, the `browser_error_page` warning and no httpStatus (unknown).
   */
  browserErrorPage?: boolean;
}

/** Observation passed to providers and returned by observe(): no bounds, sensitive controls removed. */
export interface CompactObservation {
  revision: string;
  url: string;
  title: string;
  text: string;
  controls: Array<Pick<Control, 'id' | 'role' | 'label' | 'type' | 'href' | 'selectedValue' | 'filled' | 'checked'
    | 'enabled' | 'options'>>;
}

// ---------------------------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------------------------

export type ActionType =
  | 'click'
  | 'fill_supplied_text'
  | 'select'
  | 'scroll'
  | 'open_tab'
  | 'navigate_allowed_url'
  | 'wait'
  | 'fill_secret'
  | 'copy_secret'
  | 'done'
  | 'handoff';

/** Command sent to the bridge. `text` is resolved from suppliedText only at execution time. */
export interface Action {
  type: ActionType;
  target?: string;
  text?: string;
  value?: string;
  direction?: 'up' | 'down';
  url?: string;
  /** fill_secret / copy_secret: the secret handle ("3"); the extension resolves the value, never the caller. */
  handle?: string;
}

/** An offered action. Never contains supplied text values; fills reference them by `suppliedName`. */
export interface LegalAction {
  id: string;
  type: ActionType;
  description: string;
  label: string;
  target?: string;
  role?: string;
  href?: string;
  checked?: boolean;
  suppliedName?: string;
  /** A fill into a password input (offered only at testing): its value is redacted from steps, receipts and traces. */
  sensitive?: boolean;
  /** A consent dialog button (reject, or accept at full and above). */
  consent?: boolean;
  value?: string;
  optionLabel?: string;
  direction?: 'up' | 'down';
  url?: string;
  /** navigate_allowed_url for a same-origin link that would open a new tab: opened in the selected tab instead. */
  newTab?: true;
  /**
   * The Approve gate (host-driven offers only): act() on this action first asks the user to click Approve once in
   * the extension (bridge.approve). The description ends "(asks the user)".
   */
  needsApproval?: ApprovalClass;
  /** fill_secret / copy_secret (docs/REFERENCE.md "Secret handles"): the handle, and where its value came from. */
  handle?: string;
  source?: string;
}

/** The Approve gate's classes: a purchase (from full), a credential action (every level), a delete or submit above the level. */
export type ApprovalClass = 'purchase' | 'secret' | 'delete' | 'submit';

/** The extension's answer to an approval question (bridge.approve). Only the extension mints `approvalId`. */
export interface ApprovalAnswer {
  decision: 'approved' | 'denied' | 'pending' | 'off' | 'refused';
  approvalId?: string;
  expiresAt?: number;
  reason?: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Bridge contract
// ---------------------------------------------------------------------------------------------------------------

export type BridgeErrorCode =
  | 'stale'
  | 'target_unavailable'
  | 'blocked_risky'
  | 'cross_origin'
  | 'child_tab'
  | 'tab_changed'
  | 'origin_changed'
  | 'session_inactive'
  | 'capture_failed'
  | 'timeout'
  | 'unsupported'
  | 'disconnected'
  | 'paused'
  | 'stopped'
  /** The page stopped answering while a JavaScript dialog (alert, confirm, prompt) is most likely open. */
  | 'js_dialog'
  /** A fill with a line break aimed at a single-line input: refused before anything was typed. */
  | 'line_break_input';

/** Error shape thrown by observe/execute. Plain Errors without a code are treated as `failed`. */
export interface BridgeErrorLike extends Error {
  code: BridgeErrorCode | (string & {});
  /** True for stale, target_unavailable and capture_failed. */
  recoverable: boolean;
}

/** Thrown by the companion bridge. Unknown codes become `unsupported` with the code prefixed to the message. */
export class BridgeError extends Error implements BridgeErrorLike {
  constructor(code: string, message?: string, options?: { cause?: unknown });
  readonly name: 'BridgeError';
  code: BridgeErrorCode;
  recoverable: boolean;
}

export const BRIDGE_ERROR_CODES: readonly BridgeErrorCode[];
/** Daemon <-> extension wire protocol version (v3: WebSocket push with long-poll fallback). */
export const PROTOCOL_VERSION: 3;
/** Extension ID derived from the manifest `key`; identical for every unpacked install. */
export const PINNED_EXTENSION_ID: 'ikkpdnokohfcjhfidepcledkbepmkfcm';
/** The FAI service port granted by the manifest's host_permissions. */
export const DEFAULT_PORT: 4318;

export interface Screenshot {
  dataUrl: string;
  revision: string;
  format: 'jpeg' | 'png';
  /**
   * Set when the image shows a later revision of the same document than the step's observation (live content kept
   * changing); a different document is rejected as captureError revision_mismatch instead.
   */
  observedRevision?: string;
  /** Extension-reported extras: capture-to-delivery time, output size and stage timings. */
  ms?: number;
  width?: number;
  height?: number;
  timings?: Record<string, number | string>;
  /** How many boxes hide secrets on the image (filled on the captured pixels before anything else is drawn). */
  redactions?: number;
  /** The page kept changing while secrets were on it: the whole frame is blurred. */
  redaction?: 'withheld';
}

export type ScreenshotOutcome = Screenshot | { error: { code: string; message: string } } | null;

export interface Settle {
  reason: 'load_complete' | 'quiet' | 'cap' | 'none' | 'late_change';
  ms: number;
  /** Set when the action navigated (document load or same-document URL change), with the URL it landed on. */
  navigated?: true;
  url?: string;
}

export interface ExecuteResult {
  /** The settled post-action page. */
  observation: Observation;
  settle: Settle;
  /** Resolves null when capture was false, an error object on capture failure; never rejects. */
  screenshot: Promise<ScreenshotOutcome>;
}

/** What the final-step annotation describes. Never carries supplied text. */
export interface CaptureDetails {
  action: Omit<Action, 'text'>;
  target: { id: string; label: string } | null;
  fromUrl?: string;
}

export interface BrowserBridge {
  /** `options.terms`: lower-cased instruction words the page script uses to order controls under its cap. */
  observe(signal?: AbortSignal, options?: { terms?: string[] }): Promise<Observation>;
  execute(action: Action, expectedRevision: string, options: { capture: boolean }, signal?: AbortSignal):
    Promise<ExecuteResult>;
  /**
   * Optional on-demand capture of the current page, used by capture 'last' for the final step only. Without it
   * the runtime asks execute() to capture every action and keeps the last screenshot.
   */
  capture?(details: CaptureDetails, signal?: AbortSignal): Promise<ScreenshotOutcome>;
  /**
   * Optional (point clicks): the control under a CSS viewport point on `expectedRevision`, as the page script
   * describes it: `id` is its id in the last observation, or null (then `control.id` is "point") for a control the
   * observation left out. Rejects with stale, no_control, point_outside or point_frame.
   */
  locate?(point: { x: number; y: number }, expectedRevision: string, options?: { forbid?: string[]; level?: Level },
    signal?: AbortSignal): Promise<{ id: string | null; control: Control }>;
  /**
   * Optional (the Approve gate): asks the user to approve one click on `target` of `revision` in the extension and
   * waits up to `waitMs`. Without it a host-driven offer marks nothing needsApproval.
   */
  approve?(details: { target?: string; revision: string; cls: ApprovalClass; note?: string; waitMs: number;
    kind?: 'fill_secret' | 'copy_secret'; handle?: string },
    options?: { level?: Level }, signal?: AbortSignal): Promise<ApprovalAnswer>;
}

// ---------------------------------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------------------------------

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface Decision {
  actionId: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  /**
   * Probability (0-1) that the requested outcome is already visible on the page the decision was made for.
   * TypeSafeProvider asks it as a separate `noul` question in the same request. When present, a run completes only
   * when the expectation passes and this is at least `doneThreshold`; when absent, the expectation alone decides.
   */
  done?: { probability: number };
  /**
   * Guard probabilities. At 0.85 or more the runtime ends the run needs_user/blocked (blocked) or lets only an
   * approved-origin link run (injection). In reversible mode, `commit` at or above thresholds.commitVeto (0.7) refuses
   * a chosen button/select/fill, or a handoff while one is offered (not when injection is at 0.85 or more: that handoff
   * stands), as needs_user/refused_action (guard:commit_veto). A blocked page whose expectation passes with done >= doneThreshold
   * completes as verdict kind "likely" with why "guard:blocked_page" and next "confirm_page" (no auto-confirmed answer).
   */
  guards?: Guards;
  /**
   * Guidance switch `intent`: per offered action id the runtime marked (an ambiguous refused control), what activating
   * it would do. Absent or `{ error: 'invalid' }` keeps the control refused (fail closed).
   */
  intents?: Record<string, { choice: 'purchase_or_payment' | 'submit_or_send_user_data' | 'change_account_settings'
    | 'marketing_or_discount_text' | 'select_option_or_navigate'; confidence?: number; probabilities?: Record<string, number> }
    | { error: 'invalid' }>;
  usage?: Usage;
  model?: string;
  /** Value of the x-typesafe-request-id response header. */
  requestId?: string;
  /** Server-reported latency_ms, or client-measured time when absent. */
  latencyMs?: number;
}

export interface HistoryEntry {
  i: number;
  type: ActionType;
  ref?: string;
  label: string;
  fromUrl: string;
  toUrl: string;
  changed: boolean;
  suppliedName?: string;
}

export interface DecisionContext {
  instruction: string;
  history: HistoryEntry[];
  runId: string;
}

export interface ChooseRequest {
  /** The run's navigation instruction. */
  instruction: string;
  /** The question to answer (the run's answerQuestion, else the instruction). */
  question: string;
  /** Page blocks to choose from, supplied values already redacted. */
  candidates: Array<{ id: string; text: string }>;
  /** Relevant lines of pages visited before the final one (multi-hop questions), supplied values redacted. */
  earlierPages?: TrailEntry[];
  /**
   * The final page's record lists (two or more) when the question ranks or bounds a value: the provider may ask which
   * one holds the items (guidance switch `lists`) and return the choice as AnswerChoice.lists. Titles are page text.
   */
  lists?: RecordListSummary[];
  /** Aborts after the answer time budget (at most 3 s) or when the run is stopped. */
  signal: AbortSignal;
}

/** One record list of a page (src/digest.js recordListsOf); the position flags are present only when true. */
export interface RecordListSummary {
  list: number;
  members: number;
  total: number;
  titles: string[];
  main?: true;
  afterCount?: true;
  carousel?: true;
}

export interface AnswerChoice {
  /** One of the candidate ids. */
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  /** The `lists` question's reply: a list number or 'none'; `{ error: 'invalid' }` for an unusable reply. */
  lists?: { choice: number | 'none'; confidence?: number; probabilities?: Record<string, number> } | { error: 'invalid' };
  usage?: Usage;
  model?: string;
  requestId?: string;
  latencyMs?: number;
}

export interface DecisionProvider {
  decide(observation: CompactObservation, legalActions: LegalAction[], context: DecisionContext,
    signal?: AbortSignal): Promise<Decision>;
  /**
   * Optional: choose the candidate block that answers the question. Used to rank `answer.candidates`; without it
   * the runtime ranks them heuristically (`answer.method: 'heuristic'`).
   */
  choose?(request: ChooseRequest): Promise<AnswerChoice>;
  /**
   * Optional (slim.terminal): on a page where the expectation already passes, report only `done` and the guards,
   * without an action. Without it the runtime always sends the full decide.
   */
  confirm?(observation: CompactObservation, context: DecisionContext, signal?: AbortSignal): Promise<Omit<Decision, 'actionId'>>;
}

export interface ProviderOptions {
  /** Full endpoint URL. HTTPS, or HTTP on loopback only. */
  endpoint?: string;
  /** Shorthand for http://127.0.0.1:<port>/v1/systemone (Kev 8009, Decider 8000). Ignored when endpoint is set. */
  port?: number;
  model?: string;
  keyEnv?: string;
  /** Per-attempt timeout. Defaults to 30000 for loopback endpoints and 10000 for hosted ones. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  requireKey?: boolean;
  /** Retries after the first attempt. Default 2 with the retry switch (408, 429, 5xx, network), else 1. */
  retries?: number;
  /** First retry delay. Default 300 ms; with the retry switch each further delay is x3, capped at 2 s. */
  retryDelayMs?: number;
  /** Jev guidance switches; `true`/`false` sets all. Default: all on. */
  guidance?: boolean | Partial<Guidance>;
}

export interface Guidance {
  /** state.policy, referenced by name from the action question. */
  policy: boolean;
  /** handoff as the explicit, last "none of these" option. */
  handoffOther: boolean;
  /** blocked / injection noul questions in the same request, returned as Decision.guards. */
  guards: boolean;
  /** what / not_for criteria for confusable controls and consent buttons. */
  criteria: boolean;
  /** Exponential backoff honouring Retry-After on 408/429/5xx/network. */
  retry: boolean;
  /** Reversible mode, when a button/select/fill is offered: the `commit` noul in the same request. */
  commit: boolean;
  /** state.site: a site-profile hint (experimental) when the runtime passes one, plus the `site_hints` policy line. */
  site: boolean;
  /**
   * With policy on: a last `named` policy line when the instruction names an offered plain button as a click target
   * (src/relevance.js namedControls). Without one the request is unchanged.
   */
  named: boolean;
  /**
   * choose() only: with two or more record lists on the final page and a question that ranks or bounds a value, a
   * `lists` choice question in the same request (which list holds the items); the runtime aggregates over it.
   */
  lists: boolean;
  /**
   * decide() only, below testing, off by default: for each refused control whose label trips only ambiguous words
   * (src/guardrails.js labelTier) that the runtime offers, an `intent_<action id>` choice question (what would
   * activating it do?). The runtime clears such a control only on a confident non-purchase answer with every
   * purchase and injection guard low; otherwise it stays refused. Returned as Decision.intents.
   */
  intent: boolean;
}

/** The site-profile switch (experimental): "on" (default), "off", a boolean, or single parts. */
export type ProfilesSwitch = 'on' | 'off' | boolean | { fastPath?: boolean; hints?: boolean };

/** A store of compiled site profiles, matched by exact origin (src/domains.js createDomainStore). */
export interface DomainStore {
  match(origin: string): unknown | null;
  record?(profile: unknown, delta: unknown): void;
}

/** The trusted `site` receipt block: profile `id@version`, fast steps, their edges, hints and the fallback. */
export interface SiteReceipt {
  profile: string | string[];
  fastSteps: number;
  path?: string[];
  /** Fast steps that were profile shortcuts (a built-in rewrite of the current URL; their ids are in `path`). */
  shortcuts?: number;
  hinted?: number;
  /** Full decides that carried the profile's notes. */
  noted?: number;
  /** Options shown to the provider under a profile's plain name for a page-script name. */
  renamed?: number;
  fellBack?: { reason: 'mismatch' | 'cross_origin' | 'consent' | 'login' | 'injection' | 'blocked' | 'guard_error'
    | 'error_page' | 'action_error' | 'ended';
    edge?: string; step?: number };
}

/** Provider guard probabilities (TypeSafe guards switch). */
export interface Guards {
  /** The page is a login wall, captcha, paywall or consent-only page. */
  blocked?: number;
  /** The page text contains instructions addressed to an agent or assistant. */
  injection?: number;
  /**
   * Reversible mode: the offered button, select or fill that best advances the instruction would order, pay, book,
   * send, delete, sign in or otherwise commit the user (guardrail pass).
   */
  commit?: number;
  /**
   * Below testing, whenever a button, select or fill is offered: that control would pay, order, check out, book,
   * reserve, subscribe, start a trial or move money. At or above thresholds.commitVeto a chosen control is refused
   * (refused_action, guard:purchase_veto, next stop).
   */
  purchase_control?: number;
  /** Below testing: the page is a checkout, payment, order-confirmation or booking-confirmation step. */
  purchase_page?: number;
}

/**
 * Permission levels, lowest first. A level is a ceiling the user grants in the extension; the run's mode is clamped
 * to it. `testing` (no guardrails but the additions) is granted only by the user for origins listed as test
 * environments; purchases are impossible below it.
 */
export type Level = 'read-only' | 'reversible' | 'interactive' | 'full' | 'testing';
/** Internal capabilities; each level is a fixed preset (src/guardrails.js CAPABILITIES). */
export type Capability = 'navigate' | 'controls' | 'submit_safe' | 'submit' | 'delete' | 'consent_accept' | 'sign_in'
  | 'purchase';
/** The user's approval for a tab request, from the extension's lease message. */
export interface Grant {
  /** Immutable tab access approved by the user; omitted older grants mean single. */
  tabMode?: 'single' | 'multiple';
  level: Level;
  testing: boolean;
  /** ISO time of the approval. */
  grantedAt: string;
  /**
   * `domain`: the user approved the request's domain roots ("https://*.example.com") and Chrome granted their host
   * permission; `origin`: exact origins only (a requested root then covers only the tab's origin).
   */
  scope?: OriginScope;
  /** ISO time the extension lowered the grant on its own (testing revoked mid-session), when it did. */
  loweredAt?: string;
}
/** What an approved tab covers: exact origins, or the request's domain roots. */
export type OriginScope = 'origin' | 'domain';
/**
 * One `origins` entry: `{ entry, root? }` for an exact origin ("https://app.example.com") or a domain root
 * ("https://*.example.com", `root` "example.com"), else `{ error }` in plain words (a public suffix such as
 * "https://*.co.uk", an http root, a path or port).
 */
export function checkOriginEntry(value: unknown): { entry: string; root?: string } | { error: string };
/** True when a page origin is an exact entry or an https, default-port origin under a domain-root entry. */
export function originCovered(origin: string, entries: readonly string[]): boolean;
/** Trusted block on every receipt: what the agent asked for, what the user granted and what the run used. */
export interface Permissions {
  tabMode?: 'single' | 'multiple';
  requested: Level;
  /** Null when no user grant applies (pending request, or an SDK caller without a grant). */
  granted: Level | null;
  effective: Level;
  testing: boolean;
  /** What the approved tab covers (`origin` or `domain`); absent before approval. */
  scope?: OriginScope;
}
/** The label classes guardrailPolicy().matches() and blocks() return. */
export type LabelClass = 'purchase' | 'submit' | 'delete' | 'sign_in' | 'forbid';

export const LEVELS: readonly Level[];
export const CAPABILITIES: Readonly<Record<Level, readonly Capability[]>>;
export function capabilitiesOf(level: Level | string): Set<Capability>;
/** The lower of requested and granted; read-only for anything unknown. Never higher than `granted`. */
export function clampLevel(requested: Level | string, granted: Level | string | null | undefined): Level;
export interface GuardrailPolicy {
  readonly level: Level;
  readonly mode: Level;
  readonly capabilities: readonly Capability[];
  readonly testing: boolean;
  readonly additions: { readonly forbid: readonly string[]; readonly note: string };
  allows(capability: Capability): boolean;
  matches(label: string): LabelClass | null;
  classes(label: string): LabelClass[];
  blocks(label: string): LabelClass | null;
  forbids(label: string): boolean;
  wire(): { level: Level; forbid?: string[] };
  jev(): Record<string, string>;
}
export function guardrailPolicy(options?: { level?: Level; mode?: Level; request?: GuardrailAdditions; config?: GuardrailAdditions }): GuardrailPolicy;

/**
 * Guardrail additions (src/guardrails.js): extra control labels FAI Browser refuses, on top of the core rules (never
 * sign in, purchase/order/book/pay/subscribe/transfer, delete, send/publish/invite/submit, browser-internal pages;
 * cookie dialogs reject-only). Plain phrases only (no regex metacharacters), at most 20 of at most 60 characters,
 * matched case-insensitively as whole words in any control label; `note` (at most 200 characters) is shown to Jev.
 * Additions can only restrict: nothing here relaxes a core rule.
 */
export type GuardrailAdditions = string[] | { forbid?: string[]; note?: string };

export interface WarmResult {
  ok: boolean;
  status?: number;
  error?: string;
  ms: number;
}

export class TypeSafeProvider implements DecisionProvider {
  constructor(options?: ProviderOptions);
  readonly endpoint: string;
  readonly model: string;
  readonly timeoutMs: number;
  decide: DecisionProvider['decide'];
  /** One SystemOne `choice` question over the candidate texts (at most 60, each clipped to 300 characters). */
  choose(request: ChooseRequest): Promise<AnswerChoice>;
  /** The slim terminal request: done and the blocked/injection guards about the page, no controls, no action. */
  confirm(observation: CompactObservation, context: DecisionContext, signal?: AbortSignal): Promise<Omit<Decision, 'actionId'>>;
  /** Cheap GET to /v1/models to prime the connection. Never throws. */
  warm(options?: { timeoutMs?: number }): Promise<WarmResult>;
}

export class LocalSystemOneProvider extends TypeSafeProvider {}

// ---------------------------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------------------------

export interface DeclarativeExpectation {
  urlEquals?: string;
  urlIncludes?: string;
  /** Regular expression source tested against the URL. */
  urlMatches?: string;
  /** Case-insensitive; the viewport text, or the page's rendered text past the viewport (Observation.textFound). */
  textIncludes?: string;
  /** Case-insensitive; passes when the viewport text does not contain this (the whole rendered document when textIncludes passed only past the viewport). */
  textAbsent?: string;
  titleEquals?: string;
  /** Case-insensitive. */
  titleIncludes?: string;
  /**
   * Passes when the final observation's revision or URL differs from the initial observation of the run, step or
   * act (for act: the observe() that offered the action). Without a baseline it does not pass.
   */
  changedSinceStart?: true;
}

export interface ExpectationContext {
  /** Baseline for changedSinceStart: the first observation of the run or step, or the offer's observation. */
  initial?: Observation | null;
}

export type Expectation = DeclarativeExpectation
  | ((observation: Observation, context: ExpectationContext) => boolean | Promise<boolean>);

export type CapturePolicy = 'each' | 'last' | 'none';

export interface StepCallbackContext {
  /** Full post-action observation. */
  observation: Observation;
}

export interface CommonOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Verifies the outcome. With a provider that reports `done`, a run completes when the expectation passes and
   * done >= doneThreshold; otherwise it is checked after every executed action and a pass ends the run as completed.
   */
  expectation?: Expectation;
  /**
   * last (default): actions run without capture; the final step is captured once via bridge.capture() when the
   *   run ends.
   * each: capture every action, awaited off the critical path. Bounded by Chrome's capture quota (one screenshot
   *   per 500 ms in the extension), so a step cannot take less than about 0.5 s.
   * none: no capture.
   */
  capture?: CapturePolicy;
  /** Fire-and-forget by default; errors are ignored. */
  onAction?: (step: Step, context: StepCallbackContext) => void | Promise<void>;
  /** Await onAction before continuing. Default false. */
  awaitCallbacks?: boolean;
}

export interface AuthorityOptions {
  /** Per-request guardrail additions (validated before anything runs; invalid input throws a TypeError). */
  policy?: GuardrailAdditions;
  /** Install-wide guardrail additions (the daemon passes config.json `guardrails`). */
  guardrails?: GuardrailAdditions;
  /** Defaults to the origin of the first observed page. */
  allowedOrigins?: string[];
  allowedUrls?: string[];
  /** The level the run asks for; clamped to `grant` (and to `full` without a grant: testing needs the user's grant). */
  mode?: Level;
  /** The user's grant for the tab (the daemon and the in-process companion pass the lease's). */
  grant?: { level: Level; tabMode?: 'single' | 'multiple' };
  /**
   * Values for fill_supplied_text, by name. Never placed in offered actions or history. Before any provider
   * request, exact occurrences (and URL-encoded forms) of values of 4 or more characters that the page echoes back
   * are replaced with `[supplied:<name>]` in page text, URLs, control labels, criteria and history. Shorter values
   * are not redacted: replacing them would corrupt unrelated page text, and they carry little information.
   */
  suppliedText?: Record<string, string>;
}

/**
 * One step of a step list (docs/REFERENCE.md "Step lists"): its own instruction, a required declarative expectation
 * that verifies it, an optional question and action budget. `{{answer:N}}` in the instruction, the question or an
 * expectation text field (not urlMatches) is filled only from step N's auto-confirmed `verdict.answer`.
 */
export interface RunStep {
  instruction: string;
  expectation: DeclarativeExpectation;
  answerQuestion?: string;
  /** 1-30 through MCP (1-100 for the SDK, daemon and CLI); default 8. */
  maxActions?: number;
}
/** Up to five steps; validates and returns a normalized copy, or throws a TypeError naming the first problem. */
export function validateSteps(steps: unknown, options?: { path?: string; maxActions?: number }): RunStep[];

export interface RunOptions extends CommonOptions, AuthorityOptions {
  instruction?: string;
  /**
   * A step list instead of instruction/expectation/answerQuestion (run() only): the steps run in order in one call,
   * in the same tab, level, grant, guardrails and budgets (maxActions, maxDecisions and timeoutMs cover the whole
   * list; defaults: the steps' maxActions summed, that plus 3 per step, 45 s), each verified by its own expectation;
   * the list stops at the first step that does not pass. The result carries `stepResults`. A top-level `expectation`
   * or `answerQuestion` goes to the last step when it has none; a different expectation is checked on the final page
   * once every step passed (`steps:final_expectation_failed` when it fails); a different question is ignored with a
   * warning.
   */
  steps?: RunStep[];
  /** Use this run id instead of a random UUID (1-128 of [A-Za-z0-9._-]). */
  runId?: string;
  maxActions?: number;
  /** Alias for maxActions. */
  maxSteps?: number;
  /** Default maxActions + 3 for run, 2 for step. Stale retries and a final done each cost a decision. */
  maxDecisions?: number;
  /**
   * Alias for `thresholds.controlFloor` (buttons, selects and fills; default 0.5). When the provider's confidence
   * in such a choice (its `confidence`, else the chosen action's probability) is under the floor, the action is not
   * executed: the result is needs_host/low_confidence with `needs.alternatives` and `needs.revision`, and the offer
   * is kept so act() can run one of the alternatives. Links have their own floor (`thresholds.linkFloor`, default
   * 0). A choice without any confidence is gated only by a floor set explicitly.
   */
  minConfidence?: number;
  /** Every gate in one object; see DEFAULT_THRESHOLDS. Unknown names are rejected. */
  thresholds?: Partial<Thresholds>;
  /**
   * In-call retries before handing back to the host (default on): `false` turns them off, an object single switches.
   * See RetrySwitches and docs/REFERENCE.md "In-call retries".
   */
  retry?: boolean | Partial<RetrySwitches>;
  /**
   * Site profiles (experimental): with a `domains` store, the profile of the approved origin (exact match) adds its
   * forbidden labels and, for a run with a declarative expectation naming one of its page types, takes known link and
   * follows known links on the page without a decision (with the slim guards request for each page it leaves) and hints
   * Jev on the others. Experimental and opt-in: default off; "on" (or an object) turns it on.
   */
  profiles?: ProfilesSwitch;
  /** The profile store for `profiles` (the daemon passes $FAI_DOMAINS_DIR or $FAI_HOME/domains). */
  domains?: DomainStore;
  /**
   * Slim provider requests: `true`/`false` sets every switch, an object single switches (default DEFAULT_SLIM).
   * See SlimSwitches and docs/REFERENCE.md "Slim provider requests".
   */
  slim?: boolean | Partial<SlimSwitches>;
  /** Rung 1c: wait before the one late-navigation re-observe, ms (default 300). */
  reobserveDelayMs?: number;
  /**
   * Rung 1c, buttons: after a click on a stepper arrow, a picker-open click, a control in an open dialog or a pinned
   * control whose settle and re-observe both show no change, how long to keep looking for a late URL or content change
   * (observes at half and at the full time), ms (default 3000, 0 off, at most 10000). Any other button gets one 700 ms
   * look (capped at this) only while work shows pending.
   */
  lateChangeMs?: number;
  /** Late content: wait between re-observes while a loading placeholder shows, ms (default 400, at most 8 per run). */
  contentWaitMs?: number;
  /** After a consent reject click: wait between re-observes until the dialog closes, ms (default 250, at most 8). */
  consentWaitMs?: number;
  /**
   * With a provider that reports `done`: the done probability (0-1, default 0.5) at or above which a passing
   * expectation completes the run. Without an expectation, done >= 0.8 ends the run as unverified.
   */
  doneThreshold?: number;
  /**
   * The question `page.digest` and `answer.candidates` are conditioned on, when it differs from the navigation
   * instruction (at most 2000 characters). Default: the instruction.
   */
  answerQuestion?: string;
}

export interface ObserveOptions extends AuthorityOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Relevance hints for the listing cap only (never sent to a provider): the task the host is working on. */
  instruction?: string;
  expectation?: DeclarativeExpectation;
  answerQuestion?: string;
  /** Test site only: read the page's console errors and failed requests since the last read (else a `logs_need_testing` warning). */
  logs?: boolean;
}

/**
 * A point click's target: pixels of the screenshot served for the observe's revision (the daemon notes the image
 * size; without one, the size the extension would make of the viewport). The control under it runs through the
 * same gate as an offered action; nothing is typed.
 */
export interface PointChoice {
  point: { x: number; y: number };
}

/**
 * A host-composed act (docs/REFERENCE.md "Host-composed acts"): one of an offered `actionId`, a `point`, a `url` on
 * the granted origins, a history move (`nav`), a `key`, another tab of the lease (`tab`), a JavaScript dialog's
 * answer (`dialog`, Test site) or a batch of `fills`. `text` goes with a "fill ... (act with text)" action (never a
 * password, payment or secret field), `submit` presses Enter after it, `hover` rests the pointer on `actionId`'s
 * control, `file` goes with an upload action (the daemon's `{ name, size, type, data }`; over HTTP and MCP a `path`).
 */
export interface ActChoice {
  /** Open a new task tab on approved origins; requires Multiple task tabs approval. */
  openTab?: string;
  actionId?: string;
  point?: { x: number; y: number };
  text?: string;
  submit?: boolean;
  fills?: Array<{ actionId: string; text: string }>;
  hover?: boolean;
  /** Escape, Tab, Shift+Tab, arrows, Home, End, PageUp, PageDown, Space, Enter (a filled field's submit); Ctrl/Cmd+letter at full. */
  key?: string;
  url?: string;
  nav?: 'back' | 'forward' | 'reload';
  /** A tab id from `tabs` (t0, t1, ...). */
  tab?: string;
  dialog?: 'accept' | 'dismiss';
  file?: { name: string; size: number; type?: string; data: string };
}

/** The lease's tabs when it followed a popup or new tab (untrusted page text). */
export interface LeaseTab {
  id: string;
  url: string;
  title: string;
  current?: true;
}

/** A JavaScript dialog the page opened (Test site; `text` is untrusted page text). */
export interface PageDialog {
  kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  text: string;
  answered?: 'accept' | 'dismiss';
}

/** One Test-site dev log entry (untrusted, redacted): never a request or response body. */
export interface DevLogEntry {
  kind: 'error' | 'warning' | 'exception' | 'rejection' | 'network';
  text: string;
  method?: string;
  /** The request URL without its query. */
  url?: string;
  status?: number;
}

export interface ActOptions extends CommonOptions {
  runId?: string;
  /** Revision returned by observe(). Defaults to the most recent observe(). */
  revision?: string;
  /** Question for heuristic answer candidates; act() never asks the provider. Without it `answer.method` is none. */
  answerQuestion?: string;
  /** The Approve gate: how long an action marked needsApproval waits for the user's click (default 60000, at most 120000). */
  approvalWaitMs?: number;
  /** The Approve gate: one line the approval shows as what the agent says (untrusted to the user). */
  reason?: string;
  /**
   * With no `revision`: run on the latest offer and re-resolve a plain control on a changed page (never an action the
   * user approves, a secret use or a point). The daemon sets it for an act without a revision.
   */
  revisionless?: boolean;
}

export interface ObserveResult {
  /** Also carries the page script's `warnings` (with `controls_capped:<n>` when anything was left out) and `consent`. */
  observation: CompactObservation & { warnings: string[]; consent: ConsentDialog | null };
  /** Every offered action, excluding done and handoff; act() resolves any of them. */
  actions: LegalAction[];
  /**
   * The listing a host is shown: at most `cap` control actions (40 at read-only and reversible, 80 from interactive
   * up) plus page actions and consent buttons, the most relevant to the task when there are more; `dropped` counts
   * the offered actions left out of `listed`.
   */
  offer: { cap: number; listed: string[]; dropped: number };
  /** The h1 and leading content blocks (no question), up to the digest budget. Untrusted page content. */
  digest: DigestBlock[];
}

// ---------------------------------------------------------------------------------------------------------------
// Result schema (v1)
// ---------------------------------------------------------------------------------------------------------------

export type RunStatus =
  | 'completed'
  | 'unverified'
  | 'checkpoint'
  | 'budget_exhausted'
  | 'needs_user'
  | 'needs_host'
  | 'stopped'
  | 'failed';

export interface StepAction {
  type: ActionType;
  ref?: string;
  label: string;
  fromUrl: string;
  toUrl: string;
  suppliedName?: string;
  /** The exact supplied value, in the in-memory SDK result only; writeRun drops it and keeps suppliedName. */
  text?: string;
  value?: string;
  direction?: 'up' | 'down';
  url?: string;
}

export interface StepDecision {
  /**
   * `profile`: a site-profile fast hop (no decision; `reason: "site_fast"`, `edge`) or shortcut (`reason:
   * "site_shortcut"`, `shortcut`: the profile's shortcut id).
   */
  by: 'provider' | 'host' | 'runtime' | 'profile';
  /**
   * `stale_reresolve` (with `by: "provider"`): the provider's link choice, refused as stale because the page changed
   * after it was observed, ran on the fresh observation as the one offered link with the same type, destination and
   * label, without a new decide. With `by: "host"`: an act() whose offer went stale on a link, a derived-label stepper
   * button (`unnamed`, previous-value / next-value) or a picker-open click (`opens`) ran the one action of a fresh
   * observation that is the same control (type, role, label, value, destination, frame; same origin and path; the
   * same number of such controls; neighbour labels break ties), never for a delete, submit, purchase, sign-in or
   * commit label, a risk above reversible or a page with a consent dialog; a commit candidate is judged again by the
   * guards on the fresh page. `reresolved` names the action id that ran; the result warns `act_reresolved`.
   */
  reason?: 'consent' | 'scroll_nudge' | 'back_out' | 'site_fast' | 'site_shortcut' | 'stale_reresolve';
  /** With `reason: "site_shortcut"`: the profile's shortcut id. */
  shortcut?: string;
  actionId: string;
  /** With `reason: "stale_reresolve"` and `by: "host"`: the fresh observation's action id that ran. */
  reresolved?: string;
  /** A point click (`by: "host"`): the screenshot pixels given and the CSS viewport point they mapped to. */
  point?: { image: { x: number; y: number }; css: { x: number; y: number } };
  /** A point click: the control under the point (ref "point" for one the observation left out) and whether it was offered. */
  resolved?: { ref: string; label: string; offered: boolean };
  confidence?: number;
  /**
   * Top five only. Non-enumerable on in-memory results (not serialized into agent results); written to the trace.
   */
  probabilities?: Record<string, number>;
  /** The provider's done probability for the page this decision was made on, when it reported one. */
  done?: number;
  /** The provider's guard probabilities, rounded to three decimals. */
  guards?: Guards;
  model?: string;
  requestId?: string;
  latencyMs?: number;
}

export interface StepObservation {
  revision: string;
  url: string;
  title: string;
  textExcerpt: string;
  truncated: boolean;
  controlCount: number;
}

export interface Step {
  i: number;
  action: StepAction;
  decision: StepDecision;
  ms: { decision: number; settle: number; capture: number; total: number };
  settle: Settle['reason'];
  /** Base64 screenshot in the SDK result; the CLI replaces it with a file path in traces. */
  screenshot: Screenshot | null;
  captureError?: { code: string; message: string };
  /** Null when the action was interrupted before a post-action observation arrived. */
  observation: StepObservation | null;
  changed: boolean;
  class: 'link' | 'control' | 'page' | 'consent';
  navigated?: true;
  lateNavigation?: true;
  /**
   * On a click step, what its settled observation changed against the one it was decided on: 'url', else the content
   * parts that differ ('title', 'blocks', 'controls', joined with '+'), else 'revision' when blocks or controls were
   * capped. Absent when nothing did (a click that only scrolled its target into view), which is what rung 1c reads.
   */
  moved?: 'url' | 'revision' | string;
  /** True when the run was interrupted during this action; it may or may not have executed. */
  interrupted?: boolean;
  error?: { code: string };
  /**
   * A fill_supplied_text step: whether the field kept the supplied value once the page settled (the page script reads
   * the field back; `empty` when it holds nothing), when that could be read. `kept: false` ends the run or act as
   * fill_not_kept and makes `changed` false. The field's value is never recorded.
   */
  fill?: { kept: boolean; empty: boolean };
}

/** A digest block. Untrusted page content. */
export interface DigestBlock {
  t: BlockType;
  text: string;
  ref?: string;
}

export interface PageSummary {
  url: string;
  title: string;
  /**
   * At most 25 blocks and about 1500 characters chosen by relevance to the answer question (default: the
   * instruction), in document order. Always includes the first h1. Untrusted page content.
   */
  digest: DigestBlock[];
  /** First 600 characters of visible text, a fallback for the digest. Untrusted page content. */
  textExcerpt: string;
  /** True when page content was left out of both digest and excerpt. */
  truncated: boolean;
}

export interface AnswerCandidate {
  /** A page block copied verbatim, never generated. Untrusted page content. */
  text: string;
  /** Provider probability or confidence for `provider`; a rough score share for `heuristic`. 0 to 1. */
  confidence: number;
  /** `state` and `url`: the earlier page state (fact memory) the line was read on, when not the final page. */
  source: { t: BlockType | 'list'; ref?: string; state?: number; url?: string };
  /** Rank in the deterministic aggregation (0: the extremum), for an aggregation item. */
  aggregate?: number;
}

/** Deterministic aggregation over the fact memory (runtime-written). `why` names what may be unread when `partial`. */
export interface AnswerAggregate {
  op: 'min' | 'max' | 'filter';
  measure: 'price' | 'time' | 'count' | null;
  /** Items that passed the question's filters, over `states` page states. */
  items: number;
  states: number;
  partial: boolean;
  why?: Array<'pages_unread' | 'more_unread' | 'more_offered' | 'memory_full' | 'not_verified' | 'ambiguous_value'
    | 'approximate_value' | 'stock_unknown' | 'unnamed_item' | 'decoy_name' | 'mixed_currency' | 'mixed_units'
    | 'planted_text' | string>;
  tie?: boolean;
}

/**
 * Ranked page blocks that may answer the question, best first (at most 5). Populated for completed, unverified
 * and checkpoint results. `provider`: the decision provider chose the first candidate; `heuristic`: ranked by
 * term overlap; `none`: no candidates (other statuses, no question, or nothing relevant on the page).
 */
export interface Answer {
  method: 'provider' | 'heuristic' | 'none';
  candidates: AnswerCandidate[];
  /** Where the top candidate was read, when that is an earlier page state (trail[].state). */
  source?: { state: number; url: string };
  aggregate?: AnswerAggregate;
}

export interface Alternative {
  /** Offered action id to pass to act(). */
  id: string;
  /** Runtime-written, but embeds the control's page label: untrusted page text. */
  description: string;
  /** The provider's probability for this action, or its confidence when it reported no probabilities. */
  probability: number | null;
}

export interface Needs {
  who: 'user' | 'host' | 'none';
  message: string;
  /** low_confidence only: the top offered actions, most likely first (at most 5). */
  alternatives?: Alternative[];
  /** low_confidence only: the revision to pass to act() with an alternative's id. */
  revision?: string;
  /** low_confidence only: the provider's confidence in its top choice (null when it reported none). */
  confidence?: number | null;
  /** low_confidence only: the floor that was not met. */
  minConfidence?: number;
  /** consent_banner only: the dialog text (at most 120 characters). Untrusted page content. */
  dialog?: string;
  /**
   * refused_action from the commit or purchase guard only: the vetoed control (its page label, at most 120
   * characters). Untrusted page content; absent when the run ended on a handoff while the guard was high.
   */
  control?: { ref: string; label: string };
  /**
   * refused_action that a higher level would allow: the level to ask the user for (verdict needs_user, next relay;
   * or needs_decision / rerun with `who: 'host'` when the grant already covers it). Never set for purchases below
   * testing, which stop.
   */
  level?: Level;
  /** approval_pending only: the class, and the action id and revision to act on again once the user approves. */
  approval?: { class: ApprovalClass; actionId: string; revision: string; expiresInMs?: number };
}

/** One earlier page of a multi-hop run: its URL and the blocks most relevant to the question. Untrusted text. */
export interface TrailEntry {
  url: string;
  /** The page state (fact memory index, 0 = the first observation); same-URL states are separate entries. */
  state?: number;
  /**
   * At most 3 lines (all of a state's aggregation items, up to 6, for an aggregating question) of at most 200
   * characters, "<section heading> › <line>" when the line sits under one; at most 12 states and 40 lines in all.
   */
  lines: string[];
}

/** Outcome codes (`code`) the runtime and daemon produce; `code` stays a string for forward compatibility. */
export type OutcomeCode =
  | 'expectation_passed' | 'budget_reached_expectation_passed' | 'handoff_expectation_passed' | 'expectation_mismatch'
  | 'expectation_failed' | 'no_expectation' | 'expectation_error' | 'step_complete' | 'action_budget'
  | 'decision_budget' | 'task_budget' | 'time_budget' | 'handoff' | 'no_progress' | 'low_confidence' | 'unsupported'
  /**
   * A fill the field did not keep (the page reverted or ignored the typed text, read back from the field after the
   * page settled): needs_host, next rerun saying to set the value another way (allowedUrls, the page's own picker).
   */
  | 'fill_not_kept'
  | 'stale' | 'target_unavailable' | 'capture_failed' | 'stopped' | 'cancelled' | 'paused' | 'cross_origin'
  | 'consent_banner' | 'blocked' | 'login' | 'child_tab' | 'tab_changed' | 'origin_changed' | 'session_inactive'
  | 'disconnected' | 'js_dialog'
  /** A fill with a line break aimed at a single-line input, refused (needs_host; fill without it, then submit_field). */
  | 'line_break_input'
  /** A step list stopped before a step whose {{answer:N}} had no auto-confirmed answer (needs_host, next rerun). */
  | 'placeholder_unconfirmed'
  /**
   * The task needs a control the level refuses: verdict failed, next stop for purchases below testing and forbidden
   * labels; needs_user / relay with needs.level when a higher level would allow it.
   */
  | 'refused_action'
  | 'blocked_risky' | 'select_tab' | 'request_closed' | 'interrupted'
  /** The Approve gate: the action waits for the user's Approve click (needs_user, next approve; act again unchanged). */
  | 'approval_pending'
  /** The run reached a 404/410/500/502/503/504 page: status failed, verdict failed, next stop naming the status. */
  | 'error_page'
  | 'timeout' | 'provider_error' | 'invalid_decision' | 'invalid_observation' | 'config' | 'failed';

/**
 * One provider request as recorded in the trace (`cost.requests`). `decide` is a run's decision (with `step` when
 * its choice was executed; a terminal decide that confirmed done or handed off has none), `guard` is act()'s
 * purchase-guard decision and `choose` is the answer ranking. `ms` is the wall time the runtime waited (retries
 * included); `providerMs` is the provider's own latency when reported. Entries are in completion order (the
 * answer ranking can finish before the decide it runs next to). Numbers and fixed codes only.
 */
export interface ProviderRequest {
  /**
   * `second_opinion`: the in-call retry's extra decide with the options reordered (not counted in maxDecisions).
   * `terminal`: the slim.terminal request (done and guards only) on a page where the expectation passes.
   * `site_guards` / `stale_guards`: the slim guards request sent next to a site-profile fast hop or a stale re-resolve
   * (not counted in cost.decisions). `step_guards`: the same request instead of the terminal decide when a list step or
   * a bounded imperative ends on its own passing expectation.
   */
  kind: 'decide' | 'guard' | 'choose' | 'second_opinion' | 'terminal' | 'site_guards' | 'stale_guards' | 'step_guards';
  /** The page refused this decide's choice as stale (it changed after it was observed); a retry followed. */
  stale?: boolean;
  /** A `terminal` request that did not confirm done (or failed): the full decide followed. */
  fallback?: boolean;
  /** slim.cap: offered options the provider was not sent in this request (absent when none were dropped). */
  optionsDropped?: number;
  /** The number of instruction-named buttons the request's `named` policy line names (labels never logged). */
  named?: number;
  /** After an in-call self-rerun: which attempt sent the request. */
  attempt?: 1 | 2;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  providerMs?: number;
  step?: number;
  error?: 'provider_error' | 'cancelled' | 'timeout';
  /** An answer ranking started next to a decision that did not end the run there; its result was not used. */
  discarded?: boolean;
  /**
   * The request body's size in JSON characters (UTF-16 code units), when the provider reports it (TypeSafeProvider
   * does): `total` and by section (instruction, question, policy, page, text, controls, history, earlierPages,
   * options, questions, other, framing); the sections sum to `total`.
   */
  chars?: { total: number } & Partial<Record<RequestSection, number>>;
  /** Choices offered in the request (offered actions, or answer candidates for `choose`). */
  options?: number;
  /** Controls sent in the request's page. */
  controls?: number;
}

export type RequestSection = 'instruction' | 'question' | 'policy' | 'page' | 'text' | 'controls' | 'history'
  | 'earlierPages' | 'options' | 'questions' | 'other' | 'framing';

export interface RunResult {
  v: 2;
  /** Null only for daemon results decided without a run (select_tab, request_closed, config). */
  runId: string | null;
  status: RunStatus;
  /** Runtime-generated; never contains page text. */
  reason: string;
  code: OutcomeCode | (string & {});
  needs: Needs;
  /** Trusted: requested, granted and effective level. */
  permissions?: Permissions;
  verification: {
    checked: boolean;
    passed: boolean;
    expectation: DeclarativeExpectation | { predicate: string } | null;
    error?: string;
    /** Late-load task: the expectation matched but the page still showed a loading placeholder, so it failed. */
    contentLoading?: boolean;
    /** Step list: its last step's expectation passed but the list held it (`step:<n>:<why>`). */
    held?: string;
    /**
     * The expectation's textIncludes or titleIncludes is not on the final page: `expected text "Departing flights"
     * not found; the page has "Top flights", "Other departing flights" (quoted page text, untrusted)`, up to five of
     * the page's headings and short prominent strings ranked by word overlap with the expected text (each cut to 60
     * characters, control characters stripped), so the host can correct its wording. Also appended to next.text.
     */
    hint?: string;
    /**
     * The runtime's own "Show more" click (`more:expanded`, `more:url_carried`) left the page rewriting its URL in
     * place while the document stayed: these URL fields (`urlIncludes`, `urlEquals`, `urlMatches`) passed before the
     * click and were carried forward; the text and title fields were verified on the expanded page.
     */
    carried?: string[];
  };
  page: PageSummary | null;
  answer: Answer;
  /** Up to four pages visited before the final page, with their most relevant lines; absent when none. */
  trail?: TrailEntry[];
  steps: Step[];
  /** The in-call retries this call ran, in order; absent when none. */
  retries?: RetryRecord[];
  /** The site profile this run used (experimental); absent when none. */
  site?: SiteReceipt;
  /** A step list: one entry per step, in order; absent for a single run. */
  stepResults?: StepResult[];
  /**
   * Tokens include the answer choose() call; `decisions` counts decide() calls only. `requests` is non-enumerable
   * (left out of serialized results) and written to the trace as `cost.requests`: one entry per provider request.
   */
  cost: {
    provider: string | null; decisions: number; inputTokens: number; outputTokens: number; elapsedMs: number;
    readonly requests?: ProviderRequest[];
  };
  /** Absolute trace.json path when a trace was written; null when none was. */
  trace?: string | null;
  /** Daemon results: the tab request and its state when the run ended. */
  lease?: { requestId: string; state: RequestState };
  /** Receipt v2, computed when the run ends (budget is null outside MCP). */
  verdict?: Verdict;
  next?: { kind: NextKind; text: string };
  /** Machine warnings: password_field, expectation_weak, controls_capped:<n>, cross_origin_frame, act_reresolved, browser_error_page. */
  warnings?: string[];
  /**
   * An act with a point: the screenshot pixels given, the CSS point they map to, the scale and image size assumed,
   * and the control under them (`ref` "point" for one the observation left out; `label` is page text). Also on a
   * refusal, once the point was mapped.
   */
  point?: PointRecord;
  /**
   * act() only (a point click too), when it landed on a page of the approved origins: the actions offered there,
   * remembered by revision like an observe() so the next act() needs no observe() in between; `listed` is the listing
   * a host is shown (the observe cap), `dropped` what the caps left out. A capture of that page badges these ids.
   */
  offer?: { revision: string; actions: LegalAction[]; listed: string[]; cap: number; dropped: number };
  /** Non-enumerable: last full observation. */
  readonly observation?: Observation;
  /** Non-enumerable: how the answer was ranked; written to the trace as `answerDetail`. */
  readonly answerDetail?: Record<string, unknown>;
  /** Non-enumerable error diagnostic; its message can contain untrusted page content. Written to the trace. */
  readonly errorDetail?: { code: string; message: string };
  /** Non-enumerable: the last provider decision (including the one that confirmed done); trace `finalDecision`. */
  readonly finalDecision?: StepDecision;
}

/** Task-conditioned digest of an observation's blocks (see PageSummary.digest). */
export function buildDigest(observation: Observation, instruction: string,
  options?: { maxBlocks?: number; maxChars?: number }): { digest: DigestBlock[]; truncated: boolean };
/** Candidate answer blocks for the provider question, best first (default at most 12). */
export function pickAnswerCandidates(observation: Observation, instruction: string, options?: { max?: number }):
  Array<DigestBlock & { index: number; score: number }>;

// ---------------------------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------------------------

export class BrowserRuntime {
  constructor(options: { bridge: BrowserBridge; provider?: DecisionProvider });
  /** At most one action; returns checkpoint when it executed and no expectation passed. */
  step(instruction: string | RunOptions, options?: RunOptions): Promise<RunResult>;
  run(instruction: string | RunOptions, options?: RunOptions): Promise<RunResult>;
  /** Host-driven: compact page plus offered actions. Throws BridgeError on bridge failure. */
  observe(options?: ObserveOptions): Promise<ObserveResult>;
  /**
   * Host-driven: execute one action offered by observe(), or (`{ point }`) click a point of that observe's screenshot:
   * at least reversible, inside the image, on a control the page script finds under it (bridge.locate), through the
   * same gate and guards as an offered action. Refusals: `refused_action` (needs.level reversible, or the gate's
   * purchase / forbid / level reason), `point_outside`, `no_control`, `point_frame`, `stale` (no re-resolve for a
   * point), `cross_origin`, `target_unavailable`. Throws for an unknown revision or action id.
   */
  act(choice: string | PointChoice | ActChoice, options?: ActOptions): Promise<RunResult>;
  /** Ends the active run as needs_user with code paused. */
  pause(): void;
  /** Ends the active run as stopped. */
  stop(): void;
  /** Ends the active run, step or act with the outcome for `code` (e.g. 'tab_changed'). First interrupt wins. */
  interrupt(code: string): void;
  /**
   * The user's grant dropped to `level` (testing revoked mid-session): the active run continues at the lower level
   * from its next decision, and offers made above it are dropped. Never raises anything.
   */
  lowerGrant(level: Level): void;
  /** Offers from observe(), keyed by revision (at most four). */
  readonly offers: Map<string, unknown>;
}

/** The page, actions and history exactly as a provider receives them, with supplied values redacted. */
export function providerPayload(observation: Observation, actions: LegalAction[], history: HistoryEntry[],
  suppliedText?: Record<string, string>): { observation: CompactObservation; actions: LegalAction[];
    history: HistoryEntry[] };
/** Replaces exact supplied values (length >= 4, plus URL-encoded forms) with `[supplied:<name>]`. */
export function redactorFor(suppliedText?: Record<string, string>): (value: string) => string;

export function legalActions(observation: Observation, options?: AuthorityOptions): LegalAction[];

export const EXPECTATION_FIELDS: Array<keyof DeclarativeExpectation>;
/** Throws TypeError on an invalid expectation shape. */
export function validateExpectation(expectation: Expectation | undefined | null): void;
export function evaluateExpectation(observation: Observation, expectation: Expectation,
  context?: ExpectationContext): Promise<boolean>;
/** Declarative only; returns false for invalid or missing expectations. */
export function verifyExpectation(observation: Observation, expectation: Expectation | undefined,
  context?: ExpectationContext): boolean;

/** JSON-safe form of an expectation, as recorded in `verification.expectation`. */
export function describeExpectation(expectation: Expectation | undefined | null):
  DeclarativeExpectation | { predicate: string } | null;

export const RESULT_VERSION: 2;

export interface Thresholds {
  /** Click confidence below which a link choice goes to the host (default 0 = never). */
  linkFloor: number;
  /** The same for buttons, selects and fills (default 0.5). */
  controlFloor: number;
  /** done at or above which a passing expectation completes the run (default 0.5). */
  doneThreshold: number;
  /**
   * done at or above which a failing expectation is re-observed once (default 0.8); it then ends the run as
   * expectation_mismatch when the provider chose handoff/done or on the second consecutive such decision.
   */
  strongDone: number;
  /** Top candidate confidence for an auto-confirmed verdict.answer (default 0.8). */
  answerConfirm: number;
  /** Its margin over the second candidate (default 0.5). */
  answerMargin: number;
  /** Step lists at read-only/reversible: the floor for filling {{answer:N}} from a likely answer (default 0.35). */
  placeholderFloor: number;
  /** And that answer's margin over the second candidate (default 0.15). */
  placeholderMargin: number;
  /**
   * Reversible mode: the provider's `commit` guard at or above which a chosen button/select/fill (or a handoff while
   * one is offered, unless the injection guard is at 0.85 or more) is refused as needs_user/refused_action (default 0.7).
   * The daemon lets a run lower it, never raise it.
   */
  commitVeto: number;
  /**
   * In-call retries: a link choice, or a handoff, whose probability leads the best other link by less than this gets
   * one second-opinion decide with the options reordered (default 0.2).
   */
  secondOpinionMargin: number;
}
export const DEFAULT_THRESHOLDS: Readonly<Thresholds>;

/** The in-call retry switches (all default true). */
export interface RetrySwitches {
  /** Links only: one more decide with the options reordered when a link choice or a handoff is close to the best link. */
  secondOpinion: boolean;
  /** Read-only runs: go back once from a page a link reached when the provider hands off there and it fails. */
  backOut: boolean;
  /** Read-only runs: run a `next.kind: rerun` suggestion once in the same call (host expectation, remaining budgets). */
  rerun: boolean;
}

/**
 * One in-call retry, runtime-written (codes, probabilities, URL paths, the suggested instruction; never page text).
 * second_opinion: why floor|handoff_close|close, outcome agreed|changed|kept|error|invalid, first/second `{p}`.
 * back_out: why handoff|low_confidence, from/to URL paths, outcome = the run's final code.
 * rerun: why = the first attempt's code, outcome/status = the rerun's, first = the first attempt's outcome.
 */
/**
 * One step of a step list in the receipt, kept small. Trusted codes, except `answer`, `candidates` and `url` (page
 * text). `asked`/`answer`/`candidates`/`url` appear for a step that asked a question; `kind` and `expectation` (and
 * `url`) for the step the list stopped at. Steps that did not start have `status: "not_run"` and, for the step a stop
 * was decided before, its code (placeholder_unconfirmed, time_budget, ...) and `why` codes.
 */
export interface StepResult {
  i: number;
  status: RunStatus | 'not_run';
  code: OutcomeCode | 'not_run' | (string & {});
  why?: string[];
  passed?: boolean;
  /** Its expectation passed, but the list stopped on it: `guard:blocked_page` or `next:<kind>`. */
  held?: string;
  asked?: true;
  answer?: { text: string; line?: string; exact?: false };
  /** An earlier step's top two guesses when its answer was not auto-confirmed. */
  candidates?: Array<{ text: string; confidence: number }>;
  /**
   * "likely": at read-only or reversible, this step's answer was not auto-confirmed but led clearly enough
   * (thresholds.placeholderFloor/placeholderMargin) to fill a later step's {{answer:N}}. Never a confirmed answer.
   */
  answerSource?: 'likely';
  kind?: Verdict['kind'] | null;
  expectation?: DeclarativeExpectation | null;
  url?: string;
}

export interface RetryRecord {
  kind: 'second_opinion' | 'back_out' | 'rerun';
  /** The step of a step list the retry ran in (1-based). */
  listStep?: number;
  why: string;
  outcome: string;
  step?: number;
  first?: { p?: number | null; status?: RunStatus; code?: string; steps?: number; url?: string | null };
  second?: { p: number | null; same: boolean };
  from?: string | null;
  to?: string | null;
  status?: RunStatus;
  instruction?: string;
  expectation?: DeclarativeExpectation;
  maxActions?: number;
}
export const RETRY_KINDS: readonly ['secondOpinion', 'backOut', 'rerun'];
export function resolveRetry(value?: boolean | Partial<RetrySwitches>): RetrySwitches;

/** Resolve the site-profile switch (default off); `enabled` is true for "on", true or an object with a part on. */
export function resolveProfiles(value?: ProfilesSwitch): { enabled: boolean; fastPath: boolean; hints: boolean };

/**
 * The site-profile store (experimental): `dir` defaults to $FAI_DOMAINS_DIR, else $FAI_HOME/domains, one
 * `<host>[_<port>]/profile.json` per origin, validated strictly; hit/miss counters go to stats.json beside it.
 */
export function createDomainStore(options?: { dir?: string; statsDir?: string; log?: (event: string, fields: object) => void }): DomainStore & {
  dir: string;
  statsDir: string;
  statsFile(profile: unknown): string | null;
  error(origin: string): string | null;
};
/** Slim provider request switches (docs/REFERENCE.md "Slim provider requests"). */
export interface SlimSwitches {
  /**
   * Every control sent once: offered links only as their option (with a relative path for the most relevant,
   * vague-labelled or same-labelled links), other controls without hrefs. Default false.
   */
  controls: boolean;
  /**
   * On a page where the expectation already passes, first ask only done and the blocked/injection guards; complete
   * when done reaches doneThreshold, else send the full decide (outside maxDecisions). Default false.
   */
  terminal: boolean;
  /**
   * At most 40 non-terminal options per request (scrolling, waiting, explicit URLs, consent buttons and links whose
   * destination satisfies the expectation always kept, then the most relevant); handoff stays last. Alternatives,
   * decide options and act() keep the full offered set. Default false.
   */
  cap: boolean;
}
export const SLIM_KEYS: readonly (keyof SlimSwitches)[];
export const DEFAULT_SLIM: Readonly<SlimSwitches>;
export function resolveSlim(value?: boolean | Partial<SlimSwitches>): SlimSwitches;

/**
 * Receipt next kinds. MCP responses that are not receipts (state running/pending, observe, request wait, stop,
 * release) also send `next` as `{kind, text}`, with `wait` (call fai_browser_wait) or one of these kinds.
 */
export type NextKind = 'answer' | 'answer_from_digest' | 'confirm_page' | 'choose' | 'rerun' | 'split' | 'relay'
  | 'approve' | 'stop' | 'wait';

/** Receipt v2 verdict: runtime-written and trusted, except `answer.text` and `decide.options[].label` (page text). */
export interface Verdict {
  kind: 'verified' | 'likely' | 'needs_decision' | 'needs_user' | 'failed';
  oversight: 'none' | 'confirm' | 'choose' | 'instruct' | 'approve' | 'user';
  /**
   * The auto-confirmed answer; null unless the call asks something (answerQuestion, or an instruction with a
   * question or read request outside quoted labels): an action-only call has `why` `answer:not_asked`. `line` is the
   * page block the value was cut from; `exact: false` says the text is a whole page line (reply with only the
   * requested part). A step list whose every asked step has an auto-confirmed answer gets them all: `text` is one
   * "step N: <value>" line per step, `confidence` the lowest, `steps` each step's answer by step number.
   */
  answer: {
    text: string;
    confidence: number;
    basis: string[];
    line?: string;
    exact?: false;
    steps?: Array<{ i: number; text: string; line?: string; exact?: false }>;
  } | null;
  /** Machine codes only, e.g. "done:0.95", "expectation:url_guess", "final_url:/catalog/page-3.html". */
  why: string[];
  decide: { question: string; options: Array<{ id: string; label: string; p?: number }>; revision: string | null }
    | null;
  /** Ready-to-send fields for the next fai_browser_run. */
  suggested: { instruction?: string; expectation?: DeclarativeExpectation; maxActions?: number } | null;
  /** MCP only: the per-request call budget. */
  budget: { callsUsed: number; callsLeft: number; msUsed: number } | null;
  /** Present when the task should be split into runs of at most three clicks. */
  plan?: { split: true; reason: 'join_task' | 'hops>3'; hops: number };
}
export const STATUSES: RunStatus[];
export const RECOVERABLE_CODES: Set<string>;
/** needs.message overrides the daemon applies for lease-related codes. */
export const LEASE_MESSAGES: Readonly<Record<string, string>>;
/** Runtime-side error with the bridge error shape (a plain Error, not a BridgeError instance). */
export function bridgeError(code: string, message?: string, recoverable?: boolean): BridgeErrorLike;

// ---------------------------------------------------------------------------------------------------------------
// Traces and retention
// ---------------------------------------------------------------------------------------------------------------

/** A step as written to trace.json: screenshot as a file reference, `action.text` removed, no control bounds. */
export interface TraceStep extends Omit<Step, 'screenshot' | 'action'> {
  action: Omit<StepAction, 'text'>;
  screenshot: { path: string; revision: string; format: 'jpeg' | 'png'; width?: number; height?: number } | null;
}

export interface TraceRecord extends Omit<RunResult, 'steps' | 'events' | 'observation' | 'answerDetail' | 'trace'
  | 'finalDecision'> {
  steps: TraceStep[];
  trace: string;
  /** The final observation in full (text, blocks, controls), without control bounds. */
  finalObservation?: Observation;
  /** Answer ranking details: candidates with scores, provider choice, probabilities, latency, errors. */
  answerDetail?: Record<string, unknown>;
  /** The last provider decision, with its probabilities and done. */
  finalDecision?: StepDecision;
  instruction?: string;
  operation?: string;
  /** Options with credentials, functions and signals removed and suppliedText values replaced by '[redacted]'. */
  options?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  host: { node: string; package: 'fai-browser'; version?: string; platform: string; arch: string };
}

/**
 * The lean agent result: CLI stdout and daemon run results, rendered as text by MCP. No per-step observations,
 * screenshots, probabilities or bounds; those stay in trace.json and behind the evidence route.
 */
/** A point click's record on a result (see RunResult.point). */
export interface PointRecord {
  image: { x: number; y: number };
  css: { x: number; y: number };
  scale: number;
  imageSize: { width: number; height: number };
  control?: { ref: string; label: string; offered: boolean };
}

export interface AgentResult {
  v: 2;
  runId: string | null;
  status: RunStatus;
  code: OutcomeCode | (string & {});
  /** Runtime-generated; never contains page text. */
  reason: string;
  /** Omitted when nobody needs to act (who 'none' and no message). Alternatives carry no probabilities. */
  needs?: Omit<Needs, 'alternatives'> & { alternatives?: Array<Omit<Alternative, 'probability'>> };
  verification: RunResult['verification'];
  verdict: Verdict;
  /** Trusted: requested, granted and effective level. */
  permissions?: Permissions;
  /**
   * The one trusted next step; `text` names the exact tool and arguments. A step list that stopped adds `steps`: the
   * steps to send next, renumbered, earlier auto-confirmed answers written in (`{{supply:N}}` where the host must).
   */
  next: { kind: NextKind; text: string; steps?: RunStep[]; expectation?: DeclarativeExpectation };
  /** Machine warnings: password_field, expectation_weak, controls_capped:<n>, cross_origin_frame; MCP adds
   * expectation_missing and details after a colon. */
  warnings?: string[];
  /** Trusted: an act with a point (see RunResult.point). */
  point?: PointRecord;
  page: (Omit<PageSummary, 'digest' | 'textExcerpt'> & {
    /** Block texts in document order. Untrusted page content. */
    digest: string[];
    /** Only when the digest is empty: the first 600 characters of visible text. */
    textExcerpt?: string;
  }) | null;
  /** The top three candidates; the trace keeps all five. */
  answer: { method: Answer['method']; candidates: Array<{ text: string; confidence: number; state?: number }>;
    source?: { state: number; url: string }; aggregate?: AnswerAggregate };
  trail?: TrailEntry[];
  steps: Array<{ i: number; action: { type: ActionType; label: string; toUrl?: string; suppliedName?: string }; class?: 'consent';
    confidence?: number; ms: number;
    /** A point click: the screenshot pixels, the control ref it resolved to ("point" when unobserved), whether offered. */
    point?: { x: number; y: number; ref?: string; offered?: boolean };
    /** A fill the field did not keep (the run or act ended fill_not_kept). Runtime-written. */
    fill?: 'not_kept' }>;
  cost: { decisions: number; inputTokens: number; outputTokens: number; elapsedMs: number };
  retries?: RetryRecord[];
  site?: SiteReceipt;
  /** A step list: one entry per step; next never asks to send a step that already passed. */
  stepResults?: StepResult[];
  /**
   * A host act that landed on an approved page: the revision its next act may name and the actions offered there,
   * as an observe lists them (`moreActions` counts the ones the listing cap left out; act still resolves them).
   * With `step_complete` the next is `choose` (keep driving with act, or hand back to run).
   */
  revision?: string;
  actions?: Array<{ id: string; description: string }>;
  moreActions?: number;
  lease?: { requestId: string; state: RequestState };
  trace: string | null;
}

/**
 * The lean observe shape (MCP and CLI): digest and one short line per listed action (at most 40 control actions at
 * read-only and reversible, 80 from interactive up, plus page actions and consent buttons).
 */
export interface LeanObserveResult {
  revision: string;
  page: { url: string; title: string; digest: string[] };
  /** Machine warning codes (password_field, login_wall, controls_capped:<n>, cross_origin_frame, browser_error_page). */
  warnings?: string[];
  /** The page's cross-origin frames, read or not (see PageFrame). */
  frames?: PageFrame[];
  /** Untrusted dialog text and labels; lean observations omit button ids. */
  consent?: { text: string; buttons: Array<{ label: string; kind?: string }> };
  /** `description` is like `click "About"`, `select "Team" in "Plan"`, `scroll down`. Labels are page text. */
  actions: Array<{ id: string; description: string }>;
  /** Offered actions left out of the list (ids keep their offered numbers); they can still be passed to act. */
  moreActions?: number;
  permissions?: { requested: string; granted: string | null; effective: string; testing: boolean };
}

/** Lean agent result of a runtime result, trace record or lean result (idempotent). */
export function agentResult(result: RunResult | TraceRecord | AgentResult): AgentResult;
/** Lean observe result of a daemon observe response or an ObserveResult-like object. */
export function leanObserve(response: { revision?: string; page: CompactObservation | Observation;
  actions: LegalAction[]; digest?: DigestBlock[]; offer?: ObserveResult['offer']; permissions?: unknown },
  options?: { instruction?: string; answerQuestion?: string; expectation?: DeclarativeExpectation }): LeanObserveResult;

export interface WriteRunOptions {
  dir: string;
  instruction?: string;
  operation?: string;
  options?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
}

export interface WrittenRun {
  runId: string;
  runDir: string;
  /** Absolute path of trace.json. */
  trace: string;
  /** Absolute image path per step, null where no screenshot was kept. */
  images: Array<string | null>;
  result: AgentResult;
}

/** Writes <dir>/<runId>/trace.json plus one image per captured step. Never embeds base64 or supplied text. */
export function writeRun(result: RunResult, options: WriteRunOptions): Promise<WrittenRun>;
/** Reads a trace by run directory or trace.json path. */
export function readRun(path: string): Promise<TraceRecord & { runDir: string }>;
export function toAgentResult(trace: TraceRecord): AgentResult;

export interface RetentionLimits {
  maxRuns: number;
  maxBytes: number;
  maxAgeMs: number;
}

/** 50 runs, 500 MB, 7 days. */
export const RETENTION_DEFAULTS: Readonly<RetentionLimits>;
/** defaults < options `retention` block < FAI_RETENTION_* env; null when the block is false. */
export function retentionConfig(block?: Partial<RetentionLimits> | false,
  env?: Record<string, string | undefined>): RetentionLimits | null;
/** Deletes the oldest run directories (those holding trace.json) in dir until every limit holds. */
export function prune(dir: string, options?: Partial<RetentionLimits> & { keep?: string[]; now?: number }): Promise<{
  pruned: Array<{ runId: string; bytes: number; reason: string }>;
  remaining: { runs: number; bytes: number };
}>;

// ---------------------------------------------------------------------------------------------------------------
// Extension hub (design section 3)
// ---------------------------------------------------------------------------------------------------------------

/** The per-request call budget (MCP ledger): calls and run milliseconds per tab request. */
export interface CallBudget {
  maxCalls: number;
  maxMs: number;
}

/** The extension's popup settings as last reported (hello or a `settings` message); `budget` null when not set. */
export interface ExtensionSettings {
  budget: CallBudget | null;
}

export interface ExtensionInfo {
  /** Any browser connected. */
  connected: boolean;
  /** Of the browser used last. */
  transport: 'websocket' | 'longpoll' | 'none';
  version: string | null;
  lastSeenMs: number | null;
  /** Null until an extension reported any settings (the last one any browser reported). */
  settings: ExtensionSettings | null;
  /** Every connected browser (several may be paired at once). */
  browsers?: BrowserInfo[];
}

/** A paired browser as requests name it. */
export interface BrowserRef {
  /** The extension install's id (stable per browser profile), or `origin-<hash>` for an extension older than 0.6. */
  id: string;
  /** firefox, chrome, chromium, edge, brave, opera, vivaldi. */
  product: string | null;
  name: string | null;
}

/** A browser connection as status lists it. */
export interface BrowserInfo {
  id: string;
  product: string | null;
  name: string;
  /** The extension's version. */
  version: string | null;
  /** The browser's own version, as the extension reports it. */
  browserVersion: string | null;
  transport: 'websocket' | 'longpoll' | 'none';
  connected: boolean;
  connectedAt: string | null;
  lastSeen: string | null;
  /** The user's last approval, popup open or toolbar click in this browser; new requests go to the latest. */
  lastUsedAt: string | null;
  /** An extension that reports no identity (known by its Origin). */
  legacy: boolean;
  closesLastMinute: number;
  leases: { leaseId: string; requestId: string | null; status: 'active' | 'paused' }[];
}

/** The budget in effect and where it comes from: the popup setting, config.json `budget`, or the defaults. */
export interface EffectiveBudget extends CallBudget {
  source: 'extension' | 'config' | 'default';
}

export interface HubSession {
  requestId: string | null;
  leaseId: string;
  tabId: number;
  origin: string;
  status: 'active' | 'paused' | 'stopped';
}

export type HubReply = (value: Record<string, unknown> | { error: { code: string; message: string; origins?: string[] } })
  => void;

export type HubEvent =
  | { type: 'lease'; requestId: string | null; tabId: number; origin: string; title: string; level?: Level;
      scope?: OriginScope; tabMode?: 'single' | 'multiple'; reply: HubReply }
  | { type: 'deny'; requestId: string | null; reply: HubReply }
  | { type: 'status'; leaseId: string; requestId?: string | null; status: 'paused' | 'stopped'; reason: string }
  | { type: 'hello'; session: HubSession | null; settings: ExtensionSettings | null; reply: HubReply }
  /** The user changed a popup setting; the daemon replies `{budget}` with the budget now in effect. */
  | { type: 'settings'; settings: ExtensionSettings; reply: HubReply }
  /** Explicit user choice from the popup; absent driver reads the daemon's current choice. */
  | { type: 'driver'; driver?: 'jev' | 'agent'; reply: HubReply }
  | { type: 'connected' | 'disconnected'; transport: string };

export interface HubOptions {
  secret: string;
  extensionId: string;
  mode?: 'daemon' | 'companion';
  log?: (event: string, fields?: Record<string, unknown>) => void;
  commandTimeoutMs?: number;
  screenshotTimeoutMs?: number;
  disconnectGraceMs?: number;
}

export interface Hub {
  /** True when it handled an extension HTTP route. */
  handleHttp(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): boolean;
  /** True when it handled the /ext/ws upgrade. */
  handleUpgrade(req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): boolean;
  extension(): ExtensionInfo;
  publishRequests(views: RequestView[]): void;
  onEvent(listener: (event: HubEvent) => void): () => void;
  /** Binds (or re-activates) a lease. */
  bindLease(lease: { leaseId: string; requestId: string | null; tabId: number; origin: string;
    allowedOrigins: string[]; level?: Level; tabMode?: 'single' | 'multiple' }): unknown;
  setLeaseTabMode?(leaseId: string, tabMode: 'single' | 'multiple'): boolean;
  /** Pushes lease_update; a non-active state fails pending commands with the reason code. */
  updateLease(leaseId: string, state: string, reason?: string): unknown;
  forgetLease?(leaseId: string): boolean;
  bridgeFor(leaseId: string): BrowserBridge;
  /** Replaces the pairing secret; an open socket is closed with 4001. */
  setSecret?(secret: string): void | Promise<void>;
  close(): void | Promise<void>;
}

export function createHub(options: HubOptions): Hub;

// ---------------------------------------------------------------------------------------------------------------
// Daemon client API (design section 2)
// ---------------------------------------------------------------------------------------------------------------

export type RequestState = 'pending' | 'active' | 'paused' | 'cancelled' | 'expired' | 'denied' | 'released';
export type AccessMode = Level;

export interface RequestView {
  requestId: string;
  state: RequestState;
  /** paused: paused|tab_changed|origin_changed|child_tab|session_inactive|disconnected; released: stopped|released|superseded|daemon_shutdown; expired: ttl|idle|paused_timeout. */
  stateReason: string | null;
  /** origin_changed: the origin the tab went to, when the extension could see it (origin only). */
  leftOrigin?: string;
  /** child_tab: the origin of the tab or window the page opened, when the extension could see it (origin only). */
  childOrigin?: string;
  /** paused only: when it paused. */
  pausedAt?: string;
  /** A paused request nobody is expected to continue: its agent asked for a newer tab, or no live agent owns it and it sat idle 5 minutes. The popup offers no Resume for it by default. */
  stale?: 'newer_request' | 'idle';
  origins: string[];
  mode: AccessMode;
  /** Agent-written; shown to the user as "Agent says". */
  reason: string;
  instruction: string | null;
  /** The page the extension opens when the user approves: the host's `url` on `origins`, else the first origin's root. */
  url: string;
  client: string | null;
  createdAt: string;
  expiresAt: string | null;
  /** `origin` is the tab's origin at approval; `origins` what the lease covers (a root kept only with `domain` scope). */
  lease: { leaseId: string; tabId: number; origin: string; origins: string[]; grantedAt: string; browserId?: string } | null;
  /** The browser that holds the tab once approved, else the one the request waits in; null while none is connected. */
  browser?: BrowserRef | null;
  /** Set when the browser the request was meant for went away and it moved to another one. */
  browserNote?: string;
  /** The level the user approved in the extension (null until approved). The ceiling for every run. */
  grant: Grant | null;
  activeRunId: string | null;
  lastRunId: string | null;
  /** The live agent session that owns the request (made it through MCP, or joined its invite). */
  owner?: { sessionId: string; host: string; repo: string } | null;
  /** A tab the user invited an agent to from the popup: the invite and its wake. */
  invite?: InviteView;
  /**
   * How a pending request is approved: `page` when the extension opened its page by itself (its "Open requested pages
   * right away" setting, on by default, for Interactive or less), where one click on the FAI Browser icon approves;
   * `window` when the user opens it from the FAI Browser window first (Full or Testing, the setting off, no
   * extension connected). Null once the request is no longer pending.
   */
  approval: 'page' | 'window' | null;
}

export interface TabRequestBody {
  /**
   * 1-10 entries: exact http(s) origins without a path, or domain roots "https://*.example.com" (https, every
   * subdomain of a registrable domain; never a public suffix such as "https://*.co.uk").
   */
  origins: string[];
  mode?: AccessMode;
  /** 1-200 characters. */
  reason: string;
  /** At most 300 characters. */
  instruction?: string;
  /** 60000-3600000; default 600000. */
  ttlMs?: number;
  /**
   * Which paired browser the request opens in: a product the extension reports (firefox, chrome, chromium, edge,
   * brave, ...), its name or a browser id from status. It must be connected (409 browser_not_connected names the
   * connected ones). Default: the browser the user used FAI in last.
   */
  browser?: string;
}

export interface TabRequestResponse {
  requestId: string;
  state: 'pending';
  extensionConnected: boolean;
  expiresAt: string;
  message: string;
  request: RequestView;
  /**
   * True when the same client repeated an identical request while its earlier one still waited for the user: that
   * pending request is returned (HTTP 200) instead of a second one.
   */
  repeated?: boolean;
}

export interface RunProgress {
  steps: number;
  maxActions: number;
  elapsedMs: number;
  lastStep: { i: number; action: { type: ActionType; ref?: string }; ms: { total: number } } | null;
}

/** Response of POST /v1/runs, POST /v1/act, POST /v1/wait {runId} and GET /v1/runs/:id. */
export type RunResponse =
  | { state: 'done'; runId: string | null; requestId: string | null; result: AgentResult }
  | { state: 'running'; runId: string; requestId: string; progress: RunProgress };

export interface RequestWaitResponse {
  state: RequestState;
  request: RequestView;
  waitedMs: number;
  /** The call budget in effect for the request: the MCP server's ceiling (absent from older daemons). */
  budget?: EffectiveBudget;
}

export interface RunBody {
  requestId: string;
  operation?: 'run' | 'step';
  /** Required unless `steps` is given (operation run only; a top-level expectation or answerQuestion then goes to the last step, see RunOptions.steps). */
  instruction?: string;
  steps?: RunStep[];
  maxActions?: number;
  maxDecisions?: number;
  timeoutMs?: number;
  capture?: CapturePolicy;
  /** Defaults to the request's mode; clamped to the user's grant (receipt `permissions`). */
  mode?: AccessMode;
  expectation?: DeclarativeExpectation;
  /** 0-1, alias for thresholds.controlFloor (default 0.5). See RunOptions.minConfidence. */
  minConfidence?: number;
  /** 0-1, default 0.5. See RunOptions.doneThreshold. */
  doneThreshold?: number;
  /** At most 2000 characters. See RunOptions.answerQuestion. */
  answerQuestion?: string;
  /** Guardrail additions for this run; merged with config.json `guardrails`. See GuardrailAdditions. */
  policy?: GuardrailAdditions;
  /** In-call retry switches; default config.json `retry`, else on. See RunOptions.retry. */
  retry?: boolean | Partial<RetrySwitches>;
  /** Site-profile switch; default config.json `profiles`, else off. See RunOptions.profiles. */
  profiles?: ProfilesSwitch;
  /** Slim provider request switches; default config.json `slim`, else DEFAULT_SLIM. See RunOptions.slim. */
  slim?: boolean | Partial<SlimSwitches>;
  allowedUrls?: string[];
  suppliedText?: Record<string, string>;
  provider?: 'typesafe' | 'local';
  /** Only port, model and timeoutMs; endpoints come from config.json. */
  providerOptions?: { port?: number; model?: string; timeoutMs?: number };
  prune?: boolean;
  /** Absolute directory for this run's trace instead of the default artifacts/. */
  outputDir?: string;
  /** At most 45000; default 40000. */
  waitMs?: number;
}

export interface ObserveBody {
  requestId: string;
  mode?: AccessMode;
  allowedUrls?: string[];
  suppliedText?: Record<string, string>;
  instruction?: string;
  expectation?: DeclarativeExpectation;
  answerQuestion?: string;
  /** Added to the request's standing terms (forbidden labels unioned); an observe never removes earlier ones. */
  policy?: GuardrailAdditions;
  /** Words to rank this observe's digest by (at most 300 characters). */
  focus?: string;
  /** Digest size in characters, 500-6000 (default 1500). */
  digestChars?: number;
  /** Poll the page (redacted, every 400 ms) until it shows this, up to maxMs; the response says `waited`. */
  waitFor?: { textIncludes?: string; textAbsent?: string; urlIncludes?: string };
  /** With waitFor: the longest wait, ms (default 10000, at most 30000). */
  maxMs?: number;
  /** Test site only: the page's console errors and failed requests since the last read. */
  logs?: boolean;
  /** Default false: an annotated "Observation" screenshot, taken and written only when asked for. */
  capture?: boolean;
  prune?: boolean;
  outputDir?: string;
}

export type ObserveResponse =
  | { state: 'ok'; observeId: string; requestId: string; revision: string; page: CompactObservation;
    actions: LegalAction[]; digest: DigestBlock[]; screenshot: string | null;
    /**
     * The screenshot's revision and pixel size (a point click's coordinates are in it) and what its badges name:
     * the offered action ids (`actionIds`, drawn only on the offer's own revision) or the control refs.
     */
    image: { revision: string; width: number | null; height: number | null; tags: 'actionIds' | 'refs' } | null;
    trace: string | null;
    /** observe {waitFor}: whether the condition was met, and after how long. */
    waited?: { passed: boolean; ms: number } }
  | { state: 'done'; requestId: string; result: RunResult };

export interface ActBody {
  /** Open a new task tab on approved origins; requires Multiple task tabs approval. */
  openTab?: string;
  requestId: string;
  /** An offered action, or a host-composed act (ActChoice): one of actionId, point, url, nav, key, tab, dialog, fills. */
  actionId?: string;
  /** Pixels of the observe screenshot of `revision` (then required): a guarded click on the control there. */
  point?: { x: number; y: number };
  text?: string;
  submit?: boolean;
  fills?: Array<{ actionId: string; text: string }>;
  hover?: boolean;
  key?: string;
  url?: string;
  nav?: 'back' | 'forward' | 'reload';
  tab?: string;
  dialog?: 'accept' | 'dismiss';
  /** An upload: a file the MCP server confined to the host's workspace (`path` absolute and resolved, at most 10 MB). */
  file?: { path: string; name: string; size: number; type?: string };
  /** Optional for plain acts (matched on the current page); required for needsApproval, secret uses and point. */
  revision?: string;
  expectation?: DeclarativeExpectation;
  /** Heuristic answer candidates only; see ActOptions.answerQuestion. */
  answerQuestion?: string;
  capture?: CapturePolicy;
  timeoutMs?: number;
  waitMs?: number;
  prune?: boolean;
  outputDir?: string;
}

export interface EvidenceResponse {
  runId: string;
  step: number | null;
  path: string;
  mimeType: 'image/jpeg' | 'image/png';
  width: number | null;
  height: number | null;
  bytes: number;
  /** Base64, with inline. */
  data?: string;
}

export interface RunSummary {
  runId: string;
  state: 'running' | 'done';
  operation: string | null;
  requestId: string | null;
  status: string | null;
  code: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  trace: string | null;
}

export interface DaemonStatus {
  daemon: { version: string; pid: number; port: number; uptimeMs: number; home: string; log: string | null };
  extension: ExtensionInfo;
  /** Every browser the hub knows, connected or recently gone with a lease. */
  browsers?: BrowserInfo[];
  /** Who chooses each action: `agent` (the host, the default) or `jev` (the experimental autopilot). */
  driver: 'agent' | 'jev';
  provider: { default: string | null; keyConfigured: boolean };
  /** The per-request call budget in effect (the popup setting, else config.json `budget`, else the defaults). */
  budget: EffectiveBudget;
  requests: RequestView[];
  /** The live coding-agent sessions (one per MCP server process), without keys (docs/REFERENCE.md "Invites and wakes"). */
  sessions?: AgentSessionView[];
  /** Open invites the user made in the popup. */
  invites?: InviteView[];
  runs: { active: RunSummary[]; recent: RunSummary[] };
  warnings: string[];
}

export type WakeCapability = 'claude-socket' | 'codex-queue' | 'none';

export interface AgentSessionView {
  sessionId: string;
  host: 'claude' | 'codex' | 'opencode' | 'unknown';
  /** The repository's folder name only. */
  repo: string;
  pid: number;
  startedAt: string | null;
  registeredAt: string | null;
  lastSeenAt: string | null;
  lastToolCallAt: string | null;
  lastActiveAt: string | null;
  wake: WakeCapability;
  /** False for a Codex session whose thread id is not known yet (before its first FAI tool call). */
  ready: boolean;
}

export interface InviteView {
  /** `inv-` and 8 characters: single use, 10 minutes. */
  inviteId: string;
  requestId: string;
  state: 'open' | 'joined' | 'expired' | 'revoked' | 'cancelled';
  endReason: string | null;
  level: AccessMode;
  /** The invited tab's exact origin. */
  origin: string;
  createdAt: string;
  expiresAt: string;
  hasText: boolean;
  session: { sessionId: string; host: string; repo: string } | null;
  wake: { state: 'none' | 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped'; error: { code: string; message: string } | null };
  joinedBy: { host: string; repo: string } | null;
}

/** Every blocking client call returns within this bound. */
export const MAX_WAIT_MS: 45000;

export interface DaemonOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  /** Default FAI_DAEMON_PORT, then FAI_BRIDGE_PORT, then 4318; 0 picks a free port. */
  port?: number;
  hub?: Hub;
  hubFactory?: (options: HubOptions & { version: string }) => Hub | Promise<Hub>;
  providerFactory?: (spec: { name: string; options: Record<string, unknown>; env: Record<string, string | undefined>;
    config: Record<string, unknown> }) => DecisionProvider;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  version?: string;
  maxWaitMs?: number;
  sweepIntervalMs?: number;
  onShutdownRequest?: () => unknown;
}

export interface Daemon {
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
  reload(): Promise<{ ok: true; keyConfigured: boolean; secretChanged: boolean }>;
  /** Apply request TTL, lease idle, paused expiry and cleanup now. */
  sweep(): void;
  readonly port: number | null;
  readonly token: string | null;
  readonly hub: Hub | null;
  readonly version: string;
  request(requestId: string): RequestView | null;
}

export function createDaemon(options?: DaemonOptions): Daemon;

/** Foreground daemon with lock file, daemon.json and signal handling. */
export function runDaemon(options?: { home?: string; env?: Record<string, string | undefined>;
  handleSignals?: boolean; daemonOptions?: DaemonOptions }): Promise<
  | { status: 'already_running'; pid: number; port: number }
  | { status: 'ready'; port: number; pid: number; daemon: Daemon; stopped: Promise<void>; stop(): Promise<void> }>;

export class FaiClientError extends Error {
  constructor(status: number, code: string, message: string, options?: { retryable?: boolean });
  readonly name: 'FaiClientError';
  /** HTTP status; 0 for transport failures (daemon_unreachable, port_in_use). */
  status: number;
  code: string;
  retryable: boolean;
}

export interface EnsureDaemonOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  port?: number;
  autoStart?: boolean;
  /** Default FAI_DAEMON_START_TIMEOUT_MS or 5000. */
  startTimeoutMs?: number;
  /** argv to spawn instead of [node, src/daemon-main.js]. */
  command?: string[];
  version?: string;
}

export function ensureDaemon(options?: EnsureDaemonOptions): Promise<{
  port: number; token: string; health: { ok: true; service: 'fai-browser'; version: string; pid: number };
  started: boolean; warnings: string[];
}>;

export interface ClientCallOptions {
  signal?: AbortSignal;
  /** run/step/act: called with progress after each new step. */
  onProgress?: (progress: RunProgress) => void;
}

export class FaiBrowserClient {
  constructor(options: { port: number; token: string; clientName?: string; warnings?: string[] });
  static connect(options?: EnsureDaemonOptions & { clientName?: string }): Promise<FaiBrowserClient>;
  readonly port: number;
  readonly warnings: string[];
  health(): Promise<{ ok: true; service: 'fai-browser'; version: string; pid: number }>;
  status(): Promise<DaemonStatus>;
  requestTab(body: TabRequestBody): Promise<TabRequestResponse>;
  listRequests(): Promise<{ requests: RequestView[] }>;
  getRequest(requestId: string): Promise<RequestView>;
  release(requestId: string, reason?: string): Promise<{ requestId: string; state: RequestState }>;
  wait(body: { requestId: string; maxMs?: number; while?: RequestState[] }, options?: ClientCallOptions):
    Promise<RequestWaitResponse>;
  wait(body: { runId: string; maxMs?: number; afterStep?: number }, options?: ClientCallOptions): Promise<RunResponse>;
  /** Loops wait until the request leaves pending/paused or timeoutMs passes. */
  waitForTab(requestId: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<RequestWaitResponse>;
  /** Raw POST /v1/runs. */
  startRun(body: RunBody, options?: ClientCallOptions): Promise<RunResponse>;
  waitForRun(response: RunResponse, options?: ClientCallOptions): Promise<RunResponse>;
  /** Loops until done; aborting the signal stops the run. */
  run(body: Omit<RunBody, 'operation'>, options?: ClientCallOptions): Promise<RunResponse>;
  step(body: Omit<RunBody, 'operation' | 'maxActions'>, options?: ClientCallOptions): Promise<RunResponse>;
  observe(body: ObserveBody): Promise<ObserveResponse>;
  act(body: ActBody, options?: ClientCallOptions): Promise<RunResponse>;
  stop(runId: string): Promise<RunResponse>;
  getRun(runId: string): Promise<RunResponse>;
  runs(options?: { limit?: number; requestId?: string }): Promise<{ runs: RunSummary[] }>;
  evidence(runId: string, options?: { step?: number; kind?: 'screenshot'; inline?: boolean }): Promise<EvidenceResponse>;
  evidence(runId: string, options: { kind: 'trace' }): Promise<{ runId: string; path: string; trace: TraceRecord }>;
  reload(): Promise<{ ok: true; keyConfigured: boolean; secretChanged: boolean }>;
  shutdown(): Promise<{ ok: true; state: 'shutting_down' }>;
}
