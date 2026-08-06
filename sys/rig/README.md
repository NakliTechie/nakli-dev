# Rig — `sys/rig/`

*The toolroom under nakliOS: files and version control.* Fileops over `naklios.fs`,
the typed command registry, git core (`isomorphic-git` adapter), the agent face
(`window.rig`, path grants, op-log), the faux CLI, and goal records.

**Rig is the nouns.** It owns files, the command registry, local git, grants, the
op-log, and goal records. It does not own execution (that is Kiln, `sys/kiln/`) or
pixels (that is Forge, `apps/forge/`).

**Status:** planning. No code yet. First chunk: **C0 — fileops** (extend
`../../sdk/naklios.js`; do not build a parallel fs).

**Planning docs** (this folder):
- `RIG-VISION-AND-ROADMAP.md` — vision, roles, the two-doors architecture, roadmap.
- `RIG-AGENT-HANDOFF.md` — the build contract: chunks C0–C7, checkpoints, hard rules.

Authoritative bundle + cross-repo roadmap: **`NakliTechie/agentverse`**.

> This is a planning placeholder. The user-facing README (plain words, what Rig does
> for a person) is owed after Rig's first ship, per `RIG-AGENT-HANDOFF.md` §13.
