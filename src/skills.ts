import { createHash } from "node:crypto";
import { buildCatalogAliases, expandQueryTokens, type QueryAliasMap } from "./aliases.ts";
import { EMPTY_PROFILE, type SkillOptimizerProfile } from "./profile.ts";

export interface Skill {
	name: string;
	description: string;
	location: string;
}

export interface StableCatalogOptions {
	never?: readonly string[];
	intentMaxChars?: number;
	budgetChars?: number;
}

export interface CatalogBudgetOutcome {
	requestedChars: number;
	usedChars: number;
	floorChars: number;
	intentCount: number;
	nameOnlyCount: number;
	overBudgetChars: number;
}

export interface StableCatalogResult {
	text: string;
	removedChars: number;
	skills: Skill[];
	fingerprint: string;
	budget: CatalogBudgetOutcome;
}

export interface StableCatalogInspection {
	skills: Skill[];
	fingerprint: string;
	floorChars: number;
}

export interface SkillPrefetchOptions {
	profile?: SkillOptimizerProfile;
	usagePrior?: Readonly<Record<string, number>> | ReadonlyMap<string, number>;
	always?: readonly string[];
	never?: readonly string[];
	targetTopK?: number;
	minTopK?: number;
	maxTopK?: number;
	fullRenderBudgetChars?: number;
	fuzzyCandidateLimit?: number;
}

export type RankReason = "exact" | "lexical" | "fuzzy" | "profile" | "usage";

export interface RankedSkill {
	skill: Skill;
	score: number;
	lexicalScore: number;
	exactScore: number;
	fuzzyScore: number;
	usageScore: number;
	reasons: RankReason[];
	marginalChars: number;
}

export interface SkillPrefetchPlan {
	query: string;
	fingerprint: string;
	hasSignal: boolean;
	confidence: number;
	selected: Skill[];
	selectedNames: string[];
	ranked: RankedSkill[];
	marginalChars: number;
	skippedForBudget: string[];
}

export interface SkillSearchOptions extends SkillPrefetchOptions {
	cursor?: string;
	pageSize?: number;
	intentMaxChars?: number;
}

export interface SkillSearchItem {
	name: string;
	intent: string;
	score: number;
	confidence: number;
	reasons: RankReason[];
}

export interface SkillSearchResult {
	query: string;
	fingerprint: string;
	confidence: number;
	total: number;
	items: SkillSearchItem[];
	nextCursor?: string;
}

export type SkillDescriptionIssueCode =
	| "too_long"
	| "near_empty"
	| "missing_routing"
	| "duplicate_description";

export interface SkillDescriptionIssue {
	name: string;
	code: SkillDescriptionIssueCode;
	descriptionChars: number;
	relatedSkill?: string;
}

export interface SkillDescriptionAuditOptions {
	maxChars?: number;
	minChars?: number;
	duplicateThreshold?: number;
}

export interface SkillDescriptionAudit {
	skillCount: number;
	issueCount: number;
	counts: Record<SkillDescriptionIssueCode, number>;
	estimatedReducibleChars: number;
	issues: SkillDescriptionIssue[];
}

export interface SkillCatalogOptimizationResult extends StableCatalogResult {
	plan: SkillPrefetchPlan;
}

export const DEFAULT_FULL_RENDER_BUDGET_CHARS = 12_000;
export const DEFAULT_CATALOG_BUDGET_CHARS = 12_000;
export const DEFAULT_INTENT_MAX_CHARS = 96;
const AUTO_MARKER = "<!--skill-optimizer:auto:v2-->";
const CATALOG_RE = /<available_skills\b[^>]*>([\s\S]*?)<\/available_skills>/gi;
const XML_SKILL_RE = /<skill\b[^>]*>([\s\S]*?)<\/skill>/gi;
const INDEX_RE = /<skill_index\b[^>]*>([\s\S]*?)<\/skill_index>/gi;
const STABLE_CATALOG_CACHE_MAX = 8;
const FIELD_NAMES = ["name", "intent", "description", "queries"] as const;
type FieldName = typeof FIELD_NAMES[number];

const FIELD_WEIGHTS: Readonly<Record<FieldName, number>> = {
	name: 5,
	intent: 2.4,
	description: 1,
	queries: 2,
};
const FIELD_B: Readonly<Record<FieldName, number>> = {
	name: 0.2,
	intent: 0.5,
	description: 0.72,
	queries: 0.45,
};

const STOPWORDS = new Set([
	"about", "after", "again", "also", "and", "are", "con", "come", "che", "da", "del", "della",
	"delle", "dei", "degli", "di", "do", "does", "for", "from", "gli", "how", "il", "in", "into",
	"is", "it", "la", "le", "lo", "nel", "nella", "of", "on", "or", "per", "please", "questo", "that",
	"the", "this", "to", "un", "una", "use", "using", "with",
]);

function decodeXml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function encodeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function readTag(body: string, tag: string): string {
	const match = body.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
	return match ? decodeXml(match[1].trim()) : "";
}

