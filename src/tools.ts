/**
 * Pure local tool discovery.
 *
 * Tool definitions are indexed locally and remain untouched. Dynamic loading may
 * activate a confident subset, but ambiguous or missing evidence always fails
 * open to the complete named catalog.
 */

import { tokenize } from "./skills.ts";

export interface Tool {
	name: string;
	description?: string;
	[key: string]: unknown;
}

/**
 * Generous, case-insensitive set of core/agent tool names. These tools always
 * remain active when a discovery catalog is used.
 */
export const CORE_TOOLS = new Set(
	[
		"read", "bash", "edit", "write", "multiedit", "str_replace_editor", "notebookedit",
		"glob", "grep", "ls", "find", "todo", "todowrite", "todoread",
		"subagent", "fork", "task", "mcp", "skill", "exitplanmode", "enterplanmode",
		"webfetch", "websearch", "askuserquestion", "powershell",
	].map((name) => name.toLowerCase()),
);

export type ToolSearchConfidence = "none" | "low" | "high";
export type ToolSearchField = "name" | "description" | "schemaName" | "schemaText";

export interface ToolDiscoveryBuildOptions {
	/** Case-insensitive exact names or prefixes that must always remain active. */
	protect?: readonly string[];
}

export interface ToolTermIndex {
	readonly frequencies: ReadonlyMap<string, number>;
	readonly length: number;
}

export interface ToolDiscoveryEntry {
	readonly name: string;
	readonly canonicalName: string;
	readonly description: string;
	readonly sourceIndex: number;
	readonly alwaysActive: boolean;
	readonly fields: Readonly<Record<ToolSearchField, ToolTermIndex>>;
}

/** Immutable metadata plus a local BM25F index. No tool definition is rewritten. */
export interface ToolDiscoveryCatalog {
	readonly tools: readonly unknown[];
	readonly entries: readonly ToolDiscoveryEntry[];
	readonly alwaysActiveNames: readonly string[];
	readonly candidateNames: readonly string[];
	/** Entries without a usable name; callers should leave them under Pi's native policy. */
	readonly unmanagedToolIndexes: readonly number[];
	readonly fingerprint: string;
}

export interface ToolSearchOptions {
	/** Opaque cursor returned by the preceding page. */
	cursor?: string;
	/** Results per page, clamped to 1..50. Default: 8. */
	pageSize?: number;
	/** Maximum compact description length, clamped to 0..500. Default: 240. */
	descriptionChars?: number;
}

export interface ToolSearchMatch {
	readonly name: string;
	readonly description: string;
	readonly score: number;
	readonly matchedTerms: readonly string[];
	readonly matchedFields: readonly ToolSearchField[];
}

export interface ToolSearchPage {
	readonly results: readonly ToolSearchMatch[];
	readonly total: number;
	readonly nextCursor?: string;
	readonly confidence: ToolSearchConfidence;
	/** True means results include the deterministic catalog fallback, not only matches. */
	readonly failOpen: boolean;
}

export interface ToolActivationOptions {
	/** Maximum ordinary candidates to activate after a confident search. */
	topK: number;
	/** Tools observed in conversation history. Matching is case-insensitive. */
	usedNames?: ReadonlySet<string>;
}

export type ToolActivationReason =
	| "confident-match"
	| "no-candidates"
	| "no-signal"
	| "no-match"
	| "weak-signal"
	| "ambiguous-cutoff"
	| "invalid-top-k";

export interface ToolActivationPlan {
	/** Stable registration order, suitable for Pi's setActiveTools(). */
	readonly activeNames: readonly string[];
	/** Core, configured-protected, and already-used names. */
	readonly alwaysActiveNames: readonly string[];
	/** Ranked ordinary matches; empty when the plan failed open. */
	readonly selectedNames: readonly string[];
	readonly confidence: ToolSearchConfidence;
	readonly failOpen: boolean;
	readonly reason: ToolActivationReason;
}

