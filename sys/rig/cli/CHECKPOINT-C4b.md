# C4b — Faux CLI · checkpoint artifact

Gate for the faux-CLI chunk (RIG-AGENT-HANDOFF §7, §12). Headless: the parser
and repl are the system under test; xterm.js is only the screen.

## How to run

```bash
node sys/rig/cli/test/conformance.test.mjs
```

## Result

```
C4b conformance: 9/9 passed
exit: 0
```

## What it is

A real terminal *look* over the C1 registry — no shell, no PTY.
`term.onData → line editor → parser → invokeCommand → term.write`; only the
first and last arrows touch xterm.

- **parser.mjs** — quote-aware tokeniser; slash syntax → a registry command name
  + an input object coerced to the command's `inputSchema`. Ergonomic aliases
  (`/ls`, `/read`, `/grep`, `/rm`, …) and namespace subcommands (`/git status`);
  the full dotted name (`/fs.read`) always works, so every command is reachable.
- **repl.mjs** — routes through the C4 agent face: destructive commands come
  back staged and the repl waits for an explicit `y` before `accept`. `/help`
  and `/help <cmd>` render registry metadata (no hand-written help text).
  `/py` is the operator door to the Kiln kernel (a stub until Kiln lands).
- **scrollback.mjs** — redacts token-shaped strings before persistence and
  serialises/restores byte-identically (git oids, 40 hex, stay visible).

## What the gate covers

- **Every command reachable from a typed line.** `compile('/<name>')` resolves
  to that command for all registered commands; aliases and `/git <sub>` resolve.
- **Argument coercion matches declared schemas.** `/ls -R src` →
  `{path:'src', recursive:true}` (boolean); `/grep TODO --glob *.py
  --maxResults 5` → `maxResults` a number; `/mv a b` → `{from,to}`; quoted
  args preserved.
- **Unknown → suggestions, never a throw.** `/reed` compiles to
  `{kind:'unknown', suggestions:[…'fs.read'…]}`; the repl prints them.
- **Destructive cannot run without confirmation.** `/rm work/a.txt` prints the
  proposal and leaves the file; only `y` removes it; `n` cancels and the file
  survives.
- **/help renders registry metadata**; a read/write/list flow runs end-to-end.
- **Scrollback** redacts a provider key, preserves a 40-hex git oid, and
  `serialise → restore → serialise` is byte-identical.

## Not done here (browser follow-on)

The xterm.js chrome — vendoring `@xterm/xterm` + `addon-fit` + `addon-serialize`,
wiring `term.onData → repl.feed → term.write`, history (↑/↓), Ctrl-C/Ctrl-L, and
tab-completion. None of it is the §12 system under test; the parser/repl above
are. This lands with C5 (Forge shell).
