// Conformance — P0.2 the FIF: durable, encrypted local identity storage.
//   node sys/identity/test/fif.test.mjs
//
// The point of this module is that identity SURVIVES A RELOAD, so most tests
// here drop the store and build a fresh one over the same backing cell — that
// second store is the next page load.
//
// KDF iterations are lowered throughout: this exercises the format and the
// lifecycle, not PBKDF2's cost factor (production uses PBKDF2_ITERATIONS).

import { createFifStore, memoryBackend, FifPassphraseError, FIF_VERSION } from '../fif.mjs';
import { mintPrincipal, verifyDescriptor } from '../principal.mjs';
import { issueGrant, verifyGrant, caveat } from '../grant.mjs';
import { sign, verify, b64uEncode } from '../crypto.mjs';

const ITER = 1000; // test-only cost factor
let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
async function throws(fn, code, m) {
  try { await fn(); } catch (e) { if (code && e.code !== code) throw new Error(`${m}: expected code ${code}, got ${e.code} (${e.message})`); return e; }
  throw new Error(m || 'expected a throw');
}

// A shared cell = one device's storage; a new store over it = a new page load.
function device() {
  let cell = null;
  const backend = { async read() { return cell; }, async write(v) { cell = v; }, async clear() { cell = null; } };
  return { backend, peek: () => cell, open: () => createFifStore({ backend, iterations: ITER }) };
}

await test('create writes an encrypted vault; nothing sensitive is in the clear', async () => {
  const dev = device();
  const fif = dev.open();
  eq(await fif.exists(), false, 'no vault yet');
  await fif.create('correct horse battery staple');
  eq(await fif.exists(), true, 'vault exists');

  const raw = dev.peek();
  eq(raw.version, FIF_VERSION, 'version stamped');
  eq(raw.kdf.algo, 'PBKDF2-SHA256', 'kdf params stored with the vault, so a KDF upgrade re-wraps');
  assert(raw.kdf.salt && raw.body.iv && raw.body.ct, 'salt + iv + ciphertext present');
  // The root key must not be readable from the record.
  const onDisk = JSON.stringify(raw);
  assert(!onDisk.includes(b64uEncode(fif.rootKey())), 'the root key is NOT in the stored record');
});

await test('a locked FIF refuses every accessor', async () => {
  const fif = device().open();
  await fif.create('pw', {});
  eq(fif.locked, false, 'open after create');
  fif.lock();
  eq(fif.locked, true, 'locked');
  await throws(() => fif.rootKey(), 'ELOCKED', 'rootKey while locked');
  await throws(() => fif.listPrincipals(), 'ELOCKED', 'listPrincipals while locked');
  await throws(() => fif.revocationList(), 'ELOCKED', 'revocationList while locked');
});

await test('the wrong passphrase fails closed with a distinct error', async () => {
  const dev = device();
  await dev.open().create('right-passphrase');
  const e = await throws(() => dev.open().unlock('wrong-passphrase'), 'EPASS', 'wrong passphrase');
  assert(e instanceof FifPassphraseError, 'typed error');
});

await test('the root key survives a reload — grants issued before it still verify after', async () => {
  const dev = device();
  const first = dev.open();
  await first.create('pw');
  const grant = await issueGrant(first.rootKey(), { caveats: [caveat.tools(['reckon.stage'])] });

  const next = dev.open(); // the next page load
  await next.unlock('pw');
  const v = await verifyGrant(grant, next.rootKey(), { tool: 'reckon.stage', revocationList: next.revocationList() });
  eq(v.ok, true, `a grant from the previous session verifies: ${v.reason}`);
});