function escapeTsv(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function unescapeTsv(text: string): string {
	let out = "";
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "\\" || index + 1 >= text.length) {
			out += text[index];
			continue;
		}
		const next = text[index + 1];
		index += 1;
		out += next === "t" ? "\t" : next === "r" ? "\r" : next === "n" ? "\n" : next;
	}
	return out;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function unique<T>(values: Iterable<T>): T[] {
	return [...new Set(values)];
}

function normalizedPhrase(text: string): string {
	return tokenize(text).join(" ");
}

export function tokenize(text: string): string[] {
	const normalized = decodeXml(text)
		.replace(/github/gi, " github ")
		.replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLocaleLowerCase("en-US")
		.replace(/[_/\\.-]+/g, " ");
	const matches = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}+#]*/gu) ?? [];
	return matches.filter((token) =>
		token.length >= 2
		&& !/^\d+$/.test(token)
		&& !STOPWORDS.has(token)
	);
}

export function parseSkills(text: string): Skill[] {
	const xmlSkills: Skill[] = [];
	for (const match of text.matchAll(XML_SKILL_RE)) {
		const body = match[1];
		const name = readTag(body, "name");
		if (!name) continue;
		xmlSkills.push({
			name,
			description: readTag(body, "description"),
			location: readTag(body, "location"),
		});
	}
	if (xmlSkills.length > 0) return xmlSkills;

	const indexed: Skill[] = [];
	for (const match of text.matchAll(INDEX_RE)) {
		const decoded = decodeXml(match[1]);
		for (const rawLine of decoded.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line) continue;
			const columns = line.split("\t").map(unescapeTsv);
			const name = columns[0]?.trim() ?? "";
			if (!name) continue;
			indexed.push({
				name,
				description: columns[1]?.trim() ?? "",
				location: columns[2]?.trim() ?? "",
			});
		}
	}
	return indexed;
}

function truncateAtWord(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	if (maxChars <= 3) return text.slice(0, maxChars);
	const boundary = text.lastIndexOf(" ", maxChars - 3);
	return `${text.slice(0, boundary >= Math.floor(maxChars / 2) ? boundary : maxChars - 3).trimEnd()}...`;
}

export function compactDescription(description: string, maxChars: number): string {
	const clean = decodeXml(description).replace(/\s+/g, " ").trim();
	if (!clean || maxChars <= 0) return "";
	const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((part) => part.trim()) ?? [clean];
	const lead = sentences[0] ?? clean;
	const routing = sentences.slice(1).find((sentence) => /\b(?:apply|load|trigger|use)\s+when\b/i.test(sentence));
	if (!routing) return truncateAtWord(lead, maxChars);
	if (lead === routing) return truncateAtWord(lead, maxChars);
	const combined = `${lead} ${routing}`;
	if (combined.length <= maxChars) return combined;
	const separator = " ";
	const minimumLead = Math.min(32, Math.max(12, Math.floor(maxChars * 0.4)));
	const routeBudget = Math.max(0, maxChars - minimumLead - separator.length);
	const shortRoute = truncateAtWord(routing, routeBudget);
	const leadBudget = Math.max(0, maxChars - shortRoute.length - separator.length);
	return truncateAtWord(`${truncateAtWord(lead, leadBudget)}${separator}${shortRoute}`.trim(), maxChars);
}

function matchesPattern(name: string, patterns: readonly string[]): boolean {
	const lower = name.toLocaleLowerCase("en-US");
	return patterns.some((rawPattern) => {
		const pattern = rawPattern.trim().toLocaleLowerCase("en-US");
		if (!pattern) return false;
		return pattern.endsWith("*") ? lower.startsWith(pattern.slice(0, -1)) : lower === pattern;
	});
}

function denseRow(skill: Skill, intentMaxChars = DEFAULT_INTENT_MAX_CHARS): string {
	const fields = [
		escapeTsv(skill.name),
		escapeTsv(compactDescription(skill.description, intentMaxChars)),
	];
	while (fields.length > 1 && fields.at(-1) === "") fields.pop();
	return fields.map(encodeXml).join("\t");
}

function renderStableBlock(skills: readonly Skill[], intentLimits: readonly number[]): string {
	const rows = skills.map((skill, index) => denseRow(skill, intentLimits[index] ?? 0)).join("\n");
	return [
		"<available_skills>",
		AUTO_MARKER,
		"<skill_resolver>Load full instructions for any listed name with skill_search.</skill_resolver>",
		'<skill_index format="tsv" columns="name,intent">',
		rows,
		"</skill_index>",
		"</available_skills>",
	].join("\n");
}

function canonicalSkillData(skills: readonly Skill[]): string {
	return skills.map((skill) =>
		`${skill.name.length}:${skill.name}${skill.description.length}:${skill.description}`
	).join("");
}

export function catalogFingerprint(skills: readonly Skill[]): string {
	return createHash("sha256").update(canonicalSkillData(skills), "utf8").digest("hex");
}

interface PreparedStableCatalogBlock {
	blockIndex: number;
	marked: boolean;
	parsed: readonly Skill[];
	retained: readonly Skill[];
}

