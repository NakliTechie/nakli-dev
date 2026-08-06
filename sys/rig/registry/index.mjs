// Rig command registry (C1) — public entry.
//
//   import { buildRigRegistry } from '/sys/rig/registry/index.mjs';
//   const fs = createFileops({ backend, root });
//   const registry = buildRigRegistry({ fs });
//   registry.searchCommands('read');          // metadata only
//   await registry.invokeCommand('fs.read', { path: 'a.txt', encoding: 'utf-8' });
//
// The registry is THE single capability shape; palette, faux CLI, window.rig,
// and Kiln bindings all consume it.
import { createRegistry, KNOWN_SCOPES } from './registry.mjs';
import { buildFileopsCommands } from './fileops-commands.mjs';

export { createRegistry, KNOWN_SCOPES } from './registry.mjs';
export { buildFileopsCommands } from './fileops-commands.mjs';

/**
 * Build the Rig registry over a fileops instance (C2 will add git commands to
 * the same registry).
 * @param {object} opts
 * @param {object} opts.fs   a createFileops(...) instance
 */
export function buildRigRegistry({ fs }) {
  if (!fs) throw new Error('buildRigRegistry requires a fileops instance (fs)');
  return createRegistry([...buildFileopsCommands(fs)]);
}
