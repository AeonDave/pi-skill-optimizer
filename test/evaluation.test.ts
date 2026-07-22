import assert from "node:assert/strict";
import { test } from "node:test";
import {
	aggregateEvaluationCases,
	collectIndependentEvidenceLines,
	deriveSkillStates,
	distribution,
	evaluateCase,
	evaluateMode,
	evaluateRequiredGroups,
	parseStrictAllowedSelection,
	type EvaluationMode,
	type ModeEvaluationInput,
} from "../src/evaluation.ts";
import { transformSkillsInText } from "../src/skills.ts";

function skillXml(name: string, description = "", location = `C:/skills/${name}/SKILL.md`): string {
	const descriptionLine = description ? `\n    <description>${description}</description>` : "";
	const locationLine = location ? `\n    <location>${location}</location>` : "";
	return `  <skill>\n    <name>${name}</name>${descriptionLine}${locationLine}\n  </skill>`;
}

function catalog(...skills: string[]): string {
	return `<available_skills>\n${skills.join("\n")}\n</available_skills>`;
}

test("deriveSkillStates distinguishes full, intent, name-only, and missing while resolving path-note loadability", () => {
	const original = catalog(
		skillXml("alpha", "Alpha complete description."),
		skillXml("beta", "Beta complete routing description."),
		skillXml("gamma", "Gamma complete description."),
		skillXml("delta", "Delta complete description."),
	);
	const rendered = `<available_skills>\n  <!--skill-optimizer-->\n  <skill_path_note>Skills listed without a location field are stored at {root}/{name}/SKILL.md (roots: C:/skills). Read that file to load one, or run /skill:name.</skill_path_note>\n${[
		skillXml("alpha", "Alpha complete description."),
		skillXml("beta", "Beta routing." , ""),
		skillXml("gamma", "", ""),
	].join("\n")}\n</available_skills>`;
	const analysis = deriveSkillStates(original, rendered);
	assert.deepEqual(analysis.states.map((state) => state.state), ["full", "intent", "name-only", "missing"]);
	assert.deepEqual(analysis.states.map((state) => state.loadable), [true, true, true, false]);
	assert.equal(analysis.namesPreserved, false);
	assert.equal(analysis.orderPreserved, false);
});

test("path notes do not rescue an incorrect explicit location", () => {
	const original = catalog(skillXml("alpha", "Alpha description."));
	const rendered = `<available_skills>\n  <skill_path_note>Skills listed without a location field are stored at {root}/{name}/SKILL.md (roots: C:/skills). Read that file to load one.</skill_path_note>\n${skillXml("alpha", "Alpha description.", "C:/wrong/alpha/SKILL.md")}\n</available_skills>`;
	assert.equal(deriveSkillStates(original, rendered).states[0]?.loadable, false);
});

test("hard safety rejects rewritten tail descriptions", () => {
	const original = catalog(skillXml("alpha", "Alpha exact operational workflow."));
	const rendered = catalog(skillXml("alpha", "Completely paraphrased guidance."));
	const result = evaluateMode({
		mode: "compact",
		originalText: original,
		renderedText: rendered,
		requiredGroups: [],
		selectedSkillNames: [],
		identityPreserved: false,
		reoptimizedText: rendered,
		reoptimizedIdentity: true,
	});
	assert.equal(result.safety.passed, false);
	assert.equal(result.safety.checks.find((check) => check.name === "tail-description-extractive")?.passed, false);
});

test("independent evidence oracle is uncapped and strict judge parsing never converts invalid output to an empty selection", () => {
	const output = Array.from({ length: 150 }, (_, index) => `ERROR E${1000 + index}: failure ${index}`).join("\n");
	assert.equal(collectIndependentEvidenceLines(output).length, 150);
	const allowed = new Set(["alpha", "beta"]);
	assert.deepEqual(parseStrictAllowedSelection('{"skills":["alpha"]}', "skills", allowed), ["alpha"]);
	assert.deepEqual(parseStrictAllowedSelection('{"skills":[]}', "skills", allowed), []);
	assert.throws(() => parseStrictAllowedSelection("not json", "skills", allowed), /strict JSON/);
	assert.throws(() => parseStrictAllowedSelection('{"skills":["unknown"]}', "skills", allowed), /unknown/);
});

