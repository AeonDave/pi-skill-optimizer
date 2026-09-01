import assert from "node:assert/strict";
import { test } from "node:test";
import {
	aggregateEvaluationCases,
	collectIndependentEvidenceLines,
	deriveSkillStates,
	descriptionIsExtractedVerbatim,
	distribution,
	evaluateArm,
	evaluateCase,
	evaluateRequiredGroups,
	parseStrictAllowedSelection,
	type ArmEvaluationInput,
	type EvaluationArm,
} from "../src/evaluation.ts";

function skillXml(name: string, description = "", location = `C:/skills/${name}/SKILL.md`): string {
	const descriptionLine = description ? `\n    <description>${description}</description>` : "";
	const locationLine = location ? `\n    <location>${location}</location>` : "";
	return `  <skill>\n    <name>${name}</name>${descriptionLine}${locationLine}\n  </skill>`;
}

function catalog(...skills: string[]): string {
	return `<available_skills>\n${skills.join("\n")}\n</available_skills>`;
}

test("deriveSkillStates distinguishes exposures while resolving path-note loadability", () => {
	const original = catalog(
		skillXml("alpha", "Alpha complete description."),
		skillXml("beta", "Beta complete routing description."),
		skillXml("gamma", "Gamma complete description."),
		skillXml("delta", "Delta complete description."),
	);
	const rendered = `<available_skills>\n  <!--skill-optimizer:auto:v2-->\n  <skill_path_note>Skills listed without a location field are stored at {root}/{name}/SKILL.md (roots: C:/skills). Read that file to load one.</skill_path_note>\n${[
		skillXml("alpha", "Alpha complete description."),
		skillXml("beta", "Beta routing.", ""),
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

test("hard safety rejects rewritten base descriptions", () => {
	const original = catalog(skillXml("alpha", "Alpha exact operational workflow."));
	const rendered = catalog(skillXml("alpha", "Completely paraphrased guidance."));
	const result = evaluateArm({
		arm: "auto",
		originalText: original,
		baseText: rendered,
		overlayText: "",
		requiredGroups: [],
		prefetchedSkillNames: [],
		baseIdentityPreserved: false,
		reoptimizedBaseText: rendered,
		reoptimizedBaseIdentity: true,
	});
	assert.equal(result.safety.passed, false);
	assert.equal(result.safety.checks.find((check) => check.name === "base-description-extractive")?.passed, false);
});

test("independent evidence is uncapped and strict parsing rejects invalid selections", () => {
	const output = Array.from({ length: 150 }, (_, index) => `ERROR E${1000 + index}: failure ${index}`).join("\n");
	assert.equal(collectIndependentEvidenceLines(output).length, 150);
	const allowed = new Set(["alpha", "beta"]);
	assert.deepEqual(parseStrictAllowedSelection('{"skills":["alpha"]}', "skills", allowed), ["alpha"]);
	assert.deepEqual(parseStrictAllowedSelection('{"skills":[]}', "skills", allowed), []);
	assert.throws(() => parseStrictAllowedSelection("not json", "skills", allowed), /strict JSON/);
	assert.throws(() => parseStrictAllowedSelection('{"skills":["unknown"]}', "skills", allowed), /unknown/);
});

test("required groups report base, overlay, prefetch, and model recall independently", () => {
	const original = catalog(
		skillXml("alpha", "Alpha complete description."),
		skillXml("beta", "Beta complete routing description."),
		skillXml("gamma", "Gamma complete description."),
	);
	const base = `<available_skills>\n  <skill_path_note>Skills listed without a location field are stored at {root}/{name}/SKILL.md (roots: C:/skills). Read that file to load one.</skill_path_note>\n${[
		skillXml("alpha", "Alpha complete description."),
		skillXml("beta", "Beta routing.", ""),
		skillXml("gamma", "", ""),
	].join("\n")}\n</available_skills>`;
	const states = deriveSkillStates(original, base).states;
	const metrics = evaluateRequiredGroups(
		states,
		[{ anyOf: ["alpha"] }, { anyOf: ["beta", "alternative-beta"] }, { anyOf: ["gamma"] }],
		["beta"],
		["beta", "gamma"],
		["alpha", "gamma"],
	);
	assert.equal(metrics.baseFull.recall, 1 / 3);
	assert.equal(metrics.baseIntent.recall, 2 / 3);
	assert.equal(metrics.baseLoadable.recall, 1);
	assert.equal(metrics.overlay.recall, 1 / 3);
	assert.equal(metrics.prefetch.recall, 2 / 3);
	assert.equal(metrics.modelSelected?.recall, 2 / 3);
});

const DESCRIPTIONS = {
	alpha: "Alpha specialist workflow. Additional detailed operational guidance that is absent from the stable base.",
	beta: "Beta specialist workflow. Additional detailed operational guidance that is absent from the stable base.",
	gamma: "Gamma specialist workflow. Additional detailed operational guidance that is absent from the stable base.",
	delta: "Delta specialist workflow. Additional detailed operational guidance that is absent from the stable base.",
};
const ORIGINAL = catalog(...Object.entries(DESCRIPTIONS).map(([name, description]) => skillXml(name, description)));
const STABLE_BASE = `<available_skills>\n  <!--skill-optimizer:auto:v2-->\n  <skill_path_note>Skills listed without a location field are stored at {root}/{name}/SKILL.md (roots: C:/skills). Read that file to load one.</skill_path_note>\n${Object.keys(DESCRIPTIONS).map((name) =>
	skillXml(name, `${name[0].toUpperCase() + name.slice(1)} specialist workflow.`, "")).join("\n")}\n</available_skills>`;

function caseArm(
	arm: EvaluationArm,
	required: keyof typeof DESCRIPTIONS,
	baseText = STABLE_BASE,
): Omit<ArmEvaluationInput, "originalText" | "requiredGroups" | "originalSerializedText"> {
	if (arm === "baseline") {
		return {
			arm,
			baseText: ORIGINAL,
			overlayText: "",
			prefetchedSkillNames: [],
			modelSelectedSkillNames: [required],
			renderedSerializedText: JSON.stringify({ system: ORIGINAL }),
			baseIdentityPreserved: true,
			reoptimizedBaseText: ORIGINAL,
			reoptimizedBaseIdentity: true,
			exactTokenCounts: { tokenizer: "fixture-tokenizer", before: 100, after: 100 },
		};
	}
	const overlayText = catalog(skillXml(required, DESCRIPTIONS[required]));
	return {
		arm,
		baseText,
		overlayText,
		prefetchedSkillNames: [required],
		modelSelectedSkillNames: [required],
		renderedSerializedText: JSON.stringify({ system: `${baseText}\n\n${overlayText}` }),
		baseIdentityPreserved: false,
		reoptimizedBaseText: baseText,
		reoptimizedBaseIdentity: true,
		exactTokenCounts: { tokenizer: "fixture-tokenizer", before: 100, after: 60 },
	};
}

function evaluatedCase(id: string, required: keyof typeof DESCRIPTIONS, baseText = STABLE_BASE) {
	return evaluateCase({
		id,
		catalogKey: "shared-catalog",
		originalText: ORIGINAL,
		originalSerializedText: JSON.stringify({ system: ORIGINAL }),
		requiredGroups: [{ anyOf: [required] }],
		arms: [caseArm("baseline", required), caseArm("auto", required, baseText)],
	});
}

test("paired aggregation separates stable base, overlay recall, and prefetch recall", () => {
	const first = evaluatedCase("one", "alpha");
	const second = evaluatedCase("two", "beta");
	assert.equal(first.arms.baseline.coverage.baseFull.recall, 1);
	assert.equal(first.arms.auto.coverage.overlay.recall, 1);
	assert.equal(first.arms.auto.coverage.prefetch.recall, 1);
	assert.ok(first.arms.baseline.safety.passed);
	assert.ok(first.arms.auto.safety.passed);

	const aggregate = aggregateEvaluationCases([first, second]);
	assert.equal(aggregate.baseCacheStability.comparedCatalogs, 1);
	assert.equal(aggregate.baseCacheStability.passed, true);
	assert.equal(aggregate.hardSafetyPassed, true);
	assert.equal(aggregate.arms.auto.overlayRecall.microRecall, 1);
	assert.equal(aggregate.arms.auto.prefetchRecall.microRecall, 1);
	assert.equal(aggregate.arms.auto.overlayCount.count, 2);
	assert.equal(aggregate.arms.auto.exactTokensByTokenizer["fixture-tokenizer"].saved.mean, 40);
	assert.equal(aggregate.pair.exactTokensSavedByAuto["fixture-tokenizer"].mean, 40);
	assert.ok((aggregate.pair.baseBytesSavedByAuto.mean ?? 0) > 0);
});

test("base cache stability is query-independent and detects changed bases", () => {
	const single = aggregateEvaluationCases([evaluatedCase("single", "alpha")]);
	assert.equal(single.baseCacheStability.comparedCatalogs, 0);
	assert.equal(single.baseCacheStability.passed, null);

	const unstable = aggregateEvaluationCases([
		evaluatedCase("one", "alpha"),
		evaluatedCase("two", "beta", `${STABLE_BASE}\n`),
	]);
	assert.equal(unstable.baseCacheStability.comparedCatalogs, 1);
	assert.equal(unstable.baseCacheStability.passed, false);
	assert.deepEqual(unstable.baseCacheStability.unstableCatalogKeys, ["shared-catalog"]);
});

test("hard safety detects baseline mutation and overlay/prefetch divergence", () => {
	const reordered = catalog(
		skillXml("beta", DESCRIPTIONS.beta),
		skillXml("alpha", DESCRIPTIONS.alpha),
		skillXml("gamma", DESCRIPTIONS.gamma),
		skillXml("delta", DESCRIPTIONS.delta),
	);
	const baseline = evaluateArm({
		arm: "baseline",
		originalText: ORIGINAL,
		baseText: reordered,
		overlayText: "",
		requiredGroups: [{ anyOf: ["alpha"] }],
		prefetchedSkillNames: [],
		baseIdentityPreserved: false,
		reoptimizedBaseText: `${reordered}\nchanged`,
		reoptimizedBaseIdentity: false,
	});
	const failed = new Set(baseline.safety.checks.filter((check) => !check.passed).map((check) => check.name));
	assert.ok(failed.has("base-order-preservation"));
	assert.ok(failed.has("base-idempotence"));
	assert.ok(failed.has("baseline-identity"));

	const divergent = evaluateArm({
		...caseArm("auto", "alpha"),
		originalText: ORIGINAL,
		originalSerializedText: JSON.stringify({ system: ORIGINAL }),
		requiredGroups: [{ anyOf: ["alpha"] }],
		prefetchedSkillNames: ["beta"],
	});
	assert.equal(divergent.safety.checks.find((check) => check.name === "overlay-prefetch-integrity")?.passed, false);
});

test("distribution and UTF-8 byte metrics are exact", () => {
	assert.deepEqual(distribution([1, 2, 3, 100]), { count: 4, mean: 26.5, median: 2.5, p95: 100, min: 1, max: 100 });
	assert.equal(distribution([]).mean, null);
	const utf8 = evaluateArm({
		arm: "baseline",
		originalText: "🔥",
		baseText: "🔥",
		overlayText: "",
		requiredGroups: [],
		prefetchedSkillNames: [],
		baseIdentityPreserved: true,
		reoptimizedBaseText: "🔥",
		reoptimizedBaseIdentity: true,
	});
	assert.equal(utf8.bytesBefore, 4);
	assert.equal(utf8.exactTokenCounts, undefined);
});

test("extractive safety accepts ordered fragments and rejects reordered prose", () => {
	const original = "An intentionally detailed opening sentence establishes the skill purpose and operating boundaries. Supporting details are omitted here. Use this skill when authentication failures need focused investigation.";
	const rendered = "An intentionally detailed opening… Use this skill when authentication failures need focused investigation.";
	assert.equal(descriptionIsExtractedVerbatim(original, rendered), true);
	assert.equal(descriptionIsExtractedVerbatim(original, "Use this skill when investigation needs focused authentication failures."), false);
});
