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
/** Only a ranker-top-3 off-bucket match may be promoted into the listed head. */
const RESCUE_PROMOTION_LIMIT = 3;
/** `rest` (names-only remainder) only ships beside this many complete cards. */
const REST_MIN_CARDS = 3;
/** Tag and empty browses page at the cap; query-only lexical search keeps 10. */
const BROWSE_PAGE_SIZE = 50;
const SEARCH_PAGE_SIZE = 10;
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

/** One source the host could not register; its exact reason stays host-visible. */
export interface CatalogQuarantine {
	/** Zero-based position in the caller-supplied source list. */
	index: number;
	/** The exact name when it is a usable string; otherwise null. */
	name: string | null;
	reason: string;
}

export interface PreparedSkillCatalog {
	version: typeof CATALOG_VERSION;
	fingerprint: string;
	skills: readonly Readonly<CatalogSkillItem>[];
	facets: readonly Readonly<CatalogFacet>[];
	total: number;
	unclassified: number;
	/** Malformed sources that stayed out of discovery; never silently dropped. */
	quarantined: readonly Readonly<CatalogQuarantine>[];
}

export interface TagDirectory {
	text: string;
	fingerprint: string;
	total: number;
	unclassified: number;
	usedChars: number;
	/** Non-zero means this directory cannot represent the whole host catalog. */
	quarantined: number;
}

export interface CatalogBrowseOptions {
	tags?: readonly string[];
	match?: "any" | "all";
	/**
	 * Free-text query. This module never matches text itself: candidates and their
	 * order come only from `orderedNames`, so this contract is deliberate at every
	 * level:
	 * - with `orderedNames`, a query whose supplied order holds no eligible card
	 *   yields `total: 0` (no signal) instead of a fabricated ranking;
	 * - with `tags` but no `orderedNames`, the selected bucket stays complete, in
	 *   canonical order, because a raw browse has no caller-supplied ranking to order
	 *   or narrow it;
	 * - with neither `tags` nor `orderedNames`, a non-empty query returns the
	 *   **complete catalog in canonical order** (full browse). That is the
	 *   non-castrating choice: the browser cannot evaluate the query, so it neither
	 *   narrows on it nor invents a rank. The wired `skill_search` path always
	 *   supplies the BM25F order through `orderedNames`, so it still abstains with
	 *   `total: 0` when the ranker reports no lexical signal.
	 * The query always binds the cursor.
	 */
	query?: string;
	/**
	 * Explicit text-search ordering supplied by the source-description ranker. When
	 * present it is the only lexical source: listed bucket cards first, the rest of a
	 * selected bucket in canonical order, then off-bucket matches as a rescue tail.
	 * An off-bucket match inside the ranker's overall top 3 is promoted into that head
	 * at its rank position and stays marked `rescue: true`; at most 3 are promoted.
	 * Absent it, see the full-browse contract documented on `query`.
	 */
	orderedNames?: readonly string[];
	cursor?: string;
	pageSize?: number;
}

/**
 * The wire card. `generated` is deliberately absent: a stale card already carries the
 * `unclassified` tag, and the browse result never needs the provenance flag again.
 */
export interface CatalogBrowseItem {
	name: string;
	summary: string;
	tags: readonly string[];
	/** Present only on an off-bucket match promoted into the head (ranker top 3). */
	rescue?: true;
}

/**
 * Compact browse envelope. `version`/`fingerprint` are gone because the cursor already
 * binds both; `facets` and `rest` are first-page-only so continuations stay small.
 */
export interface CatalogBrowseResult {
	total: number;
	items: readonly Readonly<CatalogBrowseItem>[];
	/** Complete selected-bucket tag counts; omitted on cursor continuations. */
	facets?: readonly Readonly<CatalogFacet>[];
	/** Remaining candidate names when the whole remainder fits one response. */
	rest?: readonly string[];
	nextCursor?: string;
	usedChars: number;
}

export interface SkillCatalogBrowser {
	readonly prepared: PreparedSkillCatalog;
	renderDirectory(budgetChars?: number): TagDirectory;
	browse(options?: CatalogBrowseOptions): CatalogBrowseResult;
}

