# AUTO benchmark

This document separates current deterministic transport checks from historical
real-provider evidence. Results from different discovery contracts are not
interchangeable.

## Tag-directory qualification (2026-10-19 snapshot)

Run `npm run bench:catalog` for the current result. This local, synthetic check
compares native catalogs, the compact-index fallback, and initialized tag
discovery on identical source descriptions. Cards and tags are preassigned: it
does **not** establish init classification accuracy, multilingual relevance,
instruction adherence, provider token savings, or model latency.

The replay counts a complete skill load in both paths, one additional browse
request in tag mode, and eight subsequent work requests. Browse results remain
in every later request; the fallback's human prefetch remains present too.
Known-name loading needs no browse. Five-page exploration is also reported,
including cases where it costs more than the compact index.

The dated results below are retained as observed. Release 3.1.3 adds init
recovery and live progress; those changes do not turn this synthetic transport
comparison into evidence of generated-card quality or provider savings.

Local working-tree run, 2026-10-19, Windows x64 / Node 26.3.0:

| Synthetic skills | Native initial bytes | Previous initial bytes | Tag initial bytes | Cumulative saving vs previous, one browse |
| --- | ---: | ---: | ---: | ---: |
| 355 | 71,975 | 8,523 | 3,254 | 31.4% (55,290 vs 80,571 bytes) |
| 2,000 | 406,188 | 30,373 | 3,280 | 79.1% (57,980 vs 277,221 bytes) |
| 10,000 | 2,034,592 | 150,373 | 3,319 | 95.7% (58,388 vs 1,357,221 bytes) |

Pagination enumerated **355/355, 2,000/2,000 and 10,000/10,000** cards without
duplicates or loss. With five browse responses, the 355-skill replay instead used
164,870 bytes across 14 requests, **more** than the previous path. These are
complete serialized payload bytes, not token conversions or provider savings.

The immutable catalog snapshot took approximately 4 / 15 / 60 ms respectively;
warm request preparation averaged approximately 1.3 / 5.3 / 27.5 ms in this run.
Snapshot creation is paid outside provider hot hooks; pagination reuses it.
Latency depends on hardware and runtime; rerun rather than treating these as SLAs.

Blocking deterministic gates:

- every eligible card is reachable exactly once through pagination, including
  stale/missing metadata under `unclassified`;
- the directory is query-independent and at most 4,000 characters; each complete
  serialized card response is at most 3,000 characters, including cursor/facets;
- exact loading remains verbatim and path-contained;
- no automatic skill selection or human-message overlay in tag mode;
- one browse plus load saves cumulative serialized bytes against the compact
  fallback for the synthetic 355/2,000/10,000 fixtures;
- an unavailable resolver, an unregistered external catalog, an undersized
  directory budget, or no net saving preserves native discovery.

Tags are selected by the main LLM, not inferred by a language-specific router.
With tags, optional query text orders candidates without vetoing the selected
bucket; query-only search retains lexical abstention. Arabic/Japanese regression
cases cover that availability property, **not** general relevance.

Before claiming production quality gains, run a paired, independently labeled
real-model evaluation of actual init-generated cards and subsequent loads/task
outcomes. Compare native, fallback and tag discovery, including broad buckets,
indirect method/behavior needs, multilingual requests, missing metadata and long
sessions. Record extra calls, cumulative context, time and provider usage. The
older `bench:real` recall harness below targets compact-index/prefetch exposure;
it is not a completed semantic evaluation of the new tag contract.

## Init recovery and live progress checks

The local init suites exercise complete card ownership and validation, bounded
diagnostic feedback, initial groups of at most 20 skills, two attempts per group,
and at most eight additional recovery calls shared by each original group's
subdivisions. Complete source descriptions survive retries; invalid partial
responses never become successful checkpoints. Provider errors do not trigger
subdivision, and terminal errors or cancellation stop later work.
Repeated failed schema migrations preserve previously known unchanged source
identities and routing fields while missing cards remain incomplete; failed new
or changed sources do not advance their hashes.

UI checks distinguish committed progress from streamed activity. They cover a
silent request with a one-second heartbeat, bounded redraws across thousands of
chunks, cumulative saved percentage, cancellation after a partial checkpoint,
session shutdown, ignored late responses and widget/timer cleanup. No real model
is needed for these local checks. They establish recovery and lifecycle behavior
under the fixtures, not the accuracy of actual model-generated summaries or tags.

## Published v2.0.0 snapshot

Status: **completed**

| Item | Value |
| --- | --- |
| Repository | `8a0b28a` (`v2.0.0`, 2026-09-01) |
| Anonymized cases | 8 |
| Distinct skills | 332 |
| Real-provider work | 31 Luna calls |
| Runtime/provider/model revision | Not recorded in the original run |
| Provider-reported cache reads | 0 |
| Invalid-response retries | 0 |
| Project safety gate | **PASS** |
| RTK external-comparator safety gate | **FAIL** |