const FIELD_ORDER: readonly ToolSearchField[] = ["name", "description", "schemaName", "schemaText"];
const FIELD_WEIGHT: Readonly<Record<ToolSearchField, number>> = {
	name: 7,
	description: 2.2,
	schemaName: 2.8,
	schemaText: 0.9,
};
const FIELD_LENGTH_NORMALIZATION: Readonly<Record<ToolSearchField, number>> = {
	name: 0.2,
	description: 0.7,
	schemaName: 0.45,
	schemaText: 0.75,
};
const BM25_K1 = 1.2;
const MAX_NAME_SEARCH_CHARS = 512;
const MAX_DESCRIPTION_SEARCH_CHARS = 4_096;
const MAX_FIELD_TERMS = 512;
const MAX_SCHEMA_SEARCH_CHARS = 2_048;
const MAX_SCHEMA_SEARCH_NODES = 96;
const MAX_SCHEMA_SEARCH_DEPTH = 4;
const MAX_SCHEMA_SEARCH_TERMS = 256;
const DEFAULT_PAGE_SIZE = 8;
const DEFAULT_DESCRIPTION_CHARS = 240;
const CURSOR_VERSION = "td1";

interface SchemaFields {
	names: string;
	text: string;
}

interface RankedEntry {
	entry: ToolDiscoveryEntry;
	score: number;
	matchedTerms: string[];
	matchedFields: ToolSearchField[];
	exactName: boolean;
}

interface Ranking {
	ranked: RankedEntry[];
	queryTerms: string[];
	knownQueryTerms: number;
	confidence: ToolSearchConfidence;
}

function canonicalName(name: string): string {
	return name.trim().toLowerCase();
}

function matchesAny(name: string, patterns: readonly string[]): boolean {
	const candidate = canonicalName(name);
	return patterns.some((pattern) => {
		const normalized = canonicalName(pattern);
		return normalized.length > 0 && (candidate === normalized || candidate.startsWith(normalized));
	});
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

function appendBounded(chunks: string[], value: unknown, state: { chars: number }): void {
	if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") || state.chars >= MAX_SCHEMA_SEARCH_CHARS) return;
	const text = String(value)
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim();
	if (!text) return;
	const remaining = MAX_SCHEMA_SEARCH_CHARS - state.chars;
	const bounded = text.slice(0, remaining);
	chunks.push(bounded);
	state.chars += bounded.length + 1;
}

/** Extract routing evidence only, never arbitrary/default schema values. */
function schemaFields(tool: Tool): SchemaFields {
	const schema = tool.input_schema ?? tool.inputSchema ?? tool.parameters;
	if (!schema || typeof schema !== "object") return { names: "", text: "" };
	const names: string[] = [];
	const text: string[] = [];
	const state = { chars: 0, nodes: 0 };
	const seen = new WeakSet<object>();

	const visit = (value: unknown, depth: number): void => {
		if (!value || typeof value !== "object" || depth > MAX_SCHEMA_SEARCH_DEPTH || state.nodes >= MAX_SCHEMA_SEARCH_NODES || state.chars >= MAX_SCHEMA_SEARCH_CHARS) return;
		if (seen.has(value as object)) return;
		seen.add(value as object);
		state.nodes += 1;
		const record = value as Record<string, unknown>;
		if (Array.isArray(record.required)) for (const required of record.required) appendBounded(names, required, state);
		if (Array.isArray(record.enum)) for (const option of record.enum) appendBounded(text, option, state);
		if (typeof record.description === "string") appendBounded(text, record.description, state);
		if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
			const properties = record.properties as Record<string, unknown>;
			for (const name of Object.keys(properties).sort()) {
				appendBounded(names, name, state);
				visit(properties[name], depth + 1);
				if (state.nodes >= MAX_SCHEMA_SEARCH_NODES || state.chars >= MAX_SCHEMA_SEARCH_CHARS) break;
			}
		}
		if (record.items) visit(record.items, depth + 1);
		for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
			const branches = record[keyword];
			if (!Array.isArray(branches)) continue;
			for (const branch of branches) {
				visit(branch, depth + 1);
				if (state.nodes >= MAX_SCHEMA_SEARCH_NODES || state.chars >= MAX_SCHEMA_SEARCH_CHARS) break;
			}
		}
	};

	visit(schema, 0);
	return { names: names.join(" "), text: text.join(" ") };
}

function termIndex(text: string, maxChars: number, maxTerms: number): ToolTermIndex {
	const terms = tokenize(text.slice(0, maxChars)).slice(0, maxTerms);
	const frequencies = new Map<string, number>();
	for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
	return { frequencies, length: terms.length };
}

function hashUpdate(hash: number, text: string): number {
	let next = hash >>> 0;
	for (let i = 0; i < text.length; i++) {
		next ^= text.charCodeAt(i);
		next = Math.imul(next, 0x01000193) >>> 0;
	}
	return next;
}

