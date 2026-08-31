# Loopback TLS certificate

The hosted prototype uses a locally trusted certificate for `local.naklios.dev`,
which resolves to `127.0.0.1`.

Keep the certificate and key out of git. The repository ignores `*.pem` under
`prototypes/`.

Create a unique certificate with the branded helper:

```sh
sh prototypes/compos/setup-local-tls.sh
```

The helper requires `mkcert`. It explicitly installs the local mkcert CA into
the machine trust store, then writes `certs/cert.pem` and `certs/key.pem`.

The relay accepts either pair:

- `certs/fullchain.pem` and `certs/privkey.pem`
- `certs/cert.pem` and `certs/key.pem`

Explicit paths override both:

```sh
TLS_CERT=/path/to/fullchain.pem TLS_KEY=/path/to/privkey.pem \
  node prototypes/compos/compos-relay.mjs
```
