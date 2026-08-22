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
- **worker.mjs / worker-runtime.mjs** — the dedicated module Worker and its
  main-thread proxy. The proxy owns the interrupt byte and governed Rig RPC.

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

## Real-Pyodide browser verification (2026-08-06)

Verified in Chromium (in-app browser) against real Pyodide **0.26.4** loaded
from the pinned CDN — harness `test/kiln-pyodide-harness.html`, **5/5**:

- Namespace persists across cells — assignment, `def`, and `import` all survive
  into later `exec` calls.
- An uncaught exception returns a real traceback as data (no throw, kernel
  usable after).
- Output is capped and truncation reported.
- `listNames` / `inspect` report the real namespace.

**Fix found by this pass:** `pyodide-runtime` used `setStdout({batched})`, which
is line-buffered and strips the trailing newline — `print(x)` captured as `"42"`
not `"42\n"`. Switched to `setStdout({write})` (raw bytes, streaming decoder) for
byte-exact capture. This is the value of the browser pass.

## Dedicated-Worker verification (2026-08-12)

`test/kiln-worker-harness.html` passed in a cross-origin-isolated Chromium page
against real Pyodide 0.26.4. A runaway `while True` returned `timeout`; an
explicit interrupt returned `interrupted`; the namespace remained usable after
both. The harness uses the headered `test/serve-kiln.mjs` server.

The **consent-gated CDN loader** (`PYODIDE_INDEX_URL`, `v0.26.4`, ~12 MiB shown
before fetch) plugs into the verified `loadRuntime` seam.

## Open boundary — post-load network APIs

The consent gate proves that Kiln does not fetch Pyodide before approval. This
checkpoint does not yet prove that model-authored Python cannot reach Worker
network globals after Pyodide loads. Disable and browser-test `fetch`,
`XMLHttpRequest`, `WebSocket`, and equivalent egress before model execution is
enabled in Forge.
