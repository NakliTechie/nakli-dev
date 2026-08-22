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
