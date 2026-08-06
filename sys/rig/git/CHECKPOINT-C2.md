# C2 — Git core · checkpoint artifact

Gate for the git-core chunk (RIG-AGENT-HANDOFF §5, §12). Built in two layers.

## How to run

```bash
node sys/rig/git/test/conformance.test.mjs        # Layer 1: adapter + local ops
node sys/rig/git/test/transport.test.mjs          # Layer 2: Transport + FakeTransport
node sys/rig/registry/test/conformance.test.mjs   # git.* on the one registry
```

## Result

```
C2 (Layer 1) conformance: 8/8 passed
C2 (Layer 2 / Transport) conformance: 3/3 passed
exit: 0
```

All four §5 checkpoint parts pass: (1) clone pinned repo@SHA → head matches;
(2) known edit → content hash matches; (3) statusMatrix on a fixture; (4) ref
set survives round-trip.

## Vendoring (hard rule #3 — never fork isomorphic-git)

`vendor/isomorphic-git/1.40.0/isomorphic-git.mjs` — isomorphic-git 1.40.0 (MIT),
bundled to a single self-contained browser ESM (esbuild, all 8 upstream deps
inlined, `Buffer` polyfill injected). Used through the fs adapter only.

## The fs adapter (`fs-adapter.mjs`)

Presents a Node-fs `{promises}` surface over a Rig fileops instance. Two
translations the checkpoint rests on:

- **Typed result → Node-coded throw.** fileops returns `{ok:false, code}`; the
  adapter throws `Error` with `.code` (`ENOENT`, `ENOTDIR`, …) as isomorphic-git
  expects.
- **Stable `ino`/`dev`.** `stat`/`lstat` synthesise `ino` from an FNV path hash
  and a constant `dev`; stable across calls, so git sees no phantom changes.
- Symlinks fail loudly (`symlink` throws `ENOSYS`) — never a silent no-op (§5).
  The backends do not represent symlinks, so `lstat === stat`.

## What Layer 1 covers

- **Part 2 — known edit → content hash matches.** `init → write → add → commit`;
  `HEAD` resolves to the commit; `a.txt` (`"hello\n"`) hashes to the canonical
  git blob id `ce013625030ba8dba906f756967f9e9ca394464a`; identical content
  yields an identical **tree** hash across two fresh repos.
- **Part 3 — statusMatrix on a fixture.** committed-unmodified,
  modified-unstaged (`[1,2,1]`), and untracked (`[0,2,0]`) rows are exact.
- **branch / checkout / log** across two branches; a feature-only file is absent
  on `main` after checkout.
- **Commit identity (§5).** Agent commits are forced to `agent@rig.local` +
  `Rig-Session:` trailer and cannot borrow the operator identity even when one
  is passed; an operator commit without an identity is refused (`ENOIDENT`).
- **diff** — working-tree (`added`/`modified`) and between two refs. The gitdir
  is pruned from the walk; directories return a marker so `walk` keeps
  descending (a null return prunes the subtree).

## Registry integration

`git.*` (13 commands: init/add/remove/commit/status/statusMatrix/log/diff/
branch/listBranches/checkout/listRemotes/resolveRef) register on the **same**
C1 registry as `fs.*`. Scopes: `git:read` / `git:write` (+ `git:remote` /
`git:push` reserved for Layer 2). `commit`, `checkout`, `remove` carry
`destructive:true`. A full `git.init → fs.write → git.add → git.commit →
git.resolveRef` flow drives entirely through `invokeCommand`
(`registry` gate 11/11).

## Layer 2 — Transport seam + FakeTransport

All remote I/O flows through one `Transport` interface
(`clone/fetch/push/listServerRefs`). `FakeTransport` (`transport.mjs`) is the
permanent test seam: it serves a source repo held in the store and moves the
object database by copying the content-addressed loose objects + refs between
two fileops-backed repos.

- **Part 1 — clone.** A fresh target clones the source; `HEAD` resolves to the
  source SHA and the worktree materialises from the tree (force-checkout,
  because the copied `.git/index` would otherwise mask an empty worktree).
- **Part 4 — ref round-trip.** The full ref set (`main` + `feature`) survives a
  clone; a branch committed on the target `push`es back so the server advertises
  it *and* holds its objects (the source resolves and reads the pushed commit).

The Bridge project supplies the real HTTP transports later against this same
interface; every Bridge checkpoint re-runs C2's checkpoint unchanged. Push stays
operator-only and is not exposed to the kernel.
