# How AUTO works

[Back to the README](../README.md)

## Stable skill base and semantic catalog mode

Without version-1 semantic catalog metadata, AUTO keeps the compatible, query-independent TSV index in the stable prompt prefix:

```xml
<!--skill-optimizer:auto:v2-->
<skill_index format="tsv" columns="name,intent">
skill-name\tShort routing intent
</skill_index>
<skill_resolver>Use skill_search to search, load, inspect resources, or request a location.</skill_resolver>
```

The TSV index contains no filesystem paths and keeps every eligible name visible. With the same catalog, profile, and configuration, its bytes remain unchanged across requests. `catalogBudgetChars` is the request-global soft budget shared by compact indexes; intents yield first, but their all-name floor may exceed it. Existing profiles without current catalog metadata, including v5 profiles, remain on this path until the user explicitly runs `/skill-optimizer init`.

Init version 6 adds an optional `profile.catalog` with a versioned, fixed 38-tag vocabulary and one LLM-generated card per skill. `discipline` covers evidence-preserving reading, persistence, verification, safe judgment and related execution habits; `other` is an honest inspection bucket for topics not represented by the taxonomy, distinct from the host's `unclassified` fallback for missing or stale cards. When current catalog metadata exists, the stable block becomes a compact, query-independent tag directory with category descriptions and counts, not a per-skill name list. The complete directory and any explicit `critical`/`alwaysSkills` name hints must fit within `min(4,000, catalogBudgetChars)` characters per catalog; if they do not fit, AUTO preserves Pi's original skill catalog. A changed card or catalog count can change the stable bytes; stability is conditional on unchanged catalog, profile and configuration.

In this mode the main model interprets the current task, chooses category tags, and can browse cards through `skill_search` with `match: "any"` or `"all"`. Each complete JSON browse response is bounded to 3,000 **characters** (not UTF-8 bytes), so a page can contain fewer than the requested page size; cursors continue the browse. A card is a distinguishing sentence of at most 200 characters, one to three canonical tags, and a host-computed source hash. Missing or stale cards remain searchable as `unclassified` using a summary derived from the current source description. With tags, an optional text `query` only orders candidates inside the complete tag-filtered bucket; it does not lexically veto candidates, so cross-language queries can still browse semantically selected tags. Without tags, `query` retains its local BM25F lexical filtering/ranking over source descriptions. The model-selected tag directory is not a new language-specific router.

Catalog mode does not automatically select or prefetch a skill. `critical` and configured `alwaysSkills` names appear as stable metadata hints, not as loaded instructions, forced tool activations or overlays. The model must choose to browse and then explicitly load a relevant exact name. The optimizer makes no per-language query keys, embedding calls, or hidden per-turn model calls: discovery decisions occur in the existing Pi turn, while tag filtering and BM25F search run locally. Init is explicit model work.

The catalog directory is used only when the profile has current semantic catalog metadata and the resolver is permitted. If pi-persona or another host policy withholds `skill_search`, AUTO leaves the native Pi skill catalog unchanged and does not re-enable the resolver. This directory-first behavior deliberately trades the old per-skill all-name prompt for a smaller taxonomy and paginated discovery; it does not guarantee that the model will browse or select the right skill.

## Explicit initialization and recovery

`/skill-optimizer init` uses the selected Pi model to generate profile metadata.
The initial groups contain at most 20 skills and 32 KiB of serialized skill-input
JSON. Complete descriptions are preserved, including a single oversized skill.
Each group gets up to two attempts; content-validation failures supply bounded
feedback on retry and can then divide into smaller groups. All subdivisions share
at most eight additional calls per original group. Provider failures do not cause
division, and terminal errors or cancellation stop the run.

Only a fully validated group is checkpointed. Missing or invalid coverage, owners,
summaries or tags reject the whole response rather than saving a partial card set.
A partial profile can already use catalog mode: accepted cards retain their tags,
while every missing or stale owner remains browsable under `unclassified`.
Known unchanged source identities and v5 routing fields survive failed schema
migration attempts. Missing or stale cards still mark those owners incomplete
and eligible for retry. New or changed sources do not advance their hashes until
accepted, and source changes invalidate their stale hints. An explicit rerun
repairs the remaining owners.
Validation establishes schema and source ownership, not semantic relevance.

