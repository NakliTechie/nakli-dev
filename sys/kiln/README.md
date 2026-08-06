# Kiln — a real Python kernel inside your browser tab

Kiln runs Python in nakliOS with nothing installed and no server. It's a
long-lived kernel living in a background Worker: you run some code, and the
variables, imports, and functions you defined are still there the next time —
like a notebook that remembers.

## What it does

- **Keeps its state.** Assign a value or import a module in one run and it's
  available in the next. A stateless "evaluate and forget" would miss the point.
- **Stays sandboxed.** The kernel has no network access and can't launch other
  programs. It can only touch the slice of your files you explicitly grant it —
  and reaches those through the very same safety checks the rest of nakliOS uses.
- **Asks before it downloads.** Python-in-the-browser is a sizable download the
  first time. Kiln shows the size and waits for your go-ahead, then caches it —
  until then Kiln simply reports itself unavailable and the rest of nakliOS is
  unaffected. Nothing is fetched behind your back.
- **Never freezes the tab.** A runaway loop is interrupted and reported, output
  is capped so it can't balloon, and an error comes back as a readable traceback
  — never a hung page.

## What it is for

Kiln is the verbs to Rig's nouns. An app can run Python against your files; and
in the assistant model, code *is* the way an agent works — it writes
`rig.write(path, text)` in a cell instead of emitting a special tool call. Kiln
also holds the wall that keeps a task honest: whether a goal is actually "done"
is decided by running the operator's own check in a **fresh** kernel that the
working session can't reach or tamper with.

Kiln does not own your files (it borrows Rig's), does not decide what it's
allowed to touch (that's your grant, held by Rig), and draws no screens of its
own (that's Forge).

## Status

Shipped and tested: the kernel itself — running code, keeping state, interrupt,
reset, inspect, output limits, and the download-consent gate — verified against
real Python in the browser. In progress: the file bridge and the generated
Python `rig` module; the assistant side comes later.

> Unrelated to `~/Code/kiln`, a separate project that happens to share the name.

Design and roadmap live in `KILN-VISION-AND-ROADMAP.md` and
`KILN-AGENT-HANDOFF.md`; the cross-repo plan is in `NakliTechie/agentverse`.
