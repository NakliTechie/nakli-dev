# C0 — Fileops · checkpoint artifact

Gate for the Rig fileops chunk (RIG-AGENT-HANDOFF §3, §12).

## How to run

```bash
node sys/rig/fileops/test/conformance.test.mjs
```

Vanilla ESM, no build step, no deps. Node 22 verified; environment-neutral
(the same suite runs in a browser harness later).

## Result

```
C0 conformance: 14/14 passed
exit: 0
```

## What the gate covers

**Every op exercised.** `read · write · list · stat · mkdir · remove · move ·
copy · patch · glob · grep` each has at least one passing case.

**Byte-hash round-trip (text + binary).** FNV-1a over the raw bytes.
- text: multi-script UTF-8 (Devanagari + Japanese + emoji) write → read → equal hash.
- binary: all 256 byte values 0x00–0xff write → read → equal hash, byte-for-byte.
- `read` returns `Uint8Array` by default; text only with `{encoding}`.

**Patch apply → revert byte-identical.** `patch()` returns an exact `revert`
diff; applying it restores the original bytes (hash-equal). Atomic: a failed
hunk returns `EPATCH` naming the hunk (`hunk #1 …`) and the file is left
byte-unchanged (verified by hash). A no-trailing-newline file survives
apply→reverse exactly.

**Traversal rejection matrix — every class fails closed** (mount root set, so
`..` above it is meaningful). Each returns `{ok:false, code:'EINVAL_PATH'}`
without throwing:

| Class | Input |
|---|---|
| dotdot escape | `../secret` |
| nested dotdot escape | `a/../../secret` |
| absolute escape | `/../secret` |
| encoded dot | `%2e%2e/secret` |
| encoded slash | `a%2fb/../../secret` |
| backslash | `..\secret` |
| control byte | `ab` |
| non-string | `42` |
| symlink escaping the mount | symlink → `../../etc/passwd` |

An in-mount symlink resolves and reads through; the out-of-mount symlink is
rejected at the resolver.

**Typed results, never throws.** `read/stat/remove/patch/list` on a missing
path, and `write` with an invalid data type, all return `{ok:false, code}` —
no exception.

## Seam

`createFileops({ backend, root })` composes the injected storage primitive into
the 11-op API. Browser wires `backend: BACKENDS[bound]` (the live Crate/Folder
store in `naklios/index.html`); the suite wires `MemoryBackend` — the C2
`FakeTransport` pattern applied to storage, a test double, not a shipped second
filesystem. One ingress validator (`pathguard.normalizeMountPath`) is the single
entry for every external path.

## Not yet wired (follow-on)

The live `BACKENDS` in `naklios/index.html` needs `stat` and `mkdir` added
(the "if not, add it there" clause of §3) before Rig fileops runs against the
real store in the browser. The headless gate above is backend-agnostic and does
not depend on that wiring.
