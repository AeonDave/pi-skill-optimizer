# pi-skill-optimizer

A [Pi](https://github.com/earendil-works/pi-mono) extension that cuts
**input-token cost** every request — slimming the `<available_skills>` catalog,
the `tools` array, and noisy tool output — **without hiding your skills** from
the model.

## Why

Pi inlines an `<available_skills>` catalog (name, description, location per skill)
into the system prompt of **every** request. With a few hundred skills that is
tens of thousands of tokens, repeated each turn — usually the biggest input cost.
This extension rewrites it intelligently instead of nuking it, and adds two more
token levers (tools array, tool output).

## Optimizations at a glance

| Optimization | Gain | Loss / risk | Resilience | Notes |
|---|---|---|---|---|
| **Skills — `hybrid`** (default) | **~67%** of catalog | none — every skill stays discoverable **and** loadable | fuzz 3k queries: **0 dropped, 100% loadable**, deterministic; critical/pinned/alwaysFull always full | BM25 rank over full descriptions; top-K full, rest name-only + **one shared path note** |
| **Skills — `compact`** | ~20% | none | query-independent → **cache-stable** | every skill kept, trimmed to intent + routing clause |
| **Tools array — `drop` / `relevance`** (opt-in) | most remaining MCP tool tokens | a dropped tool isn't callable this turn | core tools + already-used tools **never** dropped | off by default; `drop` is deterministic/cache-stable |
| **Tool output — `smart`** (default) | **~73–88%** on noisy output | none — full output saved to a temp file | errors/stack/exit-code always kept; **no silent loss** (counted elision); deterministic | free, cache-stable, cross-OS, CRLF-safe |
| **Tool output — `extract`** (opt-in) | **~90–99%** on big *data*, request-ready | latency + tokens, non-deterministic | **fails open to `smart`**; errors verbatim; full output on temp file; data-dump cmds excluded | LLM "intelligent grep" via the selected model |

Supporting: **provider-agnostic** (works on Anthropic / Gemini / OpenAI / Mistral
payloads), **granular savings telemetry** (`/skill-optimizer`), and an
**incremental `init`**. Reproduce with `npm run bench`.

## Discovery is never lost

- **`hybrid`/`compact` keep every skill name.** Tail skills drop only their
  derivable `<location>`, replaced by one `<skill_path_note>` declaring the roots
  (`<root>/<name>/SKILL.md`) — the model can still load any of them. Irregular
  paths keep an explicit `<location>`.
- **`/skill:name` is unaffected** — Pi expands it from the on-disk registry,
  independent of the catalog.
- **`never`** removes skills you don't want; **`off`** leaves the catalog untouched.

### Behavioural / always-on skills

Operator-mode and discipline skills (planning, verification, "forces explicit
reasoning") never match a task query by keyword. `init` classifies these into
`critical` (always rendered full); opt-in/triggered modes are excluded.
`alwaysFull` is a manual override on top.

## Tool-output reduction

Shrinks noisy tool output (e.g. long `bash` stdout) **transparently** at
`tool_result` time — no native binary, no tool calls, pure TS, cross-OS. The
**full output is always saved to a temp file** and referenced inline, so nothing
is lost.

```jsonc
{
  "outputMode": "smart",       // off | smart | extract
  "outputMaxLines": 400,       // only reduce results larger than this
  "outputTools": ["bash"],     // which tools' results to reduce
  "outputModel": "",           // extract: "provider/id" or empty = selected model
  "outputExtractExclude": ["cat","ls","head","tail","tree","find","dir","type"]
}
```

- **`smart`** keeps head + tail + every error/warning/stack/exit line, elides the
  middle with a counted marker. Free, deterministic.
- **`extract`** asks a model to return only the **verbatim lines relevant to the
  originating request** (no prose). Errors stay verbatim; fails open to `smart`;
  pure data-dump commands (`outputExtractExclude`) stay on `smart`.

## Install

Install from GitHub (recommended):

```bash
pi install git:github.com/AeonDave/pi-skill-optimizer
```

To modify or test it, install from a local clone instead:

```bash
git clone https://github.com/AeonDave/pi-skill-optimizer
cd pi-skill-optimizer
npm install        # dev deps, for tests/bench
pi install .       # or an absolute path to the clone
```

Pi supplies the `@earendil-works/*` peer deps at runtime. To try it for a single
run without installing, use `-e`:

```bash
pi -e git:github.com/AeonDave/pi-skill-optimizer
```

## Usage

Runs automatically (default `hybrid` + output `smart`). The footer shows
`✂ −Nk tok`; **`/skill-optimizer`** prints diagnostics and **granular telemetry**
— tokens saved this session and lifetime, split by **skills / tools / output**
(persisted to `~/.pi/agent/skill-optimizer/stats.json`).

### `init` (optional retrieval profile)

```bash
/skill-optimizer init
```

Generates a compact retrieval profile (aliases, synthetic queries, critical
skills, clusters, negative hints) from the loaded skills, **split by scope**:
global skills → `~/.pi/agent/skill-optimizer/profile.json`, project skills →
`<cwd>/.pi/skill-optimizer/profile.json` (merged at runtime, project wins).
Normal requests never call the model — they only load these files.

`init` is **incremental** (hashes each skill): re-running processes only new/
changed skills, prunes removed ones, and is a no-op when nothing changed. An
internal `initVersion` bump forces a full regeneration after an upgrade.

## Configuration

A **`config.json`** is auto-created at `~/.pi/agent/skill-optimizer/config.json`
on first run. A project `config.json` in `<cwd>/.pi/skill-optimizer/` merges over
it (project wins). **Resolution: env var > project file > global file > default.**

```jsonc
{
  "disable": false,
  "mode": "hybrid",       // off | compact | hybrid
  "topK": 20,             // hybrid: skills kept full
  "tail": "name",         // name | intent  (how non-selected skills render)
  "alwaysFull": [],       // skill names to always keep full
  "never": [],            // skill names / "prefix*" to hide entirely
  "providers": [],        // scope to model.provider ids; [] = all
  "pinnedTopK": 8,        // usage-derived skills kept full
  "toolsMode": "off",     // off | drop | relevance
  "toolsDrop": [],        // drop: tool name prefixes to remove
  "toolsTopK": 24,        // relevance: non-core tools to keep
  "toolsProtect": [],     // extra protected tool names/prefixes
  "outputMode": "smart",  // off | smart | extract
  "outputMaxLines": 400,
  "outputTools": ["bash"],
  "outputModel": "",
  "outputExtractExclude": ["cat","ls","head","tail","tree","find","dir","type"]
}
```

Every key has an env override: `PI_SKILL_OPTIMIZER_<KEY>` (e.g. `MODE`, `TOP_K`,
`TAIL`, `ALWAYS_FULL`, `NEVER`, `PROVIDERS`, `TOOLS_MODE`, `TOOLS_DROP`,
`OUTPUT`, `OUTPUT_MODEL`, `OUTPUT_EXCLUDE`). Path overrides:
`PI_SKILL_OPTIMIZER_{PROFILE,USAGE,STATS}`. `PI_SKILL_OPTIMIZER_DISABLE` turns it
off entirely.

> Tools slimming is **off by default**: a dropped tool can't be called this turn
> (skills always can). `drop <prefixes>` is the safe, deterministic choice.

> `hybrid` recomputes the catalog per query, so the cached prefix holds only up
> to the catalog; since it shrinks ~80% the non-cacheable part is small. Use
> `compact` or `off` for maximum cache stability.

## Development

```bash
npm test           # node --test, pure modules + fuzz invariants
npm run typecheck
npm run bench      # reproducible synthetic benchmark (savings, invariants, fuzz)
npm run measure <capture.json>   # exact numbers on a captured real request
```

Pure, unit-tested modules (no Pi imports): `optimize`, `skills`, `tools`,
`profile`, `output`, `stats`, `aliases`, `usage`, `config`. See
[AGENTS.md](AGENTS.md) for architecture.

## Roadmap

- Embeddings / SQLite FTS5 ranking for very large (1K+) catalogs.
- On-demand `search_skills` tool (RAG-MCP) to strip the catalog to ~0.

## License

MIT
