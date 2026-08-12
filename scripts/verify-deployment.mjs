const baseUrl = new URL(process.argv[2] || 'http://127.0.0.1:8787/');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path) {
  const response = await fetch(new URL(path, baseUrl), {
    redirect: 'manual',
    signal: AbortSignal.timeout(5_000),
  });
  return { response, body: await response.text() };
}

const expected = [
  ['/', 'text/html', "id:'nakliamp'"],
  ['/sdk/naklios.js', 'javascript', 'naklios:ready'],
  ['/apps/manifest.lock.json', 'application/json', '8bc461e9d78b'],
  ['/apps/nakliamp/', 'text/html', 'v0.1.0-m0 · preview'],
  ['/apps/nakliamp/VENDOR.md', 'text/markdown', 'Corresponding Mediabunny source is available'],
  ['/apps/nakliamp/engine/nakliamp-engine.mjs', 'javascript', 'export function createNakliAmpEngine'],
  ['/apps/nakliamp/engine/reel-engine.mjs', 'javascript', 'export function createReelEngine'],
];
for (const [path, contentType, marker] of expected) {
  const { response, body } = await request(path);
  assert(response.status === 200, `${path}: expected 200, received ${response.status}`);
  assert(
    response.headers.get('content-type')?.toLowerCase().includes(contentType),
    `${path}: unexpected Content-Type ${response.headers.get('content-type')}`,
  );
  assert(body.includes(marker), `${path}: response omitted ${marker}`);
}

const forbidden = [
  '/.git/config',
  '/.github/workflows/test.yml',
  '/.worktrees/autopilot-2026-08-06/.git',
  '/.wrangler/tmp/deploy/no-op-worker.js',
  '/plan/workplan.md',
  '/scripts/test-app-catalog.mjs',
  '/test/nakliamp-host-harness.html',
  '/sys/rig/git/test/conformance.test.mjs',
  '/apps/forge/forge-mockup.html',
  '/wrangler.jsonc',
];
for (const path of forbidden) {
  const { response } = await request(path);
  assert(response.status === 404, `${path}: expected 404, received ${response.status}`);
}

console.log(`PASS — NakliOS deployment boundary at ${baseUrl.origin}: 7 public routes; 10 private routes`);
