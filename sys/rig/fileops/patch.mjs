// patch — minimal unified-diff apply + reverse for Rig fileops (C0).
//
// Hand-rolled (no vendored dep — smaller than the ~5KB the handoff budgets).
// Two guarantees the C0 checkpoint rests on:
//   1. Atomic: apply computes the whole new content in memory and reports a
//      typed failure naming the hunk; the caller writes nothing on failure.
//   2. Exactly reversible: reversePatch(diff) applied to the patched text
//      reproduces the original bytes. fileops returns it as the `revert` diff.
//
// Text is split on '\n' only, so '\r' stays attached to its line and CRLF is
// preserved byte-for-byte. Trailing-newline presence is tracked explicitly and
// honoured via the "\ No newline at end of file" marker.

export const EPATCH = 'EPATCH';

// Split into lines without terminators, remembering whether the final line
// carried a trailing newline. join is the exact inverse.
function splitLines(text) {
  const finalNewline = text.endsWith('\n');
  const body = finalNewline ? text.slice(0, -1) : text;
  const lines = body === '' && finalNewline
    ? [] // a single trailing '\n' means one empty line's worth handled below
    : body.split('\n');
  // text "" → [] ; text "\n" → [''] with finalNewline (one empty line + NL)
  if (text === '') return { lines: [], finalNewline: false };
  if (finalNewline && body === '') return { lines: [''], finalNewline: true };
  return { lines, finalNewline };
}

function joinLines(lines, finalNewline) {
  if (lines.length === 0) return '';
  return lines.join('\n') + (finalNewline ? '\n' : '');
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a unified diff into hunks. Returns {ok, hunks} or a typed error. */
export function parsePatch(diff) {
  const raw = String(diff).split('\n');
  const hunks = [];
  let current = null;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    const m = HUNK_RE.exec(line);
    if (m) {
      current = {
        oldStart: parseInt(m[1], 10),
        newStart: parseInt(m[3], 10),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      // Ignore blank leading lines; anything else outside a hunk is malformed.
      if (line === '') continue;
      return { ok: false, code: EPATCH, message: `line outside any hunk: ${JSON.stringify(line)}` };
    }
    if (line === '\\ No newline at end of file') {
      current.lines.push({ op: '\\', text: '' });
      continue;
    }
    const op = line[0];
    if (op === ' ' || op === '+' || op === '-') {
      current.lines.push({ op, text: line.slice(1) });
    } else if (line === '') {
      // A bare empty line inside a hunk is a context line for an empty line.
      current.lines.push({ op: ' ', text: '' });
    } else {
      return { ok: false, code: EPATCH, message: `unrecognised diff line: ${JSON.stringify(line)}` };
    }
  }
  return { ok: true, hunks };
}

/**
 * Apply a unified diff to text.
 * @returns {{ok:true, result:string} | {ok:false, code:'EPATCH', message, hunk:number}}
 */
export function applyPatch(text, diff) {
  const parsed = parsePatch(diff);
  if (!parsed.ok) return parsed;

  const { lines: src, finalNewline: srcFinalNL } = splitLines(text);
  const out = [];
  let cursor = 0; // index into src (0-based)
  let finalNewline = srcFinalNL;

  for (let h = 0; h < parsed.hunks.length; h++) {
    const hunk = parsed.hunks[h];
    let pos = hunk.oldStart - 1; // 1-based → 0-based
    if (pos < 0) pos = 0;
    // Copy untouched lines between the previous hunk and this one.
    if (pos < cursor) {
      return { ok: false, code: EPATCH, message: `hunk #${h + 1} overlaps a previous hunk at line ${hunk.oldStart}`, hunk: h + 1 };
    }
    for (; cursor < pos; cursor++) out.push(src[cursor]);

    let prevOp = null; // the body op a following '\' marker refers to
    for (const l of hunk.lines) {
      if (l.op === '\\') {
        // "\ No newline at end of file" refers to the line just emitted. It
        // only speaks for the NEW file when that line is present in it (' '/'+').
        if (prevOp === ' ' || prevOp === '+') finalNewline = false;
        continue;
      }
      if (l.op === ' ') {
        if (src[cursor] !== l.text) {
          return { ok: false, code: EPATCH, message: `hunk #${h + 1} context mismatch at line ${cursor + 1}`, hunk: h + 1 };
        }
        out.push(l.text);
        cursor++;
      } else if (l.op === '-') {
        if (src[cursor] !== l.text) {
          return { ok: false, code: EPATCH, message: `hunk #${h + 1} removal mismatch at line ${cursor + 1}`, hunk: h + 1 };
        }
        cursor++;
      } else if (l.op === '+') {
        out.push(l.text);
      }
      prevOp = l.op;
    }
  }
  // Copy the tail after the last hunk.
  for (; cursor < src.length; cursor++) out.push(src[cursor]);

  return { ok: true, result: joinLines(out, finalNewline) };
}

/**
 * Produce the diff that exactly undoes `diff`. Swaps hunk ranges and flips
 * '+' ↔ '-'; context and no-newline markers are preserved. Applying the result
 * to the patched text yields the original bytes.
 */
export function reversePatch(diff) {
  const raw = String(diff).split('\n');
  const out = [];
  for (const line of raw) {
    const m = HUNK_RE.exec(line);
    if (m) {
      const oldStart = m[1], oldCount = m[2], newStart = m[3], newCount = m[4];
      const tail = line.slice(m[0].length);
      const rev = `@@ -${newStart}${newCount !== undefined ? ',' + newCount : ''} `
        + `+${oldStart}${oldCount !== undefined ? ',' + oldCount : ''} @@${tail}`;
      out.push(rev);
      continue;
    }
    if (line.startsWith('--- ')) { out.push('+++ ' + line.slice(4)); continue; }
    if (line.startsWith('+++ ')) { out.push('--- ' + line.slice(4)); continue; }
    if (line.startsWith('+')) { out.push('-' + line.slice(1)); continue; }
    if (line.startsWith('-')) { out.push('+' + line.slice(1)); continue; }
    out.push(line); // ' ' context, '\' markers, blanks
  }
  return out.join('\n');
}
