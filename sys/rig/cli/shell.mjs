// shell — a bash-flavoured faux shell over the C1 registry (Forge C5, Layer 1).
//
// The C4b `repl` is a typed command bus with slash syntax (`/ls -R src`). Forge's
// terminal wants a real bash/zsh feel instead: bare `ls`, `cd src`, `cat`,
// `grep`, `git status`, a working directory, flags, globs, pipes, and redirects
// — all still compiling down to the SAME safe Rig registry commands underneath.
//
// This is the headless core, the system under test: `feed(line) -> { output }`.
// xterm is only the screen (attached in Layer 2). No PTY, no arbitrary binaries:
// unknown commands are reported, not spawned. Destructive verbs (rm) route
// through the C4 agent face and stage for a `y` confirm, exactly like the repl.
//
// It is deliberately a CURATED shell — the command set below is everything it
// knows; `sed`/`awk`/`node`/etc. are "command not found" until implemented.

import { tokenize } from './parser.mjs';

// bash verb -> registry command name. The dotted name (fs.list) always works too.
const REGISTRY_ALIAS = {
  ls: 'fs.list', stat: 'fs.stat', mkdir: 'fs.mkdir',
  rm: 'fs.remove', mv: 'fs.move', cp: 'fs.copy',
  glob: 'fs.glob', patch: 'fs.patch',
};

// Short flags -> registry input keys (per command, resolved in buildRegistryInput).
const LIST_FLAGS = { R: 'recursive', a: 'all' };
const RM_FLAGS = { r: 'recursive', R: 'recursive', f: 'force' };

// ── path helpers: cwd lives inside the fileops root; '' is the root, and a
// path can never climb above it. ──
function normalizePath(cwd, arg) {
  const raw = String(arg == null ? '' : arg);
  const abs = raw.startsWith('/');
  const base = abs ? [] : cwd.split('/').filter(Boolean);
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (base.length) base.pop(); continue; }
    base.push(seg);
  }
  return base.join('/');
}

// ── split a line into statements (`;`, `&&`) then pipelines (`|`) then argv,
// pulling trailing redirects (`>`, `>>`) off the last stage. Reuses the
// quote-aware tokenizer so quoted operators stay literal. ──
function parseLine(line) {
  const tokens = tokenizeOps(line);
  const statements = [];
  let stmt = { op: 'first', pipeline: [], redirect: null };
  let stage = [];
  const pushStage = () => { if (stage.length) { stmt.pipeline.push(stage); stage = []; } };
  const pushStmt = () => { pushStage(); if (stmt.pipeline.length) statements.push(stmt); };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === ';' || t === '&&') { pushStmt(); stmt = { op: t, pipeline: [], redirect: null }; }
    else if (t === '|') { pushStage(); }
    else if (t === '>' || t === '>>') { stmt.redirect = { append: t === '>>', path: tokens[++i] }; }
    else stage.push(t);
  }
  pushStmt();
  return statements;
}

// Tokenize while keeping the shell operators as their own tokens. Quotes
// protect operators (so `echo "a|b"` is one token). Builds on `tokenize` by
// pre-splitting unquoted operators with spaces.
function tokenizeOps(line) {
  let out = '';
  let quote = null;
  const s = String(line == null ? '' : line);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { out += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '|' || c === ';') { out += ` ${c} `; continue; }
    if (c === '>') {
      if (s[i + 1] === '>') { out += ' >> '; i++; } else { out += ' > '; }
      continue;
    }
    if (c === '&' && s[i + 1] === '&') { out += ' && '; i++; continue; }
    out += c;
  }
  return tokenize(out);
}

// eslint-disable-next-line no-control-regex
const BINARY_BYTES = new RegExp("[\\u0000-\\u0008\\u000e-\\u001f]");

// Split text into lines the way coreutils do: a single trailing newline is a
// line terminator, not an extra empty line.
const linesOf = (t) => {
  const s = String(t == null ? '' : t);
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
};
// Written files carry a trailing newline (like echo's), so round-trips through
// the fs stay line-clean.
const withTrailingNewline = (t) => (t === '' || t.endsWith('\n') ? t : t + '\n');

function decodeData(data) {
  if (typeof data === 'string') return data;
  if (data && data.byteLength != null) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      if (!BINARY_BYTES.test(text)) return text;
    } catch (_) { /* binary */ }
    return `<${data.byteLength} bytes>`;
  }
  return '';
}

