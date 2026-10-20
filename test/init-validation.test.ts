import assert from "node:assert/strict";
import { test } from "node:test";

import { CATALOG_TAGS } from "../src/catalog.ts";
import { interpretBatchResponse, type BatchResponseOutcome, type ModelResponse } from "../src/generate.ts";
import type { SkillRef } from "../src/profile.ts";

const skills: SkillRef[] = [
	{ name: "alpha", description: "Private source description alpha." },
	{ name: "beta", description: "Private source description beta." },
];
const tag = CATALOG_TAGS[0]!.id;
const response = (text: string, stopReason = "stop"): ModelResponse => ({
	stopReason,
	content: [{ type: "text", text }],
});
const payload = () => ({
	processedSkills: skills.map(({ name }) => name),
	catalogCards: Object.fromEntries(skills.map(({ name }) => [name, { summary: `${name} capability.`, tags: [tag] }])),
});
function failed(outcome: BatchResponseOutcome): Extract<BatchResponseOutcome, { status: "failed" }> {
	assert.equal(outcome.status, "failed");
	if (outcome.status !== "failed") throw new Error("Expected rejected init response");
	return outcome;
}

test("init validation distinguishes splittable content failures from provider and stop failures", () => {
	const contentFailures = [
		response("", "length"),
		response("No JSON available."),
		response("{}"),
		response(JSON.stringify({ ...payload(), processedSkills: ["alpha"] })),
		response(JSON.stringify({ ...payload(), catalogCards: {} })),
	];
	for (const value of contentFailures) {
		assert.equal(failed(interpretBatchResponse(value, skills)).splittable, true);
	}
	for (const stopReason of ["error", "aborted", "toolUse", "unknown"]) {
		assert.notEqual(failed(interpretBatchResponse(response("{}", stopReason), skills)).splittable, true);
	}
});

test("init coverage diagnostics identify missing, extra, duplicate and non-string entries", () => {
	const cases: Array<[unknown[], RegExp[]]> = [
		[["alpha"], [/missing 1/, /"beta"/]],
		[["alpha", "beta", "foreign"], [/extra 1/, /"foreign"/]],
		[["alpha", "beta", "beta"], [/duplicate 1/, /"beta"/]],
		[["alpha", "beta", 42], [/non-string 1/]],
	];
	for (const [processedSkills, expected] of cases) {
		const outcome = failed(interpretBatchResponse(response(JSON.stringify({ ...payload(), processedSkills })), skills));
		assert.match(outcome.reason, /^incomplete processedSkills coverage:/);
		for (const pattern of expected) assert.match(outcome.reason, pattern);
		assert.equal(outcome.splittable, true);
	}
});

test("init missing coverage diagnostics explain an absent, non-array or empty field", () => {
	for (const [processedSkills, detail] of [[undefined, /missing/], ["alpha", /array/], [[], /empty/]] as const) {
		const outcome = failed(interpretBatchResponse(response(JSON.stringify({ ...payload(), processedSkills })), skills));
		assert.match(outcome.reason, /^omitted explicit processedSkills coverage:/);
		assert.match(outcome.reason, detail);
	}
});

test("init card diagnostics identify missing and extra owners", () => {
	for (const [catalogCards, detail] of [
		[{ alpha: payload().catalogCards.alpha }, /missing 1.*"beta"/],
		[{ ...payload().catalogCards, foreign: payload().catalogCards.alpha }, /extra 1.*"foreign"/],
	] as const) {
		const outcome = failed(interpretBatchResponse(response(JSON.stringify({ ...payload(), catalogCards })), skills));
		assert.match(outcome.reason, /^missing or invalid semantic catalog cards:/);
		assert.match(outcome.reason, detail);
	}
});

