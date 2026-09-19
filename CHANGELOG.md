# Changelog

All notable changes are documented here.

## Unreleased

## 2.1.0 - 2026-09-20

### Added

- A deterministic `bench:perf` harness reports cold and steady request-transform latency at 284 and 2,000 synthetic skills.

### Changed

- Development validation now targets Pi `0.85.1`, TypeBox `1.3.34`, and the current Node 22 type line while retaining the compatible Pi `>=0.84.4` peer floor.
- Stable catalog preparation and rendering use bounded LRU caches, avoiding repeated parsing and rendering across provider requests and cache-warm refreshes.
- Init batch progress is transient status; only start, terminal batch failures, and completion create durable notifications.

### Fixed

- `/skill-optimizer init` reports progress, checkpoints successful batches immediately, and avoids the redundant final profile rewrite and its stale-CAS race.
- Init respects terminal versus retryable model failures, rejects non-success stop reasons, leaves failed changed skills inactive instead of serving stale routing, and repairs misplaced global/project profile state without another model call.
- OpenAI/Azure Responses developer catalogs in `input` and structured `pi-messages` skill sections now receive the same AUTO transformation and latest-human prefetch contract.
- Synthetic pi-persona identity and clock turns cannot become routing intent or receive a prefetch overlay.
- Repeated identical status text no longer asks Pi to redraw the footer.

## 2.0.0 - 2026-09-01

### Added

- One AUTO discovery pipeline with a stable TSV `name,intent` base and request-specific full-text overlay.
- `skill_search` for paginated search, exact load, contained resources, and validated locations.
- Paginated `tool_search` with Pi runtime activation and bounded proactive selection.
- `retrieve_output` for bounded recovery of locally archived full results.
- Content-addressed SHA-256 archives with opaque identifiers and TTL cleanup.
- Monotonic history deduplication for later exact copies of large successful results.
- Lossless columnar JSON guarded by exact internal round trip and never-larger acceptance.
- Persistent provider telemetry v3 for requests, input, output, cache reads, cache writes, and total cost.
- Catalog/profile static audit through `/skill-optimizer audit`.

### Changed

- AUTO is the sole public discovery contract. Former `off`, `compact`, `hybrid`, `drop`, and `relevance` choices are removed history.
- The stable skill base is query-independent, path-free, byte-stable, and protected by an all-name floor.
- Ranking combines BM25F, exact and bounded fuzzy signals, reciprocal-rank fusion, usage decay, and diversity.
- Prefetch is a bounded latest-human overlay rather than a stable-prefix mutation.
- Tool definitions activate on demand rather than being permanently sent or heuristically removed per request.
- Request normalization shares a human-content allowlist across Anthropic, OpenAI Chat and Responses, Gemini, and Mistral.
- Generated profiles contain only `critical`, `queries`, `clusters`, and `negativeHints`.
- `init` batches by full UTF-8 weight and count, validates coverage and stop reason, and retries incomplete batches without truncation.
- RTK coexistence is per result; only shell output RTK already handled steps aside.
- Output limits use UTF-8 bytes and guarded extraction falls back through smart processing to the original.
- Statistics and usage use lock-serialized additive deltas and atomic replacement.
- Cache counters come only from provider usage; stable-prefix measurements no longer imply hits.
- Benchmark results are reserved for a reproducible AUTO run.

### Fixed

- Tool and function results, assistant content, injected context, and image metadata cannot become routing queries.
- Provider tool-use history is normalized before protection decisions.
- Repeated overlay markers and requests without genuine human text preserve identity.
- Exact skill and resource loading rejects unknown names, traversal, and symlink escape.
- Recovery text no longer exposes archive paths, and recovery verifies archive identity.
- Incomplete generation batches are not marked processed.
- Concurrent profile, usage, and statistics writes cannot replace newer deltas with stale snapshots.
- Columnar JSON preserves schema order, row order, nested values, Unicode, and protected evidence.

### Privacy

- Real-corpus construction remains explicit and private.
- Identifiers are keyed and irreversible; sanitization rejects paths, credentials, and user-specific data.
- Full archives remain local and expire under `outputArchiveTtlHours`.

## Historical releases

Tags before AUTO contain the original experiments. Their strategies, configuration, and measurements do not describe the current contract; consult a tag only when maintaining an older installation.
