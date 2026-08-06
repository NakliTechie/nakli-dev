# Kiln — `sys/kiln/`

*A persistent Python kernel inside the browser tab.* nakliOS's execution runtime — a
long-lived Pyodide kernel in a Web Worker, mounted on a scoped slice of `naklios.fs`,
with a typed protocol for executing code and keeping namespace state between cells.

**Kiln is the verbs.** Under the RLM model it is also **the model's only tool**: the
agent writes `rig.patch(path, diff)` in a Python cell instead of emitting JSON tool
calls. It owns the Python namespace, subagents, harness state, and the verifier kernel.
It does **not** own files (borrows Rig), grants (derives from Rig's), or goal records.

**The sandbox is structural:** the Worker has no network and no process spawn. The
verifier runs the operator's immutable command in a *fresh* kernel the working
namespace cannot reach — the wall against reward-hacking.

**Status:** planning. No code yet. First chunk: **K0 — the kernel** (Pyodide in a
Worker; typed `exec/interrupt/reset/inspect`; consent-gated download).

**Planning docs** (this folder):
- `KILN-VISION-AND-ROADMAP.md` — why a persistent kernel, the reward-hacking wall, roadmap.
- `KILN-AGENT-HANDOFF.md` — the build contract: chunks K0–K6, checkpoints, hard rules.

> Note: unrelated to `~/Code/kiln` (a separate LFM2/WebLLM project). Same name,
> different repo and path.

Authoritative bundle + cross-repo roadmap: **`NakliTechie/agentverse`**.

> Planning placeholder. Kiln is headless — its surfaces belong to Forge.
