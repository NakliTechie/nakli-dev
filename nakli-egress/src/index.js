// nakli-egress — a sovereign, single-tenant egress relay (Cloudflare Worker).
//
// Forwards ONE cross-origin HTTP request the browser's Same-Origin Policy blocks
// (git push, arbitrary fetch, no-CORS APIs), on behalf of the app running in
// NakliOS. It is the USER'S OWN Worker (their CF account); naklios never proxies
// anyone's traffic. See plan/egress-transport-spec.md.
//
// Security (all in src/lib.js, unit-tested):
//   - signed envelope: HMAC-SHA256(EGRESS_SECRET, canonical(method,url,headers,
//     bodyHash,nonce,ts)); reject bad sig / stale ts (±5min) / replayed nonce.
//   - destination allowlist (default-deny) + SSRF literal-IP block.
//   - stateless: NO logging of bodies or the Authorization header.
//   - CORS scoped to the configured origins, not '*'.

import { verifyEnvelope, hostAllowed, HOP_BY_HOP, bytesToB64 } from './lib.js';
import { EgressGuard } from './guard.js';
export { EgressGuard }; // the Worker runtime needs the DO class exported from the entry

const NONCE_TTL_MS = 6 * 60 * 1000;      // a hair over the ts window
const seen = new Map();                  // nonce -> expiry (fallback when no DO binding)

const MAX_REQ_BYTES = 25 * 1024 * 1024;  // reject request bodies over 25 MB
const MAX_RESP_BYTES = 50 * 1024 * 1024; // abort upstream responses over 50 MB
const MAX_BYTES_PER_MIN = 500 * 1024 * 1024; // global per-minute byte budget (DO)
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

// Per-isolate throughput brake — a cheap first line that bounds a flood's cost
// per isolate. The GLOBAL, cross-isolate rate + nonce enforcement lives in the
// EgressGuard Durable Object (below); this stays as the no-DO fallback.
const RATE_MAX_PER_MIN = 600;
const rate = { count: 0, resetAt: 0 };
function rateTrip(now) {
  if (now > rate.resetAt) { rate.count = 0; rate.resetAt = now + 60_000; }
  rate.count += 1;
  return rate.count > RATE_MAX_PER_MIN;
}

// Read an upstream body with a hard byte cap, so a huge response can't OOM the
// isolate. Returns null if the cap is exceeded.
async function readCapped(resp, max) {
  if (!resp.body) return new Uint8Array(0);
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { try { await reader.cancel(); } catch (_) {} return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function corsHeaders(origin, allowOrigins) {
  const ok = allowOrigins.includes(origin) || allowOrigins.includes('*');
  return {
    'access-control-allow-origin': ok ? origin : allowOrigins[0] || 'https://naklios.dev',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    'vary': 'origin',
  };
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'content-type': 'application/json' }, extra || {}),
  });
}