function catalogFingerprint(entries: readonly ToolDiscoveryEntry[]): string {
	let hash = 0x811c9dc5;
	for (const entry of entries) {
		hash = hashUpdate(hash, `\0${entry.canonicalName}\0${entry.alwaysActive ? "1" : "0"}`);
		for (const field of FIELD_ORDER) {
			const terms = [...entry.fields[field].frequencies.entries()].sort(([a], [b]) => a.localeCompare(b));
			for (const [term, count] of terms) hash = hashUpdate(hash, `\0${field}:${term}:${count}`);
		}
	}
	return hash.toString(36);
}

/** Build a deterministic, schema-bounded local index without changing tools. */
export function buildToolDiscoveryCatalog(
	tools: readonly unknown[],
	options: ToolDiscoveryBuildOptions = {},
): ToolDiscoveryCatalog {
	const protect = options.protect ?? [];
	const entries: ToolDiscoveryEntry[] = [];
	const unmanagedToolIndexes: number[] = [];
	const seenNames = new Set<string>();

	tools.forEach((value, sourceIndex) => {
		const definition = getToolDefinition(value);
		if (!definition || canonicalName(definition.name).length === 0) {
			unmanagedToolIndexes.push(sourceIndex);
			return;
		}
		const canonical = canonicalName(definition.name);
		if (seenNames.has(canonical)) return;
		seenNames.add(canonical);
		const schema = schemaFields(definition);
		const alwaysActive = CORE_TOOLS.has(canonical) || matchesAny(canonical, protect);
		entries.push(Object.freeze({
			name: definition.name,
			canonicalName: canonical,
			description: typeof definition.description === "string" ? definition.description : "",
			sourceIndex,
			alwaysActive,
			fields: Object.freeze({
				name: termIndex(definition.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "), MAX_NAME_SEARCH_CHARS, 64),
				description: termIndex(typeof definition.description === "string" ? definition.description : "", MAX_DESCRIPTION_SEARCH_CHARS, MAX_FIELD_TERMS),
				schemaName: termIndex(schema.names, MAX_SCHEMA_SEARCH_CHARS, MAX_SCHEMA_SEARCH_TERMS),
				schemaText: termIndex(schema.text, MAX_SCHEMA_SEARCH_CHARS, MAX_SCHEMA_SEARCH_TERMS),
			}),
		}));
	});

	const immutableEntries = Object.freeze(entries.slice());
	return Object.freeze({
		tools: Object.freeze([...tools]),
		entries: immutableEntries,
		alwaysActiveNames: Object.freeze(entries.filter((entry) => entry.alwaysActive).map((entry) => entry.name)),
		candidateNames: Object.freeze(entries.filter((entry) => !entry.alwaysActive).map((entry) => entry.name)),
		unmanagedToolIndexes: Object.freeze(unmanagedToolIndexes.slice()),
		fingerprint: catalogFingerprint(immutableEntries),
	});
}

function uniqueTerms(query: string): string[] {
	return [...new Set(tokenize(query))];
}

function rankEntries(entries: readonly ToolDiscoveryEntry[], query: string): Ranking {
	const queryTerms = uniqueTerms(query);
	if (queryTerms.length === 0 || entries.length === 0) {
		return { ranked: [], queryTerms, knownQueryTerms: 0, confidence: "none" };
	}

	const averageLength = Object.fromEntries(FIELD_ORDER.map((field) => [
		field,
		Math.max(1, entries.reduce((sum, entry) => sum + entry.fields[field].length, 0) / entries.length),
	])) as Record<ToolSearchField, number>;
	const documentFrequency = new Map<string, number>();
	for (const term of queryTerms) {
		let count = 0;
		for (const entry of entries) {
			if (FIELD_ORDER.some((field) => entry.fields[field].frequencies.has(term))) count += 1;
		}
		documentFrequency.set(term, count);
	}
	const knownQueryTerms = queryTerms.filter((term) => (documentFrequency.get(term) ?? 0) > 0).length;
	const exactQuery = queryTerms.join(" ");
	const ranked: RankedEntry[] = [];

	for (const entry of entries) {
		let score = 0;
		const matchedTerms: string[] = [];
		const matchedFieldSet = new Set<ToolSearchField>();
		for (const term of queryTerms) {
			const df = documentFrequency.get(term) ?? 0;
			if (df === 0) continue;
			let combinedFrequency = 0;
			for (const field of FIELD_ORDER) {
				const index = entry.fields[field];
				const frequency = index.frequencies.get(term) ?? 0;
				if (frequency === 0) continue;
				matchedFieldSet.add(field);
				const b = FIELD_LENGTH_NORMALIZATION[field];
				const normalizedLength = 1 - b + b * (index.length / averageLength[field]);
				combinedFrequency += FIELD_WEIGHT[field] * frequency / normalizedLength;
			}
			if (combinedFrequency === 0) continue;
			matchedTerms.push(term);
			const idf = Math.log(1 + (entries.length - df + 0.5) / (df + 0.5));
			score += idf * (combinedFrequency * (BM25_K1 + 1)) / (combinedFrequency + BM25_K1);
		}
		const exactName = exactQuery.length > 0 && exactQuery === [...entry.fields.name.frequencies.keys()].join(" ");
		if (exactName) score += 12;
		if (score > 0) {
			ranked.push({
				entry,
				score,
				matchedTerms,
				matchedFields: FIELD_ORDER.filter((field) => matchedFieldSet.has(field)),
				exactName,
			});
		}
	}

	ranked.sort((a, b) => b.score - a.score || a.entry.sourceIndex - b.entry.sourceIndex || a.entry.canonicalName.localeCompare(b.entry.canonicalName));
	if (ranked.length === 0) return { ranked, queryTerms, knownQueryTerms, confidence: "none" };
	const top = ranked[0];
	const runner = ranked[1];
	const queryCoverage = top.matchedTerms.length / queryTerms.length;
	const knownCoverage = knownQueryTerms === 0 ? 0 : top.matchedTerms.length / knownQueryTerms;
	const nameEvidence = top.matchedFields.includes("name");
	const separated = !runner || top.score >= runner.score * 1.25;
	const confidence: ToolSearchConfidence = top.exactName
		|| (top.matchedTerms.length >= 2 && queryCoverage >= 0.25 && knownCoverage >= 0.6)
		|| (nameEvidence && separated)
		? "high"
		: "low";
	return { ranked, queryTerms, knownQueryTerms, confidence };
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function compactDescription(description: string, maxChars: number): string {
	if (maxChars === 0) return "";
	const compact = description.replace(/\s+/g, " ").trim();
	if (compact.length <= maxChars) return compact;
	if (maxChars <= 3) return ".".repeat(maxChars);
	return `${compact.slice(0, maxChars - 3).trimEnd()}...`;
}

function queryFingerprint(query: string): string {
	return hashUpdate(0x811c9dc5, uniqueTerms(query).join("\0")).toString(36);
}

function encodeCursor(catalog: ToolDiscoveryCatalog, query: string, offset: number): string {
	return `${CURSOR_VERSION}.${catalog.fingerprint}.${queryFingerprint(query)}.${offset.toString(36)}`;
}

function decodeCursor(catalog: ToolDiscoveryCatalog, query: string, cursor: string | undefined): number {
	if (!cursor) return 0;
	const parts = cursor.split(".");
	if (parts.length !== 4 || parts[0] !== CURSOR_VERSION || parts[1] !== catalog.fingerprint || parts[2] !== queryFingerprint(query) || !/^[0-9a-z]+$/.test(parts[3])) {
		throw new Error("Invalid tool discovery cursor for this catalog or query");
	}
	const offset = Number.parseInt(parts[3], 36);
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid tool discovery cursor offset");
	return offset;
}

/**
 * Search inactive candidates. Weak/no evidence appends every candidate in
 * registration order so discovery cannot silently hide a tool.
 */
export function searchToolDiscoveryCatalog(
	catalog: ToolDiscoveryCatalog,
	query: string,
	options: ToolSearchOptions = {},
): ToolSearchPage {
	const candidates = catalog.entries.filter((entry) => !entry.alwaysActive);
	const ranking = rankEntries(candidates, query);
	const rankedNames = new Set(ranking.ranked.map((item) => item.entry.canonicalName));
	const fallback: RankedEntry[] = ranking.confidence === "high" ? [] : candidates
		.filter((entry) => !rankedNames.has(entry.canonicalName))
		.map((entry) => ({ entry, score: 0, matchedTerms: [], matchedFields: [], exactName: false }));
	const available = [...ranking.ranked, ...fallback];
	const pageSize = boundedInteger(options.pageSize, DEFAULT_PAGE_SIZE, 1, 50);
	const descriptionChars = boundedInteger(options.descriptionChars, DEFAULT_DESCRIPTION_CHARS, 0, 500);
	const offset = decodeCursor(catalog, query, options.cursor);
	const end = Math.min(available.length, offset + pageSize);
	const results = available.slice(offset, end).map((item) => Object.freeze({
		name: item.entry.name,
		description: compactDescription(item.entry.description, descriptionChars),
		score: Math.round(item.score * 1_000_000) / 1_000_000,
		matchedTerms: Object.freeze(item.matchedTerms.slice()),
		matchedFields: Object.freeze(item.matchedFields.slice()),
	}));
	return Object.freeze({
		results: Object.freeze(results),
		total: available.length,
		...(end < available.length ? { nextCursor: encodeCursor(catalog, query, end) } : {}),
		confidence: ranking.confidence,
		failOpen: ranking.confidence !== "high",
	});
}

function canonicalSet(names: ReadonlySet<string> | undefined): Set<string> {
	return new Set([...(names ?? [])].map(canonicalName).filter(Boolean));
}

function allNamedTools(catalog: ToolDiscoveryCatalog): string[] {
	return catalog.entries.map((entry) => entry.name);
}

function failedOpenPlan(
	catalog: ToolDiscoveryCatalog,
	alwaysActiveNames: readonly string[],
	confidence: ToolSearchConfidence,
	reason: ToolActivationReason,
): ToolActivationPlan {
	return Object.freeze({
		activeNames: Object.freeze(allNamedTools(catalog)),
		alwaysActiveNames: Object.freeze([...alwaysActiveNames]),
		selectedNames: Object.freeze([]),
		confidence,
		failOpen: true,
		reason,
	});
}

/**
 * Plan Pi active tool names. Registration order is preserved for cache
 * stability. A non-positive topK, weak evidence, or ambiguous cutoff returns
 * the complete named catalog rather than making tools unavailable.
 */
export function planToolActivation(
	catalog: ToolDiscoveryCatalog,
	query: string,
	options: ToolActivationOptions,
): ToolActivationPlan {
	const usedNames = canonicalSet(options.usedNames);
	const alwaysActiveEntries = catalog.entries.filter((entry) => entry.alwaysActive || usedNames.has(entry.canonicalName));
	const alwaysActiveNames = alwaysActiveEntries.map((entry) => entry.name);
	const candidates = catalog.entries.filter((entry) => !entry.alwaysActive && !usedNames.has(entry.canonicalName));
	if (candidates.length === 0) {
		return Object.freeze({
			activeNames: Object.freeze(alwaysActiveNames.slice()),
			alwaysActiveNames: Object.freeze(alwaysActiveNames.slice()),
			selectedNames: Object.freeze([]),
			confidence: "none",
			failOpen: false,
			reason: "no-candidates",
		});
	}
	if (!Number.isSafeInteger(options.topK) || options.topK <= 0) {
		return failedOpenPlan(catalog, alwaysActiveNames, "none", "invalid-top-k");
	}

	const ranking = rankEntries(candidates, query);
	if (ranking.queryTerms.length === 0) return failedOpenPlan(catalog, alwaysActiveNames, "none", "no-signal");
	if (ranking.ranked.length === 0) return failedOpenPlan(catalog, alwaysActiveNames, "none", "no-match");
	if (ranking.confidence !== "high") return failedOpenPlan(catalog, alwaysActiveNames, ranking.confidence, "weak-signal");

	const topK = Math.min(options.topK, ranking.ranked.length);
	const selected = ranking.ranked.slice(0, topK);
	const boundary = ranking.ranked[topK];
	if (boundary) {
		const last = selected[selected.length - 1];
		const safelySeparated = last.score >= boundary.score * 1.15 || last.matchedTerms.length > boundary.matchedTerms.length;
		if (!safelySeparated) return failedOpenPlan(catalog, alwaysActiveNames, ranking.confidence, "ambiguous-cutoff");
	}

	const selectedCanonical = new Set(selected.map((item) => item.entry.canonicalName));
	const activeNames = catalog.entries
		.filter((entry) => entry.alwaysActive || usedNames.has(entry.canonicalName) || selectedCanonical.has(entry.canonicalName))
		.map((entry) => entry.name);
	return Object.freeze({
		activeNames: Object.freeze(activeNames),
		alwaysActiveNames: Object.freeze(alwaysActiveNames),
		selectedNames: Object.freeze(selected.map((item) => item.entry.name)),
		confidence: ranking.confidence,
		failOpen: false,
		reason: "confident-match",
	});
}
