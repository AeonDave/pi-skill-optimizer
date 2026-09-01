/** Pure evaluation helpers for paired baseline/auto skill-catalog corpora. */

import { parseSkills, type Skill } from "./skills.ts";

export type EvaluationArm = "baseline" | "auto";
export type SkillExposure = "full" | "intent" | "name-only" | "missing";

export interface RequiredGroup {
	/** Alternatives that satisfy the same requirement. */
	anyOf: readonly string[];
}

export interface SkillRenderState {
	key: string;
	blockIndex: number;
	occurrence: number;
	name: string;
	state: SkillExposure;
	loadable: boolean;
	descriptionVerbatim: boolean;
	descriptionExtractedVerbatim: boolean;
	locationVerbatim: boolean;
	original: Skill;
	rendered?: Skill;
}

export interface SkillStateAnalysis {
	states: SkillRenderState[];
	originalNames: string[];
	renderedNames: string[];
	unexpectedNames: string[];
	namesPreserved: boolean;
	orderPreserved: boolean;
	allRetainedLoadable: boolean;
}

export interface CoverageMetric {
	covered: number;
	total: number;
	recall: number | null;
}

export interface RequiredGroupMetrics {
	baseFull: CoverageMetric;
	baseIntent: CoverageMetric;
	baseLoadable: CoverageMetric;
	overlay: CoverageMetric;
	prefetch: CoverageMetric;
	modelSelected: CoverageMetric | null;
	allGroupsBaseFull: boolean | null;
	allGroupsBaseIntent: boolean | null;
	allGroupsBaseLoadable: boolean | null;
	allGroupsOverlay: boolean | null;
	allGroupsPrefetched: boolean | null;
	allGroupsModelSelected: boolean | null;
}

/** Counts produced by an authoritative tokenizer. No estimate is inferred. */
export interface ExactTokenCounts {
	tokenizer: string;
	before: number;
	after: number;
}

export interface ArmEvaluationInput {
	arm: EvaluationArm;
	/** Full catalog before auto rendering. */
	originalText: string;
	/** Query-independent prompt-cache base for this arm. */
	baseText: string;
	/** Query-specific eager prefetch surface; empty for baseline. */
	overlayText: string;
	requiredGroups: readonly RequiredGroup[];
	/** Names selected by the prefetch planner, independently of overlay parsing. */
	prefetchedSkillNames: readonly string[];
	/** Downstream model skill choices, when independently observed. */
	modelSelectedSkillNames?: readonly string[];
	originalSerializedText?: string;
	renderedSerializedText?: string;
	/** True iff base rendering preserved the caller's original input identity. */
	baseIdentityPreserved: boolean;
	/** Base produced by applying stable rendering a second time. */
	reoptimizedBaseText: string;
	/** True iff the second base pass was an identity no-op. */
	reoptimizedBaseIdentity: boolean;
	exactTokenCounts?: ExactTokenCounts;
}

export interface SafetyCheck {
	name: string;
	passed: boolean;
	detail?: string;
}

export interface SafetyReport {
	passed: boolean;
	checks: SafetyCheck[];
}

export interface ArmEvaluation {
	arm: EvaluationArm;
	analysis: SkillStateAnalysis;
	coverage: RequiredGroupMetrics;
	overlaySkillNames: string[];
	prefetchedSkillNames: string[];
	baseFullCount: number;
	baseIntentCount: number;
	baseNameOnlyCount: number;
	baseMissingCount: number;
	overlayCount: number;
	prefetchCount: number;
	bytesBefore: number;
	baseBytes: number;
	overlayBytes: number;
	bytesAfter: number;
	bytesSaved: number;
	exactTokenCounts?: ExactTokenCounts & { saved: number };
	safety: SafetyReport;
	baseText: string;
	overlayText: string;
}

export interface EvaluationCaseInput {
	id: string;
	/** Stable project/catalog key used for base-cache grouping. */
	catalogKey?: string;
	originalText: string;
	requiredGroups: readonly RequiredGroup[];
	originalSerializedText?: string;
	arms: readonly Omit<ArmEvaluationInput, "originalText" | "requiredGroups" | "originalSerializedText">[];
}

export interface EvaluationCaseResult {
	id: string;
	catalogKey: string;
	arms: Record<EvaluationArm, ArmEvaluation>;
}

export interface Distribution {
	count: number;
	mean: number | null;
	median: number | null;
	p95: number | null;
	min: number | null;
	max: number | null;
}