test("required groups support alternatives and report full, intent, loadable, promoted, and model-selected recall", () => {
	const original = catalog(
		skillXml("alpha", "Alpha complete description."),
		skillXml("beta", "Beta complete routing description."),
		skillXml("gamma", "Gamma complete description."),
	);
	const rendered = `<available_skills>\n  <skill_path_note>Skills listed without a location field are stored at {root}/{name}/SKILL.md (roots: C:/skills). Read that file to load one.</skill_path_note>\n${[
		skillXml("alpha", "Alpha complete description."),
		skillXml("beta", "Beta routing.", ""),
		skillXml("gamma", "", ""),
	].join("\n")}\n</available_skills>`;
	const states = deriveSkillStates(original, rendered).states;
	const metrics = evaluateRequiredGroups(
		states,
		[{ anyOf: ["alpha"] }, { anyOf: ["beta", "alternative-beta"] }, { anyOf: ["gamma"] }],
		["alpha"],
		["alpha", "gamma"],
	);
	assert.equal(metrics.full.recall, 1 / 3);
	assert.equal(metrics.intent.recall, 2 / 3);
	assert.equal(metrics.loadable.recall, 1);
	assert.equal(metrics.promoted.recall, 1 / 3);
	assert.equal(metrics.modelSelected?.recall, 2 / 3);
	assert.equal(metrics.allGroupsLoadable, true);
	assert.equal(metrics.allGroupsFull, false);
});

const DESCRIPTIONS = {
	alpha: "Alpha specialist workflow. Additional detailed operational guidance that should be removed from compact tails.",
	beta: "Beta specialist workflow. Additional detailed operational guidance that should be removed from compact tails.",
	gamma: "Gamma specialist workflow. Additional detailed operational guidance that should be removed from compact tails.",
	delta: "Delta specialist workflow. Additional detailed operational guidance that should be removed from compact tails.",
};
const ORIGINAL = catalog(...Object.entries(DESCRIPTIONS).map(([name, description]) => skillXml(name, description)));

function transformedMode(mode: "compact" | "hybrid", query: string) {
	const options = { mode, topK: 1, tail: "name" as const, query };
	const first = transformSkillsInText(ORIGINAL, options);
	const second = transformSkillsInText(first.text, options);
	return { first, second };
}

function caseMode(mode: EvaluationMode, query: string, modelSelected: string): Omit<ModeEvaluationInput, "originalText" | "requiredGroups" | "originalSerializedText"> {
	if (mode === "off") {
		return {
			mode,
			renderedText: ORIGINAL,
			selectedSkillNames: [],
			modelSelectedSkillNames: [modelSelected],
			identityPreserved: true,
			reoptimizedText: ORIGINAL,
			reoptimizedIdentity: true,
			exactTokenCounts: { tokenizer: "fixture-tokenizer", before: 100, after: 100 },
		};
	}
	const { first, second } = transformedMode(mode, query);
	return {
		mode,
		renderedText: first.text,
		selectedSkillNames: first.selected,
		modelSelectedSkillNames: [modelSelected],
		identityPreserved: first.text === ORIGINAL,
		reoptimizedText: second.text,
		reoptimizedIdentity: second.text === first.text && second.removedChars === 0,
		exactTokenCounts: { tokenizer: "fixture-tokenizer", before: 100, after: mode === "compact" ? 40 : 60 },
	};
}

