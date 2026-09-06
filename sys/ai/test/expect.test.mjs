// Conformance — predict-then-grade for a shell call (D3).
//   node sys/ai/test/expect.test.mjs
import { parseExpect, gradeExpect, expectLine, stripExpect, EXPECT_KINDS, EXPECT_MARKER } from '../expect.mjs';
let passed = 0; const failures = [];
function test(n, fn) { try { fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

test('parseExpect: the three forms; malformed → null', () => {
  eq(JSON.stringify(parseExpect('exit 0')), JSON.stringify({ kind: 'exit', value: 0 }), 'exit');
  eq(parseExpect('exit 1').value, 1, 'exit 1'); eq(parseExpect('exit -5').value, -5, 'negative exit');
  eq(JSON.stringify(parseExpect('contains hello world')), JSON.stringify({ kind: 'contains', value: 'hello world' }), 'contains keeps the rest');
  eq(parseExpect('ABSENT Error').kind, 'absent', 'kind lowercased');
  eq(parseExpect(''), null, 'empty → null'); eq(parseExpect('exit'), null, 'no value → null'); eq(parseExpect('exit abc'), null, 'non-int exit → null');
  eq(parseExpect('contains'), null, 'contains needs a value'); eq(parseExpect('bogus x'), null, 'unknown kind → null');
  eq(EXPECT_KINDS.length, 3, 'three kinds');
});

test('gradeExpect exit: hit and miss', () => {
  assert(gradeExpect({ kind: 'exit', value: 0 }, { exitCode: 0 }).ok, 'exit 0 hit');
  const m = gradeExpect({ kind: 'exit', value: 0 }, { exitCode: 1 }); assert(!m.ok && /expected exit 0, got 1/.test(m.why), m.why);
  assert(!gradeExpect({ kind: 'exit', value: 0 }, { exitCode: null }).ok, 'unknown exit is a miss');
});

test('gradeExpect contains / absent: hit and miss', () => {
  assert(gradeExpect({ kind: 'contains', value: 'PASS' }, { output: 'all PASS' }).ok, 'contains hit');
  assert(!gradeExpect({ kind: 'contains', value: 'PASS' }, { output: 'all FAIL' }).ok, 'contains miss');
  assert(gradeExpect({ kind: 'absent', value: 'Error' }, { output: 'clean run' }).ok, 'absent hit');
  const am = gradeExpect({ kind: 'absent', value: 'Error' }, { output: 'Error: boom' }); assert(!am.ok && /appeared/.test(am.why), am.why);
  assert(gradeExpect(null, {}).ok, 'no expectation is always ok');
});

test('expectLine + stripExpect round-trip: a fold recovers the real output, never grading its own message', () => {
  const exp = { kind: 'absent', value: 'Error' };
  const graded = 'clean output' + expectLine(exp, gradeExpect(exp, { output: 'clean output' }));
  assert(graded.includes('[expect] MET'), 'the line is appended'); eq(stripExpect(graded), 'clean output', 'stripExpect recovers the output');
  // the contamination case: an absent-miss line names the very string it checks — stripExpect must remove it
  const miss = 'boom' + expectLine({ kind: 'absent', value: 'Error' }, gradeExpect({ kind: 'absent', value: 'Error' }, { output: 'boom Error' }));
  assert(/Error/.test(miss), 'the miss message mentions Error'); eq(stripExpect(miss), 'boom', 'stripped output does not carry the message');
  assert(EXPECT_MARKER.startsWith('\n'), 'the marker is newline-anchored');
});

if (failures.length) { console.error(`expect: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`expect conformance: ${passed}/${passed} passed — grammar (3 forms + malformed), grade hit/miss per form, strip round-trip`);
