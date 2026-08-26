// Conformance — per-project memory & skills assembly (pure).
//
//   node sys/ai/test/project-context.test.mjs

import { buildProjectContext, appendMemory, countMemory, rememberTool }
  from '../project-context.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

await test('buildProjectContext: empty when neither file present', () => {
  eq(buildProjectContext({}), '', 'both absent');
  eq(buildProjectContext({ agents: '', memory: '   ' }), '', 'both blank');
  eq(buildProjectContext({ agents: null, memory: null }), '', 'both null');
});

await test('buildProjectContext: injects both files, labelled', () => {
  const out = buildProjectContext({ agents: 'Use tabs.', memory: '- prefer x' });
  assert(out.includes('AGENTS.md'), 'labels AGENTS.md');
  assert(out.includes('Use tabs.'), 'includes agents content');
  assert(out.includes('memory.md'), 'labels memory.md');
  assert(out.includes('- prefer x'), 'includes memory content');
  assert(out.includes('# Project context'), 'has the framing header');
});

await test('buildProjectContext: one present, one absent', () => {
  const a = buildProjectContext({ agents: 'Only agents.' });
  assert(a.includes('Only agents.') && !a.includes('memory.md'), 'agents only');
  const m = buildProjectContext({ memory: 'Only memory.' });
  assert(m.includes('Only memory.') && !m.includes('AGENTS.md'), 'memory only');
});

await test('buildProjectContext: respects the cap', () => {
  const big = 'x'.repeat(20000);
  const out = buildProjectContext({ agents: big, cap: 100 });
  assert(out.includes('…(truncated)'), 'marks truncation');
  assert(out.length < 1000, `capped small: ${out.length}`);
});

await test('appendMemory: creates body on missing/empty', () => {
  const first = appendMemory(null, 'the API lives in api/');
  assert(first.startsWith('# Project memory'), 'creates header');
  assert(first.includes('- the API lives in api/'), 'adds the bullet');
  eq(countMemory(first), 1, 'one note');
  const fromEmpty = appendMemory('   ', 'note');
  assert(fromEmpty.startsWith('# Project memory'), 'treats blank as empty');
});

await test('appendMemory: second call appends, never clobbers', () => {
  const one = appendMemory(null, 'first');
  const two = appendMemory(one, 'second');
  assert(two.includes('- first'), 'keeps first');
  assert(two.includes('- second'), 'adds second');
  eq(countMemory(two), 2, 'two notes');
  // exactly one header
  eq((two.match(/# Project memory/g) || []).length, 1, 'single header');
});

await test('appendMemory: blank note is a no-op', () => {
  const body = appendMemory(null, 'real');
  eq(appendMemory(body, '   '), body, 'blank leaves content unchanged');
  eq(appendMemory(null, ''), '', 'blank on empty stays empty');
});

await test('appendMemory: flattens multi-line notes to one bullet', () => {
  const out = appendMemory(null, 'line one\nline two');
  eq(countMemory(out), 1, 'still one bullet');
  assert(out.includes('- line one line two'), 'newlines flattened');
});

await test('rememberTool: well-formed OpenAI tool schema', () => {
  const t = rememberTool();
  eq(t.type, 'function', 'type');
  eq(t.function.name, 'remember', 'name');
  assert(t.function.parameters.properties.note, 'has note param');
  assert(t.function.parameters.required.includes('note'), 'note required');
});

if (failures.length) {
  console.error(`project-context: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`project-context conformance: ${passed}/${passed} passed`);
