# Vendored: Crate ESM API, v1.0.2

Source: [`NakliTechie/crate`](https://github.com/NakliTechie/crate) at tag `v1.0.2`.

These are the headless ESM modules that fulfil `Crate.open()` /
`Crate.bootstrap()` + the 9-method API surface (list / read / write / remove /
move / mkdir / stat / history / onChange). The host loads them dynamically the
first time the user clicks "Connect Crate" in Settings, instantiates `Crate`
under the user's bucket + passphrase, and routes `naklios.fs.*` RPCs to it.

Subset rationale — we deliberately do NOT vendor:

| Skipped | Why |
|---|---|
| `folder.js`, `onboarding.js`, `entrypoint.js` | UI; nakliOS doesn't render the crate wizard or folder browser |
| `qr.js`, `wordlist.js`, `entropy.js`, `clipboard.js` | UI / utilities for the wizard; nakliOS does its own UI |
| `export.js`, `vendor/client-zip/` | Folder export; if users want this they can open the standalone app at crate.naklios.dev |

Changes from v1.0.1 in this drop:

- **New** `manifest-flush.js` — `crate.js` now delegates its flush logic to this shared module (eliminates a duplicate that drifted in v1.0.0 → v1.0.1). The module also receives the H2 anchor checks that were previously only in `crate.js`'s inline copy.
- **Modified** `crate.js` — `_flushManifest` is now a thin delegate. Other paths (`open`, `bootstrap`) unchanged.

To upgrade: copy the next stable tag's files into `vendor/crate/<tag>/` and
bump the import path in `index.html`. Pin to a single tag at a time — the
ESM API is the integration contract; no floating versions.

License: AGPL-3.0-or-later (same as crate itself).