interface PreparedStableCatalog {
	cacheKey: string;
	source: string;
	exclusions: string;
	blocks: readonly PreparedStableCatalogBlock[];
	skills: readonly Skill[];
	fingerprint: string;
	floorChars: number;
}

const stableCatalogCache = new Map<string, PreparedStableCatalog>();
const stableCatalogRenderCache = new Map<string, StableCatalogResult>();

function prepareStableCatalog(text: string, never: readonly string[]): PreparedStableCatalog {
	const exclusions = JSON.stringify(never);
	const cacheKey = createHash("sha256")
		.update("pi-skill-optimizer:stable-catalog:v1\0", "utf8")
		.update(exclusions, "utf8")
		.update("\0", "utf8")
		.update(text, "utf8")
		.digest("hex");
	const cached = stableCatalogCache.get(cacheKey);
	if (cached?.source === text && cached.exclusions === exclusions) {
		stableCatalogCache.delete(cacheKey);
		stableCatalogCache.set(cacheKey, cached);
		return cached;
	}

	const blocks = [...text.matchAll(CATALOG_RE)].map((match, blockIndex): PreparedStableCatalogBlock => {
		const inner = match[1];
		const parsed = parseSkills(inner);
		return {
			blockIndex,
			marked: inner.includes(AUTO_MARKER),
			parsed,
			retained: parsed.filter((skill) => !matchesPattern(skill.name, never)),
		};
	});
	const skills = [...new Map(blocks
		.flatMap((block) => block.retained)
		.map((skill) => [skill.name, skill])).values()];
	const floorChars = blocks
		.filter((block) => !block.marked && block.parsed.length > 0)
		.reduce((sum, block) => sum + renderStableBlock(block.retained, block.retained.map(() => 0)).length, 0);
	const prepared: PreparedStableCatalog = {
		cacheKey,
		source: text,
		exclusions,
		blocks,
		skills,
		fingerprint: catalogFingerprint(skills),
		floorChars,
	};
	stableCatalogCache.set(cacheKey, prepared);
	while (stableCatalogCache.size > STABLE_CATALOG_CACHE_MAX) {
		stableCatalogCache.delete(stableCatalogCache.keys().next().value as string);
	}
	return prepared;
}

function cloneStableCatalogResult(result: StableCatalogResult): StableCatalogResult {
	return {
		...result,
		skills: result.skills.map((skill) => ({ ...skill })),
		budget: { ...result.budget },
	};
}

/** Inspect the immutable all-name floor without rendering the catalog a first time. */
export function inspectStableSkillCatalog(
	text: string,
	options: Omit<StableCatalogOptions, "budgetChars"> = {},
): StableCatalogInspection {
	const prepared = prepareStableCatalog(text, options.never ?? []);
	return {
		skills: prepared.skills.map((skill) => ({ ...skill })),
		fingerprint: prepared.fingerprint,
		floorChars: prepared.floorChars,
	};
}

