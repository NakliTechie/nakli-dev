// Conformance — belief-revising project memory (our status model; Agno-inspired, not Agno's):
// a learning is a hypothesis, promoted on corroboration, retracted on disproof.
// A1 (2026-09-05): facts are RELATED — supersedes / derived_from / contradicts, a
// closed-set revision cause, revalidation when a basis is retracted, single-valued slots.
//   node sys/ai/test/memory-belief.test.mjs
import { parseFact, noteToFact, buildMemoryIndex, applyRevision, applyDemotion, dependantsOf,
         serializeFact, slotHolder, reviseTool, MEMORY_STATUSES, MEMORY_RELATIONS, REVISION_CAUSES }
  from '../memory-store.mjs';

let passed = 0; const failures = [];
async function test(n, fn){ try{ await fn(); passed++; }catch(e){ failures.push({ n, message: e.message }); } }
function assert(c, m){ if(!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m){ if(a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const F = (name, extra = {}) => ({ name, description: `${name} desc`, type: 'project', status: null, cause: null, slot: null, supersedes: [], derived_from: [], contradicts: [], body: `${name} body`, ...extra });

await test('parseFact reads status; unknown/absent → null (plain fact)', () => {
  eq(parseFact('---\nname: x\nstatus: hypothesis\n---\nb').status, 'hypothesis', 'valid status');
  eq(parseFact('---\nname: x\nstatus: bogus\n---\nb').status, null, 'bogus → null');
  eq(parseFact('---\nname: x\n---\nb').status, null, 'absent → null (older files)');
});

await test('noteToFact stamps a status when given; omits it otherwise', () => {
  const h = noteToFact('Retries live in net/retry.js', 'reference', 'hypothesis');
  eq(h.status, 'hypothesis', 'status carried');
  assert(h.file.includes('status: hypothesis'), 'status line written');
  const plain = noteToFact('Retries live in net/retry.js', 'reference');
  eq(plain.status, null, 'no status by default');
  assert(!/status:/.test(plain.file), 'no status line when omitted');
  assert(!/supersedes:|derived_from:|contradicts:|slot:/.test(plain.file), 'no relation lines when none given');
});

await test('relations round-trip: parseFact ⇄ serializeFact, lists comma-separated, slugs sanitised', () => {
  const src = '---\nname: db-is-postgres\ndescription: db is postgres\ntype: project\nstatus: verified\ncause: temporal_change\nslot: Database\nsupersedes: db-is-mysql, Old Guess\nderived_from: config-file\ncontradicts: db-is-mysql\n---\nSeen in config.';
  const f = parseFact(src);
  eq(f.slot, 'database', 'slot slugified');
  eq(f.cause, 'temporal_change', 'cause parsed');
  eq(f.supersedes.join('|'), 'db-is-mysql|Old|Guess', 'lists split on commas and whitespace (names are slugs)');
  eq(f.derived_from.join('|'), 'config-file', 'derived_from parsed');
  eq(f.contradicts.join('|'), 'db-is-mysql', 'contradicts parsed');
  const back = parseFact(serializeFact(f));
  for (const rel of MEMORY_RELATIONS) assert(Array.isArray(back[rel]), `${rel} is a list after round-trip`);
  eq(back.slot, 'database', 'slot survives'); eq(back.cause, 'temporal_change', 'cause survives'); eq(back.status, 'verified', 'status survives');
  assert(serializeFact(f).includes('supersedes: db-is-mysql, old, guess'), 'serialised as a comma list of slugs');
  eq(MEMORY_RELATIONS.length, 3, 'three relations'); eq(REVISION_CAUSES.length, 5, 'five causes');
});

await test('noteToFact carries slot / derived_from / supersedes into the file', () => {
  const f = noteToFact('Build tool is vite', 'project', 'hypothesis', { slot: 'build tool', derived_from: ['package-json'], supersedes: 'build-tool-is-webpack' });
  const p = parseFact(f.file);
  eq(p.slot, 'buildtool', 'slot written and sanitised');
  eq(p.derived_from[0], 'package-json', 'derived_from written');
  eq(p.supersedes[0], 'build-tool-is-webpack', 'supersedes written');
});

await test('buildMemoryIndex: tags hypotheses, hides+counts retracted, leaves plain facts intact', () => {
  const out = buildMemoryIndex([
    F('plain', { type: 'reference', description: 'the API is in api/' }),
    F('guess', { description: 'cache is redis', status: 'hypothesis' }),
    F('sure', { description: 'db is postgres', status: 'verified' }),
    F('wrong', { description: 'build uses make', status: 'retracted' }),
  ]);
  assert(out.includes('**plain** (reference): the API is in api/'), 'plain fact unchanged (line format)');
  assert(/\*\*guess\*\* \(project\): cache is redis _\(hypothesis/.test(out), 'hypothesis tagged');
  assert(out.includes('**sure** (project): db is postgres') && !/sure.*hypothesis/.test(out), 'verified is untagged');
  assert(!out.includes('build uses make'), 'retracted fact is hidden');
  assert(/1 fact\(s\) were retracted/.test(out), 'retracted count noted');
  assert(/`revise`/.test(out) && /`recall`/.test(out) && /`remember`/.test(out), 'names revise + recall + remember');
});

await test('buildMemoryIndex: a superseded fact renders AFTER its successor, tagged — never above its own correction', () => {
  const out = buildMemoryIndex([
    F('old-db', { description: 'db is mysql' }),                      // listed first on disk…
    F('other', { description: 'unrelated' }),
    F('new-db', { description: 'db is postgres', supersedes: ['old-db'] }), // …but its successor must come first
  ]);
  const rows = out.split('\n').filter(l => l.startsWith('- **'));
  const at = (n) => rows.findIndex(l => l.startsWith(`- **${n}**`));
  assert(at('new-db') >= 0 && at('old-db') >= 0 && at('other') >= 0, 'all three rendered');
  assert(at('new-db') < at('old-db'), 'successor above the stale row');
  eq(at('old-db'), at('new-db') + 1, 'the stale row rides immediately under its successor');
  eq(at('other'), 0, 'an unrelated fact keeps its disk order (it was listed before the successor)');
  assert(/\*\*old-db\*\*.*_\(superseded by \*\*new-db\*\* — prefer it\)_/.test(out), 'stale row tagged with its successor');
  assert(!/\*\*new-db\*\*.*superseded by/.test(out), 'the successor itself is not tagged');
  assert(/superseded.*prefer the replacement/i.test(out), 'the header explains the tag');
  // a retracted successor does not supersede anything
  const out2 = buildMemoryIndex([F('a', {}), F('b', { supersedes: ['a'], status: 'retracted' })]);
  assert(!/superseded by/.test(out2), 'a retracted fact supersedes nothing');
});

await test('applyRevision: sets status + cause + contradicts, appends a reasoned note, preserves relations', () => {
  const src = '---\nname: cache-guess\ndescription: cache is redis\ntype: project\nstatus: hypothesis\nslot: cache\nderived_from: docker-compose\n---\nThe cache looked like redis.';
  const retr = applyRevision(src, { status: 'retracted', reason: 'grep shows memcached, not redis', cause: 'correction', contradicts: 'cache-is-memcached' });
  const p = parseFact(retr);
  eq(p.status, 'retracted', 'status flipped'); eq(p.name, 'cache-guess', 'name kept'); eq(p.type, 'project', 'type kept');
  eq(p.cause, 'correction', 'cause recorded'); eq(p.contradicts[0], 'cache-is-memcached', 'contradicts recorded');
  eq(p.slot, 'cache', 'slot preserved'); eq(p.derived_from[0], 'docker-compose', 'derived_from preserved');
  assert(p.body.includes('Revised → retracted (correction):') && p.body.includes('memcached'), 'reasoned, caused revision note appended');
  const prom = applyRevision(src, { status: 'verified', reason: 'test suite confirms redis' });
  eq(parseFact(prom).status, 'verified', 'promotion works'); eq(parseFact(prom).cause, null, 'no cause on a promotion');
  eq(parseFact(applyRevision(src, { status: 'retracted', cause: 'bogus' })).cause, null, 'unknown cause dropped, not invented');
});

await test('revalidation: retracting a basis names every dependant, transitively, live ones only', () => {
  const facts = [
    F('basis'), F('child', { derived_from: ['basis'], status: 'verified' }),
    F('grandchild', { derived_from: ['child'], status: 'hypothesis' }),
    F('dead', { derived_from: ['basis'], status: 'retracted' }),
    F('unrelated', { derived_from: ['other'] }),
  ];
  eq(dependantsOf(facts, 'basis').join(','), 'child,grandchild', 'transitive cascade; retracted and unrelated excluded');
  eq(dependantsOf(facts, 'nobody').length, 0, 'no dependants → empty');
  const demoted = parseFact(applyDemotion(serializeFact(facts[1]), { basis: 'basis' }));
  eq(demoted.status, 'hypothesis', 'verified → hypothesis');
  assert(demoted.body.includes('Basis retracted:') && demoted.body.includes('`basis`'), 'the note names the basis');
  eq(demoted.derived_from[0], 'basis', 'provenance kept — the link is the audit trail');
  eq(parseFact(applyDemotion(serializeFact(facts[3]), { basis: 'basis' })).status, 'retracted', 'a retracted dependant stays retracted');
});

await test('slots: the holder is the newest live fact in that slot; retracted/superseded never hold', () => {
  const facts = [F('db1', { slot: 'db' }), F('db2', { slot: 'db', supersedes: ['db1'] }), F('db3', { slot: 'db', status: 'retracted' })];
  eq(slotHolder(facts, 'db'), 'db2', 'db2 holds: db1 superseded, db3 retracted');
  eq(slotHolder(facts, 'DB '), 'db2', 'slot lookup is sanitised');
  eq(slotHolder(facts, 'free'), null, 'empty slot → null');
  eq(slotHolder([F('x', { slot: 'db', status: 'retracted' })], 'db'), null, 'a retracted holder is no holder');
});

await test('reviseTool exposes name + status(verified|retracted) + reason + cause enum + contradicts', () => {
  const t = reviseTool();
  eq(t.function.name, 'revise', 'named revise');
  const props = t.function.parameters.properties;
  assert(props.status.enum.includes('verified') && props.status.enum.includes('retracted'), 'both statuses offered');
  eq(props.cause.enum.join(','), REVISION_CAUSES.join(','), 'cause enum is the closed set');
  assert(props.contradicts, 'contradicts offered');
  assert(t.function.parameters.required.includes('name') && t.function.parameters.required.includes('status'), 'name+status required');
  assert(/demotes every fact derived from it/.test(t.function.description), 'the tool tells the model about the cascade');
  eq(MEMORY_STATUSES.length, 3, 'three statuses');
});

if (failures.length) {
  console.error(`Memory belief-revision: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`Memory belief-revision: ${passed} passed — status model, typed relations (supersedes/derived_from/contradicts), revision cause, revalidation cascade, slots.`);
