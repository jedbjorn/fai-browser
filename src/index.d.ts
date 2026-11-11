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

/** Observation returned by observe(): no bounds, sensitive controls removed. */
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
  | 'copy_secret';

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
}
export function guardrailPolicy(options?: { level?: Level; mode?: Level; request?: GuardrailAdditions; config?: GuardrailAdditions }): GuardrailPolicy;

/**
 * Guardrail additions (src/guardrails.js): extra control labels FAI Browser refuses, on top of the core rules (never
 * sign in, purchase/order/book/pay/subscribe/transfer, delete, send/publish/invite/submit, browser-internal pages;
 * cookie dialogs reject-only). Plain phrases only (no regex metacharacters), at most 20 of at most 60 characters,
 * matched case-insensitively as whole words in any control label; `note` (at most 200 characters) is stored with the request.
 * Additions can only restrict: nothing here relaxes a core rule.
 */
export type GuardrailAdditions = string[] | { forbid?: string[]; note?: string };

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
  /** Verifies the outcome: checked after the action, and a pass ends the act as completed. */
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
  /** Values for fill_supplied_text, by name. Never placed in offered actions. */
  suppliedText?: Record<string, string>;
}


export interface ObserveOptions extends AuthorityOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Relevance hints for the listing cap only (local): the task the host is working on. */
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
  /** Question for heuristic answer candidates. Without it `answer.method` is none. */
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
  /** Every offered action; act() resolves any of them. */
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
  by: 'host' | 'runtime';
  /**
   * `stale_reresolve`: an act() whose offer went stale on a link, a derived-label stepper button (`unnamed`,
   * previous-value / next-value) or a picker-open click (`opens`) ran the one action of a fresh observation that is
   * the same control (type, role, label, value, destination, frame; same origin and path; the same number of such
   * controls; neighbour labels break ties), never for a delete, submit, purchase, sign-in or commit label, a risk
   * above reversible or a page with a consent dialog. `reresolved` names the action id that ran; the result warns
   * `act_reresolved`.
   */
  reason?: 'consent' | 'stale_reresolve';
  actionId: string;
  /** With `reason: "stale_reresolve"`: the fresh observation's action id that ran. */
  reresolved?: string;
  /** A point click: the screenshot pixels given and the CSS viewport point they mapped to. */
  point?: { image: { x: number; y: number }; css: { x: number; y: number } };
  /** A point click: the control under the point (ref "point" for one the observation left out) and whether it was offered. */
  resolved?: { ref: string; label: string; offered: boolean };
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
  /** A rough score share from the heuristic ranking. 0 to 1. */
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
 * and checkpoint results. `heuristic`: ranked by term overlap; `none`: no candidates (other statuses, no question,
 * or nothing relevant on the page).
 */
export interface Answer {
  method: 'heuristic' | 'none';
  candidates: AnswerCandidate[];
  /** Where the top candidate was read, when that is an earlier page state (trail[].state). */
  source?: { state: number; url: string };
  aggregate?: AnswerAggregate;
}


export interface Needs {
  who: 'user' | 'host' | 'none';
  message: string;
  /** The revision to act on. */
  revision?: string;
  /** A JavaScript dialog's text (at most 120 characters). Untrusted page content. */
  dialog?: string;
  /** A refused or approval-gated control (its page label, at most 120 characters). Untrusted page content. */
  control?: { ref: string; label: string };
  /**
   * refused_action that a higher level would allow: the level to ask the user for (verdict needs_user, next relay;
   * or needs_decision / observe with `who: 'host'` when the grant already covers it). Never set for purchases below
   * testing, which stop.
   */
  level?: Level;
  /** approval_pending only: the class, and the action id and revision to act on again once the user approves. */
  approval?: { class: ApprovalClass; actionId: string; revision: string; expiresInMs?: number };
}

/** One earlier page state: its URL and the blocks most relevant to the question. Untrusted text. */
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
  | 'expectation_passed' | 'expectation_failed' | 'step_complete' | 'task_budget' | 'time_budget' | 'unsupported'
  /**
   * A fill the field did not keep (the page reverted or ignored the typed text, read back from the field after the
   * page settled): needs_host, next observe saying to set the value another way (allowedUrls, the page's own picker).
   */
  | 'fill_not_kept'
  | 'stale' | 'target_unavailable' | 'capture_failed' | 'stopped' | 'cancelled' | 'paused' | 'cross_origin'
  | 'blocked' | 'login' | 'child_tab' | 'tab_changed' | 'origin_changed' | 'session_inactive'
  | 'disconnected' | 'js_dialog'
  /** A fill with a line break aimed at a single-line input, refused (needs_host; fill without it, then submit_field). */
  | 'line_break_input'
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
  | 'timeout' | 'invalid_observation' | 'config' | 'failed';

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
    /**
     * The expectation's textIncludes or titleIncludes is not on the final page: `expected text "Departing flights"
     * not found; the page has "Top flights", "Other departing flights" (quoted page text, untrusted)`, up to five of
     * the page's headings and short prominent strings ranked by word overlap with the expected text (each cut to 60
     * characters, control characters stripped), so the host can correct its wording. Also appended to next.text.
     */
    hint?: string;
  };
  page: PageSummary | null;
  answer: Answer;
  /** Earlier page states with their most relevant lines; absent when none. */
  trail?: TrailEntry[];
  steps: Step[];
  /** Kept for the result schema; always zero but `elapsedMs`. */
  cost: { decisions: number; inputTokens: number; outputTokens: number; elapsedMs: number };
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
}

/** Task-conditioned digest of an observation's blocks (see PageSummary.digest). */
export function buildDigest(observation: Observation, instruction: string,
  options?: { maxBlocks?: number; maxChars?: number }): { digest: DigestBlock[]; truncated: boolean };
