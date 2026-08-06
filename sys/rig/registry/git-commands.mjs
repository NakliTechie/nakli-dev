// git-commands — the C2 git-core ops, registered as C1 commands.
//
// buildGitCommands(gitCore) closes each command over a createGitCore(...)
// instance, exactly as fileops-commands does over fileops. git.* joins the same
// single registry — no surface gets its own path to capability.

const OK = { type: 'object', properties: { ok: { const: true } }, required: ['ok'] };
const RO = { readOnlyHint: true };
const RW = { readOnlyHint: false };

export function buildGitCommands(git) {
  return [
    {
      name: 'git.init',
      summary: 'Initialise a repository in the mount.',
      description: 'Create a new git repository at the worktree root. {defaultBranch} defaults to "main".',
      inputSchema: { type: 'object', properties: { defaultBranch: { type: 'string' } }, additionalProperties: false },
      returnSchema: OK, destructive: false, scope: 'git:write', annotations: RW,
      run: (i) => git.init(i),
    },
    {
      name: 'git.add',
      summary: 'Stage a file.',
      description: 'Add a working-tree path to the index.',
      inputSchema: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'], additionalProperties: false },
      returnSchema: OK, destructive: false, scope: 'git:write', annotations: RW,
      run: (i) => git.add(i),
    },
    {
      name: 'git.remove',
      summary: 'Unstage / remove a file from the index.',
      description: 'Remove a path from the index. Destructive — C4 stages a proposal.',
      inputSchema: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'], additionalProperties: false },
      returnSchema: OK, destructive: true, scope: 'git:write', annotations: RW,
      run: (i) => git.remove(i),
    },
    {
      name: 'git.commit',
      summary: 'Record a commit.',
      description: 'Commit the staged tree. actor "operator" requires {identity:{name,email}}; actor "agent" is forced to agent@rig.local with a session trailer and can never borrow the operator identity.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          actor: { enum: ['operator', 'agent'] },
          identity: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } } },
          session: { type: 'object' },
          timestamp: { type: 'number' }, timezoneOffset: { type: 'number' },
        },
        required: ['message'], additionalProperties: false,
      },
      returnSchema: { type: 'object', properties: { ok: { const: true }, oid: { type: 'string' }, actor: { type: 'string' } }, required: ['ok'] },
      destructive: true, scope: 'git:write', annotations: RW,
      run: (i) => git.commit(i),
    },
    {
      name: 'git.status',
      summary: 'Status of one file.',
      description: 'Return the working-tree status string for a single path.',
      inputSchema: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'], additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, status: { type: 'string' } }, required: ['ok'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: (i) => git.status(i),
    },
    {
      name: 'git.statusMatrix',
      summary: 'Status matrix for the tree.',
      description: 'Return [filepath, HEAD, WORKDIR, STAGE] rows for the working tree.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, filepaths: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, matrix: { type: 'array' } }, required: ['ok', 'matrix'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: (i) => git.statusMatrix(i),
    },
    {
      name: 'git.log',
      summary: 'Commit history.',
      description: 'Return commits reachable from a ref (default HEAD).',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, depth: { type: 'number' } }, additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, commits: { type: 'array' } }, required: ['ok', 'commits'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: (i) => git.log(i),
    },
    {
      name: 'git.diff',
      summary: 'Diff working tree or between refs.',
      description: 'List changed paths between {refA} and {refB} (or the working tree when refB is omitted).',
      inputSchema: { type: 'object', properties: { refA: { type: 'string' }, refB: { type: 'string' } }, additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, changes: { type: 'array' } }, required: ['ok', 'changes'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: (i) => git.diff(i),
    },
    {
      name: 'git.branch',
      summary: 'Create a branch.',
      description: 'Create a branch {ref}; {checkout:true} also switches to it.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, checkout: { type: 'boolean' } }, required: ['ref'], additionalProperties: false },
      returnSchema: OK, destructive: false, scope: 'git:write', annotations: RW,
      run: (i) => git.branch(i),
    },
    {
      name: 'git.listBranches',
      summary: 'List branches.',
      description: 'Return local branch names.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, branches: { type: 'array', items: { type: 'string' } } }, required: ['ok', 'branches'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: () => git.listBranches(),
    },
    {
      name: 'git.checkout',
      summary: 'Switch to a ref (discards conflicting worktree changes).',
      description: 'Check out a branch or commit into the worktree. Destructive — discards conflicting changes; C4 stages a proposal.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, force: { type: 'boolean' } }, required: ['ref'], additionalProperties: false },
      returnSchema: OK, destructive: true, scope: 'git:write', annotations: RW,
      run: (i) => git.checkout(i),
    },
    {
      name: 'git.listRemotes',
      summary: 'List configured remotes.',
      description: 'Return configured remotes.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, remotes: { type: 'array' } }, required: ['ok', 'remotes'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: () => git.listRemotes(),
    },
    {
      name: 'git.resolveRef',
      summary: 'Resolve a ref to an object id.',
      description: 'Resolve a ref (e.g. HEAD, a branch) to its commit oid.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, oid: { type: 'string' } }, required: ['ok', 'oid'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: (i) => git.resolveRef(i),
    },
  ];
}