export function renderStableSkillCatalog(text: string, options: StableCatalogOptions = {}): StableCatalogResult {
	const never = options.never ?? [];
	const intentMaxChars = clamp(Math.trunc(options.intentMaxChars ?? DEFAULT_INTENT_MAX_CHARS), 24, 240);
	const requestedChars = Math.max(0, Math.trunc(options.budgetChars ?? DEFAULT_CATALOG_BUDGET_CHARS));
	const prepared = prepareStableCatalog(text, never);
	const renderCacheKey = `${prepared.cacheKey}:${intentMaxChars}:${requestedChars}`;
	const cached = stableCatalogRenderCache.get(renderCacheKey);
	if (cached) {
		stableCatalogRenderCache.delete(renderCacheKey);
		stableCatalogRenderCache.set(renderCacheKey, cached);
		return cloneStableCatalogResult(cached);
	}
	const blocks = prepared.blocks.map((block) => ({
		...block,
		intentLimits: block.retained.map(() => 0),
	}));
	const rawBlocks = blocks.filter((block) => !block.marked && block.parsed.length > 0);
	const floorChars = prepared.floorChars;
	let remaining = Math.max(0, requestedChars - floorChars);
	const candidates = rawBlocks.flatMap((block) => block.retained
		.map((skill, skillIndex) => {
			if (!skill.description) return undefined;
			const floor = denseRow(skill, 0).length;
			const full = denseRow(skill, intentMaxChars).length;
			return {
				block,
				skill,
				skillIndex,
				cost: full - floor,
			};
		})
		.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined))
		.sort((left, right) =>
			left.cost - right.cost
			|| left.skill.name.localeCompare(right.skill.name)
			|| left.block.blockIndex - right.block.blockIndex
			|| left.skillIndex - right.skillIndex
		);
	const deferred: typeof candidates = [];
	for (const candidate of candidates) {
		if (candidate.cost <= remaining) {
			candidate.block.intentLimits[candidate.skillIndex] = intentMaxChars;
			remaining -= candidate.cost;
		} else {
			deferred.push(candidate);
		}
	}
	// Spend a useful remainder on one partial intent rather than padding or
	// exceeding the cap. The binary search accounts for XML/TSV escaping.
	if (remaining > 4) {
		for (const candidate of deferred) {
			const floor = denseRow(candidate.skill, 0).length;
			let low = 24;
			let high = intentMaxChars;
			let best = 0;
			while (low <= high) {
				const middle = Math.floor((low + high) / 2);
				const cost = denseRow(candidate.skill, middle).length - floor;
				if (cost <= remaining) {
					best = middle;
					low = middle + 1;
				} else {
					high = middle - 1;
				}
			}
			if (best > 0 && denseRow(candidate.skill, best).length > floor) {
				candidate.block.intentLimits[candidate.skillIndex] = best;
				remaining -= denseRow(candidate.skill, best).length - floor;
				break;
			}
		}
	}
	let changed = false;
	let blockCursor = 0;
	let usedChars = 0;
	let intentCount = 0;
	let nameOnlyCount = 0;
	const next = text.replace(CATALOG_RE, (block, inner: string) => {
		const state = blocks[blockCursor++];
		if (!state || state.parsed.length === 0) return block;
		if (state.marked) {
			usedChars += block.length;
			for (const skill of state.retained) {
				if (skill.description) intentCount += 1;
				else nameOnlyCount += 1;
			}
			return block;
		}
		const rebuilt = renderStableBlock(state.retained, state.intentLimits);
		usedChars += rebuilt.length;
		for (const limit of state.intentLimits) {
			if (limit > 0) intentCount += 1;
			else nameOnlyCount += 1;
		}
		changed = true;
		return rebuilt;
	});
	const result: StableCatalogResult = {
		text: changed ? next : text,
		removedChars: changed ? Math.max(0, text.length - next.length) : 0,
		skills: prepared.skills.map((skill) => ({ ...skill })),
		fingerprint: prepared.fingerprint,
		budget: {
			requestedChars,
			usedChars,
			floorChars,
			intentCount,
			nameOnlyCount,
			overBudgetChars: Math.max(0, usedChars - requestedChars),
		},
	};
	stableCatalogRenderCache.set(renderCacheKey, result);
	while (stableCatalogRenderCache.size > STABLE_CATALOG_CACHE_MAX) {
		stableCatalogRenderCache.delete(stableCatalogRenderCache.keys().next().value as string);
	}
	return cloneStableCatalogResult(result);
}

interface TermDocument {
	fields: Record<FieldName, Map<string, number>>;
	allTerms: Set<string>;
	nameTerms: Set<string>;
	intentTerms: Set<string>;
	aliasLabels: string[];
}

interface CatalogAnalysis {
	skills: readonly Skill[];
	documents: TermDocument[];
	df: Map<string, number>;
	averageLengths: Record<FieldName, number>;
	aliases: QueryAliasMap;
	profile: SkillOptimizerProfile;
	fingerprint: string;
}

const ANALYSIS_CACHE_MAX = 8;
const analysisCache = new Map<string, CatalogAnalysis>();

function termFrequency(tokens: readonly string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const token of tokens) out.set(token, (out.get(token) ?? 0) + 1);
	return out;
}

function stableObject(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableObject);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => [key, stableObject(item)]));
}

function profileFingerprint(profile: SkillOptimizerProfile): string {
	return createHash("sha256").update(JSON.stringify(stableObject(profile)), "utf8").digest("hex");
}

function routingIntent(description: string): string {
	return compactDescription(description, DEFAULT_INTENT_MAX_CHARS);
}

function analyzeCatalog(skills: readonly Skill[], profile: SkillOptimizerProfile): CatalogAnalysis {
	const fingerprint = catalogFingerprint(skills);
	const cacheKey = `${fingerprint}:${profileFingerprint(profile)}`;
	const cached = analysisCache.get(cacheKey);
	if (cached) {
		analysisCache.delete(cacheKey);
		analysisCache.set(cacheKey, cached);
		return cached;
	}

	const documents = skills.map((skill): TermDocument => {
		const fields: Record<FieldName, Map<string, number>> = {
			name: termFrequency(tokenize(skill.name)),
			intent: termFrequency(tokenize(routingIntent(skill.description))),
			description: termFrequency(tokenize(skill.description)),
			queries: termFrequency((profile.queries[skill.name] ?? []).flatMap(tokenize)),
		};
		const allTerms = new Set(FIELD_NAMES.flatMap((field) => [...fields[field].keys()]));
		return {
			fields,
			allTerms,
			nameTerms: new Set(fields.name.keys()),
			intentTerms: new Set(fields.intent.keys()),
			aliasLabels: [],
		};
	});
	const df = new Map<string, number>();
	for (const document of documents) {
		for (const term of document.allTerms) df.set(term, (df.get(term) ?? 0) + 1);
	}
	const aliases = buildCatalogAliases((term) => df.has(term));
	for (const document of documents) {
		for (const [source, targets] of aliases) {
			if (targets.some((target) => document.allTerms.has(target))) document.aliasLabels.push(source);
		}
	}
	const averageLengths = Object.fromEntries(FIELD_NAMES.map((field) => {
		const total = documents.reduce((sum, document) =>
			sum + [...document.fields[field].values()].reduce((count, frequency) => count + frequency, 0), 0);
		return [field, Math.max(1, total / Math.max(1, documents.length))];
	})) as Record<FieldName, number>;
	const analysis: CatalogAnalysis = { skills, documents, df, averageLengths, aliases, profile, fingerprint };
	analysisCache.set(cacheKey, analysis);
	while (analysisCache.size > ANALYSIS_CACHE_MAX) analysisCache.delete(analysisCache.keys().next().value as string);
	return analysis;
}

