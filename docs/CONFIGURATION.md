# Configuration and runtime reference

[Back to the README](../README.md)

## Installation and updates

Requires Pi 1.0.0 or newer and Node.js 26.3 or newer. Development packages and host
integration tests target Pi 1.3.0; packaged release checks also cover the supported
Pi 1.0.0 floor.

```bash
pi install npm:@aeondave/pi-skill-optimizer
```

| Need | Command |
| --- | --- |
| Install only in this project | `pi install -l npm:@aeondave/pi-skill-optimizer` |
| Pin version 3.1.3 | `pi install npm:@aeondave/pi-skill-optimizer@3.1.3` |
| Update an unpinned install | `pi update npm:@aeondave/pi-skill-optimizer` |

Restart Pi after installing or updating, then run `/skill-optimizer` to inspect
status. Pinned installs stay pinned until you explicitly install another version.
Run `/skill-optimizer init` when you want generated catalog cards; installation
and ordinary startup do not start this model work.

### Moving from the unscoped package

The supported npm identity is `@aeondave/pi-skill-optimizer`. Use `pi list` to
inspect the installed sources. For a common unpinned personal installation:

```bash
pi remove npm:pi-skill-optimizer
pi install npm:@aeondave/pi-skill-optimizer
```

For pinned or Git installations, remove the exact old source shown by `pi list`.
Add `-l` to both commands for project-local installations. Keep only one source
enabled: Pi treats scoped, unscoped and Git packages as different identities.
Commands and optimizer configuration, profile and usage paths stay unchanged;
renaming the package alone does not require re-init. Explicitly generating v6
cards is a separate operation. Restart Pi after migrating.

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
| `/skill-optimizer init` | Generate or incrementally update routing hints, activation metadata, and semantic catalog cards |
| `/skill-optimizer cancel` | Cancel this session's running init and retain completed checkpoints |
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
| `catalogBudgetChars` | `8000` | Soft request-global budget for compact-index intents; generated tag directories are capped at `min(4000, this value)` characters per catalog |
| `intentMaxChars` | `96` | Maximum rendered intent length |
| `prefetchTarget` | `5` | Ordinary prefetch target in no-card mode |
| `prefetchMin` | `3` | Minimum adaptive prefetch count in no-card mode |
| `prefetchMax` | `8` | Maximum adaptive prefetch count in no-card mode |
| `prefetchBudgetChars` | `6000` | No-card overlay budget for verbatim names and descriptions, not full skill instructions |
| `fuzzyCandidateLimit` | `8` | Bound for name and alias typo recovery |
| `alwaysSkills` | `[]` | Stable name hints in catalog mode; protected routing/prefetch choices in no-card mode |
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

Lock ownership is published atomically only after the complete record is synced.
Locks are never reclaimed automatically: a stale timestamp or apparently dead PID
is not a safe compare-and-delete operation across concurrent processes. A crash
can leave a lock behind. If a write reports a lock timeout, stop the Pi processes
using that optimizer data, remove only the exact `.lock` file named in the error,
then retry. Do not delete the profile, usage, stats or archive data.
Storage must support same-directory hard links (as on ordinary NTFS, APFS and
ext4 volumes); unsupported filesystems fail the write rather than weakening
locking. Network and unusual filesystems are not qualified by the local tests.

Recovery preserves original LF, CRLF, CR and mixed line endings, including the selected lines' terminators. Adjacent pages concatenate to the original text; asking past the end returns an empty page. Invalid Unicode strings containing unpaired UTF-16 surrogates are left unreduced rather than archived with replacement characters.

Nested codemode results retain their exact content and are not charged as output
savings. Session history recovery admits 128 distinct artifacts; additional new
duplicates stay verbatim rather than invalidating an earlier handle.

## Privacy

- Normal hooks never collect a benchmark corpus.
- Corpus building and real-provider evaluation are explicit commands.
- Remote evaluation receives only validated, sanitized cases with keyed irreversible identifiers.
- Raw private sessions, catalogs, paths, credentials, hostnames, and account identifiers are not published.
- Generated profile queries are routing hints, not benchmark labels.
- Full output archives stay local.
- `.pi/skill-optimizer/benchmark/` must not be committed.

## Routing profile initialization

`init` uses the selected Pi model and may incur provider cost. In an interactive session, it shows a live widget above the editor, independently of the footer or theme, and notifies at start and completion. The percentage counts only this run's target skills that were validated and saved; overall catalog coverage is displayed separately. The widget also shows the model, current batch/attempt, elapsed time and time since the last stream event. It refreshes once per second even before the first response; thinking/output character counts indicate activity and never count as completed skills. A stream-start event does not establish a network connection or completed skill. Raw thinking and JSON are not displayed or retained by the activity tracker. This is an optimizer-owned model job, separate from persona delegation.

