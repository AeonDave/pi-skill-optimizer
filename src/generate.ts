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

export const DEFAULT_INIT_BATCH_MAX_SKILLS = 80;
export const DEFAULT_INIT_BATCH_MAX_UTF8_BYTES = 32 * 1_024;
export const DEFAULT_INIT_BATCH_MAX_ATTEMPTS = 2;

export interface SkillBatchLimits {
	maxSkills: number;
	maxUtf8Bytes: number;
	maxAttempts?: number;
}

interface NormalizedSkillBatchLimits {
	maxSkills: number;
	maxUtf8Bytes: number;
	maxAttempts: number;
}

function positiveInteger(value: number, fallback: number): number {
	return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

function normalizeBatchLimits(value: SkillBatchLimits): NormalizedSkillBatchLimits {
	return {
		maxSkills: positiveInteger(value.maxSkills, DEFAULT_INIT_BATCH_MAX_SKILLS),
		maxUtf8Bytes: positiveInteger(value.maxUtf8Bytes, DEFAULT_INIT_BATCH_MAX_UTF8_BYTES),
		maxAttempts: positiveInteger(value.maxAttempts ?? DEFAULT_INIT_BATCH_MAX_ATTEMPTS, DEFAULT_INIT_BATCH_MAX_ATTEMPTS),
	};
}

/** Exact UTF-8 weight of the complete skill line sent by init. */
export function skillBatchUtf8Bytes(skill: SkillRef): number {
	return Buffer.byteLength(`- ${skill.name}: ${skill.description}\n`, "utf8");
}

/**
 * Deterministically partition skills in input order by both count and UTF-8
 * weight. A single oversized skill is kept intact in its own batch.
 */
export function batchSkillsByWeight(
	items: readonly SkillRef[],
	limits: SkillBatchLimits,
): SkillRef[][] {
	const normalized = normalizeBatchLimits(limits);
	const batches: SkillRef[][] = [];
	let batch: SkillRef[] = [];
	let bytes = 0;
	for (const skill of items) {
		const weight = skillBatchUtf8Bytes(skill);
		if (batch.length > 0 && (batch.length >= normalized.maxSkills || bytes + weight > normalized.maxUtf8Bytes)) {
			batches.push(batch);
			batch = [];
			bytes = 0;
		}
		batch.push(skill);
		bytes += weight;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
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

/** Keep only fields in the current generated-profile contract. */
function generatedProfileFields(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	return {
		critical: record.critical,
		queries: record.queries,
		clusters: record.clusters,
		negativeHints: record.negativeHints,
	};
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
	if (stopReason !== "stop") {
		return {
			status: "failed",
			reason: `unexpected stop reason: ${stopReason ?? "missing"}`,
			retryable: false,
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
	return { status: "ok", profile: normalizeProfile(generatedProfileFields(parsed)), processedSkills };
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

export interface FailedBatchGeneration {
	status: "failed";
	reason: string;
	retryable: boolean;
}

export type BatchGenerationAttempt = GeneratedBatchProfile | FailedBatchGeneration;

/** Provider/network failures may be retried, but explicit cancellation is terminal. */
export function isRetryableBatchException(error: unknown): boolean {
	if (!(error instanceof Error)) return true;
	if (error.name === "AbortError") return false;
	return error.message.trim().toLowerCase() !== "request was aborted";
}

/** Progress from a batched generation so the caller can checkpoint and report. */
export type BatchGenerationEvent =
	| {
		type: "committed";
		index: number;
		total: number;
		batchNames: readonly string[];
		applied: ReadonlySet<string>;
		partial: SkillOptimizerProfile;
	}
	| {
		type: "rejected";
		index: number;
		total: number;
		attempt: number;
		reason: string;
		retryable: boolean;
	};

/**
 * Run `runBatch` over deterministic count- and UTF-8-bounded groups, merging the profiles
 * of the batches that succeed. `runBatch` returns the parsed+normalized profile for a
 * batch, or `undefined` if that batch failed (the caller is expected to have logged why).
 * Returns `undefined` only when *every* batch failed, so a single bad batch never loses
 * the whole run and the caller can persist a partial profile.
 *
 * `onEvent` fires after each successful batch (`committed`) so the caller can checkpoint
 * immediately, and when a parsed response fails coverage (`rejected`) before retry.
 */
export async function generateProfileInBatches(
	targetSkills: readonly SkillRef[],
	limits: SkillBatchLimits,
	runBatch: (batch: SkillRef[], index: number, total: number, attempt: number) => Promise<BatchGenerationAttempt | undefined>,
	onEvent?: (event: BatchGenerationEvent) => Promise<void> | void,
): Promise<BatchGenerationResult | undefined> {
	const normalizedLimits = normalizeBatchLimits(limits);
	const batches = batchSkillsByWeight(targetSkills, normalizedLimits);
	let partial = EMPTY_PROFILE;
	const applied = new Set<string>();
	let committed = 0;
	for (let i = 0; i < batches.length; i++) {
		const batch = batches[i];
		const expected = new Set(batch.map((skill) => skill.name));
		for (let attempt = 1; attempt <= normalizedLimits.maxAttempts; attempt++) {
			const generated = await runBatch(batch, i, batches.length, attempt);
			if (!generated) continue;
			if ("status" in generated) {
				await onEvent?.({
					type: "rejected",
					index: i,
					total: batches.length,
					attempt,
					reason: generated.reason,
					retryable: generated.retryable,
				});
				if (!generated.retryable) break;
				continue;
			}
			const covered = new Set(generated.processedSkills);
			if (covered.size !== expected.size || [...covered].some((name) => !expected.has(name))) {
				await onEvent?.({
					type: "rejected",
					index: i,
					total: batches.length,
					attempt,
					reason: "incomplete coverage",
					retryable: true,
				});
				continue;
			}
			partial = mergeProfiles(partial, generated.profile);
			for (const name of expected) applied.add(name);
			committed += 1;
			await onEvent?.({
				type: "committed",
				index: i,
				total: batches.length,
				batchNames: batch.map((skill) => skill.name),
				applied: new Set(applied),
				partial,
			});
			break;
		}
	}
	if (committed === 0) return undefined;
	return { partial, applied };
}
