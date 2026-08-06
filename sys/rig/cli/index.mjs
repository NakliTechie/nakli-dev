// Rig faux CLI (C4b) — public entry. Headless core: parser + repl + scrollback.
// The xterm.js chrome (browser) wires term.onData → repl.feed → term.write and
// vendors addon-serialize for scrollback; it is not the system under test.
export { compile, tokenize, resolveCommandName } from './parser.mjs';
export { createRepl } from './repl.mjs';
export { createScrollback, redactLine } from './scrollback.mjs';
