# IdeaLab ⚗

A **local-first idea discovery laboratory**. IdeaLab generates product, software, business, scientific,
educational, engineering, automation and consumer ideas in volume from a local model (Ollama), attacks every
one of them with a separate brutal evaluator, computes a deterministic score from ten weighted factors, and
paints the result onto a wall of colour-graded cards.

The goal is not to make you feel good about ideas. It is to **search through hundreds of them quickly and stop
on the rare one that deserves attention**:

> 4.2 · 5.7 · 3.9 · 6.4 · 5.1 · **7.8** · 4.8 · 6.9 · **8.4** → *"wait. this can actually work."*

```
Generate → Evaluate → Visualize → Generate again → Discover something exceptional
```

---

## Quick start

```bash
# 1. a local model (anything Ollama runs; small models are the right trade for volume)
ollama serve
ollama pull qwen3:1.7b        # or qwen3:4b, llama3.2:3b, gemma3:1b, ...
node scripts/ollama-check.mjs # see what is installed and how big it is

# 2. the app
npm install
npm run dev                   # UI on http://localhost:5173 (Vite) + API on :8787
```

Or build once and serve the UI and API from a single port:

```bash
npm start                     # installs/builds if needed, then serves http://localhost:8787
```

No model installed yet? Switch the provider to **Demo simulator** in the header. It is a synthetic provider
that speaks the same interface, so the whole pipeline runs — streaming, incremental parsing, brutal
evaluation, evidence guards, duplicate detection, bias monitoring, Knowledge Bank gating — with simulated
latency. Every record it produces is tagged `provider: 'demo'` and the UI says so. It is a flight simulator,
not an idea source.

Requirements: Node ≥ 20.11 (uses the built-in test runner and `fetch`). Ollama is optional for demo mode.

---

## Two queues: generation never waits for review

Generation and evaluation are **separate job streams** that meet only through a queue.

```
generator ──▶ wall of cards (unscored, visible immediately) ──▶ review queue ──▶ N workers ──▶ scored card
   │                                                                │
   └── starts the next batch immediately                            └── bounded; throttles the generator at the cap
```

An idea is parsed out of the token stream, persisted, put on the wall, and handed to the review queue in the same
tick. The generator then starts the next batch. It never blocks on an evaluation, so the model is never sitting
idle while a judgment is written. Reviews outlive the job that produced them: stopping generation does not throw
away the scores for ideas that already exist, and anything still unreviewed at shutdown is re-queued on the next
boot rather than being silently left unscored.

The backlog is bounded. If review falls `IDEALAB_REVIEW_DEPTH` ideas behind (default 120), the generator waits for
the queue to drain to 60% of the cap instead of growing it without limit — memory stays flat and scores stay
recent. The strip under the header shows all three stages live: generation rate, backlog and average wait, review
rate.

### Measured

`scripts/bench-pipeline.mjs` runs the same workload through both pipelines against a stub backend that is pure
latency behind *P* parallel slots — *P* is `OLLAMA_NUM_PARALLEL`, so this models a real local GPU rather than the
demo simulator. 36 ideas, one 2.5 s generation call per 6 ideas, one 1.8 s evaluation per idea, 3 review workers,
42 model calls and 0 skipped in every row:

| P | pipeline | generation done | everything reviewed | ideas/min | avg review wait |
| --- | --- | --- | --- | --- | --- |
| 1 | blocked (old) | 79.8s | 79.8s | 27.1 | 1.8s |
| 1 | **decoupled** | **42.0s** | 79.8s | **51.4** | 16.6s |
| 4 | blocked (old) | 36.6s | 36.6s | 58.9 | 0.9s |
| 4 | **decoupled** | **15.0s** | **24.1s** | **143.8** | **3.6s** |

Read that honestly. Total model work is conserved — a single serial slot spends the same 79.8 s either way, so
decoupling cannot create throughput that the hardware does not have. What it does is stop the generator idling
inside that budget: at P=1 you get ideas at 51/min instead of 27/min, and at P=4 generation is 59% faster and
end-to-end 34% faster with review landing ~3.6 s behind generation.

The consequence worth knowing: **review is the bottleneck, not generation.** One 1.8 s evaluation per idea caps
review at ~33 ideas/min no matter how fast ideas arrive. To keep the review lag inside a few seconds either give
the model parallel slots (`OLLAMA_NUM_PARALLEL=4`, needs VRAM) and matching review workers, or make each
evaluation cheaper — shorter `num_ctx`, lower `num_predict`, a smaller evaluator model. The backlog and average
wait in the strip tell you which side is losing.

