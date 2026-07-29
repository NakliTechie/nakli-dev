# NakliOS app contract

This is the stable integration boundary between NakliOS and a cooperative app.
Apps remain ordinary browser applications. When hosted in a NakliOS window,
`sdk/naklios.js` adds lifecycle, theme, and app-scoped filesystem services.
The same source may continue to run standalone.

## Product spelling

The product name is **NakliOS**. The JavaScript global and message prefix are
lowercase `naklios`.

## Loading the SDK

Bundled system apps use the checked-in SDK:

```html
<script src="../../sdk/naklios.js"></script>
```

Standalone applications can vendor the same file or load the published copy.
The SDK is a no-op outside an iframe; `naklios.capabilities.hosted` identifies
the hosted case.

## Lifecycle

Call these after installing the app's listeners:

```js
naklios.theme.onChange(applyTheme);
naklios.onCapabilitiesChange(renderStorage);
naklios.ready();
naklios.theme.request();
naklios.requestCapabilities();
```

The lifecycle surface is:

- `naklios.ready()` — the app is interactive; NakliOS may remove its loading
  cover.
- `naklios.title(text)` — update the host window title.
- `naklios.close()` — request that NakliOS close the app window.
- `naklios.beforeClose(callback)` — register cleanup or pending-save work.
  The callback may return a Promise. Current hosts wait for it, with a bounded
  five-second fallback, before removing the iframe.

An app should still autosave during ordinary editing. `beforeClose` is the
last small durability barrier, not the primary persistence mechanism.

## Theme

`naklios.theme.onChange(callback)` receives:

```js
{
  id: "paper",
  mood: "warm",
  colors: {
    BODY: "#faf2e2",
    PANEL: "#fdf8ec",
    INK: "#2c1810",
    BRAND: "#c8512a",
    ACT: "#2a4a8a",
    OK: "#5a7a30",
    ROW: "#f0e2c8"
  }
}
```

Map these tokens into app-owned CSS variables. Do not assume every theme is
dark or that `BRAND` has sufficient contrast as body text.

## Capabilities

`naklios.capabilities` is mutated in place:

```js
{
  hosted: true,
  version: 1,
  fs: true,
  fsBackends: [
    { id: "fsa", label: "Folder", name: "NakliOS" },
    { id: "crate", label: "Crate", name: "personal" }
  ],
  fsBackend: "crate"
}
```

Use `naklios.onCapabilitiesChange(callback)` rather than reading it only once.
Folder permissions can expire and a Crate can be locked while the app is open.

## Filesystem

All paths are relative to `apps/<app-id>/` on the backend chosen for that app.
The host rejects traversal and stale-backend operations.

```js
await naklios.fs.write("library.json", JSON.stringify(library));
const library = JSON.parse(await naklios.fs.read("library.json"));
const files = await naklios.fs.list("notes");
const exists = await naklios.fs.exists("notes/one.md");
await naklios.fs.delete("notes/one.md");
```

Available methods:

- `read(path)` and `readBinary(path)`
- `write(path, stringOrBytes)`
- `append(path, line)`
- `list(prefix)`
- `exists(path)`
- `delete(path)`
- `useBackend("fsa" | "crate")`
- `subscribe(path, callback)`

`useBackend()` always goes through host confirmation. It changes the app's
view; it does not copy or delete data.

Every filesystem request carries the backend visible when it was issued.
NakliOS rejects the request if the app is rebound before the operation is
processed. Apps should surface the error and retry only after re-reading
capabilities.

## Storage locations are separate

Browser, Folder, and Crate are distinct libraries:

- **Browser** — app-owned IndexedDB or OPFS on this browser profile.
- **Folder** — the user-selected local NakliOS directory.
- **Crate** — the user's end-to-end-encrypted cloud filesystem.

Switching locations must never silently migrate, merge, overwrite, or delete
data. If an app offers import or copy, name the source and destination and
make it a separate explicit action.

An app that supports Browser storage owns that adapter itself. NakliOS provides
only Folder and Crate through `naklios.fs`.

## Change subscriptions

```js
const stop = await naklios.fs.subscribe("", event => {
  // event: { op, path, from?, to?, size?, backend, source? }
  // source === "remote" identifies a Crate change received elsewhere.
  refreshFromStorage(event);
});

// When changing location or tearing down:
stop();
```

Crate forwards its native `onChange` stream. Folder changes are detected by a
lightweight two-second metadata poll because the browser File System Access
API does not yet expose a widely supported change observer.

Subscriptions are app-scoped and backend-affine. They end when the window
closes or its backend changes. Apps should resubscribe after loading the new
location.

Do not overwrite a dirty editor automatically when a change arrives. Offer an
explicit reload/keep-mine/later decision. Clean views may refresh
automatically.

## Persistence conventions

Prefer inspectable, recoverable formats:

- JSON for indexes and metadata.
- Markdown or plain text for authored content.
- JSONL for append-only event streams.
- Separate binary files rather than data URLs inside JSON.

Serialize writes that can touch the same logical record. Write content and
metadata before updating the index that advertises the record. Keep a recovery
path for an interrupted write.

Notes v1 is the reference implementation:

```text
apps/notes/
├── library.json
└── notes/
    ├── <note-id>.md
    └── <note-id>.json
```

## Security boundary

The app never receives Folder handles, Crate credentials, bucket configuration,
or the encryption key. It receives only the scoped RPC surface.

The host derives the app identity from the iframe window it created, not from
an app-supplied ID. Apps cannot escape `apps/<app-id>/` through filesystem
paths.

Cross-origin apps remain sandboxed. Same-origin mirrors are reserved for
bundled system apps or locked standalone-app artifacts that need that
capability; immutable mirror provenance is recorded in
`apps/manifest.lock.json`.

## Minimum acceptance gate

A stateful cooperative app should prove:

1. Standalone fallback remains usable, or the UI clearly says it requires
   NakliOS.
2. Folder and Crate contain separate data and switching copies nothing.
3. Autosave survives reload and an immediate window close.
4. A backend disconnect does not silently discard a dirty record.
5. Remote changes refresh a clean view and require an explicit decision for a
   dirty view.
6. Paths remain inside the app namespace.
7. Styled dialogs replace native `alert`, `confirm`, and `prompt`.
8. Theme changes and reduced-motion preferences remain usable.
