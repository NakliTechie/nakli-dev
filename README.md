# NakliOS

A private, browser-native desktop for single-file tools. Apps stay standalone; NakliOS gives them a home — a spotlight (⌘K), themed wallpapers, task-based folders, an Essentials dock, sticky notes, and windowed apps that feel native inside the OS.

**Try it: [naklios.dev](https://naklios.dev/)**

Dozens of privacy-first tools, games, and utilities — each a single HTML file that runs entirely in your tab. A new profile starts with one skippable welcome action that creates a real Browser-backed note; storage setup waits until it is actually needed. The desktop is grouped into Essentials, Create & Convert, Think & Research, Work & Build, Privacy & Security, and Play. No build step, backend, or telemetry.

## Modes

- **Immersive** — the default for new profiles. Compatible apps open in responsive NakliOS windows on desktop and mobile; apps that cannot embed still open in a tab.
- **Basic** — built-ins and storage-dependent system apps stay hosted; other web apps open in new tabs. An existing explicit Basic preference is preserved.

Basic is a compatibility and user-choice fallback, not a second desktop
generation. The [`Experience mode policy`](docs/experience-modes.md) records
the keep decision, invariants, and historical-key migration.

Every NakliOS window has an **App Info** button in its titlebar. It shows the
actual loaded URL and origin, iframe sandbox tokens, load/SDK-ready timings,
the storage capabilities currently offered to that app, and whether the
artifact is built in, canonical, or a mirror locked to a source commit and
SHA-256.

## Adding apps

People can install a personal web app from **Settings → Apps → Add app from
manifest**. The versioned
[`third-party app standard`](docs/third-party-apps-v1.md) defines identity,
themes, lifecycle, app-scoped storage, permissions, sandboxing, updates,
accessibility, and acceptance checks. Personal registrations are profile-local.
Windowed apps are always opaque-origin sandboxed; apps that require their own
origin state can explicitly open in a normal top-level tab. Neither route
becomes a privileged mirror.

Maintainers add a first-party catalog app in source:

One line in the `APPS` array at the top of `index.html`:

```js
{ id:'mynewapp', name:'MyNewApp', url:'https://mynewapp.naklitechie.com',
  glyph:'✨', bg:'brand',
  description:'One-sentence pitch.',
  tags:['tool','ai'] }
```

Optional fields: `maxMode:'basic'`, `iframeable:false`, `private:true`, `kind:'classic'`, `desktopAlign:'right'` + `desktopOrder:N`, `svg:'<path d=…>'`, `embedUrl:'https://naklios.dev/apps/<id>/'` (same-origin mirror for FSA-needing apps; see `apps/manifest.json`).

Apps retain one predictable task-folder home. NakliOS also places Books,
NakliPoster, BOFH, MoD, NakliData, Tijori, Files, and Notes on the right side
of the desktop by default; users can return any shortcut to its folder from
the desktop context menu.

NakliData opens as a top-level app rather than an opaque sandboxed iframe
because its browser-native data engine relies on File System Access, OPFS,
workers, and cross-origin isolation.

First-party stateful and cooperative apps should follow the
[`NakliOS app contract`](docs/app-contract.md), including backend-affine
filesystem calls, separate Browser/Folder/Crate libraries, async close
durability, explicit remote-conflict handling, and the optional streamed
chat and image-generation surfaces under `naklios.ai`.

## AI

NakliOS has one host-owned inference broker backed by pinned LocalMind
runtimes. LFM2.5 230M remains the fast ~140 MB default. Settings also offers
Gemma 4 E2B, Gemma 4 E4B, and Qwen3.5 4B through pinned Transformers.js
4.2.0/WebGPU, or an
OpenAI-compatible endpoint: Ollama, LM Studio, llama.cpp, OpenAI, OpenRouter,
Groq, or a custom provider. Cooperative apps keep one SDK regardless of which
runtime the user chooses. Requests are bounded, queued fairly, reset between
apps, streamed, and cancellable.

The same broker exposes image generation through
`naklios.ai.images.generate(...)`. The default image runtime is LocalMind's
private, on-device Bonsai FLUX.2-Klein WebGPU engine. Users may instead connect
OpenAI or a compatible `POST /images/generations` endpoint. Chat and image
generation share a fair queue but have separate model settings and consent;
the host does not keep both large WebGPU workers resident at once.

Consent is per app, capability, browser, and destination. A grant for a browser-local model
does not silently authorize a local server or cloud provider. Endpoint URLs and
API keys remain host-only; keys last for the tab unless the user explicitly
chooses to remember one on that device. AI settings and secrets never sync
through Folder or Crate. Apps receive only their own text stream or generated
image: never the
worker, endpoint credentials, another app's prompts, filesystem capabilities,
Crate credentials, or host tools. Third-party manifests must declare
`inference`, followed by a separate first-use prompt.

LocalMind remains the source repository for inference runtime work. NakliOS
checks in the tested workers, catalog, and engine under
[`vendor/localmind/`](vendor/localmind/) with an upstream commit and SHA-256
lock, so the full LocalMind workbench and the shared OS service cannot drift.

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

**Files intentionally has no Browser-backed virtual filesystem.** It browses only
its app-scoped data in a connected Folder or Crate, and routes disconnected
users directly to NakliOS Storage settings.

The Crate ESM modules are vendored under [`vendor/crate/`](vendor/crate/) and loaded dynamically the first time the user clicks **Connect Crate** — zero cost for users who don't opt in.

## Base utilities

**Notepad v2** is a practical multi-document editor with horizontal open-document tabs, autosave, search/replace (including case-sensitive and regular-expression modes), go-to-line, Markdown edit/split/preview modes, local file open/Save As, import/download, word wrap, font and tab-size controls, keyboard shortcuts, and reviewed Local AI summarize/improve/proofread actions. Persistence follows a deliberate order: an app-scoped NakliOS Folder or Crate whenever one is connected, durable local file handles when working from this device, then an IndexedDB recovery/session journal (with the former localStorage registry retained only as a compatibility fallback). The journal restores open tabs and newer unsaved text after a crash, reload, or shutdown. Switching locations never migrates data implicitly, and the original v1 scratch value is preserved after one-time migration.

**Books v1.1** remains hosted in both desktop modes. It uses the current storage SDK, keeps Folder and Crate libraries isolated, and adds filtering, sorting, duplicate protection, modal-confirmed removal, reader appearance preferences, and a Local AI reading companion scoped to the visible selection, page, or passage. Local development loads the sibling `Books/` checkout; production keeps the cross-origin published app.

**Notes v1** is a bundled three-pane notebook app that stays hosted in both
desktop modes. Browser, Folder, and encrypted Crate are visibly separate
libraries: switching locations never copies or deletes notes. Notes autosaves
Markdown content and separate JSON metadata, restores its library after
reloads, supports notebooks, full-text search, pinning, and soft deletion, and
uses `naklios.fs.subscribe()` for live storage-change notifications when the
host backend supports them. It complements Notepad: Notes manages a library;
Notepad opens arbitrary files.

## License

MIT. See [LICENSE](LICENSE).

---

Part of the [NakliTechie](https://naklitechie.github.io/) series — single-file, browser-native, no-backend tools.