## Why it is fast

Speed is a feature here, because the product is *volume*. The metric that matters is **useful ideas per
minute**, not tokens per second.

| Technique | What it does |
| --- | --- |
| **Decoupled generation and review** | Two queues, so the generator never waits on an evaluator (above). |
| **Incremental stream parsing** | Ideas are parsed out of the token stream one at a time and land on the wall before the call finishes. (`lib/jsonStream.js`, `providers/ollama.js`) |
| **Batched generation** | One model call returns N ideas as a JSON array instead of N calls. |
| **Structured output** | `format` = JSON schema. The model cannot spend tokens on prose and we never pay for a parse-retry loop. Falls back to `format:"json"` on older Ollama builds automatically. |
| **Concurrent review workers** | Independent ideas are evaluated by a worker pool (default 3 — match `OLLAMA_NUM_PARALLEL`), separately bounded from deep actions. |
| **Stable system prompt** | Role prompts are byte-identical across calls so Ollama reuses its cached prompt prefix; everything variable goes in the user message. |
| **Persistent keep-alive sockets** | A hand-rolled `node:http` agent pool keeps one connection warm for hundreds of requests (`lib/http.js`). |
| **Resident weights** | `keep_alive` on every request + an explicit preload when the model changes, so the load cost is paid once. |
| **`think: false`** | Reasoning models (qwen3, deepseek-r1) stop burning tokens deliberating. Auto-disabled if the build rejects the flag. |
| **Small context, capped output** | `num_ctx` 2–3k and `num_predict` caps per role. A small model with a huge context window is a slow model. |
| **Evaluation cache + near-duplicate reuse** | Identical ideas reuse a cached evaluation; ideas ≥ 0.90 similar reuse a twin's evaluation instead of spending a call. Both are labelled on the card and in the stats. |
| **No wasted deep work** | Deep mode attacks everything but only spends improve + re-evaluate tokens on ideas at or above a threshold (default 6.0). |
| **One SSE stream, batched renders** | The browser holds a single EventSource; idea updates are coalesced into one React render every ~110 ms, cards are `React.memo`'d, and the wall renders in pages via an IntersectionObserver. |

---

## Brutal, deterministic scoring

The model scores **ten factors**. It never chooses the overall number — that is computed from configurable
weights, with technical difficulty inverted (`11 − difficulty`):

| Factor | Weight | | Factor | Weight |
| --- | --- | --- | --- | --- |
| Novelty | 15% | | Monetization | 15% |
| Usefulness | 15% | | Market potential | 10% |
| Problem severity | 10% | | Differentiation | 10% |
| Feasibility | 10% | | AI leverage | 5% |
| Technical difficulty | 5% (negative) | | Defensibility | 5% |

Displayed to one decimal: **7.3 / 10**. Weights are editable in Settings (with a live calculator) and are
renormalised on write.

### Score inflation is treated as a bug

* The evaluator prompt anchors 5–6 as the default band, forces penalties for saturated categories, unclear
  monetisation, easy copying, and forbids claiming novelty without naming prior art.
* **Evidence guards** (`shared/scoring.js`) run deterministically on every evaluation: a factor scored ≥ 7
  needs a concrete justification, ≥ 8 needs a strong one. Hype language is negative evidence. Missing
  justification caps the factor at 5.5. Novelty ≥ 7 with no named prior art is capped at 6.4 — IdeaLab never
  claims an idea is objectively novel, because it did not search the internet.
