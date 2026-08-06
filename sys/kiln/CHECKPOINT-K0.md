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

## Still a follow-on — the SAB interrupt needs the Worker

The runaway-loop interrupt (`while True` → `KeyboardInterrupt` via the SAB byte)
is **not** verifiable with Pyodide on the main thread: a tight Python loop blocks
the event loop, so the main-thread timer that sets the interrupt byte can never
fire (confirmed empirically — the tab hangs). This is exactly why the handoff
mandates *a Worker hosting Pyodide*: the interrupt is set from the free main
thread while the Worker blocks. The `setInterruptBuffer` wiring in
`pyodide-runtime` is correct; it is only exercisable through the Worker
transport, which remains the K0 browser follow-on (needs COOP/COEP cross-origin
isolation for `SharedArrayBuffer`; COEP `credentialless` lets the CDN still
load).

The **consent-gated CDN loader** (`PYODIDE_INDEX_URL`, `v0.26.4`, ~12 MiB shown
before fetch) plugs into the verified `loadRuntime` seam.
