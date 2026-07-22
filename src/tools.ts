/** Pure, conservative tool-array slimming. Dropped tools are not callable. */

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
	/** JSON-serialized characters removed from the tools array. */
	removedChars: number;
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

/** Read Anthropic/Responses or nested OpenAI Chat function definitions. */
export function getToolDefinition(value: unknown): Tool | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.name === "string") return record as Tool;
	const fn = record.function;
	if (fn && typeof fn === "object" && typeof (fn as { name?: unknown }).name === "string") return fn as Tool;
	return undefined;
}

/** Immutably replace a top-level or nested OpenAI Chat tool description. */
export function replaceToolDescription(value: unknown, description: string): unknown {
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (typeof record.name === "string") return { ...record, description };
	const fn = record.function;
	if (fn && typeof fn === "object" && typeof (fn as { name?: unknown }).name === "string") {
		return { ...record, function: { ...(fn as Record<string, unknown>), description } };
	}
	return value;
}

const MAX_SCHEMA_SEARCH_CHARS = 2_048;
const MAX_SCHEMA_SEARCH_NODES = 96;
const MAX_SCHEMA_SEARCH_DEPTH = 4;

/** Extract only routing-relevant schema text under strict size/depth bounds. */
function schemaSearchText(tool: Tool): string {
	const schema = tool.input_schema ?? tool.inputSchema ?? tool.parameters;
	if (!schema || typeof schema !== "object") return "";
	const chunks: string[] = [];
	let chars = 0;
	let nodes = 0;
	const append = (value: unknown): void => {
		if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") || chars >= MAX_SCHEMA_SEARCH_CHARS) return;
		const text = String(value)
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/[_-]+/g, " ")
			.trim();
		if (!text) return;
		const remaining = MAX_SCHEMA_SEARCH_CHARS - chars;
		const bounded = text.slice(0, remaining);
		chunks.push(bounded);
		chars += bounded.length + 1;
	};
	const visit = (value: unknown, depth: number): void => {
		if (!value || typeof value !== "object" || depth > MAX_SCHEMA_SEARCH_DEPTH || nodes >= MAX_SCHEMA_SEARCH_NODES || chars >= MAX_SCHEMA_SEARCH_CHARS) return;
		nodes += 1;
		const record = value as Record<string, unknown>;
		if (Array.isArray(record.required)) for (const required of record.required) append(required);
		if (Array.isArray(record.enum)) for (const option of record.enum) append(option);
		if (typeof record.description === "string") append(record.description);
		if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
			for (const [name, property] of Object.entries(record.properties as Record<string, unknown>)) {
				append(name);
				visit(property, depth + 1);
				if (nodes >= MAX_SCHEMA_SEARCH_NODES || chars >= MAX_SCHEMA_SEARCH_CHARS) break;
			}
		}
		if (record.items) visit(record.items, depth + 1);
		for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
			const branches = record[keyword];
			if (Array.isArray(branches)) for (const branch of branches) visit(branch, depth + 1);
		}
	};
	visit(schema, 0);
	return chunks.join(" ");
}

/** Lexical IDF score of each tool (name + description + bounded schema) against the query terms. */
function scoreTools(tools: readonly Tool[], queryTokens: readonly string[]): number[] {
	const n = tools.length;
	const sets = tools.map((t) => new Set(tokenize(`${t.name} ${t.description ?? ""} ${schemaSearchText(t)}`)));
	const nameSets = tools.map((t) => new Set(tokenize(t.name)));
	const terms = new Set(queryTokens);
	const df = new Map<string, number>();
	for (const term of terms) {
		let count = 0;
		for (const set of sets) if (set.has(term)) count++;
		df.set(term, count);
	}
	const idf = (term: string) => Math.log(1 + n / (1 + (df.get(term) ?? 0)));
	return sets.map((set, i) => {
		let score = 0;
		for (const term of terms) {
			if (set.has(term)) score += idf(term);
			if (nameSets[i].has(term)) score += 2 * idf(term);
		}
		return score;
	});
}

/**
 * Slim a `tools` array. Returns the original reference and zero savings when
 * nothing was dropped. Order of kept tools is preserved. Pure.
 */
export function optimizeTools(tools: unknown, opts: ToolsOptions): ToolsResult {
	if (!Array.isArray(tools)) return { tools: tools as unknown[], removedChars: 0, dropped: [] };
	const relevanceQueryTokens = opts.mode === "relevance" ? tokenize(opts.query) : [];
	if (opts.mode === "relevance" && relevanceQueryTokens.length === 0) {
		return { tools, removedChars: 0, dropped: [] };
	}

	const keepIndex = new Set<number>();
	const dropped: string[] = [];

	if (opts.mode === "drop") {
		tools.forEach((tool, i) => {
			const name = getToolDefinition(tool)?.name ?? "";
			if (!isProtected(name, opts.protect, opts.keepNames) && matchesAny(name, opts.dropPrefixes)) {
				dropped.push(name);
			} else {
				keepIndex.add(i);
			}
		});
	} else {
		const candidates: { tool: Tool; i: number }[] = [];
		tools.forEach((tool, i) => {
			const definition = getToolDefinition(tool);
			if (!definition) {
				keepIndex.add(i);
				return;
			}
			const name = definition.name;
			if (isProtected(name, opts.protect, opts.keepNames)) keepIndex.add(i);
			else candidates.push({ tool: definition, i });
		});
		const scores = scoreTools(candidates.map((c) => c.tool), relevanceQueryTokens);
		if (!scores.some((score) => score > 0)) return { tools, removedChars: 0, dropped: [] };
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

	if (dropped.length === 0) return { tools, removedChars: 0, dropped: [] };
	const kept = tools.filter((_, i) => keepIndex.has(i));
	const removedChars = JSON.stringify(tools).length - JSON.stringify(kept).length;
	return { tools: kept, removedChars, dropped };
}
