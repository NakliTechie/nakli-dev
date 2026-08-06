# C1 — Command registry · checkpoint artifact

Gate for the Rig command-registry chunk (RIG-AGENT-HANDOFF §4, §12).

## How to run

```bash
node sys/rig/registry/test/conformance.test.mjs
```

## Result

```
C1 conformance: 9/9 passed
exit: 0
```

## Pattern reuse (hard rule #4 — no second registry shape)

Ported from NakliData's command-bus (`src/core/agent/registry.ts`):

- A command is a plain object; the registry is a factory over an **array**, not
  a class / Map / decorator.
- `invokeCommand` is the **sole** path that reaches a command's `run` handler.
- `searchCommands` / `describeCommand` / `list` / `toolSchemas` project
  **metadata only** — they never reference `run`, so discovery is provably
  side-effect-free.
- `inputSchema` / `returnSchema` are inert JSON-Schema literals (no zod, no
  runtime schema validation) — the fileops layer validates its own inputs.

RIG §4 adds three fields NakliData's shape omits: `returnSchema`, a
`destructive` flag, and a `scope` (required grant). Same shape, three fields —
not a second registry shape.

## Command shape

```
{ name, summary, description, inputSchema, returnSchema,
  destructive: boolean, scope: string, annotations: { readOnlyHint }, run(input, ctx) }
```

First 11 commands registered: the C0 fileops (`fs.read · fs.write · fs.list ·
fs.stat · fs.mkdir · fs.remove · fs.move · fs.copy · fs.patch · fs.glob ·
fs.grep`), each closing over an injected fileops instance. C2 adds `git.*` to
the same registry.

## What the gate covers

- **Generated from metadata.** The contract test iterates every registered
  command and asserts name (unique) · one-line summary · description ·
  object `inputSchema` · `returnSchema` · boolean `destructive` · known `scope`
  · `annotations.readOnlyHint` · `run` function. A new command cannot exist
  without being covered.
- **Valid schema per command.** `required ⊆ properties`, `additionalProperties:
  false`. Destructive/read-only coherence (read-only ⇒ not destructive;
  `fs.remove` destructive; `fs.write` mutating).
- **Discovery leaves the tree hash unchanged.** `list` + `searchCommands` +
  `describeCommand`(all) + `toolSchemas` run against a seeded fileops tree; the
  FNV tree hash is identical before and after. Projected metadata provably
  omits `run`.
- **invokeCommand is the sole invoker.** `fs.write` then `fs.read` round-trips
  through the registry. An unknown command returns a typed
  `{ok:false, code:'ENOCMD', suggestions:[…]}` (never a throw) with the nearest
  command surfaced by the edit-distance fallback.
- **toolSchemas** emits LLM-shaped metadata from the registry with no handler
  leaked.

## Consumers (all read this one shape)

Command palette · faux CLI (C4b) · `window.rig` (C4) · Kiln Python bindings
(K2). None gets its own path to capability.
