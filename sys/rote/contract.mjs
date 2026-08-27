// Rote — the script contract (pure). One plain ES-module `.js` file per
// automation is the artifact (handoff §2.1); this module owns the single ingress
// that validates a script's declared `meta` and the caller's `inputs` before the
// script's `run()` is allowed to touch anything, plus the exact shape of the
// `ctx` surface a script may see (handoff §3).
//
// No DSL, no YAML — `meta.inputs` is JSON-schema-lite: a map of field → typespec.
// Typespec grammar: 'string' | 'number' | 'boolean' | 'object' and the array
// forms 'string[]' | 'number[]' | 'boolean[]', each with an optional trailing
// '?' meaning the field may be absent. Unknown keys in `inputs` are rejected
// (strict ingress) so a script never runs on a payload it didn't declare.

// The exact members a script's `ctx` exposes — the Contract gate reflects the
// live ctx against this list; any extra global is a failure (handoff §10).
export const CTX_KEYS = Object.freeze(['tools', 'explore', 'vault', 'out', 'log', 'history']);

const BASE_TYPES = new Set(['string', 'number', 'boolean', 'object']);
const ARRAY_TYPES = new Set(['string[]', 'number[]', 'boolean[]']);

// Parse a typespec into { base, array, optional }.
export function parseTypeSpec(spec) {
  let s = String(spec == null ? '' : spec).trim();
  const optional = s.endsWith('?');
  if (optional) s = s.slice(0, -1).trim();
  const array = ARRAY_TYPES.has(s);
  const base = array ? s.slice(0, -2) : s;
  const known = array ? true : BASE_TYPES.has(s);
  return { base, array, optional, known: known && (array ? BASE_TYPES.has(base) : BASE_TYPES.has(s)) };
}

function isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

function matchesBase(base, v) {
  if (base === 'string') return typeof v === 'string';
  if (base === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (base === 'boolean') return typeof v === 'boolean';
  if (base === 'object') return isPlainObject(v);
  return false;
}

// Validate one value against a typespec. Returns null on ok, else an error string.
export function checkValue(spec, value) {
  const t = parseTypeSpec(spec);
  if (!t.known) return `unknown type "${spec}"`;
  if (value === undefined || value === null) return t.optional ? null : 'is required';
  if (t.array) {
    if (!Array.isArray(value)) return `must be ${t.base}[]`;
    for (let i = 0; i < value.length; i++) if (!matchesBase(t.base, value[i])) return `[${i}] must be ${t.base}`;
    return null;
  }
  return matchesBase(t.base, value) ? null : `must be ${t.base}`;
}

// Validate a script's meta (handoff §3.2). Returns { ok, errors[] }.
// A safe single path segment — no separators, no traversal, no leading dot. Used
// for meta.name (→ the run directory) and artifact names (→ files under out/), so
// a script can never redirect its run path or forge/clobber another run's files.
export const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isSafeSegment(s) { return typeof s === 'string' && s.length <= 128 && SAFE_SEGMENT.test(s) && !s.includes('..'); }

export function validateMeta(meta) {
  const errors = [];
  if (!isPlainObject(meta)) return { ok: false, errors: ['meta must be an object'] };
  if (typeof meta.name !== 'string' || !meta.name.trim()) errors.push('meta.name must be a non-empty string');
  else if (!isSafeSegment(meta.name)) errors.push('meta.name must be a safe segment (letters/digits/._- , no "/" or "..")');
  if (!Number.isInteger(meta.version) || meta.version < 1) errors.push('meta.version must be an integer ≥ 1');
  if (meta.inputs !== undefined) {
    if (!isPlainObject(meta.inputs)) errors.push('meta.inputs must be an object of field→type');
    else for (const [k, spec] of Object.entries(meta.inputs)) {
      if (!parseTypeSpec(spec).known) errors.push(`meta.inputs.${k}: unknown type "${spec}"`);
    }
  }
  if (meta.grants !== undefined && !(Array.isArray(meta.grants) && meta.grants.every((g) => typeof g === 'string'))) {
    errors.push('meta.grants must be a string[]');
  }
  if (meta.tags !== undefined && !isPlainObject(meta.tags)) errors.push('meta.tags must be an object');
  if (meta.runtime !== undefined && !['worker', 'bridge', 'any'].includes(meta.runtime)) {
    errors.push('meta.runtime must be "worker" | "bridge" | "any"');
  }
  return { ok: errors.length === 0, errors };
}

// The single input ingress (handoff §3.3: "validate inputs against meta.inputs
// before run()"). Strict: rejects missing-required, type mismatches, and unknown
// keys. Returns { ok, value } (value = the accepted inputs) or { ok, errors[] }.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function validateInputs(meta, inputs) {
  const schema = (meta && isPlainObject(meta.inputs)) ? meta.inputs : {};
  const payload = inputs == null ? {} : inputs;
  if (!isPlainObject(payload)) return { ok: false, errors: ['inputs must be an object'] };
  const errors = [];
  for (const [k, spec] of Object.entries(schema)) {
    if (RESERVED_KEYS.has(k)) { errors.push(`inputs.${k} is a reserved key`); continue; }
    const e = checkValue(spec, hasOwn(payload, k) ? payload[k] : undefined);
    if (e) errors.push(`inputs.${k} ${e}`);
  }
  // Own-key check (not `in`, which walks the prototype chain and would let an
  // undeclared __proto__/constructor slip past the strict-ingress guarantee).
  for (const k of Object.keys(payload)) {
    if (RESERVED_KEYS.has(k) || !hasOwn(schema, k)) errors.push(`inputs.${k} is not declared in meta.inputs`);
  }
  if (errors.length) return { ok: false, errors };
  const value = Object.create(null); // null-proto: assigning a declared field can never pollute
  for (const k of Object.keys(schema)) if (!RESERVED_KEYS.has(k) && hasOwn(payload, k)) value[k] = payload[k];
  return { ok: true, value };
}
