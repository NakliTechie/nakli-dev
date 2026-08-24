// Rig goal records (C7) — public entry.
//
//   import { createGoalStore } from '/sys/rig/goals/index.mjs';
//   const goals = createGoalStore({ fs });   // fs = a createFileops(...) instance
//
// Goal records persist "what to achieve + how we'll know" on the user's backend.
// `status: done` is verifier-only (K3); the working agent can never write it.
export { createGoalStore } from './goals.mjs';