function parseList(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export default {
  async fetch(request, env) {
    const allowOrigins = parseList(env.ALLOW_ORIGINS || 'https://naklios.dev');
    const origin = request.headers.get('origin') || '';
    const cors = corsHeaders(origin, allowOrigins);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') return json({ ok: true, service: 'nakli-egress', ready: !!env.EGRESS_SECRET }, 200, cors);
    if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405, cors);

    if (!env.EGRESS_SECRET) return json({ ok: false, error: 'worker not configured (EGRESS_SECRET unset)' }, 500, cors);
    const allowlist = parseList(env.ALLOWLIST || 'github.com,*.github.com,*.githubusercontent.com,gitlab.com');

    const now = Date.now();
    if (rateTrip(now)) return json({ ok: false, error: 'rate limited' }, 429, cors);

    // Reject an oversized request body before reading it into memory.
    const clen = Number(request.headers.get('content-length') || 0);
    if (clen && clen > MAX_REQ_BYTES) return json({ ok: false, error: 'request too large' }, 413, cors);

    let envelope;
    try { envelope = await request.json(); } catch (_) { return json({ ok: false, error: 'bad json' }, 400, cors); }

    // Nonce (+ the global rate limit) is enforced by the EgressGuard DO after the
    // signature verifies. Only when there's no DO binding do we fall back to the
    // per-isolate `seen` map inside verifyEnvelope.
    const useDO = !!env.EGRESS_GUARD;
    let v;
    try {
      v = await verifyEnvelope(envelope, env.EGRESS_SECRET, {
        now,
        seenNonce: useDO ? undefined : (n) => {
          for (const [k, exp] of seen) if (exp < now) seen.delete(k); // sweep
          if (seen.has(n)) return true;
          seen.set(n, now + NONCE_TTL_MS);
          return false;
        },
      });
    } catch (_) { return json({ ok: false, error: 'bad request' }, 400, cors); }
    if (!v.ok) return json({ ok: false, error: 'unauthorized: ' + v.reason }, 401, cors);

    const { url, method, headers, bodyBytes } = v.req;
    if (!ALLOWED_METHODS.has(String(method).toUpperCase())) return json({ ok: false, error: 'method not allowed' }, 405, cors);
    if (!hostAllowed(url, allowlist)) return json({ ok: false, error: 'destination not allowed: ' + hostForLog(url) }, 403, cors);
    if (bodyBytes && bodyBytes.length > MAX_REQ_BYTES) return json({ ok: false, error: 'request too large' }, 413, cors);

    // Build the forwarded headers verbatim (incl. Authorization) minus hop-by-hop;
    // a bad value (CRLF) makes Headers.set throw — caught as a clean 400, never
    // smuggled upstream. NEVER log headers or bodies.
    const fwd = new Headers();
    let hasAuth = false;
    try {
      for (const [k, val] of Object.entries(headers || {})) {
        const lk = String(k).toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;
        if (lk === 'authorization') hasAuth = true;
        fwd.set(k, val);
      }
    } catch (_) { return json({ ok: false, error: 'invalid header' }, 400, cors); }

    // Refuse to egress credentials over cleartext http (downgrade footgun).
    if (hasAuth) {
      let proto = ''; try { proto = new URL(url).protocol; } catch (_) {}
      if (proto !== 'https:') return json({ ok: false, error: 'credentialed request must use https' }, 400, cors);
    }

    // GLOBAL, cross-isolate replay + rate/byte enforcement (the authenticated path).
    // One serialized DO instance is the single source of truth; on a DO error we
    // fail CLOSED (reject) rather than silently drop the guarantee.
    if (useDO) {
      try {
        const stub = env.EGRESS_GUARD.get(env.EGRESS_GUARD.idFromName('guard'));
        const gr = await stub.fetch('https://guard/check', {
          method: 'POST',
          body: JSON.stringify({
            nonce: envelope.nonce,
            nonceTtlMs: NONCE_TTL_MS,
            bytes: bodyBytes ? bodyBytes.length : 0,
            maxPerMin: RATE_MAX_PER_MIN,
            maxBytesPerMin: MAX_BYTES_PER_MIN,
          }),
        });
        const gj = await gr.json();
        if (!gj.ok) {
          const limited = gj.reason === 'rate limited';
          return json({ ok: false, error: limited ? 'rate limited' : ('unauthorized: ' + gj.reason) }, limited ? 429 : 401, cors);
        }
      } catch (_) {
        return json({ ok: false, error: 'guard unavailable' }, 503, cors);
      }
    }

    let upstream;
    try {
      upstream = await fetch(url, {
        method,
        headers: fwd,
        body: (method === 'GET' || method === 'HEAD') ? undefined : bodyBytes,
        redirect: 'manual', // don't silently follow off-allowlist redirects
      });
    } catch (e) {
      return json({ ok: false, error: 'upstream fetch failed: ' + (e && e.message || e) }, 502, cors);
    }

    // Read the response under a hard byte cap so a huge upstream can't OOM us.
    const respBytes = await readCapped(upstream, MAX_RESP_BYTES);
    if (respBytes === null) return json({ ok: false, error: 'upstream response too large' }, 502, cors);

    // A redirect is returned to the client (with the Location) rather than
    // followed, so the client can re-issue through the same allowlisted path.
    // Drop Set-Cookie — never surface an upstream's cookies to the calling app.
    const outHeaders = {};
    for (const [k, val] of upstream.headers) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk) || lk === 'set-cookie') continue;
      outHeaders[k] = val;
    }
    return json({
      ok: true,
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
      body: bytesToB64(respBytes),
    }, 200, cors);
  },
};

function hostForLog(u) { try { return new URL(u).hostname; } catch (_) { return '?'; } }
