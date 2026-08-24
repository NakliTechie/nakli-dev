// C5 Layer-2 conformance — the readline line editor between xterm and the shell.
//
//   node sys/rig/cli/test/lineeditor.test.mjs
//
// Feeds xterm-style keystroke strings and checks the logical state (buffer,
// cursor, history, submit/interrupt/clear events). xterm is not involved.

import { createLineEditor } from '../lineeditor.mjs';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const type = (ed, s) => { for (const ch of s) ed.feed(ch); };

test('typing builds the buffer and Enter submits + records history', () => {
  const ed = createLineEditor();
  type(ed, 'ls -R');
  eq(ed.line, 'ls -R', 'buffer');
  const r = ed.feed('\r');
  eq(r.submit, 'ls -R', 'submit on Enter');
  eq(ed.line, '', 'buffer cleared after submit');
  eq(ed.history.length, 1, 'history recorded');
});

test('backspace deletes before the cursor', () => {
  const ed = createLineEditor();
  type(ed, 'cat');
  ed.feed('\x7f');
  eq(ed.line, 'ca', 'backspace');
  ed.feed('\x7f'); ed.feed('\x7f'); ed.feed('\x7f'); // over-delete is safe
  eq(ed.line, '', 'empty after over-delete');
});

test('history up/down recalls previous lines and restores the draft', () => {
  const ed = createLineEditor();
  type(ed, 'pwd'); ed.feed('\r');
  type(ed, 'ls'); ed.feed('\r');
  type(ed, 'gre');          // in-progress draft
  ed.feed('\x1b[A');         // up → 'ls'
  eq(ed.line, 'ls', 'up recalls most recent');
  ed.feed('\x1b[A');         // up → 'pwd'
  eq(ed.line, 'pwd', 'up again recalls older');
  ed.feed('\x1b[B');         // down → 'ls'
  eq(ed.line, 'ls', 'down newer');
  ed.feed('\x1b[B');         // down → back to the draft
  eq(ed.line, 'gre', 'down restores the in-progress draft');
});

test('left arrow + insert edits mid-line', () => {
  const ed = createLineEditor();
  type(ed, 'ls');
  ed.feed('\x1b[D');         // left, cursor between l and s
  eq(ed.cursor, 1, 'cursor moved left');
  type(ed, 'X');
  eq(ed.line, 'lXs', 'inserted at cursor');
  eq(ed.cursor, 2, 'cursor advanced past insert');
});

test('Ctrl-C cancels the line and signals interrupt', () => {
  const ed = createLineEditor();
  type(ed, 'rm -rf /');
  const r = ed.feed('\x03');
  assert(r.interrupt, 'interrupt flagged');
  eq(ed.line, '', 'line cancelled');
  assert(r.output.includes('^C'), 'echoes ^C');
});

test('Ctrl-L signals a clear', () => {
  const ed = createLineEditor();
  type(ed, 'echo hi');
  const r = ed.feed('\x0c');
  assert(r.clear, 'clear flagged');
  eq(ed.line, 'echo hi', 'buffer preserved across clear');
});

test('Tab completes a unique match, and lists on ambiguity', () => {
  const commands = ['status', 'stash', 'commit'];
  const ed = createLineEditor({ complete: (buf) => commands.filter((c) => c.startsWith(buf)) });
  type(ed, 'co');
  ed.feed('\t');
  eq(ed.line, 'commit', 'unique completion fills in');

  const ed2 = createLineEditor({ complete: (buf) => commands.filter((c) => c.startsWith(buf)) });
  type(ed2, 'st');
  ed2.feed('\t');                       // first Tab: fill the common prefix
  eq(ed2.line, 'sta', 'ambiguous completes to the common prefix');
  const r = ed2.feed('\t');             // second Tab (no advance): list candidates
  assert(r.output.includes('status') && r.output.includes('stash'), 'lists candidates');
});

test('a submitted paste with a trailing newline submits once', () => {
  const ed = createLineEditor();
  const r = ed.feed('ls\r\n');
  eq(r.submit, 'ls', 'single submit for \\r\\n');
  eq(ed.line, '', 'cleared');
});

if (failures.length) {
  console.error(`line editor: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`C5-L2/lineeditor conformance: ${passed}/${passed} passed`);
