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

1. Add an entry to [`apps/manifest.json`](apps/manifest.json) pointing at the upstream repo/branch/file.
2. Run `bash scripts/sync-mirrors.sh` (or let the scheduled workflow do it on the next 6-hour cycle).
3. Set `embedUrl: 'https://nakli.dev/apps/<id>/'` on the app's `APPS` entry.

The Immersive iframe will drop its sandbox and use the mirror; standalone visits and new-tab opens continue to use the canonical `url`.

## License

MIT. See [LICENSE](LICENSE).

---

Part of the [NakliTechie](https://naklitechie.github.io/) series — single-file, browser-native, no-backend tools.
