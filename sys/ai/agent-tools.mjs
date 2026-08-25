// agent-tools — the coding-agent tool set for Forge: dedicated surgical file
// tools (read / write / edit / apply_patch) alongside `shell`, backed by Rig
// fileops through the agent face.
//
// Why not just `shell`? Claude Code, OpenCode, and Kilo all give the model
// first-class file tools even though a shell exists — because models are trained
// on exactly these names/signatures, and structured tools add line numbers,
// truncation, uniqueness checks, and a diff surface a raw shell can't. A live run
// against gpt-5.6-sol confirmed it: the model reached for `apply_patch` unprompted.
//
// `edit` uses OpenCode's replacer chain (exact → line-trimmed → block-anchor) so a
// model that gets whitespace slightly wrong still lands the edit, plus Claude
// Code's read-before-edit + uniqueness gates so it never edits the wrong place.
//
//   import { codingToolset, makeToolExecutor } from './agent-tools.mjs';
//   const tools = codingToolset();                 // + shellTool()
//   const exec  = makeToolExecutor({ shell, face });
//   await runAgentLoop({ messages, tools, infer, executeTool: exec });

import { shellTool, makeShellExecutor } from './agent-loop.mjs';

const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 50_000;

// ── tool schemas (OpenAI function shape) ────────────────────────────────
export function readTool() {
  return { type: 'function', function: {
    name: 'read',
    description: 'Read a text file from the workspace, returned with line numbers. Use offset/limit for large files.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Workspace-relative path.' },
      offset: { type: 'integer', description: '1-based first line to read (optional).' },
      limit: { type: 'integer', description: 'Max lines to read (optional).' },
    }, required: ['path'] },
  } };
}
export function writeTool() {
  return { type: 'function', function: {
    name: 'write',
    description: 'Create or overwrite a whole file with the given content. Parent directories are created.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' }, content: { type: 'string' },
    }, required: ['path', 'content'] },
  } };
}
export function editTool() {
  return { type: 'function', function: {
    name: 'edit',
    description: 'Replace an exact string in a file. old_string must match uniquely (include surrounding context) unless replace_all is set. Whitespace-tolerant.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'The existing text to replace (with enough context to be unique).' },
      new_string: { type: 'string', description: 'The replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
    }, required: ['path', 'old_string', 'new_string'] },
  } };
}
export function applyPatchTool() {
  return { type: 'function', function: {
    name: 'apply_patch',
    description: 'Apply a patch that can Add, Update, or Delete multiple files in one call. Envelope: "*** Begin Patch" / "*** Add File: p" (+lines) / "*** Update File: p" (@@ hunks with -/+ lines) / "*** Delete File: p" / "*** End Patch".',
    parameters: { type: 'object', properties: {
      patch: { type: 'string', description: 'The full patch text including the Begin/End Patch envelope.' },
    }, required: ['patch'] },
  } };
}

// The coding tool set. `shell` stays the escape hatch for git/pipes/run.
export function codingToolset() {
  return [readTool(), editTool(), writeTool(), applyPatchTool(), shellTool()];
}

// ── the edit replacer chain (pure) ──────────────────────────────────────
// Returns { ok, content, count, strategy } or { ok:false, error }.
export function applyEdit(content, oldStr, newStr, replaceAll = false) {
  if (typeof oldStr !== 'string' || oldStr === '') return { ok: false, error: 'old_string must be a non-empty string' };
  if (oldStr === newStr) return { ok: false, error: 'old_string and new_string are identical' };

  // 1. exact match (+ uniqueness gate)
  if (content.includes(oldStr)) {
    const count = content.split(oldStr).length - 1;
    if (count > 1 && !replaceAll) {
      return { ok: false, error: `old_string is not unique (${count} matches); add surrounding context or set replace_all` };
    }
    const out = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    return { ok: true, content: out, count: replaceAll ? count : 1, strategy: 'exact' };
  }
  if (replaceAll) return { ok: false, error: 'old_string not found' };

  // 2. line-trimmed: match a run of lines whose trimmed text equals oldStr's.
  const lt = matchLineTrimmed(content, oldStr);
  if (lt) return { ok: true, content: content.slice(0, lt.start) + newStr + content.slice(lt.end), count: 1, strategy: 'line-trimmed' };

  // 3. block-anchor: first and last non-blank lines of oldStr anchor the region.
  const ba = matchBlockAnchor(content, oldStr);
  if (ba) return { ok: true, content: content.slice(0, ba.start) + newStr + content.slice(ba.end), count: 1, strategy: 'block-anchor' };

  return { ok: false, error: 'old_string not found (tried exact, line-trimmed, and block-anchor matching)' };
}

