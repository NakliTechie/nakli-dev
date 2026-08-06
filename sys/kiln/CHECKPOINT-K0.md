# K0 — Kiln kernel · checkpoint artifact

Gate for the Kiln kernel chunk (KILN-AGENT-HANDOFF §3, §11).

## How to run

```bash
node sys/kiln/test/conformance.test.mjs
```

## Result

```
K0 conformance: 9/9 passed
exit: 0
```

## Shape

Kiln is a Worker hosting Pyodide behind a typed protocol. Built as the Rig-style
seam: a runtime-agnostic **kernel core** over an injected runtime, so the mock
and real Pyodide are interchangeable.

- **kernel-core.mjs** — the `exec/interrupt/reset/inspect/listNames` orchestrator.
  Owns timeout→interrupt, output-cap passthrough, provenance + cell log, and the
  typed-result contract (never throws across the boundary).
- **kiln.mjs** — the consent gate. `ensureReady()` calls the injected
  `loadRuntime` (which would fetch Pyodide) ONLY when `consent()` is true; until
  then Kiln reports `unavailable` and nothing on the network is touched.
- **mock-runtime.mjs** — the headless test seam (persistent namespace, output,
  traceback, an interruptible loop, output-cap). Not shipped.
- **pyodide-runtime.mjs** — the REAL executor over a loaded Pyodide + a
  SharedArrayBuffer interrupt byte; the code that runs inside the Worker.

## What the gate verifies (headless, mock runtime)

- **Namespace persists across exec.** Assign `x` in one cell, `print(x)` in a
  later one → `5\n`.
- **Runaway loop interrupted within the timeout, kernel still usable.** `LOOP`
  with `timeoutMs:40` → `status:'timeout'`; a subsequent exec runs and the
  namespace is intact. An explicit `interrupt(cellId)` stops a running cell →
  `status:'interrupted'`.
- **Uncaught exception → structured traceback, never a hang or a throw.**
  `raise ValueError` → `status:'error'` with the traceback as data; `exec` never
  throws; the kernel is usable afterward. A runtime that throws is also caught
  and returned as a typed error.
- **Output cap.** 5000 bytes with `outputCapBytes:100` → stdout length 100,
  `truncated:true`.
- **Provenance** is recorded on every cell.
- **No fetch without consent (security).** With consent withheld, `ensureReady`
  and `exec` never call `loadRuntime` (`loads === 0`) and report
  `consent-withheld` / `unavailable`; granting consent loads exactly once.

## Browser follow-on (real Pyodide + Worker — assumed, not headless-verified)

- **pyodide-runtime.mjs** real-Python behaviour — namespace persistence, a real
  `KeyboardInterrupt` on a runaway loop via the SAB byte, real tracebacks — is
  verified in the browser Worker with real Pyodide, not headlessly. The core
  orchestration those behaviours plug into IS verified above.
- **The Worker transport** — a blob-URL module Worker hosting Pyodide, a
  main-thread proxy implementing the runtime contract by messaging it, and the
  shared interrupt buffer (needs COOP/COEP cross-origin isolation for
  SharedArrayBuffer) — is not built here; it is the K0 browser wiring.
- **The consent-gated loader** that actually imports Pyodide from the pinned CDN
  (`PYODIDE_INDEX_URL`, `v0.26.4`, ~12 MiB shown before fetch) plugs into the
  verified `loadRuntime` seam.

No fabricated headless claim is made for the real-Pyodide path; the seam is
built and verified, the WASM integration is the documented next step.
