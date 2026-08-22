# Forge — `apps/forge/`

*The shell on top of Rig and Kiln — desktop **and** mobile.* Panels, transcript,
terminal, goal board. Forge is where the human sits: a coding agent you can point at a
repo in your own storage, read the diff, write a change, run the tests, watch them go
green, and commit — no server, no account, no install, and (until you hand it a goal)
no model.

**Forge is the window.** It owns every pixel and owns no capability — it is a view over
the Rig command registry. **Mobile is not a squeezed desktop:** a distinct single-column
shape with a surface switcher. No AI is load-bearing; every surface works with no model.

**Status:** planning. No code yet. Chunk **C5**, built strictly against the reference +
mockup below. Rig C4b and Kiln K2 are available, so the build is unblocked. Tokens as CSS custom properties from day
one; in-app prompt/confirm, never native dialogs; designed empty/error states; a11y and
i18n from the first commit.

**Planning docs** (this folder):
- `FORGE-UX-UI-REFERENCE.md` — the drawn target the build follows.
- `forge-mockup.html` — the mockup. Open in a browser.

Authoritative bundle + cross-repo roadmap: **`NakliTechie/agentverse`**.

> Planning placeholder. The user-facing README is owed after Forge's first ship.
