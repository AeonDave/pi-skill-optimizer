import { replaceControlCharacters, stripTerminalSequences } from "@earendil-works/pi-tui";

export interface SearchCardItem {
	name: string;
	description: string;
	details: readonly string[];
}

export interface SearchCard {
	noun: "results" | "skills";
	total: number;
	items: readonly SearchCardItem[];
	metadata: readonly string[];
	footer: readonly string[];
	hasNextPage: boolean;
}

const MAX_PREVIEW_RESULTS = 3;
const MAX_PREVIEW_DESCRIPTION = 140;
const MAX_FALLBACK_PREVIEW_CHARS = 320;
const MAX_FALLBACK_PREVIEW_LINES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract text blocks from Pi's result without changing its model-facing content. */
export function readTextContent(result: unknown): string {
	if (!isRecord(result) || !Array.isArray(result.content)) return "";
	return result.content
		.filter((item): item is { type: "text"; text: string } => isRecord(item) && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function sanitizeMultiline(value: string): string {
	return stripTerminalSequences(value)
		.split(/\r\n?|\n/)
		.map((line) => replaceControlCharacters(line))
		.join("\n");
}

/** Normalize untrusted display values without changing the source tool result. */
export function cleanText(value: string): string {
	return sanitizeMultiline(value).replace(/\s+/g, " ").trim();
}

export function clip(value: string, maxChars: number): string {
	const clean = cleanText(value);
	return clean.length > maxChars ? `${clean.slice(0, maxChars - 1).trimEnd()}…` : clean;
}

function sanitizeCardLine(value: string): string {
	return replaceControlCharacters(stripTerminalSequences(value)).replace(/\r?\n/g, " ");
}

/** Format typed projections through one bounded compact view and one complete expanded view. */
export function formatSearchCard(card: SearchCard, expanded: boolean, expansionHint: string): string[] {
	const shown = expanded ? card.items : card.items.slice(0, MAX_PREVIEW_RESULTS);
	const lines = [`${shown.length} of ${card.total} ${card.noun}`];
	if (expanded) lines.push(...card.metadata);
	for (const item of shown) {
		if (!expanded) {
			lines.push(clip(`${item.name}: ${item.description || "No description"}`, MAX_PREVIEW_DESCRIPTION));
			continue;
		}
		lines.push(`${cleanText(item.name)}`, `  ${cleanText(item.description) || "No description"}`, ...item.details.map((detail) => `  ${detail}`));
	}
	if (expanded) {
		lines.push(...card.footer);
	} else {
		const moreCount = Math.max(0, card.total - shown.length);
		const more = moreCount > 0 ? `${moreCount} more ${card.noun}; ` : "";
		const nextPage = card.hasNextPage ? "More results available; " : "";
		lines.push(`… (${more}${nextPage}${cleanText(expansionHint)})`);
	}
	return lines.map(sanitizeCardLine);
}

/** Bounded preview, with the entire sanitized source available when Pi expands the row. */
export function formatFallback(output: string, isError: boolean, expanded: boolean, expansionHint: string): string[] {
	const safeOutput = sanitizeMultiline(output);
	const title = isError ? "tool error output" : "tool output";
	if (expanded) return [title, ...(safeOutput ? safeOutput.split("\n") : ["No text output was returned."])];
	if (!safeOutput) return [title, "No text output was returned."];
	let remainingChars = MAX_FALLBACK_PREVIEW_CHARS;
	const sourceLines = safeOutput.split("\n");
	const previewLines: string[] = [];
	let clippedLine = false;
	for (const sourceLine of sourceLines.slice(0, MAX_FALLBACK_PREVIEW_LINES)) {
		const line = sourceLine.replace(/\s+/g, " ").trim();
		if (line.length > remainingChars) {
			previewLines.push(`${line.slice(0, Math.max(0, remainingChars - 1)).trimEnd()}…`);
			clippedLine = true;
			break;
		}
		previewLines.push(line);
		remainingChars -= line.length;
	}
	const hidden = clippedLine || sourceLines.length > previewLines.length;
	return [title, ...previewLines, ...(hidden ? [`… (more output; ${cleanText(expansionHint)})`] : [])];
}