/** Candidate answer blocks for the question, best first (default at most 12). */
export function pickAnswerCandidates(observation: Observation, instruction: string, options?: { max?: number }):
  Array<DigestBlock & { index: number; score: number }>;

// ---------------------------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------------------------

export class BrowserRuntime {
  constructor(options: { bridge: BrowserBridge; asks?: () => { purchase: boolean; secret: boolean; level: boolean } });
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
  /** Ends the active act as needs_user with code paused. */
  pause(): void;
  /** Ends the active act as stopped. */
  stop(): void;
  /** Ends the active act or observe with the outcome for `code` (e.g. 'tab_changed'). First interrupt wins. */
  interrupt(code: string): void;
  /**
   * The user's grant dropped to `level` (testing revoked mid-session): offers made above it are dropped. Never
   * raises anything.
   */
  lowerGrant(level: Level): void;
  /** Offers from observe(), keyed by revision (at most four). */
  readonly offers: Map<string, unknown>;
}

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
  /** Top candidate confidence for an auto-confirmed verdict.answer (default 0.8). */
  answerConfirm: number;
  /** Its margin over the second candidate (default 0.5). */
  answerMargin: number;
}
export const DEFAULT_THRESHOLDS: Readonly<Thresholds>;

/**
 * Receipt next kinds. MCP responses that are not receipts (state running/pending, observe, request wait, stop,
 * release) also send `next` as `{kind, text}`, with `wait` (call fai_browser_wait) or one of these kinds.
 */
export type NextKind = 'answer' | 'choose' | 'observe' | 'relay' | 'approve' | 'stop' | 'wait';

/** Receipt v2 verdict: runtime-written and trusted, except `answer.text` (page text). */
export interface Verdict {
  kind: 'verified' | 'likely' | 'needs_decision' | 'needs_user' | 'failed';
  oversight: 'none' | 'choose' | 'instruct' | 'approve' | 'user';
  /**
   * The auto-confirmed answer; null unless the call asks something (answerQuestion, or an instruction with a
   * question or read request outside quoted labels): an action-only call has `why` `answer:not_asked`. `line` is the
   * page block the value was cut from; `exact: false` says the text is a whole page line (reply with only the
   * requested part).
   */
  answer: {
    text: string;
    confidence: number;
    basis: string[];
    line?: string;
    exact?: false;
  } | null;
  /** Machine codes only, e.g. "expectation:url_guess", "final_url:/catalog/page-3.html". */
  why: string[];
  /** MCP only: the per-request call budget. */
  budget: { callsUsed: number; callsLeft: number; msUsed: number } | null;
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

export interface TraceRecord extends Omit<RunResult, 'steps' | 'events' | 'observation' | 'answerDetail' | 'trace'> {
  steps: TraceStep[];
  trace: string;
  /** The final observation in full (text, blocks, controls), without control bounds. */
  finalObservation?: Observation;
  /** Answer ranking details: candidates with scores. */
  answerDetail?: Record<string, unknown>;
  instruction?: string;
  operation?: string;
  /** Options with credentials, functions and signals removed and suppliedText values replaced by '[redacted]'. */
  options?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  host: { node: string; package: 'fai-browser'; version?: string; platform: string; arch: string };
}

/**
 * The lean agent result: CLI stdout and daemon act results. No per-step observations,
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
  /** Omitted when nobody needs to act (who 'none' and no message). */
  needs?: Needs;
  verification: RunResult['verification'];
  verdict: Verdict;
  /** Trusted: requested, granted and effective level. */
  permissions?: Permissions;
  /** The one trusted next step; `text` names the exact tool and arguments. */
  next: { kind: NextKind; text: string; expectation?: DeclarativeExpectation };
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
    ms: number;
    /** A point click: the screenshot pixels, the control ref it resolved to ("point" when unobserved), whether offered. */
    point?: { x: number; y: number; ref?: string; offered?: boolean };
    /** A fill the field did not keep (the run or act ended fill_not_kept). Runtime-written. */
    fill?: 'not_kept' }>;
  cost: { decisions: number; inputTokens: number; outputTokens: number; elapsedMs: number };
  /**
   * A host act that landed on an approved page: the revision its next act may name and the actions offered there,
   * as an observe lists them (`moreActions` counts the ones the listing cap left out; act still resolves them).
   * With `step_complete` the next is `choose` (keep driving with act).
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
  /** Calls per tab request, 1-10000 (default 50). */
  maxCalls: number;
  /** Run milliseconds per tab request, 1000-14400000 (4 hours; default 1200000, 20 minutes). */
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

export type WakeCapability = 'claude-socket' | 'codex-queue' | 'opencode-plugin' | 'none';

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
  reload(): Promise<{ ok: true; secretChanged: boolean }>;
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
  waitForRun(response: RunResponse, options?: ClientCallOptions): Promise<RunResponse>;
  observe(body: ObserveBody): Promise<ObserveResponse>;
  act(body: ActBody, options?: ClientCallOptions): Promise<RunResponse>;
  stop(runId: string): Promise<RunResponse>;
  getRun(runId: string): Promise<RunResponse>;
  runs(options?: { limit?: number; requestId?: string }): Promise<{ runs: RunSummary[] }>;
  evidence(runId: string, options?: { step?: number; kind?: 'screenshot'; inline?: boolean }): Promise<EvidenceResponse>;
  evidence(runId: string, options: { kind: 'trace' }): Promise<{ runId: string; path: string; trace: TraceRecord }>;
  reload(): Promise<{ ok: true; secretChanged: boolean }>;
  shutdown(): Promise<{ ok: true; state: 'shutting_down' }>;
}
