// hashline — omp's content-hash-anchored line edits, an MVP second edit mode.
//
// The idea (from oh-my-pi): reads are anchored with a short content-hash TAG and
// 1-indexed line numbers; edits then reference LINE NUMBERS + that TAG instead of
// retyping the old text. This kills the two things that break string-match edits
// on weaker models — fumbling exact `oldText` whitespace, and paying output
// tokens to echo the code being replaced (~61% fewer edit tokens, per omp) — and
// makes a corrupting edit structurally impossible: if the file changed since the
// read, the TAG no longer matches and the edit is rejected with "re-read".
//
// Anchored read:
//   [src/foo.py#0A1B]
//   1: def alpha():
//   2:     return 1
//
// Edit block (one file; header carries the TAG copied from the latest read):
//   [src/foo.py#0A1B]
//   PUT 1.=1:
//   +def alpha(x):
//   PUT >$:
//   +# trailing note
//
// Operation set (MVP subset — registers, MV/REM, and tree-sitter `PUT N*` block
// mode are intentionally omitted; write/delete tools cover file-level ops):
//   PUT N.=M:   replace lines N..M (inclusive) with the +body rows
//   PUT <N:     insert the +body rows BEFORE line N
//   PUT >N:     insert the +body rows AFTER line N
//   PUT >$:     append the +body rows at end of file
//   CUT N.=M    delete lines N..M (inclusive)
// Body rows are `+TEXT`; a bare `+` is a blank line.

// Four-uppercase-hex content tag via FNV-1a (32-bit), folded to 16 bits. Pure and
// deterministic — the same content always yields the same tag, and any change
// almost always changes it (a 4-hex space; collisions are the accepted MVP risk).
export function hashTag(content) {
  let h = 0x811c9dc5;
  const s = String(content == null ? '' : content);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const folded = ((h >>> 16) ^ (h & 0xffff)) & 0xffff;
  return folded.toString(16).toUpperCase().padStart(4, '0');
}

// Render a file as an anchored read: header + 1-indexed `N: line` rows.
export function renderHashline(path, content) {
  const tag = hashTag(content);
  const lines = String(content == null ? '' : content).split('\n');
  const body = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
  return `[${path}#${tag}]\n${body}`;
}

// Parse an edit block into { ok, path, tag, ops } or { ok:false, error }.
// ops: { kind:'replace'|'cut'|'insert-before'|'insert-after'|'append', a, b, body }.
export function parseHashlineEdit(block) {
  const lines = String(block == null ? '' : block).split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const header = /^\[(.+)#([0-9A-Fa-f]{4})\]$/.exec((lines[i] || '').trim());
  if (!header) return { ok: false, error: 'edit block must start with a header line "[path#TAG]"' };
  const path = header[1];
  const tag = header[2].toUpperCase();
  i++;

  const ops = [];
  const consumeBody = () => {
    const body = [];
    while (i < lines.length && lines[i].startsWith('+')) { body.push(lines[i].slice(1)); i++; }
    return body;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    let m;
    if ((m = /^PUT\s+(\d+)\.=(\d+):$/.exec(line))) {
      i++; ops.push({ kind: 'replace', a: +m[1], b: +m[2], body: consumeBody() });
    } else if ((m = /^PUT\s+<(\d+):$/.exec(line))) {
      i++; ops.push({ kind: 'insert-before', a: +m[1], body: consumeBody() });
    } else if ((m = /^PUT\s+>(\d+):$/.exec(line))) {
      i++; ops.push({ kind: 'insert-after', a: +m[1], body: consumeBody() });
    } else if (/^PUT\s+>\$:$/.exec(line)) {
      i++; ops.push({ kind: 'append', body: consumeBody() });
    } else if ((m = /^CUT\s+(\d+)\.=(\d+)$/.exec(line))) {
      i++; ops.push({ kind: 'cut', a: +m[1], b: +m[2] });
    } else if (/^PUT\s+\d+\*:$/.exec(line)) {
      return { ok: false, error: 'block mode (PUT N*) is not supported in this edit mode; use PUT N.=M with explicit line numbers' };
    } else {
      return { ok: false, error: `unrecognized edit operation: ${JSON.stringify(line)}` };
    }
  }
  if (!ops.length) return { ok: false, error: 'edit block has a header but no operations' };
  return { ok: true, path, tag, ops };
}

// Apply parsed ops to `content`, rejecting a stale TAG. Ops reference the ORIGINAL
// (pre-edit) line numbers; they are applied against a snapshot so numbering never
// shifts underfoot. Returns { ok, content, applied } or { ok:false, error }.
export function applyHashlineEdit(content, tag, ops) {
  const src = String(content == null ? '' : content);
  const actual = hashTag(src);
  if (String(tag).toUpperCase() !== actual) {
    return { ok: false, error: `stale tag: the edit anchored #${String(tag).toUpperCase()} but the file is now #${actual}. Re-read the file to get a fresh tag, then edit.` };
  }
  const lines = src.split('\n');
  const n = lines.length;

  // Normalize each op to a splice { pos, del, body } in original coordinates.
  const splices = [];
  for (const op of ops) {
    if (op.kind === 'replace' || op.kind === 'cut') {
      const a = op.a, b = op.b;
      if (!(a >= 1 && b >= a && b <= n)) {
        return { ok: false, error: `range ${a}..${b} is out of bounds (file has ${n} line${n === 1 ? '' : 's'})` };
      }
      splices.push({ pos: a - 1, del: b - a + 1, body: op.kind === 'cut' ? [] : op.body });
    } else if (op.kind === 'insert-before' || op.kind === 'insert-after') {
      const a = op.a;
      if (!(a >= 1 && a <= n)) {
        return { ok: false, error: `line ${a} is out of bounds (file has ${n} line${n === 1 ? '' : 's'})` };
      }
      splices.push({ pos: op.kind === 'insert-before' ? a - 1 : a, del: 0, body: op.body });
    } else if (op.kind === 'append') {
      splices.push({ pos: n, del: 0, body: op.body });
    }
  }

  // Reject overlapping mutations (any two ops that touch the same original line).
  const ranges = splices.filter((s) => s.del > 0).map((s) => [s.pos, s.pos + s.del]);
  ranges.sort((x, y) => x[0] - y[0]);
  for (let k = 1; k < ranges.length; k++) {
    if (ranges[k][0] < ranges[k - 1][1]) {
      return { ok: false, error: 'edit operations overlap the same lines; split them into non-overlapping ranges' };
    }
  }

  // Apply from the highest position down so earlier indices stay valid.
  const out = lines.slice();
  splices.sort((x, y) => y.pos - x.pos);
  for (const s of splices) out.splice(s.pos, s.del, ...s.body);
  return { ok: true, content: out.join('\n'), applied: ops.length };
}

// Parse + apply in one call against the current file content.
export function applyHashlineBlock(content, block) {
  const parsed = parseHashlineEdit(block);
  if (!parsed.ok) return parsed;
  const res = applyHashlineEdit(content, parsed.tag, parsed.ops);
  if (!res.ok) return res;
  return { ok: true, content: res.content, path: parsed.path, applied: res.applied };
}
