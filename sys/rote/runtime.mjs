// Rote — the runtime (reason-once/run-many). Builds the `ctx` surface a script
// sees (handoff §3.3), executes the script's default export over Rig fileops, and
// writes an IMMUTABLE, tagged run record (§3.4). Redaction is applied to every
// persisted byte of text. This module is pure over an injected `fs` (a Rig
// fileops instance) so it runs headless in a test and, unchanged, inside the
// in-tab Worker / bridge runtime that supplies a grant-scoped, op-logged fs.
//
// What it is NOT: the Worker/Overlay isolation shell (browser/bridge only) and
// the cross-app registry (`ctx.tools`) — those are layered on top. Here,
// `ctx.tools.<app>.<tool>()` fails loud ("no registry app") because the browsing
// track is deferred; a script with zero explore() and zero tool calls runs fully.

import { validateMeta, validateInputs, CTX_KEYS } from './contract.mjs';
import { createRedactor, createVault } from './vault.mjs';

export const ROTE_DIR = '.rote';

export class ExploreUnavailable extends Error {
  constructor(msg = 'explore() called but no inference endpoint is configured') { super(msg); this.name = 'ExploreUnavailable'; this.code = 'explore-unavailable'; }
}

// A run id like "2026-08-27T09-14-02Z-7f3a" (§3.4). `now` is ms, `nonce` a short
// string — both injected so runs are deterministic in tests.
export function makeRunId(nowMs, nonce) {
  const iso = new Date(nowMs).toISOString();            // 2026-08-27T09:14:02.123Z
  const stamp = iso.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  return `${stamp}-${nonce}`;
}

// Stable JSON (sorted keys) for hashing inputs deterministically.
export function canonicalJSON(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJSON).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJSON(v[k])).join(',') + '}';
}

// A registry-tools proxy. With no registry (`tools` empty), every call fails loud
// — a mutating tool call must never silently no-op (§3.3).
function makeToolsProxy(registry) {
  const reg = registry || {};
  return new Proxy({}, {
    get(_t, app) {
      return new Proxy({}, {
        get(_t2, tool) {
          return async (args) => {
            const fn = reg[app] && reg[app][tool];
            if (typeof fn !== 'function') throw new Error(`registry tool "${String(app)}.${String(tool)}" unavailable: no registry app "${String(app)}" (browsing track deferred)`);
            return fn(args);
          };
        },
      });
    },
  });
}

async function readJson(fs, path) {
  try { const r = await fs.read(path, { encoding: 'utf-8' }); if (r && r.ok) return JSON.parse(r.data); } catch (_) {}
  return null;
}

// Build the ctx + a shared mutable `state` the runner persists after execution.
function buildContext({ meta, inputs, vault, redactor, explore, registry, fs, runsRoot, nowMs }) {
  const state = { exploreCalls: 0, ok: 0, failed: 0, failures: {}, logs: [], explores: [], artifacts: [] };
  const ctx = {
    tools: makeToolsProxy(registry),
    async explore(prompt, extra) {
      if (typeof explore !== 'function') throw new ExploreUnavailable();
      const n = ++state.exploreCalls;
      const response = await explore(String(prompt == null ? '' : prompt), extra);
      const out = typeof response === 'string' ? response : String(response == null ? '' : response);
      state.explores.push({ n, prompt: String(prompt == null ? '' : prompt), response: out, trace: extra ?? null, codified: false });
      return out;
    },
    vault: { get: (name) => vault.get(name) },
    out: {
      json(name, data) { state.artifacts.push({ name: String(name), type: 'json', body: JSON.stringify(data, null, 2) }); },
      text(name, str) { state.artifacts.push({ name: String(name), type: 'text', body: String(str == null ? '' : str) }); },
      file(name, bytes) { state.artifacts.push({ name: String(name), type: 'file', bytes: bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes || []) }); },
    },
    log: {
      ok(data) { state.ok++; state.logs.push({ t: new Date(nowMs).toISOString(), level: 'ok', data: data ?? null }); },
      fail(cls, data) {
        const c = String(cls == null ? '' : cls).trim();
        if (!c) throw new Error('log.fail(class, data) requires a non-empty failure class');
        state.failed++; state.failures[c] = (state.failures[c] || 0) + 1;
        state.logs.push({ t: new Date(nowMs).toISOString(), level: 'fail', class: c, data: data ?? null });
      },
    },
    history: {
      async runs({ since } = {}) {
        const out = [];
        const dir = await fs.list(runsRoot, { recursive: false }).catch(() => null);
        if (dir && dir.ok) for (const e of dir.entries || []) {
          if (e.type !== 'dir') continue;
          const rj = await readJson(fs, e.path + '/run.json');
          if (rj && (!since || (rj.endedAt && rj.endedAt >= since))) out.push(rj);
        }
        return out.sort((a, b) => (a.runId < b.runId ? 1 : -1));
      },
      async lastFailures(cls) {
        const runs = await this.runs();
        return runs.map((r) => (r.failures && r.failures[cls]) || 0);
      },
    },
  };
  return { ctx, state };
}

