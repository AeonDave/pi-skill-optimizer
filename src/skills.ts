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

import { buildCatalogAliases, expandQueryTokens, getUserAliasRevision, type QueryAliasMap } from "./aliases.ts";
import { EMPTY_PROFILE, type SkillOptimizerProfile } from "./profile.ts";

export interface Skill {
	name: string;
	description: string;
	location: string;
}

/** What to do with the `<available_skills>` catalog. */
export type SkillMode = "off" | "compact" | "hybrid";

/** How non-selected (tail) skills are rendered in `hybrid` mode. */
export type TailStyle = "name" | "intent";

export interface SkillTransformOptions {
	/** Only `compact` and `hybrid` are handled here; `off` is handled by the caller. */
	mode: "compact" | "hybrid";
	/** hybrid: how many relevant skills keep their full description + explicit location. */
	topK: number;
	/** hybrid tail style: `name` (cheapest) or `intent` (name + short description). */
	tail: TailStyle;
	/** The request's query text, used to rank skills in `hybrid` mode. */
	query: string;
	/** User-specific init profile: aliases, synthetic queries, critical skills. */
	profile?: SkillOptimizerProfile;
	/** Usage-derived skills that should stay fully described. */
	pinnedSkills?: readonly string[];
	/** User allowlist: always render these skills full (name + description + location). */
	alwaysFull?: readonly string[];
	/** User denylist: drop these skills from the catalog entirely (exact name or `prefix*`). */
	never?: readonly string[];
	/**
	 * Soft cap for full renders selected by ordinary relevance. Critical, pinned,
	 * always-full, and adaptive ambiguity selections may exceed it. Defaults to a
	 * conservative ceiling that only affects pathological descriptions. Set to 0
	 * to disable the cap.
	 */
	fullRenderBudgetChars?: number;
}

export interface SkillTransformResult {
	text: string;
	removedChars: number;
	/** Names kept at full description (hybrid), for diagnostics. */
	selected: string[];
}

const BLOCK_RE = /<available_skills>([\s\S]*?)<\/available_skills>/g;
const SKILL_RE =
	/<skill>\s*<name>([\s\S]*?)<\/name>\s*(?:<description>([\s\S]*?)<\/description>\s*)?(?:<location>([\s\S]*?)<\/location>\s*)?<\/skill>/g;
const MAX_CATALOG_CACHE_ENTRIES = 16;
const TRANSFORMED_CATALOG_MARKER = "<!--skill-optimizer-->";

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
	fuzzyLabelSets: Array<ReadonlyArray<ReadonlySet<string>>>;
	negativeHintTokenSets: Array<ReadonlySet<string>>;
	termFreqs: Array<ReadonlyMap<string, number>>;
	docLengths: number[];
	avgDocLength: number;
	df: ReadonlyMap<string, number>;
	aliases: QueryAliasMap;
}

interface CatalogCacheEntry {
	key: string;
	analysis: CatalogAnalysis;
}

// The analysis necessarily owns parsed catalog text. Cache only a compact
// fingerprint beside it instead of retaining a second copy of the raw catalog.
const catalogCache: CatalogCacheEntry[] = [];
let catalogCacheAliasRevision = -1;

const FUZZY_SIMILARITY_THRESHOLD = 0.8;
const MIN_FUZZY_LABEL_CHARS = 5;
const MAX_FUZZY_LABEL_CHARS = 80;
const MAX_FUZZY_QUERY_TOKENS = 32;
const MAX_FUZZY_QUERY_WINDOW = 5;

/** Default only constrains unusually large full descriptions. */
export const DEFAULT_FULL_RENDER_BUDGET_CHARS = 12_000;

/** Lowercase, remove entity escapes, split on non-alphanumerics, keep letter-bearing tokens len >= 2. */
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
			description: (match[2] ?? "").trim(),
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

/** Compact dual-hash fingerprint for bounded cache lookup keys. */
function fingerprint(text: string): string {
	let fnv = 0x811c9dc5;
	let mixed = 0x9e3779b9;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		fnv = Math.imul(fnv ^ code, 0x01000193);
		mixed = Math.imul(mixed ^ code, 0x5bd1e995);
		mixed ^= mixed >>> 13;
	}
	return `${text.length.toString(36)}:${(fnv >>> 0).toString(36)}:${(mixed >>> 0).toString(36)}`;
}

