# App loading, mirrors, and launch diagnostics

NakliOS keeps standalone app repositories authoritative. Cross-origin, sandboxed
iframes are the default; a copy under `apps/<id>/` is an exceptional deployment
artifact, not a fork.

## Placement decision

Use the smallest trust level that works:

1. **Cross-origin sandbox (default):** for standalone web apps that work through
   normal browser APIs or the `naklios.*` bridge.
2. **Same-origin mirror:** only when a first-party app needs a capability that
   cannot work in the sandbox, such as a browser picker requiring same-origin
   integration. Performance alone is not a reason to remove the sandbox.
3. **System app:** only for host-critical surfaces maintained in the NakliOS
   repository, such as Files and Notes.
4. **New tab / Basic mode:** for apps that cannot safely or reliably run in an
   iframe.

Every mirror is declared in `apps/manifest.json`, resolved to an immutable
upstream commit in `apps/manifest.lock.json`, and hash-checked. Run:

```sh
node scripts/validate-mirrors.mjs
node scripts/audit-app-inventory.mjs
```

The second command also rejects catalog/URL drift, undeclared on-disk apps, and
extra files left in a mirrored directory. The scheduled sync workflow opens a
reviewable pull request; it never treats the checked-in copy as the source.

## Measuring launch readiness

Each open window records process-local `load`, cooperative `naklios:ready`, and
fallback-reveal timings. App Info shows these values. For repeatable inspection,
the console API returns a frozen, content-free snapshot:

```js
nakliOS.launchDiagnostics()
```

The current warning thresholds are:

- browser `load` later than 4 seconds;
- cooperative `ready` later than 8 seconds;
- skeleton fallback at 15 seconds.

These are investigation triggers, not automatic mirror criteria. Test cold loads
with the browser cache disabled and warm loads separately. A slow cross-origin
app should first reduce its critical assets, emit `naklios:ready` when usable,
and use a useful loading shell. Mirroring is considered only if a required
capability cannot otherwise work.

The immutable snapshot contains app id/name, origin plus pathname (never query
strings or fragments), sandbox state, timings, and a coarse status. It never
records credentials, document contents, or persistent user identifiers. When a
cooperative app reports ready within budget, a later browser `load` event does
not reclassify that usable launch as slow.

## Source-side automation

Source repositories may dispatch the NakliOS `Sync app mirrors` workflow after a
release. Dispatch needs a narrowly scoped repository secret. If it is absent,
the source workflow succeeds with a visible explanation and NakliOS discovers
the release through its six-hour scheduled sync. Credential and repository
permission changes are always manual stop-lines.
