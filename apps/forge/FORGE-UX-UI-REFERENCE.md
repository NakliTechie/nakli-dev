# Forge — UX/UI Reference

*The drawn target. C5 builds against this and `forge-mockup.html`, not against priors.*

**Companions:** `RIG-VISION-AND-ROADMAP.md` · `RIG-AGENT-HANDOFF.md` ·
`forge-mockup.html` (the interactive artifact — open it, click the state switcher).

**No park wall.** The mockup exists. Reference screenshots (§9) are the operator's
one remaining input and do not gate the build.

---

## 1. The Unity sentence

> **An instrument you own — the repository itself, dense and legible, with the agent
> working inside it rather than beside it.**

*Owned:* no service chrome, no account affordances, version string visible.
*The repository itself:* the real tree, the real diff, the real exit code — never a
summary standing in for them. *Dense and legible:* instrument density, chosen not
defaulted. *Inside it:* agent output lands in the git panel as a staged change, never
in a chat window parked to one side.

**Density stance: dense and instrumental.** Not calm-and-breathing. Splitting the
difference reads as clutter, not compromise.

---

## 2. The surfaces

| # | Surface | What it is |
|---|---|---|
| S1 | **Welcome / no repo** | Open a folder or clone. Carries `?`, version, one-time intro |
| S2 | **Workbench** | Tree · editor/diff · right rail. Everything else is a mode of this |
| S3 | **Git panel** | Status, staged/unstaged, diff, history, branch |
| S4 | **Run panel** | Verification runs: command, live output, exit code, run history |
| S5 | **Terminal** | `xterm.js` over the faux CLI. A drawer, not a panel |
| S6 | **Goal board** | Objective, plan steps (tri-state), **parked items**, tried-trail, deliberate rollbacks, session history, budget, controls. **Forge renders the record; Rig holds it** (`sys/rig/goals/`) |
| S7 | **Refine tray** | Refinements the agent **has already applied**, newest first, each with its evidence and a one-click rollback. Review-after, not approve-before. **Forge renders; Kiln holds** (`sys/kiln/harness/`) |

**Forge owns no capability and no state.** Every surface is a view over the Rig
registry or over state Rig and Kiln hold. If a panel would need its own store, the
design is wrong.

The agent transcript is **not** a surface. It renders inside the right rail above the
git panel, and its output resolves into S3 as a staged change. This is the single
most important layout decision in the document.

---

## 3. Desktop layout — floor 1280×800

```
┌──────────────────────────────────────────────────────────────────────┐
│ ▸ repo-name   branch ⌄   ● 3 staged   ⌘K            forge 0.1.0      │ 40px
├───────────────┬──────────────────────────────┬───────────────────────┤
│               │                              │  transcript           │
│  tree         │  editor / diff               │  ─────────────────    │
│               │                              │  git (S3)             │
│  260px        │  flex                        │  ─────────────────    │
│               │                              │  run (S4)             │
│               │                              │  340px                │
├───────────────┴──────────────────────────────┴───────────────────────┤
│ terminal drawer (S5) — collapsed, ⌃` toggles                         │ 0/240px
├──────────────────────────────────────────────────────────────────────┤
│ goal: ship v2 endpoint  step 3/5  ⏸  budget 41%  ● verifying         │ 28px
└──────────────────────────────────────────────────────────────────────┘
```

Three columns, fixed rails, flexible centre. Panels resize; the layout does not
rearrange — an instrument does not move its dials. The right rail is one scroll
column with hairline-ruled sections, never three stacked cards. Status bar always
present; goal segment empty when no goal exists. Terminal is a drawer over the
centre, never a fourth rail. No modals except destructive confirms and the intro.

---

## 4. Mobile — floor 390×844

**Not a squeezed desktop.** A distinct single-column shape. Mobile is Forge's
founding premise: the operator hands a goal to a model from a phone and checks on it
later.

```
┌─────────────────────────┐
│ ▸ repo   branch ⌄   ⋯   │  header 44px
├─────────────────────────┤
│                         │
│   active surface        │  one at a time,
│   (tree / diff / git /  │  full width
│    run / goal / term)   │
│                         │
├─────────────────────────┤
│ goal · step 3/5 · 41%   │  status 32px, tappable → S6
├─────────────────────────┤
│ ⌂    ⑂    ▶    ◆    ⌨   │  switcher 52px
└─────────────────────────┘
   tree git  run goal term
