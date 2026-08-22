# K1 — Kiln filesystem bridge · checkpoint artifact

Gate for KILN-AGENT-HANDOFF §4 and §11.

## How to run

```bash
node sys/kiln/test/fs-bridge.test.mjs
node sys/kiln/test/worker-runtime.test.mjs
node test/serve-kiln.mjs
# open http://127.0.0.1:8765/test/kiln-worker-harness.html in Chromium
```

## Result — 2026-08-12

```text
K1/fs-bridge conformance: 5/5 passed
K0-K2/worker-runtime conformance: 4/4 passed
Kiln Worker integration: 9/9 passed
```

## What the gate verifies

- The dedicated module Worker mounts MEMFS at `/workspace`.
- The main thread snapshots only the scoped Rig bridge into that mount.
- Python `open()` reads the scoped files and persists changed bytes back through
  the governed Rig face after each cell.
- Binary bytes round-trip unchanged in both directions.
- Python `../` and absolute escape attempts raise `PermissionError`.
- A write outside the active Rig grant returns `EGRANT` and is not persisted.
- Python removals discovered during filesystem synchronization become staged
  `fs.remove` proposals rather than immediate deletes.

## Boundary

Storage synchronizes at execution boundaries because Emscripten filesystem
callbacks are synchronous while NakliOS storage backends are asynchronous. The
Worker never receives the backend, registry, grant, or operation-log objects.
The main-thread sync applies mutations through the C4 agent face.
