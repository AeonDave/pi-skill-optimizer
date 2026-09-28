# Ranking decisions

[Back to the README](../README.md)

## Why this is still a local lexical router

The job is to find a few useful entries in a known skill catalog, before the model
starts work. Ordinary routing must be deterministic, cheap to run, and usable
without another provider or a generated profile. AUTO's hybrid is a reasonable
fit for those constraints; it is not a claim that lexical retrieval is universally
better than embeddings or that these weights are optimal.

The current pipeline is:

1. Normalize the latest genuine human text and expand catalog-supported aliases.
2. Score names, short intents, full descriptions and optional profile queries with
   field-weighted BM25F. Compact display text is not the only searchable text.
3. Add token-bounded name/example matches and bounded name/alias typo candidates.
4. Combine the rankings with weighted reciprocal-rank fusion (RRF). Decayed usage
   can reinforce an already relevant candidate, not invent relevance.
5. Apply negative hints and a small cluster-diversity adjustment, then select
   within adaptive count and character budgets. Explicitly protected skills have
   their own guarantee; they can exceed ordinary prefetch budgets.

The stable all-name index is separate from this ranking. A miss in prefetch does
not remove a skill from the library or its exact resolver.

## Contextual and behavioral skills

Literal similarity is not the whole job. A task that selects a language specialist
can also need architecture or test-first discipline without naming either.
An optional, name-owned `activation` entry in the profile records two tags:

- `kind`: `specialist`, `workflow`, or `behavioral`.
- `tasks`: a small subset of shared activities such as `software-change`,
  `software-review`, `docs-write`, or `research`.

Explicit `/skill-optimizer init` assigns these from each skill's description.
The fixed activity vocabulary works across init batches: no full-catalog model
request or runtime inference call is needed. Old profiles still work; rerun init
to regenerate them with the new tags. That regeneration uses your selected model
and can incur cost. This update does not run it automatically.

The router first selects a positively matched, tagged specialist. It can then
reserve **one ordinary prefetch slot** for a workflow or behavioral skill sharing
an activity tag, even with no lexical match to the user's words. This is one-hop
support, not recursive expansion. It retains the primary specialist, honors
exclusions and negative hints, and uses the same count and character budget.
Already selected skills are not duplicated; a one-slot budget leaves only the
primary. An explicit exact-name selection takes precedence.

Contextual search entries carry the reason `contextual`, without pretending that
they had a lexical score. Direct search ordering is retained. `clusters` represent
confusable substitutes only; complementary phases are not penalized as substitutes.

The `behavioral` tag does **not** mean always-on. Truly universal disciplines still
belong in `critical`; task-specific design, debugging and testing do not. An empty
or unrelated request cannot trigger support just from its tags or usage history.

These are routing hints, not a dependency solver or proof that the LLM classified
every skill correctly. Activity tags are deliberately coarse and the router does
not infer task phases from tool output or inspect repository files. The contextual
tests use reviewed fixtures; they do not establish generated-profile quality.

The typo fallback is deliberately conservative: it runs only when fewer than
60% of query terms are covered by the catalog or its aliases. A typo surrounded
by enough known words can therefore be missed. This is a known quality tradeoff,
not a promise to repair every misspelling.

## What the algorithm comparison can tell us

Run the diagnostic fixture locally:

```bash
npm run bench:ranking
```

It compares BM25F-only ordering, AUTO without fuzzy candidates, and full AUTO on
the same 14 synthetic skills, 18 labeled positive queries and four no-signal
queries. It prints Recall@1, Recall@5, mean reciprocal rank and no-signal
promotions. It also rejects the regression where `git` was treated as an exact
name inside `digital`.

A separate two-case support diagnostic checks architecture and behavioral guidance
without literal query overlap, and verifies no promotion on unrelated input. It
uses reviewed activation tags, not init-generated labels, and does not enter the
18-query lexical comparison below.

These are hand-authored diagnostics, **not a held-out or production dataset**.
They include typos and nearby tasks, but no generated profile, learned usage or
cluster-diversity labels. The BM25F baseline reuses AUTO's lexical component; it is
not an independent implementation. Results can reveal a tradeoff or regression,
not establish the best router for all users. Keep the denominators and report
weaker results as well as improvements.

Local diagnostic run, 2026-09-28 (working tree, Node 26.3.0, Windows x64):

| Variant | Recall@1 | Recall@5 | MRR | No-signal promotions |
| --- | --- | --- | --- | --- |
| BM25F only | 17/18 (94.4%) | 17/18 (94.4%) | 0.944 | 0/4 |
| AUTO without fuzzy | 15/18 (83.3%) | 17/18 (94.4%) | 0.889 | 0/4 |
| AUTO | 16/18 (88.9%) | 18/18 (100%) | 0.944 | 0/4 |

The hybrid recovers the final relevant item within five results, but does not win
top-one accuracy. This is why no new weight set or replacement is justified by
this fixture alone. Re-run the command for current-tree results.

| Candidate | Why keep or consider it | What is still missing |
| --- | --- | --- |
| BM25F + exact/fuzzy + RRF | Local, reproducible, no training labels or score calibration required | Representative relevance labels for weight/confidence tuning |
| BM25F alone | Simpler comparator; can lead on straightforward lexical queries | Name-typo recovery and broader intent coverage |
| Calibrated score fusion | Retains score magnitude that rank fusion discards | A separate tuning set and held-out evaluation |
| Embeddings / reranking | Could help paraphrases with little shared vocabulary | Measured quality gain, latency and privacy/cost tradeoffs; not implemented or benchmarked here |

Do not tune defaults merely to win this tiny fixture. Before replacing the router,
use separately reviewed relevance labels, keep tuning and evaluation cases
separate, compare identical catalogs and budgets, and measure both false
promotions and missed skills. The [private evaluation protocol](../BENCHMARK.md)
defines the broader gates; running it is an explicit operation.

## Performance versus quality

```bash
npm run bench:perf
```

This measures `optimizePayload` with 201 messages and 284 / 2,000 synthetic skills.
Each catalog gets one cold call and 30 warm calls; mean, p50 and p95 are reported
along with runtime/platform. Warm calls reuse the same source request and query,
not an already transformed payload. The size check must remain deterministic.

This is request-preparation latency, **not Pi startup, terminal redraw or model
latency**. There is no universal millisecond gate: compare repeated runs on the
same host. Index caching should remove repeated analysis without changing scores,
and caches must remain bounded and invalidate when catalog/profile content changes.

## Research behind the choices

BM25F combines weighted document fields before term saturation, rather than
summing independently saturated field scores. The original formulation is
[Robertson, Zaragoza and Taylor, 2004](https://www.researchgate.net/publication/221613382_Simple_BM25_extension_to_multiple_weighted_fields)
(author-uploaded paper).

RRF combines positions rather than requiring compatible score scales. Its common
constant of 60 comes from experiments in
[Cormack, Clarke and Buettcher, 2009](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf),
not a universal optimum for skill catalogs.

Later work found tuned convex score fusion stronger than RRF in its evaluated
lexical/semantic settings, and found RRF sensitive to its parameters. See
[Bruch, Gai and Ingber, 2023](https://arxiv.org/abs/2210.11934).
Those experiments do not directly validate or invalidate this skill router.
The design judgment here is to retain the local hybrid until project-specific
evaluation justifies a replacement, while fixing demonstrated correctness and
implementation-cost problems now.
