import type { CatalogBrowseItem, CatalogBrowseResult, CatalogFacet } from "../catalog.ts";
import type { RankReason, SkillSearchItem, SkillSearchResult } from "../skills.ts";
import type { ToolSearchConfidence, ToolSearchField, ToolSearchMatch, ToolSearchPage } from "../tools.ts";
import { cleanText, formatFallback, formatSearchCard, readTextContent } from "./search-card.ts";

type ToolSearchPageView = ToolSearchPage & { activated: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isToolSearchField(value: string): value is ToolSearchField {
	return ["name", "description", "schemaName", "schemaText"].includes(value);
}

function parseToolSearchMatch(value: unknown): ToolSearchMatch | undefined {
	if (!isRecord(value)
		|| typeof value.name !== "string"
		|| typeof value.description !== "string"
		|| !isFiniteNumber(value.score)
		|| !isStringArray(value.matchedTerms)
		|| !isStringArray(value.matchedFields)
		|| !value.matchedFields.every(isToolSearchField)) {
		return undefined;
	}
	return {
		name: value.name,
		description: value.description,
		score: value.score,
		matchedTerms: value.matchedTerms,
		matchedFields: value.matchedFields,
	};
}

function isToolSearchConfidence(value: unknown): value is ToolSearchConfidence {
	return value === "none" || value === "low" || value === "high";
}

function parseToolSearchPage(value: unknown): ToolSearchPageView | undefined {
	if (!isRecord(value)
		|| !Array.isArray(value.results)
		|| !isCount(value.total)
		|| !isToolSearchConfidence(value.confidence)
		|| typeof value.failOpen !== "boolean"
		|| !isStringArray(value.activated)
		|| (value.nextCursor !== undefined && typeof value.nextCursor !== "string")) {
		return undefined;
	}
	const results = value.results.map(parseToolSearchMatch);
	if (results.some((item) => item === undefined)) return undefined;
	return {
		results: results as ToolSearchMatch[],
		total: value.total,
		...(typeof value.nextCursor === "string" ? { nextCursor: value.nextCursor } : {}),
		confidence: value.confidence,
		failOpen: value.failOpen,
		activated: value.activated,
	};
}

const RANK_REASONS: readonly RankReason[] = ["exact", "lexical", "fuzzy", "profile", "usage", "contextual"];

function isRankReason(value: string): value is RankReason {
	return RANK_REASONS.includes(value as RankReason);
}

function parseSkillSearchItem(value: unknown): SkillSearchItem | undefined {
	if (!isRecord(value)
		|| typeof value.name !== "string"
		|| typeof value.intent !== "string"
		|| !isFiniteNumber(value.score)
		|| !isFiniteNumber(value.confidence)
		|| !isStringArray(value.reasons)
		|| !value.reasons.every(isRankReason)) {
		return undefined;
	}
	return {
		name: value.name,
		intent: value.intent,
		score: value.score,
		confidence: value.confidence,
		reasons: value.reasons,
	};
}

function parseRankedSkillPage(value: unknown): SkillSearchResult | undefined {
	if (!isRecord(value)
		|| typeof value.query !== "string"
		|| typeof value.fingerprint !== "string"
		|| !isFiniteNumber(value.confidence)
		|| !isCount(value.total)
		|| !Array.isArray(value.items)
		|| (value.nextCursor !== undefined && typeof value.nextCursor !== "string")) {
		return undefined;
	}
	const items = value.items.map(parseSkillSearchItem);
	if (items.some((item) => item === undefined)) return undefined;
	return {
		query: value.query,
		fingerprint: value.fingerprint,
		confidence: value.confidence,
		total: value.total,
		items: items as SkillSearchItem[],
		...(typeof value.nextCursor === "string" ? { nextCursor: value.nextCursor } : {}),
	};
}

function parseCatalogItem(value: unknown): CatalogBrowseItem | undefined {
	if (!isRecord(value)
		|| typeof value.name !== "string"
		|| typeof value.summary !== "string"
		|| !isStringArray(value.tags)
		|| (value.rescue !== undefined && value.rescue !== true)) {
		return undefined;
	}
	return {
		name: value.name,
		summary: value.summary,
		tags: value.tags,
		...(value.rescue === true ? { rescue: true } : {}),
	};
}

function parseCatalogFacet(value: unknown): CatalogFacet | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || !isCount(value.count)) return undefined;
	return { id: value.id, count: value.count };
}

function parseCatalogBrowsePage(value: unknown): CatalogBrowseResult | undefined {
	if (!isRecord(value)
		|| !isCount(value.total)
		|| !Array.isArray(value.items)
		|| !isCount(value.usedChars)
		|| (value.nextCursor !== undefined && typeof value.nextCursor !== "string")
		|| (value.rest !== undefined && !isStringArray(value.rest))
		|| (value.facets !== undefined && !Array.isArray(value.facets))) {
		return undefined;
	}
	const items = value.items.map(parseCatalogItem);
	if (items.some((item) => item === undefined)) return undefined;
	const facets = value.facets?.map(parseCatalogFacet);
	if (facets?.some((item) => item === undefined)) return undefined;
	return {
		total: value.total,
		items: items as CatalogBrowseItem[],
		...(facets ? { facets: facets as CatalogFacet[] } : {}),
		...(isStringArray(value.rest) ? { rest: value.rest } : {}),
		...(typeof value.nextCursor === "string" ? { nextCursor: value.nextCursor } : {}),
		usedChars: value.usedChars,
	};
}

