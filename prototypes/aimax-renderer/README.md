# naklios · aimax renderer (sketch)

A prototype answer to svs's ask: *"all it needs is a renderer. I can run the
daemon myself."*

This is the **renderer half only** — a browser frontend that holds no editing
logic. It renders whatever a daemon streams over a WebSocket and sends
keystrokes / commands back. The daemon (aimax's Rust core) stays the source of
truth for every buffer. See `PROTOCOL.md` for the proposed wire format.

## See it in 5 seconds (no server)

Open `index.html` and click **▶ demo daemon**. An embedded mock streams the
protocol: two windows (`main.rs` + an `*agent*` buffer), an agent streaming a
suggestion, then patching `main.rs`. Type into the focused window — the
keystrokes are *sent to the daemon*, never executed locally (open **wire ▾** to
watch them go out).

## Prove the real socket path

```bash
node prototypes/aimax-renderer/mock-daemon.mjs        # ws://localhost:9123, zero deps
cd prototypes/aimax-renderer && python3 -m http.server 8000
# open http://localhost:8000/  →  Connect
```

Point the renderer at a real aimax daemon by changing the ws URL, once the
daemon speaks `PROTOCOL.md`.

## The transport wall (the real deployment constraint)

A page served from `https://naklios.dev` **cannot** open `ws://localhost:9123`
— browsers block ws: from an https origin (mixed content), and a raw localhost
socket has no TLS. Three ways through, in order of least friction:

1. **Serve the renderer from `localhost`** (or let the daemon serve it). A page
   on `http://localhost` is a *secure context* and may open `ws://localhost`.
   This is how the "prove the real socket path" recipe above works.
2. **Daemon exposes `wss://` with a local cert** — then `naklios.dev` can reach
   it directly. More setup for the daemon.
3. **A naklios local-bridge** shims the daemon's unix IPC socket to a
   browser-reachable endpoint (this is what `nakli-local-bridge` is for; the
   generic socket-proxy mode isn't built yet).

For a first prototype, path 1 is enough and needs nothing from naklios.dev.

## Two flavors of "renderer"

| | raw VT | **structured (this sketch)** |
|---|---|---|
| daemon emits | ANSI/VT byte stream | semantic messages (`PROTOCOL.md`) |
| renderer needs | a terminal emulator (xterm.js — Forge already has it) | a small JSON mirror + native UI |
| result | "a terminal in a tab" | native panels, agent strip, real cursors |
| works for | any TUI program, unchanged | needs a structured mode on the daemon |

Forge (`apps/forge`) already vendors xterm.js, so the **raw-VT** flavor could
live there with just a transport added. The **structured** flavor is the one
worth the daemon-side work — it's what makes aimax feel native in naklios rather
than boxed in a terminal.

## Status

SKETCH. Renders a mock; the protocol is a strawman to hand svs, not a shipped
contract. Nothing here is wired into naklios.dev or the app manifest.
