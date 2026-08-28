// Conformance — P0.2 machine principals (Identity).
//   node sys/identity/test/principal.test.mjs
import { mintPrincipal, verifyDescriptor, principalId, importExternal, exportKeypair, importKeypair, PRINCIPAL_KINDS } from '../principal.mjs';
import { exportRawPub, sign, verify, b64uDecode } from '../crypto.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message + (e.stack ? '\n' + e.stack.split('\n')[1] : '') }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const now = () => Date.parse('2026-08-27T12:00:00Z');

await test('mint a root person (self-signed) and verify it', async () => {
  const person = await mintPrincipal(null, { kind: 'person', label: 'Chirag', now });
  eq(person.descriptor.kind, 'person', 'kind');
  eq(person.descriptor.mintedBy, null, 'root has no minter');
  assert(await verifyDescriptor(person.descriptor), 'self-signed verifies');
  eq(person.descriptor.id, await principalId(person.descriptor.pubkey), 'id = hash(pubkey)');
});

await test('a person mints an agent; it verifies against the person and carries the minting link', async () => {
  const person = await mintPrincipal(null, { kind: 'person', label: 'Chirag', now });
  const agent = await mintPrincipal(person, { kind: 'agent', label: 'Anvil worker', now });
  const personPub = await exportRawPub(person.keypair.publicKey);
  assert(await verifyDescriptor(agent.descriptor, personPub), 'agent verifies against its minter');
  eq(agent.descriptor.mintedBy, person.descriptor.id, 'attribution root = the person');
  // a different minter key must NOT verify it
  const other = await mintPrincipal(null, { kind: 'person', now });
  const otherPub = await exportRawPub(other.keypair.publicKey);
  assert(!(await verifyDescriptor(agent.descriptor, otherPub)), 'wrong minter fails');
});

await test('a tampered descriptor fails verification', async () => {
  const person = await mintPrincipal(null, { kind: 'person', now });
  const agent = await mintPrincipal(person, { kind: 'agent', label: 'orig', now });
  const personPub = await exportRawPub(person.keypair.publicKey);
  const tampered = { ...agent.descriptor, label: 'ESCALATED' };
  assert(!(await verifyDescriptor(tampered, personPub)), 'label tamper detected');
  const wrongId = { ...agent.descriptor, id: 'prin_deadbeef' };
  assert(!(await verifyDescriptor(wrongId, personPub)), 'id tamper detected');
});

await test('unknown / external kinds handled', async () => {
  let threw = false; try { await mintPrincipal(null, { kind: 'robot' }); } catch (_) { threw = true; }
  assert(threw, 'unknown kind rejected');
  let threw2 = false; try { await mintPrincipal(null, { kind: 'external' }); } catch (_) { threw2 = true; }
  assert(threw2, 'external is imported, not minted');
  const ext = await importExternal(new Uint8Array(32).fill(7), { label: 'peer' });
  eq(ext.kind, 'external', 'external imported'); assert(ext.id.startsWith('prin_'), 'has id');
});

await test('keypair export/import round-trips (signs + verifies)', async () => {
  const p = await mintPrincipal(null, { kind: 'agent', now });
  const dump = await exportKeypair(p.keypair);
  const restored = await importKeypair(dump);
  const msg = new TextEncoder().encode('authority');
  const sig = await sign(restored.privateKey, msg);
  const raw = await exportRawPub(restored.publicKey);
  assert(await verify(raw, sig, msg), 'restored key signs, pub verifies');
});

await test('PRINCIPAL_KINDS frozen set', () => {
  assert(PRINCIPAL_KINDS.includes('person') && PRINCIPAL_KINDS.includes('agent'), 'kinds');
});

if (failures.length) { console.error(`identity/principal: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`identity/principal conformance: ${passed}/${passed} passed`);
