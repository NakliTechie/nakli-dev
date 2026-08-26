# Anvil

A full-fledged, browser-native **code editor** over the Rig workspace — the GUI
sibling of Forge (the terminal). File tree · tabbed editor · save · real-folder
persistence (File System Access) · and (planned) an integrated coding agent with
diff review.

No server, no build (yet), no data leaving the device. A naklios app: it lives at
`apps/anvil/` alongside Forge (`apps/forge/`) and shares the `sys/rig`
(fileops/git/agent) and `sys/ai` (agent loop + tools) modules.

## Status: early foundation
Working: file tree, tabbed textarea editor with line numbers, save (Ctrl/Cmd-S),
open a real folder. Next: syntax highlighting (CodeMirror-class), the agent panel
+ diff review, Python (Kiln). See the naklios `plan/workplan.md` (Batch 6).

## Run (local)
Served from the `naklios` repo root so `../../sys/…` resolves:

    cd ~/Code/naklios-universe/naklios && python3 -m http.server 8080
    open http://localhost:8080/apps/anvil/

## Relationship to Forge
Same substrate, two surfaces. Forge is the terminal + agent (keyboard-first,
tool-call log). Anvil is the editor + agent (tree/editor/diff-review, GUI-first).
Both are naklios apps over one `sys/` core.
