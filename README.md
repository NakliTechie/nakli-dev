# naklOS

A single-file, browser-native desktop launcher for the [NakliTechie](https://naklitechie.github.io/) tool collection.

**Try it: [nakli.dev](https://nakli.dev/)**

40-odd privacy-first tools, games, and utilities, each one a single HTML file that runs entirely in your tab. naklOS gathers them into a draggable desktop with a Cmd-K spotlight, themed wallpapers, folders, and a dock. No build step, no backend, no telemetry.

## Modes

- **Basic** — built-in classics (Minesweeper, Solitaire, Calculator, Notepad, Spider) open as inline windows; everything else opens a new tab. Default.
- **Immersive** *(experimental)* — light apps open as iframe windows inside the desktop.

## Adding a new app

One line in the `APPS` array at the top of `index.html`:

```js
{ id:'mynewapp', name:'MyNewApp', url:'https://mynewapp.naklitechie.com',
  glyph:'✨', bg:'brand',
  description:'One-sentence pitch.',
  tags:['tool','ai'] }
```

Optional fields: `maxMode:'basic'`, `iframeable:false`, `private:true`, `kind:'classic'`, `desktopAlign:'right'` + `desktopOrder:N`, `svg:'<path d=…>'`, `embedUrl:'https://nakli.dev/apps/<id>/'` (same-origin mirror for FSA-needing apps; see `apps/manifest.json`).

## Mirroring an app for same-origin embedding

Cross-origin iframes can't invoke `showDirectoryPicker()`. To embed a File-System-Access-using app inside Immersive mode, mirror it under `apps/<id>/` so it loads from `nakli.dev` itself.

### One-time per app

1. Add an entry to [`apps/manifest.json`](apps/manifest.json) pointing at the upstream repo/branch/file.
2. Set `embedUrl: 'https://nakli.dev/apps/<id>/'` on the app's `APPS` entry in `index.html`.
3. In the upstream source repo, add a small dispatcher workflow at `.github/workflows/notify-naklos.yml`:

   ```yaml
   name: Notify naklOS to re-mirror
   on:
     push:
       branches: [main]
       paths: ['index.html']
   jobs:
     trigger:
       runs-on: ubuntu-latest
       steps:
         - run: gh workflow run sync-mirrors.yml --repo NakliTechie/nakli-dev --ref main
           env:
             GH_TOKEN: ${{ secrets.NAKLOS_DISPATCH_TOKEN }}
   ```

4. In that same source repo, add the secret `NAKLOS_DISPATCH_TOKEN` (Settings → Secrets and variables → Actions). It's a fine-grained PAT with **Actions: Read and write** on `NakliTechie/nakli-dev`. The same PAT can be reused across every source repo.

5. Run `bash scripts/sync-mirrors.sh` locally once to seed the initial mirror, then commit.

### How updates flow

When a source repo pushes to main with a change to `index.html`, its dispatcher fires `gh workflow run` against nakli-dev. The `Sync app mirrors` workflow pulls every mirrored app's latest `index.html`, opens a PR if anything drifted. You review + merge → Cloudflare redeploys nakli.dev with the fresh mirror.

The Immersive iframe drops its sandbox and uses the mirror; standalone visits and new-tab opens continue to use the canonical `url`.

Manual trigger anytime: Actions tab → **Sync app mirrors** → **Run workflow**.

## License

MIT. See [LICENSE](LICENSE).

---

Part of the [NakliTechie](https://naklitechie.github.io/) series — single-file, browser-native, no-backend tools.
