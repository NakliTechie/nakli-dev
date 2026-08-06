# Rig — files and version control, in your browser

Rig is the toolroom under nakliOS. It gives an app — or you, at a terminal — a
clean way to work with **your files** and **git**, entirely on your own storage.
Nothing is uploaded; a connected Folder or an encrypted Crate is the only place
your content lives.

## What it does

- **Files.** Read, write, list, stat, make directories, move, copy, remove,
  search by name (glob) or contents (grep), and apply a patch — all confined to
  the storage you connect. Every path is checked at one gate, so a stray `..` or
  an odd encoded path can't wander outside where it's allowed.
- **Git.** A real repository in the browser: initialise, stage, commit, view
  history and diffs, branch and check out, clone, and push. Your commits carry
  your identity; an agent's commits are clearly marked as the agent's, never
  yours.
- **One command set.** Everything above is a single named list of commands.
  The command palette, the terminal, an app, and the Python kernel all speak to
  the *same* list — so a capability added once shows up everywhere, described the
  same way.
- **A terminal.** A slash-command line over that command set — `/ls -R src`,
  `/read notes.txt`, `/git status`, `/help`. It looks like a shell but runs only
  those known commands; anything destructive asks before it acts.
- **An agent door, off by default.** A developer can turn on a small surface
  (`window.rig`) that lets an agent drive the same commands — but only inside a
  path you grant, with anything destructive **staged for your approval**, and
  with an append-only log of every action.

## What it is not

Rig owns the nouns — files, the command list, local git, grants, the activity
log. It does **not** run code (that's Kiln, `../kiln/`) and it does **not** draw
any screens (that's Forge, `../../apps/forge/`).

## Status

Shipped and tested: files, the command registry, git, the agent door, and the
terminal — verified in the browser too. Still to come: goal records and the
Forge interface that puts a face on all of it.

Design and roadmap live in `RIG-VISION-AND-ROADMAP.md` and
`RIG-AGENT-HANDOFF.md`; the cross-repo plan is in `NakliTechie/agentverse`.
