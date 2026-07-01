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
	let cleaned = stripCodeFences(text).trim();
	// collapse multi-line strings into single lines (newlines are not valid JSON string chars)
	cleaned = cleaned.replace(/"((?:[^"\\]|\\.)*)"/g, (m) =>
		m.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t"),
	);
	// strip // line comments
	cleaned = cleaned.replace(/\/\/.*$/gm, "");
	// strip /* */ block comments
	cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");
	// remove trailing commas before } or ]
	cleaned = cleaned.replace(/,(\s*[}\]])/g, "$1");
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("model response did not contain a JSON object");
	return JSON.parse(cleaned.slice(start, end + 1));
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
	| { status: "ok"; profile: SkillOptimizerProfile; truncated: boolean }
	| { status: "failed"; reason: string };

/**
 * Classify a batch response: an `error`/`aborted` stop, or a body with no parseable
 * JSON object, is a `failed` outcome (with a human-readable reason). A `length`
 * (truncated) stop still parses what came back and is flagged `truncated`.
 */
export function interpretBatchResponse(response: ModelResponse): BatchResponseOutcome {
	const stopReason = response.stopReason;
	if (stopReason === "error" || stopReason === "aborted") {
		const detail = response.errorMessage;
		return { status: "failed", reason: `${stopReason}${detail ? `: ${detail}` : ""}` };
	}
	let parsed: unknown;
	try {
		parsed = parseJsonObject(responseText(response));
	} catch (err) {
		return { status: "failed", reason: `produced no valid JSON (${(err as Error).message})` };
	}
	return { status: "ok", profile: normalizeProfile(parsed), truncated: stopReason === "length" };
}

/** Result of a batched profile generation: the merged partial plus which skills landed. */
export interface BatchGenerationResult {
	partial: SkillOptimizerProfile;
	/** Skill names covered by a batch that succeeded. */
	applied: Set<string>;
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
	runBatch: (batch: SkillRef[], index: number, total: number) => Promise<SkillOptimizerProfile | undefined>,
): Promise<BatchGenerationResult | undefined> {
	const batches = chunk(targetSkills, batchSize);
	const partials: SkillOptimizerProfile[] = [];
	const applied = new Set<string>();
	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		const profile = await runBatch(batch, i, batches.length);
		if (!profile) continue;
		partials.push(profile);
		for (const skill of batch) applied.add(skill.name);
	}
	if (partials.length === 0) return undefined;
	const partial = partials.reduce((acc, p) => mergeProfiles(acc, p), EMPTY_PROFILE);
	return { partial, applied };
}
