# Ranking decisions

[Back to the README](../README.md)

## Discovery has two profile modes

With current v1 `profile.catalog` metadata, discovery is LLM-led from a compact,
fixed 38-tag directory. Init supplies one source-bound card per skill (a
distinguishing sentence of at most 200 characters plus canonical tags); the host,
not the model, binds each card to the exact source-description hash. Missing or
stale cards remain available under `unclassified`, with a summary derived from
the current description. This validation proves shape and ownership, not that a
generated summary or tag is relevant.

A partially completed init can enter this mode as soon as it has valid catalog
metadata. The directory covers the whole registered catalog: accepted cards keep
their generated tags, and the remaining owners stay browsable under
`unclassified`. Restarting explicit init skips completed, unchanged cards and
repairs the remaining owners. Smaller retry batches and stricter diagnostics
improve recovery from invalid responses; they do not independently establish
classification quality. See the [init and cancellation contract](CONFIGURATION.md#routing-profile-initialization).

The directory gives the main model category descriptions and counts, not a list
of skill names. The model interprets the current task and may browse cards via
`skill_search` with tag match `any` or `all`; it must explicitly load a skill.
There is no automatic skill selection or prefetch in this mode. `critical` and
configured `alwaysSkills` names are stable hints, not loaded instructions or an
auto-selection rule. If the resolver is unavailable or the complete directory
does not fit, AUTO preserves Pi's native catalog rather than force-enabling the
tool.

The tag vocabulary is deliberately coarse. `discipline` is for evidence-preserving
reading, persistence, verification, safe judgment and related execution habits;
`other` is the honest inspection bucket when no supported topic tag fits, not a
reason to force a superficially similar category. It is distinct from
`unclassified`, which means the host has no current valid card. The model is expected to interpret
the task in its language, but multilingual discovery quality has not been
measured. There are no per-language query keys, embedding calls, or hidden
per-turn model requests; init is explicit provider work. An explicit free-text
`skill_search` query with tags orders the tag-filtered bucket: matched bucket
cards first in the ranker's order, then the bucket's remaining cards in canonical
order, and only then cards from outside the bucket that the ranker matched, as an
explicit lexical rescue. Promotion is bounded: an outsider inside the ranker's
overall top 3 moves into that head at its rank position and is marked
`rescue: true`, at most three are promoted, and every later outsider stays
behind the complete bucket. The bucket keeps its priority and membership, facets
and counts stay bucket-only, and cursors still page the complete result. A tag
choice therefore never hides a card whose source description clearly matches,
which preserves multilingual results with little or no term overlap. Without tags, a query retains local BM25F lexical
filtering/ranking over original descriptions. Catalog pagination itself never
matches text: `orderedNames` is the single lexical source, so a query whose
supplied ordering contains no eligible card yields `total: 0` instead of a
fabricated ranking.
Directory counts and card contents affect stable prompt bytes. Only populated
tag rows are rendered, plus `unclassified` when it is non-zero, so a vocabulary
entry no card uses costs no prompt bytes; the header still reports `total` and
`unclassified`. A malformed source is quarantined with a host-visible reason
rather than throwing, and a block that contains one keeps native discovery so no
skill silently disappears. The directory size cap is
`min(4,000, catalogBudgetChars)` characters per catalog, and a complete browse
response is capped at 3,000 characters (not UTF-8 bytes), so a page can contain
fewer entries than requested. The response is a compact record — `total`,
`items` of `{name, summary, tags}`, `usedChars` — with no `version` or
`fingerprint`, because the cursor already binds both. `facets` ship with the
first page only, and `nextCursor` is a short `{o,s}` token whose signature
covers version, catalog fingerprint, filter hash and offset. Tag and empty
browses page at the 50-card cap; query-only lexical search keeps 10. A first
page may also carry `rest`, the names of every candidate not shown, when the
complete list fits the same 3,000-character cap beside at least three full
cards — so a typical bucket (up to 73 cards) is answerable from one response,
and a larger bucket still paginates through its cursor. Browsing is an optional
extra request: it can cost more bytes than it saves when the model pages
repeatedly.

Profiles without current v1 catalog metadata—including v5 profiles—retain the
compatible local lexical router until the user explicitly runs init. In this
path the job is to find a few useful entries in a known skill catalog before
the model starts work. AUTO's hybrid is deterministic and provider-free, but
that does not make lexical retrieval universally better than embeddings or
prove that its weights are optimal.

The no-card compatibility pipeline is:

1. Normalize the latest genuine human text and expand catalog-supported aliases.
2. Score names, short intents, full descriptions and optional profile queries with
   field-weighted BM25F. Compact display text is not the only searchable text.
3. Add token-bounded name/example matches and bounded name/alias typo candidates.
4. Combine the rankings with weighted reciprocal-rank fusion (RRF). Decayed usage
   can reinforce an already relevant candidate, not invent relevance.
5. Apply negative hints and a small cluster-diversity adjustment, then select
   within adaptive count and character budgets. Explicitly protected skills have
   their own guarantee; they can exceed ordinary prefetch budgets.

This scoring pipeline is only the legacy/no-card request prefetch path. In that
path, exact-name evidence comes from the normalized original query: whole skill
name (12), all skill-name tokens (8), or an exact profile phrase (7). Alias
expansion contributes lexical retrieval evidence but is not itself promoted to
that exact-match channel; this avoids giving short ambiguous aliases the same
weight as a direct name request.

The stable all-name index is separate from this ranking. A miss in prefetch does
not remove a skill from the library or its exact resolver. This all-name floor
and the prefetch overlay are compatibility behavior, not the v6 directory-mode
contract.

## Contextual and behavioral skills

Literal similarity is not the whole job. A task that selects a language specialist
can also need architecture or test-first discipline without naming either.
An optional, name-owned `activation` entry in the profile records two tags:

- `kind`: `specialist`, `workflow`, or `behavioral`.
- `tasks`: a small subset of shared activities such as `software-change`,
  `software-review`, `docs-write`, or `research`.

Explicit `/skill-optimizer init` may retain or regenerate these from each skill's
description. They are used by the no-card compatibility router only. The fixed
activity vocabulary works across init batches; old profile fields are preserved
when a migration batch fails for an unchanged source. Init uses the selected
model and can incur cost; it is never run automatically.

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

## What the legacy ranking comparison can tell us

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

Historical no-card lexical diagnostic, 2026-09-28 (working tree, Node 26.3.0,
Windows x64; it does not measure v6 tag discovery):

| Variant | Recall@1 | Recall@5 | MRR | No-signal promotions |
| --- | --- | --- | --- | --- |
| BM25F only | 17/18 (94.4%) | 17/18 (94.4%) | 0.944 | 0/4 |
| AUTO without fuzzy | 15/18 (83.3%) | 17/18 (94.4%) | 0.889 | 0/4 |
| AUTO | 16/18 (88.9%) | 18/18 (100%) | 0.944 | 0/4 |

The hybrid recovers the final relevant item within five results, but does not win
top-one accuracy. This is why no new weight set or replacement is justified by
this fixture alone. Re-run the command for current-tree results. This fixture
predates v6 and says nothing about tag/card relevance or whether the main model
will browse the directory.

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

One separate synthetic transport comparison used a 355-skill catalog (2026-11-10
compact-wire snapshot, same run as BENCHMARK.md). The native initial catalog
serialized to 71,975 bytes; the former compact TSV was 8,523 bytes, and the tag
directory was 3,318 bytes. For eight work turns with one browse and an exact load,
the tag-directory scenario emitted 53,329 serialized bytes across 10 requests,
versus 80,571 bytes across 9 requests for the previous path (33.8% fewer bytes).
Five cursor-following browses still cost 53,329 bytes at this catalog size, because
a 10-card bucket completes in its first response (`rest` names the remainder) and
no continuation pages are retained; at 2,000 and 10,000 skills the same five-browse
replay cost 141,975 and 236,759 bytes, so very large buckets still pay for depth.
The earlier 2026-10-19 run (164,254 bytes for a five-page replay at 355 skills)
predates the compact wire: dropped envelope fields, first-page-only facets, short
signed cursors, populated-row-only directories and the `rest` remainder. These are
synthetic transport totals, not provider token or cost measurements, and do not
measure selection quality. They are not a universal savings claim.
Directory sizes and counts are workload-dependent. Broader scale measurements
are kept separately in [BENCHMARK.md](../BENCHMARK.md).

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
