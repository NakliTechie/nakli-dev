// Conformance — P0 end to end: the pitch demo, headless.
//   node sys/staging/test/session.test.mjs
//
// This is the vision doc's walkthrough (plan/naklios-private-ai-os-vision.md:49-63)
// executed as a contract, so the browser version is a UI over a proven core:
//   1. a person mints an agent          (Identity, persisted in the FIF)
//   2. grants it scoped tools, TTL, budget, and NO commit   (Grant)
//   3. the agent acts across Reckon AND Draft — every call attributed (History)
//   4. both mutations stage; ONE reviewer renders both diffs (Staging)
//   5. the person commits; the change actually lands
//   6. a scope violation fails LOUD — refused, and the refusal is in the ledger

import { createFifStore } from '../../identity/fif.mjs';
import { mintPrincipal } from '../../identity/principal.mjs';
import { issueGrant, attenuate, caveat } from '../../identity/grant.mjs';
import { verifyChain, mergeChains } from '../../history/ledger.mjs';
import { clearRegistry } from '../envelope.mjs';
import { registerAppDiffTypes } from '../diff-types.mjs';
import { renderReviewQueue } from '../reviewer.mjs';
import { createStagingSession, StagingDenied } from '../session.mjs';

const ITER = 1000; // test-only KDF cost factor
let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
async function denied(fn, m) {
  try { await fn(); } catch (e) {
    if (!(e instanceof StagingDenied)) throw new Error(`${m}: threw ${e.code || e.name}, not StagingDenied (${e.message})`);
    return e;
  }
  throw new Error(m || 'expected a denial');
}
function fakeDoc() {
  const make = (tag) => ({ tag, className: '', textContent: '', children: [], attrs: {}, appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = String(v); } });
  return { createElement: (tag) => make(tag) };
}
function all(n, p, out = []) { if (p(n)) out.push(n); for (const c of n.children) all(c, p, out); return out; }
const byClass = (r, c) => all(r, (n) => String(n.className).split(' ').includes(c));
const text = (n) => [n.textContent, ...n.children.map(text)].join(' ').replace(/\s+/g, ' ').trim();

clearRegistry();
registerAppDiffTypes();

// Tiny real appliers, so a commit LANDS rather than being asserted as landed.
function world() {
  const sheet = { A1: '1', C3: 'old' };
  let docText = 'a rough draft';
  return {
    sheet, doc: () => docText,
    appliers: {
      reckon: async (env) => {
        for (const op of env.diff.ops) {
          if (op.op !== 'setCells') continue;
          for (const [a1, cell] of Object.entries(op.cells)) {
            if (cell === null) delete sheet[a1];
            else sheet[a1] = 'f' in cell ? String(cell.f) : String(cell.v);
          }
        }
        return { cells: Object.keys(env.diff.ops[0].cells).length };
      },
      draft: async (env) => {
        for (const h of env.diff.hunks) docText = docText.replace(h.delText, h.insText);
        return { hunks: env.diff.hunks.length };
      },
    },
  };
}

const RECKON_DIFF = {
  sheet: 's1', sheetName: 'Sheet1',
  ops: [{ op: 'setCells', sheet: 's1', cells: { A1: { v: 42 }, B2: { f: '=A1*2' } } }],
  inverse: [{ op: 'setCells', sheet: 's1', cells: { A1: { v: 1 }, B2: null } }],
};
const DRAFT_DIFF = {
  docId: 'notes.md', docName: 'Notes', from: 0, to: 13,
  hunks: [{ index: 0, kind: 'replace', delText: 'a rough draft', insText: 'a final draft' }],
};

// The whole cast, set up the way the demo does it.
async function stage0({ clock = () => 1_000_000 } = {}) {
  const fif = createFifStore({ iterations: ITER });
  await fif.create('demo passphrase');
  const person = await mintPrincipal(null, { kind: 'person', label: 'Chirag' });
  const agent = await mintPrincipal(person, { kind: 'agent', label: 'summariser' });
  await fif.putPrincipal(person);
  await fif.putPrincipal(agent);

  // Scoped: two tools, ten minutes, fifty calls — and NO auto-commit caveat,
  // so commit stays person-only.
  const grant = await issueGrant(fif.rootKey(), {
    caveats: [
      caveat.principal(agent.descriptor.id),
      caveat.tools(['reckon.setRange', 'draft.replaceRange']),
      caveat.ttl(clock() + 600_000),
      caveat.budget({ calls: 50 }),
    ],
  });
  await fif.putGrant(grant, { label: 'summariser session', principal: agent.descriptor.id });

  const w = world();
  const session = createStagingSession({ fif, appliers: w.appliers, now: clock });
  return { fif, person, agent, grant, session, w };
}

