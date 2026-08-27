// Conformance — Rote core: the script contract, the minimal vault + redaction,
// and the runtime (immutable run records). Headless over a MemoryBackend fileops.
//   node sys/rote/test/rote-core.test.mjs
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { validateMeta, validateInputs, checkValue, CTX_KEYS } from '../contract.mjs';
import { createRedactor, createVault, createMemoryVaultStore } from '../vault.mjs';
import { runScript, makeRunId, auditRedaction, ExploreUnavailable } from '../runtime.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message + (e.stack ? '\n' + e.stack.split('\n')[1] : '') }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const mkfs = () => createFileops({ backend: new MemoryBackend() });
const sha256 = async (s) => 'h' + String(s.length).padStart(6, '0');       // deterministic test stub
const fixedNow = () => Date.parse('2026-08-27T09:14:02.123Z');

// ── contract ────────────────────────────────────────────────────────────────
await test('contract: validateInputs enforces types, required, and rejects undeclared keys', () => {
  const meta = { name: 'x', version: 1, inputs: { urls: 'string[]', n: 'number?', flag: 'boolean' } };
  assert(validateInputs(meta, { urls: ['a', 'b'], flag: true }).ok, 'valid accepted (optional omitted)');
  assert(!validateInputs(meta, { urls: ['a'], flag: 'yes' }).ok, 'wrong type rejected');
  assert(!validateInputs(meta, { flag: true }).ok, 'missing required rejected');
  assert(!validateInputs(meta, { urls: [1], flag: true }).ok, 'wrong array element rejected');
  assert(!validateInputs(meta, { urls: ['a'], flag: true, extra: 1 }).ok, 'undeclared key rejected');
  const good = validateInputs(meta, { urls: ['a'], flag: false, n: 3 });
  assert(good.ok && good.value.n === 3, 'accepted value carried through');
});

await test('contract: validateMeta rejects malformed meta', () => {
  assert(validateMeta({ name: 'x', version: 1 }).ok, 'minimal meta ok');
  assert(!validateMeta({ name: '', version: 1 }).ok, 'empty name');
  assert(!validateMeta({ name: 'x', version: 0 }).ok, 'version < 1');
  assert(!validateMeta({ name: 'x', version: 1, inputs: { a: 'weird' } }).ok, 'unknown input type');
  assert(!validateMeta({ name: 'x', version: 1, grants: 'gmail' }).ok, 'grants must be array');
});

await test('contract: input ingress resists prototype pollution', () => {
  const meta = { name: 'x', version: 1, inputs: { a: 'string' } };
  const hostile = JSON.parse('{"a":"ok","__proto__":{"polluted":true}}'); // own __proto__ key
  const r = validateInputs(meta, hostile);
  assert(!r.ok, 'undeclared __proto__ key rejected');
  const clean = validateInputs(meta, { a: 'ok' });
  assert(clean.ok, 'clean input accepted');
  assert(({}).polluted === undefined, 'Object.prototype not polluted');
  assert(Object.getPrototypeOf(clean.value) === null, 'accepted value is null-proto');
});

await test('contract: checkValue optional + array grammar', () => {
  eq(checkValue('string?', undefined), null, 'optional absent ok');
  eq(checkValue('string', undefined), 'is required', 'required absent fails');
  eq(checkValue('number[]', [1, 2]), null, 'number[] ok');
  assert(checkValue('number[]', [1, 'x']) !== null, 'bad element');
});

// ── vault + redaction ─────────────────────────────────────────────────────────
await test('vault: redactor strips values and detects them', () => {
  const r = createRedactor();
  r.register('sk-SECRET-123'); r.register('a@b.com');
  eq(r.redact('token sk-SECRET-123 for a@b.com'), 'token [REDACTED] for [REDACTED]', 'both redacted');
  assert(r.contains('leak sk-SECRET-123'), 'contains detects');
  assert(!r.contains('nothing here'), 'clean detects');
});

