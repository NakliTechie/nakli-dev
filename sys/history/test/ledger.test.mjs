// Conformance — P0.3 History ledger.
//   node sys/history/test/ledger.test.mjs
import { appendEvent, eventHash, verifyChain, mergeChains, toNDJSON, fromNDJSON, replay, contentHash, DOORS } from '../ledger.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// Build a single store's chain from a list of partial events.
async function buildChain(app, partials) {
  const events = []; let head = null;
  for (const p of partials) { const r = await appendEvent(head, { app, ...p }); events.push(r.event); head = r.head; }
  return events;
}

await test('appendEvent commits content by hash and links prev_hash', async () => {
  const evs = await buildChain('reckon', [
    { ts: 1, principal: 'prin_agent', door: 'call', tool: 'reckon.stage', input: { a: 1 }, output: { diff: 'x' }, grant_id: 'g1' },
    { ts: 2, principal: 'prin_agent', door: 'call', tool: 'reckon.stage', input: { a: 2 }, output: { diff: 'y' }, grant_id: 'g1' },
  ]);
  eq(evs[0].prev_hash, null, 'genesis prev_hash null');
  eq(evs[1].prev_hash, await eventHash(evs[0]), 'second links to first');
  assert(evs[0].input_hash.startsWith('sha256:') && evs[0].output_hash.startsWith('sha256:'), 'content hashed, not stored');
  assert(!('input' in evs[0]), 'raw input not persisted in the event');
});

await test('verifyChain passes intact, and pinpoints a tamper', async () => {
  const evs = await buildChain('draft', [
    { ts: 1, principal: 'p', door: 'ui', tool: 'draft.stage', input: {}, output: { d: 1 } },
    { ts: 2, principal: 'p', door: 'ui', tool: 'draft.stage', input: {}, output: { d: 2 } },
    { ts: 3, principal: 'p', door: 'ui', tool: 'draft.stage', input: {}, output: { d: 3 } },
  ]);
  eq((await verifyChain(evs)).ok, true, 'intact chain verifies');
  const tampered = evs.map((e, i) => i === 1 ? { ...e, tool: 'draft.commit' } : e); // edit event[1]
  const v = await verifyChain(tampered);
  eq(v.ok, false, 'tamper detected');
  eq(v.brokenAt, 2, 'break surfaces at the event whose prev_hash no longer matches');
});

await test('mergeChains orders by ts, keeps per-app chains intact', async () => {
  const reckon = await buildChain('reckon', [{ ts: 10, principal: 'p', door: 'call', tool: 'reckon.stage', input: {}, output: {} }, { ts: 30, principal: 'p', door: 'call', tool: 'reckon.stage', input: {}, output: {} }]);
  const draft = await buildChain('draft', [{ ts: 20, principal: 'p', door: 'call', tool: 'draft.stage', input: {}, output: {} }]);
  const merged = mergeChains({ reckon, draft });
  eq(merged.map((e) => e.ts).join(','), '10,20,30', 'time-ordered across apps');
  eq((await verifyChain(reckon)).ok, true, 'reckon chain still verifies after merge');
  eq((await verifyChain(draft)).ok, true, 'draft chain still verifies after merge');
});

await test('M0: a 2-app run replays every staged diff from the NDJSON alone', async () => {
  // seed: a diff store keyed by output_hash (content-addressed)
  const diffs = { r1: { cells: 'A1=42' }, d1: { steps: 'insert' } };
  const reckon = await buildChain('reckon', [{ ts: 1, principal: 'prin_agent', door: 'call', tool: 'reckon.stage', input: {}, output: diffs.r1, grant_id: 'g' }]);
  const draft = await buildChain('draft', [{ ts: 2, principal: 'prin_agent', door: 'call', tool: 'draft.stage', input: {}, output: diffs.d1, grant_id: 'g' }]);
  const ledger = mergeChains({ reckon, draft });
  const ndjson = toNDJSON(ledger);
  // reconstruct from the exported bytes alone + the content-addressed store
  const store = { [await contentHash(diffs.r1)]: diffs.r1, [await contentHash(diffs.d1)]: diffs.d1 };
  const reconstructed = replay(fromNDJSON(ndjson), (e) => store[e.output_hash]);
  eq(reconstructed.length, 2, 'both diffs reconstructed');
  eq(reconstructed[0].effect.cells, 'A1=42', 'reckon diff'); eq(reconstructed[1].effect.steps, 'insert', 'draft diff');
});

await test('unknown door rejected; DOORS frozen', async () => {
  let threw = false; try { await appendEvent(null, { ts: 1, principal: 'p', door: 'sideways', tool: 't', app: 'a', input: {}, output: {} }); } catch (_) { threw = true; }
  assert(threw, 'bad door rejected');
  assert(DOORS.includes('ui') && DOORS.includes('call') && DOORS.includes('brief') && DOORS.includes('net'), 'doors');
  const netEvt = await appendEvent(null, { ts: 1, principal: 'p', door: 'net', tool: 'fetch', app: 'anvil', input: { url_host: 'github.com' }, output: { status: 200 } });
  assert(netEvt && netEvt.event.door === 'net', 'net door accepted (egress History entry)');
});

if (failures.length) { console.error(`history/ledger: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`history/ledger conformance: ${passed}/${passed} passed`);