interface CatalogBrowsePlan {
	candidates: readonly Readonly<CatalogBrowseItem>[];
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

/**
 * A malformed source is quarantined, not fatal: one unusable entry must not
 * disable discovery (or the whole optimizer) for every other skill.
 */
function sourceProblem(name: unknown, description: unknown): string | undefined {
	if (typeof name !== "string" || !name.trim() || name !== name.trim()) return "Skill source requires an exact non-empty name";
	if (typeof description !== "string") return "Skill source requires a description string";
	if (!validUnicode(name) || !validUnicode(description)) return "Skill source text must be well-formed UTF-16";
	return undefined;
}

function readSource(source: unknown): readonly [unknown, unknown] {
	const value = source !== null && (typeof source === "object" || typeof source === "function")
		? source as { name?: unknown; description?: unknown }
		: undefined;
	return [value?.name, value?.description] as const;
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
	const quarantined: Readonly<CatalogQuarantine>[] = [];
	const valid: readonly (readonly [string, string])[] = skills.flatMap((source, index) => {
		const [name, description] = readSource(source);
		const problem = sourceProblem(name, description);
		if (problem) {
			quarantined.push(Object.freeze({ index, name: typeof name === "string" ? name : null, reason: problem }));
			return [];
		}
		return [[name as string, description as string] as const];
	});
	const items = valid.map(([name, description]): Readonly<CatalogSkillItem> => {
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
	// Quarantine detail is not part of the catalog fingerprint, so a run with
	// malformed sources must not reuse (or poison) a cache entry keyed by it.
	const cacheable = quarantined.length === 0;
	const cached = cacheable ? preparedCache.get(fingerprint) : undefined;
	if (cached) return cached;
	const facets = facetsFor(items);
	const prepared = Object.freeze({
		version: CATALOG_VERSION,
		fingerprint,
		skills: Object.freeze(items),
		facets,
		total: items.length,
		unclassified: facets.find(({ id }) => id === UNCLASSIFIED)?.count ?? 0,
		quarantined: Object.freeze(quarantined),
	});
	if (cacheable) {
		preparedCache.set(fingerprint, prepared);
		while (preparedCache.size > 4) preparedCache.delete(preparedCache.keys().next().value as string);
	}
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
	const descriptions = new Map(CATALOG_TAGS.map(({ id, description }) => [id, description]));
	// Facets already carry every populated id exactly once, so the directory lists
	// only rows a model can actually select: a zero-count row is pure token cost.
	const rows = catalog.facets.map(({ id, count }) => id === UNCLASSIFIED
		? `${UNCLASSIFIED}\tMissing or stale metadata; source-description cards remain available\t${count}`
		: `${id}\t${descriptions.get(id) ?? id}\t${count}`);
	const text = [
		"<!--skill-optimizer:tags:v1-->",
		`<skill_directory version="${CATALOG_VERSION}" total="${catalog.total}" unclassified="${catalog.unclassified}">`,
		"Discovery metadata, not loaded instructions. Choose skills using the current task and work context.",
		'Use skill_search action="search" with tags (match="any" or "all") to browse cards. Query orders the selected bucket, promotes at most three description-matching cards from outside it into the head (rescue:true), and keeps the rest of those matches behind the bucket. Empty filters browse all skills. rest lists remaining names; load by exact name or continue the cursor.',
		'Load a known exact name directly with skill_search action="load" name="..."; browsing is optional.',
		"tag\tdescription\tcount",
		...rows,
		"</skill_directory>",
	].join("\n");
	if (!Number.isFinite(budgetChars) || text.length > Math.max(0, Math.trunc(budgetChars))) {
		throw new RangeError(`Complete skill directory requires ${text.length} characters; directory budget is ${budgetChars}`);
	}
	return {
		text,
		fingerprint: catalog.fingerprint,
		total: catalog.total,
		unclassified: catalog.unclassified,
		usedChars: text.length,
		quarantined: catalog.quarantined.length,
	};
}

function fingerprintText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Compact cursor: base64url({o,s}) where `s` signs {v,f,q,o}. Version and catalog
 * fingerprint never ride along — they are recomputed here and bound by the signature.
 */
function makeCursor(fingerprint: string, filterHash: string, offset: number): string {
	return Buffer.from(JSON.stringify({ o: offset, s: cursorSignature(CATALOG_VERSION, fingerprint, filterHash, offset) }), "utf8").toString("base64url");
}

function cursorSignature(version: unknown, fingerprint: unknown, filterHash: unknown, offset: unknown): string {
	return fingerprintText(JSON.stringify({ v: version, f: fingerprint, q: filterHash, o: offset })).slice(0, 16);
}

function readCursor(cursor: string, fingerprint: string, filterHash: string, total: number): number {
	try {
		if (cursor.length > 1_024) throw new Error("oversized");
		const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (!record(parsed)) throw new Error("invalid");
		const { o, s } = parsed;
		if (typeof o !== "number" || !Number.isSafeInteger(o) || o < 0 || o >= total) throw new Error("mismatch");
		if (s !== cursorSignature(CATALOG_VERSION, fingerprint, filterHash, o)) throw new Error("signature");
		return o;
	} catch {
		throw new RangeError("Invalid or stale skill catalog cursor; restart this search");
	}
}

/** Projects a prepared card onto the wire shape; page items never carry provenance. */
function browseCard(item: Readonly<CatalogSkillItem>, rescue = false): Readonly<CatalogBrowseItem> {
	return Object.freeze(rescue
		? { name: item.name, summary: item.summary, tags: item.tags, rescue: true as const }
		: { name: item.name, summary: item.summary, tags: item.tags });
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
	return browsePrepared(catalog, options);
}

/**
 * Captures values once. Registry/profile owners can reuse this browser until they
 * explicitly replace their snapshot; caller mutations never affect its cursors.
 */
export function createSkillCatalogBrowser(
	skills: readonly CatalogSkillSource[],
	metadata?: CatalogMetadata,
): SkillCatalogBrowser {
	const sources = skills.map((source) => {
		const [name, description] = readSource(source);
		return Object.freeze({ name, description }) as CatalogSkillSource;
	});
	const prepared = prepareSkillCatalog(sources, metadata);
	const plans = new Map<string, CatalogBrowsePlan>();
	return Object.freeze({
		prepared,
		renderDirectory: (budgetChars?: number) => renderPreparedDirectory(prepared, budgetChars),
		browse: (options: CatalogBrowseOptions = {}) => browsePrepared(prepared, options, plans),
	});
}

function browsePrepared(
	catalog: PreparedSkillCatalog,
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
	// Tag and empty browses are directory paths, so they page at the cap; a query-only
	// lexical search keeps the old router's 10.
	const defaultPageSize = tags.length || !query ? BROWSE_PAGE_SIZE : SEARCH_PAGE_SIZE;
	const pageSize = Math.max(1, Math.min(BROWSE_PAGE_SIZE, Math.trunc(options.pageSize ?? defaultPageSize)));
	if (!Number.isFinite(pageSize)) throw new RangeError("Invalid catalog page size");
	const planKey = JSON.stringify({ tags, match, query, orderedNames: options.orderedNames });
	let plan = plans?.get(planKey);
	if (!plan) {
		let bucket = [...catalog.skills];
		if (tags.length) bucket = bucket.filter((item) => match === "all"
			? tags.every((tag) => item.tags.includes(tag))
			: tags.some((tag) => item.tags.includes(tag)));
		let candidates: readonly Readonly<CatalogBrowseItem>[] = bucket.map((item) => browseCard(item));
		if (options.orderedNames !== undefined) {
			const byName = new Map(catalog.skills.map((item) => [item.name, item]));
			const bucketNames = new Set(bucket.map(({ name }) => name));
			const listed: Readonly<CatalogSkillItem>[] = [];
			const rescue: Readonly<CatalogSkillItem>[] = [];
			// Rank is the caller's overall order; only its first three positions may promote.
			const rank = new Map<string, number>();
			for (const name of new Set(options.orderedNames)) {
				const item = byName.get(name);
				if (!item) continue;
				rank.set(name, rank.size);
				(bucketNames.has(name) ? listed : rescue).push(item);
			}
			if (tags.length) {
				// An explicitly selected semantic bucket stays complete and keeps priority:
				// listed matches first, then the bucket's remaining cards in canonical order,
				// then off-bucket description matches as an explicit lexical rescue tail.
				// A cross-language query therefore reorders a bucket without hiding a card.
				// A rescue card inside the ranker's overall top 3 is promoted into that head
				// at its rank position (marked `rescue: true`) so the best cross-bucket hit is
				// not pushed behind a complete bucket; every other outsider stays in the tail.
				const head = [...listed];
				const promoted = new Set<string>();
				for (const item of rescue) {
					if (promoted.size >= RESCUE_PROMOTION_LIMIT || rank.get(item.name)! >= RESCUE_PROMOTION_LIMIT) continue;
					head.push(item);
					promoted.add(item.name);
				}
				head.sort((left, right) => rank.get(left.name)! - rank.get(right.name)!);
				const inHead = new Set(head.map(({ name }) => name));
				candidates = [
					...head.map((item) => browseCard(item, promoted.has(item.name))),
					...bucket.filter(({ name }) => !inHead.has(name)).map((item) => browseCard(item)),
					...rescue.filter(({ name }) => !promoted.has(name)).map((item) => browseCard(item)),
				];
			} else {
				// Query-only browsing is lexical filtering/ranking; appending the rest of the
				// catalog here would defeat the abstention the caller relies on.
				candidates = listed.map((item) => browseCard(item));
			}
		}
		plan = {
			candidates,
			// Facets describe the selected bucket only: a lexical rescue never widens them.
			facets: facetsFor(bucket),
			filterHash: fingerprintText(JSON.stringify({ tags, match, query, order: candidates.map(({ name }) => name) })),
		};
		if (plans) {
			plans.set(planKey, plan);
			while (plans.size > 8) plans.delete(plans.keys().next().value as string);
		}
	}
	const { candidates, facets, filterHash } = plan;
	const offset = options.cursor ? readCursor(options.cursor, catalog.fingerprint, filterHash, candidates.length) : 0;
	const firstPage = offset === 0;
	const page = (end: number, rest?: readonly string[]): CatalogBrowseResult => measureResult({
		total: candidates.length,
		items: candidates.slice(offset, end),
		...(firstPage ? { facets } : {}),
		...(rest?.length ? { rest } : {}),
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
	const paginated = result!;
	if (!firstPage || offset + paginated.items.length >= candidates.length) return paginated;
	// Names-only remainder: the first page names every candidate still unlisted so a
	// typical bucket (up to ~73 cards) is answerable from one response. It ships only
	// next to at least three complete cards, and the largest such page that still fits
	// the complete response cap wins; otherwise the page stays exactly as paginated.
	for (let keep = paginated.items.length; keep >= REST_MIN_CARDS; keep -= 1) {
		const rest = candidates.slice(offset + keep).map(({ name }) => name);
		const candidate = page(offset + keep, rest);
		if (candidate.usedChars <= PAGE_BUDGET_CHARS) return candidate;
	}
	return paginated;
}
