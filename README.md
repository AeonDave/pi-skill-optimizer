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
large install it's the single biggest input-token cost and it repeats **every
turn** — measured at ~110K chars (~27K tokens) for 331 skills, ~86% of the
system prompt.

Instead of nuking the catalog (and losing skill discovery), this extension
**rewrites it intelligently**.

## What it does (modes)

On `before_provider_request`, for the `<available_skills>` catalog (in the system
prompt *or* a tool description):

| `mode` | Behaviour | Discovery |
|--------|-----------|-----------|
| `hybrid` (default) | BM25-rank skills against the request query; keep relevant, pinned, and critical skills at full description, render the rest **name-only** unless the query is weak/ambiguous. | Full — every name stays |
| `compact` | Keep **every** skill, trim each description to its intent sentence. | Full + short intent |
| `strip` | Remove the catalog entirely. | None |
| `off` | Leave the catalog untouched. | Full |

The ranking (`hybrid`) is dependency-free BM25 lexical retrieval over the catalog
itself, with name-match boosts and catalog-filtered aliases. **Crucially, scoring
runs over the full descriptions**, so a relevant skill is promoted to full even
when the rendered tail is compacted. Hybrid is adaptive: clear queries keep a
tighter set, ambiguous close-score queries keep more full descriptions, and weak
queries fall back to short tail descriptions instead of pure name-only. Pinned
skills from local usage stats and critical skills from `/skill-optimizer init`
also stay full.

> [!NOTE]
> Pi has **no `Skill` tool**: the model discovers a skill from the
> `<available_skills>` catalog and loads it by `read`-ing its `<location>` path —
> the catalog is the only *proactive* discovery surface. So:
>
> - **Explicit `/skill:name` invocation is unaffected.** Pi expands it from the
>   on-disk skill registry *before* the request is built, independent of the
>   catalog (it even works for skills hidden from it). Trimming the catalog never
>   breaks `/skill:name`.
> - **Proactive (model-chosen) discovery** rides on the catalog. `hybrid`/`compact`
>   keep every name, and relevant/critical/pinned skills stay full (name +
>   description + **location**), so the model can load them. A scorer-missed *tail*
>   skill is name-only (no location) — visible but not model-loadable until a later
>   turn re-ranks it; set `PI_SKILL_OPTIMIZER_KEEP_LOCATIONS=1` to keep every skill
>   loadable, or just use `/skill:name`. `strip` removes proactive discovery
>   entirely (only `/skill:name` works).

## Measured savings

On a real 331-skill catalog (`npm run measure`), system prompt ~32,131 tokens:

| config | ~tokens | saved | discovery |
|--------|--------:|------:|-----------|
| `off` | 32,131 | 0% | full |
| `compact` (tail=80) | 17,502 | 46% | full + short intent |
| **`hybrid` (default, adaptive 8-24, tail=0)** | **~9,600** | **~70%** | **full names + adaptive relevant full** |
| `strip` | 4,671 | 85% | none |

End-to-end (`pi -e` + a real query "recover a weak RSA key…"): system prompt
~32K → ~10.9K tokens (~66%), all 331 names present, 16 relevant skills full, and
the model correctly answered "Run RsaCtfTool against n,e."

Relevance is accurate — selected full skills per query:

```
"recover a weak RSA private key"        → rsactftool, openssl, crypto-technique, crypto-ctf, ssh-key-scanner
"refactor this Python module, add tests"→ python-testing, python-patterns, python-async-patterns, python-reverse
"analyze an Android APK"                → androguard, apktool, mobile-ctf
"crack an NTLM hash and spray SMB"      → name-that-hash, impacket, inveigh, responder, active-directory-technique
```

## Tools array (opt-in)

The `tools` array (built-in + MCP tool definitions) is often *larger* than the
skills catalog — measured ~28K tokens for 113 tools, **105 of them from MCP
servers**. Most are irrelevant to any single task.

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

Combined savings on the real 113-tool request (system + tools, ~60.6K tokens):