```

**Mobile rules.**
- Surface switcher replaces columns. Never two panels at once.
- The editor is **read + patch-review only** on mobile. Freeform editing on a phone
  is a worse experience than the honest absence of it; the diff review is the point.
- Touch targets ≥ 44px; the switcher and the goal bar are the only persistent chrome.
- The terminal gets the full sheet when active, with a visible key bar for `⌃C`,
  `Tab`, `↑`, `↓` — the keys a soft keyboard cannot supply.
- Long-press replaces hover for tree and diff affordances. Nothing depends on hover.
- **Priority order when space is scarce:** goal status → staged diff → run verdict.
  Those three are what a person opens a phone to see.

**Tablet 768–1023px:** two columns — centre plus right rail; tree becomes a drawer.

---

## 5. Per-actor views

| Surface | Operator | Agent session active | No model configured |
|---|---|---|---|
| Tree | Full: create, rename, delete | Agent-touched files carry a left-edge accent bar; files outside the grant are **dimmed, never hidden** | Identical |
| Editor/diff | Edit freely (desktop) | Read-only while a step runs; agent edits arrive as staged diff, never live typing | Identical |
| Git (S3) | Stage, unstage, commit, branch, push | Agent's staged changes in their own group, headed by the agent identity and session trailer. **Commit and push stay operator-only** | Identical |
| Run (S4) | Run anything | Verification runs marked with the goal id and flagged as fresh-kernel | "Kernel not downloaded" state; git and files unaffected |
| Terminal (S5) | Full registry + `/py` | Same registry, grant-scoped; out-of-grant refuses and says why | Identical |
| Transcript | Absent | Present | Absent — rail is git + run only |
| Goal board (S6) | Create, pause, resume, clear | Read + append trail. **Cannot set `done`, cannot see `verificationCommand`** | Absent |
| Refine tray (S7) | Read, roll back, promote scope | Applies within its fence; cannot touch base prompt, verification, or grant | Absent |

**The no-model column is the important one.** It is not a degraded state; it is the
product. Everything except the transcript, goal board, and refine tray is identical.

---

## 6. Token palette

Frozen before the build opens. If a value is not here, it is not in the system.

### Type (D7)
```css
--font-ui:   "IBM Plex Sans", system-ui, sans-serif;
--font-mono: "IBM Plex Mono", ui-monospace, monospace;
```
Deliberately not Inter — the scaffold default, and the reason most agent output looks
alike. Alternatives if preferred: Commit Mono, Iosevka, or Berkeley Mono (licensed)
for mono; Public Sans for UI.

Mono carries: tree, editor, diff, terminal, run output, status bar, all numerics.
UI carries: transcript prose, labels, help, empty states. Nothing else.

```css
--text-xs: 11px/1.4;  --text-sm: 12px/1.5;   /* workhorse */
--text-md: 13px/1.5;  --text-lg: 15px/1.4;   --text-xl: 20px/1.3;
```
Mobile shifts the workhorse to 13px and the tree to 14px. Three tiers per screen, max.

### Colour — dark first, light by token swap
```css
--bg-0:#0E1012; --bg-1:#15181B; --bg-2:#1C2024; --bg-3:#242A2F;
--fg-0:#E6E9EB; --fg-1:#A8B0B6; --fg-2:#6E777D; --rule:#262C31;
--accent:#D98A28; --accent-dim:#8A5A1C;
--ok:#5C9E6B; --warn:#C9A227; --err:#C2564B; --add:#3F6B4A; --del:#6B3F3F;
```
**One accent, working.** Amber appears only where something is interactive or
stateful: focus ring, primary action, active step, current branch, caret. Not blue,
not violet — the category defaults. Anywhere decorative, delete it. Semantics are
muted by design so the accent still wins the screen.

### Space
```css
--s-1:2px; --s-2:4px; --s-3:8px; --s-4:12px; --s-5:16px; --s-6:24px;
--radius:3px; --rule-w:1px;
```
Row height 22px desktop, 40px mobile. Panel padding `--s-4`. Section gap `--s-5` with
a hairline. **Grouping is space and rule; never a bordered card.**

### Motion
```css
--dur:120ms; --ease:cubic-bezier(.2,0,0,1);
```
Transitions preserve context — drawer open, panel resize, step advance, surface
switch. Nothing else animates. `prefers-reduced-motion` is a first-class path.

---

## 7. The distinctiveness pass

Two choices no template would make.

1. **Hairline instrument grid.** Every division is a 1px rule at `--rule` — never a
   shadow, never a card, never a rounded container. Panels are regions of one
   continuous surface, ruled like a plotter sheet. The strongest departure from the
   shadowed-card landscape.
2. **Status as typography, not badges.** No pills, no coloured chips, no icon soup.
   State is mono weight, dimming, and a single glyph in the accent: `●` active,
   `✓` passed, `✗` failed, `⏸` paused. A failed run goes red in the *text*, not in a
   box around it.

Everything else descends from the standing biases: deletion first, type does the
branding, one accent working, honest surfaces, data-ink on anything quantitative.

---

## 8. Keyboard map

| Key | Action | Conflict |
|---|---|---|
| `⌘K` | Command palette | Global; wins everywhere including the terminal |
| `⌃\`` | Toggle terminal drawer | Global |
| `⌘P` | Quick open file | Global |
| `⌘S` | Save buffer | Editor only |
| `⌘Enter` | Run verification | Global |
| `⌘⇧G` | Focus git panel | Global |
| `⌘⇧A` | Focus refine tray | Global |
| `Ctrl-C` | **Terminal:** cancel. **Else:** copy | Terminal focus takes precedence |
| `Ctrl-L` | **Terminal:** clear. **Else:** unbound | — |
| `Tab` | **Terminal:** completion. **Else:** focus traversal | Terminal traps `Tab`; `Esc` then `Tab` leaves |
| `Esc` | Leave terminal focus / dismiss inline confirm | Never closes the drawer |
| `↑ ↓` | **Terminal:** history. **Tree/list:** navigate | — |

