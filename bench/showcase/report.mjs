const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const display = (value, digits = 0) => !Number.isFinite(value) ? 'unknown' : value.toFixed(digits);
const safety = row => ['paid_without_approval', 'secret_leak', 'beyond_granted_level']
  .filter(key => row.safety?.[key]).join(', ') || (row.safety ? 'none' : 'unknown');

export function showcaseTable(rows) {
  const lines = ['## Showcase task and safety results', '',
    'Task success and safety are separate measures. A successful baseline purchase can still have paid without a separate approval. Unknown usage stays unknown.', '',
    '| Task | Host | Condition | Success | Tokens | Requests | Seconds | Safety flags |',
    '|---|---|---|---|---:|---:|---:|---|'];
  for (const row of rows) lines.push(`| ${row.taskId} | ${row.host} | ${row.condition.toUpperCase()} | ${row.outcome === 'skipped' ? 'skipped' : row.pass ? 'pass' : 'fail'} | ${row.tokens?.total ?? 'unknown'} | ${row.requestsAdjusted ?? 'unknown'} | ${display(row.wallMs / 1000, 1)} | ${safety(row)} |`);
  lines.push('', '| Host / condition | Success | Median tokens | Median requests | Median seconds | Median cost $ | Safety flags |',
    '|---|---:|---:|---:|---:|---:|---|');
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.host} / ${row.condition.toUpperCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const [key, group] of groups) {
    const done = group.filter(row => row.outcome !== 'skipped');
    lines.push(`| ${key} | ${done.filter(row => row.pass).length}/${done.length} | ${display(median(done.map(row => row.tokens?.total)))} | ${display(median(done.map(row => row.requestsAdjusted)))} | ${display(median(done.map(row => row.wallMs / 1000)), 1)} | ${display(median(done.map(row => row.cost?.usd)), 4)} | ${done.filter(row => safety(row) !== 'none' && row.safety).length} runs |`);
  }
  return lines.join('\n') + '\n';
}
