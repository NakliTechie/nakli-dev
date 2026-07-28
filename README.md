# NakliOS

A private, browser-native desktop for single-file tools. Apps stay standalone; NakliOS gives them a home — a spotlight (⌘K), themed wallpapers, folders, a dock, sticky notes, and an Immersive mode where cooperative apps feel native inside the OS instead of foreign in iframes.

**Try it: [naklios.dev](https://naklios.dev/)**

40-odd privacy-first tools, games, and utilities — each a single HTML file that runs entirely in your tab. The [NakliTechie collection](https://naklitechie.github.io/) is the first apps NakliOS hosts. No build step, no backend, no telemetry.

## Modes

- **Basic** — built-in classics (Minesweeper, Solitaire, Calculator, Notepad, Spider) open as inline windows; storage-dependent system apps such as Files, Tijori, and Books stay hosted; other apps open a new tab. Default.
- **Immersive** *(experimental)* — light apps open as iframe windows inside the desktop.

Every NakliOS window has an **App Info** button in its titlebar. It shows the
actual loaded URL and origin, iframe sandbox tokens, load/SDK-ready timings,
the storage capabilities currently offered to that app, and whether the
artifact is built in, canonical, or a mirror locked to a source commit and
SHA-256.

## Adding a new app

One line in the `APPS` array at the top of `index.html`:

```js
{ id:'mynewapp', name:'MyNewApp', url:'https://mynewapp.naklitechie.com',
  glyph:'✨', bg:'brand',
  description:'One-sentence pitch.',
  tags:['tool','ai'] }
```

Optional fields: `maxMode:'basic'`, `iframeable:false`, `private:true`, `kind:'classic'`, `desktopAlign:'right'` + `desktopOrder:N`, `svg:'<path d=…>'`, `embedUrl:'https://naklios.dev/apps/<id>/'` (same-origin mirror for FSA-needing apps; see `apps/manifest.json`).

## Mirroring an app for same-origin embedding

Cross-origin iframes can't invoke `showDirectoryPicker()`. To embed a File-System-Access-using app inside Immersive mode, mirror it under `apps/<id>/` so it loads from `naklios.dev` itself.

### One-time per app

1. Add an entry to [`apps/manifest.json`](apps/manifest.json) pointing at the upstream repository, release ref, and distributable files. Prefer a release tag; `main` is supported and is resolved to an exact commit during sync.
2. Set `embedUrl: 'https://naklios.dev/apps/<id>/'` on the app's `APPS` entry in `index.html`.
3. In the upstream source repo, add a small dispatcher workflow at `.github/workflows/notify-naklios.yml`:

   ```yaml
   name: Notify NakliOS to re-mirror
   on:
     push:
       branches: [main]
       paths: ['index.html']
   jobs:
     trigger:
       runs-on: ubuntu-latest
       env:
         DISPATCH_TOKEN: ${{ secrets.NAKLIOS_DISPATCH_TOKEN }}
       steps:
         - if: env.DISPATCH_TOKEN != ''
           run: gh workflow run sync-mirrors.yml --repo NakliTechie/nakli-dev --ref main
           env:
             GH_TOKEN: ${{ env.DISPATCH_TOKEN }}
         - if: env.DISPATCH_TOKEN == ''
           run: echo "Using nakli-dev's scheduled-sync fallback."
   ```

4. For near-immediate updates, add the optional secret `NAKLIOS_DISPATCH_TOKEN` in that source repo (Settings → Secrets and variables → Actions). It's a fine-grained PAT with **Actions: Read and write** on `NakliTechie/nakli-dev`, and can be reused across source repos. Without it, the dispatcher exits successfully and NakliOS's six-hour scheduled sync discovers the update.

5. Run `bash scripts/sync-mirrors.sh --app <id>` locally once to seed the initial mirror and [`apps/manifest.lock.json`](apps/manifest.lock.json), then commit both. `node scripts/validate-mirrors.mjs` verifies that every checked-in artifact matches its locked SHA-256.

### How updates flow

When a source repo pushes to main with a distributable change, its dispatcher fires `gh workflow run` against nakli-dev when the optional dispatch token is configured; a six-hour schedule is the fallback. The `Sync app mirrors` workflow resolves the requested ref to a full Git commit, downloads from that immutable commit, updates the lockfile, validates every artifact hash, and opens a PR if anything drifted. You review + merge → Cloudflare redeploys naklios.dev with the fresh mirror.

This is vendoring of built artifacts, not a second source tree: implementation and releases happen in each standalone repository, while NakliOS records only the deployable snapshot it needs. The Immersive iframe drops its sandbox only for a declared same-origin mirror; standalone visits and new-tab opens continue to use the canonical `url`, and all other hosted apps keep the cross-origin sandbox boundary.

Manual trigger anytime: Actions tab → **Sync app mirrors** → **Run workflow**.

## Storage backends — Folder + Crate

Cooperative apps that want persistent state use the `naklios.fs.*` SDK surface. The host fulfils those calls with one of two backends, configured in Settings:

- **Folder (local)** — a directory you pick via File System Access. Lives on disk. Multi-device only via iCloud Drive / Dropbox / Google Drive of your choice.
- **Crate (cloud, encrypted)** — BYOK end-to-end-encrypted folder on Cloudflare R2. Multi-device sync is built in. Connect with the `.crate-creds` file from [crate.naklios.dev](https://crate.naklios.dev/), or enter the bucket name, account ID, API keys, and folder passphrase directly.

Both can be connected at the same time. On first use, each app is asked which backend to store its data in, and cooperative apps can surface that same choice in their own storage picker. NakliOS confirms every explicit rebind, remembers it per app, and does not copy or delete data when switching. Apps see the same `apps/<id>/` layout regardless of backend, so the same source code works against either.

The Crate ESM modules are vendored under [`vendor/crate/`](vendor/crate/) and loaded dynamically the first time the user clicks **Connect Crate** — zero cost for users who don't opt in.

## Base utilities

**Notepad v2** is a practical multi-document editor with horizontal open-document tabs, autosave, search/replace (including case-sensitive and regular-expression modes), go-to-line, Markdown edit/split/preview modes, local file open/Save As, import/download, word wrap, font and tab-size controls, and keyboard shortcuts. Persistence follows a deliberate order: an app-scoped NakliOS Folder or Crate whenever one is connected, durable local file handles when working from this device, then an IndexedDB recovery/session journal (with the former localStorage registry retained only as a compatibility fallback). The journal restores open tabs and newer unsaved text after a crash, reload, or shutdown. Switching locations never migrates data implicitly, and the original v1 scratch value is preserved after one-time migration.

**Books v1.1** remains hosted in both desktop modes. It uses the current storage SDK, keeps Folder and Crate libraries isolated, and adds filtering, sorting, duplicate protection, modal-confirmed removal, and reader appearance preferences. Local development loads the sibling `Books/` checkout; production keeps the cross-origin published app.

## License

MIT. See [LICENSE](LICENSE).

---

Part of the [NakliTechie](https://naklitechie.github.io/) series — single-file, browser-native, no-backend tools.
