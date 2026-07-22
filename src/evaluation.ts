/** Pure evaluation helpers for real, labeled skill-catalog corpora. */

import { parseSkills, type Skill } from "./skills.ts";

export type EvaluationMode = "off" | "compact" | "hybrid";
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
	full: CoverageMetric;
	intent: CoverageMetric;
	loadable: CoverageMetric;
	promoted: CoverageMetric;
	modelSelected: CoverageMetric | null;
	allGroupsFull: boolean | null;
	allGroupsIntent: boolean | null;
	allGroupsLoadable: boolean | null;
	allGroupsPromoted: boolean | null;
	allGroupsModelSelected: boolean | null;
}

/** Counts produced by an authoritative tokenizer. No token estimate is inferred here. */
export interface ExactTokenCounts {
	tokenizer: string;
	before: number;
	after: number;
}

export interface ModeEvaluationInput {
	mode: EvaluationMode;
	/** Catalog-bearing text before optimization. */
	originalText: string;
	/** The corresponding catalog-bearing text after optimization. */
	renderedText: string;
	requiredGroups: readonly RequiredGroup[];
	/** `OptimizeResult.selected`, used to measure full-promotion recall and integrity. */
	selectedSkillNames: readonly string[];
	/** Downstream model skill choices, when independently observed. */
	modelSelectedSkillNames?: readonly string[];
	/** Original full serialized payload when byte metrics should cover more than the catalog text. */
	originalSerializedText?: string;
	/** Rendered full serialized payload paired with `originalSerializedText`. */
	renderedSerializedText?: string;
	/** True iff the first optimize call returned its original input reference. */
	identityPreserved: boolean;
	/** Text produced by optimizing the first result again with the same configuration. */
	reoptimizedText: string;
	/** True iff the second optimize call returned its first-pass input reference. */
	reoptimizedIdentity: boolean;
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

export interface ModeEvaluation {
	mode: EvaluationMode;
	analysis: SkillStateAnalysis;
	coverage: RequiredGroupMetrics;
	fullCount: number;
	intentCount: number;
	nameOnlyCount: number;
	missingCount: number;
	bytesBefore: number;
	bytesAfter: number;
	bytesSaved: number;
	exactTokenCounts?: ExactTokenCounts & { saved: number };
	safety: SafetyReport;
	renderedText: string;
}

export interface EvaluationCaseInput {
	id: string;
	/** Stable catalog/project key used for compact cache-stability grouping. */
	catalogKey?: string;
	originalText: string;
	requiredGroups: readonly RequiredGroup[];
	originalSerializedText?: string;
	modes: readonly Omit<ModeEvaluationInput, "originalText" | "requiredGroups" | "originalSerializedText">[];
}

export interface EvaluationCaseResult {
	id: string;
	catalogKey: string;
	modes: Record<EvaluationMode, ModeEvaluation>;
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

export interface ModeAggregate {
	mode: EvaluationMode;
	samples: number;
	bytesBefore: Distribution;
	bytesAfter: Distribution;
	bytesSaved: Distribution;
	fullCount: Distribution;
	exactTokensByTokenizer: Record<string, ExactTokenAggregate>;
	fullRecall: RecallAggregate;
	intentRecall: RecallAggregate;
	loadableRecall: RecallAggregate;
	promotionRecall: RecallAggregate;
	modelSelectedRecall: RecallAggregate;
}

export interface PairedModeAggregate {
	from: EvaluationMode;
	to: EvaluationMode;
	samples: number;
	/** Positive means `to` retained fewer UTF-8 bytes than `from`. */
	bytesSavedByTo: Distribution;
	/** Positive means `to` rendered more skills full than `from`. */
	fullCountChange: Distribution;
	/** Token deltas are grouped so counts from different tokenizers are never mixed. */
	exactTokensSavedByTo: Record<string, Distribution>;
}

export interface CompactCacheStability {
	/** Null means fewer than two cases shared a catalog, so stability was not measured. */
	passed: boolean | null;
	comparedCatalogs: number;
	unstableCatalogKeys: string[];
}

export interface EvaluationAggregate {
	modes: Record<EvaluationMode, ModeAggregate>;
	pairs: {
		offToCompact: PairedModeAggregate;
		offToHybrid: PairedModeAggregate;
		compactToHybrid: PairedModeAggregate;
	};
	compactCacheStability: CompactCacheStability;
	hardSafetyPassed: boolean;
	safetyFailures: Array<{ caseId: string; mode: EvaluationMode; check: string; detail?: string }>;
}

interface ParsedBlock {
	inner: string;
	skills: Skill[];
	roots: Set<string>;
}

const CATALOG_RE = /<available_skills>([\s\S]*?)<\/available_skills>/g;
const PATH_NOTE_RE = /<skill_path_note>([\s\S]*?)<\/skill_path_note>/g;

/** Independent benchmark oracle. These patterns intentionally do not import the runtime reducer. */
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

/** Collect every independently recognized evidence occurrence, without a silent cap. */
export function collectIndependentEvidenceLines(text: string): string[] {
	return text.split(/\r?\n/).filter((line) => EVALUATION_EVIDENCE_PATTERNS.some((pattern) => pattern.test(line)));
}

/** Strict parser for model-judge arrays. Invalid JSON and unknown labels are errors, not empty selections. */
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
		return {
			value: match[0],
			truncated: /^[^\p{L}\p{N}]*…/u.test(rendered.slice(end)),
		};
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
	}));
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

