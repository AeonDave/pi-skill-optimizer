/**
 * Pure skill-catalog intelligence — no Pi imports, fully unit-testable.
 *
 * Pi inlines an `<available_skills>` catalog (one `<skill>` entry — name,
 * description, location — per installed skill) into every request. This is the
 * Level-1 *discovery* layer of Anthropic's progressive-disclosure design: enough
 * for the model to know a skill exists and when to use it, without loading its
 * body. With hundreds of skills it is the dominant input-token cost.
 *
 * This module rewrites that catalog instead of nuking it, so skills stay
 * discoverable:
 *   - `compact`: keep every skill, trim each description to its intent sentence.
 *   - `hybrid` : lexically score skills against the request's own query, keep the
 *                top-K relevant ones at full description, compact the long tail.
 *
 * The scorer is dependency-free BM25-style lexical matching over the catalog
 * itself (skill descriptions are keyword-dense — "RSA", "SMB", "hashcat" — so
 * lexical routing is strong); embeddings are a later upgrade. No filesystem
 * access: the catalog in the request is self-contained.
 */

import { buildCatalogAliases, expandQueryTokens, type QueryAliasMap } from "./aliases.ts";
import { EMPTY_PROFILE, type SkillOptimizerProfile } from "./profile.ts";

export interface Skill {
	name: string;
	description: string;
	location: string;
}

/** What to do with the `<available_skills>` catalog. */
export type SkillMode = "off" | "strip" | "compact" | "hybrid";

export interface SkillTransformOptions {
	/** Only `compact` and `hybrid` are handled here; `off`/`strip` are handled by the caller. */
	mode: "compact" | "hybrid";
	/** hybrid: how many relevant skills keep their full description. */
	topK: number;
	/** Max chars for a compacted (tail) description. */
	tailChars: number;
	/** Keep `<location>` on compacted entries too (safer, larger). Full entries always keep it. */
	keepLocations: boolean;
	/** The request's query text, used to rank skills in `hybrid` mode. */
	query: string;
	/** User-specific init profile: aliases, synthetic queries, critical skills. */
	profile?: SkillOptimizerProfile;
	/** Usage-derived skills that should stay fully described. */
	pinnedSkills?: readonly string[];
	/** Use adaptive top-K selection around the requested topK. */
	adaptiveTopK?: boolean;
	minTopK?: number;
	maxTopK?: number;
	/** If ranking has no signal, keep this many chars of every tail description instead of name-only. */
	safeFallbackTailChars?: number;
}

export interface SkillTransformResult {
	text: string;
	removed: number;
	/** Names kept at full description (hybrid), for diagnostics. */
	selected: string[];
}

const BLOCK_RE = /<available_skills>([\s\S]*?)<\/available_skills>/g;
const SKILL_RE =
	/<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*(?:<location>([\s\S]*?)<\/location>\s*)?<\/skill>/g;
const MAX_CATALOG_CACHE_ENTRIES = 16;

/** Minimal stopword set (EN + a few IT, since prompts may be Italian). IDF handles the rest. */
const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "for", "with", "to", "of", "in", "on", "at", "is", "are", "be",
	"this", "that", "it", "as", "by", "from", "you", "your", "me", "my", "how", "do", "does", "can",
	"use", "used", "using", "when", "what", "which", "please", "help", "need", "want", "get", "make",
	"la", "il", "lo", "le", "un", "una", "di", "che", "per", "con", "come", "mi", "si", "non", "e", "o",
]);

interface CatalogAnalysis {
	skills: Skill[];
	skillTokenSets: Array<ReadonlySet<string>>;
	nameTokenSets: Array<ReadonlySet<string>>;
	negativeHintTokenSets: Array<ReadonlySet<string>>;
	termFreqs: Array<ReadonlyMap<string, number>>;
	docLengths: number[];
	avgDocLength: number;
	df: ReadonlyMap<string, number>;
	aliases: QueryAliasMap;
}

const catalogCache = new Map<string, CatalogAnalysis>();

/** Lowercase, decode common entities, split on non-alphanumerics, keep letter-bearing tokens len ≥ 2. */
export function tokenize(text: string): string[] {
	const cleaned = text
		.toLowerCase()
		.replace(/&[a-z]+;/g, " ")
		.replace(/&#\d+;/g, " ");
	const out: string[] = [];
	for (const raw of cleaned.split(/[^a-z0-9]+/)) {
		if (raw.length < 2 || !/[a-z]/.test(raw) || STOPWORDS.has(raw)) continue;
		out.push(raw);
	}
	return out;
}

/** Parse the inner text of an `<available_skills>` block into skills (in order). */
export function parseSkills(inner: string): Skill[] {
	const skills: Skill[] = [];
	SKILL_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = SKILL_RE.exec(inner)) !== null) {
		skills.push({
			name: match[1].trim(),
			description: match[2].trim(),
			location: (match[3] ?? "").trim(),
		});
	}
	return skills;
}

