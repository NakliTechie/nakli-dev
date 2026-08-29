// Generational evolutionary loop — the AVO crib: the LLM (or any generator) is the
// VARIATION OPERATOR, run once per candidate, inside a classic evolve/select loop.
//
// Anvil already holds the primitives this composes — `dispatch` = the population,
// the verify gate = the fitness function, Memory = the lineage. AVO's advance is that
// they run GENERATIONALLY with lineage feedback, not once. This is that loop, pure and
// injectable so it's testable without a model:
//
//   generate(ctx) -> candidate        ctx = { gen, index, best, bestScore, bestDetail, history, target }
//   score(candidate) -> number | { score, detail }   (higher is better; >= target = solved)
//
// Each generation makes `popSize` candidates (in parallel — the population), scores
// them, keeps the best-so-far, and hands the next generation ctx.best + ctx.bestDetail
// + ctx.history so the generator can REPAIR toward the failures instead of restarting
// cold. Selection is by GRADED fitness (# train pairs matched), not binary done — that
// is what lets a weak model climb.

export async function evolve({ generate, score, popSize = 3, maxGen = 3, target = 1, onGen = null } = {}) {
  if (typeof generate !== 'function' || typeof score !== 'function') {
    throw new Error('evolve needs generate() and score() functions');
  }
  const pop = Math.max(1, popSize | 0);
  const gens = Math.max(1, maxGen | 0);
  let best = null, bestScore = -Infinity, bestDetail = null;
  const history = []; // { gen, index, score, detail?, skipped? } — the lineage

  for (let gen = 0; gen < gens && bestScore < target; gen++) {
    const baseCtx = { gen, best, bestScore, bestDetail, history, target };
    // The population: popSize candidates for this generation, generated in parallel.
    const candidates = await Promise.all(
      Array.from({ length: pop }, (_, index) =>
        Promise.resolve().then(() => generate({ ...baseCtx, index })).catch(() => null)),
    );
    for (let index = 0; index < candidates.length; index++) {
      const cand = candidates[index];
      if (cand == null) { history.push({ gen, index, score: -Infinity, skipped: true }); continue; }
      let r;
      try { r = await score(cand); } catch (_) { r = -Infinity; }
      const raw = (r && typeof r === 'object') ? r.score : r;
      const detail = (r && typeof r === 'object') ? (r.detail ?? null) : null;
      const s = Number.isFinite(Number(raw)) ? Number(raw) : -Infinity;
      history.push({ gen, index, score: s, detail });
      if (s > bestScore) { bestScore = s; best = cand; bestDetail = detail; }
    }
    if (onGen) { try { onGen({ gen, best, bestScore, bestDetail, history }); } catch (_) {} }
  }

  const lastGen = history.length ? history[history.length - 1].gen : -1;
  return { best, bestScore, bestDetail, solved: bestScore >= target, generations: lastGen + 1, history };
}