await test('1-3: the agent acts across BOTH apps under one scoped grant, each call attributed', async () => {
  const { agent, grant, session } = await stage0();
  const r = await session.stage({ principal: agent.descriptor.id, grant, app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF });
  const d = await session.stage({ principal: agent.descriptor.id, grant, app: 'draft', tool: 'draft.replaceRange', diff: DRAFT_DIFF });

  eq(r.envelope.preview_renderer, 'cell-range', 'reckon renderer');
  eq(d.envelope.preview_renderer, 'prosemirror-steps', 'draft renderer');
  eq(session.pending().length, 2, 'two proposals open');
  eq(session.usageFor(grant.identifier).calls, 2, 'budget counted honestly');

  // Attribution: both chains name the AGENT, and both carry the grant id.
  for (const app of ['reckon', 'draft']) {
    const evs = session.events(app);
    eq(evs.length, 1, `${app} logged one event`);
    eq(evs[0].principal, agent.descriptor.id, `${app} event attributed to the agent`);
    eq(evs[0].grant_id, grant.identifier, `${app} event carries the grant`);
    eq(evs[0].door, 'call', 'through the call door');
  }
});

await test('4: ONE reviewer renders the Reckon diff and the Draft diff together', async () => {
  const { agent, grant, session } = await stage0();
  await session.stage({ principal: agent.descriptor.id, grant, app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF });
  await session.stage({ principal: agent.descriptor.id, grant, app: 'draft', tool: 'draft.replaceRange', diff: DRAFT_DIFF });

  const { element, models } = renderReviewQueue(session.pending(), (env) => session.contextFor(env.proposal_id), { doc: fakeDoc() });
  eq(models.length, 2, 'two cards');
  eq(byClass(element, 'nk-rev').length, 2, 'from one component');
  assert(models.every((m) => m.committable), 'the person may commit both');
  const body = text(element);
  assert(body.includes('=A1*2'), 'the Reckon formula is on screen');
  assert(body.includes('a final draft'), 'the Draft rewrite is on screen');
});

await test('5: the person commits and the change actually LANDS in both apps', async () => {
  const { person, agent, grant, session, w } = await stage0();
  const r = await session.stage({ principal: agent.descriptor.id, grant, app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF });
  const d = await session.stage({ principal: agent.descriptor.id, grant, app: 'draft', tool: 'draft.replaceRange', diff: DRAFT_DIFF });

  const rc = await session.commit(r.envelope.proposal_id, { actor: 'person', principal: person.descriptor.id });
  const dc = await session.commit(d.envelope.proposal_id, { actor: 'person', principal: person.descriptor.id });
  eq(rc.mode, 'person', 'committed as the person');
  eq(dc.mode, 'person', 'committed as the person');

  eq(w.sheet.A1, '42', 'the cell really changed');
  eq(w.sheet.B2, '=A1*2', 'the formula really landed');
  eq(w.doc(), 'a final draft', 'the document really changed');
  eq(session.pending().length, 0, 'nothing left staged');
  // The commit is attributed to the PERSON, not the agent that proposed it.
  const commitEvent = session.events('reckon').find((e) => e.tool === 'reckon.commit');
  eq(commitEvent.principal, person.descriptor.id, 'the human owns the commit');
});

await test('6: a scope violation fails LOUD — refused, with the refusal in the ledger', async () => {
  const { agent, grant, session } = await stage0();
  // The grant lists two tools; kanzen.cardMove is not one of them.
  const e = await denied(
    () => session.stage({ principal: agent.descriptor.id, grant, app: 'reckon', tool: 'kanzen.cardMove', diff: RECKON_DIFF }),
    'ungranted tool',
  );
  assert(e.reason.includes('not in'), `the reason names the rule: ${e.reason}`);
  assert(e.event, 'the denial produced an event');

  const evs = session.events('reckon');
  eq(evs.length, 1, 'the refusal is IN the ledger, not merely thrown');
  eq(evs[0].principal, agent.descriptor.id, 'attributed to the agent that tried');
  eq(session.usageFor(grant.identifier).calls, 0, 'a denial does not burn budget');
  eq(session.pending().length, 0, 'nothing was staged');
});