function profileSignature(profile: SkillOptimizerProfile): string {
	return JSON.stringify({
		aliases: profile.aliases,
		queries: profile.queries,
		negativeHints: profile.negativeHints,
	});
}

function tokenCounts(tokens: readonly string[]): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

function analyzeSkills(skills: readonly Skill[], profile: SkillOptimizerProfile = EMPTY_PROFILE): CatalogAnalysis {
	const docTokens = skills.map((s) => tokenize(`${s.name} ${s.description} ${(profile.queries[s.name] ?? []).join(" ")}`));
	const skillTokenSets = docTokens.map((tokens) => new Set(tokens));
	const nameTokenSets = skills.map((s) => new Set(tokenize(s.name)));
	const negativeHintTokenSets = skills.map((s) => new Set(tokenize((profile.negativeHints[s.name] ?? []).join(" "))));
	const termFreqs = docTokens.map(tokenCounts);
	const docLengths = docTokens.map((tokens) => Math.max(1, tokens.length));
	const avgDocLength = docLengths.reduce((sum, length) => sum + length, 0) / Math.max(1, docLengths.length);
	const df = new Map<string, number>();
	for (const set of skillTokenSets) for (const term of set) df.set(term, (df.get(term) ?? 0) + 1);
	const aliases = buildCatalogAliases((term) => df.has(term), profile.aliases);
	return { skills: [...skills], skillTokenSets, nameTokenSets, negativeHintTokenSets, termFreqs, docLengths, avgDocLength, df, aliases };
}

function analyzeCatalog(inner: string, profile: SkillOptimizerProfile): CatalogAnalysis {
	const cacheKey = `${profileSignature(profile)}\n${inner}`;
	const cached = catalogCache.get(cacheKey);
	if (cached) return cached;
	const analysis = analyzeSkills(parseSkills(inner), profile);
	catalogCache.set(cacheKey, analysis);
	if (catalogCache.size > MAX_CATALOG_CACHE_ENTRIES) {
		const oldest = catalogCache.keys().next().value;
		if (oldest !== undefined) catalogCache.delete(oldest);
	}
	return analysis;
}

function scoreAnalysis(analysis: CatalogAnalysis, queryTokens: readonly string[]): number[] {
	const n = analysis.skills.length;
	const idf = (term: string): number => Math.log(1 + (n - (analysis.df.get(term) ?? 0) + 0.5) / ((analysis.df.get(term) ?? 0) + 0.5));
	const queryTerms = new Set(expandQueryTokens(queryTokens, analysis.aliases));
	const k1 = 1.2;
	const b = 0.75;
	return analysis.termFreqs.map((counts, i) => {
		let score = 0;
		for (const term of queryTerms) {
			const tf = counts.get(term) ?? 0;
			if (tf > 0) {
				const normalized = tf + k1 * (1 - b + b * (analysis.docLengths[i] / analysis.avgDocLength));
				score += idf(term) * ((tf * (k1 + 1)) / normalized);
			}
			if (analysis.nameTokenSets[i].has(term)) score += 2 * idf(term);
			if (analysis.negativeHintTokenSets[i].has(term)) score -= idf(term);
		}
		return score;
	});
}

/**
 * BM25-style relevance of each skill to the query, with a name-match boost for
 * terms that match the skill *name* (a strong intent signal). Returns one score
 * per skill, in input order.
 */
export function scoreSkills(skills: readonly Skill[], queryTokens: readonly string[]): number[] {
	return scoreAnalysis(analyzeSkills(skills), queryTokens);
}

export interface SelectRelevantOptions {
	targetTopK: number;
	minTopK?: number;
	maxTopK?: number;
	adaptive?: boolean;
	closeScoreRatio?: number;
}

