// rig-bindings — generate the Python `rig` module FROM the Rig command registry
// (Kiln K2). Not hand-written: signatures, docstrings, and the destructive flag
// all come from registry metadata, so a new Rig command yields a new Python
// function with no Kiln change (handoff §5).
//
// Naming (matches the handoff examples rig.read / rig.git.status): the `fs`
// namespace flattens to top-level (rig.read, rig.write); every other namespace
// nests (git.status → rig.git.status). Each generated function forwards to a
// host-provided `_rig_call(name, args)` which routes through the agent face —
// out-of-grant raises RigGrantError, a destructive command returns a staged
// proposal. This module only GENERATES the source + a manifest for testing; it
// never invokes a handler.

// Python reserved words that can appear as a param name (e.g. fs.move's `from`).
const PY_RESERVED = new Set([
  'from', 'import', 'class', 'def', 'return', 'global', 'lambda', 'pass',
  'None', 'True', 'False', 'and', 'or', 'not', 'if', 'else', 'elif', 'for',
  'while', 'in', 'is', 'as', 'with', 'try', 'except', 'finally', 'raise',
]);
const pyParam = (name) => (PY_RESERVED.has(name) ? name + '_' : name);

function splitCommand(name) {
  const dot = name.indexOf('.');
  if (dot === -1) return { ns: null, op: name };
  return { ns: name.slice(0, dot), op: name.slice(dot + 1) };
}

// A command → its binding shape (used for both source and the test manifest).
function bindingFor(command) {
  const { ns, op } = splitCommand(command.name);
  const props = (command.inputSchema && command.inputSchema.properties) || {};
  const required = (command.inputSchema && command.inputSchema.required) || [];
  // required params first (positional), then optional (keyword=None).
  const keys = [
    ...required,
    ...Object.keys(props).filter((k) => !required.includes(k)),
  ];
  const params = keys.map((k) => ({ key: k, py: pyParam(k), required: required.includes(k) }));
  const nested = ns && ns !== 'fs';   // fs flattens; everything else nests
  const pyName = nested ? `${ns}.${op}` : op;
  const funcName = op; // the def name is always the op; namespace nesting is structural
  return {
    command: command.name,
    pyName,          // how it is called: read / git.status
    nested,
    namespace: nested ? ns : null,
    funcName,        // the def name
    params,
    doc: command.description || command.summary || '',
    destructive: !!command.destructive,
    scope: command.scope,
  };
}

function indent(s, n) {
  const pad = ' '.repeat(n);
  return s.split('\n').map((l) => (l ? pad + l : l)).join('\n');
}

function renderFunction(b, selfArg) {
  const sig = [
    ...(selfArg ? ['self'] : []),
    ...b.params.filter((p) => p.required).map((p) => p.py),
    ...b.params.filter((p) => !p.required).map((p) => `${p.py}=None`),
  ].join(', ');
  const argEntries = b.params.map((p) => `${JSON.stringify(p.key)}: ${p.py}`).join(', ');
  const docLines = [b.doc];
  if (b.destructive) docLines.push('', 'Destructive — returns a staged proposal; the operator accepts it in Forge.');
  const doc = docLines.join('\n');
  return [
    `def ${b.funcName}(${sig}):`,
    indent(`"""${doc}"""`, 4),
    indent(`return _rig_call(${JSON.stringify(b.command)}, {${argEntries}})`, 4),
  ].join('\n');
}

/**
 * Generate the Python `rig` module source + a manifest.
 * @param {object} registry  a buildRigRegistry(...) result
 * @returns {{source: string, manifest: object[]}}
 */
export function generateRigModule(registry) {
  const commands = registry.list();          // metadata only — never invoke
  const bindings = commands.map(bindingFor);

  const topLevel = bindings.filter((b) => !b.nested);
  const byNamespace = new Map();
  for (const b of bindings.filter((x) => x.nested)) {
    if (!byNamespace.has(b.namespace)) byNamespace.set(b.namespace, []);
    byNamespace.get(b.namespace).push(b);
  }

  const parts = [];
  parts.push('"""Rig — the repository, callable from Python.');
  parts.push('');
  parts.push('Generated from the Rig command registry. Do not edit by hand.');
  parts.push('"""');
  parts.push('');
  parts.push('class RigError(Exception):');
  parts.push('    """A Rig command failed."""');
  parts.push('');
  parts.push('class RigGrantError(RigError):');
  parts.push('    """A command was refused because its path or scope is outside the active grant."""');
  parts.push('');
  parts.push('# `_rig_call(name, args)` is provided by the Kiln host: it routes through the');
  parts.push('# Rig agent face, raising RigGrantError on an out-of-grant call and returning a');
  parts.push('# staged proposal for a destructive command.');
  parts.push('');
  for (const b of topLevel) { parts.push(renderFunction(b, false)); parts.push(''); }
  for (const [ns, members] of byNamespace) {
    const cls = `_${ns.charAt(0).toUpperCase()}${ns.slice(1)}`;
    parts.push(`class ${cls}:`);
    parts.push(indent(`"""The ${ns} namespace (rig.${ns}.*)."""`, 4));
    for (const b of members) { parts.push(indent(renderFunction(b, true), 4)); parts.push(''); }
    parts.push(`${ns} = ${cls}()`);
    parts.push('');
  }

  return { source: parts.join('\n'), manifest: bindings };
}