function tokenCounts(tokens: readonly string[]): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

function fuzzyTrigrams(value: string): ReadonlySet<string> | null {
	const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, MAX_FUZZY_LABEL_CHARS);
	if (normalized.length < MIN_FUZZY_LABEL_CHARS) return null;
	const grams = new Set<string>();
	for (let i = 0; i <= normalized.length - 3; i++) grams.add(normalized.slice(i, i + 3));
	return grams;
}

function trigramSimilarity(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
	let intersection = 0;
	const [small, large] = left.size <= right.size ? [left, right] : [right, left];
	for (const gram of small) if (large.has(gram)) intersection += 1;
	return (2 * intersection) / (left.size + right.size);
}

function buildQueryFuzzySets(queryTokens: readonly string[]): ReadonlySet<string>[] {
	const tokens = queryTokens.slice(0, MAX_FUZZY_QUERY_TOKENS);
	const labels = new Set<string>();
	for (let start = 0; start < tokens.length; start++) {
		let joined = "";
		for (let width = 1; width <= MAX_FUZZY_QUERY_WINDOW && start + width <= tokens.length; width++) {
			joined += tokens[start + width - 1];
			if (joined.length >= MIN_FUZZY_LABEL_CHARS) labels.add(joined);
		}
	}
	const sets: ReadonlySet<string>[] = [];
	for (const label of labels) {
		const grams = fuzzyTrigrams(label);
		if (grams) sets.push(grams);
	}
	return sets;
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
	const fuzzyLabelSets = skills.map((skill, i) => {
		const labels = new Set<string>([skill.name]);
		for (const [source, targets] of aliases) {
			if (targets.some((target) => skillTokenSets[i].has(target))) labels.add(source);
		}
		const sets: ReadonlySet<string>[] = [];
		for (const label of labels) {
			const grams = fuzzyTrigrams(label);
			if (grams) sets.push(grams);
		}
		return sets;
	});
	return { skills: [...skills], skillTokenSets, nameTokenSets, fuzzyLabelSets, negativeHintTokenSets, termFreqs, docLengths, avgDocLength, df, aliases };
}

function analyzeCatalog(inner: string, profile: SkillOptimizerProfile): CatalogAnalysis {
	const aliasRevision = getUserAliasRevision();
	if (aliasRevision !== catalogCacheAliasRevision) {
		catalogCache.length = 0;
		catalogCacheAliasRevision = aliasRevision;
	}
	const key = `${fingerprint(inner)}:${fingerprint(profileSignature(profile))}`;
	const cachedIndex = catalogCache.findIndex((entry) => entry.key === key);
	if (cachedIndex >= 0) {
		const cached = catalogCache[cachedIndex]!;
		catalogCache.splice(cachedIndex, 1);
		catalogCache.push(cached);
		return cached.analysis;
	}
	const analysis = analyzeSkills(parseSkills(inner), profile);
	catalogCache.push({ key, analysis });
	if (catalogCache.length > MAX_CATALOG_CACHE_ENTRIES) catalogCache.shift();
	return analysis;
}

