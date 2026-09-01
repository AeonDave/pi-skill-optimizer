/** Pure, view-only deduplication of repeated large tool-result text. */

import { createHash } from "node:crypto";
import { DEFAULT_OUTPUT_PATTERNS } from "./output.ts";

export interface HistoryToolResult {
	content: unknown;
	isError?: boolean;
	is_error?: boolean;
	[key: string]: unknown;
}

export interface HistoryArtifact {
	/** Opaque provider-safe content handle. */
	id: string;
	/** Exact original content, retained for local recovery. */
	content: unknown;
	/** Exact textual representation used for evidence checks. */
	text: string;
	bytes: number;
}

export interface HistoryDedupOptions {
	/** Results smaller than this remain untouched. */
	minBytes?: number;
	/** Additional evidence patterns that make a result ineligible. */
	protectedPatterns?: readonly RegExp[];
}

export interface HistoryDedupResult<T extends HistoryToolResult> {
	/** Original reference when no duplicate was replaced. */
	next: readonly T[];
	artifacts: readonly HistoryArtifact[];
	duplicates: number;
	/** Resolve only artifacts guaranteed to accompany this transformed view. */
	resolve: (id: string) => HistoryArtifact | undefined;
}

interface TextualContent {
	text: string;
	fingerprint: string;
	replace: (reference: string) => unknown;
}

export const DEFAULT_HISTORY_DEDUP_MIN_BYTES = 4_096;
const HISTORY_REF_PREFIX = "htr:";

function textContent(content: unknown): TextualContent | undefined {
	if (typeof content === "string") {
		return {
			text: content,
			fingerprint: `string\0${content}`,
			replace: (reference) => reference,
		};
	}
	if (!Array.isArray(content) || content.length === 0) return undefined;
	const blocks: Array<Record<string, unknown> & { type: string; text: string }> = [];
	for (const value of content) {
		if (!value || typeof value !== "object") return undefined;
		const block = value as Record<string, unknown>;
		if (block.type !== "text" || typeof block.text !== "string") return undefined;
		blocks.push(block as Record<string, unknown> & { type: string; text: string });
	}
	const texts = blocks.map((block) => block.text);
	return {
		text: texts.join("\n"),
		fingerprint: `blocks\0${JSON.stringify(texts)}`,
		replace: (reference) => [{ ...blocks[0], text: reference }],
	};
}

function matchesProtectedEvidence(text: string, patterns: readonly RegExp[]): boolean {
	const lines = text.split(/\r?\n/);
	for (const pattern of patterns) {
		for (const line of lines) {
			pattern.lastIndex = 0;
			if (pattern.test(line)) {
				pattern.lastIndex = 0;
				return true;
			}
		}
		pattern.lastIndex = 0;
	}
	return false;
}

function artifactId(fingerprint: string): string {
	return `${HISTORY_REF_PREFIX}${createHash("sha256").update(fingerprint).digest("base64url")}`;
}

function referenceText(id: string): string {
	return `[duplicate tool result; same-as=${id}]`;
}

/**
 * Replace only later exact duplicates in the returned view. The first content
 * remains verbatim. Errors, protected evidence, mixed/image content, and small
 * results are never candidates. Every replacement has an in-memory recovery
 * artifact and resolver in the returned value.
 */
export function deduplicateToolResultHistory<T extends HistoryToolResult>(
	results: readonly T[],
	options: HistoryDedupOptions = {},
): HistoryDedupResult<T> {
	const minBytes = typeof options.minBytes === "number" && Number.isFinite(options.minBytes) && options.minBytes >= 0
		? Math.floor(options.minBytes)
		: DEFAULT_HISTORY_DEDUP_MIN_BYTES;
	const patterns = [...DEFAULT_OUTPUT_PATTERNS, ...(options.protectedPatterns ?? [])];
	const firstById = new Map<string, HistoryArtifact>();
	const usedArtifacts = new Map<string, HistoryArtifact>();
	let next: T[] | undefined;
	let duplicates = 0;

	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		if (result.isError === true || result.is_error === true) continue;
		const extracted = textContent(result.content);
		if (!extracted) continue;
		const bytes = Buffer.byteLength(extracted.text, "utf8");
		if (bytes < minBytes || matchesProtectedEvidence(extracted.text, patterns)) continue;
		const id = artifactId(extracted.fingerprint);
		const first = firstById.get(id);
		if (!first) {
			firstById.set(id, { id, content: result.content, text: extracted.text, bytes });
			continue;
		}

		if (!next) next = results.slice() as T[];
		next[index] = { ...result, content: extracted.replace(referenceText(id)) };
		usedArtifacts.set(id, first);
		duplicates += 1;
	}

	const artifacts = [...usedArtifacts.values()];
	const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
	return {
		next: next ?? results,
		artifacts,
		duplicates,
		resolve: (id) => artifactsById.get(id),
	};
}
