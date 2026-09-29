@C:\Users\novad\.codex\RTK.md

# AGENTS.md

Pi extension that reduces repeated request tokens through one AUTO discovery contract, dynamic tool activation, and recoverable tool-output reduction. TypeScript is loaded by Pi through jiti without a build step.

Runtime floor: Pi 0.87.1 and Node.js 26.3. Use current Pi APIs; do not add shims for older runtimes. Reading existing user profiles is a data-preservation requirement, not a promise of support for old Pi versions.

## Package distribution

- npm identity: `@aeondave/pi-skill-optimizer`. The command and configuration directory remain `skill-optimizer`; do not rename persisted user data with the package.
- Pi supplies `@earendil-works/pi-*` and `typebox`. Imported host packages belong in wildcard optional `peerDependencies`, never runtime `dependencies`; development copies are only for tests/typechecking. Wildcards follow Pi's loader contract, not a promise of support below the documented runtime floor.
- Preserve `pi-package`, the explicit `pi.extensions` entry and a public, versioned `pi.image` banner URL. Only add `pi.video` when a real optimizer demonstration exists, with a working media content type.
- Keep the npm file allowlist narrow: runtime source (including `src/prompts/init-profile.md`), the three reference docs, selected banner and public root docs. Never ship private corpora, drafts, banner alternatives or local configuration.
- Before publication, inspect `npm pack --dry-run` and verify the packed extension with Pi's real loader outside the checkout, without package-local host dependencies. Use an isolated `PI_CODING_AGENT_DIR`; `PI_AGENT_DIR` alone does not relocate Pi's install root. Confirm registry version, integrity and gitHead after publishing; gallery eligibility is not proof that its crawler has indexed the package.
- Set `PI_SKILL_OPTIMIZER_TEST_PACKAGE` to the absolute unpacked/installed package root and run `node --import tsx --test test/host-runtime.test.ts` to exercise the artifact with the same offline status/audit/search/verbatim-load checks as the source. This variable is test-only; do not set it for ordinary suite runs.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run bench
npm run bench:ranking
npm run bench:perf
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
- `src/profile.ts` - normalization and scope handling for `critical`, `queries`, `clusters`, `negativeHints`, and optional `activation` tags.
- `src/activation.ts` - typed activity tags for specialist/workflow/behavioral support; no hardcoded skill identities or runtime model calls.
- `src/generate.ts` - UTF-8-weighted init batching, complete validation, and incomplete-batch retry.
- `src/init-readiness.ts` - pure setup-state classification from scoped profile metadata and catalog hashes; manual profiles remain supported.
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

- AUTO is the only public discovery strategy. The only global bypass is boolean `PI_SKILL_OPTIMIZER_DISABLE`; there is no `disable` config key.
- The base is query-independent `<skill_index format="tsv" columns="name,intent">` with marker `<!--skill-optimizer:auto:v2-->`.
- The base contains no path. Every eligible name survives; intent yields first at the all-name floor.
- The base remains byte-identical when catalog, profile, and configuration are unchanged.
- Score full source text. Limit only rendered base, overlay, or search responses.
- Exact names and profile phrases match whole normalized token sequences, never character substrings (`git` is not an exact match for `digital`). Cache catalog-derived features, not mutable caller objects or query-specific scores.
- Prefetch is separate from the base and appends full verbatim text only to the latest genuine human block.
- Never derive intent from tool or function results, assistant text, injected context, or image metadata.
- Overlay insertion is idempotent, minimally clones the modified provider branch, and preserves identity without a target.
- Empty input must not manufacture a ranking signal.
- `skill_search` cursors bind to query, catalog fingerprint, and ranked name order; rank-changing usage/profile updates invalidate pagination.
- Exact load accepts only a registered name. Resource and location actions stay inside the canonical skill root.
- The profile is `critical`, `queries`, `clusters`, `negativeHints`, plus optional name-owned `activation` metadata. Empty activation is omitted for legacy compatibility; init version 5 regenerates tags only on explicit init.
- `critical` is universal discipline; `behavioral` alone is not always-on. Only a selected, positively matched specialist can seed at most one activity-matched support slot, inside ordinary count/character budgets. No recursion, no excluded or negative-hint matches, no displacement of an explicit exact choice.
- `clusters` are substitutes, not complements. Contextual candidates expose their reason and do not invent lexical scores. Generated tags are hints, not independently verified relevance labels.
- Init hints are optional, UI-only and never trigger provider calls. Classify from actual profile metadata/catalog ownership, not activation-tag counts. Persist only dedupe metadata in session entries, keyed by profile scope/state/init version; keep readiness visible in the status command and avoid file reads in provider/tool hot hooks.

## Dynamic tool invariants

- Keep core, configured, already used, and bounded predicted tools active.
- Keep `tool_search` active while searchable definitions remain.
- Search is paginated and activates bounded results through Pi's runtime API.
- Never strand an in-progress provider tool loop by deactivating a used tool.
- Bound schema indexing work so recursive or large schemas cannot dominate processing.
- Empty or unrelated input preserves protected tools.
- Replan at each `before_agent_start`, not every provider/tool event. Retain used and explicitly searched tools; the frozen initial active set is the discovery baseline, not a replacement for host authorization.
- Refresh config at session/agent start and explicit commands; hot hooks reuse it without reloading profile/usage or losing pending deltas. The environment bypass stays immediate.
- Custom tool failures must throw: Pi does not treat an `isError` field returned by `execute` as a failed tool call.

## Output and history invariants

- Reducers fail open and use real UTF-8 bytes.
- Never return reduced output unless the complete archive was written.
- Recovery text contains an opaque content identifier, never an archive path.
- `retrieve_output` verifies content identity and supports bounded lines.
- Preserve source LF/CRLF/CR terminators in recovered pages; beyond EOF returns empty. Resolver results must not be reduced again.
- Reject malformed UTF-16 before hashing/archiving/deduplicating; UTF-8 encoding can collapse different lone surrogates to identical replacement bytes.
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
- Archive expiry is per-content metadata under the archive lock; readers/cleaners cannot impose their own shorter TTL. Re-saves only extend expiry; missing legacy metadata uses seven days, while malformed metadata fails closed without deletion.
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
- Loader location assertions use canonical paths (`realpathSync.native`), not lexical `resolve`: macOS temporary paths may alias `/private/var`, and Windows temporary paths may use short names. Keep positive directory-alias and negative symlink-escape coverage.
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
