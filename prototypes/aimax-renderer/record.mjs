// record.mjs — connect to a daemon's ws as a client and dump its message stream
// to a .jsonl (lines of {dt, m}) that the renderer can replay and conformance.mjs
// can validate. Zero deps (hand-rolled RFC6455 client).
//
//   node prototypes/aimax-renderer/record.mjs [ws://host:port] [out.jsonl] [seconds]
//   node prototypes/aimax-renderer/record.mjs                       # defaults: :9123, sample-session.jsonl, 4s
//
// Point it at svs's real daemon to capture a live session, then:
//   node conformance.mjs sample-session.jsonl      # where does his stream diverge?

import http from 'node:http';
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';

const URL_ = process.argv[2] || 'ws://localhost:9123';
const OUT = process.argv[3] || new URL('sample-session.jsonl', import.meta.url).pathname;
const SECS = Number(process.argv[4] || 4);
const u = new URL(URL_);

const key = crypto.randomBytes(16).toString('base64');
const req = http.request({
  host: u.hostname, port: u.port || 80, path: u.pathname || '/',
  headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': 13, 'Sec-WebSocket-Key': key },
});
req.on('upgrade', (_res, socket) => {
  console.log('connected to', URL_);
  const t0 = Date.now();
  const rows = [];
  socket.write(maskFrame(JSON.stringify({ t: 'hello', client: 'naklios-record', proto: 1 }))); // structured
  socket.on('data', (buf) => { for (const s of decode(buf)) { try { rows.push({ dt: Date.now() - t0, m: JSON.parse(s) }); } catch (_) {} } });
  setTimeout(() => {
    try { socket.end(); } catch (_) {}
    writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`recorded ${rows.length} messages → ${OUT}`);
    process.exit(0);
  }, SECS * 1000);
});
req.on('error', (e) => { console.error('connect failed:', e.message); process.exit(1); });
req.end();

// client→server frames MUST be masked (RFC6455 §5.3)
function maskFrame(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
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
    if ((buf[o] & 0x0f) === 0x1) out.push(data.toString('utf8'));
    o = p + len;
  }
  return out;
}
