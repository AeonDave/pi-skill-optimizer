# AUTO benchmark

This document defines the benchmark contract and records the current real-corpus evidence for AUTO. Earlier discovery architectures are not comparable and are intentionally excluded.

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

This is historical release evidence. It predates the Unreleased provider-shape and bounded runtime-cache changes and is not a measurement of the current working tree.

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

1. Does every eligible skill remain visible and exactly loadable?
2. Is the stable base byte-identical across unrelated human requests?
3. Does bounded prefetch improve first-turn recall without changing that base?
4. Can `skill_search` recover relevant tail skills through bounded pagination?
5. Can `tool_search` defer schemas without making required tools unavailable?
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

### Stable base

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

Use only labeled human text as the query. Compare expected skills with full verbatim definitions appended to the latest genuine human block.

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
- `tool_search` remains active while searchable definitions remain;
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
tool_search_calls
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

This benchmark covers 332 skills, not an unbounded catalog.

AUTO keeps every eligible name in the stable index. Consequently, the minimum base size is the sum of framing plus all rendered names across the request. Intent text shares one request-global budget, but the combined all-name information floors grow linearly and can exceed `catalogBudgetChars`.

A 100,000-skill catalog is not demonstrated here and may still be too large. Supporting that scale efficiently requires resolver-only discovery, namespaces, sharding, or a server-side paginated index. Those approaches change the current guarantee that every name is visible in the base prompt.

The benchmark also does not establish reduction of arbitrary system prompts or ordinary conversation history. The project targets recognized skill catalogs, dynamic tool definitions, eligible tool results, and exact duplicate history results.

## Execution

### Local blocking gates

```bash
npm run typecheck
npm test
npm run bench
npm run bench:perf
npm run bench:output
```

`npm run bench` covers discovery, loading, determinism, pagination, provider normalization, identity, and fuzz invariants. `npm run bench:output` covers byte safety, evidence, archive recovery, columnar round trips, extraction guards, history behavior, and RTK ownership.

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