function bm25fScore(analysis: CatalogAnalysis, index: number, terms: readonly string[]): number {
	const document = analysis.documents[index];
	const count = Math.max(1, analysis.documents.length);
	let score = 0;
	for (const term of unique(terms)) {
		const documentFrequency = analysis.df.get(term) ?? 0;
		if (documentFrequency === 0) continue;
		let weightedFrequency = 0;
		for (const field of FIELD_NAMES) {
			const values = document.fields[field];
			const frequency = values.get(term) ?? 0;
			if (frequency === 0) continue;
			const length = [...values.values()].reduce((sum, value) => sum + value, 0);
			const normalization = 1 - FIELD_B[field] + FIELD_B[field] * (length / analysis.averageLengths[field]);
			weightedFrequency += FIELD_WEIGHTS[field] * frequency / Math.max(0.2, normalization);
		}
		const idf = Math.log(1 + (count - documentFrequency + 0.5) / (documentFrequency + 0.5));
		score += idf * (weightedFrequency * 2.2) / (weightedFrequency + 1.2);
	}
	return score;
}

function exactScore(analysis: CatalogAnalysis, index: number, query: string, rawTerms: readonly string[]): number {
	const skill = analysis.skills[index];
	const document = analysis.documents[index];
	const queryPhrase = normalizedPhrase(query);
	const namePhrase = normalizedPhrase(skill.name);
	let score = 0;
	if (namePhrase && (queryPhrase === namePhrase || queryPhrase.includes(namePhrase))) score = 12;
	else if (document.nameTerms.size > 0 && [...document.nameTerms].every((term) => rawTerms.includes(term))) score = 8;
	else if (rawTerms.some((term) => document.nameTerms.has(term))) score = 3;
	for (const example of analysis.profile.queries[skill.name] ?? []) {
		const examplePhrase = normalizedPhrase(example);
		if (examplePhrase && (queryPhrase === examplePhrase || queryPhrase.includes(examplePhrase))) score = Math.max(score, 7);
	}
	if (rawTerms.some((term) => document.aliasLabels.includes(term))) score = Math.max(score, 4);
	return score;
}

function trigrams(text: string): Set<string> {
	const normalized = text.replace(/\s+/g, "");
	const out = new Set<string>();
	if (normalized.length < 3) return out;
	for (let index = 0; index <= normalized.length - 3; index += 1) out.add(normalized.slice(index, index + 3));
	return out;
}

function dice(left: Set<string>, right: Set<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const value of left) if (right.has(value)) intersection += 1;
	return 2 * intersection / (left.size + right.size);
}

function terminalLabelSegment(value: string): string {
	return value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.at(-1) ?? "";
}

function fuzzyScores(
	analysis: CatalogAnalysis,
	query: string,
	rawTerms: readonly string[],
	coverage: number,
	limit: number,
): number[] {
	const scores = analysis.skills.map(() => 0);
	if (rawTerms.length === 0 || coverage >= 0.6 || limit <= 0) return scores;
	const queryLabels = rawTerms.filter((term) => term.length >= 5);
	if (queryLabels.length === 0) return scores;
	const querySuffix = terminalLabelSegment(query);
	for (let index = 0; index < analysis.documents.length; index += 1) {
		const skill = analysis.skills[index];
		const labels = unique([
			normalizedPhrase(skill.name).replace(/\s+/g, ""),
			...tokenize(skill.name),
			...analysis.documents[index].aliasLabels,
		]).filter((label) => label.length >= 5);
		let best = 0;
		for (const queryLabel of queryLabels) {
			const queryTrigrams = trigrams(queryLabel);
			for (const label of labels) best = Math.max(best, dice(queryTrigrams, trigrams(label)));
		}
		if (best >= 0.56) {
			const nameSuffix = terminalLabelSegment(skill.name);
			scores[index] = querySuffix && nameSuffix === querySuffix ? Math.min(1, best + 0.08) : best;
		}
	}
	const candidates = scores
		.map((score, index) => ({ score, index }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index);
	for (const candidate of candidates.slice(limit)) scores[candidate.index] = 0;
	return scores;
}

function isUsageMap(
	prior: NonNullable<SkillPrefetchOptions["usagePrior"]>,
): prior is ReadonlyMap<string, number> {
	return typeof (prior as { get?: unknown }).get === "function";
}

function usageValue(prior: SkillPrefetchOptions["usagePrior"], name: string): number {
	if (!prior) return 0;
	const value = isUsageMap(prior) ? prior.get(name) : prior[name];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function addRrfSignal(
	out: number[],
	values: readonly number[],
	weight: number,
	eligible?: ReadonlySet<number>,
): void {
	const ranked = values
		.map((value, index) => ({ value, index }))
		.filter(({ value, index }) => value > 0 && (!eligible || eligible.has(index)))
		.sort((a, b) => b.value - a.value || a.index - b.index);
	for (let rank = 0; rank < ranked.length; rank += 1) {
		out[ranked[rank].index] += weight / (60 + rank + 1);
	}
}

function skillClusters(profile: SkillOptimizerProfile): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const [cluster, names] of Object.entries(profile.clusters)) {
		for (const name of names) out.set(name, [...(out.get(name) ?? []), cluster]);
	}
	return out;
}