await test('vault: resolves a declared grant, throws on undeclared/missing', async () => {
  const redactor = createRedactor();
  const store = createMemoryVaultStore({ 'vault:email': 'me@x.com' });
  const meta = { name: 'x', version: 1, grants: ['subscribe.email'] };
  const v = await createVault({ meta, grants: { 'subscribe.email': 'vault:email' }, store, redactor });
  eq(v.get('subscribe.email'), 'me@x.com', 'resolved value');
  assert(redactor.contains('me@x.com'), 'value registered for redaction on resolve');
  let threw = false; try { v.get('other'); } catch (_) { threw = true; }
  assert(threw, 'undeclared grant throws');
  let threw2 = false; try { await createVault({ meta, grants: {}, store, redactor }); } catch (e) { threw2 = e.code === 'grant-unavailable'; }
  assert(threw2, 'declared-but-unmapped grant → grant-unavailable');
});

// ── runtime ─────────────────────────────────────────────────────────────────
const detScript = {
  meta: { name: 'classify', version: 2, inputs: { items: 'string[]' }, tags: { domain: 'demo' } },
  async default(ctx, inputs) {
    for (const it of inputs.items) {
      if (it.includes('bad')) ctx.log.fail('has-bad', { it });
      else ctx.log.ok({ it });
    }
    ctx.out.json('summary', { count: inputs.items.length });
    ctx.out.json('ctxkeys', Object.keys(ctx).sort());
  },
};

await test('runtime: a deterministic script runs and writes an immutable, tagged run.json', async () => {
  const fs = mkfs();
  const res = await runScript({ module: detScript, inputs: { items: ['ok1', 'bad2', 'ok3'] }, fs, now: fixedNow, nonce: 'aaaa', scriptSource: 'src', sha256 });
  assert(res.ok, 'ran');
  const rj = JSON.parse((await fs.read(res.runDir + 'run.json', { encoding: 'utf-8' })).data);
  eq(rj.status, 'complete', 'complete');
  eq(rj.ok, 2, '2 ok'); eq(rj.failed, 1, '1 failed');
  eq(rj.failures['has-bad'], 1, 'failure class counted');
  eq(rj.tags.domain, 'demo', 'tags flow onto run');
  eq(rj.scriptVersion, 2, 'version'); assert(rj.scriptHash.startsWith('sha256:'), 'hashed');
  const summary = JSON.parse((await fs.read(res.runDir + 'out/summary.json', { encoding: 'utf-8' })).data);
  eq(summary.count, 3, 'out artifact written');
});

await test('runtime: ctx exposes EXACTLY the §3.3 surface (no extra globals)', async () => {
  const fs = mkfs();
  const res = await runScript({ module: detScript, inputs: { items: ['ok'] }, fs, now: fixedNow, nonce: 'bbbb', sha256 });
  const keys = JSON.parse((await fs.read(res.runDir + 'out/ctxkeys.json', { encoding: 'utf-8' })).data);
  eq(JSON.stringify(keys), JSON.stringify([...CTX_KEYS].sort()), 'ctx keys match the frozen contract list');
});

await test('runtime: a secret NEVER survives into any persisted file (canary redaction)', async () => {
  const CANARY = 'CANARY-9f3a-secret-value';
  const script = {
    meta: { name: 'leaky', version: 1, grants: ['x.key'] },
    async default(ctx) {
      const s = ctx.vault.get('x.key');
      ctx.log.ok({ using: s });                 // tries to log the secret
      ctx.out.text('note', 'secret is ' + s);   // tries to write it to an artifact
    },
  };
  const fs = mkfs();
  const res = await runScript({ module: script, inputs: {}, fs, grants: { 'x.key': 'r1' }, store: createMemoryVaultStore({ r1: CANARY }), now: fixedNow, nonce: 'cccc', sha256 });
  assert(res.ok, 'ran');
  const audit = await auditRedaction({ fs, runDir: res.runDir, redactor: res.redactor });
  assert(audit.clean, 'no persisted file contains the secret: ' + JSON.stringify(audit.offenders));
  const note = (await fs.read(res.runDir + 'out/note.txt', { encoding: 'utf-8' })).data;
  assert(!note.includes(CANARY) && note.includes('[REDACTED]'), 'artifact redacted');
});

