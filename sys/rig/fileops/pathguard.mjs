// pathguard — the single ingress validator for Rig fileops (C0).
//
// Every external path (CLI line, kernel call, window.rig call, git adapter)
// passes through normalizeMountPath before it reaches a backend. POSIX paths
// only, resolved *within the mount*; ".." escapes, absolute escapes, encoded
// traversal, backslashes, and control/NUL bytes are rejected here — fail closed.
//
// Symlink-escape rejection is not a pure-string concern: it needs to stat the
// backend. It lives in fileops.mjs (resolveMount), which calls back into this
// module to re-validate every hop. This file stays storage-agnostic.

export const EINVAL_PATH = 'EINVAL_PATH';

function reject(input, message) {
  return { ok: false, code: EINVAL_PATH, message, input };
}

// Percent-encodings that could smuggle a separator or dot-dot past a naive
// splitter. Rejected before any decode so the raw and decoded forms agree.
const ENCODED_TRAVERSAL = /%(2e|2f|5c|00|25)/i; // '.', '/', '\', NUL, '%'

// Control characters (incl. NUL) are never valid in a mount path segment.
const CONTROL_CHARS = /[\x00-\x1f]/; // eslint-disable-line no-control-regex

/**
 * Normalise an app-supplied POSIX path to a clean, mount-relative path.
 *
 * @param {string} input                 caller-supplied path (may be absolute
 *                                        "within the mount", i.e. a leading '/')
 * @returns {{ok:true, path:string, segments:string[]}
 *          | {ok:false, code:string, message:string, input:*}}
 *          On success `path` is mount-relative with no leading slash, no '.'
 *          or '..' segments; root is the empty string.
 */
export function normalizeMountPath(input) {
  if (typeof input !== 'string') {
    return reject(input, 'path must be a string');
  }
  if (input.length === 0) {
    return { ok: true, path: '', segments: [] };
  }
  if (input.includes('\\')) {
    return reject(input, 'backslash not allowed — POSIX paths only');
  }
  if (CONTROL_CHARS.test(input)) {
    return reject(input, 'control or NUL byte in path');
  }
  if (ENCODED_TRAVERSAL.test(input)) {
    return reject(input, 'percent-encoded path component not allowed');
  }

  const stack = [];
  // Leading '/' produces a leading '' segment which is dropped here: an
  // absolute path is interpreted as mount-root-absolute, never a real fs root.
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) {
        return reject(input, 'path escapes mount root');
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return { ok: true, path: stack.join('/'), segments: stack };
}

/**
 * Join a validated mount-relative path onto a mount root, producing the
 * backend safePath. `root` is trusted (operator/grant-supplied); `rel` must
 * already have passed normalizeMountPath.
 */
export function joinRoot(root, rel) {
  const base = String(root || '').replace(/\/+$/, '');
  if (!rel) return base;
  return base ? base + '/' + rel : rel;
}