* Every reduction is recorded and shown on the card (`−3 adj`) and in the detail view ("lowered from 8.6 ·
  weak-evidence"), so you can see exactly what the number is made of.
* A **calibration monitor** watches the live distribution. If the mean drifts above 7.0 or more than 20% of
  ideas score ≥ 8, it injects a re-anchoring directive into the evaluator prompt and adds extra strictness to
  the evidence guards until the distribution recovers. Health is shown in the header: `calibrated`,
  `drifting-high`, `inflated`, `harsh`.

Target distribution (what a healthy run looks like): mean **5.0–6.0**, ~20–30% at ≥ 7, under 10% at ≥ 8,
under 2% at ≥ 9. Scores like 2.8, 4.1, 5.6, 6.2 and 7.4 are normal output.

### Precise score colours

Colour is interpolated continuously from the numeric value across ten stops (deep red → red → orange → yellow
→ yellow-green → green → deepest green). **6.0 and 6.9 are different colours, and so are 7.0 and 7.9.** The
same function runs on the server and in the browser (`shared/scoring.js`) so the badge, the card border, the
tint and the API can never disagree.

---

## Fast mode vs Deep mode

* **⚡ Fast** — Generate → Evaluate → Score → Display → Next. Two model calls per idea, run in a pipeline.
  This is the discovery mode; leave it on continuous and scroll.
* **🔬 Deep** — Generate → Evaluate → **Attack** → **Improve** → **Re-evaluate**. Slower, and only worth it
  once something catches your eye.

Improvement is one level deep, deliberately: the ideas an *Improve* or *Mutate* produces are scored brutally but
are not themselves attacked and improved again. That keeps a deep batch from cascading into an unbounded chain of
derived ideas, and it means deep passes run outside the evaluation concurrency pool (with their own bound,
`IDEALAB_DEEP_CONCURRENCY`) rather than holding an evaluation slot while waiting for one.

On any idea you can also run individual actions from the detail drawer:

| Action | What happens |
| --- | --- |
| **Improve** | Rebuilds the idea around its stated weaknesses and creates a *new scored child idea* so you can compare before/after. |
| **Mutate** | Produces substantially different variants (customer / mechanism / business model / inverted assumption), each scored independently. |
| **Attack** | Fatal flaws, production failure modes, competition, unit economics, the kill shot, and what would have to be true to survive. |
| **Develop** | Smallest MVP that could prove or kill it: scope, what is deliberately out, build steps, technical requirements, prototype time, first ten customers, pricing, success metric, assumptions. |
| **Research** | The exact external checks a human should run — claims to verify, ready-to-paste search queries, competitors, data sources, kill criteria. It states plainly that IdeaLab did not browse. |
| **Re-evaluate** | Fresh evaluation, bypassing the cache, keeping the previous score in history. |

Generator, evaluator, attacker, improver, mutator, developer, researcher, meta-analyzer and extractor are
**separate prompts** (`server/src/prompts/roles.js`). The generator never scores its own ideas.

---

## Knowledge Bank

A persistent library of reusable building blocks — problems, technologies, business models, distribution
channels, monetisation mechanisms, audiences — each with name, category, description, examples, strengths,
weaknesses and source. Generation deliberately recombines them:

> problem + technology + target customer + business model + channel → a new idea

Seeded with ~60 hand-written blocks. Extraction from generated ideas is **gated**, because a knowledge base
that fills itself with model hallucinations is worse than none:

* a component must be traceable to real generated ideas (`evidence.ideaIds`), or it is rejected;
* a new component starts as **candidate** and only becomes **verified** when a second independent idea
  supports it, or when you promote it;
* anything containing market sizes, percentages, growth rates or "proven" claims without a source is
  **quarantined** as unverified and never enters a prompt;
* only verified blocks are sampled for generation, favouring underrused ones so the bank does not collapse
  onto the same few components.

---

## Anti-bias and duplicates

* **Bias monitor** — deterministic concentration over the last 60 ideas: category share, business-model
  share, audience share, overused mechanism vocabulary, AI-centric share, and a Herfindahl concentration
  index. Anything over 30% becomes an imperative directive injected into the next generation prompt
  ("At most 1 in 5 ideas may be `ai`"). A separate **meta-analyzer** role reads a compressed sample every 25
  ideas and adds its own directives. It stays quiet below 12 ideas — a handful of ideas is not a trend.
* **Duplicate detection** — token shingles over title, description, core mechanism, target user and problem.
  ≥ 0.72 is marked `≈ duplicate`, ≥ 0.38 a related `variant`. Nothing is ever deleted: a variation can still
  be the interesting one. You can hide duplicates in the filter panel.

---

## Filtering, sorting, saving

* **Filter** by overall, novelty, usefulness, feasibility, monetisation, market, AI leverage, differentiation
  or defensibility minimums (e.g. `novelty ≥ 8, feasibility ≥ 6, monetization ≥ 7`), plus category, status,
  tag, starred-only, hide-duplicates, hide-archived and full-text search.
* **Sort** by overall, novelty, usefulness, monetisation, market, feasibility, newest, oldest, most unusual
  (vocabulary rarity against the bank) or hardest to build.
* **Save** — star, archive, and status (`new / starred / researching / building / archived / rejected`), free
  notes and custom tags.

Everything is stored in `data/*.json` on your machine. Nothing leaves it.

---

## Performance panel

Ideas generated, ideas/minute, **useful ideas/minute (≥ 7)**, excellent ideas/minute (≥ 8), average
generation time, average evaluation time, average deep-action time, average and median score, counts at
≥ 7 / ≥ 8 / ≥ 9, token totals, tokens/second, model calls avoided (cache hits + duplicate reuses), retries
and failures — plus a **per-model comparison table**, so you can find out which installed model actually
produces more good ideas per minute on your hardware.

---

## Providers

Providers are modular. `ollama` and `demo` are registered in `server/src/providers/index.js`; adding LM
Studio, a llama.cpp server or a cloud API means writing one object and registering it:

```js
{
  id: 'my-provider',
  label: 'My provider',
  capabilities: { listModels: true, streaming: true, structured: true, parallel: true, preload: true },
  configure(settings, ctx) { /* store settings, keep connections warm */ },
  async ping() { /* -> { reachable, version, host } */ },
  async listModels() { /* -> [{ id, name, sizeLabel, hint, ... }] */ },
  async complete({ role, model, system, prompt, schema, temperature, maxTokens,
                   numCtx, signal, onToken, onItem, itemArrayKey }) {
    // stream tokens; call onItem(obj) for each complete element of the
    // response array so the pipeline can start evaluating immediately
    return { text, object, items, usage, elapsedMs, model, provider };
  },
}
```

Nothing else in the codebase knows which provider is running, and the model list is always queried from the
provider — no model is hardcoded. The default when none is selected is the **smallest installed model**,
because for scanning, throughput beats capability.

---

## Configuration

Everything is editable in **Settings** and persisted to `data/settings.json`. Environment variables set the
initial values:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OLLAMA_HOST` / `IDEALAB_OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama endpoint |
| `IDEALAB_PROVIDER` | `ollama` | `ollama` or `demo` |
| `IDEALAB_MODEL` | *(auto)* | Model id; empty = smallest installed |
| `IDEALAB_BATCH` | `6` | Ideas per generation call |
| `IDEALAB_EVAL_CONCURRENCY` | `3` | Concurrent review workers (match `OLLAMA_NUM_PARALLEL`) |
| `IDEALAB_REVIEW_DEPTH` | `120` | Review backlog at which generation throttles until it drains to 60% |
| `IDEALAB_DEEP_CONCURRENCY` | `2` | Concurrent deep actions (attack/improve), capped at the eval concurrency |
| `IDEALAB_CTX_GEN` / `_CTX_EVAL` / `_CTX_DEEP` | `3072 / 2048 / 3072` | `num_ctx` per role |
| `IDEALAB_MAXTOK_GEN` / `_EVAL` / `_DEEP` | `1400 / 900 / 1200` | `num_predict` caps |
| `IDEALAB_TEMP_GEN` / `_TEMP_EVAL` | `1.0 / 0.2` | Temperature per role |
| `IDEALAB_KEEP_ALIVE` | `30m` | How long weights stay resident (`-1` = until restart) |
| `IDEALAB_DEEP_THRESHOLD` | `6` | Deep mode only improves ideas at or above this score |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | API + UI server |
| `IDEALAB_DATA_DIR` | `./data` | Where ideas, knowledge and settings live |

Tuning for maximum useful ideas per minute: raise `IDEALAB_BATCH` and `IDEALAB_EVAL_CONCURRENCY` together
(with `OLLAMA_NUM_PARALLEL` to match), drop to a smaller model, and keep `num_ctx` as small as the prompts
allow.

---

## HTTP API

```
GET    /api/health                     provider reachability, active model, bank size
GET    /api/providers                  registered providers
GET    /api/models[?refresh=1]         models the provider actually has installed
POST   /api/models/preload|unload      keep weights resident / free RAM
GET    /api/settings   PATCH /api/settings   POST /api/settings/reset
GET    /api/scoring                  factors, weights, calibration state, 40-step colour ramp
POST   /api/jobs                     { count | continuous, category, mode, model } or { action, ideaId }
GET    /api/jobs     POST /api/jobs/:id/pause|resume|stop    POST /api/jobs/stop-all
GET    /api/reviews                  review queue: depth, workers in flight, backlog cap, avg wait, next up
POST   /api/reviews/pause|resume     stop or restart scoring without touching generation
POST   /api/reviews/clear            drop the backlog (ideas stay on the wall, unscored)
POST   /api/reviews/requeue          re-queue every idea that is still unscored
GET    /api/ideas?sort=&min_novelty=8&category=&q=&limit=    filter + sort the wall
GET    /api/ideas/:id                full record, similar ideas, children, parent
PATCH  /api/ideas/:id                status, starred, notes, tags    DELETE /api/ideas/:id
POST   /api/ideas/:id/action         improve | mutate | attack | develop | research | reevaluate
GET    /api/stats                    throughput, quality gates, per-model comparison, calibration
GET    /api/bias     POST /api/bias/analyze    POST /api/bias/reset
GET    /api/knowledge   POST /api/knowledge    PATCH/DELETE /api/knowledge/:id
POST   /api/knowledge/:id/promote    POST /api/knowledge/extract
GET    /events                       single SSE stream: snapshot, idea:new, idea:scored, idea:updated,
                                     job:update, stats, calibration, bias, knowledge, and the review
                                     lifecycle (review:queued|start|done|paused|resumed|throttled|cleared)
```

---

## Tests

```bash
npm test              # 97 tests
npm run test:unit     # scoring, calibration guards, colour ramp, stream parser, similarity, knowledge gating, UI render
npm run test:pipeline # end-to-end pipeline against the synthetic provider
npm run test:api      # HTTP + SSE integration against a real spawned server
```

`tests/throughput.test.js` pins the decoupling itself, and each of its seven tests fails against the old
batch-scoped pipeline: generation returns while its ideas are still unreviewed, the next batch starts before the
previous one has been scored, a continuous job keeps producing while review trails it, the generator is throttled
at the backlog cap and released when review catches up, every idea records how long it waited, deep review also
runs off the generation path, and unreviewed ideas are re-queued after a restart.

```bash
node scripts/bench-pipeline.mjs 36 4     # blocked vs decoupled against a P-slot stub backend
node scripts/bench-throughput.mjs 60 3   # the same comparison through the demo provider
```

The suite asserts the things that matter: the overall score equals its deterministic recomputation, the
distribution of a 40-idea firehose is not wall-to-wall 8–10, hype-only justifications get lowered while
well-argued ones do not, novelty without prior art is capped, streamed JSON is parsed correctly at **every**
possible chunk boundary, unevidenced knowledge-bank entries are rejected, and the UI renders every component
from realistic API fixtures without crashing.

---

## Layout

```
shared/scoring.js         one implementation of factors, weights, evidence guards and colour
server/src/
  providers/              ollama.js · demo.js · index.js (registry)
  prompts/                roles.js (9 separate role prompts) · schemas.js · build.js
  pipeline/               engine.js · jobs.js (generation) · review.js (evaluation queue)
                          scoring.js · calibration.js · bias.js · ideas.js · similarity.js · stats.js
  knowledge/              seed.js (~60 hand-written blocks) · bank.js (gated ingestion)
  lib/                    http.js (keep-alive pool) · jsonStream.js (incremental JSON) · store.js · bus.js · util.js
  routes/api.js           HTTP API
web/src/                  React UI: TopBar, PipelineStrip, FilterPanel, IdeaWall, IdeaCard, IdeaDetail,
                          KnowledgePanel, BiasPanel, StatsPanel, SettingsPanel
scripts/                  dev.mjs (server + vite) · bootstrap.mjs (self-healing start) · ollama-check.mjs
                          bench-pipeline.mjs · bench-throughput.mjs
data/                     your ideas, knowledge bank and settings (gitignored, local-only)
```

## Notes and honest limits

* IdeaLab does not browse. Novelty, prior art and market claims are a local model's hypotheses, and the UI
  says so wherever it matters. Use **Research** to turn an idea into checks a human can actually run.
* Score inflation is fought in three places (prompt anchoring, deterministic evidence guards, live
  distribution feedback) but a weak model can still be inconsistent. If the calibration chip in the header
  says `inflated`, the monitor is already pushing back — or switch models and compare.
* Local models are slow, and **review is the bottleneck, not generation**. Decoupling stops the generator
  idling, but it cannot create model capacity: one 1.8 s evaluation per idea caps review at ~33 ideas/min
  however fast ideas arrive. If the strip shows the backlog growing and the average wait climbing, either give
  the model parallel slots (`OLLAMA_NUM_PARALLEL`, plus matching review workers) or make each evaluation
  cheaper — smaller `num_ctx`, lower `num_predict`, a smaller evaluator model.
* The backlog cap is a real limit, not a bug. At `IDEALAB_REVIEW_DEPTH` (default 120) the generator waits for
  review to drain to 60%. That is deliberate: an unbounded queue means ideas scored minutes after they were
  generated, against a calibration window that no longer reflects what is on screen.
