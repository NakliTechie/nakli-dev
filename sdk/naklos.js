/*!
 * naklos.js — cooperative SDK for apps hosted inside naklOS (Immersive mode)
 *
 * Drop this file into your app's <head> or copy its contents inline. The
 * surface is a no-op when the app loads standalone (window.parent === window),
 * so the same source works in both contexts:
 *
 *   <script src="https://nakli.dev/sdk/naklos.js"></script>
 *   <script>
 *     naklos.ready();                          // signal "I'm loaded"
 *     naklos.title('My app — unlocked');       // update host window title
 *     naklos.close();                          // self-close from a Done button
 *     naklos.theme.onChange(t => paint(t));    // restyle on host theme change
 *   </script>
 *
 * naklos.capabilities.hosted is true only when running inside naklOS.
 *
 * Single source of truth: /Users/chiragpatnaik/Code/Browser/naklOS/sdk/naklos.js
 * Vendor it inline in each app to keep the no-network-dependency ethos.
 * License: MIT.
 */
(function () {
  var inNaklOS = false;
  try { inNaklOS = !!(window.parent && window.parent !== window); } catch (_) {}

  var currentTheme = null;
  var themeListeners = new Set();
  var beforeCloseCb = null;

  function send(type, data) {
    if (!inNaklOS) return;
    try {
      var msg = Object.assign({ type: type }, data || {});
      window.parent.postMessage(msg, '*');
    } catch (_) {}
  }

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'naklos:theme') {
      currentTheme = { id: msg.theme, colors: msg.colors, mood: msg.mood };
      themeListeners.forEach(function (cb) {
        try { cb(currentTheme); } catch (_) {}
      });
    } else if (msg.type === 'naklos:beforeclose') {
      if (beforeCloseCb) { try { beforeCloseCb(); } catch (_) {} }
    }
  });

  window.naklos = {
    version: 1,
    capabilities: {
      hosted: inNaklOS,
      version: 1,
    },
    ready: function () { send('naklos:ready'); },
    title: function (s) { send('naklos:title', { title: String(s) }); },
    close: function () { send('naklos:close'); },
    beforeClose: function (cb) { beforeCloseCb = typeof cb === 'function' ? cb : null; },
    theme: {
      get current() { return currentTheme; },
      onChange: function (cb) {
        if (typeof cb !== 'function') return function () {};
        themeListeners.add(cb);
        if (currentTheme) { try { cb(currentTheme); } catch (_) {} }
        return function () { themeListeners.delete(cb); };
      },
      request: function () { send('naklos:theme-request'); },
    },
  };
})();
