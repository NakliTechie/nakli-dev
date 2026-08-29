# nakli-egress

A **sovereign, single-tenant egress relay** for NakliOS — a Cloudflare Worker *you*
own and deploy, that forwards one cross-origin HTTP request the browser's Same-Origin
Policy blocks (git push, arbitrary fetch, no-CORS APIs). naklios never proxies your
traffic; it goes through your own Worker.

See `../plan/egress-transport-spec.md` for the full design. This is consumed by the
`naklios.net.fetch` SDK transport, routed by the NakliOS host.

## Security model (all in `src/lib.js`, unit-tested)

- **Signed envelope** — every request carries `HMAC-SHA256(EGRESS_SECRET, canonical)`
  where canonical = `method\nurl\nsorted-headers\nbodySHA256\nnonce\nts`. The Worker
  rejects a bad signature, a stale timestamp (±5 min), or a replayed nonce.
- **Destination allowlist** — default-deny; only hosts you list are reachable.
- **SSRF guard** — private/loopback/metadata IP literals blocked even if a rule is loose.
- **Stateless** — no logging of request/response bodies or the `Authorization` header.
- **Scoped CORS** — only your NakliOS origin(s), never `*`.

## Deploy (your own Cloudflare account)

```bash
cd nakli-egress
npx wrangler deploy                         # deploys to nakli-egress.<you>.workers.dev
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" \
  | npx wrangler secret put EGRESS_SECRET    # the shared secret
```

Then in NakliOS → Settings → set the egress **Worker URL** and the **same secret**.
Optionally set `ALLOWLIST` / `ALLOW_ORIGINS` vars in `wrangler.jsonc` (defaults cover
GitHub + GitLab and the `https://naklios.dev` origin).

## Test

```bash
node test/lib.test.mjs      # security core, no network
```

The Worker never stores anything; deleting it revokes egress instantly.
