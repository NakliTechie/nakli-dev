// Assay ledger — the `assay.*` blocks, over the P0 History hash-chain (sys/history).
//
// Design note (grounds the "ledger patch" in what exists): History commits content
// by HASH, not storage, and its event is 9 fixed fields. An assay block is richer
// (round, clusters, from_findings, test counts) and the verifiers (verify.mjs) need
// that content. So an assay ledger is a THIN content layer: it keeps the structured
// block AND appends a History event committing to it (input_hash = hash(block)). The
// hash-chain gives tamper-evidence; the kept blocks give the queryable content. This
// is the same shape as a Rote run.json ("a slice of this ledger" + content), and it
// obeys §11's "no second ledger" — integrity lives in History, not a parallel chain.
//
// The doc's block-level `door` vocabulary (modelContext/window/channel/system) does
// not match History's DOORS (ui/call/brief); we map by actor kind (person→ui, else
// call) so blocks are valid History events. Reconcile the vocab when wiring the UI.

import { appendEvent, verifyChain, contentHash } from '../history/ledger.mjs';

export const ASSAY_BLOCK_TYPES = Object.freeze([
  'assay.campaign', 'assay.instrument.v1', 'assay.candidate', 'assay.measure',
  'assay.finding.v1', 'assay.directive.v1', 'assay.adjudication', 'assay.expansion',
  'assay.wall.breach', 'assay.instrument.retract', 'assay.ship',
]);

function isStr(v) { return typeof v === 'string' && v.length > 0; }
function isInt(v) { return Number.isInteger(v); }

// Validate a block. Known types are checked for their required fields; unknown
// `assay.*` types are allowed through when allowUnknown (the doc's
// `additionalBlockTypes: allow` — existing readers ignore unknown blocks). A
// non-assay or malformed type is always rejected.
export function validateBlock(b, { allowUnknown = true } = {}) {
  if (!b || typeof b !== 'object') return 'block is not an object';
  if (!isStr(b.type)) return 'missing type';
  if (!isStr(b.campaign)) return 'missing campaign';
  if (!isStr(b.actor)) return 'missing actor';
  if (!Number.isFinite(b.ts)) return 'missing ts';
  const known = ASSAY_BLOCK_TYPES.includes(b.type);
  if (!known) {
    if (b.type.startsWith('assay.') && allowUnknown) return null;
    return `unknown block type "${b.type}"`;
  }
  switch (b.type) {
    case 'assay.campaign': return (isStr(b.goal) && b.ship_bar != null) ? null : 'campaign needs goal + ship_bar';
    case 'assay.instrument.v1': return (isInt(b.version) && isStr(b.ratchet_sha)) ? null : 'instrument needs version + ratchet_sha';
    case 'assay.candidate':
      if (!isInt(b.round) || b.round < 0) return 'candidate needs round >= 0';
      if (!b.implementer_tests || !isInt(b.implementer_tests.count)) return 'candidate needs implementer_tests.count';
      return null;
    case 'assay.finding.v1': return (Array.isArray(b.clusters) && b.clusters.length) ? null : 'finding needs clusters[]';
    case 'assay.directive.v1':
      if (!Array.isArray(b.from_findings)) return 'directive needs from_findings[]';
      if (!Array.isArray(b.items)) return 'directive needs items[]';
      return null;
    case 'assay.wall.breach': return isStr(b.scope) ? null : 'breach needs scope';
    default: return null; // measure/adjudication/expansion/retract/ship — lenient at this tier
  }
}

// person/human actors act through the window (ui door); agents & system act through
// the model/system (call door). Keeps every assay block a valid History event.
function deriveDoor(actor) {
  return (/:(person|human):/.test(actor) || actor.startsWith('actor:human')) ? 'ui' : 'call';
}

// A campaign-scoped assay ledger: append blocks, keep them, and maintain the
// History hash-chain over them. Not persisted here — storage is the caller's, as
// with the base op-log; `.events` is the exportable chain.
export function createAssayLedger() {
  const blocks = [];
  const events = [];
  let head = null;
  return {
    blocks, events,
    get head() { return head; },
    async append(block, { allowUnknown = true } = {}) {
      const err = validateBlock(block, { allowUnknown });
      if (err) throw new Error(`invalid assay block: ${err}`);
      const r = await appendEvent(head, {
        ts: block.ts, principal: block.actor, door: deriveDoor(block.actor),
        tool: block.type, app: 'assay', input: block, output: null,
        grant_id: block.grant_id ?? null,
      });
      blocks.push(block);
      events.push(r.event);
      head = r.head;
      return r.head;
    },
    // Integrity = the History chain is intact AND every kept block still hashes to
    // the input_hash its event committed (no block mutated after the fact).
    async verifyIntegrity() {
      const chain = await verifyChain(events);
      if (!chain.ok) return { ok: false, reason: `chain broken at ${chain.brokenAt}` };
      for (let i = 0; i < blocks.length; i++) {
        const h = await contentHash(blocks[i]);
        if (events[i].input_hash !== h) return { ok: false, reason: `block ${i} content ≠ committed hash` };
      }
      return { ok: true, reason: '' };
    },
    // All blocks of a type for a campaign, in append order.
    ofType(type, campaign) {
      return blocks.filter((b) => b.type === type && (!campaign || b.campaign === campaign));
    },
  };
}
