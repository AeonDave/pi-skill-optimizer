# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## 1.0.0

First stable release.

### Skills catalog
- `hybrid` (default): dependency-free BM25 ranking over the full descriptions;
  top-K full (name + description + explicit `<location>`), the rest name-only
  with a single shared `<skill_path_note>` — every skill stays discoverable and
  loadable. ~67% catalog savings with 100% loadability in a 3000-query fuzz.
- `compact`: keep every skill, trimmed to its intent sentence; query-independent
  (cache-stable).
- Adaptive top-K, `alwaysFull` allowlist, `never` denylist, usage-based pinning,
  and `init`-generated retrieval profiles (aliases, synthetic queries, critical
  skills, clusters, negative hints).
- Behavioural / always-on skills are classified into `critical` at `init` time
  (opt-in/triggered modes excluded); tail `intent` keeps the routing clause
  ("Use when …") not just the first sentence.

### Tools array (opt-in)
- `drop` (prefixes) and `relevance` (top-K) modes; core tools and tools already
  used in the conversation are never dropped.

### Tool-output reduction (transparent, at `tool_result`)
- `smart` (default): deterministic head/tail + error/stack/exit-line keep with
  counted elision; full output saved to a temp file. Free, cross-OS, CRLF-safe.
- `extract` (opt-in): query-aware "intelligent grep" via the selected model
  (verbatim selection, errors kept, fails open to `smart`); data-dump commands
  excluded.

### Provider-agnostic & ops
- Rewrites the catalog wherever the provider puts the system prompt: Anthropic
  `system`, Gemini `systemInstruction`, OpenAI Responses `instructions`,
  OpenAI/Mistral `system`/`developer` messages, and tool descriptions.
- Granular savings telemetry (skills / tools / output, session + lifetime) in
  `/skill-optimizer`, persisted to `stats.json`.
- Global + project `config.json` (project wins) with env overrides; profiles and
  usage split global vs project; incremental, hash-based `init` with version-gated
  full regeneration.
- Auto-coexistence with `rtk`-style extensions: output reduction auto-deactivates
  when an `rtk`-named extension is detected (skills/tools slimming stay active);
  override with `outputDisableWithRtk`.
