# naklios ⇄ aimax — a proposed structured render protocol (v1, draft)

This is a **strawman** for the "structured buffer + window state" flavor. It is
what a naklios renderer wants a daemon to speak so it can draw a **native UI**
(panels, cursors, an agent strip) instead of interpreting a raw VT byte stream.

It is a proposal to react to, not a spec to conform to. The alternative — the
daemon just streams raw ANSI/VT and we render it with xterm.js — needs none of
this, but yields "a terminal in a tab" with no semantic hooks.

## Framing

- Transport: one WebSocket. Messages are JSON, one object per WS text frame.
- Direction is explicit; every message has a `t` (type) field.
- The **daemon is the source of truth**. The renderer holds only a mirror it
  rebuilds from messages; it never edits a buffer on its own. Keystrokes are
  *sent*, never executed locally.
- Versioned buffers: each buffer carries a monotonic `version`; `patch` messages
  are relative and carry the resulting `version` so a client can detect a gap and
  ask for a full `buffer` resync.

## Daemon → renderer

```jsonc
// once, on connect
{ "t":"hello", "app":"aimax", "proto":1, "caps":["buffers","windows","agent","minibuffer"] }

// full buffer contents (sent on open, or to resync)
{ "t":"buffer", "id":"b1", "name":"main.rs", "mode":"rust", "version":3,
  "cursor":{"line":5,"col":0},
  "lines":["use crate::agent::Agent;","","fn main() {"] }

// incremental edit (line/col ranges, 0-based). from = version this applies to
{ "t":"patch", "id":"b1", "from":3, "version":4,
  "edits":[ {"range":[[5,4],[5,4]], "text":"/* by agent */ "} ] }

// cursor / point move without a content change
{ "t":"cursor", "id":"b1", "cursor":{"line":5,"col":19}, "version":4 }

// window layout — which buffer shows where. weight = flex share
{ "t":"windows", "focus":"w1",
  "layout":[ {"id":"w1","buffer":"b1","weight":1.6}, {"id":"w2","buffer":"b2","weight":1} ] }

// agent activity — first-class, not just text in a buffer
{ "t":"agent", "id":"a1", "buffer":"b2", "state":"streaming", "chunk":"…tokens…" }
{ "t":"agent", "id":"a1", "buffer":"b2", "state":"idle", "text":"…final…" }

// the echo area / prompt line
{ "t":"minibuffer", "prompt":"M-x ", "text":"save-buf" }
{ "t":"echo", "text":"Saved main.rs" }
```

Optional later: `mode`-specific syntax spans (`{"t":"spans","id":"b1","spans":[...]}`)
so highlighting is tree-sitter-accurate rather than the renderer's toy guess.

## Renderer → daemon

```jsonc
// mode picks the flavor: "structured" (this doc) or "vt" (raw ANSI → xterm)
{ "t":"hello", "client":"naklios-render", "proto":1, "mode":"structured" }

// a keystroke aimed at a window. mods: "C"=ctrl "M"=alt/meta "S"=super/cmd
{ "t":"key", "window":"w1", "key":"a", "mods":[] }
{ "t":"key", "window":"w1", "key":"s", "mods":["C","M"] }   // e.g. C-M-s

// a named command (M-x). the daemon decides what it means
{ "t":"command", "name":"save-buffer", "args":[] }

// viewport size of a window in the renderer, so the daemon can reflow if it wants
{ "t":"resize", "window":"w1", "cols":92, "rows":40 }

// subscribe / focus intent
{ "t":"subscribe", "buffers":["b1","b2"] }
{ "t":"focus", "window":"w2" }

// the renderer detected a version gap (missed a message) → resend the whole buffer
{ "t":"resync", "id":"b1" }
```

In the **vt** flavor the client sends `{ "t":"input", "bytes":"…" }` (VT-encoded
keystrokes from xterm) and the daemon replies with a raw ANSI byte stream in
each frame — none of the structured messages above apply.

## Why this shape

- **Buffers + agents are peers.** `agent` is its own message type bound to a
  buffer — matching aimax's "agents are first-class, they read/write/watch
  buffers." A renderer can show agent activity distinctly (a strip, a gutter),
  not as anonymous text.
- **Keystrokes go to the daemon.** The daemon owns keymaps, Scheme bindings, and
  the M-x table; the renderer stays dumb. Same editor, many frontends.
- **Patches, not repaints.** Line/col edits keep a multi-MB buffer cheap to
  stream and let the renderer animate agent edits.

## Open questions for the daemon side

1. Does aimax already have a machine-readable frontend protocol over its IPC
   socket, or only a human VT TUI? If the latter, is a structured mode feasible,
   or should we render raw VT (xterm.js) for v0 and add structure later?
2. Unix socket vs a TCP/WS listener — see README "the transport wall."
3. Who owns syntax highlighting — daemon (tree-sitter spans) or renderer (toy)?
4. Multiplexing: one socket per frontend, or a broker so the TUI and a naklios
   renderer attach to the same session at once?
