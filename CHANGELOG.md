# Changelog

All notable changes are documented here.

## 3.1.3 - 2026-10-20

### Added

- Add explicit init v6 semantic skill cards from a shared 38-tag vocabulary, including `discipline` for execution habits and `other` for unsupported topics that need inspection. When current catalog metadata exists, the prompt uses a bounded tag directory and lets the main model choose whether to browse paginated cards; tag filters define the bucket and an optional text query only orders within it. Exact loading remains explicit. Existing profiles stay on the compatible name/intent index and lexical prefetch path until the user runs init.

### Fixed

- Preserve nested codemode tool results byte-for-byte instead of replacing programmatic JSON with reduced text; do not count those results as output savings.
- Honor external tool-set changes, including pi-persona restrictions, rather than restoring old tools or optimizer helpers. Declare the tool resolver's transitive reach for Pi 1.3.
- Keep all emitted history recovery handles resolvable within the 128-artifact session bound; leave new duplicate payloads unchanged when full.
- Preserve prototype-colliding skill names such as `constructor`, `toString` and `__proto__` through profile ranking, hashes and usage records.
- Measure init batches from the exact serialized skill JSON, including escaping and framing.
- Recover invalid init responses with precise validation feedback, initial batches of at most 20 full skill descriptions, and bounded subdivision after retries fail. Keep strict card validation and checkpoint each valid group. Stop all batches on cancellation or terminal quota errors, and label partial completion as `init incomplete` with an explicit retry command.
- Keep init visible with a live panel above the editor, including with themes that hide the footer. Show committed percentage, catalog coverage, batch/attempt, model, elapsed time and streamed activity. Add `/skill-optimizer cancel`, prevent overlapping session jobs, and stop timers/provider work on session teardown without late saves.
- Preserve still-valid profile hints across repeated failed catalog migrations; known unchanged source identities remain retryable until their semantic cards are complete.
- Publish complete lock owner records atomically. Remove unsafe automatic stale-lock deletion; timeouts now explain manual recovery after confirming no writer is active.

### Changed

- Align development host dependencies and integration checks with Pi 1.3.0 while retaining the Pi 1.0.0 runtime floor.
- Let packed-artifact smoke checks target an explicit Pi version; default to the development host version.

## 3.1.2 - 2026-10-13

### Fixed

- Handle Pi 1.2 custom-triggered runs as no-intent starts: fail open for permitted tools, ignore custom message text even if a stray prompt field is present, and preserve the previous human request for output extraction.

## 3.1.1 - 2026-10-08

### Fixed

- Optimize the native Pi transcript before provider conversion, keeping worker notifications, shell
  output and summaries out of human-intent routing and prefetch insertion.
- Preserve structured system sections and tool declarations; respect provider scoping when the
  request has no selected model.
- Label prefetch as catalog metadata, not loaded instructions or usage evidence. Emit its actual
  catalog fingerprint and report selected skills only when an overlay was inserted.
- Recognize native Pi skill-activation calls without double-counting `skill_search` usage.

## 3.1.0 - 2026-10-03

### Breaking

- Rename the optimizer's model-callable `tool_search` to `optimizer_tool_search`. Explicit tool calls must use the new name. Pi's built-in `tool_search` now loads alongside the optimizer without a replacement warning.

### Fixed

- Preserve an active built-in `tool_search` during optimizer replanning.
- Retain tools activated later by Pi or another extension, and honor `alwaysTools` for initially inactive `deferred` or `codemode` tools while respecting hidden and inactive direct tools.
- Capture an explicitly requested benchmark catalog from Pi 1.0's `before_agent_start` skill options.

### Changed

- Require Pi 1.0.0 or newer for this release.
- Run typechecking and host integration tests against Pi 1.0.0 development packages.
- Add a reproducible Pi CLI black-box smoke test for the packed artifact.

## 3.0.1 - 2026-09-30

### Fixed

- Keep Pi 0.99's initially inactive `deferred` and `codemode` tools discoverable through the optimizer's `tool_search`. Activate only matching search results, retain them across later replanning, and leave initially unavailable direct or hidden tools outside the catalog.
- Reject blank tool searches without activating fallback results. Document how to disable Pi's replaceable built-in `tool-search` at the same scope as the optimizer, avoiding its startup conflict warning.

## 3.0.0 - 2026-09-28

### Scoped distribution - 2026-09-29

- Move npm distribution to `@aeondave/pi-skill-optimizer`, replacing the old unscoped name at the same runtime version, with public access, the `pi-package` discovery keyword and a versioned banner URL for the Pi gallery. The existing Git tag and release history are unchanged.
- Declare Pi host packages and TypeBox as wildcard, optional peers; keep development copies for tests, but ship no duplicate host dependencies. The supported runtime floor remains Pi 0.87.1 / Node.js 26.3.
- Document scoped installation and migration without loading two copies. Explicitly allowlist published reference docs and cover gallery/host metadata with release tests.

### Breaking

- Require Pi 0.87.1+ and Node.js 26.3+; development dependencies, host integration tests and CI target the current APIs. Node 22/24 and older Pi releases are no longer supported. Existing profile files remain readable so users can explicitly refresh routing hints without losing their configuration.

### Added

- Init-generated activity tags distinguish specialists, workflow methods and behavioral discipline. A positively selected specialist can bring one contextual support skill into the ordinary budget even without literal keyword overlap. Tags do not make behavioral skills always-on; old profiles remain compatible and upgrade on explicit init.
- Versioned init prompt and a real Pi loader/runner smoke test that runs without provider requests.
- A brief, UI-only optional-init hint and explicit setup readiness in status. Session metadata prevents repeated hints across turns and reload/resume; manual profiles are respected and init never starts automatically.

### Fixed

- Replan tool activation on each agent run, retain used and explicitly searched tools, and restore optimizer-deferred tools on bypass without activating initially unavailable tools.
- Refresh configuration between agent runs without repeated synchronous reads in provider/tool hooks. Skill search now respects exclusions and configured fuzzy/usage settings.
- Route custom-tool errors through Pi's exception contract and keep resolver results verbatim, preventing recursive reduction of recovered output or full skill instructions.
- Exact skill/profile phrase matches respect token boundaries; `git` no longer matches inside `digital`. Skill search cursors reject ranking-order changes caused by new profile or usage evidence.
- Output recovery preserves LF, CRLF, CR and mixed terminators, and returns an empty page beyond EOF. Malformed Unicode cannot create lossy archive or ambiguous history handles.
- Columnar JSON fails open on unsafe or noncanonical numeric spellings instead of silently rounding them; zero-column decoding has a bounded expansion.
- Archive retention belongs to each stored output, not the project that happens to read or clean it. Identical-content saves can extend, never shorten, the lease; legacy files use a fixed seven-day fallback.
- Stale lock timestamps no longer let another writer steal a live process's lock; recovery also verifies that the owner has exited.

### Improved

- Check complete rendered savings before writing an output archive.
- Cache catalog-derived ranking features and calculate query-wide values once, without changing the BM25F weights or score formula.
- Add a local ranking-component diagnostic and warm-latency percentiles; keep synthetic measurements separate from historical model-quality claims.
- Put installation and everyday use first in the README, split out configuration/architecture/ranking references, and add the selected library banner.
- Add Windows/Linux/macOS CI for Node 26.3 and current 26.x, portable path/newline regressions, package-link validation and consistent source line endings.

## 2.1.1 - 2026-09-20

### Fixed

- `/skill-optimizer init` preserves the provider failure in terminal diagnostics, reports retries only when another attempt will run, and treats exhausted quota or billing limits as terminal instead of submitting the same batch again.

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
