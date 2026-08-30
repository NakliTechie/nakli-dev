// mock-daemon.mjs — a zero-dependency stand-in for svs's aimax daemon.
//
// Speaks BOTH flavors over one WebSocket; the client picks in its hello:
//   {t:'hello', mode:'structured'}  → semantic messages  (see PROTOCOL.md)  → index.html
//   {t:'hello', mode:'vt'}          → a raw ANSI/VT byte stream             → vt.html
// (no mode ⇒ structured, so the plain renderer works unchanged).
//
// Zero deps — just node's http + crypto, a hand-rolled RFC6455 codec.
//
//   node prototypes/aimax-renderer/mock-daemon.mjs      # ws://localhost:9123
//
// The real aimax daemon replaces this file; the renderers are unchanged.

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 9123);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC6455 magic

const server = http.createServer((_, res) => { res.writeHead(426); res.end('websocket only'); });

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  console.log('renderer connected');
  const send = (obj) => socket.write(encode(JSON.stringify(obj)));
  const sendRaw = (str) => socket.write(encode(str)); // raw VT frame
  let started = false;
  const start = (mode) => {
    if (started) return; started = true;
    console.log('mode:', mode);
    if (mode === 'vt') driveVT(sendRaw); else driveStructured(send);
  };
  socket.on('data', (buf) => { for (const m of decode(buf)) onClient(safeJson(m), send, start); });
  socket.on('error', () => {});
  setTimeout(() => start('structured'), 500); // fallback if a client never says hello
});

function onClient(msg, send, start) {
  if (!msg) return;
  if (msg.t === 'hello') { start(msg.mode || 'structured'); return; }
  // a real daemon acts on these; the mock echoes intent so the round-trip is visible
  if (msg.t === 'key') send({ t: 'echo', text: `key ${keyLabel(msg)} → daemon` });
  if (msg.t === 'command') send({ t: 'minibuffer', prompt: 'M-x ', text: msg.name || '' });
  if (msg.t === 'resync') send(fullBuffer());          // structured: client asked for a full resend
}
const keyLabel = (m) => `${(m.mods || []).join('-')}${m.mods && m.mods.length ? '-' : ''}${m.key}`;

// ── STRUCTURED scene: buffers + windows + an agent that edits main.rs ──
function fullBuffer() {
  return { t: 'buffer', id: 'b1', name: 'main.rs', mode: 'rust', version: 3, cursor: { line: 5, col: 0 },
    lines: ['use crate::agent::Agent;', '', 'fn main() {', '    let mut ed = Editor::new();',
            '    // agent is a first-class citizen', '    ed.attach(Agent::claude());', '    ed.run();', '}'] };
}
function driveStructured(send) {
  send({ t: 'hello', app: 'aimax', proto: 1, caps: ['buffers', 'windows', 'agent', 'minibuffer'] });
  send(fullBuffer());
  send({ t: 'buffer', id: 'b2', name: '*agent*', mode: '', version: 1, cursor: { line: -1, col: 0 },
    lines: ['◆ watching buffer main.rs', '◆ awaiting instruction'] });
  send({ t: 'windows', focus: 'w1', layout: [{ id: 'w1', buffer: 'b1', weight: 1.6 }, { id: 'w2', buffer: 'b2', weight: 1 }] });
  send({ t: 'echo', text: 'aimax daemon ready · 2 buffers · 1 agent' });

  const line = 'streaming agent output into a side buffer, then editing main.rs…';
  let i = 0;
  send({ t: 'agent', id: 'a1', buffer: 'b2', state: 'streaming', text: '' });
  const iv = setInterval(() => {
    if (i >= line.length) {
      clearInterval(iv);
      send({ t: 'agent', id: 'a1', buffer: 'b2', state: 'idle', text: line });
      send({ t: 'patch', id: 'b1', from: 3, version: 4, edits: [{ range: [[5, 4], [5, 4]], text: '/* by agent */ ' }] });
      send({ t: 'cursor', id: 'b1', cursor: { line: 5, col: 19 }, version: 4 });
      send({ t: 'echo', text: 'agent edited main.rs · +1 change' });
      return;
    }
    send({ t: 'agent', id: 'a1', buffer: 'b2', state: 'streaming', chunk: line[i++] });
  }, 30);
}

// ── VT scene: a raw ANSI/VT byte stream, the flavor a plain TUI daemon emits ──
const E = '\x1b['; // CSI
function driveVT(sendRaw) {
  const clear = `${E}2J${E}H`;
  const bar = `${E}44m${E}97m aimax ${E}49m${E}39m ${E}90m~/proj · main.rs ${E}39m\r\n`;
  const code = [
    `${E}90m 1${E}39m ${E}34muse${E}39m crate::agent::Agent;`,
    `${E}90m 2${E}39m `,
    `${E}90m 3${E}39m ${E}34mfn${E}39m ${E}35mmain${E}39m() {`,
    `${E}90m 4${E}39m     ${E}34mlet${E}39m ${E}34mmut${E}39m ed = Editor::new();`,
    `${E}90m 5${E}39m     ${E}90m// agent is a first-class citizen${E}39m`,
    `${E}90m 6${E}39m     ed.attach(Agent::claude());`,
    `${E}90m 7${E}39m     ed.run();`,
    `${E}90m 8${E}39m }`,
  ].join('\r\n');
  sendRaw(clear + bar + '\r\n' + code + '\r\n');
  // code occupies terminal rows 3..10 (row1 bar, row2 blank). line 6 = row 8.
  const CODE_ROW0 = 3;                                // terminal row of code line 1
  const editRow = CODE_ROW0 + 5;                      // code line 6 (ed.attach…)
  const msg = '  ◆ agent: applying /* by agent */ to line 6…';
  let i = 0;
  const iv = setInterval(() => {
    if (i === 0) sendRaw(`${E}12;1H${E}95m`);         // move to row 12, magenta
    if (i >= msg.length) {
      clearInterval(iv);
      sendRaw(`${E}39m`);
      // redraw code line 6 in full with the agent's comment (clean, not an overwrite)
      sendRaw(`${E}${editRow};1H${E}2K${E}90m 6${E}39m     ${E}90m/* by agent */${E}39m ed.attach(Agent::claude());`);
      sendRaw(`${E}14;1H${E}92m  ✓ main.rs edited · +1 change${E}39m\r\n`);
      return;
    }
    sendRaw(msg[i++]);
  }, 30);
}

const safeJson = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };

// ── minimal RFC6455 frame codec (text frames) ──
function encode(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
function decode(buf) {
  const out = [];
  let o = 0;
  while (o + 2 <= buf.length) {
    const b1 = buf[o + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, p = o + 2;
    if (len === 126) { len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask; if (masked) { mask = buf.slice(p, p + 4); p += 4; }
    if (p + len > buf.length) break;
    const data = buf.slice(p, p + len);
    if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    if ((buf[o] & 0x0f) === 0x1) out.push(data.toString('utf8')); // text
    o = p + len;
  }
  return out;
}

server.listen(PORT, () => console.log(`mock aimax daemon on ws://localhost:${PORT} (structured + vt)`));
