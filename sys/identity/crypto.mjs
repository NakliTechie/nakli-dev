// Identity — crypto primitives (WebCrypto only; isomorphic Node 20+/browser, no
// dependency). Ed25519 for principal signatures; HMAC-SHA256 for macaroon-style
// grant chains; SHA-256 for ids and history hashes. Confirmed available in Node v22.

const subtle = globalThis.crypto.subtle;

// ── base64url (Uint8Array <-> string), url-safe, unpadded ─────────────────────
export function b64uEncode(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = (s) => new TextEncoder().encode(String(s));

export async function sha256(bytes) {
  const b = typeof bytes === 'string' ? enc(bytes) : bytes;
  return new Uint8Array(await subtle.digest('SHA-256', b));
}
export async function sha256Hex(bytes) {
  const h = await sha256(bytes);
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function randomBytes(n) { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; }

// ── Ed25519 (principal signatures) ────────────────────────────────────────────
export async function generateSigningKeypair() {
  return subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
}
export async function exportRawPub(publicKey) { return new Uint8Array(await subtle.exportKey('raw', publicKey)); }
export async function importRawPub(raw) { return subtle.importKey('raw', raw instanceof Uint8Array ? raw : b64uDecode(raw), { name: 'Ed25519' }, true, ['verify']); }
export async function exportPkcs8(privateKey) { return new Uint8Array(await subtle.exportKey('pkcs8', privateKey)); }
export async function importPkcs8(raw) { return subtle.importKey('pkcs8', raw instanceof Uint8Array ? raw : b64uDecode(raw), { name: 'Ed25519' }, true, ['sign']); }
export async function sign(privateKey, bytes) { return new Uint8Array(await subtle.sign({ name: 'Ed25519' }, privateKey, typeof bytes === 'string' ? enc(bytes) : bytes)); }
export async function verify(publicKey, sig, bytes) {
  const pk = (publicKey && publicKey.type) ? publicKey : await importRawPub(publicKey);
  return subtle.verify({ name: 'Ed25519' }, pk, sig instanceof Uint8Array ? sig : b64uDecode(sig), typeof bytes === 'string' ? enc(bytes) : bytes);
}

// ── HMAC-SHA256 (macaroon caveat chain) ──────────────────────────────────────
export async function hmac(keyBytes, bytes) {
  const key = await subtle.importKey('raw', keyBytes instanceof Uint8Array ? keyBytes : b64uDecode(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, typeof bytes === 'string' ? enc(bytes) : bytes));
}

// Constant-time compare (both must be Uint8Array of equal length to match).
export function constantTimeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
