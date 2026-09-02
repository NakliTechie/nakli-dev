// Guards the honesty + reachability invariants in Anvil's task loop.
//
// Each assertion below pins a defect that shipped:
//   - a gated pass and "the model stopped calling tools" shared one green dot;
//   - the Must-pass gate was hidden behind a flag seedState() never set;
//   - two of the three gate-command examples could not run in this shell;
//   - five tools returned before the preTool hook guard could see them;
//   - the whole "Learn this project" run emitted no events at all;
//   - the debounced state.json write clobbered other tabs with no lock.
//
// Grep-based, like the other app-contract tests.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

// ── "done" is the verifier's word ───────────────────────────────────────
// An UNGATED task_done also returns verified:true (sys/ai/agent-loop.mjs:290-295),
// so the status MUST be keyed on the gate existing as well.
assert.match(anvil, /\(gated && result\.verified\) \? 'done' : 'unclaimed'/,
  'a done stop without a green gate is unclaimed, not done');
assert.match(anvil, /const gated = !!String\(\(t\.verifyCmd\|\|''\)\)\.trim\(\)/,
  'gated is derived from the task\'s own verify command');
assert.match(anvil, /\.dot\.unclaimed\{/, 'unclaimed has its own dot style');
// Shape, not colour alone, must carry the distinction.
assert.match(anvil, /\.dot\.unclaimed\{background:transparent;box-shadow:inset/,
  'the unclaimed dot is a hollow ring, not a second solid colour');
assert.ok(!/if\(result\.stop==='done'\) state\.proven = true/.test(anvil),
  'the progressive-reveal flag is gone');
// No CODE reader may remain (the surviving mentions are comments explaining why).
const provenCode = anvil.split('\n').filter(l => l.includes('state.proven') && !l.trim().startsWith('//'));
assert.equal(provenCode.length, 0, `no code reader is left behind for state.proven: ${provenCode.join(' | ')}`);

// ── the gate is always reachable ────────────────────────────────────────
assert.match(anvil, /g\.hidden = false;/, 'the Must-pass gate is always visible');

// ── the gate examples must be runnable in the Forge browser shell ───────
const promptLine = anvil.match(/const v=prompt\('Gate command[^\n]*/)[0];
assert.ok(!/pytest/.test(promptLine), 'no pytest example (Kiln is stdlib + a pinned allowlist)');
assert.ok(!/"sh /.test(promptLine) && !/sh check\.sh/.test(promptLine),
  'no `sh` example (`sh` is not a shell builtin — exit 127)');
assert.match(promptLine, /python /, 'at least one runnable python example remains');

// ── every tool passes the hook guard ────────────────────────────────────
// The guard must sit above the first early-returning Anvil-layer tool.
const execIdx = anvil.indexOf('const executeTool = async (nm, ar, callObj)=>{');
const guardIdx = anvil.indexOf('preToolDecision(hooksCfg, nm, ar)', execIdx);
const firstToolIdx = anvil.indexOf("if(nm==='skill')", execIdx);
assert.ok(execIdx >= 0 && guardIdx > execIdx, 'the hook guard is inside executeTool');
assert.ok(guardIdx < firstToolIdx,
  'the hook guard runs BEFORE skill/recall/remember/revise/synthesize can return');
// Exactly one guard site — the old one was removed, not duplicated.
assert.equal((anvil.match(/preToolDecision\(hooksCfg/g) || []).length, 1,
  'the hook guard is not evaluated twice per call');
// Write-capable tools are refused outright outside code mode.
assert.match(anvil, /mode!=='code' && \(nm==='remember'\|\|nm==='revise'\|\|nm==='synthesize'\)/,
  'the write-capable tools are mode-gated defensively');

// ── priming is visible ──────────────────────────────────────────────────
const prime = anvil.slice(anvil.indexOf('You are PRIMING'), anvil.indexOf('You are PRIMING') + 2500);
assert.match(prime, /onEvent:\(e\)=>/, 'the priming run reports its tool calls');
assert.match(prime, /e\.type==='tool-call'/, 'priming surfaces tool calls');
assert.match(prime, /e\.type==='tool-error'/, 'priming surfaces tool errors');

// ── the shared state write is serialised and refuses to clobber ─────────
assert.match(anvil, /navigator\.locks\.request\('anvil-state'/,
  'the remote state write is serialised with Web Locks');
assert.match(anvil, /if\(disk && diskRev>mine\)/,
  'a stale tab detects that another tab is ahead');
assert.match(anvil, /did NOT overwrite it/, 'and says so instead of losing the other tab\'s work');
assert.match(anvil, /state\.rev=mine\+1/, 'a successful write advances the revision');
// The lock must not be assumed present.
assert.match(anvil, /navigator\.locks && navigator\.locks\.request/, 'Web Locks are feature-detected');

console.log('anvil-guards: honesty, reachability, hook coverage and single-writer state all hold');
