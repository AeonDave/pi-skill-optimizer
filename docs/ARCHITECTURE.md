# How AUTO works

[Back to the README](../README.md)

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

## Request-specific prefetch

AUTO extracts intent only from genuine human text in Anthropic, OpenAI Chat and Responses, Gemini, Mistral, and Pi's structured `pi-messages` request shapes. A catalog may live in a system or developer block, but neither is treated as human intent. Assistant text, tool or function results, injected context, image metadata, and empty input cannot create a ranking signal.

Ranking uses exact matching, BM25F, bounded name and alias typo recovery, reciprocal-rank fusion, diversity, profile evidence, and decayed usage evidence. It scores full source descriptions, then appends a bounded set of verbatim skill names and descriptions (not the full `SKILL.md` instructions) to the latest human block. The overlay is separate from the stable prefix, fingerprinted, idempotent, and omitted when there is no valid target.

Optional init-generated activation tags distinguish specialists, workflow methods
and behavioral discipline. An admitted specialist can bring one activity-matched
supporting skill into the ordinary prefetch budget; this does not recursively
expand dependencies or treat a behavioral tag as universal. See
[contextual routing](RANKING.md#contextual-and-behavioral-skills).

## Dynamic tools

AUTO keeps protected and predicted tools active and leaves the rest behind `optimizer_tool_search`. Search is bounded and paginated. A returned result is activated through Pi's runtime API without replacing already active tools. Core, configured, and previously used tools remain callable, so an in-progress tool loop cannot be stranded. Pi's built-in `tool_search` remains active when the host enables it. Weak or absent routing signal fails open to every permitted tool; safety wins, but that request may retain the full schema cost.

Selection is recalculated before each agent run, not just the first request. Used tools and explicit search results stay active for the session. The discoverable set starts from Pi's initially active tools plus the optimizer's own resolvers. Newly activated host tools are retained; inactive `deferred` and `codemode` tools can be selected through search or `alwaysTools`. Inactive direct and hidden tools are not silently added. This is schema routing, not authorization: another extension's call-time permission checks remain authoritative.

See Pi's [extension and dynamic-tool API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Recoverable output

The default `smart` reducer is deterministic and UTF-8 byte-aware. It preserves protected evidence and accepts a reduction only when the complete returned representation clears both configured saving thresholds. Size and line settings trigger reduction; they are not hard output caps. Protected evidence may make the returned result exceed them.

Homogeneous JSON object arrays may use a lossless columnar form after an exact internal round trip. With `outputMode: "extract"` and an explicit `outputModel`, sufficiently large text may first use model-assisted extraction. Extracted content must be an ordered verbatim subsequence, retain protected evidence, and provide material savings. Rejection falls back to smart reduction, then to the original.

Before AUTO returns any reduced result, it stores the complete original in a local, immutable, content-addressed archive. Provider-visible recovery text contains only an opaque identifier. `retrieve_output` verifies and resolves that identifier with bounded line access.

Savings include the recovery label and are checked before an archive write. The optimizer's own resolver results are exempt from reduction, avoiding a second handle in place of the original you just requested. Custom-tool failures throw through Pi's error path instead of returning a success-shaped error object.

Columnar conversion conservatively leaves unsafe integers, non-finite numbers,
negative zero and noncanonical numeric spellings untouched. Parsing twice is not
a losslessness oracle when both parses can round the same value. Invalid Unicode
strings also fail open. Exact recovery retains the source's original line endings;
it does not normalize Windows output to LF.

History deduplication keeps the first large successful result intact and replaces only later exact copies. Errors, images, mixed media, small results, and protected evidence are never deduplicated.

## Scale and limits

AUTO reduces metadata in the tested catalogs, but does not guarantee model discovery.

- The current contract keeps every eligible skill name in the stable index. Its minimum size therefore grows linearly with the number and length of names. This all-name information floor cannot be compressed away while preserving immediate name-level discovery.
- A catalog with 100,000 skills is outside the scale demonstrated by the current 332-skill benchmark. It may still produce an impractically large name-only base.
- Extreme catalogs require an additional resolver-only, namespace-sharded, or server-side paginated discovery layer. That would deliberately change the current all-name visibility guarantee.
- Arbitrarily large system prompts are not automatically reduced. AUTO transforms recognized skill catalogs, manages tool definitions, and processes eligible tool results; it does not summarize unrelated policy, instructions, or conversation content.
- Provider tokenization, caching, and pricing remain provider-controlled. Stable bytes improve cacheability but do not prove a cache hit or guarantee a specific bill.
- Very small catalogs or outputs may remain unchanged when framing overhead would eliminate the saving.
