# Changelog

All notable changes are documented here.

## Unreleased

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
