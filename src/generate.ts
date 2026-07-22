/**
 * Profile-generation helpers, extracted from the extension entry point so the
 * fragile bits (JSON extraction, response classification, and the batched
 * orchestration that keeps a large `init` from failing as one giant request)
 * are pure and unit-testable without the Pi runtime.
 */

import { EMPTY_PROFILE, mergeProfiles, normalizeProfile, type SkillOptimizerProfile, type SkillRef } from "./profile.ts";

/** Minimal shape of a model response we care about (subset of `AssistantMessage`). */
export interface ModelResponse {
	stopReason?: string;
	errorMessage?: string;
	content?: Array<{ type?: string; text?: string }>;
}

/** Concatenate the text blocks of a model response (ignores non-text content). */
export function responseText(response: ModelResponse): string {
	return (response.content ?? [])
		.filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

export function stripCodeFences(text: string): string {
	const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)```\s*$/i);
	if (fenced) return fenced[1];
	return text;
}

/** Parse the model's JSON profile, tolerating code fences, comments, and trailing commas. */
export function parseJsonObject(text: string): unknown {
	const source = stripCodeFences(text).trim();
	let started = false;
	let inString = false;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	let depth = 0;
	let cleaned = "";

	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];
		if (!started) {
			if (ch !== "{") continue;
			started = true;
			depth = 1;
			cleaned = "{";
			continue;
		}
		if (lineComment) {
			if (ch === "\n") {
				lineComment = false;
				cleaned += ch;
			}
			continue;
		}
		if (blockComment) {
			if (ch === "*" && next === "/") {
				blockComment = false;
				i++;
			} else if (ch === "\n") cleaned += ch;
			continue;
		}
		if (inString) {
			if (escaped) {
				cleaned += ch;
				escaped = false;
			} else if (ch === "\\") {
				cleaned += ch;
				escaped = true;
			} else if (ch === '"') {
				cleaned += ch;
				inString = false;
			} else if (ch === "\n") cleaned += "\\n";
			else if (ch === "\r") cleaned += "\\r";
			else if (ch === "\t") cleaned += "\\t";
			else cleaned += ch;
			continue;
		}
		if (ch === '"') {
			inString = true;
			cleaned += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			lineComment = true;
			i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			blockComment = true;
			i++;
			continue;
		}
		if (ch === "}" || ch === "]") {
			const whitespace = cleaned.match(/\s*$/)?.[0] ?? "";
			const prefix = cleaned.slice(0, cleaned.length - whitespace.length);
			if (prefix.endsWith(",")) cleaned = `${prefix.slice(0, -1)}${whitespace}`;
			depth--;
			cleaned += ch;
			if (depth === 0) return JSON.parse(cleaned);
			continue;
		}
		if (ch === "{" || ch === "[") depth++;
		cleaned += ch;
	}
	throw new Error("model response did not contain a JSON object");
}

/** Split `items` into consecutive groups of at most `size` (one group when `size <= 0`). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
	if (size <= 0) return [items.slice()];
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** Outcome of interpreting a single batch's model response. */
export type BatchResponseOutcome =
	| { status: "ok"; profile: SkillOptimizerProfile; processedSkills: string[] }
	| { status: "failed"; reason: string; retryable: boolean };

function readProcessedSkills(value: unknown): string[] | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const raw = record.processedSkills;
	if (!Array.isArray(raw)) return undefined;
	return [...new Set(raw
		.filter((name): name is string => typeof name === "string")
		.map((name) => name.trim())
		.filter(Boolean))];
}

/**
 * Classify truncated, errored, aborted, invalid, and explicitly uncovered batch
 * responses as failures. Successful responses must declare processed skill coverage.
 */
export function interpretBatchResponse(response: ModelResponse): BatchResponseOutcome {
	const stopReason = response.stopReason;
	if (stopReason === "length") {
		return { status: "failed", reason: "output was truncated (length limit)", retryable: true };
	}
	if (stopReason === "error" || stopReason === "aborted") {
		const detail = response.errorMessage;
		return {
			status: "failed",
			reason: `${stopReason}${detail ? `: ${detail}` : ""}`,
			retryable: stopReason === "error",
		};
	}
	let parsed: unknown;
	try {
		parsed = parseJsonObject(responseText(response));
	} catch (err) {
		return { status: "failed", reason: `produced no valid JSON (${(err as Error).message})`, retryable: true };
	}
	const processedSkills = readProcessedSkills(parsed);
	if (!processedSkills || processedSkills.length === 0) {
		return { status: "failed", reason: "omitted explicit processedSkills coverage", retryable: true };
	}
	return { status: "ok", profile: normalizeProfile(parsed), processedSkills };
}

/** Result of a batched profile generation: the merged partial plus which skills landed. */
export interface BatchGenerationResult {
	partial: SkillOptimizerProfile;
	/** Skill names covered by a batch that succeeded. */
	applied: Set<string>;
}

export interface GeneratedBatchProfile {
	profile: SkillOptimizerProfile;
	processedSkills: readonly string[];
}

/**
 * Run `runBatch` over `targetSkills` in groups of `batchSize`, merging the profiles
 * of the batches that succeed. `runBatch` returns the parsed+normalized profile for a
 * batch, or `undefined` if that batch failed (the caller is expected to have logged why).
 * Returns `undefined` only when *every* batch failed, so a single bad batch never loses
 * the whole run and the caller can persist a partial profile.
 */
export async function generateProfileInBatches(
	targetSkills: readonly SkillRef[],
	batchSize: number,
	runBatch: (batch: SkillRef[], index: number, total: number) => Promise<GeneratedBatchProfile | undefined>,
): Promise<BatchGenerationResult | undefined> {
	const batches = chunk(targetSkills, batchSize);
	const partials: SkillOptimizerProfile[] = [];
	const applied = new Set<string>();
	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		const generated = await runBatch(batch, i, batches.length);
		if (!generated) continue;
		const expected = new Set(batch.map((skill) => skill.name));
		const covered = new Set(generated.processedSkills);
		if (covered.size !== expected.size || [...covered].some((name) => !expected.has(name))) continue;
		partials.push(generated.profile);
		for (const name of expected) applied.add(name);
	}
	if (partials.length === 0) return undefined;
	const partial = partials.reduce((acc, p) => mergeProfiles(acc, p), EMPTY_PROFILE);
	return { partial, applied };
}
