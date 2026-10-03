# Configuration and runtime reference

[Back to the README](../README.md)

## Runtime tools

| Tool | Purpose |
| --- | --- |
| `skill_search` | Paginated skill search plus exact `load`, contained `resource`, and explicit `location` actions |
| `optimizer_tool_search` | Search deferred tool definitions and activate bounded matches additively |
| `retrieve_output` | Recover archived output or a deduplicated history result by opaque identifier |

Exact skill loading accepts only registered names. Resource and location resolution use canonical paths and containment checks to reject traversal and symlink escape. Search cursors bind to the query, catalog and ranked name order; a changed profile or usage prior that reorders results requires a new search, rather than duplicating or skipping a page. This is an exact local resolver guarantee, not a guarantee that the model will select the right skill; see the separate [ranking diagnostics](RANKING.md) and [historical model benchmark](../BENCHMARK.md).

`excludeSkills` removes names from discovery and search, not from explicit exact loading. It is a routing preference, not an access-control boundary. The three resolver tools return their content without another output-reduction pass, so full skill instructions and recovered originals remain readable.

### Tool search and Pi 1.0.0

The extension registers `optimizer_tool_search`, leaving Pi's built-in `tool_search` available under its own name. The optimizer indexes eligible registered tools, including ones it deferred from Pi's active set and Pi-registered `deferred` or `codemode` tools. Matching inactive results activate additively; unrelated fallback results remain inactive. An already active built-in `tool_search` stays active during optimizer replanning. Pi's built-in MCP extension can activate its own `tool_search` when a deferred server connects.

If an older optimizer release led you to add `-builtin:tool-search` in `~/.pi/agent/settings.json` or `.pi/settings.json`, remove that entry after updating if you want Pi's built-in search available again. The built-in is inactive by default unless enabled in Pi's `defaultTools` or activated by Pi for deferred MCP tools; the optimizer's search stays available independently. Existing explicit calls to the optimizer's old `tool_search` name must use `optimizer_tool_search` after this update.

## Commands

| Command | Purpose |
| --- | --- |
| `/skill-optimizer` | Show setup readiness, AUTO state, catalog budget, critical skills, usage prior, tool activation, provider telemetry, and savings |
| `/skill-optimizer init` | Generate or incrementally update routing hints and contextual activation tags |
| `/skill-optimizer audit` | Report description issues without editing source skills |

The optional setup hint is informational, not an error: ordinary routing works
without init. It appears on the first eligible interactive prompt, at most once
per profile scope, readiness state and init version in the current session.
Session metadata preserves that suppression across reload/resume. It is not sent
to the model and does not run init or incur model cost itself. Headless sessions,
disabled/out-of-scope routing and empty catalogs do not emit it. Status remains
available even after the hint has been shown. Nonempty hand-authored profiles
without generation metadata are treated as manual, not as a failed setup.

## Configuration

Global configuration lives at `~/.pi/agent/skill-optimizer/config.json`. A project can override it with `.pi/skill-optimizer/config.json`.

| Key | Default | Purpose |
| --- | ---: | --- |
| `catalogBudgetChars` | `8000` | Request-global soft budget for stable-index intents |
| `intentMaxChars` | `96` | Maximum rendered intent length |
| `prefetchTarget` | `5` | Ordinary prefetch target |
| `prefetchMin` | `3` | Minimum adaptive prefetch count |
| `prefetchMax` | `8` | Maximum adaptive prefetch count |
| `prefetchBudgetChars` | `6000` | Full-definition overlay budget |
| `fuzzyCandidateLimit` | `8` | Bound for name and alias typo recovery |
| `alwaysSkills` | `[]` | Skills favored for routing and prefetch |
| `excludeSkills` | `[]` | Skills intentionally removed from discovery |
| `providers` | `[]` | Provider allowlist; empty means all |
| `toolPrefetchMax` | `5` | Maximum proactive tool activation |
| `toolSearchPageSize` | `8` | Default tool-search page size |
| `alwaysTools` | `[]` | Keep initially active tools and named `deferred` or `codemode` tools active; hidden tools remain unavailable |
| `historyDedupMinBytes` | `4096` | Minimum result size for history deduplication |
| `usageHalfLifeDays` | `30` | Usage-evidence decay half-life |
| `usageMaxEntries` | `2048` | Persistent usage-evidence bound |
| `usageStaleDays` | `180` | Age for pruning stale one-off evidence |
| `outputMode` | `"smart"` | `"off"`, `"smart"`, or guarded `"extract"` |
| `outputMaxLines` | `400` | Line-count activation threshold |
| `outputMaxBytes` | `16000` | UTF-8 byte activation threshold |
| `outputMinSavingsBytes` | `512` | Minimum absolute saving |
| `outputMinSavingsRatio` | `0.1` | Minimum relative saving |
| `outputTools` | `["*"]` | Eligible tool-name patterns |
| `outputModel` | `""` | Explicit model for guarded extraction |
| `outputExtractMinBytes` | `32000` | Minimum input size for extraction |
| `outputExtractExclude` | common listing commands | Tools excluded from extraction |
| `outputArchiveTtlHours` | `168` | Archive retention period |

