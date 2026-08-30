#!/usr/bin/env bash
# setup-cert.sh — the one credentialed step of pattern B (loopback + real cert).
#
# Run this YOURSELF with your Cloudflare token (Claude never sees it). It:
#   1. creates the DNS record  local.naklios.dev  A  127.0.0.1  (DNS-only)
#   2. issues a REAL Let's Encrypt cert for that name via DNS-01
#   3. drops cert.pem + key.pem in ./tls/ for the wss bridge
#
# The result: naklios.dev (https) → wss://local.naklios.dev:9130 → your local
# daemon, with a browser-trusted cert and ZERO per-user cert install.
#
# Prereqs: a Cloudflare API token with Zone:DNS:Edit + Zone:Read on naklios.dev.
#   Create at: https://dash.cloudflare.com/profile/api-tokens (template
#   "Edit zone DNS", scoped to naklios.dev). Then:
#     export CF_API_TOKEN=<your-token>
#     bash setup-cert.sh
#
# Idempotent: re-running updates the record + renews the cert.
set -euo pipefail

ZONE="${CF_ZONE:-naklios.dev}"
NAME="${CF_NAME:-local.naklios.dev}"
IP="127.0.0.1"
OUT="$(cd "$(dirname "$0")" && pwd)/tls"
: "${CF_API_TOKEN:?export CF_API_TOKEN=<Cloudflare token with Zone:DNS:Edit on $ZONE>}"

api() { curl -sS -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" "$@"; }

echo "→ resolving zone id for $ZONE"
ZID=$(api "https://api.cloudflare.com/client/v4/zones?name=$ZONE" | sed -n 's/.*"id":"\([0-9a-f]\{32\}\)".*/\1/p' | head -1)
[ -n "$ZID" ] || { echo "could not resolve zone id — is the token scoped to $ZONE?"; exit 1; }

echo "→ ensuring DNS: $NAME A $IP (DNS-only)"
REC=$(api "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records?type=A&name=$NAME")
RID=$(echo "$REC" | sed -n 's/.*"id":"\([0-9a-f]\{32\}\)".*/\1/p' | head -1)
BODY="{\"type\":\"A\",\"name\":\"$NAME\",\"content\":\"$IP\",\"ttl\":120,\"proxied\":false}"
if [ -n "$RID" ]; then
  api -X PUT "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records/$RID" --data "$BODY" >/dev/null
  echo "  updated existing record"
else
  api -X POST "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records" --data "$BODY" >/dev/null
  echo "  created record"
fi

echo "→ ensuring acme.sh (pure-shell ACME client)"
ACME="$HOME/.acme.sh/acme.sh"
[ -x "$ACME" ] || { curl -s https://get.acme.sh | sh -s email="admin@$ZONE" >/dev/null; }

echo "→ issuing Let's Encrypt cert for $NAME via DNS-01 (Cloudflare)"
CF_Token="$CF_API_TOKEN" "$ACME" --issue --server letsencrypt --dns dns_cf -d "$NAME" --keylength 2048 || {
  # --issue exits non-zero if the cert is still valid; that's fine.
  echo "  (issue step returned non-zero — usually 'cert not yet due for renewal', continuing)"
}

echo "→ installing cert → $OUT"
mkdir -p "$OUT"
"$ACME" --install-cert -d "$NAME" \
  --key-file "$OUT/key.pem" \
  --fullchain-file "$OUT/cert.pem"

echo
echo "done. verify DNS + run the bridge in wss mode:"
echo "  dig +short $NAME            # → $IP"
echo "  TLS_CERT=$OUT/cert.pem TLS_KEY=$OUT/key.pem \\"
echo "    node prototypes/aimax-renderer/bridge.mjs ~/.aimax/sock 9130"
echo "then open https://naklios.dev/prototypes/aimax-renderer/aimax → Connect (wss://$NAME:9130)"
