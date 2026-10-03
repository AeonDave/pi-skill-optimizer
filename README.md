# pi-skill-optimizer

**Keep your skill library. Cut the repeated context.**

![pi-skill-optimizer: a whole library, just the skills you need](assets/banner.png)

[Install](#install) · [What changes](#what-changes) · [Everyday use](#everyday-use) · [Configuration](#configuration) · [Docs](#documentation)

An extension for [Pi](https://github.com/earendil-works/pi) that routes skills and tools locally and reduces large tool results without losing access to the originals.

Keep every skill name visible, bring relevant descriptions into focus, and load the full instructions when needed. Large tool results can be reduced too, with the original kept locally for recovery.

No embedding service or extra model call for ordinary routing. No changes to your source skills.

## Install

Requires **Pi 1.0.0+** and **Node.js 26.3+**. Upgrade both before installing v3.1.

```bash
pi install npm:@aeondave/pi-skill-optimizer
```

Restart Pi, then check that it loaded:

```text
/skill-optimizer
```

On Pi 1.0.0, the optimizer's search tool is `optimizer_tool_search`. Pi's
built-in `tool_search` can load alongside it without a name conflict. If you
previously disabled `builtin:tool-search` to avoid the warning, you can remove
that setting after updating the optimizer. See the
[tool-search configuration](docs/CONFIGURATION.md#tool-search-and-pi-100).

That's enough to start. Optionally run `/skill-optimizer init` to generate routing hints for your library. **Init uses your current Pi model and may incur cost**; normal discovery does not.

| Need | Command |
| --- | --- |
| Install only in this project | `pi install -l npm:@aeondave/pi-skill-optimizer` |
| Pin the current release | `pi install npm:@aeondave/pi-skill-optimizer@3.1.0` |
| Update an unpinned install | `pi update npm:@aeondave/pi-skill-optimizer` |

Restart after updating. Pinned installs stay pinned until you explicitly install another version.

### Moving from the unscoped package

The supported npm package is **`@aeondave/pi-skill-optimizer`**; it replaces the old unscoped name. Commands and configuration paths have not changed. Version 3.0.0 keeps the same runtime code as the unscoped 3.0.0 release.

Use `pi list` to check your installed sources. For an unpinned personal install:

```bash
pi remove npm:pi-skill-optimizer
pi install npm:@aeondave/pi-skill-optimizer
```

For a pinned or Git install, remove the exact old source shown by `pi list`. Add `-l` to both commands for a project-local install. Keep only one source enabled: Pi treats scoped, unscoped and Git packages as different identities. Your optimizer config, routing profile and usage data stay in their existing locations; no re-init is needed just for this migration. Restart Pi afterward.

## What changes

Say you have hundreds of skills, but you're asking Pi to fix a database migration. Sending every full description again is rarely useful.

AUTO keeps a compact, stable index of **all eligible names**, adds relevant descriptions beside your latest request, and exposes `skill_search` for loading complete instructions. The stable index does not change when your question changes.

| Area | What AUTO does | What stays available |
| --- | --- | --- |
| Skills | Shortens catalog descriptions; prefetches relevant ones | Every eligible name and exact full-instruction loading |
| Tools | Defers less relevant schemas behind `optimizer_tool_search` | Protected, configured, already-used and activated tools |
| Large results | Applies deterministic reduction; lossless columnar JSON where suitable | Complete originals through `retrieve_output` during archive retention |
| Repeated results | Replaces later exact duplicates with recovery references | The first result, errors, protected evidence and mixed media |

Tool routing fails open when the signal is weak: all permitted tools remain active. Output reduction also fails open if it cannot archive the original or make a meaningful saving. RTK-handled shell results are left to RTK, one result at a time.

[How AUTO works](docs/ARCHITECTURE.md) · [Ranking decisions and limits](docs/RANKING.md)

## Everyday use

You can leave AUTO running with its defaults.

- `/skill-optimizer` shows setup readiness, savings, active tools and provider usage.
- `/skill-optimizer audit` reports description issues without rewriting your skills.
- `/skill-optimizer init` creates or updates routing hints. Successful batches are checkpointed; rerunning resumes incomplete work.

An optional setup hint appears at the first eligible prompt when initialization is missing or needs attention. It never starts init for you or adds instructions to the model's context.

Pi gets three optimizer tools: `skill_search`, `optimizer_tool_search` and `retrieve_output`. Pi may also provide its built-in `tool_search`. Skill search is paginated and exact loads accept only registered names. Output recovery uses opaque identifiers, not exposed archive paths.

Skills can be useful even when you never mention them. Init can tag architecture,
testing and behavioral guidance by activity, so a matched specialist can bring
one relevant supporting skill into prefetch. Behavioral does not mean always-on.
[Contextual routing](docs/RANKING.md#contextual-and-behavioral-skills) explains the
budget and limitations. Existing profiles need an explicit init rerun for these tags.

## Configuration

Start with defaults. For project-specific settings, create `.pi/skill-optimizer/config.json`:

```json
{
  "alwaysSkills": ["your-project-skill"],
  "alwaysTools": ["your-required-tool"],
  "outputMode": "smart"
}
```

Replace the example names with installed skills/tools. Global defaults live at `~/.pi/agent/skill-optimizer/config.json`; project settings override them, followed by environment variables.

The default output mode is local and deterministic. Optional `extract` mode needs an explicit model and validates its output before accepting it. It is not enabled by default.

[Full configuration, defaults and RTK behavior](docs/CONFIGURATION.md)

## Limits and privacy

This is not a general conversation summarizer. It does not shrink arbitrary instructions, guarantee that the model picks the right skill, or guarantee lower provider bills.

All names stay visible, so the minimum index still grows with the library. Description budgets are soft at that floor. Output size settings trigger reduction rather than enforce hard caps: protected evidence can exceed them.

Original outputs stay in local archives, retained for **seven days by default**. They may contain sensitive tool output; treat them accordingly. Normal hooks do not collect benchmark corpora or send data to a separate ranking service. Your selected Pi provider still receives the ordinary request.

Generated profile hints are not benchmark labels. Stable prompt bytes are not proof of cache hits. [Privacy, persistence and accounting](docs/CONFIGURATION.md#privacy)

## Evidence and development

The [published v2.0.0 benchmark](BENCHMARK.md#published-v200-snapshot) records eight private, anonymized cases. It is historical evidence, **not a result for the current working tree or a universal savings claim**.

Local checks use synthetic data, no remote model calls:

```bash
npm install
npm run typecheck
npm test
npm run bench
npm run bench:ranking
npm run bench:perf
npm run bench:output
```

Load your checkout with `pi -e ./src/index.ts`. `bench:ranking` compares routing components on a small diagnostic fixture; `bench:perf` measures cold and warm request handling at 284 and 2,000 skills. Neither establishes end-to-end model quality.

The CI workflow covers Windows, Linux and macOS on Node 26.3 and the current 26.x. Tests
include native/forward-slash resource paths, spaces, Unicode, symlink containment,
and exact LF/CRLF/mixed-newline recovery. A configured matrix is not evidence of
a successful run; check the jobs for the commit you use.

`corpus:build` and `bench:real` are separate, explicit private-evaluation workflows. They are not part of the local checks and may involve provider cost. See the [benchmark protocol](BENCHMARK.md) before using them.

## Documentation

- [Architecture and guarantees](docs/ARCHITECTURE.md)
- [Configuration and runtime reference](docs/CONFIGURATION.md)
- [Ranking rationale and evaluation](docs/RANKING.md)
- [Benchmark contract and historical results](BENCHMARK.md)
- [Changelog](CHANGELOG.md)

MIT. See [LICENSE](LICENSE).
