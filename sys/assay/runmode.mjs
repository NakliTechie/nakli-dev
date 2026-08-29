// Assay Run-Mode driver — turns the reducer (loop.mjs) into a running campaign.
//
// This is the sequencing engine Anvil calls: repeatedly ask nextStep whose turn it
// is, run that role's EXECUTOR to produce its ledger block(s), append them, repeat —
// until an exit (ship / park) or a person-only gate that pauses for the Owner. The
// role executors are injected: in Anvil they run the agent loop as that role over the
// campaign artifacts (through the role's Grant set); in tests they are deterministic
// fakes. The driver holds no state of its own — everything is in the ledger, so it is
// killable and resumable (call runCampaign again over the persisted ledger).
//
// Executors: { [action]: async (ctx) => block | block[] | null }. Actions are the
// nextStep `next.action` values (campaign.start, build-instrument, build-candidate,
// measure, adjudicate, request-expansion, propose-ship, park). Returning null means
// "a human must act here" → the campaign pauses.

import { nextStep } from './loop.mjs';

const PERSON_ONLY_ACTIONS = new Set(['campaign.start', 'propose-ship', 'park']);

export async function runCampaign({ ledger, campaign, executors = {}, config = {}, budget = null, onStep = null, maxIters = 1000 }) {
  let iters = 0;
  while (iters++ < maxIters) {
    const budgetHit = !!(budget && typeof budget.spent === 'function' && typeof budget.cap === 'number' && budget.spent() >= budget.cap);
    const step = nextStep(ledger, { campaign, config, budgetHit });
    const action = step.next && step.next.action;
    const exec = action ? executors[action] : null;

    // An exit: run its (person-only) executor if provided, append, and stop.
    if (step.exit) {
      if (exec) {
        const produced = await exec({ ...step.next, phase: step.phase, ledger, campaign });
        if (produced == null) return { status: 'paused', reason: 'awaiting-human', exit: step.exit, step, iters };
        for (const b of [].concat(produced)) await ledger.append(b);
      }
      return { status: step.exit, round: step.round, step, iters };
    }

    // A normal step with no executor wired → pause (e.g. the Owner must start it).
    if (!exec) return { status: 'paused', reason: `no executor for "${action}"`, step, iters };

    const produced = await exec({ ...step.next, phase: step.phase, ledger, campaign });
    // A person-only step whose executor declines (returns null) pauses for the human.
    if (produced == null) {
      return { status: 'paused', reason: PERSON_ONLY_ACTIONS.has(action) ? 'awaiting-human' : `executor declined "${action}"`, step, iters };
    }
    for (const b of [].concat(produced)) await ledger.append(b);
    if (onStep) onStep({ step, blocks: [].concat(produced) });
  }
  return { status: 'max-iters', iters };
}