// Render a registry result as terminal text (bash-ish, not the repl's format).
function renderResult(name, res, { long } = {}) {
  if (res.entries) {
    return res.entries
      .map((e) => (long ? `${e.type === 'dir' ? 'd' : '-'} ${e.name}` : e.name))
      .join(long ? '\n' : '  ');
  }
  if (res.matches) return res.matches.map((m) => (typeof m === 'object' ? `${m.path}:${m.line}: ${m.text}` : m)).join('\n');
  if (typeof res.data === 'string' || (res.data && res.data.byteLength != null)) return decodeData(res.data);
  if (res.stat) return `${res.stat.type} ${res.stat.size}`;
  if (res.commits) return res.commits.map((c) => `${c.oid.slice(0, 7)} ${c.commit.message.split('\n')[0]}`).join('\n');
  if (res.branches) return res.branches.join('\n');
  if (res.changes) return res.changes.map((c) => `${c.status[0].toUpperCase()} ${c.path}`).join('\n') || '(clean)';
  if (res.oid) return res.oid;
  return '';
}

// Map an isomorphic-git statusMatrix row [filepath, head, workdir, stage] to a
// short porcelain code. null = unmodified (omit from `git status`).
function statusCode(row) {
  const [f, head, work, stage] = row;
  if (head === 1 && work === 1 && stage === 1) return null; // clean
  if (head === 0 && stage === 0) return `?? ${f}`;           // untracked
  if (head === 0) return `A  ${f}`;                          // staged new
  if (work === 0) return `${stage === 0 ? 'D ' : ' D'} ${f}`; // deleted
  const staged = stage !== 1;                                // differs from HEAD in index
  const dirty = work === 2 && stage === 1;                   // differs from index in tree
  return `${staged ? 'M' : ' '}${dirty ? 'M' : ' '} ${f}`;
}

function renderGit(sub, res) {
  if (sub === 'status') {
    if (res.matrix) return res.matrix.map(statusCode).filter(Boolean).join('\n') || '(clean)';
    if (typeof res.status === 'string') return res.status;
  }
  if (res.commits) return res.commits.map((c) => `${c.oid.slice(0, 7)} ${c.commit.message.split('\n')[0]}`).join('\n');
  if (res.branches) return res.branches.join('\n');
  if (typeof res.diff === 'string') return res.diff;
  if (res.oid) return `[${res.oid.slice(0, 7)}]`;
  return 'ok';
}