function scoreAnalysis(analysis: CatalogAnalysis, queryTokens: readonly string[]): number[] {
	const n = analysis.skills.length;
	const idf = (term: string): number => Math.log(1 + (n - (analysis.df.get(term) ?? 0) + 0.5) / ((analysis.df.get(term) ?? 0) + 0.5));
	const queryTerms = new Set(expandQueryTokens(queryTokens, analysis.aliases));
	const k1 = 1.2;
	const b = 0.75;
	const lexicalScores = analysis.termFreqs.map((counts, i) => {
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

	// Exact lexical routing remains authoritative when it covers the query. The
	// fuzzy path is deliberately limited to weak lexical cases, names, and alias
	// sources so descriptions cannot create broad semantic false positives.
	const maxLexical = Math.max(0, ...lexicalScores);
	const matchedTerms = Array.from(queryTerms).filter((term) => analysis.df.has(term)).length;
	const lexicalCoverage = queryTerms.size === 0 ? 0 : matchedTerms / queryTerms.size;
	if (maxLexical > 0 && lexicalCoverage >= 2 / 3) return lexicalScores;

	const queryFuzzySets = buildQueryFuzzySets(queryTokens);
	if (queryFuzzySets.length === 0) return lexicalScores;
	const fuzzyScores = analysis.fuzzyLabelSets.map((labels) => {
		let best = 0;
		for (const querySet of queryFuzzySets) {
			for (const labelSet of labels) best = Math.max(best, trigramSimilarity(querySet, labelSet));
		}
		return best >= FUZZY_SIMILARITY_THRESHOLD ? best : 0;
	});
	if (!fuzzyScores.some((score) => score > 0)) return lexicalScores;
	if (maxLexical === 0) {
		return fuzzyScores.map((score, i) => (lexicalScores[i] < 0 ? lexicalScores[i] : score));
	}

	// Blend two [0, 1] signals instead of adding incompatible BM25 and trigram
	// magnitudes. A high-confidence name match wins a weak generic lexical hit.
	return lexicalScores.map((score, i) => {
		if (score < 0) return score;
		const lexical = score / maxLexical;
		const fuzzy = fuzzyScores[i];
		return 0.35 * lexical + 0.65 * fuzzy;
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
		.sort((a, b) => b.score - a.score);
	if (ranked.length === 0) return [];
	if (!opts.adaptive) return ranked.slice(0, Math.max(0, opts.targetTopK)).map((x) => x.i);

	const maxTopK = Math.max(0, opts.maxTopK ?? opts.targetTopK);
	const minTopK = Math.min(maxTopK, Math.max(0, opts.minTopK ?? opts.targetTopK));
	let keep = Math.min(maxTopK, Math.max(minTopK, opts.targetTopK));
	if (keep === 0) return [];
	const closeScoreRatio = opts.closeScoreRatio ?? 0.75;
	while (keep < Math.min(maxTopK, ranked.length) && ranked[keep].score >= ranked[keep - 1].score * closeScoreRatio) {
		keep += 1;
	}
	return ranked.slice(0, keep).map((x) => x.i);
}

/** Routing-signal keywords: the "when to use this skill" clause is the strongest tail signal. */
const ROUTING_KEYWORDS = /\b(use (this )?(skill )?when|use when|use for|use to|trigger on|invoke when|activate (when|for)|use after|use before)\b/i;
const ROUTING_SENTENCE = /([^.!?\n]*\b(use (this )?(skill )?when|use when|use for|use to|trigger on|invoke when|activate (when|for)|use after|use before)\b[^.!?\n]*[.!?]?)/i;

/**
 * Trim a description to its first sentence (capped at maxChars on a word boundary),
 * then append the routing clause ("Use when …") if the first sentence lacks one —
 * the routing signal is what makes a tail skill discoverable. It never
 * paraphrases or replaces the first sentence; it only truncates to the budget.
 */
export function compactDescription(description: string, maxChars: number): string {
	const trimmed = description.trim();
	const budget = Math.max(0, Math.floor(maxChars));
	if (!trimmed || budget === 0) return "";
	const cap = (s: string, limit: number): string => {
		if (limit <= 0) return "";
		if (s.length <= limit) return s;
		if (limit === 1) return "…";
		const raw = s.slice(0, limit - 1);
		const boundary = raw.replace(/\s+\S*$/, "").trimEnd();
		return `${boundary || raw}…`.slice(0, limit);
	};
	const firstMatch = trimmed.match(/^([\s\S]*?[.!?])(\s|$)/);
	const first = firstMatch ? firstMatch[1] : trimmed;
	if (ROUTING_KEYWORDS.test(first)) return cap(first, budget);
	const routing = trimmed.match(ROUTING_SENTENCE)?.[1].trim();
	if (!routing || first.includes(routing)) return cap(first, budget);
	const combined = `${first} ${routing}`;
	if (combined.length <= budget) return combined;
	if (budget < 3) return cap(first, budget);

	// Keep both original clauses within one final budget; routing gets up to half
	// reserved, while unused first-clause space flows back to the routing clause.
	const reservedRouting = Math.min(routing.length, Math.max(1, Math.floor((budget - 1) / 2)));
	const firstPart = cap(first, budget - reservedRouting - 1);
	const separatorLength = firstPart ? 1 : 0;
	const routingPart = cap(routing, budget - firstPart.length - separatorLength);
	if (!firstPart) return routingPart;
	if (!routingPart) return firstPart;
	return `${firstPart} ${routingPart}`;
}

/** Tail descriptions cap (internal): a short intent line, not the full text. */
const INTENT_CHARS = 80;

/** True if `name` matches any pattern: exact, or `prefix*` wildcard. */
function nameMatches(name: string, patterns: readonly string[]): boolean {
	for (const pattern of patterns) {
		if (pattern.endsWith("*")) {
			if (name.startsWith(pattern.slice(0, -1))) return true;
		} else if (name === pattern) {
			return true;
		}
	}
	return false;
}

/** Root dir of a location iff it follows the `<root>/<name>/SKILL.md` convention, else null. */
function derivableRoot(location: string, name: string): string | null {
	const match = location.match(/^(.*)[\\/]([^\\/]+)[\\/]SKILL\.md$/i);
	if (!match || match[2] !== name) return null;
	return match[1];
}

function renderFull(skill: Skill): string {
	const lines = ["  <skill>", `    <name>${skill.name}</name>`];
	if (skill.description) lines.push(`    <description>${skill.description}</description>`);
	if (skill.location) lines.push(`    <location>${skill.location}</location>`);
	lines.push("  </skill>");
	return lines.join("\n");
}

/**
 * Render a tail skill. Drops the `<location>` when it is derivable from the
 * `<root>/<name>/SKILL.md` convention (the path note declares the roots), but
 * keeps an explicit `<location>` for irregular paths so the skill stays loadable.
 */
function renderTail(skill: Skill, tail: TailStyle): { text: string; droppedRoot: string | null } {
	const lines = ["  <skill>", `    <name>${skill.name}</name>`];
	if (tail === "intent" && skill.description) lines.push(`    <description>${compactDescription(skill.description, INTENT_CHARS)}</description>`);
	let droppedRoot: string | null = null;
	if (skill.location) {
		const root = derivableRoot(skill.location, skill.name);
		if (root) droppedRoot = root;
		else lines.push(`    <location>${skill.location}</location>`);
	}
	lines.push("  </skill>");
	return { text: lines.join("\n"), droppedRoot };
}

/** One-line note so the model can load a tail skill whose location was dropped. */
function pathNote(roots: readonly string[]): string {
	return `  <skill_path_note>Skills listed without a location field are stored at {root}/{name}/SKILL.md (roots: ${roots.join(" | ")}). Read that file to load one, or run /skill:name.</skill_path_note>`;
}

/**
 * Rewrite the `<available_skills>` block inside `text` per the options. Returns
 * the original text (and `removedChars: 0`) when there is no catalog or no skills.
 *
 * `hybrid` keeps the top-K query-relevant skills (plus critical/pinned/alwaysFull)
 * at full description + explicit location, and renders the rest as the `tail`
 * style with the location replaced by a single path note — so every surviving
 * skill stays loadable. `compact` renders every skill as a short intent tail.
 * Skills matched by `never` are dropped entirely.
 */
export function transformSkillsInText(text: string, opts: SkillTransformOptions): SkillTransformResult {
	let changed = false;
	const selected: string[] = [];
	const selectedSet = new Set<string>();
	const profile = opts.profile ?? EMPTY_PROFILE;
	const pinned = new Set(opts.pinnedSkills ?? []);
	const critical = new Set(profile.critical);
	const always = new Set(opts.alwaysFull ?? []);
	const never = opts.never ?? [];
	BLOCK_RE.lastIndex = 0;
	const next = text.replace(BLOCK_RE, (block, inner: string) => {
		if (block.includes(TRANSFORMED_CATALOG_MARKER)) return block;
		const analysis = analyzeCatalog(inner, profile);
		const skills = analysis.skills;
		if (skills.length === 0) return block;

		const excluded = skills.map((skill) => never.length > 0 && nameMatches(skill.name, never));
		const fullSet = new Set<number>();
		const orderedFull: number[] = [];
		const markFull = (i: number): void => {
			if (excluded[i] || fullSet.has(i)) return;
			fullSet.add(i);
			orderedFull.push(i);
		};
		let hasLexicalSignal = false;
		if (opts.mode === "hybrid") {
			const scores = scoreAnalysis(analysis, tokenize(opts.query));
			hasLexicalSignal = scores.some((score) => score > 0);
			const ranked = selectRelevant(scores, {
				targetTopK: opts.topK,
				minTopK: opts.topK,
				maxTopK: Math.ceil(opts.topK * 1.5),
				adaptive: true,
			});
			const budgetOption = opts.fullRenderBudgetChars;
			const fullBudget = budgetOption === 0 || budgetOption === Number.POSITIVE_INFINITY
					? Number.POSITIVE_INFINITY
					: typeof budgetOption === "number" && Number.isFinite(budgetOption) && budgetOption > 0
						? Math.floor(budgetOption)
						: DEFAULT_FULL_RENDER_BUDGET_CHARS;
			const ordinaryCount = Math.min(Math.max(0, Math.floor(opts.topK)), ranked.length);
			let spent = 0;
			for (let position = 0; position < ordinaryCount; position++) {
				const i = ranked[position];
				const skill = skills[i];
				if (critical.has(skill.name) || pinned.has(skill.name) || always.has(skill.name)) {
					markFull(i);
					continue;
				}
				const cost = renderFull(skill).length;
				if (spent + cost > fullBudget) break;
				markFull(i);
				spent += cost;
			}
			// Adaptive selections beyond topK are ambiguity guardrails. They are
			// intentionally outside the budget because pruning a close alternative
			// would trade routing quality for a nominal cap.
			for (let position = ordinaryCount; position < ranked.length; position++) markFull(ranked[position]);
		}
		skills.forEach((skill, i) => {
			if (critical.has(skill.name) || pinned.has(skill.name) || always.has(skill.name)) markFull(i);
		});

		const tailStyle: TailStyle = opts.mode === "compact" || !hasLexicalSignal ? "intent" : opts.tail;
		const usedRoots: string[] = [];
		const seenRoots = new Set<string>();
		const entries: string[] = [];
		skills.forEach((skill, i) => {
			if (excluded[i]) return;
			if (fullSet.has(i)) {
				entries.push(renderFull(skill));
				return;
			}
			const { text: entry, droppedRoot } = renderTail(skill, tailStyle);
			if (droppedRoot && !seenRoots.has(droppedRoot)) {
				seenRoots.add(droppedRoot);
				usedRoots.push(droppedRoot);
			}
			entries.push(entry);
		});

		const metadata = [`  ${TRANSFORMED_CATALOG_MARKER}`];
		if (usedRoots.length > 0) metadata.push(pathNote(usedRoots));
		const rebuilt = `<available_skills>\n${metadata.join("\n")}\n${entries.join("\n")}\n</available_skills>`;
		if (rebuilt.length >= block.length) return block;
		for (const i of orderedFull) {
			const name = skills[i].name;
			if (selectedSet.has(name)) continue;
			selectedSet.add(name);
			selected.push(name);
		}
		changed = true;
		return rebuilt;
	});
	if (!changed) return { text, removedChars: 0, selected: [] };
	return { text: next, removedChars: text.length - next.length, selected };
}

/**
 * Pull the query text from an Anthropic-style `messages` array: the first user
 * text (the session task) plus the latest user text (the current step). Tool
 * results and non-text blocks are skipped, so during a tool-use loop the query
 * stays the original task — which keeps the rewritten prompt stable within a turn.
 */
export function extractQuery(messages: unknown, maxChars = 2000): string {
	if (maxChars <= 0) return "";
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
