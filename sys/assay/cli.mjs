// Assay verifier CLI — the headless `verify wall|tests` / `replay` hooks (Anvil
// amendment §4), as a standalone entry point over the same functions the future
// Anvil command bus will call. De-risk form: reads assay.* blocks as NDJSON (one
// JSON block per line) from a file or stdin, rebuilds the ledger, runs the check,
// and exits 0 (pass) / 1 (fail) / 2 (usage). When Anvil wiring lands, `anvil verify
// wall <campaign>` calls verify.mjs directly over the live History store instead.
//
//   node sys/assay/cli.mjs <wall|tests|replay> <campaign> [blocks.ndjson]
//   cat blocks.ndjson | node sys/assay/cli.mjs wall <campaign>

import { readFileSync } from 'node:fs';
import { createAssayLedger } from './ledger.mjs';
import { verifyWall, verifyTests, replay } from './verify.mjs';

const CHECKS = { wall: verifyWall, tests: verifyTests, replay };

async function main() {
  const [mode, campaign, file] = process.argv.slice(2);
  const check = CHECKS[mode];
  if (!check || !campaign) {
    console.error('usage: node sys/assay/cli.mjs <wall|tests|replay> <campaign> [blocks.ndjson]');
    process.exit(2);
  }
  const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
  const blocks = text.split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { console.error(`line ${i + 1}: bad JSON`); process.exit(2); }
  });
  const L = createAssayLedger();
  for (const b of blocks) {
    try { await L.append(b); } catch (e) { console.error(`reject: ${e.message}`); process.exit(2); }
  }
  const res = check(L, { campaign });
  if (res.ok) console.log(`assay ${mode}: PASS (${campaign})`);
  else console.error(`assay ${mode}: FAIL (${campaign}) — ${res.reason}`);
  process.exit(res.code);
}

main();
