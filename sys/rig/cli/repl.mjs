// repl — the C4b line processor. Headless-drivable: feed(line) → { output }.
// term.onData → (line editor) → feed → term.write is the only xterm coupling;
// this module is the system under test, xterm is not.
//
// Destructive commands route through the C4 agent face: invoke returns a staged
// proposal, the repl prints it and waits for an explicit `y`, and only then
// calls accept. `/help` renders registry metadata (no hand-written help text).

import { compile } from './parser.mjs';

// eslint-disable-next-line no-control-regex
const BINARY_BYTES = new RegExp("[\u0000-\u0008\u000e-\u001f]");

function renderHelpAll(registry) {
  return registry.list()
    .map((c) => `/${c.name}  —  ${c.summary}`)
    .join('\n');
}

function renderHelpOne(registry, target) {
  const c = registry.describeCommand(target);
  if (!c) return `no such command: ${target}`;
  const params = Object.entries((c.inputSchema && c.inputSchema.properties) || {})
    .map(([k, v]) => {
      const req = (c.inputSchema.required || []).includes(k) ? '' : '?';
      return `${k}${req}:${v.type || 'any'}`;
    })
    .join(' ');
  return [
    `/${c.name}  (${c.scope}${c.destructive ? ', destructive' : ''})`,
    c.description,
    params ? `args: ${params}` : 'args: none',
  ].join('\n');
}

function formatResult(name, res) {
  if (res.entries) return res.entries.map((e) => `${e.type === 'dir' ? 'd' : '-'} ${e.path}`).join('\n') || '(empty)';
  if (res.matches && res.matches.length && typeof res.matches[0] === 'object') {
    return res.matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
  }
  if (res.matches) return res.matches.join('\n') || '(no matches)';
  if (typeof res.data === 'string') return res.data;
  if (res.data && res.data.byteLength != null) {
    // A terminal renders text; decode UTF-8, fall back to a byte count for
    // genuinely binary content (NUL / control bytes).
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(res.data);
      if (!BINARY_BYTES.test(text)) return text;
    } catch (_) { /* not valid UTF-8 */ }
    return `<${res.data.byteLength} bytes>`;
  }
  if (res.stat) return `${res.stat.type} ${res.stat.size}b`;
  if (res.oid) return res.oid;
  if (res.commits) return res.commits.map((c) => `${c.oid.slice(0, 7)} ${c.commit.message.split('\n')[0]}`).join('\n');
  if (res.branches) return res.branches.join('\n');
  if (res.changes) return res.changes.map((c) => `${c.status[0].toUpperCase()} ${c.path}`).join('\n') || '(no changes)';
  return 'ok';
}

export function createRepl({ registry, face }) {
  let pending = null; // { proposalId, name }

  async function feed(line) {
    const out = [];
    const write = (s) => { if (s != null && s !== '') out.push(String(s)); };

    if (pending) {
      const ans = String(line == null ? '' : line).trim().toLowerCase();
      const p = pending;
      pending = null;
      if (ans === 'y' || ans === 'yes') {
        const r = await face.accept(p.proposalId);
        write(r.ok ? `done: ${p.name}` : `error ${r.code}: ${r.message}`);
      } else {
        face.reject(p.proposalId);
        write(`cancelled: ${p.name}`);
      }
      return { output: out };
    }

    const c = compile(line, registry);
    switch (c.kind) {
      case 'empty': return { output: out };
      case 'error': write(c.message); return { output: out };
      case 'help': write(c.target ? renderHelpOne(registry, c.target) : renderHelpAll(registry)); return { output: out };
      case 'py': write('the Python kernel (Kiln) is not available in this build'); return { output: out };
      case 'unknown':
        write(`unknown command: /${c.verb}`);
        if (c.suggestions.length) write(`did you mean: ${c.suggestions.join(', ')}`);
        return { output: out };
      case 'command': {
        const res = await face.invoke(c.name, c.input);
        if (res.staged) {
          pending = { proposalId: res.proposalId, name: c.name };
          write(`${c.name} is destructive: ${JSON.stringify(c.input)}`);
          write('confirm? [y/N]');
          return { output: out, awaitingConfirm: res.proposalId };
        }
        if (res.ok) write(formatResult(c.name, res));
        else {
          write(`error ${res.code}: ${res.message}`);
          if (res.suggestions && res.suggestions.length) write(`did you mean: ${res.suggestions.join(', ')}`);
        }
        return { output: out };
      }
      default: return { output: out };
    }
  }

  return { feed, get awaitingConfirm() { return pending ? pending.proposalId : null; } };
}
