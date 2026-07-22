# Benchmark report

This document reports the deterministic synthetic benchmark and the final fresh
real-corpus evaluation for `pi-skill-optimizer`. It describes measured behavior,
not a claim of quality superiority or statistical equivalence between modes.

## Final real-corpus snapshot

| Item | Value |
| --- | --- |
| Run date | 2026-07-22 |
| Corpus | Anonymized real catalog and observations |
| Catalog size | 332 skills |
| Skill cases | 24 observed cases |
| Tool-output cases | 3 real outputs |
| Evaluator model | `openai-codex/gpt-5.6-luna` |
| Reasoning | Off |
| Model execution | 87 fresh calls, 0 resume-cache hits, 0 invalid-response retries |
| RTK | 0.42.4 |
| Project safety | **PASS** |
| External RTK safety | **FAIL** |

The fresh-run requirement matters: no model response was reused from the resume
cache, and malformed judge output did not require a retry.

## Methodology

### Corpus construction and privacy

The corpus is derived from a real Pi skill catalog, explicit observed skill-use
evidence, and real tool output. Before evaluation, the builder replaces sensitive
paths and common personal or secret-bearing forms, assigns salted stable IDs, and
emits no reversal mapping. The evaluator receives the anonymized corpus rather
than the original private session material.

Anonymization reduces disclosure risk but is not a proof of anonymity. Queries,
tool output, unusual terminology, and combinations of facts may still be
identifying. The salt, corpus, catalog, runtime capture, model cache, and full JSON
report are therefore private local artifacts and must be reviewed before sharing.

### Skill evaluation

Each of the 24 observed queries is evaluated against the same 332-skill catalog in
three modes:

| Mode | Catalog presented to the evaluator |
| --- | --- |
| `off` | Original catalog |
| `compact` | Every retained skill has a compact intent description |
| `hybrid` | Relevant skills remain full; the tail is compacted according to signal and fallback rules |

For each mode, the evaluator model selects skills from the rendered catalog. The
model is given only allowed skill names, and its response is parsed as strict JSON.
Invalid output is retried instead of being silently interpreted as an empty
selection.

Actual input-token counts come from provider usage for the complete anonymized
evaluator request, including evaluator instructions, the anonymized query, and the
rendered catalog. They are not token counts for the catalog in isolation. The
numbers are exact for this anonymized corpus, model, and run only.

### Output evaluation

The three output cases cover one grep output, one log output, and one git-log
output. Four variants are measured:

| Variant | Meaning |
| --- | --- |
| `raw` | Original output |
| `smart` | Project evidence-aware deterministic reduction |
| `extract` | Project model-assisted extraction with conservative fallback |
| `RTK` | Output produced by external RTK 0.42.4 |

Candidate bytes measure the returned output itself. Judge-input tokens measure the
entire fixed judge request, including its instructions, reference evidence, and
candidate output. They are not standalone candidate token counts, so byte ratios
and judge-input-token ratios answer different questions.

## Metric definitions

| Metric | Definition |
| --- | --- |
| Actual anonymized input tokens | Provider-reported input usage for the complete anonymized skill-selection request |
| Catalog bytes | UTF-8 size of the rendered catalog |
| Model micro recall | Observed positive skill labels selected, aggregated across all labels |
| Any-hit rate | Cases where the model selected at least one observed positive label |
| Full exposure | Observed positive labels whose skill retained its full description |
| Intent exposure | Observed positive labels retaining at least a compact intent description |
| Loadability | Observed positive labels whose rendered entry still resolves to its skill file |
| Exact evidence recall | Literal reference evidence retained in returned output |
| Semantic evidence recall | Reference evidence judged semantically present in returned output |

### Label semantics and bias

Skill labels are conservative positive observations: a label records a skill that
was explicitly mentioned or observed as used. An unlabelled skill is not a
negative label, and the labelled set is not asserted to be the unique or complete
optimal solution. Model recall therefore measures recovery of observed positives,
not overall task correctness or the absence of unnecessary selections.

The cases reflect one real catalog and one user's observed workload. Topic mix,
prior skill choices, phrasing, and repeated catalog structure can bias both labels
and evaluator behavior. The small corpus is useful for paired engineering checks,
but not for population-level inference.

## Skill results

| Mode | Avg actual anonymized input tokens | Token reduction | Avg catalog bytes | Model micro recall | Any-hit | Full exposure | Intent exposure | Loadability |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `off` | 28,212 | Baseline | 108,784 | 34% | 42% | 100% | Not separately reported | 100% |
| `compact` | 15,414 | 45.4% vs `off` | 59,379 | 37% | 42% | 37% | 100% | 100% |
| `hybrid` | 10,363 | 63.3% vs `off` | 36,286 | 34% | 42% | 49% | 56.3% | 100% |

`hybrid` used 32.8% fewer actual input tokens than `compact`. These percentages
are computed from the displayed unrounded averages and describe this run only.
The 34%, 37%, and 34% model-recall values must not be read as a ranking of mode
quality: 24 positive-only cases and one model run do not establish superiority or
equivalence. The stable 42% any-hit rate is descriptive, not a significance test.

Loadability remained 100% in every mode. `compact` retained intent exposure for
all observed positives, while `hybrid` traded more catalog reduction for 56.3%
intent exposure and 49% full exposure on those positives.

## Output results

All recall values below are percentages.

