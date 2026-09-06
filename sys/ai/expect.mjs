// Predict-then-grade for a shell call (D3; khiladi's expect, NOOA's retrodiction). The agent
// states what it EXPECTS before running a command; the result is graded against it, and a MISS
// is a small, honest failure signal on the run record. Pure and OPTIONAL — a shell call with no
// `expect` behaves exactly as before.
//
// A three-token grammar, "<kind> <value>":
//   exit <n>        the command must exit with code n
//   contains <str>  the combined stdout/stderr must contain str
//   absent <str>    the output must NOT contain str (e.g. "absent Error")
export const EXPECT_KINDS = Object.freeze(['exit', 'contains', 'absent']);

export function parseExpect(str) {
  const s = String(str == null ? '' : str).trim();
  if (!s) return null;
  const sp = s.indexOf(' ');
  const kind = (sp < 0 ? s : s.slice(0, sp)).toLowerCase();
  const value = sp < 0 ? '' : s.slice(sp + 1).trim();
  if (!EXPECT_KINDS.includes(kind)) return null;
  if (kind === 'exit') { if (value === '') return null; const n = Number(value); return Number.isInteger(n) ? { kind, value: n } : null; }
  return value ? { kind, value } : null;
}

export function gradeExpect(exp, { exitCode = null, output = '' } = {}) {
  if (!exp) return { ok: true, why: 'no expectation' };
  const out = String(output == null ? '' : output);
  if (exp.kind === 'exit') {
    const ok = exitCode != null && Number(exitCode) === exp.value;
    return { ok, why: ok ? `exit ${exitCode} as expected` : `expected exit ${exp.value}, got ${exitCode == null ? 'unknown' : exitCode}` };
  }
  if (exp.kind === 'contains') {
    const ok = out.includes(exp.value);
    return { ok, why: ok ? `output contains "${exp.value}"` : `expected output to contain "${exp.value}" — it did not` };
  }
  // absent
  const ok = !out.includes(exp.value);
  return { ok, why: ok ? `"${exp.value}" absent as expected` : `expected "${exp.value}" to be absent — it appeared` };
}

// The line appended to a graded shell result (the agent's immediate feedback). A fixed marker
// so a post-hoc fold can split it off and never grade against its own message.
export const EXPECT_MARKER = '\n[expect] ';
export function expectLine(exp, grade) {
  return `${EXPECT_MARKER}${grade.ok ? 'MET' : 'MISS'} (${exp.kind} ${exp.value}) — ${grade.why}`;
}
// Recover the command's real output from a graded result — everything before the marker.
export function stripExpect(result) {
  const s = String(result == null ? '' : result);
  const i = s.indexOf(EXPECT_MARKER);
  return i < 0 ? s : s.slice(0, i);
}
