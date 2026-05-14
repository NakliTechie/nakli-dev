# naklOS

⚝ **Try it now → https://nakli.dev/**

**A desktop full of single-file, privacy-first browser-native tools.**

All these tools, none of your data.

---

## What it is

A desktop-themed launcher for the [NakliTechie](https://naklitechie.github.io/) collection — 40+ browser-native tools, games, and utilities, each one a single HTML file that runs entirely in your tab.

- **Launcher mode** — click an icon, the app opens in a new tab. Honest.
- **Playful mode** — built-in classics (Minesweeper, Solitaire, Calculator) open as draggable windows on the desktop. Everything else still opens in its own tab.
- **Immersive mode** — light apps open as iframe windows inside the desktop. Marked EXPERIMENTAL. Heavy apps (Bahi, Slate, LocalMind…) fall back to a new tab.

Spotlight (Cmd-K / Ctrl-K) searches every app by name, tag, or description. Icons drag-to-rearrange and the layout persists. Twelve curated [Rangrez](https://rangrez.naklitechie.com/) palettes ship inline; the full 240 lazy-load on demand.

## What it deliberately isn't

- **Not an OS.** No process model, no permissions, no kernel. It's a desktop-themed launcher.
- **Not an emulator.** [Karkhana](https://naklitechie.github.io/Karkhana/) already does that.
- **Not a cloud product.** No account, no telemetry, no analytics, no network requests after first paint (except the optional "Load all 240 palettes" button).
- **Not a frame for embedding heavy apps.** Apps over a few hundred KB open in their own tab — iframing them in groups would melt the browser and break their URL bars.

## How it works

| Concern | Solution |
|---|---|
| File count | One HTML file. ~73 KB. |
| Build step | None. |
| App registry | Hard-coded array at the top of `index.html`. Adding an app = one line. |
| Apps themselves | Stay at their existing URLs (`naklitechie.github.io/X`, `*.naklitechie.com`). naklOS only launches them. |
| Window manager | Drag-by-titlebar, click-to-focus, close button. Numeric z-index stack. No resize/min/max in v0. |
| iframe sandbox | `allow-same-origin allow-scripts allow-popups allow-forms allow-downloads`. No top-navigation. Cross-origin by construction. |
| iframe protocol | Optional `naklos:ready` / `naklos:close` / `naklos:title` from child; `naklos:beforeclose` from parent. Apps work without modification. |
| Layout storage | `localStorage['naklOS.layout']` — `{positions, hidden}`. Snap-to-96px grid. |
| Palette engine | CSS variables driven by Rangrez palette tokens (BODY / PANEL / INK / BRAND / ACT / OK / ROW). Live switch, no reload. |
| Mobile | `(pointer: coarse)` or width &lt; 720px → forced Launcher mode, scrollable 3/4-column grid, pill-button Spotlight. |
| Dependencies | **Zero.** |

## Usage

1. Open `nakli.dev`.
2. Click an icon → it opens.
3. Cmd-K (or Ctrl-K) → search by name, tag, or description.
4. Settings (⚙) → switch rendering mode, pick a palette.
5. Drag any icon to rearrange. Position persists in `localStorage`.

## Adding a new app

One line in the `APPS` array at the top of `index.html`:

```js
{ id:'mynewapp', name:'MyNewApp', url:'https://mynewapp.naklitechie.com',
  glyph:'✨', bg:'brand',
  description:'One-sentence pitch.',
  tags:['tool','ai'] }
```

Optional fields:
- `maxMode:'B'` — heavy apps that should fall back to a new tab in Immersive mode.
- `iframeable:false` — apps that can't run in an iframe at all (e.g. a v86 VM).
- `private:true` — adds a status dot on the icon tile.
- `kind:'classic'` — for built-in apps that ship inline in the desktop.

## Modes (the long version)

Three render modes, user-selectable. Each app's click is routed through `effectiveMode(app)` which collapses three forces: user's chosen mode, app-declared maximum mode, device capability (mobile is locked to Launcher).

**A — Quiet (Launcher).** Click → `window.open(url, '_blank')`. Default on mobile.

**B — Playful.** Default on desktop. Same as A for regular apps. Built-in classics (Minesweeper / Solitaire / Calculator) open as draggable inline windows.

**C — Immersive (experimental).** Same as B for classics and locked-down apps. Light NakliTechie apps open as iframe windows. The honest list of why this is experimental: iframes don't share keyboard focus with the parent, Cmd-K may be eaten by an embedded app, mobile scrolls fight window drags, and a buggy app loaded in an iframe makes the desktop look bad. If after a few weeks of dogfooding Mode C feels like ceremony rather than utility, the deprecation path is one line of code.

## Palette

Default is **`japan-10 · 漆 URUSHI`** — Wajima lacquerware, kintsugi gold-orange accent. Twelve hand-picked palettes ship inline; the remaining ~228 lazy-load from [Rangrez](https://rangrez.naklitechie.com/) when you press *Load all 240*.

The inline twelve are chosen to cover roles, not collections: dark (URUSHI), clean light (MUJI), mono (SUMI), porcelain blue (QINGHUA), cinnabar (ZHUSHA), festival red (HONG), turmeric (HALDI), indigo (NEEL), bindi (KUMKUM), saffron (SAFFRON), Bauhaus light (DESSAU), Kandinsky cobalt (KANDINSKY BLUE).

## Browser support

Chrome, Edge, Firefox, Safari 16.4+. No Web Workers required for the desktop itself. Individual NakliTechie apps may have their own requirements (Karkhana needs a recent Chrome; LocalMind wants WebGPU).

## License

MIT. See [`LICENSE`](LICENSE).

---

Part of the [NakliTechie](https://naklitechie.github.io/) series — single-file, browser-native, no-backend tools.