await test('runtime: a secret with quote/backslash/newline is redacted in its JSON-ESCAPED form too', async () => {
  const CANARY = 'pa"ss\\word\nCANARY-8b2c'; // contains " \ and newline → JSON-escaped when stringified
  const script = {
    meta: { name: 'esc', version: 1, grants: ['x.key'] },
    async default(ctx) { const s = ctx.vault.get('x.key'); ctx.log.ok({ using: s }); ctx.out.text('n', s); ctx.out.json('j', { [s]: 1 }); },
  };
  const fs = mkfs();
  const res = await runScript({ module: script, inputs: {}, fs, grants: { 'x.key': 'r1' }, store: createMemoryVaultStore({ r1: CANARY }), now: fixedNow, nonce: 'esc1', sha256 });
  const audit = await auditRedaction({ fs, runDir: res.runDir, redactor: res.redactor });
  assert(audit.clean, 'no persisted file contains the secret (raw or escaped): ' + JSON.stringify(audit.offenders));
  // belt-and-braces: the escaped substring must not appear literally either
  const log = (await fs.read(res.runDir + 'log.ndjson', { encoding: 'utf-8' })).data;
  assert(!log.includes('CANARY-8b2c'), 'canary token absent from the log');
});

await test('runtime: removability — explore() with no endpoint → run.json status error, class explore-unavailable', async () => {
  const script = { meta: { name: 'needsai', version: 1 }, async default(ctx) { await ctx.explore('do a thing'); } };
  const fs = mkfs();
  const res = await runScript({ module: script, inputs: {}, fs, explore: null, now: fixedNow, nonce: 'dddd', sha256 });
  const rj = JSON.parse((await fs.read(res.runDir + 'run.json', { encoding: 'utf-8' })).data);
  eq(rj.status, 'error', 'errored'); eq(rj.errorClass, 'explore-unavailable', 'class'); eq(rj.exploreCalls, 0, 'never counted');
});

await test('runtime: explore() with an endpoint is persisted per call', async () => {
  const script = { meta: { name: 'usesai', version: 1 }, async default(ctx) { const r = await ctx.explore('q'); ctx.log.ok({ r }); } };
  const fs = mkfs();
  const res = await runScript({ module: script, inputs: {}, fs, explore: async (p) => 'answer-to:' + p, now: fixedNow, nonce: 'eeee', sha256 });
  const rj = JSON.parse((await fs.read(res.runDir + 'run.json', { encoding: 'utf-8' })).data);
  eq(rj.exploreCalls, 1, 'counted'); eq(rj.status, 'complete', 'ok');
  const ex = JSON.parse((await fs.read(res.runDir + 'explore/1.json', { encoding: 'utf-8' })).data);
  eq(ex.response, 'answer-to:q', 'explore persisted'); eq(ex.codified, false, 'starts uncodified');
});

await test('runtime: run records are immutable (write-once)', async () => {
  const fs = mkfs();
  const common = { module: detScript, inputs: { items: ['ok'] }, fs, now: fixedNow, nonce: 'ffff', sha256 };
  assert((await runScript(common)).ok, 'first run ok');
  let threw = false; try { await runScript(common); } catch (e) { threw = /immutable/.test(e.message); }
  assert(threw, 'second run at same id refused as immutable');
});

await test('runtime: bad inputs reject BEFORE any run record is written', async () => {
  const fs = mkfs();
  const res = await runScript({ module: detScript, inputs: { items: 'not-an-array' }, fs, now: fixedNow, nonce: 'gggg', sha256 });
  assert(!res.ok && res.code === 'bad-inputs', 'rejected');
  const listed = await fs.list('.rote', { recursive: true });
  assert(!listed.ok || !(listed.entries || []).some((e) => e.name === 'run.json'), 'no run.json written for a rejected run');
});