function diversityOrder(
	ranked: readonly RankedSkill[],
	profile: SkillOptimizerProfile,
	prefixLimit: number,
): RankedSkill[] {
	const remaining = [...ranked];
	const ordered: RankedSkill[] = [];
	const clusterCounts = new Map<string, number>();
	const clusters = skillClusters(profile);
	const limit = clamp(Math.trunc(prefixLimit), 0, ranked.length);
	while (remaining.length > 0 && ordered.length < limit) {
		let bestIndex = 0;
		let bestAdjusted = -Infinity;
		for (let index = 0; index < remaining.length; index += 1) {
			const repeated = (clusters.get(remaining[index].skill.name) ?? [])
				.reduce((sum, cluster) => sum + (clusterCounts.get(cluster) ?? 0), 0);
			const adjusted = remaining[index].score / (1 + repeated * 0.18);
			if (adjusted > bestAdjusted) {
				bestAdjusted = adjusted;
				bestIndex = index;
			}
		}
		const [picked] = remaining.splice(bestIndex, 1);
		ordered.push(picked);
		for (const cluster of clusters.get(picked.skill.name) ?? []) {
			clusterCounts.set(cluster, (clusterCounts.get(cluster) ?? 0) + 1);
		}
	}
	return ordered.length === ranked.length ? ordered : [...ordered, ...remaining];
}

function renderFullSkill(skill: Skill): string {
	const parts = [
		"  <skill>",
		`    <name>${encodeXml(skill.name)}</name>`,
	];
	if (skill.description) parts.push(`    <description>${encodeXml(skill.description)}</description>`);
	parts.push("  </skill>");
	return parts.join("\n");
}

function marginalRenderChars(skill: Skill): number {
	return Math.max(0, renderFullSkill(skill).length - denseRow(skill).length);
}

function emptyPlan(query: string, skills: readonly Skill[]): SkillPrefetchPlan {
	return {
		query,
		fingerprint: catalogFingerprint(skills),
		hasSignal: false,
		confidence: 0,
		selected: [],
		selectedNames: [],
		ranked: [],
		marginalChars: 0,
		skippedForBudget: [],
	};
}

