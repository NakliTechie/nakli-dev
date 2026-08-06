// kiln — the K0 facade: the consent gate over the kernel core.
//
// Kiln does NOT load Pyodide until consent is granted (hard rule #11, never
// auto-download). `loadRuntime` is the injected async function that would fetch
// + initialise Pyodide (real one in the browser; a stub in tests). The gate is
// here so the "no fetch without consent" guarantee is enforced in one place and
// is headlessly testable with a fetch/load spy.
//
// Until ready, Kiln reports `unavailable` in one line and every other nakliOS
// surface is unaffected (§3).

import { createKernelCore } from './kernel-core.mjs';

/**
 * @param {object}   opts
 * @param {function} opts.loadRuntime  async () => runtime  (fetches + inits Pyodide)
 * @param {function} opts.consent      () => boolean         (operator granted the download)
 * @param {number}   [opts.sizeBytes]  reported download size, for the consent prompt
 * @param {function} [opts.now]
 */
export function createKiln({ loadRuntime, consent, sizeBytes = null, now = () => Date.now() }) {
  if (typeof loadRuntime !== 'function') throw new Error('createKiln requires loadRuntime()');
  if (typeof consent !== 'function') throw new Error('createKiln requires consent()');

  let state = 'unloaded'; // unloaded | loading | ready | unavailable
  let core = null;
  let loadPromise = null;

  function status() { return state; }
  function downloadSize() { return sizeBytes; }

  // Load only with consent. Never touches the network otherwise.
  async function ensureReady() {
    if (state === 'ready') return { ok: true };
    if (!consent()) return { ok: false, reason: 'consent-withheld', message: 'Kiln needs your consent to download Pyodide.' };
    if (loadPromise) return loadPromise;
    state = 'loading';
    loadPromise = (async () => {
      try {
        const runtime = await loadRuntime();
        core = createKernelCore({ runtime, now });
        state = 'ready';
        return { ok: true };
      } catch (e) {
        state = 'unavailable';
        loadPromise = null;
        return { ok: false, reason: 'unavailable', message: String(e && e.message ? e.message : e) };
      }
    })();
    return loadPromise;
  }

  // Every operation goes through the ready gate; typed miss when not ready.
  async function withCore(fn) {
    const r = await ensureReady();
    if (!r.ok) return { status: 'unavailable', reason: r.reason, message: r.message };
    return fn(core);
  }

  return {
    status,
    downloadSize,
    ensureReady,
    exec: (cellId, code, opts) => withCore((c) => c.exec(cellId, code, opts)),
    interrupt: (cellId) => (core ? core.interrupt(cellId) : { ok: false, message: 'kernel not ready' }),
    reset: (opts) => (core ? core.reset(opts) : { ok: false, message: 'kernel not ready' }),
    inspect: (name) => withCore((c) => c.inspect(name)),
    listNames: () => withCore((c) => c.listNames()),
    cells: () => (core ? core.cells() : []),
  };
}