Use `/skill-optimizer cancel` to stop the current init without losing saved batches. A second init cannot overlap the first within a session. Session replacement, reload and shutdown cancel the operation and clear its widget; late responses cannot save profiles or repaint an old session. A completed, failed or cancelled widget retains the actual final percentage until the next init or session teardown.

Initial batches contain at most 20 skills and 32 KiB of serialized skill JSON, including escaping and framing. Descriptions are kept complete; a single oversized skill remains intact in its own batch. This is a skill-input budget, not a cap on the full provider request, validation feedback, or model tokens.

Each batch gets up to two attempts: its first request and one retry. Response validation failures return bounded diagnostics to the model on retry. If the response remains invalid, init divides the batch into smaller groups, with at most eight additional calls shared by all subdivisions of each original batch: at most ten calls for that original group. These are implementation limits, not configuration keys. Progress labels such as `1/5.1` identify a subdivision. Network/provider failures do not trigger division, and cancellation or terminal quota errors stop the entire run. Every successful group is validated completely and checkpointed immediately; no partial invalid response is accepted. An `init incomplete` result reports the number left for retry and requires another explicit `/skill-optimizer init`; it does not schedule background work. The next init skips completed, unchanged owners.

Init validates exact per-batch `processedSkills` and card ownership, a successful provider stop reason, and every generated card before saving. The model must return only `summary` and `tags` for each card: a nonempty summary of at most 200 characters and one to three distinct IDs from the fixed 38-tag vocabulary. A distinguishing sentence is requested, but relevance and prose quality cannot be established by schema validation. The host computes the source hash from the exact skill name and description; the model cannot supply that hash or other card fields. Diagnostics identify bounded examples of missing, extra or duplicate coverage and invalid card fields without dumping the model response. `discipline` represents evidence-preserving reading, persistence, verification, safe judgment and related execution habits; `other` is used honestly when no supported topic tag fits, distinct from `unclassified` for missing or stale cards.

New or changed skills whose regeneration fails stay unhashed, and changed sources invalidate their stale routing hints. Known unchanged source hashes and existing v5 fields are retained across failed migration attempts. Missing or stale cards independently keep those owners incomplete and eligible for explicit retry; retaining an old source identity does not mark card generation successful. In a partial catalog, pending skills remain browsable through their current source descriptions under `unclassified`; without catalog metadata, the compatible index still covers them. Init also repairs global/project profile ownership without another model call. Ordinary discovery and skill browsing do not make hidden model calls.

The profile is optional. Without one, AUTO still uses the catalog's names and descriptions. A v5 profile (or another profile without current v1 catalog metadata) keeps the compatible compact name/intent TSV and lexical BM25F prefetch behavior until you explicitly run init. The extension does not upgrade it on startup. Init version 6 uses the current Pi model and can incur provider cost; card generation is not automatic.

Init version 6 retains the existing routing fields and optional `activation`
metadata, and adds `catalog` cards. The model uses the shared tag descriptions to
classify each installed skill; there are no per-language query keys, embeddings, or
extra per-turn provider requests. For example, `profile.json` may contain:

```json
{
  "catalog": {
    "version": 1,
    "cards": {
      "python-patterns": {
        "summary": "Apply Python idioms and safe implementation patterns.",
        "tags": ["programming"],
        "sourceHash": "<computed by the host>"
      }
    }
  },
  "activation": {
    "python-patterns": { "kind": "specialist", "tasks": ["software-change"] },
    "software-architecture": { "kind": "workflow", "tasks": ["software-design", "software-change"] },
    "test-driven-development": { "kind": "behavioral", "tasks": ["software-change"] }
  }
}
```

Cards and activation entries are profile data, not config keys. The model emits only
the card summary and canonical tags; the host binds the source hash to the exact
skill name and description. A missing or stale card uses a short summary derived
from the current description and appears under the `unclassified` browse tag until
an explicit init successfully regenerates it.

When current v1 catalog metadata exists, AUTO replaces the per-skill stable TSV with the
shared category directory and counts. The directory is a hint for the main model,
not a retrieval result: it does not automatically select or prefetch skills. Names
in `critical` and configured `alwaysSkills` remain stable hints only. The model can
choose tags and browse using `skill_search` (`match: "any"` or `"all"`); each full
JSON page is capped at 3,000 characters, so it may return fewer than the requested
page size. When tags are supplied, they define the complete result bucket and a
free-text `query` only orders within it; lexical mismatch must not veto candidates.
With no tags, `query` retains the existing lexical filtering and BM25F ranking.
If a persona or host policy withholds `skill_search`, the optimizer preserves
Pi's native skill catalog instead of force-enabling its tool.

The directory shows counts per category, so catalog changes can change its stable
bytes. The 4,000-character cap applies per tag directory, and a directory that
cannot fit the configured limit is not substituted. See [catalog discovery and
ranking limits](RANKING.md) and [how AUTO works](ARCHITECTURE.md).