/** Derive every original skill's rendered exposure and loadability. */
export function deriveSkillStates(originalText: string, renderedText: string): SkillStateAnalysis {
	const originalBlocks = parseCatalogBlocks(originalText);
	const renderedBlocks = parseCatalogBlocks(renderedText);
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
			const loadable = !!rendered && (explicitLocation || locationFromNote);
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

/** Evaluate multi-label requirements, including alternative skills in each group. */
export function evaluateRequiredGroups(
	states: readonly SkillRenderState[],
	groups: readonly RequiredGroup[],
	promotedSkillNames: readonly string[],
	modelSelectedSkillNames?: readonly string[],
): RequiredGroupMetrics {
	const byName = new Map<string, SkillRenderState[]>();
	for (const state of states) {
		const entries = byName.get(state.name) ?? [];
		entries.push(state);
		byName.set(state.name, entries);
	}
	const has = (name: string, predicate: (state: SkillRenderState) => boolean): boolean => (byName.get(name) ?? []).some(predicate);
	const full = coverageMetric(groups, (name) => has(name, (state) => state.state === "full"));
	const intent = coverageMetric(groups, (name) => has(name, (state) => state.state === "full" || state.state === "intent"));
	const loadable = coverageMetric(groups, (name) => has(name, (state) => state.loadable));
	const promotedSet = new Set(promotedSkillNames);
	const promoted = coverageMetric(groups, (name) => promotedSet.has(name));
	const modelSelected = modelSelectedSkillNames === undefined
		? null
		: coverageMetric(groups, (name) => new Set(modelSelectedSkillNames).has(name));
	const all = (metric: CoverageMetric): boolean | null => metric.total === 0 ? null : metric.covered === metric.total;
	return {
		full,
		intent,
		loadable,
		promoted,
		modelSelected,
		allGroupsFull: all(full),
		allGroupsIntent: all(intent),
		allGroupsLoadable: all(loadable),
		allGroupsPromoted: all(promoted),
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

/** Evaluate one mode artifact produced by the caller's real optimize pass. */
export function evaluateMode(input: ModeEvaluationInput): ModeEvaluation {
	if ((input.originalSerializedText === undefined) !== (input.renderedSerializedText === undefined)) {
		throw new Error("originalSerializedText and renderedSerializedText must be provided together");
	}
	const analysis = deriveSkillStates(input.originalText, input.renderedText);
	const coverage = evaluateRequiredGroups(analysis.states, input.requiredGroups, input.selectedSkillNames, input.modelSelectedSkillNames);
	const stateCount = (state: SkillExposure): number => analysis.states.filter((entry) => entry.state === state).length;
	const selectedFullVerbatim = input.selectedSkillNames.every((name) =>
		analysis.states.some((state) => state.name === name && state.state === "full" && state.descriptionVerbatim && state.locationVerbatim));
	const descriptionsExtractive = analysis.states
		.filter((state) => state.state !== "missing")
		.every((state) => state.descriptionExtractedVerbatim);
	const checks: SafetyCheck[] = [
		{ name: "name-preservation", passed: analysis.namesPreserved, detail: analysis.namesPreserved ? undefined : "rendered names differ from the original multiset" },
		{ name: "order-preservation", passed: analysis.orderPreserved, detail: analysis.orderPreserved ? undefined : "skill order changed" },
		{ name: "full-description-verbatim", passed: selectedFullVerbatim, detail: selectedFullVerbatim ? undefined : "a selected skill is not a verbatim full render" },
		{ name: "tail-description-extractive", passed: descriptionsExtractive, detail: descriptionsExtractive ? undefined : "a rendered description contains text not extracted verbatim and in order from the original" },
		{ name: "loadability", passed: analysis.namesPreserved && analysis.allRetainedLoadable, detail: analysis.namesPreserved && analysis.allRetainedLoadable ? undefined : "a retained skill is missing or not loadable" },
		{
			name: "idempotence",
			passed: input.reoptimizedText === input.renderedText && input.reoptimizedIdentity,
			detail: input.reoptimizedText === input.renderedText && input.reoptimizedIdentity ? undefined : "second pass changed text or did not preserve identity",
		},
	];
	if (input.mode === "off") {
		const passed = input.renderedText === input.originalText && input.identityPreserved;
		checks.push({ name: "off-identity", passed, detail: passed ? undefined : "off mode changed text or reference identity" });
	}
	const beforeText = input.originalSerializedText ?? input.originalText;
	const afterText = input.renderedSerializedText ?? input.renderedText;
	const bytesBefore = utf8Bytes(beforeText);
	const bytesAfter = utf8Bytes(afterText);
	return {
		mode: input.mode,
		analysis,
		coverage,
		fullCount: stateCount("full"),
		intentCount: stateCount("intent"),
		nameOnlyCount: stateCount("name-only"),
		missingCount: stateCount("missing"),
		bytesBefore,
		bytesAfter,
		bytesSaved: bytesBefore - bytesAfter,
		...(input.exactTokenCounts ? { exactTokenCounts: validateExactTokens(input.exactTokenCounts) } : {}),
		safety: { passed: checks.every((check) => check.passed), checks },
		renderedText: input.renderedText,
	};
}

/** Evaluate the required off/compact/hybrid artifacts for one labeled query. */
export function evaluateCase(input: EvaluationCaseInput): EvaluationCaseResult {
	const modes = new Map(input.modes.map((mode) => [mode.mode, mode]));
	for (const mode of ["off", "compact", "hybrid"] as const) {
		if (!modes.has(mode)) throw new Error(`evaluation case ${input.id} is missing mode ${mode}`);
	}
	const evaluate = (mode: EvaluationMode): ModeEvaluation => evaluateMode({
		...modes.get(mode)!,
		mode,
		originalText: input.originalText,
		requiredGroups: input.requiredGroups,
		...(input.originalSerializedText === undefined ? {} : { originalSerializedText: input.originalSerializedText }),
	});
	return {
		id: input.id,
		catalogKey: input.catalogKey ?? input.originalText,
		modes: { off: evaluate("off"), compact: evaluate("compact"), hybrid: evaluate("hybrid") },
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
	evaluations: readonly ModeEvaluation[],
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

function aggregateMode(mode: EvaluationMode, evaluations: readonly ModeEvaluation[]): ModeAggregate {
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
		mode,
		samples: evaluations.length,
		bytesBefore: distribution(evaluations.map((value) => value.bytesBefore)),
		bytesAfter: distribution(evaluations.map((value) => value.bytesAfter)),
		bytesSaved: distribution(evaluations.map((value) => value.bytesSaved)),
		fullCount: distribution(evaluations.map((value) => value.fullCount)),
		exactTokensByTokenizer,
		fullRecall: aggregateRecall(evaluations, (coverage) => coverage.full),
		intentRecall: aggregateRecall(evaluations, (coverage) => coverage.intent),
		loadableRecall: aggregateRecall(evaluations, (coverage) => coverage.loadable),
		promotionRecall: aggregateRecall(evaluations, (coverage) => coverage.promoted),
		modelSelectedRecall: aggregateRecall(evaluations, (coverage) => coverage.modelSelected),
	};
}

function aggregatePair(cases: readonly EvaluationCaseResult[], from: EvaluationMode, to: EvaluationMode): PairedModeAggregate {
	const tokenDeltas = new Map<string, number[]>();
	for (const entry of cases) {
		const left = entry.modes[from].exactTokenCounts;
		const right = entry.modes[to].exactTokenCounts;
		if (!left || !right || left.tokenizer !== right.tokenizer) continue;
		const values = tokenDeltas.get(left.tokenizer) ?? [];
		values.push(left.after - right.after);
		tokenDeltas.set(left.tokenizer, values);
	}
	return {
		from,
		to,
		samples: cases.length,
		bytesSavedByTo: distribution(cases.map((entry) => entry.modes[from].bytesAfter - entry.modes[to].bytesAfter)),
		fullCountChange: distribution(cases.map((entry) => entry.modes[to].fullCount - entry.modes[from].fullCount)),
		exactTokensSavedByTo: Object.fromEntries([...tokenDeltas].map(([tokenizer, values]) => [tokenizer, distribution(values)])),
	};
}

/** Aggregate paired cases without mixing catalogs, examples, or tokenizer families. */
export function aggregateEvaluationCases(cases: readonly EvaluationCaseResult[]): EvaluationAggregate {
	const compactByCatalog = new Map<string, Set<string>>();
	const catalogCounts = new Map<string, number>();
	for (const entry of cases) {
		const outputs = compactByCatalog.get(entry.catalogKey) ?? new Set<string>();
		outputs.add(entry.modes.compact.renderedText);
		compactByCatalog.set(entry.catalogKey, outputs);
		catalogCounts.set(entry.catalogKey, (catalogCounts.get(entry.catalogKey) ?? 0) + 1);
	}
	const comparedCatalogs = [...catalogCounts.values()].filter((count) => count > 1).length;
	const unstableCatalogKeys = [...compactByCatalog]
		.filter(([key, outputs]) => (catalogCounts.get(key) ?? 0) > 1 && outputs.size > 1)
		.map(([key]) => key);
	const safetyFailures: EvaluationAggregate["safetyFailures"] = [];
	for (const entry of cases) {
		for (const mode of ["off", "compact", "hybrid"] as const) {
			for (const check of entry.modes[mode].safety.checks) {
				if (!check.passed) safetyFailures.push({ caseId: entry.id, mode, check: check.name, ...(check.detail ? { detail: check.detail } : {}) });
			}
		}
	}
	const compactCacheStability = {
		passed: comparedCatalogs === 0 ? null : unstableCatalogKeys.length === 0,
		comparedCatalogs,
		unstableCatalogKeys,
	};
	return {
		modes: {
			off: aggregateMode("off", cases.map((entry) => entry.modes.off)),
			compact: aggregateMode("compact", cases.map((entry) => entry.modes.compact)),
			hybrid: aggregateMode("hybrid", cases.map((entry) => entry.modes.hybrid)),
		},
		pairs: {
			offToCompact: aggregatePair(cases, "off", "compact"),
			offToHybrid: aggregatePair(cases, "off", "hybrid"),
			compactToHybrid: aggregatePair(cases, "compact", "hybrid"),
		},
		compactCacheStability,
		hardSafetyPassed: safetyFailures.length === 0 && compactCacheStability.passed !== false,
		safetyFailures,
	};
}
