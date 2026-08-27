// Conformance — OverlayBackend: copy-on-write worktree over a base backend.
//   node sys/rig/fileops/test/overlay-backend.test.mjs
import { MemoryBackend } from '../memory-backend.mjs';
import { OverlayBackend } from '../overlay-backend.mjs';
import { createFileops } from '../fileops.mjs';

let passed = 0; const failures = [];
async function test(n, fn){ try { await fn(); passed++; } catch (e){ failures.push({ n, message: e.message }); } }
function assert(c, m){ if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m){ if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const enc = (s) => new TextEncoder().encode(s);
const dec = (u) => new TextDecoder().decode(u);

async function seed(){
  const base = new MemoryBackend();
  await base.write('README.md', enc('root readme'));
  await base.write('src/app.js', enc('app'));
  await base.write('src/util.js', enc('util'));
  await base.write('docs/guide.md', enc('guide'));
  return base;
}

await test('read falls through to base; base is not mutated by the overlay', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  eq(dec(await ov.readBinary('src/app.js')), 'app', 'reads base file');
  await ov.write('src/app.js', enc('CHANGED'));
  eq(dec(await ov.readBinary('src/app.js')), 'CHANGED', 'overlay shadows base');
  eq(dec(await base.readBinary('src/app.js')), 'app', 'base untouched');
});

await test('delete tombstones in the overlay only', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  await ov.delete('README.md');
  eq(await ov.exists('README.md'), false, 'gone from overlay');
  let threw = false; try { await ov.readBinary('README.md'); } catch (_){ threw = true; }
  assert(threw, 'read of tombstoned throws');
  eq(await base.exists('README.md'), true, 'base still has it');
});

await test('write of a new deep file creates implicit dirs in the merged view', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  await ov.write('lib/deep/x.txt', enc('x'));
  eq((await ov.stat('lib')).type, 'dir', 'new dir exists');
  eq((await ov.stat('lib/deep')).type, 'dir', 'nested dir exists');
  const top = await ov.list('');
  assert(top.includes('lib/'), 'lib/ shows at root');
  assert(top.includes('README.md'), 'base root file still lists');
});

await test('list merges base + overlay, applies tombstones', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  await ov.write('src/new.js', enc('new'));
  await ov.delete('src/util.js');
  const kids = await ov.list('src');
  assert(kids.includes('src/app.js'), 'kept app.js');
  assert(kids.includes('src/new.js'), 'added new.js');
  assert(!kids.includes('src/util.js'), 'tombstoned util.js hidden');
});

await test('a base dir emptied purely by tombstones vanishes from the overlay view', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  await ov.delete('docs/guide.md'); // the only file under docs/
  eq(await ov.stat('docs'), null, 'docs dir gone');
  const top = await ov.list('');
  assert(!top.includes('docs/'), 'docs/ no longer listed');
  eq(await base.exists('docs'), true, 'base docs dir intact');
});

await test('two overlays over one base are isolated from each other', async () => {
  const base = await seed();
  const a = new OverlayBackend(base);
  const b = new OverlayBackend(base);
  await a.write('src/app.js', enc('from-A'));
  await b.write('src/app.js', enc('from-B'));
  await b.write('b-only.txt', enc('b'));
  eq(dec(await a.readBinary('src/app.js')), 'from-A', 'A sees its own write');
  eq(dec(await b.readBinary('src/app.js')), 'from-B', 'B sees its own write');
  eq(await a.exists('b-only.txt'), false, "A can't see B's new file");
  eq(dec(await base.readBinary('src/app.js')), 'app', 'base still original');
});

await test('changes() reports written + deleted, sorted', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  await ov.write('z.txt', enc('z'));
  await ov.write('a.txt', enc('a'));
  await ov.delete('README.md');
  const ch = ov.changes();
  eq(JSON.stringify(ch.written), JSON.stringify(['a.txt', 'z.txt']), 'written sorted');
  eq(JSON.stringify(ch.deleted), JSON.stringify(['README.md']), 'deleted listed');
  assert(ov.hasChanges(), 'hasChanges true');
  assert(!new OverlayBackend(base).hasChanges(), 'fresh overlay has no changes');
});

await test('commit replays writes then deletes onto a target via the applier', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  await ov.write('src/app.js', enc('MERGED'));
  await ov.write('brand/new.txt', enc('n'));
  await ov.delete('docs/guide.md');
  const order = [];
  const applied = await ov.commit({
    write: async (p, bytes) => { order.push('w:' + p); await base.write(p, bytes); },
    remove: async (p) => { order.push('d:' + p); await base.delete(p); },
  });
  eq(dec(await base.readBinary('src/app.js')), 'MERGED', 'base updated');
  eq(dec(await base.readBinary('brand/new.txt')), 'n', 'new file landed');
  eq(await base.exists('docs/guide.md'), false, 'deleted on base');
  eq(order[0], 'w:brand/new.txt', 'writes before deletes, sorted');
  eq(order[order.length - 1], 'd:docs/guide.md', 'delete last');
  eq(applied.written.length, 2, 'reported 2 writes');
});

await test('delete isolation: a tombstone in overlay A is invisible to overlay B', async () => {
  const base = await seed();
  const a = new OverlayBackend(base);
  const b = new OverlayBackend(base);
  await a.delete('README.md');
  eq(await a.exists('README.md'), false, 'A hid it');
  eq(await b.exists('README.md'), true, "B still sees it (A's tombstone did not leak)");
  eq(dec(await b.readBinary('README.md')), 'root readme', 'B reads the base content');
});

await test('commit through a real fileops applier is BYTE-EXACT (fixes lossy text round-trip)', async () => {
  // Mirrors the production applier: overlay.commit → fs.write(rel, bytes). A byte
  // (0xFF) that a UTF-8 decode/encode would mangle must survive intact.
  const base = new MemoryBackend();
  const ov = new OverlayBackend(base);
  const blob = Uint8Array.from([0x00, 0xff, 0x10, 0x80, 0x41]); // 0xFF is invalid UTF-8
  await ov.write('blob.bin', blob);
  const realFs = createFileops({ backend: base });
  await ov.commit({
    write: async (p, bytes) => { await realFs.write(p, bytes); }, // byte-accurate, like production
    remove: async (p) => { await realFs.remove(p); },
  });
  const got = await base.readBinary('blob.bin');
  eq(got.length, blob.length, 'length preserved');
  assert(blob.every((v, i) => v === got[i]), 'every byte preserved (0xFF intact)');
});

await test('through createFileops: an isolated agent-style fs works over the overlay', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  const ofs = createFileops({ backend: ov });
  const r = await ofs.read('src/app.js', { encoding: 'utf-8' });
  assert(r.ok && r.data === 'app', 'fileops reads base through overlay');
  const w = await ofs.write('src/app.js', 'via-fileops');
  assert(w.ok, 'fileops write ok');
  const r2 = await ofs.read('src/app.js', { encoding: 'utf-8' });
  eq(r2.data, 'via-fileops', 'fileops sees overlay write');
  eq(dec(await base.readBinary('src/app.js')), 'app', 'base still original through fileops');
  const ls = await ofs.list('', { recursive: true });
  assert(ls.ok && ls.entries.some(e => e.path === 'src/app.js'), 'recursive list works');
});

if (failures.length){
  console.error(`overlay-backend: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`overlay-backend conformance: ${passed}/${passed} passed`);