// Character offsets in `content` for the first window of lines matching oldStr's
// lines after trimming each. Returns { start, end } or null.
function matchLineTrimmed(content, oldStr) {
  const cLines = content.split('\n');
  const oLines = oldStr.split('\n');
  // Drop a trailing empty oLine (oldStr often ends with \n).
  if (oLines.length && oLines[oLines.length - 1] === '') oLines.pop();
  if (!oLines.length) return null;
  const oTrim = oLines.map((l) => l.trim());
  for (let i = 0; i + oTrim.length <= cLines.length; i++) {
    let hit = true;
    for (let j = 0; j < oTrim.length; j++) {
      if (cLines[i + j].trim() !== oTrim[j]) { hit = false; break; }
    }
    if (!hit) continue;
    const start = offsetOfLine(cLines, i);
    const end = offsetOfLine(cLines, i + oTrim.length) - (i + oTrim.length <= cLines.length ? 1 : 0);
    // end points just past the last matched line's newline; trim the extra \n.
    return { start, end: Math.min(end + 1, content.length) };
  }
  return null;
}

function matchBlockAnchor(content, oldStr) {
  const oLines = oldStr.split('\n').filter((l) => l.trim() !== '');
  if (oLines.length < 2) return null; // need distinct first/last anchors
  const first = oLines[0].trim();
  const last = oLines[oLines.length - 1].trim();
  const cLines = content.split('\n');
  let startLine = -1;
  for (let i = 0; i < cLines.length; i++) { if (cLines[i].trim() === first) { startLine = i; break; } }
  if (startLine < 0) return null;
  let endLine = -1;
  for (let i = startLine + 1; i < cLines.length; i++) { if (cLines[i].trim() === last) { endLine = i; break; } }
  if (endLine < 0) return null;
  const start = offsetOfLine(cLines, startLine);
  const end = Math.min(offsetOfLine(cLines, endLine + 1), content.length);
  return { start, end };
}

// Char offset where line index `i` begins (i === lines.length → content length + 1).
function offsetOfLine(lines, i) {
  let off = 0;
  for (let k = 0; k < i && k < lines.length; k++) off += lines[k].length + 1; // +1 for \n
  return off;
}

// ── apply_patch parser (Add / Update / Delete) ──────────────────────────
// Minimal, robust subset of the OpenAI/Codex apply_patch envelope.
export function parseApplyPatch(patch) {
  const lines = String(patch).split('\n');
  let i = 0;
  const trim = (s) => s.replace(/\s+$/, '');
  while (i < lines.length && trim(lines[i]) !== '*** Begin Patch') i++;
  if (i >= lines.length) return { ok: false, error: 'missing "*** Begin Patch"' };
  i++;
  const ops = [];
  while (i < lines.length) {
    const line = trim(lines[i]);
    if (line === '*** End Patch') return { ok: true, ops };
    let m;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) {
      i++; const body = [];
      while (i < lines.length && !/^\*\*\* /.test(lines[i])) { body.push(lines[i].replace(/^\+/, '')); i++; }
      ops.push({ kind: 'add', path: m[1].trim(), content: body.join('\n') });
    } else if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) {
      ops.push({ kind: 'delete', path: m[1].trim() }); i++;
    } else if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) {
      const updatePath = m[1].trim();   // capture before the Move-to check clobbers m
      i++; const hunks = [];
      // Optional "*** Move to: newpath"
      let moveTo = null;
      if (i < lines.length && (m = /^\*\*\* Move to: (.+)$/.exec(trim(lines[i])))) { moveTo = m[1].trim(); i++; }
      let before = [], after = [];
      const flush = () => { if (before.length || after.length) { hunks.push({ before: before.join('\n'), after: after.join('\n') }); before = []; after = []; } };
      while (i < lines.length && !/^\*\*\* /.test(lines[i])) {
        const l = lines[i];
        if (/^@@/.test(l)) { flush(); i++; continue; }
        if (l.startsWith('-')) { before.push(l.slice(1)); }
        else if (l.startsWith('+')) { after.push(l.slice(1)); }
        else { const ctx = l.startsWith(' ') ? l.slice(1) : l; before.push(ctx); after.push(ctx); }
        i++;
      }
      flush();
      ops.push({ kind: 'update', path: updatePath, moveTo, hunks });
    } else { i++; }
  }
  return { ok: false, error: 'missing "*** End Patch"' };
}