export function planSkillPrefetch(
	skills: readonly Skill[],
	query: string,
	options: SkillPrefetchOptions = {},
): SkillPrefetchPlan {
	const profile = options.profile ?? EMPTY_PROFILE;
	const never = options.never ?? [];
	const available = skills.filter((skill) => !matchesPattern(skill.name, never));
	if (available.length === 0) return emptyPlan(query, available);
	const analysis = analyzeCatalog(available, profile);
	const rawTerms = unique(tokenize(query));
	const expandedTerms = expandQueryTokens(rawTerms, analysis.aliases);
	const termMatches = rawTerms.filter((term) =>
		analysis.df.has(term) || (analysis.aliases.get(term)?.length ?? 0) > 0
	).length;
	const coverage = rawTerms.length > 0 ? termMatches / rawTerms.length : 0;
	const lexical = available.map((_, index) => bm25fScore(analysis, index, expandedTerms));
	const exact = available.map((_, index) => exactScore(analysis, index, query, rawTerms));
	const fuzzy = fuzzyScores(
		analysis,
		query,
		rawTerms,
		coverage,
		clamp(Math.trunc(options.fuzzyCandidateLimit ?? 12), 0, 32),
	);
	const eligible = new Set<number>();
	for (let index = 0; index < available.length; index += 1) {
		if (lexical[index] > 0 || exact[index] > 0 || fuzzy[index] > 0) eligible.add(index);
	}
	const hasSignal = rawTerms.length > 0 && eligible.size > 0;
	const usage = available.map((skill) => usageValue(options.usagePrior, skill.name));
	const maximumUsage = Math.max(0, ...usage);
	const normalizedUsage = usage.map((value) => maximumUsage > 0 ? value / maximumUsage : 0);
	const fused = available.map(() => 0);
	addRrfSignal(fused, lexical, 1.5);
	addRrfSignal(fused, exact, 2.2);
	addRrfSignal(fused, fuzzy, 0.8);
	if (hasSignal) addRrfSignal(fused, normalizedUsage, 0.35, eligible);

	for (let index = 0; index < available.length; index += 1) {
		const negative = new Set((profile.negativeHints[available[index].name] ?? []).flatMap(tokenize));
		if (rawTerms.some((term) => negative.has(term))) fused[index] *= 0.55;
	}

	let ranked = available
		.map((skill, index): RankedSkill => {
			const reasons: RankReason[] = [];
			if (exact[index] > 0) reasons.push("exact");
			if (lexical[index] > 0) reasons.push("lexical");
			if (fuzzy[index] > 0) reasons.push("fuzzy");
			if ((profile.queries[skill.name]?.length ?? 0) > 0 && lexical[index] > 0) reasons.push("profile");
			if (normalizedUsage[index] > 0 && eligible.has(index)) reasons.push("usage");
			return {
				skill,
				score: fused[index] * 100,
				lexicalScore: lexical[index],
				exactScore: exact[index],
				fuzzyScore: fuzzy[index],
				usageScore: normalizedUsage[index],
				reasons,
				marginalChars: marginalRenderChars(skill),
			};
		})
		.filter((entry, index) => hasSignal && eligible.has(index) && entry.score > 0)
		.sort((left, right) => right.score - left.score || right.exactScore - left.exactScore || left.skill.name.localeCompare(right.skill.name));
	const minTopK = clamp(Math.trunc(options.minTopK ?? 3), 0, available.length);
	const maxTopK = clamp(Math.trunc(options.maxTopK ?? 16), minTopK, available.length);
	const targetTopK = clamp(Math.trunc(options.targetTopK ?? 8), minTopK, maxTopK);
	ranked = diversityOrder(ranked, profile, maxTopK);

	const top = ranked[0]?.score ?? 0;
	const second = ranked[1]?.score ?? 0;
	const gap = top > 0 ? clamp((top - second) / top, 0, 1) : 0;
	const exactConfidence = (ranked[0]?.exactScore ?? 0) >= 7 ? 1 : (ranked[0]?.exactScore ?? 0) > 0 ? 0.5 : 0;
	const confidence = hasSignal ? clamp(0.15 + 0.35 * coverage + 0.35 * exactConfidence + 0.15 * gap, 0, 1) : 0;
	let desired = confidence >= 0.8
		? minTopK
		: confidence <= 0.35
			? maxTopK
			: targetTopK;
	if (confidence < 0.8 && desired > 0 && ranked.length > desired) {
		const boundary = ranked[desired - 1]?.score ?? 0;
		while (desired < maxTopK && (ranked[desired]?.score ?? 0) >= boundary * 0.9) desired += 1;
	}

	const protectedNames = new Set([
		...profile.critical,
		...(options.always ?? []),
	].filter((name) => available.some((skill) => skill.name === name)));
	const selected: Skill[] = [];
	const selectedNames = new Set<string>();
	for (const skill of available) {
		if (!protectedNames.has(skill.name)) continue;
		selected.push(skill);
		selectedNames.add(skill.name);
	}
	const budget = Math.max(0, Math.trunc(options.fullRenderBudgetChars ?? DEFAULT_FULL_RENDER_BUDGET_CHARS));
	let marginalChars = selected.reduce((sum, skill) => sum + marginalRenderChars(skill), 0);
	let ordinaryChars = 0;
	let ordinaryCount = 0;
	const skippedForBudget: string[] = [];
	for (const entry of ranked) {
		if (ordinaryCount >= desired) break;
		if (selectedNames.has(entry.skill.name)) continue;
		if (ordinaryChars + entry.marginalChars > budget) {
			skippedForBudget.push(entry.skill.name);
			continue;
		}
		selected.push(entry.skill);
		selectedNames.add(entry.skill.name);
		ordinaryChars += entry.marginalChars;
		marginalChars += entry.marginalChars;
		ordinaryCount += 1;
	}
	return {
		query,
		fingerprint: analysis.fingerprint,
		hasSignal,
		confidence,
		selected,
		selectedNames: selected.map((skill) => skill.name),
		ranked,
		marginalChars,
		skippedForBudget,
	};
}

export function renderSkillPrefetch(plan: SkillPrefetchPlan): string {
	if (plan.selected.length === 0) return "";
	return [
		`<skill_prefetch catalog_sha256="${plan.fingerprint}">`,
		"  <skill_resolver>Use skill_search(name) to load the full skill resource.</skill_resolver>",
		...plan.selected.map(renderFullSkill),
		"</skill_prefetch>",
	].join("\n");
}

interface SearchCursorPayload {
	v: 1;
	f: string;
	q: string;
	o: number;
	s: string;
}

function searchQueryFingerprint(query: string): string {
	return createHash("sha256").update(query, "utf8").digest("hex");
}

function cursorSignature(fingerprint: string, queryHash: string, offset: number): string {
	return createHash("sha256")
		.update(`pi-skill-optimizer:cursor:v1\0${fingerprint}\0${queryHash}\0${offset}`, "utf8")
		.digest("hex")
		.slice(0, 24);
}

