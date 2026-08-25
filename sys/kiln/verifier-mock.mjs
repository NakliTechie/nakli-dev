// MockVerifierRuntime — the headless stand-in for a fresh real-Pyodide
// interpreter, matching the runtime contract createVerifier expects. It models
// only what the K3 security property needs to be provable without a browser:
// a per-instance namespace, a read-only mount, an exit code, and a monkey-patch
// that lives ONLY in the namespace where it was applied.
//
// It is NOT Python and is never shipped — the real behaviour is a fresh Pyodide
// kernel running the operator's command (pytest, `python -m`, a shell check).
//
// A "verification command" is newline directives:
//   CHECK <path>        exit 0 if mount[path] contains "PASS", else exit 1
//                       (models a test that inspects the run tree)
//   WRITE <path> <text> write to the mount — REFUSED (exit 1) under mountReadOnly
//   PATCH_ASSERT        set a namespace flag that makes every later CHECK pass
//                       (models the agent redefining assert / sys.exit so its own
//                        runs always "succeed"). Namespace-local by construction:
//                        a fresh runtime never carries it, which is the whole point.
//   ECHO <text>         append <text> to stdout (a no-op probe)
//
// The exit code is the last failing directive's, or 0 if none failed — the same
// "any check fails → non-zero" shape a real test command has.

export class MockVerifierRuntime {
  constructor() {
    this.ns = new Map();      // per-instance: the agent's patches never reach a fresh one
    this.mount = {};
    this.readOnly = false;
  }

  mountReadOnly(mount) {
    this.mount = { ...(mount || {}) };
    this.readOnly = true;
  }

  async runCommand(command) {
    let stdout = '';
    let stderr = '';
    let exit = 0;
    for (const raw of String(command).split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;
      let m;
      if (line === 'PATCH_ASSERT') {
        this.ns.set('_assert_patched', true);
      } else if ((m = /^CHECK\s+(\S+)$/.exec(line))) {
        const patched = this.ns.get('_assert_patched') === true;
        const content = this.mount[m[1]];
        if (patched) {
          exit = 0;
          stdout += `CHECK ${m[1]}: pass (assert patched)\n`;
        } else if (typeof content === 'string' && content.includes('PASS')) {
          exit = 0;
          stdout += `CHECK ${m[1]}: pass\n`;
        } else {
          exit = 1;
          stderr += `CHECK ${m[1]}: FAIL\n`;
        }
      } else if ((m = /^WRITE\s+(\S+)\s+(.*)$/.exec(line))) {
        if (this.readOnly) {
          exit = 1;
          stderr += `WRITE ${m[1]}: refused (read-only mount)\n`;
        } else {
          this.mount[m[1]] = m[2];
        }
      } else if ((m = /^ECHO\s+(.*)$/.exec(line))) {
        stdout += m[1] + '\n';
      }
      // unknown directive: no-op (a real runtime would ignore blank/comment too)
    }
    return { exit, stdout, stderr };
  }

  dispose() { this.ns.clear(); }
}
