// Conformance — belief-revising project memory (Agno "learning machine" mechanism):
// a learning is a hypothesis, promoted on corroboration, retracted on disproof.
//   node sys/ai/test/memory-belief.test.mjs
import { parseFact, noteToFact, buildMemoryIndex, applyRevision, reviseTool, MEMORY_STATUSES } from '../memory-store.mjs';

let passed = 0; const failures = [];
async function test(n, fn){ try{ await fn(); passed++; }catch(e){ failures.push({ n, message: e.message }); } }
function assert(c, m){ if(!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m){ if(a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

await test('parseFact reads status; unknown/absent → null (plain fact)', () => {
  eq(parseFact('---\nname: x\nstatus: hypothesis\n---\nb').status, 'hypothesis', 'valid status');
  eq(parseFact('---\nname: x\nstatus: bogus\n---\nb').status, null, 'bogus → null');
  eq(parseFact('---\nname: x\n---\nb').status, null, 'absent → null (back-compat)');
});

await test('noteToFact stamps a status when given; omits it otherwise (back-compat)', () => {
  const h = noteToFact('Retries live in net/retry.js', 'reference', 'hypothesis');
  eq(h.status, 'hypothesis', 'status carried');
  assert(h.file.includes('status: hypothesis'), 'status line written');
  const plain = noteToFact('Retries live in net/retry.js', 'reference');
  eq(plain.status, null, 'no status by default');
  assert(!/status:/.test(plain.file), 'no status line when omitted');
});

await test('buildMemoryIndex: tags hypotheses, hides+counts retracted, leaves plain facts intact', () => {
  const out = buildMemoryIndex([
    { name: 'plain', type: 'reference', description: 'the API is in api/', status: null },
    { name: 'guess', type: 'project', description: 'cache is redis', status: 'hypothesis' },
    { name: 'sure', type: 'project', description: 'db is postgres', status: 'verified' },
    { name: 'wrong', type: 'project', description: 'build uses make', status: 'retracted' },
  ]);
  assert(out.includes('**plain** (reference): the API is in api/'), 'plain fact unchanged (back-compat line format)');
  assert(/\*\*guess\*\* \(project\): cache is redis _\(hypothesis/.test(out), 'hypothesis tagged');
  assert(out.includes('**sure** (project): db is postgres') && !/sure.*hypothesis/.test(out), 'verified is untagged');
  assert(!out.includes('build uses make'), 'retracted fact is hidden');
  assert(/1 fact\(s\) were retracted/.test(out), 'retracted count noted');
  assert(/`revise`/.test(out) && /`recall`/.test(out) && /`remember`/.test(out), 'names revise + recall + remember');
});

await test('applyRevision: sets status, appends a reasoned note, preserves identity, round-trips', () => {
  const src = '---\nname: cache-guess\ndescription: cache is redis\ntype: project\nstatus: hypothesis\n---\nThe cache looked like redis.';
  const retr = applyRevision(src, { status: 'retracted', reason: 'grep shows memcached, not redis' });
  const p = parseFact(retr);
  eq(p.status, 'retracted', 'status flipped'); eq(p.name, 'cache-guess', 'name kept'); eq(p.type, 'project', 'type kept');
  assert(p.body.includes('Revised → retracted:') && p.body.includes('memcached'), 'reasoned revision note appended');
  const prom = applyRevision(src, { status: 'verified', reason: 'test suite confirms redis' });
  eq(parseFact(prom).status, 'verified', 'promotion works');
});

await test('reviseTool exposes name + status(verified|retracted) + reason', () => {
  const t = reviseTool();
  eq(t.function.name, 'revise', 'named revise');
  const props = t.function.parameters.properties;
  assert(props.status.enum.includes('verified') && props.status.enum.includes('retracted'), 'both statuses offered');
  assert(t.function.parameters.required.includes('name') && t.function.parameters.required.includes('status'), 'name+status required');
  eq(MEMORY_STATUSES.length, 3, 'three statuses');
});

if (failures.length) {
  console.error(`Memory belief-revision: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`Memory belief-revision: ${passed} passed — hypothesis→verified/retracted status, tagged/hidden in the index, revise tool + applyRevision, back-compat preserved.`);