await test('a minted agent — descriptor AND usable private key — survives a reload', async () => {
  const dev = device();
  const first = dev.open();
  await first.create('pw');

  const person = await mintPrincipal(null, { kind: 'person', label: 'Chirag' });
  const agent = await mintPrincipal(person, { kind: 'agent', label: 'summariser' });
  await first.putPrincipal(person);
  await first.putPrincipal(agent);

  const next = dev.open();
  await next.unlock('pw');
  eq(next.listPrincipals().length, 2, 'both principals persisted');

  const back = await next.getPrincipal(agent.descriptor.id);
  assert(back, 'agent found by id');
  eq(back.descriptor.mintedBy, person.descriptor.id, 'the attribution link survived');
  // The private key round-tripped only if it can still sign.
  const sig = await sign(back.keypair.privateKey, 'after the reload');
  assert(await verify(back.descriptor.pubkey, sig, 'after the reload'), 'the reloaded private key still signs');
  // And the attribution still verifies against the minter's stored pubkey.
  const rehydratedPerson = await next.getPrincipal(person.descriptor.id);
  assert(await verifyDescriptor(back.descriptor, rehydratedPerson.descriptor.pubkey), 'agent verifies against its stored minter');
});

await test('grants and the revocation list persist; a revoked grant stops verifying', async () => {
  const dev = device();
  const first = dev.open();
  await first.create('pw');
  const grant = await issueGrant(first.rootKey(), { caveats: [caveat.tools(['draft.stage'])] });
  await first.putGrant(grant, { label: 'summariser session' });
  eq(first.listGrants().length, 1, 'stored');
  eq(first.listGrants()[0].label, 'summariser session', 'label kept');

  const next = dev.open();
  await next.unlock('pw');
  eq(next.getGrant(grant.identifier).identifier, grant.identifier, 'grant retrievable after reload');
  const ok = await verifyGrant(grant, next.rootKey(), { tool: 'draft.stage', revocationList: next.revocationList() });
  eq(ok.ok, true, 'verifies before revocation');

  await next.revoke(grant.identifier);
  const after = dev.open();
  await after.unlock('pw');
  assert(after.revocationList().has(grant.identifier), 'revocation persisted across the reload');
  const denied = await verifyGrant(grant, after.rootKey(), { tool: 'draft.stage', revocationList: after.revocationList() });
  eq(denied.ok, false, 'revoked grant refused'); eq(denied.reason, 'revoked', 'and says why');
});

await test('putGrant replaces rather than duplicating the same identifier', async () => {
  const fif = device().open();
  await fif.create('pw');
  const g = await issueGrant(fif.rootKey(), { caveats: [] });
  await fif.putGrant(g, { label: 'first' });
  await fif.putGrant(g, { label: 'second' });
  eq(fif.listGrants().length, 1, 'one record');
  eq(fif.listGrants()[0].label, 'second', 'latest wins');
});

await test('create refuses to clobber an existing vault unless forced', async () => {
  const dev = device();
  const first = dev.open();
  await first.create('pw');
  const before = b64uEncode(first.rootKey());
  await throws(() => dev.open().create('other'), undefined, 'clobber refused');

  const forced = dev.open();
  await forced.create('other', { force: true });
  assert(b64uEncode(forced.rootKey()) !== before, 'forcing really does mint a new root key');
});

await test('a tampered vault fails to decrypt rather than silently loading', async () => {
  const dev = device();
  await dev.open().create('pw');
  dev.peek().kdf.salt = b64uEncode(new Uint8Array(16).fill(7)); // move the record to different KDF params
  await throws(() => dev.open().unlock('pw'), 'EPASS', 'tampered salt rejected');
});

await test('an external principal (no private key) stores and reloads', async () => {
  const dev = device();
  const first = dev.open();
  await first.create('pw');
  const peer = await mintPrincipal(null, { kind: 'person', label: 'peer' });
  await first.putPrincipal({ descriptor: peer.descriptor, keypair: null });

  const next = dev.open();
  await next.unlock('pw');
  const rec = await next.getPrincipal(peer.descriptor.id);
  eq(rec.keypair, null, 'no private key held');
  eq(rec.descriptor.label, 'peer', 'descriptor intact');
});

if (failures.length) { console.error(`identity/fif: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`identity/fif conformance: ${passed}/${passed} passed`);
