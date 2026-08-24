// C5 Layer-2 conformance — Tab completion (command names + cached paths).
//
//   node sys/rig/cli/test/completer.test.mjs

import { createCompleter } from '../completer.mjs';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); }
}
function same(a, b, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg || 'not equal'}: ${x} !== ${y}`);
}

const commands = ['ls', 'cat', 'cd', 'clear', 'git', 'grep'];
const tree = { '': ['a.txt', 'b.txt', 'src'], src: ['main.js', 'util.js'] };
const complete = createCompleter({ commands, listPath: (d) => tree[d] || [] });

test('first word completes command names, sorted', () => {
  same(complete('c'), ['cat', 'cd', 'clear'], 'c*');
  same(complete('gi'), ['git'], 'gi*');
  same(complete('z'), [], 'no match');
});

test('argument position completes cwd paths', () => {
  same(complete('cat a'), ['cat a.txt'], 'single path');
  same(complete('cat '), ['cat a.txt', 'cat b.txt', 'cat src'], 'all entries');
});

test('nested path completes under the token directory', () => {
  same(complete('cat src/m'), ['cat src/main.js'], 'nested');
  same(complete('cat src/'), ['cat src/main.js', 'cat src/util.js'], 'dir contents');
});

test('preserves text after the cursor', () => {
  same(complete('cat a.txt', 5), ['cat a.txt.txt'], 'completes token at cursor, keeps tail');
});

test('empty buffer offers all commands', () => {
  same(complete(''), ['cat', 'cd', 'clear', 'git', 'grep', 'ls'], 'all commands sorted');
});

if (failures.length) {
  console.error(`completer: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`C5-L2/completer conformance: ${passed}/${passed} passed`);
