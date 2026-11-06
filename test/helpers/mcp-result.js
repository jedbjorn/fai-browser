export function mcpText(result) {
  return (result?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

export function mcpError(result) {
  return JSON.parse(result.content[0].text).error;
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : value;
}

function json(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Read the labels of FAI's model-facing text result without recreating a second wire payload. */
export function mcpData(result) {
  const text = mcpText(result);
  const out = { text };
  const lines = text.split('\n');
  let section = null;
  for (const line of lines) {
    let match = /^next \(([^)]+)\): ([\s\S]*)$/.exec(line);
    if (match) {
      out.next = { kind: match[1], text: match[2] };
      section = null;
      continue;
    }
    if (line.startsWith('next.steps (send exactly as steps): ')) {
      out.next = { ...out.next, steps: json(line.slice(36)) };
      continue;
    }
    if (line.startsWith('next.expectation (send with next.steps): ')) {
      out.next = { ...out.next, expectation: json(line.slice(41)) };
      continue;
    }
    match = /^verdict: (\S+) \(oversight ([^)]+)\); status (\S+) \(([^)]+)\), verified: (true|false)$/.exec(line);
    if (match) {
      out.state = 'done';
      out.v = 2;
      out.verdict = { ...out.verdict, kind: match[1], oversight: match[2] };
      out.status = match[3];
      out.code = match[4];
      out.verification = { ...out.verification, passed: match[5] === 'true' };
      section = null;
      continue;
    }
    match = /^status: (\S+)(?: \(([^)]+)\))?(?:, verified: (true|false))?$/.exec(line);
    if (match) {
      out.status = match[1];
      if (match[2]) out.code = match[2];
      if (match[3] !== undefined) out.verification = { ...out.verification, passed: match[3] === 'true' };
      section = null;
      continue;
    }
    match = /^status (\S+) \(([^)]+)\), verified: (true|false)$/.exec(line);
    if (match) {
      out.status = match[1];
      out.code = match[2];
      out.verification = { ...out.verification, passed: match[3] === 'true' };
      section = null;
      continue;
    }
    if (line.startsWith('why: ')) {
      out.verdict = { ...out.verdict, why: line.slice(5).split(', ') };
      continue;
    }
    if (/^steps: \d+ /.test(line)) {
      out.stepResults = line.slice(7).split('; ').map(entry => {
        const step = /^(\d+) (\S+)(?: \(([^)]+)\))?(?:, verified: (true|false))?(?:, held \(([^)]+)\))?( \(likely\))?$/.exec(entry);
        return { i: Number(step[1]), status: step[2], code: step[3], ...(step[4] ? { passed: step[4] === 'true' } : {}),
          ...(step[5] ? { held: step[5] } : {}), ...(step[6] ? { answerSource: 'likely' } : {}) };
      });
      continue;
    }
    if (line.startsWith('suggested: ')) {
      out.verdict = { ...out.verdict, suggested: json(line.slice(11)) };
      continue;
    }
    match = /^budget: (\d+) call\(s\) used, (\d+) left, ([\d.]+) s$/.exec(line);
    if (match) {
      out.verdict = { ...out.verdict, budget: { callsUsed: Number(match[1]), callsLeft: Number(match[2]), msUsed: Number(match[3]) * 1000 } };
      continue;
    }
    if (line.startsWith('expectation: ')) {
      out.verification = { ...out.verification, expectation: json(line.slice(13)) };
      continue;
    }
    if (line.startsWith('granted: ')) {
      match = /^granted: (\S+)(?: \(asked (\S+)\))?$/.exec(line);
      out.granted = { level: match[1], asked: match[2] };
      continue;
    }
    if (line.startsWith('needs who: ')) {
      out.needs = { ...out.needs, who: line.slice(11) };
      continue;
    }
    if (line.startsWith('needs: ')) {
      match = /^needs: ([\s\S]*?)(?: \(level ([^)]+)\))?$/.exec(line);
      out.needs = { ...out.needs, message: match[1] };
      if (match[2]) out.needs.level = match[2];
      continue;
    }
    match = /^waited: condition (met|not met) after (\d+) ms$/.exec(line);
    if (match) {
      out.waited = { passed: match[1] === 'met', ms: Number(match[2]) };
      continue;
    }
    if (line.startsWith('warning: ')) {
      (out.warnings ??= []).push(line.slice(9));
      continue;
    }
    if (line.startsWith('calls left on this request: ')) {
      out.callsLeft = Number(line.slice(28));
      continue;
    }
    match = /^runId: (\S+), requestId: (\S+)$/.exec(line);
    if (match) {
      out.runId = match[1];
      out.requestId = match[2];
      section = null;
      continue;
    }
    match = /^(state|driver|requestId|runId|revision|kind|step|bytes|truncated|stopped|path|trace): ([\s\S]*)$/.exec(line);
    if (match) {
      out[match[1]] = ['step', 'bytes'].includes(match[1]) ? Number(match[2]) : match[2] === 'true' ? true : match[2] === 'false' ? false : match[2];
      section = null;
      continue;
    }
    match = /^daemon: version (\S+), pid (\d+), port (\d+)$/.exec(line);
    if (match) {
      out.daemon = { version: match[1], pid: Number(match[2]), port: Number(match[3]) };
      continue;
    }
    match = /^extension: (connected|disconnected)(?: \(([^)]+)\))?(?:, version (\S+))?$/.exec(line);
    if (match) {
      out.extension = { connected: match[1] === 'connected', transport: match[2], version: match[3] };
      continue;
    }
    match = /^provider: (\S+), key configured: (true|false)$/.exec(line);
    if (match) {
      out.provider = { default: match[1] === 'none' ? null : match[1], keyConfigured: match[2] === 'true' };
      continue;
    }
    match = /^permissions: requested (\S+), granted (\S+), effective (\S+), testing (true|false)$/.exec(line);
    if (match) {
      out.permissions = { requested: match[1], granted: match[2] === 'none' ? null : match[2], effective: match[3], testing: match[4] === 'true' };
      continue;
    }
    match = /^request: (\S+) (\S+)(?: (\S+))?(?:, active run (\S+))?(?:, origins (.*))?$/.exec(line);
    if (match) {
      (out.requests ??= []).push({ requestId: match[1], state: match[2], mode: match[3], activeRunId: match[4], origins: match[5]?.split(' ') });
      continue;
    }
    if (line.startsWith('url: ')) {
      out.page = { ...out.page, url: line.slice(5) };
      section = null;
      continue;
    }
    if (line.startsWith('title: ')) {
      out.page = { ...out.page, title: line.slice(7) };
      section = null;
      continue;
    }
    if (/^page digest(?: \(.*\))?:$/.test(line)) {
      out.page = { ...out.page, digest: [] };
      section = 'digest';
      continue;
    }
    if (line === 'page digest (untrusted page text):') {
      out.page = { ...out.page, digest: [] };
      section = 'digest';
      continue;
    }
    if (line === 'page text:') {
      section = 'pageText';
      continue;
    }
    if (section === 'digest' || section === 'pageText') {
      if (/^(?:actions(?: offered now)? \(|answer candidates|earlier pages:|decide options|alternatives \(|steps:|did: |cookie dialog:|popup \(|dialog: |js dialog |tabs: |log |refused control:|trace: |\(\d+ more)/.test(line)) {
        section = null;
      } else {
        if (section === 'digest') out.page.digest.push(line);
        else out.page.textExcerpt = out.page.textExcerpt ? `${out.page.textExcerpt}\n${line}` : line;
        continue;
      }
    }
    if (/^actions(?: offered now)? \(.*\):$/.test(line) || line === 'actions (labels are untrusted page text):') {
      out.actions = [];
      section = 'actions';
      continue;
    }
    match = /^(a\d+)  ([\s\S]*?)(?: \[(purchase|secret|delete|submit)\])?$/.exec(line);
    if (match && section === 'actions') {
      const action = { id: match[1], description: match[2] };
      if (match[3]) action.needsApproval = match[3];
      out.actions.push(action);
      continue;
    }
    match = /^\((\d+) more(?: offered actions)? not listed/.exec(line);
    if (match) {
      out.moreActions = Number(match[1]);
      section = null;
      continue;
    }
    if (line.startsWith('did: ')) {
      (out.did ??= []).push(line.slice(5));
      continue;
    }
    if (line.startsWith('tabs: ')) {
      out.tabs = line.slice(6).split(' | ').map(entry => {
        const tab = /^(\S+?)(\*?) ([\s\S]*)$/.exec(entry);
        return { id: tab[1], title: tab[3], ...(tab[2] ? { current: true } : {}) };
      });
      continue;
    }
    match = /^js dialog \((\S+), (\S+)\): ([\s\S]*)$/.exec(line);
    if (match) {
      out.dialog = { kind: match[1], text: match[3] };
      if (match[2] === 'dismissed') out.dialog.answered = 'dismiss';
      if (match[2] === 'accepted') out.dialog.answered = 'accept';
      if (match[2] === 'open') out.dialog.open = true;
      continue;
    }
    match = /^log (\S+)(?: (\d+))?(?:(?: (\S+))?(?: (\S+))?)?: ([\s\S]*)$/.exec(line);
    if (match) {
      (out.logs ??= []).push({ kind: match[1], ...(match[2] ? { status: Number(match[2]) } : {}),
        ...(match[3] ? { method: match[3] } : {}), ...(match[4] ? { url: match[4] } : {}), text: match[5] });
      continue;
    }
    if (line.startsWith('dialog: ')) {
      out.needs = { ...out.needs, dialog: line.slice(8) };
      continue;
    }
    if (line.startsWith('refused control: ')) {
      out.needs = { ...out.needs, control: { label: line.slice(17) } };
      continue;
    }
    match = /^image omitted: (?:step (\S+) )?(\S+)$/.exec(line);
    if (match) {
      (out.imagesOmitted ??= []).push({ ...(match[1] && match[1] !== '-' ? { step: Number(match[1]) } : {}), reason: match[2] });
      continue;
    }
    match = /^image: (?:step (\d+), )?revision (\S+), (?:(\d+)x(\d+) px|size unknown); badges are (action ids|control refs)/.exec(line);
    if (match) {
      out.image = { ...(match[1] ? { step: Number(match[1]) } : {}), revision: match[2],
        ...(match[3] ? { width: Number(match[3]), height: Number(match[4]) } : {}), tags: match[5] === 'action ids' ? 'actionIds' : 'refs' };
      continue;
    }
    match = /^(?:decide options|alternatives) \(revision (\S+)\):$/.exec(line);
    if (match) {
      const decide = { revision: match[1], options: [] };
      out.verdict = { ...out.verdict, decide };
      out.needs = { ...out.needs, revision: match[1] };
      section = 'options';
      continue;
    }
    match = /^- (\S+): ([\s\S]*?)(?: \((\d+\.\d+)\))?$/.exec(line);
    if (match && section === 'options') {
      out.verdict.decide.options.push({ id: match[1], label: match[2], ...(match[3] ? { p: Number(match[3]) } : {}) });
      continue;
    }
    if (line === 'answer candidates (guesses):') {
      out.answer = { ...out.answer, candidates: [] };
      section = 'candidates';
      continue;
    }
    match = /^- ([\s\S]*?)(?: \((\d+\.\d+)\))?(?: \(earlier state (\d+)\))?$/.exec(line);
    if (match && section === 'candidates') {
      out.answer.candidates.push({ text: match[1], confidence: match[2] ? Number(match[2]) : undefined,
        ...(match[3] ? { state: Number(match[3]) } : {}) });
      continue;
    }
    if (line.startsWith('answer: ')) {
      out.verdict = { ...out.verdict, answer: { ...out.verdict?.answer, text: line.slice(8) } };
      continue;
    }
    if (line.startsWith('answer line: ')) {
      out.verdict = { ...out.verdict, answer: { ...out.verdict?.answer, line: line.slice(13) } };
      continue;
    }
    if (line.startsWith('steps: ')) {
      out.steps = line.slice(7).split(' > ').map((entry, i) => {
        const split = entry.indexOf(' ');
        return { i: i + 1, action: { type: entry.slice(0, split), label: entry.slice(split + 1) } };
      });
      continue;
    }
    section = null;
  }
  if (out.actions === undefined && /(?:^|\n)a\d+  /.test(text)) out.actions = [];
  if (out.verdict && !Object.hasOwn(out.verdict, 'suggested')) out.verdict.suggested = null;
  if (out.verdict && !Object.hasOwn(out.verdict, 'budget')) out.verdict.budget = null;
  if (out.page && out.status && !out.page.truncated) out.page.truncated = /page digest \(more on the page:/.test(text);
  if (!out.state && !out.status && out.page && out.next?.kind === 'choose') out.state = 'ok';
  return out;
}

export function mcpDirect(result) {
  return { ...mcpData(result), text: result.content[0].text, isError: result.isError === true };
}
