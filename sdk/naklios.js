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
 *       const stop = await naklios.fs.subscribe('', event => refresh(event));
 *     }
 *
 *     // Shared on-device inference (when the user grants this app access):
 *     if (naklios.capabilities.ai) {
 *       const stream = await naklios.ai.chat.completions.create({
 *         messages: [{ role: 'user', content: 'Summarise this note.' }],
 *         stream: true,
 *       });
 *       for await (const chunk of stream) {
 *         render(chunk.choices[0].delta.content || '');
 *       }
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
    ai: false,
    aiModel: null,
    aiState: 'idle',
  };

  // Request/reply correlation for fs RPCs
  var pendingRpc = new Map();   // requestId → { resolve, reject }
  var rpcCounter = 0;
  var fsSubscriptions = new Map(); // subscriptionId → callback
  var aiRequests = new Map(); // requestId → streamed request state

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

  function makeAiStream(options) {
    if (!inNakliOS) throw new Error('Not hosted — naklios.ai unavailable standalone');
    if (!capabilities.ai) throw new Error('NakliOS Local AI is unavailable or not permitted');
    options = options || {};
    var requestId = 'a' + (++rpcCounter) + '_' + Date.now();
    var queued = [];
    var waiters = [];
    var complete = false;
    var failure = null;

    function deliver(item) {
      if (waiters.length) waiters.shift().resolve({ value: item, done: false });
      else queued.push(item);
    }
    function finish() {
      complete = true;
      while (waiters.length) waiters.shift().resolve({ value: undefined, done: true });
    }
    function fail(error) {
      failure = error;
      complete = true;
      while (waiters.length) waiters.shift().reject(error);
    }

    var stream = {
      next: function () {
        if (queued.length) return Promise.resolve({ value: queued.shift(), done: false });
        if (failure) return Promise.reject(failure);
        if (complete) return Promise.resolve({ value: undefined, done: true });
        return new Promise(function (resolve, reject) {
          waiters.push({ resolve: resolve, reject: reject });
        });
      },
      cancel: function () {
        send('naklios:ai:cancel', { requestId: requestId });
      },
    };
    stream[Symbol.asyncIterator] = function () { return stream; };
    aiRequests.set(requestId, {
      deliver: deliver,
      finish: finish,
      fail: fail,
      onStatus: typeof options.onStatus === 'function' ? options.onStatus : null,
    });
    send('naklios:ai:chat', {
      requestId: requestId,
      messages: Array.isArray(options.messages) ? options.messages : [],
      maxTokens: options.max_tokens || options.maxTokens,
    });
    if (options.signal) {
      if (options.signal.aborted) stream.cancel();
      else options.signal.addEventListener('abort', function () { stream.cancel(); }, { once: true });
    }
    return stream;
  }

  async function createAiCompletion(options) {
    options = options || {};
    var stream = makeAiStream(options);
    if (options.stream === true) return stream;
    var content = '';
    var finishReason = 'stop';
    for await (var chunk of stream) {
      var choice = chunk.choices && chunk.choices[0];
      if (choice && choice.delta && choice.delta.content) content += choice.delta.content;
      if (choice && choice.finish_reason) finishReason = choice.finish_reason;
    }
    return {
      id: 'naklios-local',
      object: 'chat.completion',
      model: capabilities.aiModel || 'localmind',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: content },
        finish_reason: finishReason,
      }],
    };
  }

  window.addEventListener('message', function (e) {
    if (inNakliOS && e.source !== window.parent) return;
    var msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'naklios:theme') {
      currentTheme = { id: msg.theme, colors: msg.colors, mood: msg.mood };
      themeListeners.forEach(function (cb) {
        try { cb(currentTheme); } catch (_) {}
      });
    } else if (msg.type === 'naklios:beforeclose') {
      var closeWork;
      try { closeWork = beforeCloseCb ? beforeCloseCb() : null; } catch (_) { closeWork = null; }
      Promise.resolve(closeWork).catch(function () {}).then(function () {
        send('naklios:beforeclose-ready', { requestId: msg.requestId });
      });
    } else if (msg.type === 'naklios:capabilities') {
      if (typeof msg.fs === 'boolean') capabilities.fs = msg.fs;
      if (Array.isArray(msg.fsBackends)) capabilities.fsBackends = msg.fsBackends;
      capabilities.fsBackend = typeof msg.fsBackend === 'string' ? msg.fsBackend : null;
      if (typeof msg.ai === 'boolean') capabilities.ai = msg.ai;
      capabilities.aiModel = typeof msg.aiModel === 'string' ? msg.aiModel : null;
      capabilities.aiState = typeof msg.aiState === 'string' ? msg.aiState : 'idle';
      capListeners.forEach(function (cb) {
        try { cb(capabilities); } catch (_) {}
      });
    } else if (msg.type === 'naklios:ai:event' && msg.requestId) {
      var aiRequest = aiRequests.get(msg.requestId);
      if (!aiRequest) return;
      if (msg.event === 'status') {
        try { aiRequest.onStatus && aiRequest.onStatus(msg.status, msg.progress || null); } catch (_) {}
      } else if (msg.event === 'token') {
        aiRequest.deliver({
          id: msg.requestId,
          object: 'chat.completion.chunk',
          model: msg.model || capabilities.aiModel || 'localmind',
          choices: [{
            index: 0,
            delta: { content: String(msg.token || '') },
            finish_reason: null,
          }],
        });
      } else if (msg.event === 'done') {
        aiRequest.deliver({
          id: msg.requestId,
          object: 'chat.completion.chunk',
          model: msg.model || capabilities.aiModel || 'localmind',
          choices: [{
            index: 0,
            delta: {},
            finish_reason: msg.finishReason || 'stop',
          }],
        });
        aiRequests.delete(msg.requestId);
        aiRequest.finish();
      } else if (msg.event === 'error') {
        aiRequests.delete(msg.requestId);
        aiRequest.fail(new Error(msg.error || 'NakliOS Local AI failed'));
      }
    } else if (msg.type === 'naklios:fs:reply' && msg.requestId) {
      var p = pendingRpc.get(msg.requestId);
      if (!p) return;
      pendingRpc.delete(msg.requestId);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    } else if (msg.type === 'naklios:fs:event' && msg.subscriptionId) {
      var listener = fsSubscriptions.get(msg.subscriptionId);
      if (listener) {
        try { listener(msg.event || {}); } catch (_) {}
      }
    } else if (msg.type === 'naklios:fs:subscription-ended' && msg.subscriptionId) {
      var endedListener = fsSubscriptions.get(msg.subscriptionId);
      fsSubscriptions.delete(msg.subscriptionId);
      if (endedListener) {
        try { endedListener({ op: 'disconnected', reason: msg.reason || 'Storage subscription ended' }); } catch (_) {}
      }
    }
  });

  window.naklios = {
    version: 1,
    capabilities: capabilities,   // mutated in place; read fields directly
    ready: function () {
      send('naklios:ready', {
        features: { beforeCloseAck: true, fsSubscribe: true, aiStream: true },
      });
    },
    title: function (s) { send('naklios:title', { title: String(s) }); },
    close: function () { send('naklios:close'); },
    openSettings: function (section) {
      send('naklios:open-settings', { section: String(section || '') });
    },
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
      // Watch an app-relative path or directory. Crate events are immediate;
      // Folder changes are detected by a lightweight host poll. Resolves to
      // an unsubscribe function.
      subscribe: async function (path, cb) {
        if (typeof cb !== 'function') throw new Error('naklios.fs.subscribe requires a callback');
        var subscriptionId = await rpc(
          'naklios:fs:subscribe',
          fsPayload({ path: path || '' }),
        );
        fsSubscriptions.set(subscriptionId, cb);
        var active = true;
        return function () {
          if (!active) return;
          active = false;
          fsSubscriptions.delete(subscriptionId);
          send('naklios:fs:unsubscribe', { subscriptionId: subscriptionId });
        };
      },
      // Explicit backend changes are always confirmed by the NakliOS host.
      // Switching changes the app-scoped view; it never copies or deletes data.
      useBackend: function (backend)    { return rpc('naklios:fs:selectBackend', { backend: backend }); },
    },
    ai: {
      chat: {
        completions: {
          create: createAiCompletion,
        },
      },
      cancelAll: function () {
        aiRequests.forEach(function (_, requestId) {
          send('naklios:ai:cancel', { requestId: requestId });
        });
      },
    },
  };
})();
