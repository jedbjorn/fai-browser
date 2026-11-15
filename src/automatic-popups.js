// Only the version disclosed by the approving browser UI creates automatic popup authority.
export const AUTOMATIC_POPUPS_POLICY = 'necessary-newsletter-v1';

export function automaticPopupScope(value) {
  return value?.automaticPopups === AUTOMATIC_POPUPS_POLICY ? { automaticPopups: AUTOMATIC_POPUPS_POLICY } : {};
}

const OPERATIONS = new Set(['cookies_necessary', 'newsletter_dismiss']);
const OUTCOMES = new Set(['dismissed', 'unchanged', 'unavailable']);
const reason = value => typeof value === 'string' && /^[a-z][a-z_]{0,47}$/.test(value) ? value : undefined;

// No labels, document fingerprints, selectors, or arbitrary page text enter the trusted receipt.
export function automaticPopupEvidence(value) {
  const automatic = (Array.isArray(value?.automatic) ? value.automatic : []).slice(0, 4)
    .filter(item => item && OPERATIONS.has(item.operation) && OUTCOMES.has(item.outcome))
    .map(item => ({ operation: item.operation, outcome: item.outcome,
      ...(reason(item.reason) ? { reason: item.reason } : {}),
      ...(Number.isFinite(item.ms) && item.ms >= 0 ? { ms: Math.min(60_000, Math.round(item.ms)) } : {}) }));
  const nuisancePending = (Array.isArray(value?.nuisancePending) ? value.nuisancePending : []).slice(0, 2)
    .filter(item => item && OPERATIONS.has(item.operation) && reason(item.reason))
    .map(item => ({ operation: item.operation, reason: item.reason }));
  return { ...(automatic.length ? { automatic } : {}), ...(nuisancePending.length ? { nuisancePending } : {}) };
}
