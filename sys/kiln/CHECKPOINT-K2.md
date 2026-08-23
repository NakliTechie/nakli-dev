# K2 — Generated Python `rig` module · checkpoint artifact

Gate for KILN-AGENT-HANDOFF §5 and §11.

## How to run

```bash
node sys/kiln/test/rig-bindings.test.mjs
node sys/kiln/test/worker-runtime.test.mjs
node test/serve-kiln.mjs
# open http://127.0.0.1:8765/test/kiln-worker-harness.html in Chromium
```

## Result — 2026-08-12

```text
K2/rig-bindings conformance: 7/7 passed
K0-K2/worker-runtime conformance: 4/4 passed
Kiln Worker integration: 9/9 passed
```

## What the gate verifies

- Every registry command generates one Python binding from registry metadata.
- Generated signatures and descriptions match the registry.
- `fs.*` commands flatten to `rig.*`; namespaced commands remain nested.
- The Worker installs the generated source as an importable `rig` module.
- A SharedArrayBuffer RPC returns governed registry results synchronously to
  Python without a second capability implementation.
- The JSON codec preserves nested binary values.
- Out-of-grant calls raise `RigGrantError` inside Python.
- Destructive calls return proposal objects and leave storage unchanged until
  operator acceptance.

## Hardening pass — 2026-08-23 (audit C-K1 / M-K2…M-K6 / L-K7)

Headless additions in `test/worker-runtime.test.mjs` (now 8/8): egress stubs
throw, the rig-call allowlist rejects a name with no binding, a face-less write
is refused unless opted in, and Rig-error truncation cuts on a UTF-8 boundary.

Enforced now (was structurally assumed):

- **Network egress (C-K1)** — `worker.mjs` replaces `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource`, `Request`, `importScripts`, `Worker`,
  `SharedWorker`, and `navigator.sendBeacon` with throwing stubs at the end of
  `initialize()`, before the first user cell. `postMessage` is untouched (Rig
  channel). `import js; js.fetch(...)` now raises.
- **Rig call surface (M-K2)** — the main-thread `rig-call` handler rejects any
  name absent from the generated binding allowlist (`deriveRigAllowlist`) before
  `face.invoke`, returning a typed `ENOCMD` rather than reaching an ungoverned
  registry command.
- **No hang-forever (M-K3)** — `messageerror` and `error` both settle all
  pending and mark the Worker closed; `request()` carries per-op timeouts
  (init 120s, runCode 60s, configurable).
- **Staged deletions (M-K4)** — a staged `fs.remove` path is masked from the
  snapshot sent to the Worker, so `loadSnapshot` no longer resurrects it
  mid-session; the host copy is still retained for operator accept.
- **Ungoverned writes (M-K5)** — a storage-backed session with no Rig face
  refuses to start, and `syncWorkerSnapshot` refuses face-less writes
  (`EUNGOVERNED`) unless `allowUngovernedWrites` is explicitly set.

CDN integrity (M-K6) — partial and documented: the Pyodide **entry module**
(`pyodide.mjs`) is fetched, SHA-256-verified against
`PYODIDE_ENTRY_SHA256`, then imported from a blob URL. The core wasm/asm and
package wheels `loadPyodide` subsequently fetches remain trusted to the
immutable-versioned CDN plus Pyodide's own `pyodide-lock.json` — pinning their
digests too is deferred.