export interface RecallAggregate {
	examples: number;
	coveredGroups: number;
	totalGroups: number;
	macroRecall: number | null;
	microRecall: number | null;
	allGroupsRate: number | null;
}

export interface ExactTokenAggregate {
	samples: number;
	before: Distribution;
	after: Distribution;
	saved: Distribution;
}

export interface ArmAggregate {
	arm: EvaluationArm;
	samples: number;
	bytesBefore: Distribution;
	baseBytes: Distribution;
	overlayBytes: Distribution;
	bytesAfter: Distribution;
	bytesSaved: Distribution;
	baseFullCount: Distribution;
	overlayCount: Distribution;
	prefetchCount: Distribution;
	exactTokensByTokenizer: Record<string, ExactTokenAggregate>;
	baseFullRecall: RecallAggregate;
	baseIntentRecall: RecallAggregate;
	baseLoadableRecall: RecallAggregate;
	overlayRecall: RecallAggregate;
	prefetchRecall: RecallAggregate;
	modelSelectedRecall: RecallAggregate;
}

export interface PairedArmAggregate {
	from: "baseline";
	to: "auto";
	samples: number;
	/** Positive means auto retained fewer complete eager-request UTF-8 bytes. */
	bytesSavedByAuto: Distribution;
	/** Positive means auto retained fewer query-independent base bytes. */
	baseBytesSavedByAuto: Distribution;
	/** Query-specific bytes added by auto's eager overlay. */
	overlayBytesAddedByAuto: Distribution;
	exactTokensSavedByAuto: Record<string, Distribution>;
}

export interface BaseCacheStability {
	/** Null means fewer than two cases shared a catalog. */
	passed: boolean | null;
	comparedCatalogs: number;
	unstableCatalogKeys: string[];
}

export interface EvaluationAggregate {
	arms: Record<EvaluationArm, ArmAggregate>;
	pair: PairedArmAggregate;
	baseCacheStability: BaseCacheStability;
	hardSafetyPassed: boolean;
	safetyFailures: Array<{ caseId: string; arm: EvaluationArm; check: string; detail?: string }>;
}

interface ParsedBlock {
	inner: string;
	skills: Skill[];
	roots: Set<string>;
	resolverBacked: boolean;
}

const CATALOG_RE = /<available_skills>([\s\S]*?)<\/available_skills>/g;
const PATH_NOTE_RE = /<skill_path_note>([\s\S]*?)<\/skill_path_note>/g;

/** Independent benchmark oracle; intentionally separate from the runtime reducer. */
const EVALUATION_EVIDENCE_PATTERNS: readonly RegExp[] = [
	/\b(?:error|failed|failure|fatal|panic|exception|traceback|warning|warn|denied|timed?\s*out)\b/i,
	/^\s*(?:at\s+\S|Caused by:|File\s+["'][^"']+["'],\s+line\s+\d+)/i,
	/(?:^|\s)(?:FAIL|FAILED|not ok)(?:\s|$|:)/i,
	/\b(?:assert(?:ion)?|expected|actual|received)\b/i,
	/\b(?:exit(?:ed)?\s+(?:code|status)|non-zero)\b/i,
	/(?:^|\s)(?:[A-Za-z]:[\\/]|\/|\.\.\/[\w.-])?[^\s:()[\]{}]+\.[A-Za-z0-9]{1,12}:\d+(?::\d+)?\b/,
	/^\s*(?:constraint|requirement|required|must(?:\s+not)?|do\s+not|never|shall(?:\s+not)?)\b/i,
	/\b(?:[45]\d{2}|E\d{2,}|ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT)\b/,
];

export function collectIndependentEvidenceLines(text: string): string[] {
	return text.split(/\r?\n/).filter((line) => EVALUATION_EVIDENCE_PATTERNS.some((pattern) => pattern.test(line)));
}