/** Indices of the top-K skills with a positive score, best first. */
export function selectRelevant(scores: readonly number[], options: number | SelectRelevantOptions): number[] {
	const opts: SelectRelevantOptions = typeof options === "number" ? { targetTopK: options, adaptive: false } : options;
	const ranked = scores
		.map((score, i) => ({ score, i }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
	if (ranked.length === 0) return [];
	if (!opts.adaptive) return ranked.slice(0, Math.max(0, opts.targetTopK)).map((x) => x.i);

	const maxTopK = Math.max(0, opts.maxTopK ?? opts.targetTopK);
	const minTopK = Math.min(maxTopK, Math.max(0, opts.minTopK ?? opts.targetTopK));
	let keep = Math.min(maxTopK, Math.max(minTopK, opts.targetTopK));
	const closeScoreRatio = opts.closeScoreRatio ?? 0.75;
	while (keep < Math.min(maxTopK, ranked.length) && ranked[keep].score >= ranked[keep - 1].score * closeScoreRatio) {
		keep += 1;
	}
	return ranked.slice(0, keep).map((x) => x.i);
}

/** Trim a description to its first sentence, capped at maxChars on a word boundary. */
export function compactDescription(description: string, maxChars: number): string {
	const trimmed = description.trim();
	const sentence = trimmed.match(/^([\s\S]*?[.!?])(\s|$)/);
	let result = sentence ? sentence[1] : trimmed;
	if (result.length > maxChars) {
		result = `${result.slice(0, maxChars).replace(/\s+\S*$/, "")}…`;
	}
	return result;
}

function renderSkill(skill: Skill, full: boolean, tailChars: number, keepLocations: boolean): string {
	const lines = [`  <skill>`, `    <name>${skill.name}</name>`];
	if (full) {
		lines.push(`    <description>${skill.description}</description>`);
	} else if (tailChars > 0) {
		lines.push(`    <description>${compactDescription(skill.description, tailChars)}</description>`);
	} // tailChars === 0 → name-only (the name itself declares intent)
	if ((full || keepLocations) && skill.location) lines.push(`    <location>${skill.location}</location>`);
	lines.push(`  </skill>`);
	return lines.join("\n");
}

/**
 * Rewrite the `<available_skills>` block inside `text` per the options. Returns
 * the original text (and `removed: 0`) when there is no catalog or no skills.
 * In `hybrid` mode the top-K query-relevant skills keep their full description
 * and the rest are compacted; every skill keeps its `<name>`, so nothing becomes
 * undiscoverable.
 */
export function transformSkillsInText(text: string, opts: SkillTransformOptions): SkillTransformResult {
	let changed = false;
	const selected: string[] = [];
	const profile = opts.profile ?? EMPTY_PROFILE;
	const pinnedNames = new Set(opts.pinnedSkills ?? []);
	const criticalNames = new Set(profile.critical);
	BLOCK_RE.lastIndex = 0;
	const next = text.replace(BLOCK_RE, (block, inner: string) => {
		const analysis = analyzeCatalog(inner, profile);
		const skills = analysis.skills;
		if (skills.length === 0) return block;

		let fullSet: Set<number>;
		let indices: number[] = [];
		let renderTailChars = opts.tailChars;
		if (opts.mode === "hybrid") {
			indices = selectRelevant(scoreAnalysis(analysis, tokenize(opts.query)), {
				targetTopK: opts.topK,
				minTopK: opts.minTopK,
				maxTopK: opts.maxTopK,
				adaptive: opts.adaptiveTopK,
			});
			fullSet = new Set(indices);
			if (indices.length === 0 && (opts.safeFallbackTailChars ?? 0) > renderTailChars) {
				renderTailChars = opts.safeFallbackTailChars ?? renderTailChars;
			}
			skills.forEach((skill, i) => {
				if (criticalNames.has(skill.name) || pinnedNames.has(skill.name)) {
					fullSet.add(i);
					if (!indices.includes(i)) indices.push(i);
				}
			});
		} else {
			fullSet = new Set(); // compact: none kept full
		}

		const entries = skills.map((skill, i) => renderSkill(skill, fullSet.has(i), renderTailChars, opts.keepLocations));
		const rebuilt = `<available_skills>\n${entries.join("\n")}\n</available_skills>`;
		if (rebuilt.length >= block.length) return block;
		selected.push(...indices.map((i) => skills[i].name));
		changed = true;
		return rebuilt;
	});
	if (!changed) return { text, removed: 0, selected: [] };
	return { text: next, removed: text.length - next.length, selected };
}

/**
 * Pull the query text from an Anthropic-style `messages` array: the first user
 * text (the session task) plus the latest user text (the current step). Tool
 * results and non-text blocks are skipped, so during a tool-use loop the query
 * stays the original task — which keeps the rewritten prompt stable within a turn.
 */
export function extractQuery(messages: unknown, maxChars = 2000): string {
	if (!Array.isArray(messages)) return "";
	const userTexts: string[] = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const m = message as { role?: unknown; content?: unknown };
		if (m.role !== "user") continue;
		if (typeof m.content === "string") {
			if (m.content.trim()) userTexts.push(m.content);
		} else if (Array.isArray(m.content)) {
			const text = m.content
				.filter((b): b is { type: "text"; text: string } => !!b && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
				.map((b) => b.text)
				.join(" ");
			if (text.trim()) userTexts.push(text);
		}
	}
	if (userTexts.length === 0) return "";
	const first = userTexts[0];
	const last = userTexts[userTexts.length - 1];
	if (first === last) return first.slice(0, maxChars);
	const separator = "\n";
	if (last.length + separator.length >= maxChars) return last.slice(-maxChars);
	const firstBudget = maxChars - last.length - separator.length;
	return `${first.slice(0, firstBudget)}${separator}${last}`;
}
