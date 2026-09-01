import assert from "node:assert/strict";
import { test } from "node:test";
import {
	batchSkillsByWeight,
	generateProfileInBatches,
	interpretBatchResponse,
	parseJsonObject,
	responseText,
	stripCodeFences,
	skillBatchUtf8Bytes,
	type ModelResponse,
} from "../src/generate.ts";
import { EMPTY_PROFILE, type SkillOptimizerProfile, type SkillRef } from "../src/profile.ts";

const textResponse = (text: string, stopReason = "stop"): ModelResponse => ({
	stopReason,
	content: [{ type: "text", text }],
});

test("responseText concatenates text blocks and ignores non-text content", () => {
	const res: ModelResponse = {
		content: [
			{ type: "text", text: "a" },
			{ type: "tool_use" } as { type: string },
			{ type: "text", text: "b" },
		],
	};
	assert.equal(responseText(res), "a\nb");
	assert.equal(responseText({}), "");
});

test("stripCodeFences unwraps a ```json fence and leaves bare text alone", () => {
	assert.equal(stripCodeFences("```json\n{\"a\":1}\n```").trim(), '{"a":1}');
	assert.equal(stripCodeFences("{\"a\":1}"), '{"a":1}');
});

test("parseJsonObject parses plain JSON", () => {
	assert.deepEqual(parseJsonObject('{"critical":["a"]}'), { critical: ["a"] });
});

test("parseJsonObject tolerates fences, comments, trailing commas, and surrounding prose", () => {
	const messy = [
		"Here is your profile:",
		"```json",
		"{",
		'  // the critical skills',
		'  "critical": ["a", "b",],',
		'  /* clusters */',
		'  "clusters": { "x": ["a"] },',
		"}",
		"```",
		"Hope that helps!",
	].join("\n");
	assert.deepEqual(parseJsonObject(messy), { critical: ["a", "b"], clusters: { x: ["a"] } });
});

test("parseJsonObject collapses multi-line string values instead of failing", () => {
	const withNewlineInString = '{"queries":{"a":["line one\nline two"]}}';
	const parsed = parseJsonObject(withNewlineInString) as { queries: { a: string[] } };
	assert.equal(parsed.queries.a[0], "line one\nline two");
});

test("parseJsonObject preserves comment markers in strings and stops at the first balanced object", () => {
	assert.deepEqual(
		parseJsonObject('prefix {"url":"https://example.test/a/*b*/","value":"x,}"} suffix {not json}'),
		{ url: "https://example.test/a/*b*/", value: "x,}" },
	);
});

test("parseJsonObject throws the diagnostic error when there is no object", () => {
	assert.throws(() => parseJsonObject(""), /did not contain a JSON object/);
	assert.throws(() => parseJsonObject("no json here"), /did not contain a JSON object/);
	assert.throws(() => parseJsonObject("[1,2,3]"), /did not contain a JSON object/);
});

test("batchSkillsByWeight enforces count and UTF-8 limits without truncating descriptions", () => {
	const skills: SkillRef[] = [
		{ name: "a", description: "ASCII" },
		{ name: "unicode", description: "😀😀" },
		{ name: "c", description: "complete routing description" },
	];
	const firstTwoBytes = skillBatchUtf8Bytes(skills[0]) + skillBatchUtf8Bytes(skills[1]);
	assert.deepEqual(
		batchSkillsByWeight(skills, { maxSkills: 3, maxUtf8Bytes: firstTwoBytes }),
		[[skills[0], skills[1]], [skills[2]]],
	);
	assert.deepEqual(batchSkillsByWeight(skills, { maxSkills: 1, maxUtf8Bytes: 1_000 }), skills.map((skill) => [skill]));
	assert.deepEqual(batchSkillsByWeight([], { maxSkills: 2, maxUtf8Bytes: 100 }), []);
	assert.equal(batchSkillsByWeight([{ name: "huge", description: "x".repeat(200) }], { maxSkills: 2, maxUtf8Bytes: 10 })[0][0].description.length, 200);
});

test("interpretBatchResponse fails on error/aborted with the errorMessage detail", () => {
	const err = interpretBatchResponse({ stopReason: "error", errorMessage: "context length exceeded", content: [] });
	assert.equal(err.status, "failed");
	assert.match((err as { reason: string }).reason, /error: context length exceeded/);

	const aborted = interpretBatchResponse({ stopReason: "aborted", content: [] });
	assert.equal(aborted.status, "failed");
	assert.equal((aborted as { reason: string }).reason, "aborted");
});

test("interpretBatchResponse fails (does not throw) when the body has no JSON object", () => {
	const out = interpretBatchResponse(textResponse("the model refused"));
	assert.equal(out.status, "failed");
	assert.match((out as { reason: string }).reason, /no valid JSON/);
});

