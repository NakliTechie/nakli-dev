// completer — Tab completion for the Forge terminal (Rig C5, L2).
//
// The line editor calls complete(buffer, cursor) synchronously on Tab, so path
// completion reads a *cache* of directory listings (the app refreshes it after
// cd / each prompt), never the async fs directly. First word → command names;
// later words → paths under the token's directory.
//
//   const complete = createCompleter({ commands, listPath });
//   createLineEditor({ complete });
//
// Returns full-line candidates (buffer with the completed token substituted), so
// the line editor can fill a unique match or the common prefix directly.

export function createCompleter({ commands = [], listPath = () => [] } = {}) {
  const names = [...commands].sort();
  return function complete(buffer, cursor = buffer.length) {
    const head = buffer.slice(0, cursor);
    // The token under the cursor is the run of non-space chars ending at cursor.
    const m = /(\S*)$/.exec(head);
    const word = m ? m[1] : '';
    const before = head.slice(0, head.length - word.length);
    const after = buffer.slice(cursor);
    const firstWord = before.trim() === '';

    let candidates;
    if (firstWord) {
      candidates = names.filter((c) => c.startsWith(word));
    } else {
      const slash = word.lastIndexOf('/');
      const dir = slash >= 0 ? word.slice(0, slash) : '';
      const base = slash >= 0 ? word.slice(slash + 1) : word;
      const entries = listPath(dir) || [];
      candidates = entries
        .filter((e) => e.startsWith(base))
        .sort()
        .map((e) => (dir ? `${dir}/${e}` : e));
    }
    return candidates.map((c) => before + c + after);
  };
}
