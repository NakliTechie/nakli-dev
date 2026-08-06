# isomorphic-git — vendored, pinned

- **Version:** 1.40.0 (MIT). Upstream: https://github.com/isomorphic-git/isomorphic-git
- **`isomorphic-git.mjs`** — the full library, bundled to a single self-contained
  ESM (esbuild `--bundle --format=esm --platform=browser`), with a `Buffer`
  polyfill injected (`buffer` npm package) so it needs no global Buffer in the
  browser. All 8 upstream deps (async-lock, sha.js, crc-32, pako, pify, ignore,
  clean-git-ref, diff3) are inlined.
- **`http-web.mjs`** — the browser smart-HTTP client (`makeHttpClient`), bundled
  the same way. Used only by real Transports; FakeTransport does not need it.

**Do not fork or hand-edit.** Rig uses it through an fs adapter only
(`sys/rig/git/fs-adapter.mjs`). To rebump: re-run the esbuild bundle from the
pinned npm tarball; do not patch these files in place.

The C2 checkpoint (init/add/commit/log/statusMatrix over the adapter) is the
regression gate for a rebump.