This is historical release evidence. It predates the provider-shape and bounded runtime-cache changes released in v2.1.0 and is not a measurement of the current working tree.

No raw request, catalog, output, path, account identifier, hostname, or private corpus record is published.

## Discovery results

| Metric | Baseline | AUTO | Absolute change | Relative change |
| --- | ---: | ---: | ---: | ---: |
| Provider input | 28,177 tokens | 5,215 tokens | -22,962 tokens | **-81.5%** |
| Stable skill base | 106,966 bytes | 11,993 bytes | -94,973 bytes | **-88.8%** |
| End-model skill recall | 38% | 50% | **+12 pp** | - |
| Overlay/prefetch recall | - | 58% | - | - |
| Request overlay | - | 8,676 bytes | - | - |
| Stable-base byte gate | - | PASS | - | - |

End-model recall and overlay/prefetch recall measure different stages. The 58% value is not added to the 50% value and is not an end-to-end score. Exact local loading through a registered `skill_search` name is a resolver invariant; it does not imply that the model will discover or select that name.

The stable-base gate confirms that unrelated requests did not change the query-independent AUTO prefix. Provider-reported cache reads were zero, so this run demonstrates deterministic bytes, not a cache-hit or cost improvement.

## Output results

Three output cases were evaluated from identical raw inputs.

| Pipeline | Case 1 | Case 2 | Case 3 | Total | Reduction | Exact evidence by case | Semantic evidence by case |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Raw | 3,876 | 4,004 | 1,219 | 9,099 | - | 100% / 100% / 100% | 100% / 100% / 100% |
| Smart | 3,532 | 1,653 | 1,218 | 6,403 | **29.6%** | 100% / 100% / 100% | 100% / 100% / 100% |
| Guarded extraction | 3,533 | 1,650 | 1,219 | 6,402 | **29.6%** | 100% / 100% / 100% | 100% / 100% / 100% |
| RTK 0.42.4 | 1,793 | 500 | 244 | 2,537 | **72.1%** | 0% / 0% / 0% | 0% / 33% / 0% |

Project smart and guarded-extraction paths retained 100% exact and semantic evidence. Both passed the project safety gate.

RTK 0.42.4 is an external size comparator. Its smaller output did not retain the evidence required by this benchmark, so the external-comparator safety gate failed. This result applies only to RTK 0.42.4, these three cases, and this evidence definition. It is not a general assessment of RTK or its command-output use.

Guarded extraction is accepted only when it is an ordered verbatim subsequence, retains protected evidence, clears both saving thresholds, and has a recoverable complete archive. Any rejection falls back to smart processing and then to the original.

## Evaluation questions

The benchmark asks:

1. Does every eligible skill remain discoverable and exactly loadable?
2. Is the stable base byte-identical across unrelated human requests?
3. Does tag browsing preserve selection quality while reducing cumulative context and accounting for added calls?
4. Can `skill_search` recover relevant tail skills through bounded pagination?
5. Can `optimizer_tool_search` defer schemas without making required tools unavailable?
6. Do output and history reductions preserve protected evidence and exact recovery?
7. Is every accepted serialized transformation smaller?
8. What do providers report for tokens, cache reads, cache writes, and cost?

## Data and privacy contract

### Deterministic synthetic suite

The repository-local suite covers:

- regular and irregular skill roots;
- duplicate and near-duplicate names and descriptions;
- typos, Unicode, empty queries, and unrelated queries;
- critical, usage-weighted, configured, and excluded skills;
- ties, ambiguous neighborhoods, and budget boundaries;
- Anthropic, OpenAI Chat and Responses, Gemini, and Mistral request shapes;
- dynamic tool schemas, pagination, activation, and already-used protection;
- plain text, logs, tables, source, JSON, and adversarial evidence placement.

Synthetic cases enforce invariants and regressions. They do not measure real-user quality.

### Private real corpus

`npm run corpus:build` creates an explicit local corpus of real catalogs, sanitized human requests, tool schemas, and tool outputs. Collection never runs in an ordinary Pi hook.

A publishable evaluation corpus must:

- replace identifying values with keyed irreversible identifiers;
- remove absolute paths, credentials, hostnames, account names, and repository secrets;
- retain only structure required for routing and evidence checks;
- use human-reviewed labels rather than generated profile queries;
- pass validation before any remote call;
- remain under `.pi/skill-optimizer/benchmark/`;
- never be committed or published raw.

Remote evaluation receives only validated, sanitized cases.

