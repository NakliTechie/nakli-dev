# naklios · aimax renderer (sketch)

A prototype answer to svs's ask: *"all it needs is a renderer. I can run the
daemon myself."*

This is the **renderer half only** — a browser frontend that holds no editing
logic. It renders whatever the daemon exposes and sends edits/commands back;
the daemon (aimax's Rust core) stays the source of truth for every buffer.

**Two things live here:**
- `aimax.html` + `bridge.mjs` — the **real client**, verified end to end against
  a locally-built headless aimax over its own JSON-RPC (see "Against the REAL
  aimax daemon" below). This is the one that matters.
- `index.html` / `vt.html` / `mock-daemon.mjs` / `PROTOCOL.md` — the earlier
  **strawman** (a proposed structured wire + a raw-VT variant + a mock), built
  before his protocol was known. Kept as a general reference and for the
  record→validate→replay tooling.

## See it in 5 seconds (no server)

Open `index.html` and click **▶ demo daemon**. An embedded mock streams the
protocol: two windows (`main.rs` + an `*agent*` buffer), an agent streaming a
suggestion, then patching `main.rs`. Type into the focused window — the
keystrokes are *sent to the daemon*, never executed locally (open **wire ▾** to
watch them go out).

## Prove the real socket path

```bash
node prototypes/aimax-renderer/mock-daemon.mjs        # ws://localhost:9123, zero deps
python3 -m http.server 8000                            # serve from the REPO ROOT (vt.html needs ../../vendor)
# structured:  http://localhost:8000/prototypes/aimax-renderer/index.html  → Connect
# raw VT:      http://localhost:8000/prototypes/aimax-renderer/vt.html      → Connect
```

The one daemon serves both flavors; the client picks in its hello
(`mode:"structured"` or `mode:"vt"`). Point either renderer at a real aimax
daemon by changing the ws URL, once it speaks `PROTOCOL.md`.

## Against the REAL aimax daemon (verified)

aimax already defines its frontend surface — **JSON-RPC 2.0 over a unix socket**
(`~/.aimax/sock`), `core/src/ipc.rs`: methods `eval` / `get_state` / `subscribe`,
plus pushed `event` notifications. `aimax.html` speaks that contract directly
(no invented wire); `bridge.mjs` exposes the unix socket as a browser ws.

```bash
# 1. build + run aimax headless (its supported "daemon, no TUI" mode)
git clone https://github.com/svs/aimax && cd aimax && cargo build
./target/debug/aimax --headless          # IPC on ~/.aimax/sock

# 2. bridge the unix socket to a ws the browser can reach
node prototypes/aimax-renderer/bridge.mjs ~/.aimax/sock 9130

# 3. serve from repo root + open the real client
python3 -m http.server 8000
#    http://localhost:8000/prototypes/aimax-renderer/aimax.html  → Connect (ws://localhost:9130)
```

`aimax.html` subscribes to events, pulls `get_state` (buffer list + cursor) and
`eval (buffer-text)` (content), renders natively, and writes edits back as
`(buffer-insert …)` / `(buffer-switch …)`. **Verified end to end** against a
locally-built headless aimax: buffers/tabs/cursor render from the live daemon;
an edit made in the browser landed in the real daemon buffer (confirmed by an
independent socket probe). The one gotcha: aimax reads **newline-delimited**
requests — the ws client must append `\n`.

Gaps (open questions for svs, not blockers): `get_state` exposes buffer
metadata + cursor but **not** window layout or buffer text (text comes via
`eval`); v0 renders the current buffer + a tab per buffer.

### How it connects — and why it's NOT a CORS thing

The renderer opens a plain `new WebSocket(url)` to the bridge. Two facts people
usually get backwards:

1. **WebSockets are not subject to CORS.** No preflight, no
   `Access-Control-Allow-Origin`. The handshake carries an `Origin` header, but
   nothing *requires* the server to answer it a particular way to connect. So
   "make the bridge CORS-compliant" is a non-goal — CORS isn't the gate.
2. **The browser gate is mixed content**, not CORS: an `https://` page cannot
   open `ws://`. Serving the renderer from `http://localhost` and dialing
   `ws://localhost` just works — which is the recipe above.

**Tested live on naklios.dev (the page IS deployed there):** from
`https://naklios.dev`, `new WebSocket('ws://localhost:9130')` is **blocked by the
browser before any network request** — the bridge sees nothing. So the localhost
"exemption" does **not** save a public-https page here; `ws://` from `https://`
is refused, and the browser doesn't even send the Private Network Access
preflight. (The bridge now answers that PNA preflight anyway — see
`Access-Control-Allow-Private-Network` — because it's half of the eventual fix.)

**To make naklios.dev → a local daemon work you need `wss://`:** the bridge
serves TLS with a locally-trusted cert (e.g. `mkcert` for `127.0.0.1` or a
loopback host), so it's secure-to-secure (no mixed content) and the PNA grant
covers the public→local hop. That installs a local CA into the system trust
store — a deliberate step, not done here. Until then, the intended deployment
for a *local* daemon is to **serve the renderer from localhost** (or have the
daemon serve it); a public-origin renderer talking to your localhost is exactly
what browsers work to prevent.

**The real security control is the reverse of CORS.** *Because* ws skips CORS,
any website you happen to be visiting could run `new WebSocket('ws://localhost:9130')`
and drive your local daemon. So the bridge enforces its **own Origin allowlist**
(`ALLOW_ORIGINS`, default `http://localhost:8000` + `https://naklios.dev`); a
request from any other origin gets `403`. A request with no Origin (a non-browser
client — node, curl — which could reach the unix socket directly anyway) is
allowed. Verified: `Origin: https://evil.example.com` → 403; `http://localhost:8000`
→ accepted. This is the same class of control the egress Worker applies, just at
the local-bridge boundary.

### Where the connection settings live

In this prototype: the **ws URL field + Connect button** in the toolbar (default
`ws://localhost:9130`) — that's the whole config surface. There is no persistent
store yet. In a real naklios integration this would move into the host's
bridge/egress settings (the `nakliOS.gitAuth` / egress-settings pattern), and the
allowlist would be the host's, not a per-prototype default.

## Files

| file | what |
|---|---|
| `aimax.html` | **the real client** — speaks aimax's JSON-RPC (subscribe/get_state/eval, pull-on-notify); edits via `(buffer-insert)` |
| `bridge.mjs` | **nakli-local-bridge** — exposes a unix socket as `ws://localhost`; protocol-agnostic, reusable for any local daemon |
| `index.html` | structured strawman renderer — native panels, agent strip, Cmd-K palette, click-to-focus, version-gap resync |
| `vt.html`    | raw-VT renderer — pipes a daemon's ANSI stream into xterm; a thin remote-terminal client for any TUI |
| `mock-daemon.mjs` | zero-dep strawman daemon, both flavors, chosen by the client hello |
| `record.mjs` | connect to a daemon, dump its stream → `.jsonl` (point it at a real daemon to capture a live session) |
| `conformance.mjs` | validate a `.jsonl` against `PROTOCOL.md` — where does a daemon's stream diverge from the strawman? |
| `PROTOCOL.md` | the strawman structured render contract (superseded for aimax by its own JSON-RPC; kept as a general reference) |

## Record → validate → replay (the integration loop)

The moment svs sends a socket dump — or points us at his daemon — this is the loop:

```bash
node record.mjs ws://his-daemon:PORT capture.jsonl 5   # capture 5s of his stream
node conformance.mjs capture.jsonl                     # exit 0 = conforms; else a per-line diff report
# then replay it into the renderer with NO daemon:
#   http://localhost:8000/prototypes/aimax-renderer/index.html?replay=capture.jsonl
```

In the renderer, **⏺ rec** captures the inbound stream to a `.jsonl` you can
download, and **replay** loads one back. `?replay=<url>` does the same by link.

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
