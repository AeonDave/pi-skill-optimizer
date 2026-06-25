# pi-skill-optimizer

A [Pi](https://github.com/earendil-works/pi-mono) extension that **slims the
system prompt** before every request to cut input-token cost — without hiding
your skills from the model.

## Why

Pi inlines an `<available_skills>` catalog into the system prompt of every
request — one `<skill>` entry (name, description, location) per installed skill.
This is the Level-1 *discovery* layer of [Anthropic's progressive-disclosure
design](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills):
enough for the model to know a skill exists, without loading its body. With a
large install (a few hundred skills) it is the single biggest input-token cost
and it repeats **every turn** — often tens of thousands of tokens and the
majority of the system prompt.

Instead of nuking the catalog (and losing skill discovery), this extension
**rewrites it intelligently**.

## What it does (modes)

On `before_provider_request`, for the `<available_skills>` catalog (in the system
prompt *or* a tool description):

| `mode` | Behaviour | Discovery |
|--------|-----------|-----------|
| `hybrid` (default) | BM25-rank skills against the request query; keep relevant, pinned, critical, and `alwaysFull` skills at full description + explicit `<location>`; render the rest as the `tail` style with the location replaced by one shared path note. | Full + loadable — every skill stays loadable |
| `compact` | Keep **every** skill, trim each description to its intent sentence; locations replaced by the shared path note. | Full + short intent |
| `off` | Leave the catalog untouched. | Full |

The ranking (`hybrid`) is dependency-free BM25 lexical retrieval over the catalog
itself, with name-match boosts and catalog-filtered aliases. **Scoring runs over
the full descriptions**, so a relevant skill is promoted to full even when the
rendered tail is name-only. Selection is adaptive: ambiguous close-score queries
keep a few more full descriptions. Pinned skills (local usage), critical skills
(`/skill-optimizer init`), and your `alwaysFull` list also stay full.

### Behavioural / always-on skills

Some skills are *behavioural*: operator-mode or discipline skills that should
apply in **every** session (planning, verification, evidence, code guidelines, an
operator mode that "forces explicit reasoning"). Relevance ranking can never
surface them from a task query — they share no keywords with the task. This is
handled **at `init` time**: the model classifies always-on behavioural skills
into `critical`, which is always rendered full. Opt-in/triggered modes (e.g. a
`/vault` mode that assumes an external app) are deliberately excluded. `alwaysFull`
is only a manual user override on top of that, not the mechanism for behavioural
skills.

### Why the default is `tail: name` and there is no `keepLocations` toggle

The catalog cost splits roughly into **descriptions ~60%, locations ~24%, names
~9%**. A tail skill (one the ranker judged irrelevant for this query) needs a
name to stay discoverable, but its *full path* is pure repetition: every skill
lives at `<root>/<name>/SKILL.md` under a handful of roots. So instead of a
`keepLocations` boolean (which created an incoherent "described but unloadable"
state), the optimizer:

- keeps the **explicit `<location>`** on full (selected) skills, and
- drops the derivable location on tail skills, replacing all of them with **one
  `<skill_path_note>`** that declares the roots — so every tail skill is still
  loadable (the model derives the path), at ~100 tokens instead of ~6K.

Irregular paths that don't match the convention keep their explicit `<location>`.
Net: name-only tail + path note is both the cheapest **and** a fully-loadable,
consistent layout.

> [!NOTE]
> Pi has **no `Skill` tool**: the model discovers a skill from the
> `<available_skills>` catalog and loads it by `read`-ing its `<location>` path.
> **Explicit `/skill:name` invocation is unaffected** — Pi expands it from the
> on-disk registry before the request is built, independent of the catalog.
> Skills listed in `never` are removed from the catalog entirely.

## Measured savings

Reproducible, machine-independent numbers from `npm run bench` (a synthetic
~280-skill catalog; descriptions dominate the cost, locations are next):

| config | saved | selection quality | discovery |
|--------|------:|-------------------|-----------|
| `off` | 0% | — | full |
| `compact` | ~40% | n/a (no ranking) | every skill + short intent + path note |
| `hybrid` `tail: intent` | ~35% | P=100%, recall full | top-K full + intent tail + path note |
| **`hybrid` `tail: name` (default)** | **~67%** | **P=100%, recall full** | **top-K full + name-only tail + path note (all loadable)** |

Across a 3000-query fuzz pass: **0** skills ever dropped, **100%** of skills stay
loadable, behavioural/critical skills are kept full every time, output is
deterministic, and average savings are ~70%. Run `npm run bench` to reproduce,
or `npm run measure <capture.json>` for exact numbers on a captured real request.

### `tail: name` vs `tail: intent`

The `tail` style only changes how **non-selected** skills are rendered — it does
**not** change which skills are selected (scoring always runs over the full
descriptions). In the benchmark both styles give the **same selection quality**
(P=100%, full recall) but `name` saves roughly **twice** as many tokens. So
`name` is the default: same discovery quality, lower cost. Use `tail: intent`
only if you want the model to read a short description for *every* skill (richer
breadcrumbs for the long tail) and can afford ~half the savings.

## Tools array (opt-in)

The `tools` array (built-in + MCP tool definitions) is often *larger* than the
skills catalog — with several MCP servers connected it can run to tens of
thousands of tokens, most of it irrelevant to any single task.

> [!WARNING]
> **Tools are riskier than skills.** A skill removed from the catalog is still
> invokable by name; a tool removed from `tools` is **not callable at all** — no
> fallback within the turn. So tool slimming is **off by default** and heavily
> guarded: core tools are never dropped, and any tool already **used in the
> conversation** is kept (so nothing vanishes mid-task).

`PI_SKILL_OPTIMIZER_TOOLS_MODE`:

- `drop` (recommended): remove only the server prefixes you list — deterministic,
  predictable, cache-stable.
- `relevance`: keep core + used + the top-K query-relevant of the rest (dynamic;
  a relevance miss means a tool the model wanted isn't available — use a generous
  `TOP_K`).

Combined, slimming skills (`hybrid`) and tools (`drop`/`relevance`) compounds:
skills typically save the majority of the catalog, and dropping unused MCP server
prefixes removes most of the remaining tool tokens. Tool relevance is targeted —
for a "search the web and index docs" query the
web-search and indexing MCP tools score highest and are kept, while unrelated
servers' tools are dropped; for a task no MCP server matches, only core tools and
skills remain.

## Install

```bash
pi install pi-skill-optimizer
pi list
```

Pi provides the `@earendil-works/*` peer deps; `npm install` is only for
development. Try it for one run: `pi -e pi-skill-optimizer`.

## Usage

Install it — it runs automatically (default `hybrid`). The footer shows
`✂ −Nk tok` when it trims a request; `/skill-optimizer` prints diagnostics
(mode, last savings, which skills were kept full).

Optional retrieval-profile initialization:

```bash
/skill-optimizer init
```

This asks the current model to generate a compact retrieval profile from the
skills loaded in this Pi session. It is then **split by skill scope**, mirroring
how Pi loads skills:

- skills from the global install (`~/.pi/agent/skills`) → `~/.pi/agent/skill-optimizer/profile.json`
- skills from the project (`<cwd>/.pi/skills`) → `<cwd>/.pi/skill-optimizer/profile.json` (only written when the project has its own skills)

At runtime both files are loaded and **merged** (project extends global), then
filtered against the active catalog. The profile contains aliases, synthetic
user queries, critical skills, clusters, and negative hints. Normal requests do
not call the model; they only load these local files. A global
`~/.pi/agent/skill-optimizer/usage.json` tracks conservative usage signals
(explicit skill mentions or real skill-tool activations, deduplicated per
prompt) so frequently useful skills can stay full without letting the ranker
reinforce itself. Override the layout with `PI_SKILL_OPTIMIZER_PROFILE` /
`PI_SKILL_OPTIMIZER_USAGE` (an explicit path collapses the split onto a single
file).

### Incremental re-runs

`init` is **incremental**. Each skill is hashed (name + description) and the
hashes are stored in the profile. Re-running `/skill-optimizer init`:

- sends only **new or modified** skills to the model,
- **prunes** skills that disappeared from the catalog,
- and is a **no-op** (no model call) when nothing changed.

When the optimizer itself is upgraded and its init logic changes (an internal
`initVersion` bump), the next `init` does a **full regeneration** automatically,
ignoring the cached hashes — so profile semantics never drift across versions.

## Configuration

The primary way to configure the optimizer is a **`config.json`** file. On first
run it auto-creates a documented template at
`~/.pi/agent/skill-optimizer/config.json` (global). Edit it to change behaviour —
no env vars required.

For a single project, drop a `config.json` in `<project>/.pi/skill-optimizer/`;
it is merged over the global one (**project keys win**).

```jsonc
// ~/.pi/agent/skill-optimizer/config.json
{
  "disable": false,
  "mode": "hybrid",       // off | compact | hybrid
  "topK": 20,             // hybrid: skills kept full (name + description + location)
  "tail": "name",         // name | intent  (how the rest are rendered)
  "alwaysFull": [],       // skill names to always keep full
  "never": [],            // skill names / "prefix*" to hide entirely
  "providers": [],        // scope to model.provider ids; [] = all
  "pinnedTopK": 8,        // usage-derived skills kept full
  "toolsMode": "off",     // off | drop | relevance
  "toolsDrop": [],        // drop: tool name prefixes to remove
  "toolsTopK": 24,        // relevance: non-core tools to keep
  "toolsProtect": []      // extra protected tool names/prefixes
}
```

**Resolution order for every setting:** env var > project `config.json` > global
`config.json` > built-in default. The env vars below still work and override the
files (handy for one-off runs).

| Env var | Default | Purpose |
|---------|---------|---------|
| `PI_SKILL_OPTIMIZER_DISABLE` | _(off)_ | Any non-empty value turns it off. |
| `PI_SKILL_OPTIMIZER_MODE` | `hybrid` | `off` \| `compact` \| `hybrid`. |
| `PI_SKILL_OPTIMIZER_TOP_K` | `20` | hybrid: skills kept full (name + description + location). |
| `PI_SKILL_OPTIMIZER_TAIL` | `name` | `name` \| `intent` — how non-selected skills render. |
| `PI_SKILL_OPTIMIZER_ALWAYS_FULL` | `[]` | JSON array of skill names to always keep full. |
| `PI_SKILL_OPTIMIZER_NEVER` | `[]` | JSON array of skill names / `"prefix*"` to hide entirely. |
| `PI_SKILL_OPTIMIZER_PROVIDERS` | _(all)_ | Comma list of `model.provider` ids to scope to. |
| `PI_SKILL_OPTIMIZER_PROFILE` | `<agentDir>/skill-optimizer/profile.json` + `<cwd>/.pi/skill-optimizer/profile.json` | Override path (collapses the global/project split onto one file). |
| `PI_SKILL_OPTIMIZER_USAGE` | `<agentDir>/skill-optimizer/usage.json` | Override path for pinned skill usage stats (global). |
| `PI_SKILL_OPTIMIZER_PINNED_TOP_K` | `8` | Usage-derived skills always kept full. |
| `PI_SKILL_OPTIMIZER_TOOLS_MODE` | `off` | `off` \| `drop` \| `relevance` (see Tools array above). |
| `PI_SKILL_OPTIMIZER_TOOLS_DROP` | `[]` | `drop` mode: JSON array of tool name prefixes to remove (e.g. `["serverA_","serverB_"]`). |
| `PI_SKILL_OPTIMIZER_TOOLS_TOP_K` | `24` | `relevance` mode: non-core tools to keep. |
| `PI_SKILL_OPTIMIZER_TOOLS_PROTECT` | `[]` | Extra protected tool names/prefixes (on top of the core set + used tools). |

```bash
PI_SKILL_OPTIMIZER_TAIL=intent pi          # keep a short description on tail skills too
PI_SKILL_OPTIMIZER_TOP_K=28 pi             # more full promoted skills
PI_SKILL_OPTIMIZER_MODE=compact pi         # keep all skills at intent, cache-stable
PI_SKILL_OPTIMIZER_PROVIDERS=claude-pro-max-native pi  # only the Claude provider
```

### Caching note

`hybrid` rebuilds the catalog from the query, so the system prompt's cached
prefix is preserved only up to the catalog; the catalog itself is recomputed per
turn. Because the catalog shrinks ~80%, the non-cacheable segment is far smaller.
For maximum cache stability use `compact` (query-independent) or `off`.

## Development

```bash
npm install
npm run typecheck
npm test           # node --test on the pure modules (incl. fuzz invariants)
npm run bench      # reproducible synthetic benchmark (savings, invariants, fuzz)
npm run measure    # exact numbers on a captured real request
```

`src/skills.ts` and `src/optimize.ts` are pure (no Pi imports) and unit-tested.
See [AGENTS.md](AGENTS.md) for architecture.

## Roadmap

- **Embeddings** for semantic ranking (beyond lexical) — better recall on
  paraphrased queries.
- **SQLite FTS5/BM25 index** for very large catalogs. The current in-memory BM25
  path is simpler and has no dependency; SQLite may be worthwhile for 1K+ skills.
- **On-demand `search_skills` tool** (RAG-MCP style): strip the catalog to ~0 and
  let the model retrieve skills by calling a tool — maximum upfront savings.

## License

MIT
