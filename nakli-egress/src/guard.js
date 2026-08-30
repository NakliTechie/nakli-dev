// EgressGuard — a single Durable Object that gives the relay STRONGLY-CONSISTENT,
// cross-isolate state the in-isolate best-effort maps can't:
//   - replay protection: a nonce is recorded once and rejected on reuse, across
//     every isolate/colo (the per-isolate Map only caught same-isolate replays).
//   - rate + byte budget: a per-minute ceiling on authenticated egress, so a
//     leaked secret can't drive unbounded calls/bytes on the user's CF account.
//
// One instance (idFromName('guard')) serves the single tenant. DO fetch handlers
// are serialized per instance, so the check-then-record is atomic with no locking.
// Called ONLY after the Worker has verified the HMAC signature — unauthenticated
// requests never reach it.

export class EgressGuard {
  constructor(state) { this.state = state; }

  async fetch(request) {
    let body;
    try { body = await request.json(); } catch (_) { body = {}; }
    const {
      nonce,
      nonceTtlMs = 6 * 60 * 1000,
      bytes = 0,
      maxPerMin = 600,
      maxBytesPerMin = 500 * 1024 * 1024,
    } = body || {};
    const now = Date.now();
    const store = this.state.storage;

    // ── rate + byte window (fixed 60s bucket) ──
    let rate = await store.get('rate');
    if (!rate || now - rate.start >= 60_000) rate = { start: now, count: 0, bytes: 0 };
    if (rate.count + 1 > maxPerMin || rate.bytes + bytes > maxBytesPerMin) {
      return reply({ ok: false, reason: 'rate limited' });
    }

    // ── replay: reject a reused, unexpired nonce ──
    if (nonce) {
      const key = 'n:' + String(nonce);
      const exp = await store.get(key);
      if (typeof exp === 'number' && exp > now) return reply({ ok: false, reason: 'replayed nonce' });
      await store.put(key, now + nonceTtlMs);
    }

    // commit the rate window only for an accepted request
    rate.count += 1;
    rate.bytes += bytes;
    await store.put('rate', rate);

    // opportunistic bounded sweep so the nonce set doesn't grow forever
    await this._sweep(store, now);
    return reply({ ok: true });
  }

  async _sweep(store, now) {
    try {
      const list = await store.list({ prefix: 'n:', limit: 64 });
      const dead = [];
      for (const [k, v] of list) if (typeof v === 'number' && v <= now) dead.push(k);
      if (dead.length) await store.delete(dead);
    } catch (_) {}
  }
}

function reply(obj) {
  return new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });
}
