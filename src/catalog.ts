import { createHash } from "node:crypto";

export const CATALOG_VERSION = 1 as const;

/** Stable shared discovery vocabulary; a new meaning requires a version change. */
export const CATALOG_TAGS: readonly Readonly<{ id: string; description: string }>[] = Object.freeze([
	{ id: "architecture", description: "System structure, boundaries, and design decisions" },
	{ id: "debugging", description: "Investigate causes and diagnose failing behavior" },
	{ id: "testing", description: "Tests, fixtures, fuzzing, and test reliability" },
	{ id: "review", description: "Assess existing work and identify concrete issues" },
	{ id: "workflow", description: "Plan, coordinate, and complete work in stages" },
	{ id: "discipline", description: "Execution habits, evidence, reading, persistence, and safe judgment" },
	{ id: "memory", description: "Preserve, retrieve, and maintain working knowledge" },
	{ id: "verification", description: "Validate outcomes and substantiate claims" },
	{ id: "documentation", description: "Technical explanations, references, and project docs" },
	{ id: "writing", description: "Draft, revise, and structure written material" },
	{ id: "research", description: "Find sources, investigate questions, and synthesize" },
	{ id: "data", description: "Mathematics, datasets, databases, and machine learning" },
	{ id: "visualization", description: "Diagrams, charts, and visual explanations" },
	{ id: "frontend", description: "Interfaces, browser applications, and visual design" },
	{ id: "backend", description: "Services, APIs, storage, and server applications" },
	{ id: "programming", description: "Language-specific implementation and code patterns" },
	{ id: "performance", description: "Measure and improve resource use and speed" },
	{ id: "security", description: "Assess threats, exposure, and protective controls" },
	{ id: "web-security", description: "Web application and API security testing" },
	{ id: "network", description: "Network protocols, traffic, discovery, and services" },
	{ id: "cloud", description: "Cloud platforms, accounts, and infrastructure" },
	{ id: "identity", description: "Authentication, credentials, and directory services" },
	{ id: "cryptography", description: "Cryptographic systems, keys, and cryptanalysis" },
	{ id: "reverse-engineering", description: "Understand binaries and unfamiliar implementations" },
	{ id: "forensics", description: "Collect and interpret digital evidence" },
	{ id: "malware", description: "Analyze malicious software and its behavior" },
	{ id: "exploitation", description: "Investigate and demonstrate software vulnerabilities" },
	{ id: "mobile", description: "Mobile applications, devices, and platform tooling" },
	{ id: "hardware", description: "Physical devices, electronics, and hardware analysis" },
	{ id: "embedded", description: "Firmware, microcontrollers, and embedded systems" },
	{ id: "wireless", description: "Radio, wireless protocols, and signal systems" },
	{ id: "geolocation", description: "Locate places and interpret geographic evidence" },
	{ id: "media", description: "Images, audio, video, and media processing" },
	{ id: "office", description: "Documents, spreadsheets, presentations, and records" },
	{ id: "agents", description: "AI agents, skills, prompts, and model integrations" },
	{ id: "tools", description: "Use and configure specific applications and utilities" },
	{ id: "devops", description: "Builds, releases, deployment, and runtime operations" },
	{ id: "other", description: "Topics outside this vocabulary; inspect before assuming no skill fits" },
].map((tag) => Object.freeze(tag)));

const KNOWN_TAGS = new Set(CATALOG_TAGS.map(({ id }) => id));
const UNCLASSIFIED = "unclassified";
const PAGE_BUDGET_CHARS = 3_000;
const preparedCache = new Map<string, PreparedSkillCatalog>();

export interface CatalogCard {
	summary: string;
	tags: string[];
	sourceHash: string;
}

export interface CatalogMetadata {
	version: typeof CATALOG_VERSION;
	cards: Record<string, CatalogCard>;
}

export interface CatalogSkillSource {
	name: string;
	description: string;
}

export interface CatalogSkillItem {
	name: string;
	summary: string;
	tags: readonly string[];
	/** True only when validated metadata still matches the current source. */
	generated: boolean;
}

export interface CatalogFacet {
	id: string;
	count: number;
}

export interface PreparedSkillCatalog {
	version: typeof CATALOG_VERSION;
	fingerprint: string;
	skills: readonly Readonly<CatalogSkillItem>[];
	facets: readonly Readonly<CatalogFacet>[];
	total: number;
	unclassified: number;
}

export interface TagDirectory {
	text: string;
	fingerprint: string;
	total: number;
	unclassified: number;
	usedChars: number;
}

export interface CatalogBrowseOptions {
	tags?: readonly string[];
	match?: "any" | "all";
	query?: string;
	/** Explicit text-search ordering supplied by the source-description ranker. */
	orderedNames?: readonly string[];
	cursor?: string;
	pageSize?: number;
}

