/*!
 * naklios.js — cooperative SDK for apps hosted inside NakliOS (Immersive mode)
 *
 * Drop this file into your app's <head> or copy its contents inline. The
 * surface is a no-op when the app loads standalone (window.parent === window),
 * so the same source works in both contexts:
 *
 *   <script src="https://naklios.dev/sdk/naklios.js"></script>
 *   <script>
 *     naklios.ready();                          // signal "I'm loaded"
 *     naklios.title('My app — unlocked');       // update host window title
 *     naklios.close();                          // self-close from a Done button
 *     naklios.theme.onChange(t => paint(t));    // restyle on host theme change
 *
 *     // Filesystem (when hosted with a connected Folder or Crate):
 *     if (naklios.capabilities.fs){
 *       await naklios.fs.write('vault.json', JSON.stringify(vault));
 *       const data = await naklios.fs.read('vault.json');
 *     }
 *   </script>
 *
 * naklios.capabilities.hosted is true only when running inside NakliOS.
 * naklios.capabilities.fs is true when hosted storage is available to the app.
 * naklios.capabilities.fsBackends lists connected Folder/Crate choices, and
 * naklios.capabilities.fsBackend is the app's current binding (or null).
 * Apps may call naklios.fs.useBackend(id); NakliOS confirms the change.
 * Listen for changes via naklios.onCapabilitiesChange(cb).
 *
 * Paths in fs methods are relative to apps/<your-app-id>/ on the selected backend.
 * Traversal (../) is blocked at the host.
 *
 * Single source of truth: /Users/chiragpatnaik/Code/naklios-universe/naklOS/sdk/naklios.js
 * Vendor it inline in each app to keep the no-network-dependency ethos.
 * License: MIT.
 */
(function () {
  var inNakliOS = false;
  try { inNakliOS = !!(window.parent && window.parent !== window); } catch (_) {}

  var currentTheme = null;
  var themeListeners = new Set();
  var capListeners = new Set();
  var beforeCloseCb = null;
  var capabilities = {
    hosted: inNakliOS,
    version: 1,
    fs: false,
    fsBackends: [],
    fsBackend: null,
  };

  // Request/reply correlation for fs RPCs
  var pendingRpc = new Map();   // requestId → { resolve, reject }
  var rpcCounter = 0;

  function send(type, data) {
    if (!inNakliOS) return;
    try {
      var msg = Object.assign({ type: type }, data || {});
      window.parent.postMessage(msg, '*');
    } catch (_) {}
  }

  function rpc(type, payload) {
    if (!inNakliOS) return Promise.reject(new Error('Not hosted — naklios.* unavailable standalone'));
    return new Promise(function (resolve, reject) {
      var requestId = 'r' + (++rpcCounter) + '_' + Date.now();
      pendingRpc.set(requestId, { resolve: resolve, reject: reject });
      send(type, Object.assign({ requestId: requestId }, payload || {}));
      // 30s timeout — host should respond near-instantly; this is a safety net.
      setTimeout(function () {
        if (pendingRpc.has(requestId)) {
          pendingRpc.delete(requestId);
          reject(new Error('naklios RPC timeout: ' + type));
        }
      }, 30000);
    });
  }

  // Bind each operation to the backend visible when it was issued. The host
  // rejects it if the app is rebound before the message is processed, which
  // prevents a delayed save from crossing Folder/Crate boundaries.
  function fsPayload(data) {
    return Object.assign({ backend: capabilities.fsBackend }, data || {});
  }

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'naklios:theme') {
      currentTheme = { id: msg.theme, colors: msg.colors, mood: msg.mood };
      themeListeners.forEach(function (cb) {
        try { cb(currentTheme); } catch (_) {}
      });
    } else if (msg.type === 'naklios:beforeclose') {
      if (beforeCloseCb) { try { beforeCloseCb(); } catch (_) {} }
    } else if (msg.type === 'naklios:capabilities') {
      if (typeof msg.fs === 'boolean') capabilities.fs = msg.fs;
      if (Array.isArray(msg.fsBackends)) capabilities.fsBackends = msg.fsBackends;
      capabilities.fsBackend = typeof msg.fsBackend === 'string' ? msg.fsBackend : null;
      capListeners.forEach(function (cb) {
        try { cb(capabilities); } catch (_) {}
      });
    } else if (msg.type === 'naklios:fs:reply' && msg.requestId) {
      var p = pendingRpc.get(msg.requestId);
      if (!p) return;
      pendingRpc.delete(msg.requestId);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
  });

  window.naklios = {
    version: 1,
    capabilities: capabilities,   // mutated in place; read fields directly
    ready: function () { send('naklios:ready'); },
    title: function (s) { send('naklios:title', { title: String(s) }); },
    close: function () { send('naklios:close'); },
    beforeClose: function (cb) { beforeCloseCb = typeof cb === 'function' ? cb : null; },
    theme: {
      get current() { return currentTheme; },
      onChange: function (cb) {
        if (typeof cb !== 'function') return function () {};
        themeListeners.add(cb);
        if (currentTheme) { try { cb(currentTheme); } catch (_) {} }
        return function () { themeListeners.delete(cb); };
      },
      request: function () { send('naklios:theme-request'); },
    },
    onCapabilitiesChange: function (cb) {
      if (typeof cb !== 'function') return function () {};
      capListeners.add(cb);
      try { cb(capabilities); } catch (_) {}
      return function () { capListeners.delete(cb); };
    },
    requestCapabilities: function () { send('naklios:capabilities-request'); },
    fs: {
      // All paths are app-relative (under apps/<your-id>/ in the host folder).
      // Returns Promises. Reject if no folder connected, permission denied,
      // or path tries to traverse.
      read:       function (path)       { return rpc('naklios:fs:read', fsPayload({ path: path })); },
      readBinary: function (path)       { return rpc('naklios:fs:readBinary', fsPayload({ path: path })); },
      write:      function (path, data) { return rpc('naklios:fs:write', fsPayload({ path: path, data: data })); },
      append:     function (path, line) { return rpc('naklios:fs:append', fsPayload({ path: path, line: line })); },
      list:       function (prefix)     { return rpc('naklios:fs:list', fsPayload({ prefix: prefix || '' })); },
      delete:     function (path)       { return rpc('naklios:fs:delete', fsPayload({ path: path })); },
      exists:     function (path)       { return rpc('naklios:fs:exists', fsPayload({ path: path })); },
      // Explicit backend changes are always confirmed by the NakliOS host.
      // Switching changes the app-scoped view; it never copies or deletes data.
      useBackend: function (backend)    { return rpc('naklios:fs:selectBackend', { backend: backend }); },
    },
  };
})();
