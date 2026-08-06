// window-rig — the developer-gated window.rig door (C4).
//
// window.rig is OFF BY DEFAULT (hard rule / §6: "Developer setting, off by
// default. No exceptions."). installWindowRig only attaches the surface when
// `enabled` is true; when off, window.rig is left undefined. The surface is the
// governed agent face — the same invoke/accept the kernel uses, nothing more.

/**
 * @param {object} opts
 * @param {object} [opts.target]   the global to attach to (defaults to window)
 * @param {boolean} opts.enabled   the developer setting
 * @param {object}  opts.face      a createAgentFace(...) result
 * @returns {function} an uninstall function that removes window.rig
 */
export function installWindowRig({ target, enabled, face }) {
  const g = target || (typeof window !== 'undefined' ? window : undefined);
  if (!g) return () => {};
  const remove = () => { try { delete g.rig; } catch (_) { g.rig = undefined; } };
  if (!enabled) { remove(); return remove; }
  g.rig = {
    invoke: (name, input) => face.invoke(name, input),
    accept: (id, opts) => face.accept(id, opts),
    reject: (id) => face.reject(id),
    pending: () => face.pendingProposals(),
    search: (q) => face.searchCommands(q),
    describe: (n) => face.describeCommand(n),
    tools: () => face.toolSchemas(),
    grant: () => face.grant.describe(),
  };
  return remove;
}
