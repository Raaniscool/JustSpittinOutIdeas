/**
 * Throughput benchmark: decoupled generation vs. the old block-per-batch
 * pipeline. Each mode runs in a fresh app instance with a cold cache and an
 * empty bank, so neither gets an advantage from the other's work.
 *
 *   blocked  - generate a batch, wait for every evaluation, then generate again
 *              (what the pipeline used to do)
 *   decoupled- generate continuously, review happens on its own workers
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TARGET = Number(process.argv[2] || 60);
const CONCURRENCY = Number(process.argv[3] || 3);
// Injected latency so the benchmark can model real local-model timings instead of
// the demo provider's toy ones. On a real GPU a generation call for 6 ideas takes
// seconds and judging one idea takes seconds - review genuinely trails generation.
const GEN_MS = Number(process.env.GEN_MS || 0);
const EVAL_MS = Number(process.env.EVAL_MS || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `idealab-bench-${mode}-`));
  process.env.IDEALAB_DATA_DIR = dir;
  process.env.IDEALAB_PROVIDER = 'demo';
  const { createApp, patchSettings, shutdown } = await import('../server/src/app.js');
  const ctx = createApp();
  patchSettings(ctx, {
    provider: 'demo',
    model: 'idealab-sim-1b',
    performance: { ideasPerGenerationCall: 6, evaluateConcurrency: CONCURRENCY, maxReviewDepth: 500 },
    pipeline: { recombination: false, biasCheckEvery: 5000 },
  });
  const reviews = ctx.engine.reviews;

  if (GEN_MS || EVAL_MS) {
    const { getProvider } = await import('../server/src/providers/index.js');
    const provider = getProvider('demo');
    const real = provider.complete.bind(provider);
    provider.complete = async (opts) => {
      if (opts.role === 'generator' && GEN_MS) await sleep(GEN_MS);
      if (opts.role === 'evaluator' && EVAL_MS) await sleep(EVAL_MS);
      return real(opts);
    };
  }

  let peakDepth = 0;
  const watch = setInterval(() => { peakDepth = Math.max(peakDepth, reviews.depth); }, 10);

  const t0 = Date.now();
  let generated = 0;
  let batches = 0;
  let genDoneAt = 0;
  while (generated < TARGET) {
    const r = await ctx.engine.generateBatch({ count: 6, category: 'any', mode: 'fast' });
    generated += r.generated;
    batches++;
    if (mode === 'blocked') await reviews.drain(); // the old contract
  }
  genDoneAt = Date.now() - t0;
  await reviews.drain();
  const totalMs = Date.now() - t0;
  clearInterval(watch);

  const s = ctx.stats.summary();
  const scored = ctx.repo.all().filter((i) => i.scoringState === 'scored').length;
  const out = {
    mode, generated, batches, scored,
    genDoneAt, totalMs, peakDepth,
    ideasPerMin: Math.round((generated / (genDoneAt / 60000)) * 10) / 10,
    endToEndPerMin: Math.round((scored / (totalMs / 60000)) * 10) / 10,
    avgReviewWaitMs: s.avgReviewWaitMs,
    avgEvalMs: s.avgEvaluationMs,
    avgGenMs: s.avgGenerationMs,
    useful: s.countGe7,
  };
  await shutdown(ctx);
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

// Run in both orders so neither mode benefits from warm process state.
const first = await run(process.env.ORDER === 'flip' ? 'decoupled' : 'blocked');
const second = await run(process.env.ORDER === 'flip' ? 'blocked' : 'decoupled');
const rows = [first, second].sort((a, b) => a.mode.localeCompare(b.mode));

console.log(`\n${TARGET} ideas, ${CONCURRENCY} review workers${GEN_MS || EVAL_MS ? `, +${GEN_MS}ms/generation call +${EVAL_MS}ms/evaluation call` : ', demo provider latency'}\n`);
const hdr = ['mode', 'generated', 'scored', 'gen done', 'end-to-end', 'peak queue', 'ideas/min', 'scored/min', 'avg review wait'];
const fmt = (r) => [
  r.mode, String(r.generated), String(r.scored),
  `${(r.genDoneAt / 1000).toFixed(1)}s`, `${(r.totalMs / 1000).toFixed(1)}s`,
  String(r.peakDepth), String(r.ideasPerMin), String(r.endToEndPerMin),
  `${Math.round(r.avgReviewWaitMs)}ms`,
];
const widths = hdr.map((h, i) => Math.max(h.length, ...rows.map((r) => fmt(r)[i].length)));
const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
console.log(line(hdr));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of rows) console.log(line(fmt(r)));

const b = rows.find((r) => r.mode === 'blocked');
const d = rows.find((r) => r.mode === 'decoupled');
const pct = ((b.totalMs - d.totalMs) / b.totalMs) * 100;
console.log(`\ngeneration phase: blocked ${(b.genDoneAt / 1000).toFixed(1)}s vs decoupled ${(d.genDoneAt / 1000).toFixed(1)}s`);
console.log(`end-to-end:       blocked ${(b.totalMs / 1000).toFixed(1)}s vs decoupled ${(d.totalMs / 1000).toFixed(1)}s  (${pct > 0 ? pct.toFixed(0) : (-pct).toFixed(0)}% ${pct > 0 ? 'faster' : 'slower'})`);
console.log(`avg gen call ${d.avgGenMs}ms | avg eval call ${d.avgEvalMs}ms | ideas >=7: blocked ${b.useful}, decoupled ${d.useful}\n`);
