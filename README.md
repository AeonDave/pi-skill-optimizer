# pi-skill-optimizer

Token-efficient capability discovery and recoverable tool-output reduction for [Pi](https://github.com/earendil-works/pi).

The extension exposes one strategy: **AUTO**. It replaces repeated full skill catalogs with a stable, compact index, adds a bounded request-specific prefetch to the latest genuine human input, activates tool definitions on demand, and reduces large tool results without giving up local recovery.

RTK is the recommended companion for command output. It is not required.

## What AUTO changes

| Surface | Stable or immediately available | Added only when needed |
| --- | --- | --- |
| Skills | Every eligible skill name and a short routing intent | Full verbatim definitions selected for the current request |
| Skill files | A `skill_search` resolver instruction | Exact skill content, resource, or validated location |
| Tools | Core, configured, already used, and bounded predicted tools | Definitions found and activated through `tool_search` |
| Tool output | Evidence-preserving reduced content | Complete original through `retrieve_output` |

AUTO targets repeated capability metadata and large tool results. It does not rewrite arbitrary instructions, ordinary conversation history, or unrelated system-prompt content.

## How it works

### Stable skill base

AUTO renders a query-independent index in the stable prompt prefix:

```xml
<!--skill-optimizer:auto:v2-->
<skill_index format="tsv" columns="name,intent">
skill-name\tShort routing intent
</skill_index>
<skill_resolver>Use skill_search to search, load, inspect resources, or request a location.</skill_resolver>
```

The index contains no filesystem paths. With the same catalog, profile, and configuration, its bytes remain unchanged across requests. `catalogBudgetChars` is a request-global soft budget shared by every catalog found in one request. Intents yield first, but the combined all-name floor may exceed the budget.

### Request-specific prefetch

AUTO extracts intent only from genuine human text in Anthropic, OpenAI Chat and Responses, Gemini, and Mistral request shapes. Assistant text, tool or function results, injected context, image metadata, and empty input cannot create a ranking signal.

Ranking uses exact matching, BM25F, bounded name and alias typo recovery, reciprocal-rank fusion, diversity, profile evidence, and decayed usage evidence. It scores full source descriptions, then appends a bounded set of full verbatim definitions to the latest human block. The overlay is separate from the stable prefix, fingerprinted, idempotent, and omitted when there is no valid target.

### Dynamic tools

AUTO keeps protected and predicted tools active and leaves the rest behind `tool_search`. Search is bounded and paginated. A returned result is activated through Pi's runtime API without replacing already active tools. Core, configured, and previously used tools remain callable, so an in-progress tool loop cannot be stranded. Weak or absent routing signal fails open to every permitted tool; safety wins, but that request may retain the full schema cost.

See Pi's [extension and dynamic-tool API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

### Recoverable output

The default `smart` reducer is deterministic and UTF-8 byte-aware. It preserves protected evidence and accepts a reduction only when the complete returned representation clears both configured saving thresholds. Size and line settings trigger reduction; they are not hard output caps. Protected evidence may make the returned result exceed them.

Homogeneous JSON object arrays may use a lossless columnar form after an exact internal round trip. With `outputMode: "extract"` and an explicit `outputModel`, sufficiently large text may first use model-assisted extraction. Extracted content must be an ordered verbatim subsequence, retain protected evidence, and provide material savings. Rejection falls back to smart reduction, then to the original.

Before AUTO returns any reduced result, it stores the complete original in a local, immutable, content-addressed archive. Provider-visible recovery text contains only an opaque identifier. `retrieve_output` verifies and resolves that identifier with bounded line access.

History deduplication keeps the first large successful result intact and replaces only later exact copies. Errors, images, mixed media, small results, and protected evidence are never deduplicated.

## Runtime tools

| Tool | Purpose |
| --- | --- |
| `skill_search` | Paginated skill search plus exact `load`, contained `resource`, and explicit `location` actions |
| `tool_search` | Search deferred tool definitions and activate bounded matches additively |
| `retrieve_output` | Recover archived output or a deduplicated history result by opaque identifier |

Exact skill loading accepts only registered names. Resource and location resolution use canonical paths and containment checks to reject traversal and symlink escape. Search cursors are bound to the query and catalog fingerprint. This is an exact local resolver guarantee, not a guarantee that the model will select the right skill; measured model and prefetch recall are reported separately below.

## Install

```bash
pi install npm:pi-skill-optimizer
```

Start Pi and generate the routing profile:

```text
/skill-optimizer init
```

`init` is explicit model work. It batches full descriptions by skill count and UTF-8 input size, validates complete coverage and provider stop reason, and retries incomplete batches. Ordinary discovery does not call a model.

For local development:

```bash
npm install
pi -e ./src/index.ts
```

## Commands

| Command | Purpose |
| --- | --- |
| `/skill-optimizer` | Show AUTO state, catalog budget, critical skills, usage prior, tool activation, provider telemetry, and savings |
| `/skill-optimizer init` | Generate or incrementally update `critical`, `queries`, `clusters`, and `negativeHints` |
| `/skill-optimizer audit` | Report bounded catalog and profile issues without editing source skills |

## Configuration

Global configuration lives at `~/.pi/agent/skill-optimizer/config.json`. A project can override it with `.pi/skill-optimizer/config.json`.

| Key | Default | Purpose |
| --- | ---: | --- |
| `catalogBudgetChars` | `8000` | Request-global soft budget for stable-index intents |
| `intentMaxChars` | `96` | Maximum rendered intent length |
| `prefetchTarget` | `5` | Ordinary prefetch target |
| `prefetchMin` | `3` | Minimum adaptive prefetch count |
| `prefetchMax` | `8` | Maximum adaptive prefetch count |
| `prefetchBudgetChars` | `6000` | Full-definition overlay budget |
| `fuzzyCandidateLimit` | `8` | Bound for name and alias typo recovery |
| `alwaysSkills` | `[]` | Skills favored for routing and prefetch |
| `excludeSkills` | `[]` | Skills intentionally removed from discovery |
| `providers` | `[]` | Provider allowlist; empty means all |
| `toolPrefetchMax` | `5` | Maximum proactive tool activation |
| `toolSearchPageSize` | `8` | Default tool-search page size |
| `alwaysTools` | `[]` | Tools that remain active |
| `historyDedupMinBytes` | `4096` | Minimum result size for history deduplication |
| `usageHalfLifeDays` | `30` | Usage-evidence decay half-life |
| `usageMaxEntries` | `2048` | Persistent usage-evidence bound |
| `usageStaleDays` | `180` | Age for pruning stale one-off evidence |
| `outputMode` | `"smart"` | `"off"`, `"smart"`, or guarded `"extract"` |
| `outputMaxLines` | `400` | Line-count activation threshold |
| `outputMaxBytes` | `16000` | UTF-8 byte activation threshold |
| `outputMinSavingsBytes` | `512` | Minimum absolute saving |
| `outputMinSavingsRatio` | `0.1` | Minimum relative saving |
| `outputTools` | `["*"]` | Eligible tool-name patterns |
| `outputModel` | `""` | Explicit model for guarded extraction |
| `outputExtractMinBytes` | `32000` | Minimum input size for extraction |
| `outputExtractExclude` | common listing commands | Tools excluded from extraction |
| `outputArchiveTtlHours` | `168` | Archive retention period |

Configuration is also available through `PI_SKILL_OPTIMIZER_*` environment variables. Lists are comma-separated. The bypass exists only as `PI_SKILL_OPTIMIZER_DISABLE` and uses boolean semantics; there is no `disable` configuration key. Output exceptions retain the exact names `PI_SKILL_OPTIMIZER_OUTPUT_MIN_SAVINGS_RATIO` and `PI_SKILL_OPTIMIZER_OUTPUT_EXCLUDE`.

## RTK coexistence

Ownership is decided per result:

| Result | Owner |
| --- | --- |
| Shell output already handled by RTK | RTK only |
| Shell output not handled by RTK | AUTO eligible |
| Read, web, MCP, and other eligible output | AUTO eligible |
| Already reduced output | No second reduction |

RTK never changes skill discovery or dynamic tool activation.

## Telemetry and persistence

Provider telemetry records only authoritative usage fields:

```text
requests, input, output, cacheRead, cacheWrite, totalCost
```

AUTO does not infer cache hits from stable bytes. Characters, UTF-8 bytes, provider tokens, and cost remain separate metrics.

Profile, usage, and statistics updates use atomic replacement and lock-serialized additive deltas. Archives are immutable, SHA-256 verified, and TTL-cleaned. Usage evidence is bounded and decays over time.

## Privacy

- Normal hooks never collect a benchmark corpus.
- Corpus building and real-provider evaluation are explicit commands.
- Remote evaluation receives only validated, sanitized cases with keyed irreversible identifiers.
- Raw private sessions, catalogs, paths, credentials, hostnames, and account identifiers are not published.
- Generated profile queries are routing hints, not benchmark labels.
- Full output archives stay local.
- `.pi/skill-optimizer/benchmark/` must not be committed.

## Current benchmark

The current private, anonymized run covers 8 cases and 332 skills.

| Metric | Baseline/raw | AUTO | Change |
| --- | ---: | ---: | ---: |
| Provider input | 28,177 tokens | 5,215 tokens | **-81.5%** |
| Stable skill base | 106,966 bytes | 11,993 bytes | **-88.8%** |
| End-model skill recall | 38% | 50% | **+12 pp** |
| Overlay/prefetch recall | - | 58% | - |
| Smart output | 9,099 tokens | 6,403 tokens | **-29.6%** |
| Guarded extract output | 9,099 tokens | 6,402 tokens | **-29.6%** |

Smart and guarded extraction retained 100% exact and semantic evidence, and the project safety gate passed. RTK 0.42.4 produced 2,537 tokens in the same three output cases but failed the benchmark's external protected-evidence gate. The evaluation used 31 Luna calls.

See [BENCHMARK.md](./BENCHMARK.md) for per-case output results, methodology, safety gates, limitations, and reproduction commands.

## Scale and limits

AUTO makes the tested large catalogs substantially cheaper, not free, and does not guarantee model discovery.

- The current contract keeps every eligible skill name in the stable index. Its minimum size therefore grows linearly with the number and length of names. This all-name information floor cannot be compressed away while preserving immediate name-level discovery.
- A catalog with 100,000 skills is outside the scale demonstrated by the current 332-skill benchmark. It may still produce an impractically large name-only base.
- Extreme catalogs require an additional resolver-only, namespace-sharded, or server-side paginated discovery layer. That would deliberately change the current all-name visibility guarantee.
- Arbitrarily large system prompts are not automatically reduced. AUTO transforms recognized skill catalogs, manages tool definitions, and processes eligible tool results; it does not summarize unrelated policy, instructions, or conversation content.
- Provider tokenization, caching, and pricing remain provider-controlled. Stable bytes improve cacheability but do not prove a cache hit or guarantee a specific bill.
- Very small catalogs or outputs may remain unchanged when framing overhead would eliminate the saving.

## Development and validation

```bash
npm run typecheck
npm test
npm run bench
npm run bench:output
npm run corpus:build
npm run bench:real
npm run measure <capture.json>
```

The first four commands are local gates. `corpus:build` and `bench:real` are explicit remote workflows and may incur provider cost.

## References

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

## License

MIT
