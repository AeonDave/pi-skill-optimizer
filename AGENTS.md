@C:\Users\novad\.codex\RTK.md

# AGENTS.md

Pi extension that reduces repeated request tokens through one AUTO discovery contract, dynamic tool activation, and recoverable tool-output reduction. TypeScript is loaded by Pi through jiti without a build step.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run bench
npm run bench:output
npm run corpus:build
npm run bench:real
npm run measure <capture.json>
pi -e ./src/index.ts
```

Remote corpus and provider runs are explicit and never part of `npm test`.

## Architecture

- `src/request.ts` - provider-neutral human-text extraction, tool-use history, and minimal-clone overlay insertion for Anthropic, OpenAI Chat and Responses, Gemini, and Mistral.
- `src/skills.ts` - stable TSV index, BM25F and exact ranking, bounded fuzzy recovery, reciprocal-rank fusion, diversity, budgets, and fingerprints.
- `src/skill-loader.ts` - exact skill, resource, and location resolution with canonical-path containment.
- `src/tools.ts` - dynamic tool catalog, schema-aware ranking, protected activation, and paginated search.
- `src/optimize.ts` - stable-base and latest-human overlay orchestration with identity preservation.
- `src/profile.ts` - normalization and scope handling for `critical`, `queries`, `clusters`, and `negativeHints`.
- `src/generate.ts` - UTF-8-weighted init batching, complete validation, and incomplete-batch retry.
- `src/usage.ts` - bounded, decayed, deduplicated usage evidence.
- `src/history.ts` - monotonic exact deduplication with opaque recovery artifacts.
- `src/output.ts` - UTF-8-safe smart reduction, guarded verbatim extraction, lossless columnar JSON, protected evidence, and per-result RTK ownership.
- `src/stats.ts` - savings and authoritative provider telemetry v3.
- `src/persistence.ts` - atomic replacement, lock-serialized additive deltas, and content-addressed output archives.
- `src/corpus.ts` - HMAC identifiers, irreversible sanitization, private corpus schema, and evidence labels.
- `src/evaluation.ts` - paired discovery, tool, output, cache, token, cost, and safety metrics.
- `src/config.ts` - AUTO defaults, project/global normalization, provider scope, and boolean bypass.
- `src/index.ts` - Pi hooks, state, activation, `skill_search`, `tool_search`, `retrieve_output`, diagnostics, and commands.
- `scripts/bench.ts` - deterministic AUTO invariants.
- `scripts/output-bench.ts` - output, evidence, archive, columnar, and RTK benchmark.
- `scripts/build-real-corpus.ts` and `scripts/evaluate-real-corpus.ts` - explicit private real-provider workflow.
- `scripts/measure.ts` - serialized-size measurement.

## AUTO invariants

- AUTO is the only public discovery strategy. The only global bypass is `disable` or `PI_SKILL_OPTIMIZER_DISABLE`.
- The base is query-independent `<skill_index format="tsv" columns="name,intent">` with marker `<!--skill-optimizer:auto:v2-->`.
- The base contains no path. Every eligible name survives; intent yields first at the all-name floor.
- The base remains byte-identical when catalog, profile, and configuration are unchanged.
- Score full source text. Limit only rendered base, overlay, or search responses.
- Prefetch is separate from the base and appends full verbatim text only to the latest genuine human block.
- Never derive intent from tool or function results, assistant text, injected context, or image metadata.
- Overlay insertion is idempotent, minimally clones the modified provider branch, and preserves identity without a target.
- Empty input must not manufacture a ranking signal.
- `skill_search` cursors bind to query and catalog fingerprint.
- Exact load accepts only a registered name. Resource and location actions stay inside the canonical skill root.
- The generated profile is exactly `critical`, `queries`, `clusters`, and `negativeHints`.

## Dynamic tool invariants

- Keep core, configured, already used, and bounded predicted tools active.
- Keep `tool_search` active while searchable definitions remain.
- Search is paginated and activates bounded results through Pi's runtime API.
- Never strand an in-progress provider tool loop by deactivating a used tool.
- Bound schema indexing work so recursive or large schemas cannot dominate processing.
- Empty or unrelated input preserves protected tools.

## Output and history invariants

- Reducers fail open and use real UTF-8 bytes.
- Never return reduced output unless the complete archive was written.
- Recovery text contains an opaque content identifier, never an archive path.
- `retrieve_output` verifies content identity and supports bounded lines.
- Preserve protected evidence in every path.
- Extraction accepts only an ordered verbatim subsequence with material savings; rejection falls back through smart processing to the original.
- Columnar JSON requires homogeneous rows, exact round trip, and a smaller complete representation.
- RTK ownership is per result. Skip only shell output RTK already handled; read, web, MCP, and other eligible results remain available.
- History keeps the first large successful result and changes only later exact copies with recoverable artifacts.
- Never deduplicate errors, protected evidence, images, mixed media, or small results.
- A second pass cannot be larger or more destructive.

## Persistence and telemetry invariants

- Persistent updates use atomic replacement.
- Shared usage and statistics use a process lock and additive read-modify-write deltas.
- Archives are immutable, content-addressed, SHA-256 verified, and TTL-cleaned.
- Telemetry v3 is `requests`, `input`, `output`, `cacheRead`, `cacheWrite`, and `totalCost`.
- Cache reads and writes come only from provider usage. Stable bytes do not prove a cache hit.
- Keep characters and bytes separate from provider tokens and cost.
- Usage evidence is bounded and decays; pruning protects current explicit evidence and configured skills.

## Privacy invariants

- Normal hooks never collect a benchmark corpus.
- Corpus creation and remote evaluation require explicit commands.
- Never send an unsanitized session or catalog remotely.
- Use keyed irreversible identifiers and remove secrets, identities, hostnames, and absolute paths.
- Generated profile queries are not labels.
- Never commit `.pi/skill-optimizer/benchmark/`.

## Testing

- Request changes require Anthropic, OpenAI Chat and Responses, Gemini, and Mistral human/tool-result cases.
- Ranking, base, overlay, loader, or dynamic-tool changes require focused tests and `npm run bench`.
- Output or history changes require focused tests and `npm run bench:output`.
- Other pure modules require their corresponding suites.
- Hook or config changes require `npm run typecheck`, then `pi -e ./src/index.ts` with status, audit, and search/load smoke paths.
- Run focused tests after edits, then all local gates before a completion claim.
- Never invoke `corpus:build` or `bench:real` implicitly.

## References

- [Pi skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)
- [Pi extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
- [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [OpenAI Codex skills](https://developers.openai.com/codex/skills)
