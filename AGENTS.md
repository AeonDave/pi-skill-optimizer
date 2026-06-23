# AGENTS.md

Pi extension that slims the system prompt before each request to cut input-token
cost, by intelligently rewriting the `<available_skills>` catalog rather than
nuking it. TypeScript, loaded by Pi via jiti (no build step).

## Commands

```bash
npm install
npm run typecheck                 # tsc --noEmit (uses real @earendil-works/* types)
npm test                          # node --test on the pure modules
npm run measure [capture.json]    # real token savings + relevance on a captured catalog
pi -e ./src/index.ts              # live-load in Pi for manual testing
```

## Architecture

- `src/skills.ts` — **pure**, the catalog intelligence:
  - `parseSkills` / `BLOCK_RE` — parse `<available_skills>` (name, description, location).
  - `tokenize` + `scoreSkills` — dependency-free BM25 lexical ranking with name-match boosts.
  - `selectRelevant`, `compactDescription`, `renderSkill`, `transformSkillsInText` — rebuild the block (`compact`/`hybrid`).
  - `extractQuery` — pull the query (first + last user text) from `messages`.
- `src/profile.ts` — **pure**, normalizes `/skill-optimizer init` output (aliases,
  critical skills, synthetic queries, clusters, negative hints).
- `src/usage.ts` — **pure**, normalizes pinned-skill usage stats and derives
  conservative recordable usage from explicit mentions / real skill-tool calls.
- `src/aliases.ts` — **pure**, built-in and profile-generated alias normalization,
  filtered against the user's active catalog before scoring.
- `src/tools.ts` — **pure**, the `tools`-array slimmer: `optimizeTools` (modes
  `drop` by prefix / `relevance` by lexical score) with a generous `CORE_TOOLS`
  protected set; `collectUsedToolNames` keeps any tool already used in the
  conversation. Off by default.
- `src/optimize.ts` — **pure** orchestration: `optimize(payload, config)` walks every
  system text block AND tool description, applies the skill rewrite (off/strip/compact/hybrid)
  plus extra tag-block / paragraph removal, then slims the `tools` array, and returns
  `{ next, removed, selected, droppedTools }`.
- `src/config.ts` — env-driven `OptimizeConfig` (`getConfig`), `isDisabled`, `getScopeProviders`.
- `src/index.ts` — factory: a `before_provider_request` hook (scoped + enabled), footer
  status, and the `/skill-optimizer` diagnostics command.
- `scripts/measure.ts` — runs the optimizer over a captured request body to report
  real char/token savings per mode and the skills selected per sample query.

## Key invariants (do not break)

- **Score on full, render compacted.** Relevance is computed over the *full*
  descriptions plus generated query hints, so a relevant skill is always promoted
  to full regardless of how cryptic its name is; only the irrelevant tail is
  compacted/dropped. Never score on the already-compacted text.
- **Names always survive; loading needs the location.** Pi has no `Skill` tool —
  the model loads a skill by `read`-ing its `<location>` (and explicit
  `/skill:name` expands from the on-disk registry, catalog-independent).
  `compact`/`hybrid` keep every `<name>` so the model stays *aware* of every
  skill, and promoted (relevant/critical/pinned) skills keep their `<location>` so
  they are *loadable*. A name-only tail entry is intentionally not model-loadable
  (that is the saving); `KEEP_LOCATIONS` restores loadability for all. Only `strip`
  removes names entirely (and advertises "no discovery").
- **Quality guardrails over raw savings.** Hybrid must keep critical and pinned
  skills full, adapt top-K upward on ambiguous close scores, and use a short-tail
  fallback when the query has no lexical signal.
- **Pinned usage must be conservative.** Do not record every ranked/selected
  skill as usage; only explicit user mentions or observed skill-tool invocations
  should feed the pinned-skill file, deduped across provider tool loops.
- **Remove/compact only, never rewrite.** Surviving description text is verbatim;
  the module must not paraphrase or reorder it. Keep `skills.ts`/`optimize.ts`
  pure and tested.
- **Catalog can live in system or a tool description.** Scan both (Pi puts it in
  the system prompt; genuine Claude Code puts it in the `Skill` tool description).
- **Tools have no fallback — guard hard.** A skill dropped from the catalog is
  still invokable by name; a tool dropped from `tools` is *not callable at all*.
  So tool slimming is OFF by default, never drops `CORE_TOOLS`, and never drops a
  tool present in `collectUsedToolNames(messages)`. Prefer `drop` (explicit
  prefixes) over `relevance` (a miss removes a tool the model wanted).
- **Identity-return.** Return the original reference / `undefined` from the hook
  when nothing changed (detected by reference), and honor `PI_SKILL_OPTIMIZER_DISABLE`.

## Relationship to pi-claude

This is the general, provider-agnostic **token** optimizer. It is intentionally
separate from `pi-claude` (Claude Pro/Max Native): that extension keeps only the
system-prompt edit it *needs* to function (removing Pi's "Pi documentation"
paragraph, which trips Anthropic's third-party classifier). Skill-catalog
trimming benefits any provider, so it lives here. The two coexist cleanly — both
hook `before_provider_request`; this one only touches `<available_skills>` (and
configured extra tags/paragraphs), never the billing header or identity blocks.

## Testing

- `skills.ts` / `optimize.ts` changes: add/update `test/skills.test.ts` /
  `test/optimize.test.ts` (`npm test`), then re-run `npm run measure` to confirm
  the savings/relevance numbers still hold.
- Hook/config changes: `npm run typecheck`, then verify in Pi with
  `pi -e ./src/index.ts` and `/skill-optimizer` (footer shows `✂ −Nk tok`).
