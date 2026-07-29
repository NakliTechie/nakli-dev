import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const sdkSource = await readFile(new URL('sdk/naklios.js', root), 'utf8');

assert.match(html, /new URL\('vendor\/localmind\/inference-worker\.js', document\.baseURI\)/);
assert.match(html, /const AI_MAX_QUEUE = 12/);
assert.match(html, /const AI_MAX_QUEUE_PER_APP = 3/);
assert.match(html, /function aiNextRequest\(\)[\s\S]*?request\.appId !== aiHost\.lastAppId/);
assert.match(html, /function aiNormaliseMessages\(messages\)/);
assert.match(html, /function aiHostCancelSource\(source\)/);
assert.match(html, /aiHostCancelSource\(iframe\.contentWindow\)/);
assert.match(html, /generationConfig:\{ max_tokens:request\.maxTokens, reset:true \}/,
  'every app request clears model conversation state');
assert.match(html, /aiPermissions: JSON\.parse\(localStorage\.getItem\('nakliOS\.aiPermissions\.v1'\)/);

const serializeStart = html.indexOf('function serializeState()');
const serializeEnd = html.indexOf('async function fsWriteState', serializeStart);
const serializeSource = html.slice(serializeStart, serializeEnd);
assert.doesNotMatch(
  serializeSource,
  /aiPermissions/,
  'device-local AI grants must not sync through Folder state.json',
);
assert.match(
  html,
  /The shared \$\{AI_MODEL_LABEL\} model runs on this device[\s\S]*?Prompts and replies stay in this tab/,
  'first use explains the model download and prompt boundary',
);
assert.match(html, /This app did not declare the inference permission/);
assert.match(html, /event:'token'/);
assert.match(html, /event:'done'/);
assert.match(html, /event:'error'/);
assert.match(html, /id="pad-ai"/, 'Notepad exposes a local AI action');
assert.match(html, /Nothing changes until you choose Replace or Insert/);
assert.match(html, /aiHostChatNative\(APP_ID/, 'host-native apps use the same broker');

const posted = [];
const listeners = new Map();
const parent = {
  postMessage(message) { posted.push(message); },
};
const windowObject = {
  parent,
  addEventListener(type, callback) { listeners.set(type, callback); },
};
const context = vm.createContext({
  window:windowObject,
  console,
  Map,
  Set,
  Promise,
  Symbol,
  Error,
  Date,
  Object,
  Array,
  String,
  setTimeout,
  clearTimeout,
});
vm.runInContext(sdkSource, context, { filename:'sdk/naklios.js' });

const dispatch = (data, source = parent) => {
  const listener = listeners.get('message');
  assert.ok(listener, 'SDK message listener is installed');
  listener({ data, source });
};

dispatch({
  type:'naklios:capabilities',
  fs:false,
  ai:true,
  aiModel:'LiquidAI/LFM2.5-230M-GGUF',
  aiState:'idle',
});
assert.equal(windowObject.naklios.capabilities.ai, true);

// A non-parent window cannot forge host capabilities or inference replies.
dispatch({ type:'naklios:capabilities', ai:false }, { postMessage() {} });
assert.equal(windowObject.naklios.capabilities.ai, true);

const statuses = [];
const stream = await windowObject.naklios.ai.chat.completions.create({
  messages:[{ role:'user', content:'Hello' }],
  max_tokens:64,
  stream:true,
  onStatus(status) { statuses.push(status); },
});
const chat = posted.find(message => message.type === 'naklios:ai:chat');
assert.ok(chat?.requestId, 'SDK posts a correlated Local AI request');
assert.equal(chat.maxTokens, 64);

dispatch({ type:'naklios:ai:event', requestId:chat.requestId, event:'status', status:'queued' });
dispatch({ type:'naklios:ai:event', requestId:chat.requestId, event:'token', token:'Hello ' });
dispatch({ type:'naklios:ai:event', requestId:chat.requestId, event:'token', token:'locally.' });
dispatch({
  type:'naklios:ai:event',
  requestId:chat.requestId,
  event:'done',
  finishReason:'stop',
});

let streamed = '';
let finishReason = null;
for await (const chunk of stream) {
  streamed += chunk.choices[0].delta.content || '';
  finishReason = chunk.choices[0].finish_reason || finishReason;
}
assert.equal(streamed, 'Hello locally.');
assert.equal(finishReason, 'stop');
assert.deepEqual(statuses, ['queued']);

const cancellable = await windowObject.naklios.ai.chat.completions.create({
  messages:[{ role:'user', content:'Wait' }],
  stream:true,
});
cancellable.cancel();
const cancel = posted.at(-1);
assert.equal(cancel.type, 'naklios:ai:cancel');
assert.ok(cancel.requestId);

console.log('NakliOS Local AI broker and SDK contract: PASS');
