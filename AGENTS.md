# AGENTS.md

Pi extension that reduces repeated request tokens by compacting the
`<available_skills>` catalog, optionally slimming the tools array, and reducing
long tool output. TypeScript, loaded by Pi through jiti without a build step.

## Commands

```bash
npm install
npm run typecheck                 # tsc --noEmit against real Pi types
npm test                          # node --test on pure modules
npm run bench                     # deterministic invariants and fuzz benchmark
npm run bench:output              # output safety and evidence benchmark
npm run corpus:build              # private real catalog/session corpus (uses Luna)
npm run bench:real                # paired real-model and RTK evaluation
npm run measure <capture.json>    # exact chars and estimated token equivalent
pi -e ./src/index.ts              # live-load for manual testing
```

## Architecture

- `src/request.ts` - pure normalization of canonical Anthropic, OpenAI,
  Gemini, and Mistral request shapes; shared text/query extraction and tool-use
  history.
- `src/skills.ts` - pure catalog parser, BM25 plus conservative name/alias fuzzy
  recall, soft-budget selection, compact rendering, loadability notes, and
  idempotent text transformation.
- `src/tools.ts` - pure tools-array optimization with core, configured, and
  already-used tool protection.
- `src/optimize.ts` - pure orchestration over normalized system surfaces and tool
  descriptions; returns `{ next, removedChars, selected, droppedTools }`.
- `src/aliases.ts` - built-in and profile-generated aliases filtered against the
  active catalog.
- `src/profile.ts` - profile normalization, scope splitting, and incremental hash
  bookkeeping.
- `src/generate.ts` - pure parsing and validation of batched `init` responses.
- `src/usage.ts` - conservative, deduplicated evidence for usage-derived pins.
- `src/output.ts` - UTF-8 byte-safe deterministic reduction and guarded
  model-assisted verbatim extraction with protected evidence.
- `src/stats.ts` - savings counters and mergeable persistent deltas.
- `src/persistence.ts` - atomic JSON replacement and lock-serialized
  read-modify-write helpers for concurrent project and global state.
- `src/corpus.ts` - pure HMAC identifiers, irreversible redaction, private corpus
  schema, validation, rendering, and exact evidence recall.
- `src/evaluation.ts` - pure paired exposure, recall, byte/token, cache-stability,
  and hard-safety metrics for real corpus cases.
- `src/config.ts` - defaults, file/env normalization, disable handling, and
  provider scoping.
- `src/index.ts` - Pi hook registration, state I/O, RTK coexistence, footer, and
  `/skill-optimizer` commands.
- `scripts/measure.ts` - captured-request serialized-size measurement.
- `scripts/bench.ts` - deterministic synthetic benchmark and blocking invariants.
- `scripts/output-bench.ts` - deterministic output-safety and evidence benchmark.
- `scripts/build-real-corpus.ts` - explicit one-shot real catalog/session capture.
- `scripts/evaluate-real-corpus.ts` - Luna token/recall and RTK output comparison.
- `scripts/lib/luna.ts` - isolated Luna CLI runner and authoritative usage parser.

## Key invariants

- **Score full text, compact only while rendering.** Never rank an already
  compacted description.
- **Public catalog modes are `off`, `compact`, and `hybrid`.** Except for an
  explicit `never` exclusion, every name survives in `compact` and `hybrid`.
- **Every retained skill remains loadable.** Promoted and irregular entries keep
  explicit locations; regular tail entries may use one shared
  `<skill_path_note>` containing roots and the `<root>/<name>/SKILL.md`
  convention.
- **Optimization is idempotent.** Return an already transformed catalog
  unchanged because removed text cannot be reconstructed.
- **No-signal requests preserve intent.** `hybrid` uses a short `intent` tail
  when query extraction or lexical scoring has no usable signal.
- **Quality wins over nominal savings.** Keep critical and pinned skills full and
  expand top-K when close scores are ambiguous. A soft full-render budget applies
  only to ordinary selections; protected and ambiguity-guard entries may exceed
  it.
- **Fuzzy recall is bounded.** Apply typo recovery only to skill names and aliases,
  only when lexical coverage is weak, and never turn a no-signal request into a
  false promotion.
- **Descriptions are not rewritten.** Surviving text remains verbatim and in its
  original order.
- **Usage evidence is conservative.** Record only explicit skill mentions or
  observed skill-tool calls, deduplicated across provider tool loops. Pruning may
  remove only stale one-off entries and must protect critical/current pins.
- **Catalogs may occur in system content or tool descriptions.** Normalize and
  scan both.
- **Tools have no fallback after removal.** Tools slimming is off by default,
  never removes core/protected/already-used tools, and relevance mode fails open
  without lexical signal. Schema indexing must stay bounded. Prefer deterministic
  prefix `drop` mode.
- **Output reducers fail open.** Use real UTF-8 bytes, retain protected evidence,
  accept model output only as an ordered verbatim subsequence, require material
  savings, and fall back `extract -> smart -> original`. Never return a reduced
  result when the full-output archive failed.
- **Benchmark data stays private by default.** Never collect in the normal hook,
  never send unsanitized sessions remotely, never use generated profile queries
  as labels, and never commit `.pi/skill-optimizer/benchmark/`.
- **Identity return matters.** Return the original reference, and the hook must
  return `undefined`, when nothing changed. Honor
  `PI_SKILL_OPTIMIZER_DISABLE` using boolean semantics.
- **Persistent updates must not lose deltas.** Write JSON through atomic
  replacement and serialize read-modify-write operations with the persistence
  lock; never overwrite usage or statistics from a stale in-memory snapshot.

## Compatibility

This extension is provider-agnostic and separate from `pi-claude`. It edits only
the configured catalog, tag/paragraph surfaces, tools array, and tool results;
it does not alter billing or identity blocks.

RTK is the recommended companion for effective command-output reduction, not a
runtime prerequisite. When an RTK-style extension is detected, only this
extension's overlapping output reducer steps aside. Catalog and tools-array
safety must not change when RTK is absent.

`compact` must remain query-independent for provider-cache stability. Do not
claim cache hit metrics unless Pi exposes authoritative provider cache data.

## Testing

- Changes to request normalization require `test/request.test.ts` coverage for
  Anthropic, OpenAI Responses/messages, and Gemini forms.
- Changes to `skills.ts`, `tools.ts`, or `optimize.ts` require focused unit tests
  plus `npm run bench` for discovery, loadability, no-signal, determinism, and
  idempotence invariants.
- Profile, usage, generation, output, stats, persistence, and config changes
  require tests in their corresponding pure-module suites.
- Hook/config changes require `npm run typecheck`, then a live Pi check with
  `pi -e ./src/index.ts` and `/skill-optimizer`.
- Output changes require `test/output.test.ts` and `npm run bench:output`.
- Corpus/evaluation changes require their pure-module tests. Remote Luna calls
  are opt-in through `corpus:build` and `bench:real`, never part of `npm test`.