## Discovery protocol

### Compact-index fallback base

This and the following prefetch protocol apply to profiles without v6 cards;
initialized tag discovery uses the separate qualification gates above.

Render the AUTO index for every catalog under unrelated requests and supported provider shapes.

Blocking invariants:

- unchanged catalog, profile, and configuration produce identical bytes;
- the AUTO marker appears exactly once;
- every eligible name appears exactly once;
- no filesystem location appears;
- all catalogs in a request share one soft intent budget until their combined all-name floors are reached;
- a second transformation preserves the already transformed reference.

Reported metrics:

```text
base_bytes
base_provider_tokens
all_name_recall
byte_stability_rate
path_leak_count
```

### Human-input prefetch

Use only labeled human text as the query. Compare expected skills with verbatim
catalog descriptions appended to the latest genuine human block, not full
`SKILL.md` instructions.

Blocking invariants:

- tool and function results never become query text;
- assistant text, injected context, and image metadata never become query text;
- empty input creates no ranking signal;
- only the latest genuine human text block changes;
- the AUTO marker prevents a second append;
- no valid human target means identity;
- descriptions stay verbatim and in source order;
- count and character budgets are deterministic.

Reported metrics:

```text
overlay_recall_at_budget
overlay_precision
overlay_bytes
overlay_provider_tokens
false_promotion_rate
```

### Skill search and loading

`skill_search` is evaluated independently of proactive prefetch. Expected results come from human-reviewed corpus labels, not generated profile queries.

Measure:

- Recall@1, Recall@3, Recall@5, MRR, and nDCG;
- exact-name recovery under bounded spelling variation;
- pagination completeness and duplicate rate;
- cursor rejection after query or fingerprint changes;
- exact-load success for registered names;
- rejection of unknown names, traversal, and symlink escape;
- response bytes for search, resource, and location actions.

Search-followed-by-load and multi-page sequences are included.

## Dynamic-tool protocol

Use small and large tool catalogs with human-reviewed required-tool labels.

Blocking invariants:

- core, configured, and already used tools remain active;
- inactive schemas are absent from the initial provider request;
- `optimizer_tool_search` remains active while searchable definitions remain;
- activation makes selected tools callable in the same session;
- activation is additive and cannot strand an active provider tool loop;
- schema indexing work and response pagination remain bounded;
- weak, empty, or unrelated routing signal fails open to every permitted tool.

Fail-open protects availability but can preserve the full tool-schema cost for that request. The benchmark must report this case rather than treating it as a discovery saving.

Reported metrics:

```text
tool_recall
initial_tool_schema_bytes
activated_tool_schema_bytes
optimizer_tool_search_calls
activation_failures
```

## Output protocol

Each case records original bytes, returned bytes, archive status, recovery result, protected evidence, and reducer path.

### Smart reduction

Test plain text, logs, tables, source, JSON, Unicode, UTF-8 byte boundaries, and adversarial evidence placement.

Required properties:

- activation thresholds use UTF-8 bytes rather than JavaScript character count;
- protected evidence remains present;
- byte and line thresholds are not hard caps, and protected evidence may exceed them;
- output clears absolute and relative saving thresholds;
- archive failure returns the original;
- `retrieve_output` reproduces the original and honors line bounds;
- provider-facing text contains no archive location;
- a second pass is not larger or more destructive.

### Columnar JSON

Use homogeneous object arrays with reordered keys, missing keys, nested values, Unicode, nulls, and metadata-like values.

Required properties:

- decoding is exact under JSON semantics;
- column and row ordering are preserved;
- protected evidence prevents conversion;
- heterogeneous arrays remain unchanged;
- the complete serialized representation is smaller.

### Guarded extraction

Measure accepted and rejected candidates. Acceptance requires:

- ordered verbatim subsequence validation;
- complete protected-evidence retention;
- both saving thresholds;
- a valid local archive;
- deterministic fallback through smart processing to the original.

Provider input, output, and cost are reported separately from deterministic saved bytes. A rejected candidate is a successful safety decision, not a reduction.

### RTK pairing

| Result class | Expected owner |
| --- | --- |
| Shell result already handled by RTK | RTK only |
| Shell result not handled by RTK | AUTO eligible |
| Read, web, MCP, and other eligible result | AUTO eligible |
| Already reduced result | Neither runs again |

AUTO alone, RTK alone, and paired behavior are compared on identical raw output. Returned size and protected-evidence recall are reported per result class.

### History deduplication

The first large successful result remains intact. Only later exact copies become opaque, recoverable references. Errors, images, mixed media, small results, and protected evidence remain unchanged. A second pass cannot increase mutation.

## Provider and cache accounting

Persistent telemetry v3 records:

