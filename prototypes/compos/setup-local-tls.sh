#!/bin/sh
set -eu

if ! command -v mkcert >/dev/null 2>&1; then
  echo 'mkcert is required: https://github.com/FiloSottile/mkcert#installation' >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cert_dir="$script_dir/certs"
mkdir -p "$cert_dir"

echo 'Installing the local mkcert CA into this machine trust store.'
mkcert -install
mkcert \
  -cert-file "$cert_dir/cert.pem" \
  -key-file "$cert_dir/key.pem" \
  local.naklios.dev
chmod 600 "$cert_dir/key.pem"

echo "Created $cert_dir/cert.pem and $cert_dir/key.pem"
echo 'Run: node compos-relay.mjs'
