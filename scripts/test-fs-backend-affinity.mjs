import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const host=fs.readFileSync(path.join(root,'index.html'),'utf8');
const sdk=fs.readFileSync(path.join(root,'sdk/naklios.js'),'utf8');

assert.match(
  sdk,
  /function fsPayload\(data\)[\s\S]*backend: capabilities\.fsBackend/,
  'SDK snapshots backend affinity into each filesystem request',
);
assert.match(
  sdk,
  /naklios:fs:write', fsPayload\(\{ path: path, data: data \}\)/,
  'writes carry the SDK backend snapshot',
);
assert.match(
  host,
  /async function fsHostHandle[\s\S]*msg\.backend && msg\.backend !== backendId[\s\S]*Storage backend changed/,
  'host rejects stale path operations after a rebind',
);
assert.match(
  host,
  /async function fsHostList[\s\S]*msg\.backend && msg\.backend !== backendId[\s\S]*Storage backend changed/,
  'host rejects stale list operations after a rebind',
);

console.log('NakliOS filesystem backend affinity contracts: ok');