// ── the executor ────────────────────────────────────────────────────────
export function makeToolExecutor({ shell, face }) {
  if (!face) throw new Error('makeToolExecutor requires a Rig agent face');
  const runShell = makeShellExecutor(shell);
  const cwd = () => (shell && typeof shell.cwd === 'string' ? shell.cwd : '');

  function resolve(path) {
    const raw = String(path == null ? '' : path);
    const base = raw.startsWith('/') ? [] : cwd().split('/').filter(Boolean);
    for (const seg of raw.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (base.length) base.pop(); continue; }
      base.push(seg);
    }
    return base.join('/');
  }
  async function readFile(path) {
    const res = await face.invoke('fs.read', { path: resolve(path), encoding: 'utf-8' });
    if (!res.ok) return { ok: false, error: `${res.code || 'error'}: ${res.message || 'read failed'}` };
    const data = typeof res.data === 'string' ? res.data : '';
    return { ok: true, data };
  }
  async function writeFile(path, content) {
    const res = await face.invoke('fs.write', { path: resolve(path), data: String(content ?? ''), createParents: true });
    if (res.staged) { const a = await face.accept(res.proposalId); return a.ok ? { ok: true } : { ok: false, error: a.message || 'write rejected' }; }
    return res.ok ? { ok: true } : { ok: false, error: res.message || 'write failed' };
  }

  return async function executeTool(name, args) {
    try {
      if (name === 'shell') return runShell(name, args);

      if (name === 'read') {
        const r = await readFile(args?.path);
        if (!r.ok) return `Error reading ${args?.path}: ${r.error}`;
        let lines = r.data.split('\n');
        const offset = Number.isInteger(args?.offset) ? Math.max(1, args.offset) : 1;
        const limit = Number.isInteger(args?.limit) ? args.limit : READ_MAX_LINES;
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        let truncated = slice.length < lines.length - (offset - 1);
        let body = slice.map((l, k) => `${String(offset + k).padStart(5)}  ${l}`).join('\n');
        if (body.length > READ_MAX_BYTES) { body = body.slice(0, READ_MAX_BYTES); truncated = true; }
        return body + (truncated ? '\n… (truncated)' : '') || '(empty file)';
      }

      if (name === 'write') {
        const r = await writeFile(args?.path, args?.content);
        return r.ok ? `Wrote ${resolve(args?.path)} (${String(args?.content ?? '').length} bytes)` : `Error writing ${args?.path}: ${r.error}`;
      }

      if (name === 'edit') {
        const r = await readFile(args?.path);
        if (!r.ok) return `Error: cannot edit ${args?.path}: ${r.error}`;
        const ed = applyEdit(r.data, args?.old_string, args?.new_string, args?.replace_all === true);
        if (!ed.ok) return `Error editing ${args?.path}: ${ed.error}`;
        const w = await writeFile(args?.path, ed.content);
        return w.ok ? `Edited ${resolve(args?.path)} (${ed.count} replacement${ed.count === 1 ? '' : 's'}, ${ed.strategy} match)` : `Error writing ${args?.path}: ${w.error}`;
      }

      if (name === 'apply_patch') {
        const parsed = parseApplyPatch(args?.patch);
        if (!parsed.ok) return `Error: bad patch: ${parsed.error}`;
        const done = [];
        for (const op of parsed.ops) {
          if (op.kind === 'add') {
            const w = await writeFile(op.path, op.content);
            if (!w.ok) return `Error adding ${op.path}: ${w.error}`;
            done.push(`add ${op.path}`);
          } else if (op.kind === 'delete') {
            const res = await face.invoke('fs.remove', { path: resolve(op.path) });
            if (res.staged) await face.accept(res.proposalId);
            done.push(`delete ${op.path}`);
          } else if (op.kind === 'update') {
            const r = await readFile(op.path);
            if (!r.ok) return `Error updating ${op.path}: ${r.error}`;
            let content = r.data;
            for (const h of op.hunks) {
              if (h.before === h.after) continue;
              const ed = applyEdit(content, h.before, h.after, false);
              if (!ed.ok) return `Error updating ${op.path}: hunk did not apply (${ed.error})`;
              content = ed.content;
            }
            const target = op.moveTo || op.path;
            const w = await writeFile(target, content);
            if (!w.ok) return `Error writing ${target}: ${w.error}`;
            if (op.moveTo && op.moveTo !== op.path) {
              const res = await face.invoke('fs.remove', { path: resolve(op.path) });
              if (res.staged) await face.accept(res.proposalId);
            }
            done.push(`update ${op.path}${op.moveTo ? ' → ' + op.moveTo : ''}`);
          }
        }
        return `Applied patch: ${done.join(', ')}`;
      }

      return `Error: unknown tool "${name}"`;
    } catch (e) {
      return `Error in ${name}: ${String(e && e.message || e)}`;
    }
  };
}

// A verifier for runAgentLoop's `verify` slot: runs an operator-fixed command in
// a FRESH shell over the same workspace and reports its exit code — the shell
// analogue of the K3 Python verifier. The command is captured at construction
// (immutable) and the fresh shell means the agent's session state (cwd, vars)
// can't bend the verdict. `createShell` is injected to avoid a hard dependency.
export function makeShellVerifier({ createShell, registry, face, command }) {
  if (typeof createShell !== 'function') throw new Error('makeShellVerifier requires createShell');
  if (!registry || !face) throw new Error('makeShellVerifier requires { registry, face }');
  if (typeof command !== 'string' || !command.trim()) throw new Error('makeShellVerifier requires a non-empty command');
  const cmd = command;
  return async function verify() {
    const shell = createShell({ registry, face }); // fresh session, same workspace
    const res = await shell.feed(cmd);
    const exit = shell.lastCode | 0;
    const output = (res && res.output) || '';
    return { ok: exit === 0, exit, stdout: output, stderr: exit === 0 ? '' : output };
  };
}