| config | ~tokens | saved | tools dropped |
|--------|--------:|------:|--------------:|
| `off` | 60,616 | 0% | 0 |
| skills `hybrid` (default) | 38,434 | 37% | 0 |
| + tools `drop` `xxx_` | 28,045 | 54% | 80 |
| + tools `relevance` (top-8) | 18,696 | 69% | 102 |

Tool relevance is accurate — for a "search the web and index docs" query the
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
skills loaded in this Pi session, then writes
`.pi-skill-optimizer.profile.json` in the current working directory. The profile
contains aliases, synthetic user queries, critical skills, clusters, and negative
hints. Normal requests do not call the model; they only load this local file and
filter it against the active catalog. A separate
`.pi-skill-optimizer.usage.json` tracks conservative usage signals (explicit
skill mentions or real skill-tool activations, deduplicated per prompt) so
frequently useful skills can stay full without letting the ranker reinforce
itself.

## Configuration

All optional.

| Env var | Default | Purpose |
|---------|---------|---------|
| `PI_SKILL_OPTIMIZER_DISABLE` | _(off)_ | Any non-empty value turns it off. |
| `PI_SKILL_OPTIMIZER_MODE` | `hybrid` | `off` \| `strip` \| `compact` \| `hybrid`. |
| `PI_SKILL_OPTIMIZER_TOP_K` | `16` | hybrid: relevant skills kept at full description. |
| `PI_SKILL_OPTIMIZER_ADAPTIVE` | `1` | Adapt top-K upward for ambiguous close scores. |
| `PI_SKILL_OPTIMIZER_MIN_TOP_K` | `8` | Adaptive minimum full relevant skills. |
| `PI_SKILL_OPTIMIZER_MAX_TOP_K` | `24` | Adaptive maximum full relevant skills. |
| `PI_SKILL_OPTIMIZER_TAIL_CHARS` | `0` | Max chars for a compacted description (`0` = name-only). |
| `PI_SKILL_OPTIMIZER_FALLBACK_TAIL` | `80` | Weak-query fallback: short tail descriptions instead of name-only. |
| `PI_SKILL_OPTIMIZER_KEEP_LOCATIONS` | _(off)_ | Keep `<location>` on name-only tail entries, so the model can `read`/load *any* skill (not just promoted ones) — larger prompt. |
| `PI_SKILL_OPTIMIZER_STRIP` | `[]` | JSON array of *extra* XML tag blocks to remove. |
| `PI_SKILL_OPTIMIZER_ANCHORS` | `[]` | JSON array of substrings; drop whole paragraphs containing one. |
| `PI_SKILL_OPTIMIZER_PROVIDERS` | _(all)_ | Comma list of `model.provider` ids to scope to. |
| `PI_SKILL_OPTIMIZER_PROFILE` | `./.pi-skill-optimizer.profile.json` | Retrieval profile JSON path, relative to Pi cwd unless absolute. |
| `PI_SKILL_OPTIMIZER_USAGE` | `./.pi-skill-optimizer.usage.json` | Pinned skill usage stats path. |
| `PI_SKILL_OPTIMIZER_PINNED_TOP_K` | `8` | Usage-derived skills always kept full. |
| `PI_SKILL_OPTIMIZER_TOOLS_MODE` | `off` | `off` \| `drop` \| `relevance` (see Tools array above). |
| `PI_SKILL_OPTIMIZER_TOOLS_DROP` | `[]` | `drop` mode: JSON array of tool name prefixes to remove (e.g. `["serverA_","serverB_"]`). |
| `PI_SKILL_OPTIMIZER_TOOLS_TOP_K` | `24` | `relevance` mode: non-core tools to keep. |
| `PI_SKILL_OPTIMIZER_TOOLS_PROTECT` | `[]` | Extra protected tool names/prefixes (on top of the core set + used tools). |

```bash
PI_SKILL_OPTIMIZER_MODE=compact PI_SKILL_OPTIMIZER_TAIL_CHARS=80 pi   # keep all, short intents
PI_SKILL_OPTIMIZER_TOP_K=24 pi                                        # safer hybrid (more full)
PI_SKILL_OPTIMIZER_PROVIDERS=claude-pro-max-native pi                 # only the Claude provider
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
npm test           # node --test on the pure modules
npm run measure    # real numbers on a captured catalog
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