await test('6b: an agent cannot commit its own proposal — commit is person-only', async () => {
  const { agent, grant, session } = await stage0();
  const r = await session.stage({ principal: agent.descriptor.id, grant, app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF });
  const e = await denied(
    () => session.commit(r.envelope.proposal_id, { actor: 'agent', principal: agent.descriptor.id, grant }),
    'agent self-commit',
  );
  assert(e.reason.includes('person-only'), `names the rule: ${e.reason}`);
  const denials = session.events('reckon').filter((ev) => ev.tool === 'reckon.commit');
  eq(denials.length, 1, 'the attempt is logged');
  assert(session.proposal(r.envelope.proposal_id), 'the proposal survives a refused commit — the person can still review it');
});

await test('6c: a revoked grant stops the agent mid-session', async () => {
  const { fif, agent, grant, session } = await stage0();
  await session.stage({ principal: agent.descriptor.id, grant, app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF });
  await fif.revoke(grant.identifier);
  const e = await denied(
    () => session.stage({ principal: agent.descriptor.id, grant, app: 'draft', tool: 'draft.replaceRange', diff: DRAFT_DIFF }),
    'revoked grant',
  );
  eq(e.reason, 'revoked', 'revocation is the reason');
});

await test('6d: an expired TTL stops the agent', async () => {
  let t = 1_000_000;
  const { agent, grant, session } = await stage0({ clock: () => t });
  t += 600_001; // past the ten-minute TTL
  const e = await denied(
    () => session.stage({ principal: agent.descriptor.id, grant, app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF }),
    'expired grant',
  );
  assert(e.reason.includes('expired'), `names expiry: ${e.reason}`);
});

await test('6e: a different principal cannot use the agent\'s grant', async () => {
  const { person, agent, grant, session } = await stage0();
  const e = await denied(
    () => session.stage({ principal: person.descriptor.id, grant, app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF }),
    'grant bound to its principal',
  );
  assert(e.reason.includes('principal'), `names the binding: ${e.reason}`);
  assert(agent.descriptor.id !== person.descriptor.id, 'distinct principals');
});

await test('an attenuated grant narrows but never widens', async () => {
  const { agent, grant, session } = await stage0();
  const narrowed = await attenuate(grant, caveat.tools(['draft.replaceRange'])); // drops reckon
  await session.stage({ principal: agent.descriptor.id, grant: narrowed, app: 'draft', tool: 'draft.replaceRange', diff: DRAFT_DIFF });
  await denied(
    () => session.stage({ principal: agent.descriptor.id, grant: narrowed, app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF }),
    'attenuation removed reckon',
  );
});

await test('the ledger verifies, and the merged cross-app view is time-ordered', async () => {
  let t = 1_000_000;
  const { person, agent, grant, session } = await stage0({ clock: () => (t += 10) });
  const r = await session.stage({ principal: agent.descriptor.id, grant, app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF });
  await session.stage({ principal: agent.descriptor.id, grant, app: 'draft', tool: 'draft.replaceRange', diff: DRAFT_DIFF });
  await session.commit(r.envelope.proposal_id, { actor: 'person', principal: person.descriptor.id });
  await denied(() => session.stage({ principal: agent.descriptor.id, grant, app: 'draft', tool: 'nope.tool', diff: DRAFT_DIFF }), 'a denial to sit in the chain');

  for (const app of ['reckon', 'draft']) {
    const v = await verifyChain(session.events(app));
    eq(v.ok, true, `${app} chain intact (broke at ${v.brokenAt})`);
  }
  const merged = mergeChains(session.events());
  eq(merged.length, 4, 'every action AND refusal in one view');
  for (let i = 1; i < merged.length; i++) assert(merged[i].ts >= merged[i - 1].ts, 'time-ordered');

  // Tampering is caught: rewrite one event's tool and the chain breaks.
  const tampered = session.events('reckon').map((e, i) => (i === 0 ? { ...e, tool: 'reckon.somethingElse' } : e));
  const bad = await verifyChain(tampered);
  eq(bad.ok, false, 'an edited ledger fails verification');
});

await test('an app with no applier can stage and be reviewed, but not commit', async () => {
  const { fif, agent, grant } = await stage0();
  const session = createStagingSession({ fif, appliers: {}, now: () => 1_000_000 });
  const r = await session.stage({ principal: agent.descriptor.id, grant, app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF });
  renderReviewQueue([r.envelope], session.contextFor(r.envelope.proposal_id), { doc: fakeDoc() }); // renders fine
  let msg = '';
  try { await session.commit(r.envelope.proposal_id, { actor: 'person' }); } catch (e) { msg = e.message; }
  assert(msg.includes('no applier'), `honest about the unwired app: ${msg}`);
});

if (failures.length) { console.error(`staging/session: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`staging/session (P0 demo, headless): ${passed}/${passed} passed`);