test("evaluateCase and aggregateEvaluationCases produce paired byte/token/recall metrics and enforce cache stability", () => {
	const makeCase = (id: string, query: string, required: string) => evaluateCase({
		id,
		catalogKey: "shared-catalog",
		originalText: ORIGINAL,
		requiredGroups: [{ anyOf: [required] }],
		modes: [caseMode("off", query, required), caseMode("compact", query, required), caseMode("hybrid", query, required)],
	});
	const first = makeCase("one", "alpha", "alpha");
	const second = makeCase("two", "beta", "beta");
	assert.equal(first.modes.off.coverage.full.recall, 1);
	assert.equal(first.modes.compact.coverage.intent.recall, 1);
	assert.equal(first.modes.hybrid.coverage.full.recall, 1);
	assert.ok(first.modes.off.safety.passed);
	assert.ok(first.modes.compact.safety.passed);
	assert.ok(first.modes.hybrid.safety.passed);

	const aggregate = aggregateEvaluationCases([first, second]);
	assert.equal(aggregate.compactCacheStability.comparedCatalogs, 1);
	assert.equal(aggregate.compactCacheStability.passed, true);
	assert.equal(aggregate.hardSafetyPassed, true);
	assert.equal(aggregate.modes.hybrid.fullRecall.microRecall, 1);
	assert.equal(aggregate.modes.compact.fullCount.count, 2);
	assert.equal(aggregate.modes.compact.exactTokensByTokenizer["fixture-tokenizer"].saved.mean, 60);
	assert.equal(aggregate.pairs.offToCompact.exactTokensSavedByTo["fixture-tokenizer"].mean, 60);
	assert.ok((aggregate.pairs.offToCompact.bytesSavedByTo.mean ?? 0) > 0);
});

test("cache stability is not applicable when no catalog has repeated cases", () => {
	const single = evaluateCase({
		id: "single",
		catalogKey: "single-catalog",
		originalText: ORIGINAL,
		requiredGroups: [{ anyOf: ["alpha"] }],
		modes: [caseMode("off", "alpha", "alpha"), caseMode("compact", "alpha", "alpha"), caseMode("hybrid", "alpha", "alpha")],
	});
	const aggregate = aggregateEvaluationCases([single]);
	assert.equal(aggregate.compactCacheStability.comparedCatalogs, 0);
	assert.equal(aggregate.compactCacheStability.passed, null);
});

test("hard safety detects off mutation, reordered names, selected non-full skills, and failed idempotence", () => {
	const reordered = catalog(
		skillXml("beta", DESCRIPTIONS.beta),
		skillXml("alpha", DESCRIPTIONS.alpha),
		skillXml("gamma", DESCRIPTIONS.gamma),
		skillXml("delta", DESCRIPTIONS.delta),
	);
	const result = evaluateMode({
		mode: "off",
		originalText: ORIGINAL,
		renderedText: reordered,
		requiredGroups: [{ anyOf: ["alpha"] }],
		selectedSkillNames: ["alpha"],
		identityPreserved: false,
		reoptimizedText: `${reordered}\nchanged`,
		reoptimizedIdentity: false,
	});
	assert.equal(result.safety.passed, false);
	const failed = new Set(result.safety.checks.filter((check) => !check.passed).map((check) => check.name));
	assert.ok(failed.has("order-preservation"));
	assert.ok(failed.has("idempotence"));
	assert.ok(failed.has("off-identity"));
});

test("distribution uses deterministic median and nearest-rank p95; UTF-8 byte metrics are not character estimates", () => {
	assert.deepEqual(distribution([1, 2, 3, 100]), { count: 4, mean: 26.5, median: 2.5, p95: 100, min: 1, max: 100 });
	const empty = distribution([]);
	assert.equal(empty.mean, null);
	const utf8 = evaluateMode({
		mode: "off",
		originalText: "🔥",
		renderedText: "🔥",
		requiredGroups: [],
		selectedSkillNames: [],
		identityPreserved: true,
		reoptimizedText: "🔥",
		reoptimizedIdentity: true,
	});
	assert.equal(utf8.bytesBefore, 4);
	assert.equal(utf8.exactTokenCounts, undefined);
});


test("extractive safety accepts ordered runtime description fragments", async () => {
	const [{ descriptionIsExtractedVerbatim }, { compactDescription }] = await Promise.all([
		import("../src/evaluation.ts"),
		import("../src/skills.ts"),
	]);
	const original = "An intentionally detailed opening sentence establishes the skill purpose and operating boundaries. Supporting details are omitted here. Use this skill when authentication failures need focused investigation.";
	const rendered = compactDescription(original, 80);

	assert.match(rendered, /…[\s\S]*Use this skill/u);
	assert.equal(descriptionIsExtractedVerbatim(original, rendered), true);
	assert.equal(descriptionIsExtractedVerbatim(original, "Use this skill when investigation needs focused authentication failures."), false);
});