test("interpretBatchResponse parses valid output and rejects truncation as retryable", () => {
	const ok = interpretBatchResponse(textResponse('{"critical":["a"],"processedSkills":["a"]}'));
	assert.equal(ok.status, "ok");
	assert.deepEqual((ok as { profile: SkillOptimizerProfile }).profile.critical, ["a"]);

	const truncated = interpretBatchResponse(textResponse('{"critical":["a"]}', "length"));
	assert.equal(truncated.status, "failed");
	assert.equal((truncated as { retryable: boolean }).retryable, true);
});

test("interpretBatchResponse requires explicit processedSkills even with profile content", () => {
	assert.equal(interpretBatchResponse(textResponse("{}")).status, "failed");
	assert.equal(interpretBatchResponse(textResponse('{"critical":["a"]}')).status, "failed");
	const covered = interpretBatchResponse(textResponse('{"processedSkills":["a"]}'));
	assert.equal(covered.status, "ok");
	assert.deepEqual((covered as { processedSkills?: string[] }).processedSkills, ["a"]);
});

const refs = (...names: string[]): SkillRef[] => names.map((name) => ({ name, description: `${name} desc` }));
const limits = (maxSkills: number) => ({ maxSkills, maxUtf8Bytes: 10_000 });

test("generateProfileInBatches batches by size and merges every successful batch", async () => {
	const seen: string[][] = [];
	const result = await generateProfileInBatches(refs("a", "b", "c", "d", "e"), limits(2), async (batch, i, total) => {
		assert.equal(total, 3); // ceil(5/2)
		seen.push(batch.map((s) => s.name));
		return { profile: { ...EMPTY_PROFILE, critical: batch.map((s) => s.name) }, processedSkills: batch.map((s) => s.name) };
	});
	assert.ok(result);
	assert.deepEqual(seen, [["a", "b"], ["c", "d"], ["e"]]);
	assert.deepEqual([...result.applied].sort(), ["a", "b", "c", "d", "e"]);
	assert.deepEqual(result.partial.critical.sort(), ["a", "b", "c", "d", "e"]);
});

test("generateProfileInBatches keeps successes and marks a failed batch's skills unapplied", async () => {
	const result = await generateProfileInBatches(refs("a", "b", "c", "d"), limits(2), async (batch) => {
		if (batch.some((s) => s.name === "c")) return undefined; // 2nd batch (c,d) fails
		return { profile: { ...EMPTY_PROFILE, critical: batch.map((s) => s.name) }, processedSkills: batch.map((s) => s.name) };
	});
	assert.ok(result);
	assert.deepEqual([...result.applied].sort(), ["a", "b"]);
	assert.deepEqual(result.partial.critical.sort(), ["a", "b"]);
	// caller derives failed = changed - applied
	const failed = ["a", "b", "c", "d"].filter((n) => !result.applied.has(n));
	assert.deepEqual(failed, ["c", "d"]);
});

test("generateProfileInBatches rejects incomplete or foreign batch coverage", async () => {
	let attempts = 0;
	const result = await generateProfileInBatches(refs("a", "b"), limits(2), async () => {
		attempts += 1;
		return {
			profile: { ...EMPTY_PROFILE, critical: ["a"] },
			processedSkills: ["a", "not-in-batch"],
		};
	});
	assert.equal(result, undefined);
	assert.equal(attempts, 2);
});

test("generateProfileInBatches retries incomplete coverage and accepts a complete retry once", async () => {
	const attempts: number[] = [];
	const skills = refs("a", "b");
	const result = await generateProfileInBatches(
		skills,
		{ maxSkills: 2, maxUtf8Bytes: 1_000, maxAttempts: 3 },
		async (batch, _index, _total, attempt) => {
			attempts.push(attempt);
			return {
				profile: { ...EMPTY_PROFILE, critical: batch.map((skill) => skill.name) },
				processedSkills: attempt === 1 ? ["a"] : batch.map((skill) => skill.name),
			};
		},
	);
	assert.ok(result);
	assert.deepEqual(attempts, [1, 2]);
	assert.deepEqual([...result.applied].sort(), ["a", "b"]);
});

test("generateProfileInBatches has no legacy fallback without explicit processedSkills", async () => {
	const result = await generateProfileInBatches(refs("a"), limits(1), async () => EMPTY_PROFILE as unknown as { profile: SkillOptimizerProfile; processedSkills: string[] });
	assert.equal(result, undefined);
});

test("generateProfileInBatches returns undefined only when every batch fails", async () => {
	const result = await generateProfileInBatches(refs("a", "b", "c"), limits(1), async () => undefined);
	assert.equal(result, undefined);
});