await test('security: an artifact name cannot traverse out of out/ (no run.json forgery)', async () => {
  const script = { meta: { name: 'evil', version: 1 }, async default(ctx) { ctx.out.json('../run', { PLANTED: true, status: 'complete', ok: 9999 }); } };
  const fs = mkfs();
  const res = await runScript({ module: script, inputs: {}, fs, now: fixedNow, nonce: 'trav1', sha256 });
  assert(res.ok, 'runScript still returns a record');
  const rj = JSON.parse((await fs.read(res.runDir + 'run.json', { encoding: 'utf-8' })).data);
  eq(rj.status, 'error', 'the traversal throws → run errors');
  assert(rj.PLANTED === undefined && rj.ok !== 9999, 'run.json is the genuine record, not the forged object');
  const listed = await fs.list('.rote/runs/evil', { recursive: true });
  assert(!(listed.entries || []).some((e) => e.name === 'run.json' && !e.path.includes(res.runId)), 'no forged run.json elsewhere');
});

await test('security: a cross-run artifact path is rejected', async () => {
  const script = { meta: { name: 'evil2', version: 1 }, async default(ctx) { ctx.out.text('../../victim/out/injected', 'x'); } };
  const fs = mkfs();
  const res = await runScript({ module: script, inputs: {}, fs, now: fixedNow, nonce: 'trav2', sha256 });
  const rj = JSON.parse((await fs.read(res.runDir + 'run.json', { encoding: 'utf-8' })).data);
  eq(rj.status, 'error', 'rejected → errored');
  const victim = await fs.stat('.rote/runs/victim').catch(() => null);
  assert(!victim || !victim.ok, 'no sibling run dir was created');
});

await test('security: out.file refuses bytes that contain a registered secret', async () => {
  const CANARY = 'BINARY-CANARY-4d2e';
  const script = { meta: { name: 'binleak', version: 1, grants: ['k'] }, async default(ctx) { const s = ctx.vault.get('k'); ctx.out.file('leak.bin', new TextEncoder().encode('prefix ' + s)); } };
  const fs = mkfs();
  const res = await runScript({ module: script, inputs: {}, fs, grants: { k: 'r' }, store: createMemoryVaultStore({ r: CANARY }), now: fixedNow, nonce: 'bin1', sha256 });
  const rj = JSON.parse((await fs.read(res.runDir + 'run.json', { encoding: 'utf-8' })).data);
  eq(rj.status, 'error', 'refused → errored');
  const leak = await fs.stat(res.runDir + 'out/leak.bin').catch(() => null);
  assert(!leak || !leak.ok, 'no leaking binary artifact was written');
  const audit = await auditRedaction({ fs, runDir: res.runDir, redactor: res.redactor });
  assert(audit.clean, 'no persisted file contains the secret');
});

await test('security: validateMeta rejects an unsafe meta.name', () => {
  assert(!validateMeta({ name: '../etc', version: 1 }).ok, 'traversal name rejected');
  assert(!validateMeta({ name: 'a/b', version: 1 }).ok, 'slash name rejected');
  assert(!validateMeta({ name: '.hidden', version: 1 }).ok, 'leading dot rejected');
  assert(validateMeta({ name: 'news_letters-2', version: 1 }).ok, 'normal name ok');
});

await test('runtime: parentRunId comes from the option, not inputs', async () => {
  const fs = mkfs();
  const res = await runScript({ module: detScript, inputs: { items: ['ok'] }, fs, parentRunId: 'r-parent-123', now: fixedNow, nonce: 'par1', sha256 });
  const rj = JSON.parse((await fs.read(res.runDir + 'run.json', { encoding: 'utf-8' })).data);
  eq(rj.parentRunId, 'r-parent-123', 're-run points at its parent');
});

await test('runtime: log.fail requires a failure class', async () => {
  const script = { meta: { name: 'noclass', version: 1 }, async default(ctx) { ctx.log.fail('', {}); } };
  const fs = mkfs();
  const res = await runScript({ module: script, inputs: {}, fs, now: fixedNow, nonce: 'hhhh', sha256 });
  const rj = JSON.parse((await fs.read(res.runDir + 'run.json', { encoding: 'utf-8' })).data);
  eq(rj.status, 'error', 'throwing in fail() errors the run');
});

await test('makeRunId format', () => {
  eq(makeRunId(Date.parse('2026-08-27T09:14:02.123Z'), '7f3a'), '2026-08-27T09-14-02Z-7f3a', 'id shape');
});

if (failures.length) {
  console.error(`rote-core: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`rote-core conformance: ${passed}/${passed} passed`);
