# Vendored LocalMind inference runtime

NakliOS owns the app-facing inference broker, while LocalMind owns the model
runtime. The checked-in JavaScript files in this directory are exact copies
from the LocalMind commit and hashes recorded in `manifest.json`. This includes
the chat workers, conservative model catalog, and the generated Bonsai
FLUX.2-Klein image worker.

To update the runtime:

1. update and test LocalMind first;
2. copy every file listed in `manifest.json` from that tagged commit;
3. update the commit and SHA-256 values in `manifest.json`;
4. run `node scripts/test-localmind-vendor.mjs` and the NakliOS test suite.

Do not patch the vendored files only in NakliOS. Runtime changes belong
upstream in LocalMind so the workbench and operating system cannot drift.
