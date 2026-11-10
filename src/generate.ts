/**
 * Profile-generation helpers, extracted from the extension entry point so the
 * fragile bits (JSON extraction, response classification, and the batched
 * orchestration that keeps a large `init` from failing as one giant request)
 * are pure and unit-testable without the Pi runtime.
 */

import { EMPTY_PROFILE, mergeProfiles, normalizeProfile, type SkillOptimizerProfile, type SkillRef } from "./profile.ts";
import {
	CATALOG_TAGS,
	CATALOG_VERSION,
	catalogSourceHash,
	normalizeCatalogMetadata,
	type CatalogMetadata,
} from "./catalog.ts";

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

export const DEFAULT_INIT_BATCH_MAX_SKILLS = 20;
export const DEFAULT_INIT_BATCH_MAX_UTF8_BYTES = 32 * 1_024;
export const DEFAULT_INIT_BATCH_MAX_ATTEMPTS = 2;
export const DEFAULT_INIT_BATCH_MAX_RECOVERY_CALLS = 8;

export interface SkillBatchLimits {
	maxSkills: number;
	maxUtf8Bytes: number;
	maxAttempts?: number;
	/** Additional calls shared by all subdivisions of each original batch. */
	maxRecoveryCalls?: number;
}

interface NormalizedSkillBatchLimits {
	maxSkills: number;
	maxUtf8Bytes: number;
	maxAttempts: number;
	maxRecoveryCalls: number;
}

