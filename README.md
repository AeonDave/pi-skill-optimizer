# pi-skill-optimizer

A [Pi](https://github.com/earendil-works/pi-mono) extension that reduces repeated
request tokens while preserving skill discovery and loadability.

## What it optimizes

Pi sends the skill catalog and tool definitions on every provider request. Large
catalogs and MCP tool sets can therefore dominate input size. This extension has
three independent optimization layers:

| Layer | Default | Behavior |
|---|---|---|
| Skills catalog | `hybrid` | Ranks skills against the request, keeps relevant skills full, and compacts the remaining catalog. |
| Tools array | `off` | Optionally removes tools by explicit prefix or lexical relevance. |
| Tool output | `smart` | Reduces long output while retaining diagnostic context and a reference to the saved original. |

### Skills catalog modes

- `off` leaves the catalog unchanged.
- `compact` keeps every retained skill with a short, query-independent
  description.
- `hybrid` scores the full original descriptions, keeps relevant, critical, and
  pinned skills full, then renders the tail as `name` or `intent`.

When a request has no usable lexical signal, `hybrid` uses the short `intent`
tail instead of reducing most entries to names. Ranking always uses the full
catalog; compaction happens only while rendering the result. A conservative
fuzzy pass over skill names and profile aliases recovers minor typos only when
normal lexical coverage is weak. Ordinary full entries share a soft serialized
character budget; critical, pinned, explicitly protected, and ambiguity-guard
entries may exceed it.

### Tools array modes

- `off` leaves tools unchanged and is the default.
- `drop` removes configured name prefixes. This is the recommended tool mode
  because its behavior is explicit and deterministic.
- `relevance` retains the highest-scoring non-core tools. It fails open and
  leaves the array unchanged when the query is empty or has no lexical match.

Core tools, explicitly protected tools, and tools already used in canonical
Anthropic, OpenAI, or Gemini conversation history are never removed. Relevance
scoring includes a bounded view of JSON-schema property names, descriptions,
required fields, and enums instead of relying on the tool name alone.

### Tool-output modes

- `off` leaves tool results unchanged.
- `smart` deterministically keeps the head, tail, protected evidence, and bounded
  context from long output.
- `extract` asks the selected model to retain verbatim lines relevant to the
  request. Its result is accepted only when every line exists in the source with
  valid multiplicity and original order, all protected evidence survives, and
  the reduction clears the configured benefit floor. Rejection falls back in
  the order `extract -> smart -> original`.

All output thresholds and metrics use real UTF-8 bytes, and clipping never splits
a Unicode code point. Protected evidence covers errors, warnings, stack frames,
failed tests and assertions, path-and-line diagnostics, exit failures, and
explicit constraints. When output is reduced, the original is written through
an exclusive, owner-only temporary file and its path is included in the result.
If archival fails, the original result is returned unchanged.

## Guarantees

- `compact` and `hybrid` keep every skill name except entries explicitly excluded
  by `never`.
- Every retained skill remains loadable. Promoted and irregular entries keep an
  explicit `<location>`; regular tail entries may share one `<skill_path_note>`
  with roots and the `<root>/<name>/SKILL.md` convention.
- An already optimized catalog is returned unchanged. Removed descriptions
  cannot be reconstructed safely, so repeated optimization is idempotent.
- Surviving description text is retained verbatim; the optimizer removes or
  shortens content but does not paraphrase or reorder it.
- Explicit skill mentions and observed skill-tool calls are the only events that
  affect usage pinning.
- Usage history is bounded and prunes only stale one-off observations; critical,
  explicitly full, and currently pinned skills are protected from pruning.
- If a request does not change, the hook returns the original reference.
- Canonical Anthropic, OpenAI Responses/messages, Gemini, and Mistral request
  shapes are normalized before query extraction and optimization.

Explicit `/skill:name` expansion remains independent of the in-request catalog.

## RTK

[RTK](https://github.com/rtk-ai/rtk) is the recommended companion and is
operationally important for the best command-output reduction, but it is not a
runtime prerequisite. The catalog and tools-array optimizer work without it,
and the built-in `smart`/`extract` path remains a guarded fallback.

When an RTK-style Pi extension is detected, this extension disables only its
overlapping tool-output reducer by default. Skills and tools-array optimization
remain active. Set `outputDisableWithRtk` to `false` only if both output reducers
are intentionally required.

## Install

Install from GitHub:

```bash
pi install git:github.com/AeonDave/pi-skill-optimizer
```

For local development:

```bash
git clone https://github.com/AeonDave/pi-skill-optimizer
cd pi-skill-optimizer
npm install
pi install .
```

Pi provides the `@earendil-works/*` peer dependencies at runtime. A one-off run
can load the extension directly:

```bash
pi -e git:github.com/AeonDave/pi-skill-optimizer
```

## Usage

The extension runs automatically. The defaults are skills mode `hybrid`, tools
mode `off`, and output mode `smart`.

Use `/skill-optimizer` to inspect the active configuration and session/lifetime
savings. Use `/skill-optimizer init` to generate an optional retrieval profile.

## Configuration

On first run, the extension creates
`~/.pi/agent/skill-optimizer/config.json`. Project settings in
`<cwd>/.pi/skill-optimizer/config.json` override global settings. Environment
variables override both files.

```jsonc
{
  "disable": false,
  "mode": "hybrid",       // off | compact | hybrid
  "topK": 20,             // hybrid: baseline number kept full
  "fullRenderBudgetChars": 12000, // soft budget for ordinary full entries; 0 = unlimited
  "tail": "name",         // name | intent
  "alwaysFull": [],       // skill names always kept full
  "never": [],            // exact names or prefix* patterns to exclude
  "providers": [],        // provider IDs; [] means all
  "pinnedTopK": 8,        // usage-derived skills kept full

  "toolsMode": "off",     // off | drop | relevance
  "toolsDrop": [],        // drop-mode name prefixes
  "toolsTopK": 24,        // relevance-mode non-core limit
  "toolsProtect": [],     // additional protected names/prefixes

  "outputMode": "smart",  // off | smart | extract
  "outputMaxLines": 400,
  "outputMinSavingsBytes": 512,
  "outputMinSavingsRatio": 0.1,
  "outputTools": ["bash"],
  "outputModel": "",
  "outputExtractExclude": ["cat", "ls", "head", "tail", "tree", "find", "dir", "type"],
  "outputDisableWithRtk": true,

  "usageMaxEntries": 2048,
  "usageStaleDays": 180
}
```

Configuration environment variables use the
`PI_SKILL_OPTIMIZER_<SETTING>` prefix. Common examples are `MODE`, `TOP_K`,
`TAIL`, `FULL_RENDER_BUDGET_CHARS`, `ALWAYS_FULL`, `NEVER`, `PROVIDERS`,
`TOOLS_MODE`, `TOOLS_DROP`, `OUTPUT`, `OUTPUT_MODEL`,
`OUTPUT_MIN_SAVINGS_BYTES`, `OUTPUT_MIN_SAVINGS_RATIO`, `OUTPUT_EXCLUDE`,
`USAGE_MAX_ENTRIES`, and `USAGE_STALE_DAYS`.
`PI_SKILL_OPTIMIZER_DISABLE=true` disables the extension; `false` does not.

State path overrides are `PI_SKILL_OPTIMIZER_PROFILE`,
`PI_SKILL_OPTIMIZER_USAGE`, and `PI_SKILL_OPTIMIZER_STATS`.

## Retrieval profile

```text
/skill-optimizer init
```

`init` generates aliases, synthetic queries, critical skills, clusters, and
negative hints from the loaded catalog. Global skills are written to
`~/.pi/agent/skill-optimizer/profile.json`; project skills are written to
`<cwd>/.pi/skill-optimizer/profile.json`. They are merged at runtime with project
data taking precedence.

Generation is incremental. Unchanged skills are identified by hash, removed
skills are pruned, and incomplete batches remain pending for the next run.
Normal provider requests read the profile but do not invoke a model to update it.

## Diagnostics and state

The footer shows the current estimated token reduction. `/skill-optimizer`
reports exact serialized characters removed and estimated token equivalents,
split across skills, tools, and output. Output telemetry separately reports
attempts, accepted extractions, evidence rejections, insufficient-benefit
fallbacks, and reducer errors.

Persistent state is stored under `~/.pi/agent/skill-optimizer/` and the project
`.pi/skill-optimizer/` directory. Profile, usage, and statistics writes use
atomic replacement; usage and statistics updates are serialized to avoid losing
concurrent deltas.

Token figures are estimates derived from character counts. Actual tokenization
depends on the provider and model.

`compact` is query-independent and therefore the cache-stable catalog mode.
`hybrid` intentionally varies with the request to improve relevance. Pi's hook
does not expose authoritative provider cache reads/writes, so the extension does
not invent cache-hit telemetry or dynamically inject cache claims.

## Latest real-corpus snapshot

Fresh run from 2026-07-22 using `openai-codex/gpt-5.6-luna` with reasoning off:

| Mode | Avg actual input tokens | Reduction vs `off` | Catalog bytes | Model micro recall | Full exposure | Loadability |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `off` | 28,212 | Baseline | 108,784 | 34% | 100% | 100% |
| `compact` | 15,414 | 45.4% | 59,379 | 37% | 37% | 100% |
| `hybrid` | 10,363 | 63.3% | 36,286 | 34% | 49% | 100% |

These 24 observed positive-only cases show measured token reduction and preserved
loadability, but they are too small and biased to establish quality superiority or
statistical equivalence. Project safety passed; the separately evaluated RTK
0.42.4 output comparison failed its evidence-safety contract on the three real
outputs. See [BENCHMARK.md](BENCHMARK.md) for the full methodology, output tables,
privacy notes, limitations, and reproduction commands.

## Interpreting the real-corpus benchmark

The private-corpus benchmark evaluates anonymized artifacts. UTF-8 byte counts
and provider usage are exact for those anonymized evaluator requests, not for the
original production payload. Output `actualFixedJudgeInputTokens` includes the
fixed judge instructions and reference facts; it is not a candidate-only token
count, so candidate size comparisons use UTF-8 bytes.

Model calls are fresh by default. `--resume-model-cache` is an explicit
reproducibility option: resumed results are labeled separately and their stored
provider usage is excluded from current-run telemetry. Compact cache stability
means identical compact catalog serialization across at least two queries; it is
reported as N/A without a comparison and is not a provider cache-hit claim.

Project safety covers the optimizer's skill, smart-output, and extract-output
invariants. RTK is an external comparator with a separate safety result. Observed
skill reads are positive relevance labels; the benchmark does not infer a
"primary" skill from tool-call order.

## Development

```bash
npm install
npm test
npm run typecheck
npm run bench
npm run bench:output
npm run corpus:build
npm run bench:real
npm run measure <capture.json>
pi -e ./src/index.ts
```

`bench` uses a deterministic synthetic catalog and blocks on discovery,
loadability, relevance, fuzzy recovery, soft-budget, cache-stability, and
idempotence regressions. `bench:output` blocks on UTF-8 safety, exact evidence
recall, ordered-verbatim extraction, hallucination rejection, and material byte
savings. `measure` reports exact serialized-size differences and an explicitly
estimated token equivalent for a captured provider request.

### Real private benchmark

The synthetic benchmarks are fast regression gates. For empirical results on
the current installation, build a private corpus and evaluate it with the real
Luna model:

```bash
npm run corpus:build
npm run bench:real -- --skill-cases 8 --output-cases 3
```

`corpus:build` performs one isolated `openai-codex/gpt-5.6-luna:low` call to
capture Pi's real pre-optimization skill catalog. It then scans a bounded set of
local Pi sessions and retains only anonymized user turns followed by observed
`SKILL.md` reads, plus bounded real shell outputs. `profile.json` is frozen as a
ranking feature; generated aliases and queries are never treated as labels.

`bench:real` compares the same labeled turns under `off`, `compact`, and
`hybrid`. Each mode is sent to Luna, so reported input, output, reasoning,
`cacheRead`, and `cacheWrite` values come from provider usage rather than a
characters-per-token estimate. It also feeds identical output buffers through
the built-in `smart`/`extract` fallback and `rtk pipe`, reporting exact UTF-8
bytes and protected-evidence recall.

All prompts are sanitized before remote evaluation. Absolute paths, home names,
emails, IP addresses, URL hosts, UUIDs, credentials, JWTs, PEM blocks, and common
API-token forms are redacted. Stable identifiers use a private HMAC salt. The
corpus, salt, model cache, and reports remain under
`.pi/skill-optimizer/benchmark/`, which is ignored by Git. Review that directory
manually before sharing any artifact; semantic skill names are intentionally
retained because replacing them would invalidate name and fuzzy retrieval.

Observed skill reads are positive labels, not exhaustive negatives. Explicit
`/skill:name` turns and already optimized captures are excluded. Results should
therefore be read as paired recall on observed behavior, not as universal task
success or a substitute for human adjudication.

See [AGENTS.md](AGENTS.md) for module boundaries and invariants.

## License

MIT
