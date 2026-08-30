# Bundled cert — `local.naklios.dev` (pattern A)

The bridge serves `wss://local.naklios.dev:9130` using a **real Let's Encrypt
cert** for `local.naklios.dev`, a public DNS name that resolves to `127.0.0.1`
(every machine's own loopback). This is what lets `https://naklios.dev` reach a
user's local daemon with **no per-user cert install** (the Plex/Discord pattern).

## What lives here (at runtime / in the release — NOT in git source)

- `fullchain.pem` — the LE cert chain for `local.naklios.dev`
- `privkey.pem` — its private key

Both are **gitignored** (`prototypes/**/*.pem`). They are **not** in the public
source repo — committing a key to a public repo would trip secret scanning and
paint a target on it. They ship in the **release/package** instead (npm tarball /
binary), which is what "bundle in the distribution" means.

The bridge auto-loads them from this dir when `TLS_CERT`/`TLS_KEY` aren't set.

## Is the key secret? No — and that's fine

This key is **deliberately public**: it travels to every user. That is safe
because the cert only certifies `local.naklios.dev` → `127.0.0.1`. Traffic to
that name **never leaves the user's machine** (it loops back), so there is **no
network path to intercept** — the classic "steal the key, MITM users" attack does
not apply. Anyone can obtain the key; it lets them run a browser-trusted service
on *their own* loopback, which is exactly (and only) the intended use.

## The one real cost: revocation → rotation

A key known to be public may be **revoked** by the CA (this has happened to Plex,
Discord, Spotify). When that happens, re-issue and re-ship:

```bash
export CF_API_TOKEN=<Cloudflare token: Zone:DNS:Edit on naklios.dev>
bash ../setup-cert.sh          # re-issues → tls/{cert,key}.pem
cp ../tls/cert.pem fullchain.pem && cp ../tls/key.pem privkey.pem
# then rebuild + republish the bridge package
```

LE certs are valid 90 days, so plan a rotation regardless. Automate with the CF
DNS-01 token (`setup-cert.sh`) rather than the manual TXT flow when unattended.

## The scale path (see IDEAS.md)

When this gets big, replace the single shared key with **per-install short-lived
certs** minted by a naklios-run issuing service — no shared public key at all.
Logged as the option-3 future in IDEAS.md.
