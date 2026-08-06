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
C0 conformance: 16/16 passed
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

**Backend-agnostic (3 backend shapes proven).** The backend contract is a
one-level `list` (immediate children); `fileops` owns recursion. Verified
against: a one-level object store (`MemoryBackend`), a recursive-list backend,
and a Crate-faithful backend whose `delete` throws on a directory and whose
`mkdir` is a no-op (dirs implicit). `remove`/`copy`/`glob`/recursive-`list`
are correct against all three.

## Seam

`createFileops({ backend, root })` composes the injected storage primitive into
the 11-op API. Browser wires `backend: BACKENDS[bound]` (the live Crate/Folder
store in `naklios/index.html`); the suite wires `MemoryBackend` — the C2
`FakeTransport` pattern applied to storage, a test double, not a shipped second
filesystem. One ingress validator (`pathguard.normalizeMountPath`) is the single
entry for every external path.

## Live wiring (in place; live behaviour unverified headlessly)

`naklios/index.html` now carries the live-store wiring (all additive — nothing
existing calls it, so it cannot regress the shipped app; inert until C2):

- `fsStat` / `fsMkdir` helpers (Folder backend); `stat` returns null for a
  missing path rather than throwing.
- `BACKENDS.fsa` and `BACKENDS.crate` gain `stat` + `mkdir`. Crate `stat` maps
  the manifest entry (`{isDir,size,ts}` → `{type,size,mtimeMs}`) and falls back
  to a prefix listing for an implicit directory; Crate `mkdir` is a no-op.
- `rigFileops({root, backendId})` factory — dynamic-imports this module and
  injects `BACKENDS[bound]`. Not exposed on `window` (that is C4's gated door).

The main inline script passes `node --check` after the edits. The live
behaviour against a real connected Crate/Folder is **assumed**, not verified —
it needs a browser smoke or C2's git-adapter checkpoint to confirm.
