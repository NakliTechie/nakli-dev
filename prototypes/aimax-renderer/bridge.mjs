// bridge.mjs — nakli-local-bridge, socket-proxy mode.
//
// A browser page on https can't reach a raw unix socket. This bridge exposes a
// local unix-domain socket as a browser-reachable WebSocket, relaying bytes
// verbatim in both directions. It is protocol-agnostic — it does NOT parse
// JSON-RPC; it just moves bytes — so it works for aimax's socket or any other
// line-oriented local daemon.
//
//   node prototypes/aimax-renderer/bridge.mjs [unixSocketPath] [wsPort]
//   node prototypes/aimax-renderer/bridge.mjs ~/.aimax/sock 9130     # aimax default
//
// Then the renderer connects to ws://localhost:9130. Serve the renderer from
// localhost too (a secure context) so the browser allows the ws://localhost hop.
//
// Zero deps. Hand-rolled RFC6455 (text frames). One unix connection per ws client.

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const rawSock = process.argv[2] || path.join(os.homedir(), '.aimax', 'sock');
const SOCK = rawSock.replace(/^~(?=$|\/)/, os.homedir());
const PORT = Number(process.argv[3] || process.env.PORT || 9130);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const server = http.createServer((_, res) => { res.writeHead(426); res.end('websocket only'); });

server.on('upgrade', (req, ws) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  ws.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
           `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);

  const unix = net.connect(SOCK);
  let alive = true;
  const close = () => { if (!alive) return; alive = false; try { ws.end(); } catch (_) {} try { unix.end(); } catch (_) {} };

  unix.on('connect', () => console.log('bridged ws client ↔', SOCK));
  unix.on('error', (e) => { console.error('unix socket error:', e.message); try { ws.write(encode(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'bridge_error', data: e.message } }))); } catch (_) {} close(); });
  unix.on('close', close);
  ws.on('error', close);
  ws.on('close', close);

  // unix → ws: forward whatever bytes arrive, framed as one ws text message per chunk.
  // (aimax writes newline-delimited JSON; the client splits on newlines itself.)
  unix.on('data', (buf) => { if (alive) try { ws.write(encode(buf.toString('utf8'))); } catch (_) { close(); } });

  // ws → unix: decode client frames, write payloads straight through.
  let acc = Buffer.alloc(0);
  ws.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    const { messages, rest } = decode(acc);
    acc = rest;
    for (const m of messages) { if (m.opcode === 0x8) { close(); return; } if (m.opcode === 0x1 && alive) unix.write(m.text); }
  });
});

// ── RFC6455 ──
function encode(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
// returns fully-decoded frames plus any leftover partial bytes (framing can split across TCP chunks)
function decode(buf) {
  const messages = [];
  let o = 0;
  while (o + 2 <= buf.length) {
    const opcode = buf[o] & 0x0f;
    const b1 = buf[o + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, p = o + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask; if (masked) { if (p + 4 > buf.length) break; mask = buf.slice(p, p + 4); p += 4; }
    if (p + len > buf.length) break; // wait for the rest of this frame
    const data = buf.slice(p, p + len);
    if (masked) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    messages.push({ opcode, text: data.toString('utf8') });
    o = p + len;
  }
  return { messages, rest: buf.slice(o) };
}

server.listen(PORT, () => console.log(`nakli-local-bridge: ws://localhost:${PORT}  ↔  ${SOCK}`));