// Persist the run: log.ndjson, explore/<n>.json, out/*, then run.json LAST. All
// text is redacted; binary out files are written raw (can't redact bytes). run.json
// is write-once — an existing one is refused (runs are immutable, §2.5).
async function persistRun({ fs, runDir, state, redactor, run }) {
  const w = async (path, data) => { const r = await fs.write(path, data, { createParents: true }); if (r && r.ok === false) throw new Error(`write ${path} failed: ${r.message || 'error'}`); };
  const ndjson = state.logs.map((l) => redactor.redact(JSON.stringify(l))).join('\n');
  await w(runDir + 'log.ndjson', ndjson ? ndjson + '\n' : '');
  for (const ex of state.explores) await w(runDir + `explore/${ex.n}.json`, redactor.redact(JSON.stringify({ prompt: ex.prompt, response: ex.response, trace: ex.trace, codified: ex.codified }, null, 2)));
  for (const a of state.artifacts) {
    if (a.type === 'file') await w(runDir + 'out/' + a.name, a.bytes);
    else await w(runDir + 'out/' + a.name + (a.type === 'json' ? '.json' : '.txt'), redactor.redact(a.body));
  }
  const existing = await fs.stat(runDir + 'run.json').catch(() => null);
  if (existing && existing.ok) throw new Error(`run.json already exists at ${runDir} — runs are immutable`);
  await w(runDir + 'run.json', redactor.redact(JSON.stringify(run, null, 2)));
}

// Run a script module to completion and return { ok, runId, runDir, run }.
// Setup failures (bad meta/inputs/grants) reject BEFORE any run record is written
// (handoff §3.3). An error DURING run (including ExploreUnavailable) is recorded
// with status "error" and a failure class, per the Removability gate (§10).
export async function runScript({
  module, inputs = {}, fs, grants = {}, store = null, explore = null, registry = {},
  now = () => Date.now(), nonce = null, scriptSource = '', sha256 = null,
  runtimeLabel = 'worker', startedBy = { actor: 'human', door: 'ui' },
}) {
  if (!module || typeof module.default !== 'function') return { ok: false, code: 'bad-script', errors: ['script has no default export function'] };
  const meta = module.meta;
  const mc = validateMeta(meta);
  if (!mc.ok) return { ok: false, code: 'bad-meta', errors: mc.errors };
  const ic = validateInputs(meta, inputs);
  if (!ic.ok) return { ok: false, code: 'bad-inputs', errors: ic.errors };

  const redactor = createRedactor();
  let vault;
  try { vault = await createVault({ meta, grants, store, redactor }); }
  catch (e) { return { ok: false, code: e.code || 'grant-unavailable', errors: [String(e && e.message || e)] }; }

  const startMs = now();
  const runId = makeRunId(startMs, nonce || Math.random().toString(16).slice(2, 6));
  const runsRoot = `${ROTE_DIR}/runs/${meta.name}`;
  const runDir = `${runsRoot}/${runId}/`;
  const { ctx, state } = buildContext({ meta, inputs: ic.value, vault, redactor, explore, registry, fs, runsRoot, nowMs: startMs });

  let status = 'complete', errorClass = null, errorMessage = null;
  try { await module.default(ctx, ic.value); }
  catch (e) { status = 'error'; errorClass = e && e.code ? String(e.code) : 'error'; errorMessage = redactor.redact(String(e && e.message || e)); }

  const endMs = now();
  const hash = async (s) => (typeof sha256 === 'function' ? 'sha256:' + await sha256(s) : 'sha256:unknown');
  const run = {
    runId, script: meta.name, scriptVersion: meta.version,
    scriptHash: await hash(scriptSource), parentRunId: (inputs && inputs.__parentRunId) || null,
    startedBy, runtime: runtimeLabel, inputsHash: await hash(canonicalJSON(ic.value)),
    tags: (meta.tags && typeof meta.tags === 'object') ? meta.tags : {},
    exploreCalls: state.exploreCalls, ok: state.ok, failed: state.failed, failures: state.failures,
    artifacts: state.artifacts.map((a) => ({ name: a.name, type: a.type })),
    status, errorClass, errorMessage,
    durationMs: Math.max(0, endMs - startMs), startedAt: new Date(startMs).toISOString(), endedAt: new Date(endMs).toISOString(),
  };
  await persistRun({ fs, runDir, state, redactor, run });
  return { ok: true, runId, runDir, run, redactor };
}

// Audit helper (Contract/Sandbox gates): scan every persisted file under a run
// dir and confirm no registered secret survived redaction. Returns { clean, offenders[] }.
export async function auditRedaction({ fs, runDir, redactor }) {
  const offenders = [];
  const listing = await fs.list(runDir, { recursive: true }).catch(() => null);
  if (listing && listing.ok) for (const e of listing.entries || []) {
    if (e.type !== 'file') continue;
    const r = await fs.read(e.path, { encoding: 'utf-8' }).catch(() => null);
    if (r && r.ok && redactor.contains(r.data)) offenders.push(e.path);
  }
  return { clean: offenders.length === 0, offenders };
}

export { CTX_KEYS };
