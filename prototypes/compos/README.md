# NakliOS · Compos prototype

This is the canonical NakliOS prototype for
[`svs/compos`](https://github.com/svs/compos). NakliOS embeds Compos's native
Phoenix LiveView client. Compos remains authoritative for buffers, windows,
agents, commands, persistence, and rendering.

The upstream revision reviewed for this prototype is
`5928e8ccb60cab0b8747468ec4277623b665a2d0`.

## Components

- `index.html` — hosted connection and pairing surface.
- `guide.html` — user onboarding and troubleshooting.
- `compos-relay.mjs` — paired loopback HTTP and WebSocket reverse proxy.
- `setup-local-tls.sh` — explicit `mkcert` setup for a per-install certificate.
- `relay-worker.mjs` — Cloudflare Worker entrypoint for the downloads.
- `relay-worker-core.mjs` — Worker routing and response policy.
- `wrangler.jsonc` — `compos-relay.naklios.dev` deployment configuration.

## Architecture

```text
naklios.dev/prototypes/compos/
        │ HTTPS iframe + one-time pairing
        ▼
local.naklios.dev:9130
  nakli-compos-relay (loopback only)
        │ HTTP + WebSocket reverse proxy
        ▼
127.0.0.1:4004
  Compos Phoenix LiveView
```

The relay does not expose `~/.compos/sock`. Compos documents that JSON-RPC
socket as unauthenticated and capable of `eval`; it remains local.

## User quick start

Start Compos:

```sh
git clone https://github.com/svs/compos
cd compos
mix deps.get
mix run --no-halt
```

In another terminal, download the branded artifacts, establish a local trust
root, and run the relay:

```sh
curl -fsSLO https://compos-relay.naklios.dev/compos-relay.mjs
curl -fsSLO https://compos-relay.naklios.dev/setup-local-tls.sh
sh setup-local-tls.sh
node compos-relay.mjs
```

Open `https://naklios.dev/prototypes/compos/` and paste the pairing code printed
by the relay.

## Relay security contract

- The relay binds to `127.0.0.1` by default.
- The pairing code contains 128 random bits unless the operator supplies
  `NAKLI_BRIDGE_PAIR_TOKEN`.
- The first valid `?pair=` request consumes the pairing code.
- Pairing creates one in-memory session and redirects to a URL without the code.
- The browser receives an HttpOnly, SameSite=Strict session cookie.
- Every proxied HTTP request and WebSocket upgrade requires that session.
- Requests carrying an Origin must match the configured allowlist.
- Private Network Access preflights expose no Compos capability.
- The relay rewrites the upstream Origin to Compos's loopback origin.

## Run from this checkout

The repository copy contains no certificate or private key. Provide the
browser-trusted `local.naklios.dev` certificate through file paths:

```sh
TLS_CERT=/path/to/fullchain.pem TLS_KEY=/path/to/privkey.pem \
  node prototypes/compos/compos-relay.mjs
```

For local HTTP development:

```sh
DISABLE_TLS=1 node prototypes/compos/compos-relay.mjs --port 9130
```

## Publish the relay artifacts

The Worker imports `compos-relay.mjs` and `setup-local-tls.sh` as text modules.
It serves public source only. It has no bindings and receives no certificate or
private key. Each installation uses `mkcert` to create a unique certificate
under a locally trusted CA.

Validate and deploy:

```sh
npx --yes wrangler@latest deploy --dry-run \
  --config prototypes/compos/wrangler.jsonc
npx --yes wrangler@latest deploy \
  --config prototypes/compos/wrangler.jsonc
```

## Verification

```sh
node --test prototypes/compos/bridge.test.mjs
node --test prototypes/compos/relay-worker.test.mjs
node scripts/verify-delivery.mjs
```

The release acceptance gate starts a real Compos daemon, pairs through the TLS
relay, edits one buffer, reloads the frame, and checks that Compos retained its
buffer and window state.

## License boundary

Compos is GPL-3.0. NakliOS does not copy or vendor Compos source. This prototype
interoperates with a separately installed local process over its native HTTP and
WebSocket client surface.
