# C4 — Agent face · checkpoint artifact

Gate for the agent-face chunk (RIG-AGENT-HANDOFF §6, §12).

## How to run

```bash
node sys/rig/agent/test/conformance.test.mjs
```

## Result

```
C4 conformance: 6/6 passed
exit: 0
```

## What it is

The governed surface over the C1 registry. Every non-operator call goes through
`createAgentFace(...).invoke`; the registry stays the single capability shape and
this layer adds §6 governance:

- **grant.mjs** — the one grant primitive: path prefixes + capability scopes,
  deny-by-default, revocable. Path checks reuse `pathguard`, so a grant edge and
  the fs ingress cannot disagree. Rig owns grants; Kiln derives its mount from
  the same grant (never sets/widens/caches — rule #5c).
- **oplog.mjs** — append-only JSONL in the store (never localStorage, rule #9):
  `{ts, actor, caller, command, argsDigest, status}`. Token-shaped strings are
  redacted before the digest is taken (§10).
- **agent-face.mjs** — grant enforcement per command, destructive-op staging
  (propose → operator accept), and op-logging on every call.
- **window-rig.mjs** — installs `window.rig` ONLY when the developer setting is
  on; off by default, undefined otherwise.

## What the gate covers

- **Escape-class matrix.** With a `work` grant, `fs.write` on `../secret`,
  `/etc/passwd`, `work/../secret`, `%2e%2e/x`, `..\x`, and out-of-grant
  `other/x.txt` each returns `{ok:false, code:'EGRANT'}` without throwing; an
  in-grant path is allowed.
- **Grant edges.** A withheld scope (`fs:remove`), a revoked grant, and a prefix
  boundary (`workshop` is not under `work`) all deny with `EGRANT`.
- **Destructive staging.** `fs.remove` returns a staged proposal and leaves the
  file untouched; `accept` executes it; `reject` discards it and a rejected
  proposal can no longer be accepted (`ENOPROPOSAL`).
- **Op-log replay reconstructs the tree.** A recorded op sequence logs one entry
  per call with a faithful `argsDigest` (`=== digestArgs(input)`), actor, and
  caller; replaying the sequence into a fresh store yields a byte-identical
  `work` subtree (empty diff). Token-shaped args are digested only after
  redaction.
- **window.rig off by default.** `enabled:false` ⇒ `window.rig` undefined;
  `enabled:true` ⇒ `invoke`/`tools()`/`grant()` present; uninstall removes it.

## Not done here (follow-on)

- **Cross-tab channel** on the same registry (§6) — a browser `BroadcastChannel`
  concern, outside the §12 checkpoint; deferred.
- **Out-of-root `move` staging** — currently a move outside the grant is denied
  (`EGRANT`) rather than staged; refine when C5 surfaces staging UI.
- **index.html wiring** of the developer setting + `installWindowRig` — additive
  and off by default; not yet placed in the live launcher.
