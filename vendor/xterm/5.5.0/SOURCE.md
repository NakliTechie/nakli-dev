# xterm.js — vendored for the Forge terminal

MIT License © The xterm.js authors (https://github.com/xtermjs/xterm.js).

Vendored self-contained ESM bundles (no external imports), fetched from jsDelivr:
- `xterm.mjs`   — @xterm/xterm@5.5.0/+esm            (exports `Terminal`)
- `addon-fit.mjs` — @xterm/addon-fit@0.10.0/+esm     (exports `FitAddon`)
- `xterm.css`   — @xterm/xterm@5.5.0/css/xterm.css

Imported by relative path from `apps/forge/`, like `vendor/isomorphic-git/`.
No CDN at runtime; the strict single-file/no-network ethos holds.
