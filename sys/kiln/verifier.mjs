// verifier.mjs — Kiln K3, the verifier kernel.
//
// Produces a trustworthy verdict on whether a run meets its operator-authored
// verification. The load-bearing property (RIG-VISION §7): the working agent
// cannot launder its own verdict. Three walls enforce it:
//
//   1. FRESH namespace per verification. `verify()` builds a brand-new runtime
//      via the injected factory — never the agent's kernel. Anything the agent
//      monkey-patched in its own namespace (assert, sys.exit, the test runner,
//      the result object) simply does not exist in the verifier's interpreter,
//      so it cannot bend the verdict.
//   2. READ-ONLY mount over the run tree. The verifier reads the artifacts the
//      agent produced; it cannot be tricked into writing state to force a pass.
//   3. IMMUTABLE verificationCommand. Fixed at construction (operator-authored),
//      never taken from the agent at verify-time. The verdict does echo the
//      command back (goals.verifiedBy records it) — that value is operator-
//      authored, not a secret; what the agent must never do is *set* or *swap*
//      it, and it cannot.
//
// The verdict { ok, exit, command, runId } is exactly what C7 `goals.markDone`
// consumes — and only `exit === 0` flips a goal to done. This module is
// runtime-agnostic (same seam as kernel-core): a MockVerifierRuntime in headless
// tests, a fresh real-Pyodide interpreter in the browser harness.
//
// The runtime contract this expects:
//   runCommand(command) -> { exit:int, stdout, stderr }   // never throws for a
//                                                          // failed check; exit says so
//   mountReadOnly(mount)   // optional — install the run tree, refusing writes
//   dispose()              // optional — tear the fresh namespace down

export function createVerifier({ loadRuntime, verificationCommand, mount = {}, now = () => Date.now() }) {
  if (typeof loadRuntime !== 'function') {
    throw new Error('createVerifier requires loadRuntime() — a FRESH-runtime factory, not the agent kernel');
  }
  if (typeof verificationCommand !== 'string' || !verificationCommand.trim()) {
    throw new Error('createVerifier requires a non-empty verificationCommand');
  }
  const command = verificationCommand;          // Wall 3: captured once, immutable.
  const roMount = Object.freeze({ ...mount });  // Wall 2: a frozen read-only snapshot.

  async function verify(opts = {}) {
    // Only runId is honoured from the caller. A command passed here is IGNORED —
    // the verification is fixed at construction, so the agent cannot substitute
    // a friendlier check at verify-time.
    const runId = opts.runId || null;
    const started = now();

    let rt;
    try {
      rt = await loadRuntime();                 // Wall 1: a fresh namespace, every time.
    } catch (e) {
      return verdict({ exit: 1, stderr: `verifier could not start a runtime: ${msg(e)}`, command, runId, started, now });
    }
    if (typeof rt.mountReadOnly === 'function') rt.mountReadOnly(roMount);

    let out;
    try {
      out = await rt.runCommand(command);
    } catch (e) {
      // A thrown runtime is a verifier failure, which is NOT a pass: exit 1.
      return verdict({ exit: 1, stderr: msg(e), command, runId, started, now });
    } finally {
      try { rt.dispose && rt.dispose(); } catch (_) {}
    }

    const exit = normaliseExit(out && out.exit);
    return verdict({
      exit,
      stdout: (out && out.stdout) || '',
      stderr: (out && out.stderr) || '',
      command, runId, started, now,
    });
  }

  return { verify };
}

// Fail CLOSED. A pass requires a genuine integer zero exit. A real integer is
// returned as-is (so a negative or non-1 failure code survives for diagnostics);
// ANYTHING else — undefined, null, NaN, a boolean, a string, a field missing
// because the runtime returned nothing — is a failure (exit 1), NEVER coerced to
// a pass. The verifier's whole job is to fail closed here: an unknown exit is not
// evidence of success, so it must not launder into `done`.
function normaliseExit(exit) {
  if (exit === 0) return 0;
  if (Number.isInteger(exit)) return exit;
  return 1;
}

function verdict({ exit, stdout = '', stderr = '', command, runId, started, now }) {
  return { ok: exit === 0, exit, command, runId, stdout, stderr, ms: now() - started };
}

function msg(e) { return String(e && e.message ? e.message : e); }