```text
requests
input
output
cacheRead
cacheWrite
totalCost
```

Only provider usage fields are authoritative for tokens, cache behavior, and cost. Characters, UTF-8 bytes, and characters-per-token conversions are secondary measurements.

A cache experiment must:

1. Send the same stable prefix across distinct human requests.
2. Record the exact serialized prefix hash.
3. Record provider usage and cost.
4. Separate first-write, later-read, and uncached observations where available.
5. Report unavailable counters as unavailable, not zero.
6. Keep provider results separate before aggregation.

OpenAI, Anthropic, and Gemini expose different cache semantics. Stable bytes make caching possible but do not prove a hit.

## Scale boundary

The historical provider benchmark covers 332 skills. Current synthetic transport
checks cover 355, 2,000 and 10,000; neither establishes unbounded semantic quality.

Without v6 cards, AUTO keeps every eligible name in the stable index. Its
information floor grows linearly and can exceed `catalogBudgetChars`. Initialized
tag discovery deliberately replaces immediate name visibility with a bounded
directory and paged access; all cards remain resolvable rather than all names
remaining in every prompt.

A 100,000-skill catalog is not demonstrated here. Even with a bounded directory,
source indexing and init work scale with catalog size. Large buckets and repeated
browsing can dominate conversation space and latency.

The benchmark also does not establish reduction of arbitrary system prompts or ordinary conversation history. The project targets recognized skill catalogs, dynamic tool definitions, eligible tool results, and exact duplicate history results.

## Execution

### Local blocking gates

```bash
npm run typecheck
npm test
npm run bench
npm run bench:ranking
npm run bench:catalog
npm run bench:perf
npm run bench:output
```

`npm run bench` covers discovery, loading, determinism, pagination, provider normalization, identity, and fuzz invariants. `npm run bench:output` covers byte safety, evidence, archive recovery, columnar round trips, extraction guards, history behavior, and RTK ownership.

`npm run bench:ranking` compares BM25F-only, AUTO without fuzzy and full AUTO on
a small hand-authored synthetic fixture. It is a component diagnostic, not a
held-out relevance benchmark. [Current rationale and diagnostic results](docs/RANKING.md).
`npm run bench:perf` reports runtime/platform, cold latency and 30 warm samples
(mean, p50, p95) at 284 and 2,000 skills. These are request-preparation timings,
not model, startup or terminal-redraw timings.

For interactive development, load the checkout with `pi -e ./src/index.ts` and
exercise status, audit, search and verbatim skill loading. CI defines Windows,
Linux and macOS jobs on Node 26.3 and the current 26.x; inspect the jobs for the
commit under review rather than treating a configured matrix as a passing run.

### Packed release qualification

Inspect the package allowlist before testing the distribution:

```bash
npm pack --dry-run
npm pack
```

Unpack the tarball outside the checkout, without package-local Pi host
dependencies. Use an isolated `PI_CODING_AGENT_DIR`; `PI_AGENT_DIR` alone does not
relocate Pi's install root. Point the artifact host tests at that absolute package
root with the test-only `PI_SKILL_OPTIMIZER_TEST_PACKAGE` variable, then run
`node --import tsx --test test/host-runtime.test.ts`. Leave the variable unset for
ordinary source-suite runs.

Run `npm run smoke:blackbox -- <absolute-unpacked-package-root>` with the current
development Pi, and repeat against Pi 1.0.0 by setting `PI_CLI` to that CLI and
passing its exact version as the second argument:
`npm run smoke:blackbox -- <absolute-unpacked-package-root> 1.0.0`.
The black-box fixture model is local and needs no provider key. Packed loader,
offline command and tool checks qualify the tested artifact and host pair; they
do not establish live-provider init quality.

### Private real-model workflow

```bash
npm run corpus:build
npm run bench:real
```

These commands may send sanitized material to a real provider and incur cost. They are never invoked by `npm test`.

### Captured-request measurement

```bash
npm run measure <capture.json>
```

Measure exact serialized characters and UTF-8 bytes. Token conversions are estimates unless they come from provider usage.

## Publication checklist

Before publishing a new result:

- record commit, date, runtime, provider, model revision, corpus revision, and seed;
- run paired variants against identical sanitized inputs;
- keep ordering, concurrency, and retry policy fixed;
- separate deterministic gates from model-quality metrics;
- state failed and unavailable fields;
- retain numerators and denominators behind published percentages;
- publish no raw input, output, secret, identifier, hostname, or path;
- carry no result from an earlier architecture into the AUTO table.

## Primary references

These sources guide the protocol; they are not project benchmark evidence.

- [Pi skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)
- [Pi extensions and dynamic tools](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [OpenAI Codex skills](https://developers.openai.com/codex/skills)