Configuration is also available through `PI_SKILL_OPTIMIZER_*` environment variables. Lists are comma-separated. The bypass exists only as `PI_SKILL_OPTIMIZER_DISABLE` and uses boolean semantics; there is no `disable` configuration key. Output exceptions retain the exact names `PI_SKILL_OPTIMIZER_OUTPUT_MIN_SAVINGS_RATIO` and `PI_SKILL_OPTIMIZER_OUTPUT_EXCLUDE`.

Configuration refreshes at session start, before each agent run, and when you use a `/skill-optimizer` command. Provider and tool-result hooks reuse that snapshot instead of rereading files on every event. The environment bypass is checked immediately. Profile and usage state are retained separately; refreshing settings does not reset pending usage or telemetry.

## RTK coexistence

Ownership is decided per result:

| Result | Owner |
| --- | --- |
| Shell output already handled by RTK | RTK only |
| Shell output not handled by RTK | AUTO eligible |
| Read, web, MCP, and other eligible output | AUTO eligible |
| Already reduced output | No second reduction |

RTK never changes skill discovery or dynamic tool activation.

## Telemetry and persistence

Provider telemetry records only authoritative usage fields:

```text
requests, input, output, cacheRead, cacheWrite, totalCost
```

AUTO does not infer cache hits from stable bytes. Characters, UTF-8 bytes, provider tokens, and cost remain separate metrics.

Profile updates use atomic replacement with revision checks; usage and statistics merge lock-serialized additive deltas. Archive content is immutable and SHA-256 verified. A separate expiry record belongs to each archive: saving identical content may extend its retention, but a reader or project with a shorter TTL cannot shorten it. Legacy archives without expiry records get a fixed seven-day lifetime from their last modification; corrupt expiry records fail closed without deleting content. Usage evidence is bounded and decays over time.

An old lock is reclaimed only when its recorded process is no longer alive;
elapsed time alone must not interrupt a slow or suspended writer. Unknown lock
ownership fails closed rather than risking a concurrent overwrite.

Recovery preserves original LF, CRLF, CR and mixed line endings, including the selected lines' terminators. Adjacent pages concatenate to the original text; asking past the end returns an empty page. Invalid Unicode strings containing unpaired UTF-16 surrogates are left unreduced rather than archived with replacement characters.

## Privacy

- Normal hooks never collect a benchmark corpus.
- Corpus building and real-provider evaluation are explicit commands.
- Remote evaluation receives only validated, sanitized cases with keyed irreversible identifiers.
- Raw private sessions, catalogs, paths, credentials, hostnames, and account identifiers are not published.
- Generated profile queries are routing hints, not benchmark labels.
- Full output archives stay local.
- `.pi/skill-optimizer/benchmark/` must not be committed.

## Routing profile initialization

`init` is explicit model work. It notifies at start and completion while per-batch progress stays in the transient status line. It batches full descriptions by skill count and UTF-8 input size, validates complete coverage and a successful provider stop reason, retries only retryable failures, and checkpoints each successful batch so interrupted work is not lost. A changed skill whose regeneration fails stays unhashed and inactive until retry, rather than serving stale routing. Init also repairs global/project profile ownership without another model call. Ordinary discovery does not call a model.


The profile is optional. Without one, AUTO still uses the catalog's names and descriptions. Run `init` when you want generated routing hints, and rerun it after changing your skills. It uses the current Pi model and can incur provider cost.

Profile init version 5 also generates optional `activation` tags. Each installed
skill can be a `specialist`, `workflow`, or `behavioral` skill and declare applicable
activities. For example, the profile may contain:

```json
{
  "activation": {
    "python-patterns": { "kind": "specialist", "tasks": ["software-change"] },
    "software-architecture": { "kind": "workflow", "tasks": ["software-design", "software-change"] },
    "test-driven-development": { "kind": "behavioral", "tasks": ["software-change"] }
  }
}
```

These are example entries inside `profile.json`, not `config.json`, and only make
sense for installed skills. They allow bounded contextual support without turning
every behavioral skill into a permanent default. The next explicit init upgrades
older generated profiles; no regeneration or model call happens on ordinary
startup. See [contextual routing and its limits](RANKING.md#contextual-and-behavioral-skills).