test("init card diagnostics describe each rejected card field without accepting partial batches", () => {
	const invalidCards: Array<[unknown, RegExp]> = [
		[null, /must be an object/],
		[{ tags: [tag] }, /missing.*summary/],
		[{ summary: "Alpha." }, /missing.*tags/],
		[{ summary: "Alpha.", tags: [tag], sourceHash: "f".repeat(64) }, /extra.*sourceHash/],
		[{ summary: "Alpha.", tags: [tag], invented: true }, /extra.*invented/],
		[{ summary: 42, tags: [tag] }, /summary.*string/],
		[{ summary: "  ", tags: [tag] }, /summary.*empty/],
		[{ summary: "x".repeat(201), tags: [tag] }, /summary.*200/],
		[{ summary: "bad\ud800", tags: [tag] }, /summary.*Unicode/],
		[{ summary: "Alpha.", tags: tag }, /tags.*array/],
		[{ summary: "Alpha.", tags: [] }, /tags.*1-3/],
		[{ summary: "Alpha.", tags: [tag, tag, tag, tag] }, /tags.*1-3/],
		[{ summary: "Alpha.", tags: [42] }, /tags.*string/],
		[{ summary: "Alpha.", tags: ["invented-tag"] }, /tags.*unknown/],
		[{ summary: "Alpha.", tags: [tag, tag] }, /tags.*duplicate/],
	];
	for (const [card, expected] of invalidCards) {
		const value = { ...payload(), catalogCards: { ...payload().catalogCards, alpha: card } };
		const outcome = failed(interpretBatchResponse(response(JSON.stringify(value)), skills));
		assert.match(outcome.reason, /^missing or invalid semantic catalog cards:/);
		assert.match(outcome.reason, /"alpha"/);
		assert.match(outcome.reason, expected);
		assert.equal(outcome.splittable, true);
	}
});

test("init validation diagnostics are bounded and escape unsafe names without response or source dumps", () => {
	const unsafeName = `unsafe\n\u001b[31m\u202e${"x".repeat(2_000)}`;
	const privateDescription = "PRIVATE_SOURCE_DESCRIPTION_DO_NOT_ECHO";
	const batch = [{ name: unsafeName, description: privateDescription }];
	const outcome = failed(interpretBatchResponse(response(JSON.stringify({
		processedSkills: [unsafeName],
		catalogCards: { [unsafeName]: { summary: "", tags: [tag] } },
	})), batch));
	assert.ok(outcome.reason.length <= 600);
	assert.doesNotMatch(outcome.reason, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
	assert.match(outcome.reason, /\\n/);
	assert.match(outcome.reason, /\\u001b/);
	assert.doesNotMatch(outcome.reason, new RegExp(privateDescription));
	const malformed = failed(interpretBatchResponse(response('{"SECRET_RESPONSE_TOKEN": nope}'), skills));
	assert.doesNotMatch(malformed.reason, /SECRET_RESPONSE_TOKEN/);
});

test("init provider diagnostics stay bounded and safe without becoming split feedback", () => {
	const detail = `provider\n\u001b[31m\u202e${"x".repeat(2_000)}`;
	const outcome = failed(interpretBatchResponse({ ...response("", "error"), errorMessage: detail }, skills));
	assert.ok(outcome.reason.length <= 600);
	assert.doesNotMatch(outcome.reason, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
	assert.notEqual(outcome.splittable, true);
	const unexpected = failed(interpretBatchResponse(response("", detail), skills));
	assert.ok(unexpected.reason.length <= 600);
	assert.doesNotMatch(unexpected.reason, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
	assert.notEqual(unexpected.splittable, true);
	for (const errorMessage of ["provider malformed \ud800 \udc00", `provider ${"x".repeat(590)}😀 suffix`]) {
		const malformed = failed(interpretBatchResponse({ ...response("", "error"), errorMessage }, skills));
		assert.ok(malformed.reason.length <= 600);
		assert.doesNotMatch(malformed.reason, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
	}
});

test("init cannot repair malformed or duplicate host names by splitting response batches", () => {
	for (const batch of [
		[{ name: "bad\ud800", description: "Source." }],
		[{ name: " alpha", description: "Source." }],
		[skills[0]!, skills[0]!],
	]) {
		const names = [...new Set(batch.map(({ name }) => name))];
		const outcome = failed(interpretBatchResponse(response(JSON.stringify({
			processedSkills: names,
			catalogCards: Object.fromEntries(names.map((name) => [name, { summary: "Capability.", tags: [tag] }])),
		})), batch));
		assert.notEqual(outcome.splittable, true);
		assert.match(outcome.reason, /input.*name/);
	}
});

test("init validation keeps exact valid card acceptance unchanged", () => {
	assert.equal(interpretBatchResponse(response(JSON.stringify(payload())), skills).status, "ok");
});
