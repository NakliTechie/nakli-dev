import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redirectRequest } from '../redirects/naklios-com/worker.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(
  path.join(root, 'redirects', 'naklios-com', 'wrangler.jsonc'),
  'utf8',
));

assert.equal(config.name, 'naklios-com-redirect');
assert.equal(config.workers_dev, false);
assert.deepEqual(config.routes, [
  { pattern: 'naklios.com/*', zone_name: 'naklios.com' },
  { pattern: 'www.naklios.com/*', zone_name: 'naklios.com' },
]);

const cases = [
  ['https://naklios.com/', 'https://naklios.dev/'],
  ['https://naklios.com/apps/nakliamp/?mode=immersive&from=legacy', 'https://naklios.dev/apps/nakliamp/?mode=immersive&from=legacy'],
  ['https://www.naklios.com/docs/storage%20guide?q=a%2Fb', 'https://naklios.dev/docs/storage%20guide?q=a%2Fb'],
  ['https://naklios.com//outside.example/path', 'https://naklios.dev//outside.example/path'],
];

for (const [source, target] of cases) {
  const response = redirectRequest(new Request(source));
  assert.equal(response.status, 308, `${source}: redirect status`);
  assert.equal(response.headers.get('location'), target, `${source}: redirect location`);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(await response.text(), '');
}

const postResponse = redirectRequest(new Request('https://naklios.com/api/example', {
  method: 'POST',
  body: 'payload',
}));
assert.equal(postResponse.status, 308, 'non-GET requests retain their method through 308');

console.log('PASS — naklios.com redirect Worker: apex and www preserve paths and queries');