The model request streams through Pi's configured model registry. An independent
widget above the editor shows committed progress and catalog coverage, current
batch/attempt, elapsed time, and activity counters. Streamed text and thinking are
never displayed; activity does not advance the saved percentage. A one-second
heartbeat keeps a silent request visible without redrawing on every chunk.
`/skill-optimizer cancel` retains completed checkpoints. Operation cancellation,
session replacement and shutdown guard against late writes or stale UI updates;
session teardown also clears the widget and its timer. See the
[initialization reference](CONFIGURATION.md#routing-profile-initialization).

## Request-specific prefetch

AUTO extracts intent only from genuine human text in Anthropic, OpenAI Chat and Responses, Gemini, Mistral, and Pi's structured `pi-messages` request shapes. A catalog may live in a system or developer block, but neither is treated as human intent. Assistant text, tool or function results, injected context, image metadata, and empty input cannot create a ranking signal.

At runtime, catalog optimization and usage extraction run in Pi's `context_with_system` hook,
before provider conversion erases custom-message provenance. Native `custom`, `bashExecution`,
`branchSummary`, `compactionSummary` and `toolResult` messages remain intact and cannot become
the query or overlay target. Structured system sections and tool declarations are preserved;
request-local clones do not modify persisted conversation entries.

Pi 1.2+ distinguishes user starts in `before_agent_start` (`messageType: "user"` with `prompt`)
from custom-triggered starts (`messageType: "custom"` with `message`). Only a user prompt updates the
last human request and drives tool activation. A custom start has no routing signal, so optimizer
activation fails open across permitted named tools while retaining protected, used, and searched
tools; custom message text is ignored even if the event also carries a `prompt` property. The
previous human request remains available to output extraction. On Pi 1.0, the supported event has no
`messageType` discriminator, so its string `prompt` continues to identify user intent.

In the compatible no-card path, ranking uses exact matching, BM25F, bounded name and alias typo recovery, reciprocal-rank fusion, diversity, profile evidence, and decayed usage evidence. It scores full source descriptions, then appends a bounded set of verbatim skill names and descriptions (not the full `SKILL.md` instructions) to the latest human block. That legacy overlay is separate from the stable prefix, fingerprinted, idempotent, and omitted when there is no valid target. Current catalog mode has no automatic lexical overlay.

The resolver labels prefetch as discovery metadata, not loaded instructions or usage evidence.
Diagnostics count only overlays actually inserted. Usage follows explicit human mentions and skill
activations; the `skill_search` executor records its own loads/resources, so transcript scanning
does not count those calls twice. Catalog selections and assistant acknowledgments are not usage.

In the compatible no-card path, optional init-generated activation tags distinguish specialists, workflow methods
and behavioral discipline. An admitted specialist can bring one activity-matched
supporting skill into the ordinary prefetch budget; this does not recursively
expand dependencies or treat a behavioral tag as universal. See
[contextual routing](RANKING.md#contextual-and-behavioral-skills).
These legacy activation hints do not auto-select skills in semantic catalog mode.

## Dynamic tools

AUTO keeps protected and predicted tools active and leaves the rest behind `optimizer_tool_search`. Search is bounded and paginated. A returned result is activated through Pi's runtime API without replacing already active tools. Core, configured, and previously used tools remain callable, so an in-progress tool loop cannot be stranded. Pi's built-in `tool_search` remains active when the host enables it. Weak or absent routing signal fails open to every permitted tool; safety wins, but that request may retain the full schema cost.

Selection is recalculated before each agent run, not just the first request. Used tools and explicit search results stay active within the current discovery baseline. The optimizer records its own applied selection; an external removal starts a new baseline instead of silently restoring old tools, while additive host activations are retained. This lets pi-persona narrow a session without optimizer helpers reappearing. An identical set is not an observable change; call-time permissions remain the authority.

Inactive `deferred` and `codemode` tools remain discoverable while the optimizer's tool resolver is permitted; inactive direct and hidden tools are not silently added. `optimizer_tool_search` declares its transitive tool reach to Pi 1.3. This is schema routing, not authorization: another extension's call-time permission checks remain authoritative.

See Pi's [extension and dynamic-tool API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

## Recoverable output

The default `smart` reducer is deterministic and UTF-8 byte-aware. It preserves protected evidence and accepts a reduction only when the complete returned representation clears both configured saving thresholds. Size and line settings trigger reduction; they are not hard output caps. Protected evidence may make the returned result exceed them.

Homogeneous JSON object arrays may use a lossless columnar form after an exact internal round trip. With `outputMode: "extract"` and an explicit `outputModel`, sufficiently large text may first use model-assisted extraction. Extracted content must be an ordered verbatim subsequence, retain protected evidence, and provide material savings. Rejection falls back to smart reduction, then to the original.

Before AUTO returns any reduced result, it stores the complete original in a local, immutable, content-addressed archive. Provider-visible recovery text contains only an opaque identifier. `retrieve_output` verifies and resolves that identifier with bounded line access.

Savings include the recovery label and are checked before an archive write. The optimizer's own resolver results are exempt from reduction, avoiding a second handle in place of the original you just requested. Custom-tool failures throw through Pi's error path instead of returning a success-shaped error object.

Nested `tool_result` events identified by Pi's `parentToolCallId` are also exempt.
Their content can be parsed by a codemode caller before it reaches the model;
changing JSON shape or appending a recovery footer would break that caller.
They contribute no output-reduction savings.

Columnar conversion conservatively leaves unsafe integers, non-finite numbers,
negative zero and noncanonical numeric spellings untouched. Parsing twice is not
a losslessness oracle when both parses can round the same value. Invalid Unicode
strings also fail open. Exact recovery retains the source's original line endings;
it does not normalize Windows output to LF.

History deduplication keeps the first large successful result intact and replaces only later exact copies. Errors, images, mixed media, small results, and protected evidence are never deduplicated.

History admits at most 128 distinct recovery artifacts per session. Existing
handles remain valid; once capacity is reached, new duplicate payloads stay
unchanged instead of producing references that would immediately be evicted.

## Scale and limits

AUTO reduces metadata in the tested catalogs, but does not guarantee model discovery.

- The compatible no-card path keeps every eligible skill name in its stable TSV index; that base grows linearly with names and their rendered intent. Current semantic catalog mode deliberately replaces the per-skill name list with a fixed-size directory and paginated local browsing, so name-level visibility depends on the model choosing to use the resolver.
- Synthetic transport tests exercise up to 10,000 cards, but do not qualify model discovery quality, provider cost, or extreme-catalog latency. A 100,000-skill catalog remains outside the demonstrated runtime scale.
- Catalog mode is not server-side search: it prepares and filters the registered local catalog. Larger catalogs may need a separately designed sharded or remote index, with its own privacy and relevance qualification.
- Arbitrarily large system prompts are not automatically reduced. AUTO transforms recognized skill catalogs, manages tool definitions, and processes eligible tool results; it does not summarize unrelated policy, instructions, or conversation content.
- Provider tokenization, caching, and pricing remain provider-controlled. Stable bytes improve cacheability but do not prove a cache hit or guarantee a specific bill.
- Very small catalogs or outputs may remain unchanged when framing overhead would eliminate the saving.
