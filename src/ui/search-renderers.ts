import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clip, cleanText } from "./search-card.ts";
import { formatOptimizerToolSearchResult, formatSkillSearchResult } from "./search-projections.ts";

const TOOL_SEARCH_NAME = "optimizer_tool_search";
const SKILL_SEARCH_NAME = "skill_search";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getSkillCallTarget(args: unknown): { action: string; target: string } {
	const action = isRecord(args) && typeof args.action === "string" ? cleanText(args.action) : "search";
	if (action === "search") {
		const query = isRecord(args) && typeof args.query === "string" ? cleanText(args.query) : "";
		const tags = isRecord(args) && Array.isArray(args.tags)
			? args.tags.filter((tag): tag is string => typeof tag === "string").map(cleanText).filter(Boolean)
			: [];
		const match = isRecord(args) && (args.match === "any" || args.match === "all") ? ` (${args.match})` : "";
		const tagFilter = tags.length > 0 ? `tags ${tags.join(", ")}${match}` : "";
		return { action, target: [query, tagFilter].filter(Boolean).join(" · ") || "(browse all)" };
	}
	if (isRecord(args) && action === "resource") {
		const name = typeof args.name === "string" ? cleanText(args.name) : "(skill unavailable)";
		const path = typeof args.path === "string" ? cleanText(args.path) : "(path unavailable)";
		return { action, target: `${name}/${path}` };
	}
	const name = isRecord(args) && typeof args.name === "string" ? cleanText(args.name) : "(skill unavailable)";
	return { action, target: name };
}

/** Registers display-only projections for existing search tools. Execution and result content remain host-owned. */
export function registerSearchToolRenderers(pi: ExtensionAPI): void {
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (toolName !== TOOL_SEARCH_NAME && toolName !== SKILL_SEARCH_NAME) return base;
		const isOptimizerSearch = toolName === TOOL_SEARCH_NAME;
		return {
			...base,
			renderCall(args, theme, context) {
				if (isOptimizerSearch) {
					const rawQuery = isRecord(args) && typeof args.query === "string" ? cleanText(args.query) : "(query unavailable)";
					const query = context.expanded ? rawQuery : clip(rawQuery, 120);
					return new Text(`${theme.fg("toolTitle", "tool search")} ${query}`, 0, 0);
				}
				const call = getSkillCallTarget(args);
				const target = context.expanded ? cleanText(call.target) : clip(call.target, 120);
				return new Text(`${theme.fg("toolTitle", `skill ${call.action}`)} ${target}`, 0, 0);
			},
			renderResult(result, options, theme, context) {
				const expansionHint = context.keyHint("app.tools.expand", "to expand details");
				const skillAction = isRecord(context.args) ? context.args.action : undefined;
				const lines = isOptimizerSearch
					? formatOptimizerToolSearchResult(result, options.expanded, expansionHint, context.isError)
					: formatSkillSearchResult(result, skillAction, options.expanded, expansionHint, context.isError);
				return new Text(lines.map((line, index) => index === 0 ? theme.fg("toolTitle", line) : line).join("\n"), 0, 0);
			},
		};
	});
}
