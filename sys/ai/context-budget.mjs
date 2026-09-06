// Honest context budget (B4; Posthorse's budgetFor, the Ollama num_ctx finding). A local
// model has a small, often-misconfigured window: Ollama defaults num_ctx to 4,096 whatever
// the model can take, so a run silently truncates. This module reports the budget HONESTLY —
// where the window came from, whether it is even usable, and what to do when it is not — and
// refuses automatic behaviour rather than pretend. Pure: no fetch, no clock; the caller does
// the /api/show request and passes the JSON in.

export const MIN_USABLE_TOKENS = 10_000;   // below this, automatic rollover/reminders are refused
export const DEFAULT_RESERVE = 2_000;      // headroom kept for the response
export const OLLAMA_DEFAULT_NUM_CTX = 4_096; // Ollama's silent default when num_ctx is unset
export const HANDOFF_MAX_CHARS = 20_000;
const CHARS_PER_TOKEN = 4;

// A static window table for presets whose window is fixed/known (no probe).
export const PRESET_WINDOWS = Object.freeze({
  'gemini-nano': 32_768, // Chrome's on-device Gemini Nano (Prompt API)
});

// Parse an Ollama /api/show response + the request's num_ctx option into an effective window.
// model_info.<arch>.context_length is what the MODEL can take; num_ctx is what the server will
// actually use. When num_ctx is unset the server uses its default (4,096) — an ASSUMED window,
// flagged, because it is the difference between "40k" on paper and 4k in practice.
export function windowFromOllama(show, numCtx = null) {
  const info = (show && show.model_info) || {};
  const key = Object.keys(info).find((k) => /\.context_length$/.test(k));
  const modelMax = key ? Number(info[key]) : null;
  if (Number.isFinite(numCtx) && numCtx > 0) {
    const win = modelMax ? Math.min(numCtx, modelMax) : numCtx;
    return { window: win, source: `num_ctx ${numCtx}${modelMax ? ` (model max ${modelMax})` : ''}`, assumed: false, modelMax };
  }
  const win = modelMax ? Math.min(OLLAMA_DEFAULT_NUM_CTX, modelMax) : OLLAMA_DEFAULT_NUM_CTX;
  return { window: win, source: `server default (assumed ${OLLAMA_DEFAULT_NUM_CTX}; num_ctx unset)`, assumed: true, modelMax };
}

// The window for a preset. ollama → from a probe you pass in `probe` ({show, numCtx}); a known
// preset → the static table; anything else → null (usage not known).
export function windowForPreset(preset, { probe = null } = {}) {
  if (preset === 'ollama') return probe ? windowFromOllama(probe.show, probe.numCtx) : { window: null, source: 'ollama not probed', assumed: true, modelMax: null };
  if (PRESET_WINDOWS[preset]) return { window: PRESET_WINDOWS[preset], source: `${preset} (fixed)`, assumed: false, modelMax: PRESET_WINDOWS[preset] };
  return { window: null, source: `${preset || 'unknown'} — window not known`, assumed: true, modelMax: null };
}

// The budget itself. `used` is the current transcript's estimated tokens.
export function contextBudget({ window, reserve = DEFAULT_RESERVE, used = 0 } = {}) {
  if (!Number.isFinite(window) || window <= 0) {
    return { window: null, reserve, usable: null, used, remaining: null, supported: false, automatic: false, reason: 'usage not known — no automatic rollover or reminder' };
  }
  const usable = Math.max(0, window - reserve);
  const supported = usable >= MIN_USABLE_TOKENS;
  const remaining = Math.max(0, usable - used);
  return {
    window, reserve, usable, used, remaining, supported, automatic: supported,
    reason: supported ? null : `only ${usable} usable tokens (window ${window} − reserve ${reserve}) < ${MIN_USABLE_TOKENS} — automatic behaviour off; raise num_ctx or use a larger model`,
  };
}

// Cap a handoff at 20,000 chars AND half the usable window (Posthorse's rule). `usable` in tokens.
export function capHandoff(text, { usable = null } = {}) {
  const byWindow = Number.isFinite(usable) ? Math.floor((usable / 2) * CHARS_PER_TOKEN) : Infinity;
  const cap = Math.min(HANDOFF_MAX_CHARS, byWindow);
  const s = String(text ?? '');
  return s.length <= cap ? s : s.slice(0, cap) + `\n[handoff truncated at ${cap} chars]`;
}

// One reminder, fingerprinted by the budget shape so a window/reserve change re-arms it and a
// stale one (from a different shape) is dropped from the projection. Remind in the last 10% of
// usable, capped so a fresh window never trips it.
export function reminderFingerprint({ window, contextWindow, reserve } = {}) {
  return `ctx:${window ?? '?'}:${contextWindow ?? window ?? '?'}:${reserve ?? '?'}`;
}
export function shouldRemind(budget, { used = budget.used } = {}) {
  if (!budget || !budget.supported) return false;
  const band = Math.min(0.1 * budget.usable, 32_000);
  return used >= budget.usable - band;
}
// Drop reminders whose fingerprint is not the current one (stale — a different budget shape).
export function filterStaleReminders(messages, currentFp) {
  return (messages || []).filter((m) => !(m && m._reminderFp && m._reminderFp !== currentFp));
}

// Tools.
export function contextRemainingTool() {
  return { type: 'function', function: { name: 'context_remaining',
    description: 'Report the honest context budget: the window, where it came from, how much is usable, and how much is left. Says plainly when the window is unknown or too small for automatic behaviour.',
    parameters: { type: 'object', properties: {} } } };
}
export function checkpointTool() {
  return { type: 'function', function: { name: 'checkpoint',
    description: 'Record a checkpoint: a concise handoff of goal, progress, decisions and next steps that survives a context rollover as the next turn\'s starting landmark. Capped; save fuller detail with remember.',
    parameters: { type: 'object', properties: { handoff: { type: 'string', description: 'Concise continuation state the next turn needs.' } }, required: ['handoff'] } } };
}