function positiveInteger(value: number, fallback: number): number {
	return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

function normalizeBatchLimits(value: SkillBatchLimits): NormalizedSkillBatchLimits {
	return {
		maxSkills: positiveInteger(value.maxSkills, DEFAULT_INIT_BATCH_MAX_SKILLS),
		maxUtf8Bytes: positiveInteger(value.maxUtf8Bytes, DEFAULT_INIT_BATCH_MAX_UTF8_BYTES),
		maxAttempts: positiveInteger(value.maxAttempts ?? DEFAULT_INIT_BATCH_MAX_ATTEMPTS, DEFAULT_INIT_BATCH_MAX_ATTEMPTS),
		maxRecoveryCalls: Number.isFinite(value.maxRecoveryCalls) && value.maxRecoveryCalls! >= 0
			? Math.floor(value.maxRecoveryCalls!) : DEFAULT_INIT_BATCH_MAX_RECOVERY_CALLS,
	};
}

/** Serialize the exact skill-input JSON sent for one init batch. */
export function serializeSkillBatch(skills: readonly SkillRef[], previousFailure?: string): string {
	return JSON.stringify({
		skills: skills.map(({ name, description }) => ({ name, description })),
		...(previousFailure ? { retryFeedback: previousFailure.slice(0, 600) } : {}),
	});
}

/** Exact UTF-8 weight of the skill-input JSON sent by init. */
export function skillBatchUtf8Bytes(skills: readonly SkillRef[]): number {
	return Buffer.byteLength(serializeSkillBatch(skills), "utf8");
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
	for (const skill of items) {
		if (batch.length > 0 && (
			batch.length >= normalized.maxSkills
			|| skillBatchUtf8Bytes([...batch, skill]) > normalized.maxUtf8Bytes
		)) {
			batches.push(batch);
			batch = [];
		}
		batch.push(skill);
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

/** Outcome of interpreting a single batch's model response. */
export type BatchResponseOutcome =
	| { status: "ok"; profile: SkillOptimizerProfile; processedSkills: string[] }
	| { status: "failed"; reason: string; retryable: boolean; splittable?: boolean };

const MAX_VALIDATION_REASON_CHARS = 600;
const VALIDATION_TAG_IDS = new Set(CATALOG_TAGS.map(({ id }) => id));

/** Diagnostics quote bounded names, never descriptions or complete model output. */
function diagnosticName(name: string): string {
	let clipped = "";
	let count = 0;
	for (const character of name) {
		if (count++ === 48) {
			clipped += "...";
			break;
		}
		clipped += character;
	}
	return JSON.stringify(clipped)
		.replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, (character) =>
			`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function boundedReason(reason: string): string {
	const escaped = (character: string): string => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
	const safe = reason
		.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, escaped)
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, escaped);
	if (safe.length <= MAX_VALIDATION_REASON_CHARS) return safe;
	let end = MAX_VALIDATION_REASON_CHARS - 3;
	if (/[\uD800-\uDBFF]/u.test(safe[end - 1] ?? "")) end -= 1;
	return `${safe.slice(0, end)}...`;
}

function diagnosticNames(names: readonly string[]): string {
	return `${names.length} (${diagnosticName(names[0]!)}${names.length > 1 ? ", ..." : ""})`;
}

function missingProcessedCoverage(value: unknown): string {
	const raw = (value as Record<string, unknown>).processedSkills;
	if (raw === undefined) return "processedSkills is missing; return every exact input name";
	if (!Array.isArray(raw)) return "processedSkills must be an array of exact input names";
	if (raw.length === 0) return "processedSkills is empty; return every exact input name";
	return "processedSkills contains no non-empty string names";
}

function coverageDiagnostic(value: unknown, expected: ReadonlySet<string>): string {
	const raw = (value as Record<string, unknown>).processedSkills;
	if (!Array.isArray(raw)) return missingProcessedCoverage(value);
	const names = raw.filter((name): name is string => typeof name === "string");
	const actual = new Set(names);
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
	}
	const missing = [...expected].filter((name) => !actual.has(name));
	const extra = [...actual].filter((name) => !expected.has(name));
	return [
		...(missing.length ? [`missing ${diagnosticNames(missing)}`] : []),
		...(extra.length ? [`extra ${diagnosticNames(extra)}`] : []),
		...(duplicates.size ? [`duplicate ${diagnosticNames([...duplicates])}`] : []),
		...(names.length !== raw.length ? [`non-string ${raw.length - names.length}`] : []),
	].join("; ") || "names must match every exact input name once";
}

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
function generatedProfileFields(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	return {
		critical: record.critical,
		queries: record.queries,
		clusters: record.clusters,
		negativeHints: record.negativeHints,
		activation: record.activation,
	};
}

function hasExactNameCoverage(names: readonly string[] | undefined, expected: ReadonlySet<string>): boolean {
	if (!Array.isArray(names)) return false;
	if (names.length !== expected.size) return false;
	const actual = new Set(names);
	return actual.size === expected.size && [...actual].every((name) => expected.has(name));
}

function hasExactRawProcessedCoverage(value: unknown, expected: ReadonlySet<string>): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const names = (value as Record<string, unknown>).processedSkills;
	return Array.isArray(names)
		&& names.every((name): name is string => typeof name === "string")
		&& hasExactNameCoverage(names, expected);
}

type CatalogBindingOutcome =
	| { status: "ok"; catalog: CatalogMetadata }
	| { status: "failed"; reason: string; splittable: boolean };

function rejectedCatalog(reason: string, splittable = true): CatalogBindingOutcome {
	return { status: "failed", reason, splittable };
}

/** Explain a rejected normalized card without duplicating its acceptance decision. */
function rejectedCardReason(name: string, card: Record<string, unknown>): string {
	const owner = `card ${diagnosticName(name)}`;
	if (typeof card.summary !== "string") return `${owner} summary must be a string`;
	if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(card.summary)) {
		return `${owner} summary contains malformed Unicode`;
	}
	const summary = card.summary.replace(/\s+/gu, " ").trim();
	if (!summary) return `${owner} summary is empty`;
	if (summary.length > 200) return `${owner} summary exceeds 200 characters (${summary.length})`;
	if (!Array.isArray(card.tags)) return `${owner} tags must be an array of 1-3 distinct canonical IDs`;
	if (card.tags.length < 1 || card.tags.length > 3) return `${owner} tags must contain 1-3 distinct canonical IDs`;
	if (!card.tags.every((tag): tag is string => typeof tag === "string")) return `${owner} tags must contain only string canonical IDs`;
	if (card.tags.some((tag) => !VALIDATION_TAG_IDS.has(tag))) {
		const unknown = card.tags.filter((tag) => !VALIDATION_TAG_IDS.has(tag)).join(", ");
		return `${owner} tags contain unknown IDs (${unknown}); use the fixed catalog vocabulary`;
	}
	if (new Set(card.tags).size !== card.tags.length) return `${owner} tags contain duplicate IDs`;
	return `${owner} violates the semantic catalog schema`;
}

function bindCatalogCards(value: unknown, skills: readonly SkillRef[]): CatalogBindingOutcome {
	if (!value || typeof value !== "object" || Array.isArray(value)) return rejectedCatalog("catalogCards must be an object keyed by exact input name");
	const cardRecord = value as Record<string, unknown>;
	const expected = new Map<string, SkillRef>();
	for (const skill of skills) {
		if (expected.has(skill.name)) return rejectedCatalog(`input contains duplicate skill name ${diagnosticName(skill.name)}`, false);
		expected.set(skill.name, skill);
	}
	const rawNames = Object.keys(cardRecord);
	const missing = [...expected.keys()].filter((name) => !Object.prototype.hasOwnProperty.call(cardRecord, name));
	const extra = rawNames.filter((name) => !expected.has(name));
	if (missing.length || extra.length) return rejectedCatalog([
		...(missing.length ? [`missing ${diagnosticNames(missing)}`] : []),
		...(extra.length ? [`extra ${diagnosticNames(extra)}`] : []),
	].join("; "));

	const boundCards: Record<string, unknown> = {};
	for (const [name, skill] of expected) {
		const raw = cardRecord[name];
		const owner = `card ${diagnosticName(name)}`;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return rejectedCatalog(`${owner} must be an object`);
		const card = raw as Record<string, unknown>;
		const missingFields = ["summary", "tags"].filter((field) => !Object.prototype.hasOwnProperty.call(card, field));
		if (missingFields.length) return rejectedCatalog(`${owner} missing fields: ${missingFields.join(", ")}`);
		const extraFields = Object.keys(card).filter((field) => field !== "summary" && field !== "tags");
		if (extraFields.length) return rejectedCatalog(`${owner} extra fields: ${diagnosticNames(extraFields)}; emit only summary and tags`);
		Object.defineProperty(boundCards, name, {
			value: {
				summary: card.summary,
				tags: card.tags,
				sourceHash: catalogSourceHash(name, skill.description),
			},
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	const metadata = normalizeCatalogMetadata({ version: CATALOG_VERSION, cards: boundCards });
	for (const name of expected.keys()) {
		if (metadata && Object.prototype.hasOwnProperty.call(metadata.cards, name)) continue;
		if (!name || name !== name.trim() || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(name)) {
			return rejectedCatalog(`input skill name ${diagnosticName(name)} is not a valid exact catalog name`, false);
		}
		return rejectedCatalog(rejectedCardReason(name, cardRecord[name] as Record<string, unknown>));
	}
	if (!metadata || Object.keys(metadata.cards).length !== expected.size || Object.keys(metadata.cards).some((name) => !expected.has(name))) {
		return rejectedCatalog("catalogCards must cover every exact input name once");
	}
	return { status: "ok", catalog: metadata };
}

function hasCompleteBoundCatalog(profile: SkillOptimizerProfile, skills: readonly SkillRef[]): boolean {
	if (!profile || typeof profile !== "object") return false;
	const metadata = normalizeCatalogMetadata(profile.catalog);
	if (!metadata || metadata.version !== CATALOG_VERSION || metadata.cards === undefined) return false;
	const expected = new Map<string, SkillRef>();
	for (const skill of skills) {
		if (expected.has(skill.name)) return false;
		expected.set(skill.name, skill);
	}
	const names = Object.keys(metadata.cards);
	if (names.length !== expected.size || names.some((name) => !expected.has(name))) return false;
	for (const [name, skill] of expected) {
		const card = Object.prototype.hasOwnProperty.call(metadata.cards, name) ? metadata.cards[name] : undefined;
		if (!card || card.sourceHash !== catalogSourceHash(name, skill.description)) return false;
	}
	return true;
}

/** Quota and billing exhaustion cannot recover within one init command. */
function isRetryableModelError(errorMessage: string | undefined): boolean {
	if (!errorMessage) return true;
	const detail = errorMessage.toLowerCase();
	return ![
		"weekly/monthly limit exhausted",
		"insufficient_quota",
		"insufficient quota",
		"quota exceeded",
		"billing hard limit",
		"credit balance is too low",
	].some((marker) => detail.includes(marker));
}

/**
 * Classify truncated, errored, aborted, invalid, and explicitly uncovered batch
 * responses as failures. Successful responses must declare processed skill coverage.
 */
export function interpretBatchResponse(response: ModelResponse, expectedSkills?: readonly SkillRef[]): BatchResponseOutcome {
	const stopReason = response.stopReason;
	if (stopReason === "length") {
		return { status: "failed", reason: "output was truncated (length limit)", retryable: true, splittable: true };
	}
	if (stopReason === "error" || stopReason === "aborted") {
		const detail = response.errorMessage;
		return {
			status: "failed",
			reason: boundedReason(`${stopReason}${detail ? `: ${detail}` : ""}`),
			retryable: stopReason === "error" && isRetryableModelError(detail),
		};
	}
	if (stopReason !== "stop") {
		return {
			status: "failed",
			reason: boundedReason(`unexpected stop reason: ${stopReason ?? "missing"}`),
			retryable: false,
		};
	}
	let parsed: unknown;
	try {
		parsed = parseJsonObject(responseText(response));
	} catch {
		return { status: "failed", reason: "produced no valid JSON; return one complete JSON object", retryable: true, splittable: true };
	}
	const processedSkills = readProcessedSkills(parsed);
	if (!processedSkills || processedSkills.length === 0) {
		return { status: "failed", reason: boundedReason(`omitted explicit processedSkills coverage: ${missingProcessedCoverage(parsed)}`), retryable: true, splittable: true };
	}
	let catalog: CatalogMetadata | undefined;
	if (expectedSkills) {
		const expectedNames = new Set(expectedSkills.map((skill) => skill.name));
		if (!hasExactRawProcessedCoverage(parsed, expectedNames)) {
			return { status: "failed", reason: boundedReason(`incomplete processedSkills coverage: ${coverageDiagnostic(parsed, expectedNames)}`), retryable: true, splittable: true };
		}
		const record = parsed as Record<string, unknown>;
		const binding = bindCatalogCards(record.catalogCards, expectedSkills);
		if (binding.status === "failed") {
			return { status: "failed", reason: boundedReason(`missing or invalid semantic catalog cards: ${binding.reason}`), retryable: true, ...(binding.splittable ? { splittable: true } : {}) };
		}
		catalog = binding.catalog;
	}
	return {
		status: "ok",
		profile: normalizeProfile({ ...generatedProfileFields(parsed), ...(catalog ? { catalog } : {}) }),
		processedSkills,
	};
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
	/** Only response-content failures benefit from smaller batches. */
	splittable?: boolean;
}

export type BatchGenerationAttempt = GeneratedBatchProfile | FailedBatchGeneration;

export interface BatchAttemptContext {
	/** Original batch ordinal plus stable subdivision suffixes, e.g. 1/5.2. */
	label: string;
	/** Host validation feedback only; never provider/network error details. */
	previousFailure?: string;
}

/** Provider/network failures may be retried, but explicit cancellation is terminal. */
export function isRetryableBatchException(error: unknown): boolean {
	if (!(error instanceof Error)) return true;
	if (error.name === "AbortError") return false;
	return error.message.trim().toLowerCase() !== "request was aborted"
		&& isRetryableModelError(error.message);
}

/** Progress from a batched generation so the caller can checkpoint and report. */
export type BatchGenerationEvent =
	| {
		type: "committed";
		index: number;
		total: number;
		label: string;
		batchNames: readonly string[];
		applied: ReadonlySet<string>;
		partial: SkillOptimizerProfile;
	}
	| {
		type: "rejected";
		index: number;
		total: number;
		label: string;
		attempt: number;
		reason: string;
		retryable: boolean;
		willRetry: boolean;
		willSplit: boolean;
	};

/**
 * Run `runBatch` over deterministic count- and UTF-8-bounded groups, merging the profiles
 * of the batches that succeed. `runBatch` returns the parsed+normalized profile for a
 * batch, or `undefined` if that batch failed (the caller is expected to have logged why).
 * Returns `undefined` only when *every* batch failed, so a single bad batch never loses
 * the whole run and the caller can persist a partial profile.
 *
 * Content failures receive feedback on retry, then split into smaller complete batches
 * within a per-original-batch call budget. Provider failures never trigger splitting.
 * Terminal failures stop the entire run. Every accepted child checkpoints immediately.
 */
export async function generateProfileInBatches(
	targetSkills: readonly SkillRef[],
	limits: SkillBatchLimits,
	runBatch: (batch: SkillRef[], index: number, total: number, attempt: number, context: BatchAttemptContext) => Promise<BatchGenerationAttempt | undefined>,
	onEvent?: (event: BatchGenerationEvent) => Promise<void> | void,
): Promise<BatchGenerationResult | undefined> {
	const normalizedLimits = normalizeBatchLimits(limits);
	const batches = batchSkillsByWeight(targetSkills, normalizedLimits);
	let partial = EMPTY_PROFILE;
	const applied = new Set<string>();
	let committed = 0;
	let stopped = false;
	const run = async (batch: SkillRef[], index: number, label: string, callBudget: number, previousFailure?: string): Promise<void> => {
		const expected = new Set(batch.map((skill) => skill.name));
		for (let attempt = 1; attempt <= normalizedLimits.maxAttempts && callBudget > 0 && !stopped; attempt++) {
			callBudget--;
			const generated = await runBatch(batch, index, batches.length, attempt, { label, previousFailure });
			let failure: FailedBatchGeneration | undefined;
			if (!generated) failure = { status: "failed", reason: "no batch result", retryable: true };
			else if ("status" in generated) failure = generated;
			else if (!hasExactNameCoverage(generated.processedSkills, expected)) {
				failure = { status: "failed", reason: "incomplete coverage", retryable: true, splittable: true };
			} else if (!hasCompleteBoundCatalog(generated.profile, batch)) {
				failure = { status: "failed", reason: "incomplete catalog coverage", retryable: true, splittable: true };
			}
			if (failure) {
				const willRetry = failure.retryable && attempt < normalizedLimits.maxAttempts && callBudget > 0;
				const willSplit = failure.retryable && failure.splittable === true && !willRetry && batch.length > 1 && callBudget >= 2;
				await onEvent?.({
					type: "rejected",
					index,
					total: batches.length,
					label,
					attempt,
					reason: failure.reason,
					retryable: failure.retryable,
					willRetry,
					willSplit,
				});
				if (!failure.retryable) { stopped = true; return; }
				previousFailure = failure.splittable ? failure.reason.slice(0, 600) : undefined;
				if (willSplit) {
					const middle = Math.ceil(batch.length / 2);
					// Reserve a share for each child so one invalid branch cannot starve its sibling.
					const leftBudget = Math.floor(callBudget / 2);
					await run(batch.slice(0, middle), index, `${label}.1`, leftBudget, previousFailure);
					if (!stopped) await run(batch.slice(middle), index, `${label}.2`, callBudget - leftBudget, previousFailure);
					return;
				}
				if (!willRetry) return;
				continue;
			}
			if (!generated || "status" in generated) return;
			partial = mergeProfiles(partial, generated.profile);
			for (const name of expected) applied.add(name);
			committed += 1;
			await onEvent?.({
				type: "committed",
				index,
				total: batches.length,
				label,
				batchNames: batch.map((skill) => skill.name),
				applied: new Set(applied),
				partial,
			});
			return;
		}
	};
	for (let i = 0; i < batches.length && !stopped; i++) {
		await run(batches[i]!, i, `${i + 1}/${batches.length}`, normalizedLimits.maxAttempts + normalizedLimits.maxRecoveryCalls);
	}
	if (committed === 0) return undefined;
	return { partial, applied };
}