/** Invalid JSON and unknown labels are errors, never empty selections. */
export function parseStrictAllowedSelection(text: string, field: string, allowed: ReadonlySet<string>): string[] {
	let source = text.trim();
	const fenced = source.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
	if (fenced) source = fenced[1].trim();
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch (error) {
		throw new Error(`judge response is not strict JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("judge response must be a JSON object");
	const entries = (value as Record<string, unknown>)[field];
	if (!Array.isArray(entries)) throw new Error(`judge response field ${field} must be an array`);
	const selected: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (typeof entry !== "string") throw new Error(`judge response field ${field} must contain only strings`);
		if (!allowed.has(entry)) throw new Error(`judge response contains unknown ${field} value: ${entry}`);
		if (!seen.has(entry)) {
			seen.add(entry);
			selected.push(entry);
		}
	}
	return selected;
}

export function descriptionIsExtractedVerbatim(original: string, rendered: string): boolean {
	if (!rendered.trim()) return true;
	const sourceWords = Array.from(original.matchAll(/[\p{L}\p{N}]+/gu), (match) => match[0]);
	const renderedWords = Array.from(rendered.matchAll(/[\p{L}\p{N}]+/gu), (match) => {
		const end = (match.index ?? 0) + match[0].length;
		return { value: match[0], truncated: /^[^\p{L}\p{N}]*…/u.test(rendered.slice(end)) };
	});
	if (renderedWords.length === 0) return original.trim().length > 0 && /^…+$/u.test(rendered.trim());
	let sourceIndex = 0;
	for (const word of renderedWords) {
		while (sourceIndex < sourceWords.length) {
			const sourceWord = sourceWords[sourceIndex];
			if (sourceWord === word.value || (word.truncated && sourceWord.startsWith(word.value))) break;
			sourceIndex += 1;
		}
		if (sourceIndex === sourceWords.length) return false;
		sourceIndex += 1;
	}
	return true;
}

function pathRoots(inner: string): Set<string> {
	const roots = new Set<string>();
	for (const note of inner.matchAll(PATH_NOTE_RE)) {
		const match = note[1].match(/\(roots:\s*([\s\S]*?)\)\.\s*Read/i);
		if (!match) continue;
		for (const root of match[1].split("|").map((value) => value.trim()).filter(Boolean)) roots.add(root);
	}
	return roots;
}

function parseCatalogBlocks(text: string): ParsedBlock[] {
	return Array.from(text.matchAll(CATALOG_RE), (match) => ({
		inner: match[1],
		skills: parseSkills(match[1]),
		roots: pathRoots(match[1]),
		resolverBacked: match[1].includes("<!--skill-optimizer:auto:v2-->"),
	}));
}

function parseOverlaySkills(text: string): Skill[] {
	if (!text.trim()) return [];
	const blocks = parseCatalogBlocks(text);
	return blocks.length > 0 ? blocks.flatMap((block) => block.skills) : parseSkills(text);
}

function derivableRoot(location: string, name: string): string | null {
	const match = location.match(/^(.*)[\\/]([^\\/]+)[\\/]SKILL\.md$/i);
	return match && match[2] === name ? match[1] : null;
}

function multisetEqual(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const counts = new Map<string, number>();
	for (const value of left) counts.set(value, (counts.get(value) ?? 0) + 1);
	for (const value of right) {
		const count = counts.get(value) ?? 0;
		if (count === 0) return false;
		if (count === 1) counts.delete(value);
		else counts.set(value, count - 1);
	}
	return counts.size === 0;
}

/** Derive every original skill's exposure and loadability in the stable base. */
export function deriveSkillStates(originalText: string, baseText: string): SkillStateAnalysis {
	const originalBlocks = parseCatalogBlocks(originalText);
	const renderedBlocks = parseCatalogBlocks(baseText);
	const states: SkillRenderState[] = [];
	const unexpectedNames: string[] = [];
	const originalNames = originalBlocks.flatMap((block) => block.skills.map((skill) => skill.name));
	const renderedNames = renderedBlocks.flatMap((block) => block.skills.map((skill) => skill.name));

	for (let blockIndex = 0; blockIndex < originalBlocks.length; blockIndex++) {
		const originalBlock = originalBlocks[blockIndex];
		const renderedBlock = renderedBlocks[blockIndex];
		const queues = new Map<string, Array<{ skill: Skill; index: number }>>();
		for (const [index, skill] of (renderedBlock?.skills ?? []).entries()) {
			const queue = queues.get(skill.name) ?? [];
			queue.push({ skill, index });
			queues.set(skill.name, queue);
		}
		const usedRendered = new Set<number>();
		const occurrences = new Map<string, number>();
		for (const original of originalBlock.skills) {
			const occurrence = occurrences.get(original.name) ?? 0;
			occurrences.set(original.name, occurrence + 1);
			const matched = queues.get(original.name)?.shift();
			if (matched) usedRendered.add(matched.index);
			const rendered = matched?.skill;
			const descriptionVerbatim = rendered !== undefined && rendered.description === original.description;
			const descriptionExtractedVerbatim = rendered !== undefined && descriptionIsExtractedVerbatim(original.description, rendered.description);
			const locationVerbatim = rendered !== undefined && rendered.location === original.location;
			let state: SkillExposure;
			if (!rendered) state = "missing";
			else if (descriptionVerbatim && locationVerbatim) state = "full";
			else if (!rendered.description) state = "name-only";
			else state = "intent";

			const root = derivableRoot(original.location, original.name);
			const hasExplicitLocation = !!rendered?.location;
			const explicitLocation = hasExplicitLocation && rendered.location === original.location;
			const locationFromNote = !hasExplicitLocation && root !== null && (renderedBlock?.roots.has(root) ?? false);
			const locationFromResolver = !!rendered && (renderedBlock?.resolverBacked ?? false);
			const loadable = !!rendered && (explicitLocation || locationFromNote || locationFromResolver);
			states.push({
				key: `${blockIndex}:${original.name}:${occurrence}`,
				blockIndex,
				occurrence,
				name: original.name,
				state,
				loadable,
				descriptionVerbatim,
				descriptionExtractedVerbatim,
				locationVerbatim,
				original,
				...(rendered ? { rendered } : {}),
			});
		}
		for (const [index, skill] of (renderedBlock?.skills ?? []).entries()) {
			if (!usedRendered.has(index)) unexpectedNames.push(skill.name);
		}
	}
	for (let i = originalBlocks.length; i < renderedBlocks.length; i++) {
		unexpectedNames.push(...renderedBlocks[i].skills.map((skill) => skill.name));
	}

	return {
		states,
		originalNames,
		renderedNames,
		unexpectedNames,
		namesPreserved: multisetEqual(originalNames, renderedNames),
		orderPreserved: originalNames.length === renderedNames.length && originalNames.every((name, i) => renderedNames[i] === name),
		allRetainedLoadable: states.filter((state) => state.state !== "missing").every((state) => state.loadable),
	};
}

function coverageMetric(groups: readonly RequiredGroup[], covered: (name: string) => boolean): CoverageMetric {
	let count = 0;
	for (const group of groups) if (group.anyOf.some(covered)) count += 1;
	return { covered: count, total: groups.length, recall: groups.length === 0 ? null : count / groups.length };
}

export function evaluateRequiredGroups(
	states: readonly SkillRenderState[],
	groups: readonly RequiredGroup[],
	overlaySkillNames: readonly string[],
	prefetchedSkillNames: readonly string[],
	modelSelectedSkillNames?: readonly string[],
): RequiredGroupMetrics {
	const byName = new Map<string, SkillRenderState[]>();
	for (const state of states) {
		const entries = byName.get(state.name) ?? [];
		entries.push(state);
		byName.set(state.name, entries);
	}
	const has = (name: string, predicate: (state: SkillRenderState) => boolean): boolean => (byName.get(name) ?? []).some(predicate);
	const overlaySet = new Set(overlaySkillNames);
	const prefetchSet = new Set(prefetchedSkillNames);
	const modelSet = modelSelectedSkillNames === undefined ? undefined : new Set(modelSelectedSkillNames);
	const baseFull = coverageMetric(groups, (name) => has(name, (state) => state.state === "full"));
	const baseIntent = coverageMetric(groups, (name) => has(name, (state) => state.state === "full" || state.state === "intent"));
	const baseLoadable = coverageMetric(groups, (name) => has(name, (state) => state.loadable));
	const overlay = coverageMetric(groups, (name) => overlaySet.has(name));
	const prefetch = coverageMetric(groups, (name) => prefetchSet.has(name));
	const modelSelected = modelSet === undefined ? null : coverageMetric(groups, (name) => modelSet.has(name));
	const all = (metric: CoverageMetric): boolean | null => metric.total === 0 ? null : metric.covered === metric.total;
	return {
		baseFull,
		baseIntent,
		baseLoadable,
		overlay,
		prefetch,
		modelSelected,
		allGroupsBaseFull: all(baseFull),
		allGroupsBaseIntent: all(baseIntent),
		allGroupsBaseLoadable: all(baseLoadable),
		allGroupsOverlay: all(overlay),
		allGroupsPrefetched: all(prefetch),
		allGroupsModelSelected: modelSelected ? all(modelSelected) : null,
	};
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

function validateExactTokens(value: ExactTokenCounts | undefined): (ExactTokenCounts & { saved: number }) | undefined {
	if (!value) return undefined;
	if (!value.tokenizer.trim()) throw new Error("exactTokenCounts.tokenizer must be non-empty");
	if (![value.before, value.after].every((count) => Number.isInteger(count) && count >= 0)) {
		throw new Error("exactTokenCounts must contain non-negative integer counts");
	}
	return { ...value, saved: value.before - value.after };
}

function combinedText(baseText: string, overlayText: string): string {
	return overlayText.trim() ? `${baseText}\n\n${overlayText}` : baseText;
}

function overlayIsVerbatim(originalText: string, overlayText: string, overlaySkills: readonly Skill[]): boolean {
	const originals = parseCatalogBlocks(originalText).flatMap((block) => block.skills);
	const resolverBacked = overlayText.includes("<skill_prefetch");
	return overlaySkills.every((rendered) => originals.some((original) =>
		original.name === rendered.name
		&& original.description === rendered.description
		&& (original.location === rendered.location || (resolverBacked && rendered.location === ""))));
}

/** Evaluate one artifact while keeping stable-base and eager-overlay metrics separate. */
export function evaluateArm(input: ArmEvaluationInput): ArmEvaluation {
	if ((input.originalSerializedText === undefined) !== (input.renderedSerializedText === undefined)) {
		throw new Error("originalSerializedText and renderedSerializedText must be provided together");
	}
	const analysis = deriveSkillStates(input.originalText, input.baseText);
	const overlaySkills = parseOverlaySkills(input.overlayText);
	const overlaySkillNames = overlaySkills.map((skill) => skill.name);
	const prefetchedSkillNames = [...input.prefetchedSkillNames];
	const coverage = evaluateRequiredGroups(
		analysis.states,
		input.requiredGroups,
		overlaySkillNames,
		prefetchedSkillNames,
		input.modelSelectedSkillNames,
	);
	const stateCount = (state: SkillExposure): number => analysis.states.filter((entry) => entry.state === state).length;
	const descriptionsExtractive = analysis.states
		.filter((state) => state.state !== "missing")
		.every((state) => state.descriptionExtractedVerbatim);
	const overlayVerbatim = overlayIsVerbatim(input.originalText, input.overlayText, overlaySkills);
	const overlayPrefetchIntegrity = multisetEqual(overlaySkillNames, prefetchedSkillNames);
	const checks: SafetyCheck[] = [
		{ name: "base-name-preservation", passed: analysis.namesPreserved, detail: analysis.namesPreserved ? undefined : "base names differ from the original multiset" },
		{ name: "base-order-preservation", passed: analysis.orderPreserved, detail: analysis.orderPreserved ? undefined : "base skill order changed" },
		{ name: "base-description-extractive", passed: descriptionsExtractive, detail: descriptionsExtractive ? undefined : "base description contains non-extractive text" },
		{ name: "base-loadability", passed: analysis.namesPreserved && analysis.allRetainedLoadable, detail: analysis.namesPreserved && analysis.allRetainedLoadable ? undefined : "a base skill is missing or not loadable" },
		{ name: "overlay-verbatim", passed: overlayVerbatim, detail: overlayVerbatim ? undefined : "overlay contains an unknown or rewritten skill" },
		{ name: "overlay-prefetch-integrity", passed: overlayPrefetchIntegrity, detail: overlayPrefetchIntegrity ? undefined : "overlay names differ from the prefetch plan" },
		{
			name: "base-idempotence",
			passed: input.reoptimizedBaseText === input.baseText && input.reoptimizedBaseIdentity,
			detail: input.reoptimizedBaseText === input.baseText && input.reoptimizedBaseIdentity ? undefined : "second stable-base pass changed text or identity",
		},
	];
	if (input.arm === "baseline") {
		const passed = input.baseText === input.originalText
			&& input.baseIdentityPreserved
			&& input.overlayText.trim().length === 0
			&& prefetchedSkillNames.length === 0;
		checks.push({ name: "baseline-identity", passed, detail: passed ? undefined : "baseline changed the catalog or added prefetch content" });
	}
	const beforeText = input.originalSerializedText ?? input.originalText;
	const afterText = input.renderedSerializedText ?? combinedText(input.baseText, input.overlayText);
	const bytesBefore = utf8Bytes(beforeText);
	const baseBytes = utf8Bytes(input.baseText);
	const overlayBytes = utf8Bytes(input.overlayText);
	const bytesAfter = utf8Bytes(afterText);
	return {
		arm: input.arm,
		analysis,
		coverage,
		overlaySkillNames,
		prefetchedSkillNames,
		baseFullCount: stateCount("full"),
		baseIntentCount: stateCount("intent"),
		baseNameOnlyCount: stateCount("name-only"),
		baseMissingCount: stateCount("missing"),
		overlayCount: overlaySkillNames.length,
		prefetchCount: prefetchedSkillNames.length,
		bytesBefore,
		baseBytes,
		overlayBytes,
		bytesAfter,
		bytesSaved: bytesBefore - bytesAfter,
		...(input.exactTokenCounts ? { exactTokenCounts: validateExactTokens(input.exactTokenCounts) } : {}),
		safety: { passed: checks.every((check) => check.passed), checks },
		baseText: input.baseText,
		overlayText: input.overlayText,
	};
}

/** Evaluate exactly one baseline artifact and one auto artifact. */
export function evaluateCase(input: EvaluationCaseInput): EvaluationCaseResult {
	const arms = new Map(input.arms.map((arm) => [arm.arm, arm]));
	for (const arm of ["baseline", "auto"] as const) {
		if (!arms.has(arm)) throw new Error(`evaluation case ${input.id} is missing arm ${arm}`);
	}
	const evaluate = (arm: EvaluationArm): ArmEvaluation => evaluateArm({
		...arms.get(arm)!,
		arm,
		originalText: input.originalText,
		requiredGroups: input.requiredGroups,
		...(input.originalSerializedText === undefined ? {} : { originalSerializedText: input.originalSerializedText }),
	});
	return {
		id: input.id,
		catalogKey: input.catalogKey ?? input.originalText,
		arms: { baseline: evaluate("baseline"), auto: evaluate("auto") },
	};
}

/** Deterministic nearest-rank distributions used by corpus reports. */
export function distribution(values: readonly number[]): Distribution {
	if (values.length === 0) return { count: 0, mean: null, median: null, p95: null, min: null, max: null };
	const sorted = [...values].sort((a, b) => a - b);
	const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
	const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
	return { count: sorted.length, mean, median, p95, min: sorted[0], max: sorted[sorted.length - 1] };
}

function aggregateRecall(
	evaluations: readonly ArmEvaluation[],
	metric: (coverage: RequiredGroupMetrics) => CoverageMetric | null,
): RecallAggregate {
	const values = evaluations.map((evaluation) => metric(evaluation.coverage)).filter((value): value is CoverageMetric => value !== null && value.total > 0);
	const coveredGroups = values.reduce((sum, value) => sum + value.covered, 0);
	const totalGroups = values.reduce((sum, value) => sum + value.total, 0);
	return {
		examples: values.length,
		coveredGroups,
		totalGroups,
		macroRecall: values.length === 0 ? null : values.reduce((sum, value) => sum + (value.recall ?? 0), 0) / values.length,
		microRecall: totalGroups === 0 ? null : coveredGroups / totalGroups,
		allGroupsRate: values.length === 0 ? null : values.filter((value) => value.covered === value.total).length / values.length,
	};
}

function aggregateArm(arm: EvaluationArm, evaluations: readonly ArmEvaluation[]): ArmAggregate {
	const tokenGroups = new Map<string, Array<ExactTokenCounts & { saved: number }>>();
	for (const evaluation of evaluations) {
		const tokens = evaluation.exactTokenCounts;
		if (!tokens) continue;
		const group = tokenGroups.get(tokens.tokenizer) ?? [];
		group.push(tokens);
		tokenGroups.set(tokens.tokenizer, group);
	}
	const exactTokensByTokenizer: Record<string, ExactTokenAggregate> = {};
	for (const [tokenizer, values] of tokenGroups) {
		exactTokensByTokenizer[tokenizer] = {
			samples: values.length,
			before: distribution(values.map((value) => value.before)),
			after: distribution(values.map((value) => value.after)),
			saved: distribution(values.map((value) => value.saved)),
		};
	}
	return {
		arm,
		samples: evaluations.length,
		bytesBefore: distribution(evaluations.map((value) => value.bytesBefore)),
		baseBytes: distribution(evaluations.map((value) => value.baseBytes)),
		overlayBytes: distribution(evaluations.map((value) => value.overlayBytes)),
		bytesAfter: distribution(evaluations.map((value) => value.bytesAfter)),
		bytesSaved: distribution(evaluations.map((value) => value.bytesSaved)),
		baseFullCount: distribution(evaluations.map((value) => value.baseFullCount)),
		overlayCount: distribution(evaluations.map((value) => value.overlayCount)),
		prefetchCount: distribution(evaluations.map((value) => value.prefetchCount)),
		exactTokensByTokenizer,
		baseFullRecall: aggregateRecall(evaluations, (coverage) => coverage.baseFull),
		baseIntentRecall: aggregateRecall(evaluations, (coverage) => coverage.baseIntent),
		baseLoadableRecall: aggregateRecall(evaluations, (coverage) => coverage.baseLoadable),
		overlayRecall: aggregateRecall(evaluations, (coverage) => coverage.overlay),
		prefetchRecall: aggregateRecall(evaluations, (coverage) => coverage.prefetch),
		modelSelectedRecall: aggregateRecall(evaluations, (coverage) => coverage.modelSelected),
	};
}

function aggregatePair(cases: readonly EvaluationCaseResult[]): PairedArmAggregate {
	const tokenDeltas = new Map<string, number[]>();
	for (const entry of cases) {
		const baseline = entry.arms.baseline.exactTokenCounts;
		const auto = entry.arms.auto.exactTokenCounts;
		if (!baseline || !auto || baseline.tokenizer !== auto.tokenizer) continue;
		const values = tokenDeltas.get(baseline.tokenizer) ?? [];
		values.push(baseline.after - auto.after);
		tokenDeltas.set(baseline.tokenizer, values);
	}
	return {
		from: "baseline",
		to: "auto",
		samples: cases.length,
		bytesSavedByAuto: distribution(cases.map((entry) => entry.arms.baseline.bytesAfter - entry.arms.auto.bytesAfter)),
		baseBytesSavedByAuto: distribution(cases.map((entry) => entry.arms.baseline.baseBytes - entry.arms.auto.baseBytes)),
		overlayBytesAddedByAuto: distribution(cases.map((entry) => entry.arms.auto.overlayBytes - entry.arms.baseline.overlayBytes)),
		exactTokensSavedByAuto: Object.fromEntries([...tokenDeltas].map(([tokenizer, values]) => [tokenizer, distribution(values)])),
	};
}

/** Aggregate paired cases without mixing catalogs or tokenizer families. */
export function aggregateEvaluationCases(cases: readonly EvaluationCaseResult[]): EvaluationAggregate {
	const autoBasesByCatalog = new Map<string, Set<string>>();
	const catalogCounts = new Map<string, number>();
	for (const entry of cases) {
		const outputs = autoBasesByCatalog.get(entry.catalogKey) ?? new Set<string>();
		outputs.add(entry.arms.auto.baseText);
		autoBasesByCatalog.set(entry.catalogKey, outputs);
		catalogCounts.set(entry.catalogKey, (catalogCounts.get(entry.catalogKey) ?? 0) + 1);
	}
	const comparedCatalogs = [...catalogCounts.values()].filter((count) => count > 1).length;
	const unstableCatalogKeys = [...autoBasesByCatalog]
		.filter(([key, outputs]) => (catalogCounts.get(key) ?? 0) > 1 && outputs.size > 1)
		.map(([key]) => key);
	const safetyFailures: EvaluationAggregate["safetyFailures"] = [];
	for (const entry of cases) {
		for (const arm of ["baseline", "auto"] as const) {
			for (const check of entry.arms[arm].safety.checks) {
				if (!check.passed) safetyFailures.push({ caseId: entry.id, arm, check: check.name, ...(check.detail ? { detail: check.detail } : {}) });
			}
		}
	}
	const baseCacheStability: BaseCacheStability = {
		passed: comparedCatalogs === 0 ? null : unstableCatalogKeys.length === 0,
		comparedCatalogs,
		unstableCatalogKeys,
	};
	return {
		arms: {
			baseline: aggregateArm("baseline", cases.map((entry) => entry.arms.baseline)),
			auto: aggregateArm("auto", cases.map((entry) => entry.arms.auto)),
		},
		pair: aggregatePair(cases),
		baseCacheStability,
		hardSafetyPassed: safetyFailures.length === 0 && baseCacheStability.passed !== false,
		safetyFailures,
	};
}