function parseSkillSearchPage(value: unknown): SkillSearchResult | CatalogBrowseResult | undefined {
	if (!isRecord(value)) return undefined;
	// These explicit discriminators preserve the two real search wire contracts, including empty pages.
	if (typeof value.query === "string" && typeof value.fingerprint === "string") return parseRankedSkillPage(value);
	if ("usedChars" in value) return parseCatalogBrowsePage(value);
	return undefined;
}

/** Formats the optimizer_tool_search response without changing its model-facing payload. */
export function formatOptimizerToolSearchResult(result: unknown, expanded: boolean, expansionHint: string, isError = false): string[] {
	const output = readTextContent(result);
	let page: ToolSearchPageView | undefined;
	if (!isError) {
		try {
			page = parseToolSearchPage(JSON.parse(output) as unknown);
		} catch {
			// Preserve unexpected host/plugin output as text below instead of breaking tool rendering.
		}
	}
	if (!page) return formatFallback(output, isError, expanded, expansionHint);
	return formatSearchCard({
		noun: "results",
		total: page.total,
		items: page.results.map((item) => ({
			name: item.name,
			description: item.description,
			details: [
				`Score: ${item.score}`,
				`Matched terms: ${item.matchedTerms.length > 0 ? item.matchedTerms.map(cleanText).join(", ") : "none"}`,
				`Matched fields: ${item.matchedFields.length > 0 ? item.matchedFields.join(", ") : "none"}`,
			],
		})),
		metadata: [
			`Confidence: ${page.confidence}`,
			`Fail-open: ${page.failOpen ? "yes (fallback tools included)" : "no"}`,
		],
		footer: [
			`Activated: ${page.activated.length > 0 ? page.activated.map(cleanText).join(", ") : "none"}`,
			`Next cursor: ${page.nextCursor === undefined ? "none" : cleanText(page.nextCursor)}`,
		],
		hasNextPage: page.nextCursor !== undefined,
	}, expanded, expansionHint);
}

function formatRankedSkillCard(page: SkillSearchResult, expanded: boolean, expansionHint: string): string[] {
	return formatSearchCard({
		noun: "skills",
		total: page.total,
		items: page.items.map((item) => ({
			name: item.name,
			description: item.intent,
			details: [
				`Score: ${item.score}`,
				`Confidence: ${item.confidence}`,
				`Reasons: ${item.reasons.length > 0 ? item.reasons.join(", ") : "none"}`,
			],
		})),
		metadata: [`Search confidence: ${page.confidence}`],
		footer: [
			`Fingerprint: ${cleanText(page.fingerprint)}`,
			`Next cursor: ${page.nextCursor === undefined ? "none" : cleanText(page.nextCursor)}`,
		],
		hasNextPage: page.nextCursor !== undefined,
	}, expanded, expansionHint);
}

function formatCatalogSkillCard(page: CatalogBrowseResult, expanded: boolean, expansionHint: string): string[] {
	return formatSearchCard({
		noun: "skills",
		total: page.total,
		items: page.items.map((item) => ({
			name: item.name,
			description: item.summary,
			details: [
				`Tags: ${item.tags.map(cleanText).join(", ") || "none"}`,
				...(item.rescue === true ? ["Rescue match"] : []),
			],
		})),
		metadata: [`Used chars: ${page.usedChars}`],
		footer: [
			`Facets: ${page.facets === undefined ? "not included on this page" : page.facets.length > 0 ? page.facets.map(({ id, count }) => `${cleanText(id)} (${count})`).join(", ") : "none"}`,
			`Rest: ${page.rest === undefined ? "not included on this page" : page.rest.length > 0 ? page.rest.map(cleanText).join(", ") : "none"}`,
			`Next cursor: ${page.nextCursor === undefined ? "none" : cleanText(page.nextCursor)}`,
		],
		hasNextPage: page.nextCursor !== undefined,
	}, expanded, expansionHint);
}

/** Projects only the two declared skill_search search contracts; load/resource output remains full text. */
export function formatSkillSearchResult(result: unknown, action: unknown, expanded: boolean, expansionHint: string, isError = false): string[] {
	const output = readTextContent(result);
	if (isError || action !== "search") return formatFallback(output, isError, expanded, expansionHint);
	try {
		const page = parseSkillSearchPage(JSON.parse(output) as unknown);
		if (page) return "query" in page
			? formatRankedSkillCard(page, expanded, expansionHint)
			: formatCatalogSkillCard(page, expanded, expansionHint);
	} catch {
		// Unrecognized search output stays visible as bounded text rather than a raw JSON wall.
	}
	return formatFallback(output, false, expanded, expansionHint);
}
