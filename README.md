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

Optional fields: `maxMode:'basic'`, `iframeable:false`, `private:true`, `kind:'classic'`, `desktopAlign:'right'` + `desktopOrder:N`, `svg:'<path d=…>'`.

## License

MIT. See [LICENSE](LICENSE).

---

Part of the [NakliTechie](https://naklitechie.github.io/) series — single-file, browser-native, no-backend tools.
