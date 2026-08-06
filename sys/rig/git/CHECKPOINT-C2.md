# C2 — Git core · checkpoint artifact

Gate for the git-core chunk (RIG-AGENT-HANDOFF §5, §12). Built in two layers.

## How to run

```bash
node sys/rig/git/test/conformance.test.mjs        # Layer 1: adapter + local ops
node sys/rig/registry/test/conformance.test.mjs   # git.* on the one registry
```

## Result — Layer 1 (local ops)

```
C2 (Layer 1) conformance: 8/8 passed
exit: 0
```

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

## Not yet done — Layer 2 (Transport)

Checkpoint parts **1** (clone pinned repo@SHA → head matches) and **4** (ref set
survives round-trip) need the Transport seam: a `Transport` interface and the
permanent `FakeTransport` (a bare repo in the store) supplying clone/fetch/push.
`git-core` exposes `clone/fetch/push/listServerRefs` that delegate to an injected
transport; none is wired yet. Push stays operator-only and is not exposed to the
kernel.
