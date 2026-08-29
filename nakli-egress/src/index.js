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

const NONCE_TTL_MS = 6 * 60 * 1000;      // a hair over the ts window
const seen = new Map();                  // nonce -> expiry (best-effort, per-isolate)

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

    let envelope;
    try { envelope = await request.json(); } catch (_) { return json({ ok: false, error: 'bad json' }, 400, cors); }

    const now = Date.now();
    const v = await verifyEnvelope(envelope, env.EGRESS_SECRET, {
      now,
      seenNonce: (n) => {
        for (const [k, exp] of seen) if (exp < now) seen.delete(k); // sweep
        if (seen.has(n)) return true;
        seen.set(n, now + NONCE_TTL_MS);
        return false;
      },
    });
    if (!v.ok) return json({ ok: false, error: 'unauthorized: ' + v.reason }, 401, cors);

    const { url, method, headers, bodyBytes } = v.req;
    if (!hostAllowed(url, allowlist)) return json({ ok: false, error: 'destination not allowed: ' + hostForLog(url) }, 403, cors);

    // Forward headers verbatim (incl. Authorization) minus hop-by-hop; let fetch
    // set host/content-length. NEVER log headers or bodies.
    const fwd = new Headers();
    for (const [k, val] of Object.entries(headers || {})) {
      if (!HOP_BY_HOP.has(String(k).toLowerCase())) fwd.set(k, val);
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

    // A redirect is returned to the client (with the Location) rather than
    // followed, so the client can re-issue through the same allowlisted path.
    const outHeaders = {};
    for (const [k, val] of upstream.headers) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = val;
    }
    const respBytes = new Uint8Array(await upstream.arrayBuffer());
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
