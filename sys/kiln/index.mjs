// Kiln kernel (K0) — public entry.
//
//   const kiln = createKiln({ loadRuntime, consent: () => operatorSaidYes });
//   await kiln.ensureReady();                    // loads Pyodide only with consent
//   await kiln.exec('cell-1', 'x = 40 + 2', { provenance: 'operator' });
//   await kiln.exec('cell-2', 'print(x)');       // 42 — the namespace persists
//
// loadRuntime is the injected Pyodide loader (real: pyodide-runtime.mjs in the
// browser Worker; tests: a MockRuntime). The consent gate lives in createKiln.
export { createKiln } from './kiln.mjs';
export { createKernelCore, DEFAULT_TIMEOUT_MS, DEFAULT_OUTPUT_CAP } from './kernel-core.mjs';
export { MockRuntime } from './mock-runtime.mjs';