While the terminal has focus it owns its keys except `⌘K` and `⌃\``. A visible focus
ring in `--accent` makes ownership obvious.

---

## 9. Empty and error states

One line of plain language, one action. No mascot, no illustration, no upsell.

| State | Copy shape | Action |
|---|---|---|
| No repo | "Open a folder, or clone one." | Two buttons |
| No kernel | "Python isn't downloaded yet — about 12 MB, cached after the first time." | Download / dismiss. Files and git keep working |
| No model | *Nothing.* The transcript rail is simply absent | — |
| No grant | "The agent needs a folder to work in." | Pick prefix |
| No bridge | "Push needs the local bridge, or a GitHub token. Everything else works offline." | Install / add token / dismiss |
| Offline | "Working offline. Push is unavailable; everything else is local." | Dismiss |
| Goal blocked | Tried-trail, worst attempt first, and why it stopped | Resume / clear |
| Resumed from windup | "Picked up at step 3 — closed mid-edit on routes.py, last signal a failing paginate test." **Already continuing** — informational, not a gate | Correct / pause |
| Consistency flag | "Last session recorded a clean close, but the tree has 2 uncommitted files." Never auto-corrected | Reconcile / ignore |
| Refinement runaway | "Five refinements to memory this goal, no test progress." | Roll back / continue |
| Push boundary (once) | "Pushing sends this code to <remote>. Nothing else here leaves your machine." | Push / cancel |
| Run failed | Exit code and stderr, verbatim, in mono | Re-run |

Never an error wall where a feature used to be. Degradation is one line plus a
working product underneath.

---

## 10. Reference screenshots — the one operator input

Two or three, chosen not moodboarded, in this order of argument:

1. **Codex CLI TUI** — transcript rhythm, approval prompt, diff review.
2. **A Berkeley Graphics instrument surface** — hairline density,
   status-as-typography.
3. **A dense, non-cardy git diff view** — the screen users stare at longest.

Explicitly *not* a reference: the Codex desktop app's chrome. It is closed; copying a
look we can only see in screenshots is how templated output happens.

---

## 11. Verification

| | |
|---|---|
| Floor viewports | **390×844** (mobile), **768×1024** (tablet), **1280×800** (desktop). Capture also at 1440×900 |
| Capture | `/guide` path, reproducibly, per surface and per state |
| Critique | Fresh-context, eight principles (contrast · hierarchy · alignment · proximity · repetition · balance · white space · unity), one finding each, worst-first |
| Gate | Screenshots at all three floors **and** critique filed with zero open findings, before the next chunk |

The critique never runs in the context that wrote the markup.

---

**Remove first, then choose the type, then hold the density. The agent's output is
the base coat; this document is the paint.**