export interface CatalogBrowseResult {
	version: typeof CATALOG_VERSION;
	fingerprint: string;
	total: number;
	items: readonly Readonly<CatalogSkillItem>[];
	facets: readonly Readonly<CatalogFacet>[];
	nextCursor?: string;
	usedChars: number;
}

export interface SkillCatalogBrowser {
	readonly prepared: PreparedSkillCatalog;
	renderDirectory(budgetChars?: number): TagDirectory;
	browse(options?: CatalogBrowseOptions): CatalogBrowseResult;
}

interface CatalogBrowsePlan {
	candidates: readonly Readonly<CatalogSkillItem>[];
	facets: readonly Readonly<CatalogFacet>[];
	filterHash: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON-like data only: inherited properties and accessors are not metadata. */
function own(value: object, key: string): unknown {
	return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function clean(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

function validUnicode(text: string): boolean {
	return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
}

export function normalizeCatalogMetadata(value: unknown): CatalogMetadata | undefined {
	if (!record(value) || own(value, "version") !== CATALOG_VERSION) return undefined;
	const rawCards = own(value, "cards");
	if (!record(rawCards)) return undefined;
	const cards: Record<string, CatalogCard> = {};
	for (const name of Object.keys(rawCards).sort(compare)) {
		const raw = own(rawCards, name);
		if (!name || name !== name.trim() || !validUnicode(name) || !record(raw)) continue;
		const rawSummary = own(raw, "summary");
		const rawTags = own(raw, "tags");
		const sourceHash = own(raw, "sourceHash");
		if (typeof rawSummary !== "string" || !validUnicode(rawSummary)) continue;
		const summary = clean(rawSummary);
		// One distinguishing sentence is a generation-quality instruction. Punctuation
		// cannot validate that requirement without rejecting valid abbreviations.
		if (!summary || summary.length > 200) continue;
		if (!Array.isArray(rawTags) || rawTags.length < 1 || rawTags.length > 3) continue;
		if (!rawTags.every((tag): tag is string => typeof tag === "string" && KNOWN_TAGS.has(tag))) continue;
		const tags = [...new Set(rawTags)].sort(compare);
		if (tags.length !== rawTags.length) continue;
		if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/u.test(sourceHash)) continue;
		Object.defineProperty(cards, name, { value: { summary, tags, sourceHash }, enumerable: true, writable: true, configurable: true });
	}
	return { version: CATALOG_VERSION, cards };
}

/** Preserves the profile's existing v2 UTF-8 length-framed source identity. */
export function catalogSourceHash(name: string, description: string): string {
	return createHash("sha256")
		.update("pi-skill-optimizer:skill:v2\0", "utf8")
		.update(String(Buffer.byteLength(name, "utf8")), "utf8").update(":", "utf8").update(name, "utf8")
		.update(String(Buffer.byteLength(description, "utf8")), "utf8").update(":", "utf8").update(description, "utf8")
		.digest("hex");
}

function sourceSummary(description: string): string {
	const text = clean(description);
	if (!text) return "No description available; load this skill to inspect its instructions.";
	const boundary = text.search(/[.!?](?:\s|$)/u);
	const sentence = boundary < 0 ? text : text.slice(0, boundary + 1);
	if (sentence.length <= 200) return sentence;
	let end = 197;
	const word = sentence.lastIndexOf(" ", end);
	if (word > 140) end = word;
	if (/[\uD800-\uDBFF]/u.test(sentence[end - 1] ?? "")) end -= 1;
	return `${sentence.slice(0, end).trimEnd()}...`;
}

function facetsFor(items: readonly CatalogSkillItem[]): readonly Readonly<CatalogFacet>[] {
	const counts = new Map<string, number>();
	for (const item of items) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
	return Object.freeze([...CATALOG_TAGS.map(({ id }) => id), UNCLASSIFIED]
		.filter((id) => counts.has(id))
		.map((id) => Object.freeze({ id, count: counts.get(id)! })));
}

export function prepareSkillCatalog(
	skills: readonly CatalogSkillSource[],
	metadata?: CatalogMetadata,
): PreparedSkillCatalog {
	const normalized = normalizeCatalogMetadata(metadata);
	const seen = new Set<string>();
	const sourceHashes = new Map<string, string>();
	const items = skills.map(({ name, description }): Readonly<CatalogSkillItem> => {
		if (typeof name !== "string" || !name.trim() || name !== name.trim() || typeof description !== "string" || !validUnicode(name) || !validUnicode(description)) {
			throw new TypeError("Skill source requires an exact non-empty name and description");
		}
		if (seen.has(name)) throw new RangeError(`Duplicate skill name: ${name}`);
		seen.add(name);
		const sourceHash = catalogSourceHash(name, description);
		sourceHashes.set(name, sourceHash);
		const card = normalized ? own(normalized.cards, name) as CatalogCard | undefined : undefined;
		const generated = card?.sourceHash === sourceHash;
		return Object.freeze({
			name,
			summary: generated ? card!.summary : sourceSummary(description),
			tags: Object.freeze(generated ? [...card!.tags] : [UNCLASSIFIED]),
			generated,
		});
	}).sort((left, right) => compare(left.name, right.name));
	const hash = createHash("sha256").update(`pi-skill-optimizer:catalog:${CATALOG_VERSION}\0`);
	for (const item of items) hash.update(JSON.stringify([item.name, sourceHashes.get(item.name), item.summary, item.tags, item.generated]));
	const fingerprint = hash.digest("hex");
	const cached = preparedCache.get(fingerprint);
	if (cached) return cached;
	const facets = facetsFor(items);
	const prepared = Object.freeze({
		version: CATALOG_VERSION,
		fingerprint,
		skills: Object.freeze(items),
		facets,
		total: items.length,
		unclassified: facets.find(({ id }) => id === UNCLASSIFIED)?.count ?? 0,
	});
	preparedCache.set(fingerprint, prepared);
	while (preparedCache.size > 4) preparedCache.delete(preparedCache.keys().next().value as string);
	return prepared;
}

export function renderTagDirectory(
	skills: readonly CatalogSkillSource[],
	metadata?: CatalogMetadata,
	budgetChars = 4_000,
): TagDirectory {
	const catalog = prepareSkillCatalog(skills, metadata);
	return renderPreparedDirectory(catalog, budgetChars);
}

function renderPreparedDirectory(catalog: PreparedSkillCatalog, budgetChars = 4_000): TagDirectory {
	const counts = new Map(catalog.facets.map(({ id, count }) => [id, count]));
	const text = [
		"<!--skill-optimizer:tags:v1-->",
		`<skill_directory version="${CATALOG_VERSION}" total="${catalog.total}" unclassified="${catalog.unclassified}">`,
		"Discovery metadata, not loaded instructions. Choose skills using the current task and work context.",
		'Use skill_search action="search" with tags (match="any" or "all") to browse cards. Query alone searches source descriptions; with tags it only prioritizes cards. Empty filters browse all skills; cursor continues a page.',
		'Load a known exact name directly with skill_search action="load" name="..."; browsing is optional.',
		"tag\tdescription\tcount",
		...CATALOG_TAGS.map(({ id, description }) => `${id}\t${description}\t${counts.get(id) ?? 0}`),
		`${UNCLASSIFIED}\tMissing or stale metadata; source-description cards remain available\t${catalog.unclassified}`,
		"</skill_directory>",
	].join("\n");
	if (!Number.isFinite(budgetChars) || text.length > Math.max(0, Math.trunc(budgetChars))) {
		throw new RangeError(`Complete skill directory requires ${text.length} characters; directory budget is ${budgetChars}`);
	}
	return { text, fingerprint: catalog.fingerprint, total: catalog.total, unclassified: catalog.unclassified, usedChars: text.length };
}

function fingerprintText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function makeCursor(fingerprint: string, filterHash: string, offset: number): string {
	const body = { v: CATALOG_VERSION, f: fingerprint, q: filterHash, o: offset };
	const s = fingerprintText(JSON.stringify(body)).slice(0, 24);
	return Buffer.from(JSON.stringify({ ...body, s }), "utf8").toString("base64url");
}

function readCursor(cursor: string, fingerprint: string, filterHash: string, total: number): number {
	try {
		if (cursor.length > 1_024) throw new Error("oversized");
		const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (!record(parsed)) throw new Error("invalid");
		const { v, f, q, o, s } = parsed;
		if (v !== CATALOG_VERSION || f !== fingerprint || q !== filterHash || typeof o !== "number" || !Number.isSafeInteger(o) || o < 0 || o >= total) throw new Error("mismatch");
		if (s !== fingerprintText(JSON.stringify({ v, f, q, o })).slice(0, 24)) throw new Error("signature");
		return o;
	} catch {
		throw new RangeError("Invalid or stale skill catalog cursor; restart this search");
	}
}

function measureResult(result: CatalogBrowseResult): CatalogBrowseResult {
	// Counting the complete returned JSON includes this field and its own digit width.
	let length = JSON.stringify(result).length;
	while (result.usedChars !== length) {
		result.usedChars = length;
		length = JSON.stringify(result).length;
	}
	return result;
}

export function browseSkillCatalog(
	skills: readonly CatalogSkillSource[],
	metadata?: CatalogMetadata,
	options: CatalogBrowseOptions = {},
): CatalogBrowseResult {
	const catalog = prepareSkillCatalog(skills, metadata);
	const descriptions = new Map(skills.map(({ name, description }) => [name, description]));
	return browsePrepared(catalog, descriptions, options);
}

/**
 * Captures values once. Registry/profile owners can reuse this browser until they
 * explicitly replace their snapshot; caller mutations never affect its cursors.
 */
export function createSkillCatalogBrowser(
	skills: readonly CatalogSkillSource[],
	metadata?: CatalogMetadata,
): SkillCatalogBrowser {
	const sources = skills.map(({ name, description }) => Object.freeze({ name, description }));
	const prepared = prepareSkillCatalog(sources, metadata);
	const descriptions = new Map(sources.map(({ name, description }) => [name, description]));
	const plans = new Map<string, CatalogBrowsePlan>();
	return Object.freeze({
		prepared,
		renderDirectory: (budgetChars?: number) => renderPreparedDirectory(prepared, budgetChars),
		browse: (options: CatalogBrowseOptions = {}) => browsePrepared(prepared, descriptions, options, plans),
	});
}

function browsePrepared(
	catalog: PreparedSkillCatalog,
	descriptions: ReadonlyMap<string, string>,
	options: CatalogBrowseOptions,
	plans?: Map<string, CatalogBrowsePlan>,
): CatalogBrowseResult {
	const rawTags = options.tags ?? [];
	if (!Array.isArray(rawTags) || rawTags.length > CATALOG_TAGS.length + 1) throw new RangeError("Too many catalog tags");
	const unknown = rawTags.filter((tag) => !KNOWN_TAGS.has(tag) && tag !== UNCLASSIFIED);
	if (unknown.length) throw new RangeError(`Unknown catalog tags: ${unknown.join(", ")}. Known tags: ${[...KNOWN_TAGS, UNCLASSIFIED].join(", ")}`);
	const tags = [...new Set(rawTags)].sort(compare);
	const match = options.match ?? "any";
	if (match !== "any" && match !== "all") throw new TypeError("Catalog tag match must be any or all");
	const query = clean(options.query ?? "").toLocaleLowerCase("en-US");
	const pageSize = Math.max(1, Math.min(50, Math.trunc(options.pageSize ?? 10)));
	if (!Number.isFinite(pageSize)) throw new RangeError("Invalid catalog page size");
	const planKey = JSON.stringify({ tags, match, query, orderedNames: options.orderedNames });
	let plan = plans?.get(planKey);
	if (!plan) {
		let candidates = [...catalog.skills];
		if (tags.length) candidates = candidates.filter((item) => match === "all"
			? tags.every((tag) => item.tags.includes(tag))
			: tags.some((tag) => item.tags.includes(tag)));
		if (options.orderedNames !== undefined) {
			const byName = new Map(candidates.map((item) => [item.name, item]));
			candidates = [...new Set(options.orderedNames)].flatMap((name) => {
				const item = byName.get(name);
				return item ? [item] : [];
			});
		} else if (query) {
			const matches: Readonly<CatalogSkillItem>[] = [];
			const remaining: Readonly<CatalogSkillItem>[] = [];
			for (const item of candidates) {
				const text = `${item.name}\n${item.summary}\n${descriptions.get(item.name) ?? ""}`.toLocaleLowerCase("en-US");
				(text.includes(query) ? matches : remaining).push(item);
			}
			// A chosen semantic bucket remains complete across query languages.
			// Text can prioritize its cards; only query-only searches narrow by text.
			candidates = tags.length ? [...matches, ...remaining] : matches;
		}
		plan = {
			candidates,
			facets: facetsFor(candidates),
			filterHash: fingerprintText(JSON.stringify({ tags, match, query, order: candidates.map(({ name }) => name) })),
		};
		if (plans) {
			plans.set(planKey, plan);
			while (plans.size > 8) plans.delete(plans.keys().next().value as string);
		}
	}
	const { candidates, facets, filterHash } = plan;
	const offset = options.cursor ? readCursor(options.cursor, catalog.fingerprint, filterHash, candidates.length) : 0;
	const page = (end: number): CatalogBrowseResult => measureResult({
		version: CATALOG_VERSION,
		fingerprint: catalog.fingerprint,
		total: candidates.length,
		items: candidates.slice(offset, end),
		facets,
		...(end < candidates.length ? { nextCursor: makeCursor(catalog.fingerprint, filterHash, end) } : {}),
		usedChars: 0,
	});
	if (candidates.length === 0) return page(0);
	let result: CatalogBrowseResult | undefined;
	for (let end = offset + 1; end <= Math.min(candidates.length, offset + pageSize); end += 1) {
		const candidate = page(end);
		if (candidate.usedChars > PAGE_BUDGET_CHARS) {
			if (!result) throw new RangeError(`Next skill card cannot fit the ${PAGE_BUDGET_CHARS}-character response budget; use exact load or narrower filters`);
			break;
		}
		result = candidate;
	}
	return result!;
}