function encodeSearchCursor(fingerprint: string, queryHash: string, offset: number): string {
	const payload: SearchCursorPayload = {
		v: 1,
		f: fingerprint,
		q: queryHash,
		o: offset,
		s: cursorSignature(fingerprint, queryHash, offset),
	};
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeSearchCursor(cursor: string, fingerprint: string, queryHash: string): number {
	try {
		const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<SearchCursorPayload>;
		if (
			payload.v !== 1
			|| payload.f !== fingerprint
			|| payload.q !== queryHash
			|| !Number.isSafeInteger(payload.o)
			|| (payload.o ?? -1) < 0
			|| payload.s !== cursorSignature(fingerprint, queryHash, payload.o as number)
		) throw new Error("mismatch");
		return payload.o as number;
	} catch {
		throw new RangeError("Invalid or stale skill search cursor");
	}
}

export function searchSkillCatalog(
	skills: readonly Skill[],
	query: string,
	options: SkillSearchOptions = {},
): SkillSearchResult {
	const plan = planSkillPrefetch(skills, query, options);
	const pageSize = clamp(Math.trunc(options.pageSize ?? 10), 1, 50);
	const queryHash = searchQueryFingerprint(query);
	const offset = options.cursor
		? decodeSearchCursor(options.cursor, plan.fingerprint, queryHash)
		: 0;
	const intentMaxChars = clamp(Math.trunc(options.intentMaxChars ?? DEFAULT_INTENT_MAX_CHARS), 24, 240);
	const page = plan.ranked.slice(offset, offset + pageSize);
	const topScore = plan.ranked[0]?.score ?? 0;
	const items = page.map((entry): SkillSearchItem => ({
		name: entry.skill.name,
		intent: compactDescription(entry.skill.description, intentMaxChars),
		score: entry.score,
		confidence: entry.exactScore >= 12
			? 1
			: entry.exactScore >= 8
				? Math.max(0.95, plan.confidence)
				: clamp(plan.confidence * (topScore > 0 ? entry.score / topScore : 0), 0, 0.94),
		reasons: [...entry.reasons],
	}));
	const nextOffset = offset + page.length;
	return {
		query,
		fingerprint: plan.fingerprint,
		confidence: plan.confidence,
		total: plan.ranked.length,
		items,
		...(nextOffset < plan.ranked.length
			? { nextCursor: encodeSearchCursor(plan.fingerprint, queryHash, nextOffset) }
			: {}),
	};
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const value of left) if (right.has(value)) intersection += 1;
	return intersection / (left.size + right.size - intersection);
}

export function auditSkillDescriptions(
	skills: readonly Skill[],
	options: SkillDescriptionAuditOptions = {},
): SkillDescriptionAudit {
	const maxChars = clamp(Math.trunc(options.maxChars ?? 600), 80, 10_000);
	const minChars = clamp(Math.trunc(options.minChars ?? 24), 1, maxChars);
	const duplicateThreshold = clamp(options.duplicateThreshold ?? 0.9, 0.7, 1);
	const issues: SkillDescriptionIssue[] = [];
	const tokenSets = skills.map((skill) => new Set(tokenize(skill.description)));
	const routingPattern = /\b(?:apply|load|trigger|use)\s+when\b|\bwhen\s+(?:handling|reviewing|working|you|your)\b|\bfor\s+(?:requests?|tasks?|workflows?|cases?|projects?)\b/i;
	let estimatedReducibleChars = 0;
	for (let index = 0; index < skills.length; index += 1) {
		const skill = skills[index];
		const clean = skill.description.replace(/\s+/g, " ").trim();
		if (clean.length > maxChars) {
			issues.push({ name: skill.name, code: "too_long", descriptionChars: clean.length });
			estimatedReducibleChars += clean.length - maxChars;
		}
		if (clean.length < minChars || tokenSets[index].size < 3) {
			issues.push({ name: skill.name, code: "near_empty", descriptionChars: clean.length });
		} else if (!routingPattern.test(clean)) {
			issues.push({ name: skill.name, code: "missing_routing", descriptionChars: clean.length });
		}
		for (let previous = 0; previous < index; previous += 1) {
			if (tokenSets[index].size < 5 || tokenSets[previous].size < 5) continue;
			if (jaccard(tokenSets[index], tokenSets[previous]) < duplicateThreshold) continue;
			issues.push({
				name: skill.name,
				code: "duplicate_description",
				descriptionChars: clean.length,
				relatedSkill: skills[previous].name,
			});
			break;
		}
	}
	const counts: Record<SkillDescriptionIssueCode, number> = {
		too_long: 0,
		near_empty: 0,
		missing_routing: 0,
		duplicate_description: 0,
	};
	for (const issue of issues) counts[issue.code] += 1;
	return {
		skillCount: skills.length,
		issueCount: issues.length,
		counts,
		estimatedReducibleChars,
		issues,
	};
}

export function optimizeSkillCatalog(
	text: string,
	query: string,
	options: SkillPrefetchOptions & StableCatalogOptions = {},
): SkillCatalogOptimizationResult {
	const stable = renderStableSkillCatalog(text, options);
	return {
		...stable,
		plan: planSkillPrefetch(stable.skills, query, options),
	};
}