| Output | Variant | Candidate bytes | Whole judge-input tokens | Exact evidence | Semantic evidence |
| --- | --- | ---: | ---: | ---: | ---: |
| grep | `raw` | 6,708 | 3,885 | 100 | 100 |
| grep | `smart` | 5,702 | 3,543 | 100 | 100 |
| grep | `extract` | 5,702 | 3,543 | 100 | 100 |
| grep | `RTK` | 186 | 1,803 | 0 | 0 |
| log | `raw` | 15,230 | 4,014 | 100 | 100 |
| log | `smart` | 5,363 | 1,662 | 100 | 100 |
| log | `extract` | 5,363 | 1,663 | 100 | 100 |
| log | `RTK` | 658 | 509 | 0 | 33 |
| git-log | `raw` | 4,197 | 1,228 | 100 | 100 |
| git-log | `smart` | 4,197 | 1,230 | 100 | 100 |
| git-log | `extract` | 4,197 | 1,228 | 100 | 100 |
| git-log | `RTK` | 292 | 255 | 0 | 0 |

The extractor accepted none of its three attempted reductions. Two attempts fell
back to the safe `smart` result because required evidence was not retained; one
fell back to the original because the benefit was insufficient. The returned
project outputs therefore kept 100% exact and semantic evidence in all three
cases. This is conservative fallback behavior, not evidence that extraction is
generally ineffective.

RTK produced substantially smaller candidates, but exact evidence recall was 0%
for all three cases and semantic recall was 33% only for the log case. That makes
the separately reported external RTK safety result **FAIL** for this corpus. It is
not a general assessment of RTK, and it does not change the project's own safety
result.

## Safety contract

The benchmark treats the following as blocking project invariants:

- `off` must preserve the original catalog.
- Retained skill names must remain ordered and discoverable.
- Every retained skill must remain loadable through an explicit location or the
  declared shared path convention.
- Skills selected for promotion must retain their full description.
- Compact descriptions must contain only ordered text extracted from the original
  description; truncation must be explicit.
- Re-optimizing an already transformed catalog must be idempotent.
- Project output reduction must preserve the required exact and semantic evidence
  after fallback.

All project invariants passed in the final fresh run. RTK is evaluated as an
external comparison with its own safety status; an external failure is reported
but does not masquerade as a project-runtime failure.

## Deterministic synthetic benchmark

The synthetic benchmark is separate from the real-corpus model evaluation. It is
deterministic and is intended to catch regressions in invariants and routing under
controlled inputs.

| Scenario | Result |
| --- | --- |
| Skill catalog | 284 synthetic skills |
| Hybrid catalog reduction | 67% characters saved |
| Relevance cases | 8/8 passed |
| Name retention | 100% |
| Loadability | 100% |
| Fuzzing | 3,000 iterations |
| Output fixture | 600 lines, 66,885 bytes |
| Output extraction reduction | 99% |
| Output evidence retention | 100% |

Synthetic results establish deterministic behavior on generated fixtures. They do
not substitute for representative real workloads or human task-quality review.

## Reproduction

Install and validate the pure project first:

```bash
npm install
npm run typecheck
npm test
npm run bench
```

Capture a local catalog, build the private anonymized corpus, and run a fresh real
evaluation:

```bash
pi -e ./scripts/capture-catalog-extension.ts
npx tsx scripts/build-real-corpus.ts
npx tsx scripts/evaluate-real-corpus.ts
```

The evaluator performs provider calls and requires the corresponding Pi/model
authentication. A fresh comparable run must omit `--resume-model-cache`; enabling
that flag is useful for interrupted local work but produces separately labelled
resume-cache telemetry.

The deterministic output fixture can also be run directly:

```bash
npx tsx scripts/output-bench.ts
```

## Local artifacts

The real benchmark writes private artifacts below
`.pi/skill-optimizer/benchmark/`:

| Path | Contents |
| --- | --- |
| `catalog.json` | Sanitized captured catalog |
| `corpus.json` | Anonymized skill and output cases |
| `runtime.json` | Captured runtime/tool availability metadata |
| `model-cache.json` | Optional evaluator response cache |
| `real-report.json` | Full machine-readable report |
| `salt` | Private salt used for stable anonymized identifiers |

Keep the directory private by default. `BENCHMARK.md` is the intentionally small,
reviewed summary suitable for source control; it does not embed raw cases.

## Limitations

- One 332-skill catalog does not represent other installations or catalog mixes.
- Twenty-four positive-only skill cases cannot measure precision, unnecessary
  selections, end-task success, or population-level effects.
- Three outputs do not cover the diversity of commands, failures, encodings, or
  evidence shapes seen in practice.
- One model with reasoning disabled does not establish behavior for other models,
  providers, reasoning settings, or future model revisions.
- Model judgments and selections can vary between fresh runs.
- Provider token counts apply only to the complete anonymized evaluator requests
  from this run; they are not counts for the original private requests.
- Output candidate bytes and whole judge-input tokens are not interchangeable
  compression metrics.
- Exact and semantic evidence oracles protect known reference evidence, not every
  possible downstream use of an output.
- The RTK comparison reflects version 0.42.4 and these three fixtures only.

## Conclusions and next steps

The measured token reduction is material for this anonymized catalog, and the
project's discovery, loadability, idempotence, and returned-output safety gates all
passed. The observational recall values are mixed and too limited to support a
quality ranking. The output extractor behaved conservatively by rejecting all
three unsafe or low-benefit attempts, while the external RTK comparison sacrificed
the benchmark's required evidence on these fixtures.

Useful next steps are to expand the corpus across users, domains, providers, and
catalog sizes; add negative and ambiguity labels; repeat fresh runs for variance;
add blinded human task-quality review; broaden output types; and record candidate-
only tokenizer measurements separately from whole judge-request usage.
