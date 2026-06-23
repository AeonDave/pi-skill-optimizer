/**
 * Pure tool-array slimming — no Pi imports, fully unit-testable.
 *
 * The `tools` array (built-in + MCP tool definitions: name, description,
 * input_schema) is a major input-token cost — often *larger* than the skills
 * catalog (measured ~28K tokens for 113 tools, 105 of them from MCP servers like
 * `htb_*` (57!), `mcpwn_*`, `ctx_*`, `tavily_*`).
 *
 * CRITICAL difference from skills: a skill dropped from the catalog is still
 * invokable by name (fallback); a tool dropped from `tools` is **not callable at
 * all** — there is no fallback within the turn. So this is conservative and
 * OPT-IN:
 *   - core tools are never dropped (a generous built-in protected set);
 *   - any tool already used in the conversation is kept (so nothing vanishes
 *     mid-task);
 *   - `drop` mode removes only the server prefixes you explicitly list
 *     (deterministic, cache-stable, predictable);
 *   - `relevance` mode keeps core + used + the top-K query-relevant of the rest.
 */

import { tokenize } from "./skills.ts";

export type ToolsMode = "off" | "drop" | "relevance";

export interface Tool {
	name: string;
	description?: string;
	[key: string]: unknown;
}

export interface ToolsOptions {
	mode: "drop" | "relevance"; // "off" handled by caller
	/** drop mode: remove tools whose name equals or starts with one of these. */
	dropPrefixes: readonly string[];
	/** relevance mode: keep this many of the non-protected, query-relevant tools. */
	topK: number;
	/** Extra protected names/prefixes (kept on top of the core set + used tools). */
	protect: readonly string[];
	/** Tool names already used in the conversation — always kept. */
	keepNames: ReadonlySet<string>;
	/** Query text for relevance ranking. */
	query: string;
}

export interface ToolsResult {
	tools: unknown[];
	removed: number;
	dropped: string[];
}

/**
 * Generous, case-insensitive set of core/agent tool names that must never be
 * dropped. Errs on the side of keeping a tool callable.
 */
export const CORE_TOOLS = new Set(
	[
		"read", "bash", "edit", "write", "multiedit", "str_replace_editor", "notebookedit",
		"glob", "grep", "ls", "find", "todo", "todowrite", "todoread",
		"subagent", "fork", "task", "mcp", "skill", "exitplanmode", "enterplanmode",
		"webfetch", "websearch", "askuserquestion", "powershell",
	].map((s) => s.toLowerCase()),
);

function matchesAny(name: string, patterns: readonly string[]): boolean {
	return patterns.some((p) => p.length > 0 && (name === p || name.startsWith(p)));
}

function isProtected(name: string, protect: readonly string[], keepNames: ReadonlySet<string>): boolean {
	return CORE_TOOLS.has(name.toLowerCase()) || keepNames.has(name) || matchesAny(name, protect);
}

function isTool(value: unknown): value is Tool {
	return !!value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string";
}

/** Lexical IDF score of each tool (name + description) against the query terms. */
function scoreTools(tools: readonly Tool[], queryTokens: readonly string[]): number[] {
	const n = tools.length;
	const sets = tools.map((t) => new Set(tokenize(`${t.name} ${t.description ?? ""}`)));
	const nameSets = tools.map((t) => new Set(tokenize(t.name)));
	const df = new Map<string, number>();
	for (const set of sets) for (const term of set) df.set(term, (df.get(term) ?? 0) + 1);
	const idf = (term: string) => Math.log(1 + n / (1 + (df.get(term) ?? 0)));
	const terms = new Set(queryTokens);
	return sets.map((set, i) => {
		let score = 0;
		for (const term of terms) {
			if (set.has(term)) score += idf(term);
			if (nameSets[i].has(term)) score += 2 * idf(term);
		}
		return score;
	});
}

/** Collect tool names referenced by `tool_use` blocks anywhere in the messages. */
export function collectUsedToolNames(messages: unknown): Set<string> {
	const used = new Set<string>();
	if (!Array.isArray(messages)) return used;
	for (const message of messages) {
		const content = (message as { content?: unknown })?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const b = block as { type?: unknown; name?: unknown };
			if (b?.type === "tool_use" && typeof b.name === "string") used.add(b.name);
		}
	}
	return used;
}

/**
 * Slim a `tools` array. Returns the original reference (and `removed: 0`) when
 * nothing was dropped. Order of kept tools is preserved. Pure.
 */
export function optimizeTools(tools: unknown, opts: ToolsOptions): ToolsResult {
	if (!Array.isArray(tools)) return { tools: tools as unknown[], removed: 0, dropped: [] };

	const keepIndex = new Set<number>();
	const dropped: string[] = [];

	if (opts.mode === "drop") {
		tools.forEach((tool, i) => {
			const name = isTool(tool) ? tool.name : "";
			if (!isProtected(name, opts.protect, opts.keepNames) && matchesAny(name, opts.dropPrefixes)) {
				dropped.push(name);
			} else {
				keepIndex.add(i);
			}
		});
	} else {
		const candidates: { tool: Tool; i: number }[] = [];
		tools.forEach((tool, i) => {
			if (!isTool(tool)) {
				keepIndex.add(i);
				return;
			}
			const name = tool.name;
			if (isProtected(name, opts.protect, opts.keepNames)) keepIndex.add(i);
			else candidates.push({ tool, i });
		});
		const scores = scoreTools(candidates.map((c) => c.tool), tokenize(opts.query));
		const selected = scores
			.map((score, idx) => ({ score, idx }))
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, Math.max(0, opts.topK))
			.map((x) => x.idx);
		const selectedSet = new Set(selected);
		candidates.forEach((c, idx) => {
			if (selectedSet.has(idx)) keepIndex.add(c.i);
			else dropped.push(c.tool.name);
		});
	}

	if (dropped.length === 0) return { tools, removed: 0, dropped: [] };
	const kept = tools.filter((_, i) => keepIndex.has(i));
	const removed = JSON.stringify(tools).length - JSON.stringify(kept).length;
	return { tools: kept, removed, dropped };
}
