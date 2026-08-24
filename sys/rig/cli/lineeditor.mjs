// lineeditor — the readline layer between xterm and the shell (Forge C5, L2).
//
// xterm is a raw screen: `term.onData` delivers keystrokes as strings and the
// app must echo, edit, and manage history itself. This module is that logic,
// headless and testable — xterm only feeds it bytes and writes back its output.
//
//   const ed = createLineEditor({ prompt: '$ ', complete });
//   term.onData(d => { const r = ed.feed(d); term.write(r.output);
//                      if (r.submit != null) runInShell(r.submit); });
//
// It owns: printable insert at cursor, ←/→, Backspace, history ↑/↓, Tab
// completion (delegated to `complete(buffer)`), Ctrl-C (cancel line), Ctrl-L
// (clear signal), Enter (submit). No PTY — just a one-line editor.

const CSI = '\x1b[';

export function createLineEditor({ prompt = '$ ', complete = () => [] } = {}) {
  let buffer = '';
  let cursor = 0;            // index into buffer
  const history = [];
  let hist = 0;             // history cursor; history.length === "new line"
  let draft = '';           // the in-progress line stashed when browsing history

  // Full-line repaint: return to col 0, clear to EOL, redraw prompt+buffer,
  // then park the cursor. Simple and correct for a single line.
  function render() {
    let out = `\r${CSI}K${prompt}${buffer}`;
    const back = buffer.length - cursor;
    if (back > 0) out += `${CSI}${back}D`;
    return out;
  }

  function setLine(next, curs = next.length) {
    buffer = next;
    cursor = Math.max(0, Math.min(curs, next.length));
    return render();
  }

  function feed(data) {
    let out = '';
    let submit; // set to the line string on Enter
    let interrupt = false;
    let clear = false;
    const s = String(data == null ? '' : data);

    for (let i = 0; i < s.length; i++) {
      const c = s[i];

      // ── escape sequences: arrows ──
      if (c === '\x1b' && s[i + 1] === '[') {
        const code = s[i + 2];
        i += 2;
        if (code === 'A') {            // up — older history
          if (hist === history.length) draft = buffer;
          if (hist > 0) { hist--; out += setLine(history[hist]); }
        } else if (code === 'B') {     // down — newer history
          if (hist < history.length) {
            hist++;
            out += setLine(hist === history.length ? draft : history[hist]);
          }
        } else if (code === 'C') {     // right
          if (cursor < buffer.length) { cursor++; out += `${CSI}C`; }
        } else if (code === 'D') {     // left
          if (cursor > 0) { cursor--; out += `${CSI}D`; }
        }
        continue;
      }

      // ── control chars ──
      if (c === '\r' || c === '\n') {  // Enter — submit
        out += '\r\n';
        submit = buffer;
        if (buffer.trim() !== '') history.push(buffer);
        buffer = ''; cursor = 0; hist = history.length; draft = '';
        // Stop consuming a paired \r\n as two submits.
        if (c === '\r' && s[i + 1] === '\n') i++;
        break;
      }
      if (c === '\x7f' || c === '\b') { // Backspace
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor--;
          out += render();
        }
        continue;
      }
      if (c === '\x03') {               // Ctrl-C — cancel the line
        out += '^C\r\n';
        buffer = ''; cursor = 0; hist = history.length; draft = '';
        interrupt = true;
        continue;
      }
      if (c === '\x0c') {               // Ctrl-L — clear screen (app clears, we repaint)
        clear = true;
        out += `${CSI}2J${CSI}H` + render();
        continue;
      }
      if (c === '\t') {                 // Tab — completion
        const matches = complete(buffer, cursor) || [];
        if (matches.length === 1) {
          out += setLine(matches[0]);
        } else if (matches.length > 1) {
          const common = longestCommonPrefix(matches);
          if (common.length > buffer.length) out += setLine(common);
          else out += '\r\n' + matches.join('  ') + '\r\n' + render();
        }
        continue;
      }
      if (c < ' ') continue;            // ignore other control bytes

      // ── printable: insert at cursor ──
      buffer = buffer.slice(0, cursor) + c + buffer.slice(cursor);
      cursor++;
      // Fast path: appending at end just echoes the char; otherwise repaint.
      out += cursor === buffer.length ? c : render();
    }

    const result = { output: out };
    if (submit != null) result.submit = submit;
    if (interrupt) result.interrupt = true;
    if (clear) result.clear = true;
    return result;
  }

  return {
    feed,
    prompt() { return prompt; },
    get line() { return buffer; },
    get cursor() { return cursor; },
    get history() { return history.slice(); },
  };
}

function longestCommonPrefix(strs) {
  if (!strs.length) return '';
  let p = strs[0];
  for (const s of strs) {
    while (!s.startsWith(p)) p = p.slice(0, -1);
    if (!p) break;
  }
  return p;
}