export function createShell({ registry, face, cwd = '', kiln = null } = {}) {
  if (!registry || !face) throw new Error('createShell requires { registry, face }');
  const state = { cwd, history: [], vars: new Map([['HOME', '/']]) };

  // $VAR / ${VAR} / $? / $PWD expansion. NOTE: the tokenizer already stripped
  // quotes, so (unlike POSIX) single-quotes don't suppress expansion here — a
  // known simplification tracked under the POSIX-later agenda.
  function expand(token) {
    return String(token).replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$\?/g,
      (m, braced, bare) => {
        if (m === '$?') return String(lastCode);
        const name = braced || bare;
        if (name === 'PWD') return '/' + state.cwd;
        return state.vars.has(name) ? state.vars.get(name) : '';
      },
    );
  }
  let pending = null; // { proposalId, verb }
  let lastCode = 0;

  // Build a registry command input from argv, resolving paths against cwd.
  function buildRegistryInput(cmdName, argv) {
    const command = registry.describeCommand(cmdName);
    const props = (command.inputSchema && command.inputSchema.properties) || {};
    const input = {};
    const positional = [];
    const flagMap = cmdName === 'fs.list' ? LIST_FLAGS : cmdName === 'fs.remove' ? RM_FLAGS : {};
    for (let i = 0; i < argv.length; i++) {
      const t = argv[i];
      if (t.startsWith('--')) {
        const key = t.slice(2);
        const prop = props[key];
        if (prop && prop.type === 'boolean') input[key] = true;
        else input[key] = argv[++i];
      } else if (t.length > 1 && t[0] === '-') {
        for (const ch of t.slice(1)) { const key = flagMap[ch]; if (key && props[key]) input[key] = true; }
      } else positional.push(t);
    }
    // Path-shaped keys resolve against cwd; two-arg commands use from/to.
    if ('from' in props && 'to' in props) {
      input.from = normalizePath(state.cwd, positional[0] || '');
      input.to = normalizePath(state.cwd, positional[1] || '');
    } else if ('path' in props) {
      input.path = positional.length ? normalizePath(state.cwd, positional[0]) : state.cwd;
    } else if ('pattern' in props) {
      input.pattern = positional[0] || '';
      if (positional[1]) input.cwd = normalizePath(state.cwd, positional[1]);
      else input.cwd = state.cwd;
    }
    if (props.encoding && !('encoding' in input)) input.encoding = 'utf-8';
    return input;
  }

  async function runRegistry(cmdName, argv, stdin) {
    const long = cmdName === 'fs.list' && argv.includes('-l');
    const input = buildRegistryInput(cmdName, argv);
    const res = await face.invoke(cmdName, input);
    if (res.staged) return { staged: res.proposalId, verb: cmdName };
    if (!res.ok) return { text: `${cmdName}: ${res.code || 'error'}: ${res.message || 'failed'}`, code: 1 };
    return { text: renderResult(cmdName, res, { long }), code: 0 };
  }

  // ── builtins: shell-native, may consume/produce piped text ──
  const builtins = {
    cd(argv) {
      const target = normalizePath(state.cwd, argv[0] || '');
      state.cwd = target;
      return { text: '', code: 0 };
    },
    pwd() { return { text: '/' + state.cwd, code: 0 }; },
    echo(argv) { return { text: argv.join(' '), code: 0 }; },
    clear() { return { text: '', code: 0, clear: true }; },
    history() { return { text: state.history.map((h, i) => `${i + 1}  ${h}`).join('\n'), code: 0 }; },
    which(argv) {
      const v = argv[0];
      const known = builtins[v] || REGISTRY_ALIAS[v] || registry.describeCommand(v) || (v === 'git' || v === 'python');
      return { text: known ? v : `${v} not found`, code: known ? 0 : 1 };
    },
    async cat(argv, stdin) {
      if (!argv.length) return { text: stdin || '', code: 0 };
      const parts = [];
      for (const a of argv) {
        const res = await face.invoke('fs.read', { path: normalizePath(state.cwd, a), encoding: 'utf-8' });
        if (res.ok) parts.push(decodeData(res.data));
        else return { text: `cat: ${a}: ${res.code || 'error'}`, code: 1 };
      }
      return { text: parts.join(''), code: 0 };
    },
    async grep(argv, stdin) {
      const flags = argv.filter((a) => a.startsWith('-'));
      const rest = argv.filter((a) => !a.startsWith('-'));
      const pattern = rest[0] || '';
      const files = rest.slice(1);
      const nline = flags.some((f) => f.includes('n'));
      const re = new RegExp(pattern);
      const filter = (text, prefix) => linesOf(text)
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => re.test(l))
        .map(({ l, i }) => `${prefix ? prefix + ':' : ''}${nline ? (i + 1) + ':' : ''}${l}`);
      if (files.length) {
        const hits = [];
        for (const f of files) {
          const res = await face.invoke('fs.read', { path: normalizePath(state.cwd, f), encoding: 'utf-8' });
          if (res.ok) hits.push(...filter(decodeData(res.data), files.length > 1 ? f : ''));
        }
        return { text: hits.join('\n'), code: hits.length ? 0 : 1 };
      }
      const hits = filter(stdin || '', '');
      return { text: hits.join('\n'), code: hits.length ? 0 : 1 };
    },
    head(argv, stdin) {
      const n = flagNum(argv, 10);
      return { text: linesOf(stdin).slice(0, n).join('\n'), code: 0 };
    },
    tail(argv, stdin) {
      const n = flagNum(argv, 10);
      const lines = linesOf(stdin);
      return { text: lines.slice(Math.max(0, lines.length - n)).join('\n'), code: 0 };
    },
    wc(argv, stdin) {
      const text = stdin || '';
      const lines = (text.match(/\n/g) || []).length;   // newlines, like coreutils
      const words = text.split(/\s+/).filter(Boolean).length;
      return { text: `${lines} ${words} ${text.length}`, code: 0 };
    },
    sort(argv, stdin) { return { text: linesOf(stdin).sort().join('\n'), code: 0 }; },
    uniq(argv, stdin) {
      const out = [];
      let prev;
      for (const l of linesOf(stdin)) { if (l !== prev) out.push(l); prev = l; }
      return { text: out.join('\n'), code: 0 };
    },
    async touch(argv) {
      const path = normalizePath(state.cwd, argv[0] || '');
      const exists = await face.invoke('fs.stat', { path });
      if (exists.ok) return { text: '', code: 0 };
      const res = await face.invoke('fs.write', { path, data: '', createParents: true });
      return { text: res.ok ? '' : `touch: ${res.message || 'failed'}`, code: res.ok ? 0 : 1 };
    },
    env() {
      const lines = [...state.vars.entries()].sort().map(([k, v]) => `${k}=${v}`);
      lines.push(`PWD=/${state.cwd}`);
      return { text: lines.join('\n'), code: 0 };
    },
    export(args) {
      for (const a of args) {
        const eq = a.indexOf('=');
        if (eq > 0) state.vars.set(a.slice(0, eq), a.slice(eq + 1));
      }
      return { text: '', code: 0 };
    },
    unset(args) { for (const a of args) state.vars.delete(a); return { text: '', code: 0 }; },
    help() {
      const cmds = ['cd', 'pwd', 'ls', 'cat', 'echo', 'grep', 'find', 'head', 'tail', 'wc',
        'sort', 'uniq', 'touch', 'mkdir', 'rm', 'mv', 'cp', 'stat', 'git', 'python',
        'env', 'export', 'unset', 'clear', 'history', 'which'];
      return { text: 'commands: ' + cmds.join(' ') + '\nvars: NAME=value, $NAME, ${NAME}, $?, $PWD', code: 0 };
    },
  };

  function flagNum(argv, dflt) {
    const i = argv.findIndex((a) => a === '-n');
    if (i >= 0 && argv[i + 1]) return Number(argv[i + 1]) || dflt;
    const m = argv.find((a) => /^-\d+$/.test(a));
    return m ? Number(m.slice(1)) : dflt;
  }

  const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

  // Bash-style filename globbing: a token with * or ? expands to matching paths
  // (cwd-relative; the glob command returns root-relative, so strip the cwd
  // prefix). No match → the literal token is kept (nullglob off). Flags (-x) and
  // env-looking tokens are left alone.
  async function expandGlobs(tokens) {
    const out = [];
    const prefix = state.cwd ? state.cwd + '/' : '';
    for (const t of tokens) {
      if (/[*?]/.test(t) && !t.startsWith('-')) {
        const res = await face.invoke('fs.glob', { pattern: t, cwd: state.cwd });
        if (res.ok && res.matches.length) {
          out.push(...res.matches.map((m) => (m.startsWith(prefix) ? m.slice(prefix.length) : m)).sort());
          continue;
        }
      }
      out.push(t);
    }
    return out;
  }

  async function runStage(rawArgv, stdin) {
    // Leading NAME=value tokens set shell variables; if nothing follows, the
    // stage is a pure assignment.
    let argv = rawArgv;
    let ai = 0;
    while (ai < argv.length && ASSIGN.test(argv[ai])) {
      const eq = argv[ai].indexOf('=');
      state.vars.set(argv[ai].slice(0, eq), expand(argv[ai].slice(eq + 1)));
      ai++;
    }
    if (ai > 0) argv = argv.slice(ai);
    if (argv.length === 0) return { text: '', code: 0 };
    // Expand $VARs, then globs (`*.txt`) in the argument tokens.
    argv = argv.map(expand);
    argv = [argv[0], ...(await expandGlobs(argv.slice(1)))];
    const verb = argv[0];
    const args = argv.slice(1);
    if (builtins[verb]) return builtins[verb](args, stdin);
    if (verb === 'python' || verb === 'py') {
      if (!kiln) return { text: 'python: the Kiln kernel is not available in this build', code: 1 };
      const r = await kiln.exec('shell', args.join(' '));
      return { text: (r.stdout || '') + (r.stderr || ''), code: r.status === 'ok' ? 0 : 1 };
    }
    if (verb === 'find') { // find <dir> -> glob dir/** ; keep it simple
      const base = args[0] ? normalizePath(state.cwd, args[0]) : state.cwd;
      const res = await face.invoke('fs.glob', { pattern: (base ? base + '/' : '') + '**', cwd: '' });
      return res.ok ? { text: res.matches.join('\n'), code: 0 } : { text: `find: ${res.message}`, code: 1 };
    }
    if (verb === 'git') return runGit(args);
    const cmdName = REGISTRY_ALIAS[verb] || (registry.describeCommand(verb) ? verb : null);
    if (cmdName) return runRegistry(cmdName, args, stdin);
    return { text: `${verb}: command not found`, code: 127 };
  }

  // git <sub> [args]: map porcelain to the Rig git.* registry commands. Paths
  // resolve against cwd (git core dir is the root). Commits go through the face
  // as agent@rig.local and stage like any destructive op.
  async function runGit(args) {
    const sub = args[0];
    const rest = args.slice(1);
    const positional = rest.filter((a) => !a.startsWith('-'));
    const rel = (p) => normalizePath(state.cwd, p);
    if (!sub) return { text: 'usage: git <init|add|rm|commit|status|log|diff|branch|checkout>', code: 1 };

    let name; let input = {};
    switch (sub) {
      case 'init': input = {}; name = 'git.init'; break;
      case 'add': name = 'git.add'; input = { filepath: rel(positional[0] || '') }; break;
      case 'rm': name = 'git.remove'; input = { filepath: rel(positional[0] || '') }; break;
      case 'commit': {
        const mi = rest.findIndex((a) => a === '-m' || a === '--message');
        const message = mi >= 0 ? rest[mi + 1] : positional[0];
        if (!message) return { text: 'git commit: need -m "<message>"', code: 1 };
        name = 'git.commit'; input = { message, actor: 'agent' };
        break;
      }
      case 'status':
        if (positional[0]) { name = 'git.status'; input = { filepath: rel(positional[0]) }; }
        else { name = 'git.statusMatrix'; input = {}; }
        break;
      case 'log': name = 'git.log'; input = flagNum(rest, 0) ? { depth: flagNum(rest, 0) } : {}; break;
      case 'diff': name = 'git.diff'; input = positional[0] ? { ref: positional[0] } : {}; break;
      case 'branch': name = 'git.branch'; input = positional[0] ? { name: positional[0] } : {}; break;
      case 'checkout': name = 'git.checkout'; input = { ref: positional[0] || '' }; break;
      default: return { text: `git: '${sub}' is not a rig git command`, code: 1 };
    }
    if (!registry.describeCommand(name)) return { text: `git: '${sub}' is unavailable (no git core wired)`, code: 1 };
    const res = await face.invoke(name, input);
    if (res.staged) return { staged: res.proposalId, verb: `git ${sub}` };
    if (!res.ok) return { text: `git ${sub}: ${res.code || 'error'}: ${res.message || 'failed'}`, code: 1 };
    return { text: renderGit(sub, res), code: 0 };
  }

  async function runPipeline(pipeline) {
    let stdin = '';
    let last = { text: '', code: 0 };
    for (const argv of pipeline) {
      last = await runStage(argv, stdin);
      if (last.staged) return last; // destructive: surface for confirm
      if (last.clear) return last;
      stdin = last.text;
    }
    return last;
  }

  async function feed(line) {
    const out = [];
    const write = (s) => { if (s != null && s !== '') out.push(String(s)); };

    // Resolve a pending destructive confirm first.
    if (pending) {
      const ans = String(line == null ? '' : line).trim().toLowerCase();
      const p = pending; pending = null;
      if (ans === 'y' || ans === 'yes') {
        const r = await face.accept(p.proposalId);
        write(r.ok ? '' : `${p.verb}: ${r.message || 'failed'}`);
      } else { face.reject(p.proposalId); write(`cancelled: ${p.verb}`); }
      return { output: out.join('\n') };
    }

    const raw = String(line == null ? '' : line);
    if (raw.trim() !== '') state.history.push(raw.trim());
    let cleared = false;

    for (const stmt of parseLine(raw)) {
      if (stmt.op === '&&' && lastCode !== 0) continue; // short-circuit
      const res = await runPipeline(stmt.pipeline);
      lastCode = res.code || 0;
      if (res.clear) { cleared = true; continue; }
      if (res.staged) {
        pending = { proposalId: res.staged, verb: res.verb };
        write(`${res.verb} is destructive. confirm? [y/N]`);
        return { output: out.join('\n'), awaitingConfirm: res.staged };
      }
      if (stmt.redirect) {
        const path = normalizePath(state.cwd, expand(stmt.redirect.path));
        const chunk = withTrailingNewline(res.text);
        let data = chunk;
        if (stmt.redirect.append) {
          const cur = await face.invoke('fs.read', { path, encoding: 'utf-8' });
          data = (cur.ok ? decodeData(cur.data) : '') + chunk;
        }
        const w = await face.invoke('fs.write', { path, data, createParents: true });
        if (!w.ok) write(`${path}: ${w.message || 'write failed'}`);
      } else {
        // Terminal display: drop the single trailing newline (the screen adds
        // its own line break); inner newlines are preserved.
        write(res.text.endsWith('\n') ? res.text.slice(0, -1) : res.text);
      }
    }
    return { output: out.join('\n'), cleared };
  }

  return {
    feed,
    get cwd() { return state.cwd; },
    get awaitingConfirm() { return pending ? pending.proposalId : null; },
  };
}
