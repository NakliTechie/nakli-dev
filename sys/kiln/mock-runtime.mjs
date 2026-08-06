// MockRuntime — a headless test seam standing in for real Pyodide, matching the
// runtime contract createKernelCore expects. It simulates only what the K0
// checkpoint exercises: a persistent namespace, output, a structured traceback,
// an interruptible loop, and output-cap truncation. It is NOT a Python
// interpreter and is never shipped — the real behaviour is pyodide-runtime.mjs.
//
// Recognised test directives (one per line):
//   NAME = VALUE        assign (persists across runCode calls)
//   print(NAME)         emit the bound value's repr, or a NameError line
//   raise Err(msg)      produce a structured traceback (stops the cell)
//   LOOP                block until interrupt() is called (a runaway loop)
//   BIGOUTPUT n         emit n bytes of stdout (for the output cap)
//   THROW               throw a JS error (to prove the core never leaks it)

export class MockRuntime {
  constructor() {
    this.ns = new Map(); // name -> { type, repr }
    this._interrupt = false;
  }

  interrupt() { this._interrupt = true; }

  listNames() { return [...this.ns.keys()]; }

  inspect(name) {
    const e = this.ns.get(name);
    return e ? { type: e.type, repr: e.repr } : null;
  }

  reset({ keepMounts } = {}) { this.ns.clear(); this._interrupt = false; }

  async runCode(code, { outputCapBytes } = {}) {
    this._interrupt = false;
    const src = String(code);

    if (src.trim() === 'LOOP') {
      return await new Promise((resolve) => {
        const check = () => {
          if (this._interrupt) {
            this._interrupt = false;
            resolve({ stdout: '', stderr: '', result: null, traceback: null, interrupted: true, truncated: false });
          } else {
            setTimeout(check, 3);
          }
        };
        check();
      });
    }
    if (src.trim() === 'THROW') throw new Error('mock runtime blew up');

    let stdout = '';
    let traceback = null;
    let result = null;
    for (const rawLine of src.split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;
      const rz = /^raise\s+(\w+)\((.*)\)$/.exec(line);
      const asg = /^(\w+)\s*=\s*(.+)$/.exec(line);
      const pr = /^print\((\w+)\)$/.exec(line);
      const big = /^BIGOUTPUT\s+(\d+)$/.exec(line);
      if (rz) {
        const msg = rz[2].replace(/^['"]|['"]$/g, '');
        traceback = `Traceback (most recent call last):\n  File "<cell>", line 1\n${rz[1]}: ${msg}`;
        break;
      } else if (asg) {
        const v = asg[2].trim();
        this.ns.set(asg[1], { type: /^\d+$/.test(v) ? 'int' : 'str', repr: v });
        result = v;
      } else if (pr) {
        const e = this.ns.get(pr[1]);
        stdout += (e ? e.repr : `NameError: name '${pr[1]}' is not defined`) + '\n';
      } else if (big) {
        stdout += 'x'.repeat(Number(big[1]));
      }
      // other lines: no-op
    }

    let truncated = false;
    if (outputCapBytes && stdout.length > outputCapBytes) {
      stdout = stdout.slice(0, outputCapBytes);
      truncated = true;
    }
    return { stdout, stderr: '', result, traceback, interrupted: false, truncated };
  }
}
