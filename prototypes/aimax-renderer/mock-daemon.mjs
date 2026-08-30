// mock-daemon.mjs — a zero-dependency stand-in for svs's aimax daemon.
//
// It speaks the STRUCTURED render protocol (see PROTOCOL.md) over a WebSocket,
// so the naklios renderer (index.html) can connect to a REAL socket and prove
// the transport end to end — no `ws` package, just node's http + crypto.
//
//   node prototypes/aimax-renderer/mock-daemon.mjs   # listens on ws://localhost:9123
//
// Then open the renderer FROM localhost (so the browser lets it reach ws://localhost):
//   python3 -m http.server 8000   # in prototypes/aimax-renderer/
//   open http://localhost:8000/  → Connect
//
// The real aimax daemon would replace this file entirely; the renderer is unchanged.

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
  socket.on('data', (buf) => { for (const msg of decode(buf)) onClient(JSON.parse(msg), send); });
  socket.on('error', () => {});
  driveScene(send);
});

// ── the "editor": a scripted scene proving buffers + windows + an agent edit ──
function driveScene(send) {
  send({ t: 'hello', app: 'aimax', proto: 1, caps: ['buffers', 'windows', 'agent', 'minibuffer'] });
  send({ t: 'buffer', id: 'b1', name: 'main.rs', mode: 'rust', version: 3, cursor: { line: 5, col: 0 },
    lines: ['use crate::agent::Agent;', '', 'fn main() {', '    let mut ed = Editor::new();',
            '    // agent is a first-class citizen', '    ed.attach(Agent::claude());', '    ed.run();', '}'] });
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

// a real daemon acts on these; the mock just echoes intent back so you see the round-trip
function onClient(msg, send) {
  if (msg.t === 'hello') console.log('client hello:', msg.client);
  if (msg.t === 'key') send({ t: 'echo', text: `key ${msg.mods?.join('-') || ''}${msg.mods?.length ? '-' : ''}${msg.key} → daemon` });
  if (msg.t === 'command') send({ t: 'minibuffer', prompt: 'M-x ', text: msg.name || '' });
}

// ── minimal RFC6455 frame codec (text frames, server→client unmasked, client→server unmasked here) ──
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
    const opcode = buf[o] & 0x0f;
    if (opcode === 0x1) out.push(data.toString('utf8')); // text
    o = p + len;
  }
  return out;
}

server.listen(PORT, () => console.log(`mock aimax daemon on ws://localhost:${PORT}`));
