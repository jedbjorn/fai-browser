// Run ordering and prompt-cache bookkeeping for bench/compare.mjs. Pure: no I/O.
//
// Two orders:
//   contiguous (default)  one timeline per host x condition: optional warm-up run(s), then every task x repeat back to
//                         back, so each run reuses the host's prompt cache from the run before it. The condition order
//                         alternates per host (ABBA: host 1 A then B, host 2 B then A, ...) to spread time drift.
//   interleave            the pre-timeline order: rep -> task -> host -> condition, so conditions alternate per task.
//
// Each schedule item: {task, condition, host, rep, warmup, w, timeline}. `warmup` items are excluded from tables.

export const ORDERS = Object.freeze(['contiguous', 'interleave']);

// Seconds a cached prefix survives without reuse. Codex (OpenAI GPT-5.6+): 30 min. Claude Code: 5 min or 1 h; the
// subscription default (no CLAUDE_CODE_PROMPT_CACHE_TTL) writes 1 h entries.
export function cacheTtlS(host, claudeCacheTtl = 'default') {
  const vendor = typeof host === 'string' ? String(host).split(':')[0] : host?.vendor;
  if (vendor === 'claude') {
    return claudeCacheTtl === '5m' ? 300 : 3600;
  }
  return 1800;
}

export const timelineKey = (hostId, condition) => `${hostId}|${condition}`;

// Condition order for the host at `hostIndex`: reversed on every second host when abba is on.
export function orderedConditions(conditions, hostIndex, abba = true) {
  return abba && hostIndex % 2 === 1 ? [...conditions].reverse() : [...conditions];
}

export function buildSchedule({
  hosts, conditions, tasks, repeat = 1, order = 'contiguous', warmup = null, warmupTask = null, abba = true,
}) {
  if (!ORDERS.includes(order)) {
    throw new Error(`order must be one of ${ORDERS.join(', ')}`);
  }
  const warmups = warmup ?? (order === 'contiguous' ? 1 : 0);
  const warmTask = warmupTask ?? tasks[0];
  const items = [];
  if (order === 'interleave') {
    // Warm-ups (only when asked for) run once per host x condition before the interleaved loop.
    for (const host of hosts) {
      for (const condition of conditions) {
        for (let w = 1; w <= warmups; w++) {
          items.push({ task: warmTask, condition, host, rep: 0, warmup: true, w, timeline: timelineKey(host.id, condition) });
        }
      }
    }
    for (let rep = 1; rep <= repeat; rep++) {
      for (const task of tasks) {
        for (const host of hosts) {
          for (const condition of conditions) {
            items.push({ task, condition, host, rep, warmup: false, w: 0, timeline: timelineKey(host.id, condition) });
          }
        }
      }
    }
    return items;
  }
  hosts.forEach((host, hostIndex) => {
    for (const condition of orderedConditions(conditions, hostIndex, abba)) {
      const timeline = timelineKey(host.id, condition);
      for (let w = 1; w <= warmups; w++) {
        items.push({ task: warmTask, condition, host, rep: 0, warmup: true, w, timeline });
      }
      for (let rep = 1; rep <= repeat; rep++) {
        for (const task of tasks) {
          items.push({ task, condition, host, rep, warmup: false, w: 0, timeline });
        }
      }
    }
  });
  return items;
}

// Cache phase of a run that is about to start. `state` is the timeline's previous run ({endedAt ms, measured}),
// `lastOnHost` the condition of the previous run on the same host (any condition), `nowMs` this run's start.
//   cold  first run of its timeline (no warm-up before it), or the gap since the timeline's previous run exceeds the
//         cache TTL, or (interleave) the host's previous run used another condition
//   warm  otherwise
export function cachePhase({ state, lastOnHost, condition, nowMs, ttlS }) {
  if (!state) {
    return { phase: 'cold', gapS: null, why: 'first run of the timeline' };
  }
  const gapS = (nowMs - state.endedAt) / 1000;
  if (gapS > ttlS) {
    return { phase: 'cold', gapS, why: `gap ${Math.round(gapS)} s > TTL ${ttlS} s` };
  }
  if (lastOnHost && lastOnHost !== condition) {
    return { phase: 'cold', gapS, why: 'previous run on this host used another condition' };
  }
  return { phase: 'warm', gapS, why: null };
}

// "order: ..." header line for summary.md.
export function orderLine({ order, warmup, warmupTask, abba, stablePaths, claudeCacheTtl, claudeHosts = true }) {
  const ttl = claudeHosts ? `, claude cache TTL ${claudeCacheTtl}` : '';
  if (order === 'interleave') {
    return `order: interleave (per-task alternation)${warmup ? `, warm-up ${warmup} (${warmupTask}, excluded)` : ''}`
      + `${stablePaths ? ', stable paths' : ''}${ttl}`;
  }
  return `order: contiguous per host×condition${abba ? ', ABBA' : ''}, warm-up ${warmup}`
    + `${warmup ? ` (${warmupTask}, excluded)` : ''}${stablePaths ? ', stable paths' : ''}${ttl}`;
}
