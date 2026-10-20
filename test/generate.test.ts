import assert from "node:assert/strict";
import { test } from "node:test";
import {
	batchSkillsByWeight,
	generateProfileInBatches,
	interpretBatchResponse,
	isRetryableBatchException,
	parseJsonObject,
	responseText,
	serializeSkillBatch,
	stripCodeFences,
	skillBatchUtf8Bytes,
	type ModelResponse,
} from "../src/generate.ts";
import { EMPTY_PROFILE, hashSkill, type SkillOptimizerProfile, type SkillRef } from "../src/profile.ts";
import { CATALOG_TAGS } from "../src/catalog.ts";

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
	const firstTwo = [skills[0]!, skills[1]!];
	const firstTwoBytes = skillBatchUtf8Bytes(firstTwo);
	assert.deepEqual(
		batchSkillsByWeight(skills, { maxSkills: 3, maxUtf8Bytes: firstTwoBytes }),
		[firstTwo, [skills[2]!]],
	);
	assert.deepEqual(batchSkillsByWeight(skills, { maxSkills: 1, maxUtf8Bytes: 1_000 }), skills.map((skill) => [skill]));
	assert.deepEqual(batchSkillsByWeight([], { maxSkills: 2, maxUtf8Bytes: 100 }), []);
	assert.equal(batchSkillsByWeight([{ name: "huge", description: "x".repeat(200) }], { maxSkills: 2, maxUtf8Bytes: 10 })[0][0].description.length, 200);
});

test("init batch byte accounting is the exact UTF-8 size of the shared JSON request serializer", () => {
	const skills: SkillRef[] = [
		{ name: "quote\"slash\\", description: "line one\nline two; café 🙂" },
		{ name: "next", description: "short" },
	];
	const expected = JSON.stringify({ skills: skills.map(({ name, description }) => ({ name, description })) });
	assert.equal(serializeSkillBatch(skills), expected);
	assert.equal(skillBatchUtf8Bytes(skills), Buffer.byteLength(expected, "utf8"));
	assert.ok(skillBatchUtf8Bytes(skills) > Buffer.byteLength(skills.map((s) => `- ${s.name}: ${s.description}\n`).join(""), "utf8"));
});

test("interpretBatchResponse fails on error/aborted with the errorMessage detail", () => {
	const err = interpretBatchResponse({ stopReason: "error", errorMessage: "context length exceeded", content: [] });
	assert.equal(err.status, "failed");
	assert.match((err as { reason: string }).reason, /error: context length exceeded/);
	assert.equal((err as { retryable: boolean }).retryable, true);

	const exhausted = interpretBatchResponse({
		stopReason: "error",
		errorMessage: "429: Weekly/Monthly Limit Exhausted",
		content: [],
	});
	assert.equal(exhausted.status, "failed");
	assert.equal((exhausted as { retryable: boolean }).retryable, false);

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

test("interpretBatchResponse includes validated activation metadata without weakening coverage", () => {
	const withActivation = interpretBatchResponse(textResponse(JSON.stringify({
		processedSkills: ["a"],
		activation: { a: { kind: "workflow", tasks: ["software-change", "software-design"] } },
	})));
	assert.equal(withActivation.status, "ok");
	if (withActivation.status === "ok") {
		assert.deepEqual(withActivation.profile.activation, {
			a: { kind: "workflow", tasks: ["software-change", "software-design"] },
		});
		assert.deepEqual(withActivation.processedSkills, ["a"]);
	}
	assert.equal(interpretBatchResponse(textResponse(JSON.stringify({
		activation: { a: { kind: "workflow", tasks: ["software-change"] } },
	}))).status, "failed");
});

test("interpretBatchResponse rejects non-success stop reasons", () => {
	for (const stopReason of ["pending", "toolUse"] as const) {
		const outcome = interpretBatchResponse(textResponse('{"processedSkills":["a"]}', stopReason));
		assert.equal(outcome.status, "failed", stopReason);
		assert.equal((outcome as { retryable: boolean }).retryable, false, stopReason);
	}
});

test("batch exception retry classification treats cancellation as terminal", () => {
	const aborted = new Error("cancelled by caller");
	aborted.name = "AbortError";
	assert.equal(isRetryableBatchException(aborted), false);
	assert.equal(isRetryableBatchException(new Error("Request was aborted")), false);
	assert.equal(isRetryableBatchException(new Error("429: Weekly/Monthly Limit Exhausted")), false);
	assert.equal(isRetryableBatchException(new Error("temporary network failure")), true);
});

test("interpretBatchResponse requires explicit processedSkills even with profile content", () => {
	assert.equal(interpretBatchResponse(textResponse("{}")).status, "failed");
	assert.equal(interpretBatchResponse(textResponse('{"critical":["a"]}')).status, "failed");
	const covered = interpretBatchResponse(textResponse('{"processedSkills":["a"]}'));
	assert.equal(covered.status, "ok");
	assert.deepEqual((covered as { processedSkills?: string[] }).processedSkills, ["a"]);
});

test("interpretBatchResponse requires exact semantic-card coverage and host-binds hashes", () => {
	const batch = refs("alpha", "βeta");
	const tag = CATALOG_TAGS[0]!.id;
	const cards = Object.fromEntries(batch.map(({ name }) => [name, {
		summary: `${name} capability.`,
		tags: [tag],
	}]));
	const accepted = interpretBatchResponse(textResponse(JSON.stringify({
		processedSkills: batch.map(({ name }) => name),
		catalogCards: cards,
	})), batch);
	assert.equal(accepted.status, "ok");
	if (accepted.status === "ok") {
		assert.deepEqual(Object.keys(accepted.profile.catalog?.cards ?? {}).sort(), ["alpha", "βeta"]);
		assert.equal(accepted.profile.catalog?.cards.alpha?.sourceHash, hashSkill("alpha", "alpha desc"));
		assert.equal(accepted.profile.catalog?.cards["βeta"]?.sourceHash, hashSkill("βeta", "βeta desc"));
	}
	const prototypeBatch = refs("__proto__");
	const prototypeCards = Object.fromEntries([["__proto__", { summary: "Prototype-owned skill card.", tags: [tag] }]]);
	const prototypeOutcome = interpretBatchResponse(textResponse(JSON.stringify({
		processedSkills: ["__proto__"],
		catalogCards: prototypeCards,
	})), prototypeBatch);
	assert.equal(prototypeOutcome.status, "ok");
	if (prototypeOutcome.status === "ok") {
		assert.equal(Object.hasOwn(prototypeOutcome.profile.catalog!.cards, "__proto__"), true);
		assert.equal(prototypeOutcome.profile.catalog!.cards["__proto__"]?.sourceHash, hashSkill("__proto__", "__proto__ desc"));
	}

	const invalidOutputs = [
		{ processedSkills: ["alpha", "βeta"], catalogCards: { alpha: cards.alpha } }, // missing owner
		{ processedSkills: ["alpha", "βeta"], catalogCards: { ...cards, foreign: cards.alpha } }, // foreign owner
		{ processedSkills: ["alpha", "βeta"], catalogCards: { ...cards, alpha: { summary: "", tags: [tag] } } },
		{ processedSkills: ["alpha", "βeta"], catalogCards: { ...cards, alpha: { summary: "Too long.".repeat(40), tags: [tag] } } },
		{ processedSkills: ["alpha", "βeta"], catalogCards: { ...cards, alpha: { summary: "Unknown tag.", tags: ["invented-tag"] } } },
		{ processedSkills: ["alpha", "βeta"], catalogCards: { ...cards, alpha: { summary: "LLM hash.", tags: [tag], sourceHash: "f".repeat(64) } } },
	];
	for (const payload of invalidOutputs) {
		const outcome = interpretBatchResponse(textResponse(JSON.stringify(payload)), batch);
		assert.equal(outcome.status, "failed");
		if (outcome.status === "failed") assert.equal(outcome.retryable, true);
	}
});

const refs = (...names: string[]): SkillRef[] => names.map((name) => ({ name, description: `${name} desc` }));
const limits = (maxSkills: number) => ({ maxSkills, maxUtf8Bytes: 10_000 });
const generatedBatch = (batch: readonly SkillRef[], critical = batch.map((skill) => skill.name)) => ({
	profile: {
		...EMPTY_PROFILE,
		critical,
		catalog: {
			version: 1 as const,
			cards: Object.fromEntries(batch.map((skill) => [skill.name, {
				summary: `${skill.name} capability.`,
				tags: [CATALOG_TAGS[0]!.id],
				sourceHash: hashSkill(skill.name, skill.description),
			}])),
		},
	},
	processedSkills: batch.map((skill) => skill.name),
});

test("generateProfileInBatches batches by size and merges every successful batch", async () => {
	const seen: string[][] = [];
	const result = await generateProfileInBatches(refs("a", "b", "c", "d", "e"), limits(2), async (batch, i, total) => {
		assert.equal(total, 3); // ceil(5/2)
		seen.push(batch.map((s) => s.name));
		return generatedBatch(batch);
	});
	assert.ok(result);
	assert.deepEqual(seen, [["a", "b"], ["c", "d"], ["e"]]);
	assert.deepEqual([...result.applied].sort(), ["a", "b", "c", "d", "e"]);
	assert.deepEqual(result.partial.critical.sort(), ["a", "b", "c", "d", "e"]);
});

test("generateProfileInBatches keeps successes and marks a failed batch's skills unapplied", async () => {
	const result = await generateProfileInBatches(refs("a", "b", "c", "d"), limits(2), async (batch) => {
		if (batch.some((s) => s.name === "c")) return undefined; // 2nd batch (c,d) fails
		return generatedBatch(batch);
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
	assert.equal(attempts, 6, "invalid parent and both single-skill children remain rejected");
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
				...generatedBatch(batch),
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

test("generateProfileInBatches retries and never commits absent or source-mismatched catalog cards", async () => {
	let attempts = 0;
	const events: Array<{ type: string; reason?: string }> = [];
	const skills = refs("safe");
	const result = await generateProfileInBatches(
		skills,
		{ maxSkills: 1, maxUtf8Bytes: 1_000, maxAttempts: 2 },
		async (batch) => {
			attempts += 1;
			if (attempts === 1) return {
				profile: { ...EMPTY_PROFILE },
				processedSkills: batch.map((skill) => skill.name),
			};
			const generated = generatedBatch(batch);
			generated.profile.catalog.cards.safe!.sourceHash = "0".repeat(64);
			return generated;
		},
		async (event) => {
			if (event.type === "rejected") events.push({ type: event.type, reason: event.reason });
			else events.push({ type: event.type });
		},
	);
	assert.equal(result, undefined);
	assert.equal(attempts, 2);
	assert.deepEqual(events, [
		{ type: "rejected", reason: "incomplete catalog coverage" },
		{ type: "rejected", reason: "incomplete catalog coverage" },
	]);
});

test("generateProfileInBatches returns undefined only when every batch fails", async () => {
	const result = await generateProfileInBatches(refs("a", "b", "c"), limits(1), async () => undefined);
	assert.equal(result, undefined);
});

test("generateProfileInBatches does not retry a terminal batch failure", async () => {
	let attempts = 0;
	const result = await generateProfileInBatches(
		refs("a"),
		{ maxSkills: 1, maxUtf8Bytes: 1_000, maxAttempts: 3 },
		async () => {
			attempts += 1;
			return { status: "failed", reason: "aborted", retryable: false };
		},
	);
	assert.equal(result, undefined);
	assert.equal(attempts, 1);
});

test("generateProfileInBatches retries a transient batch failure", async () => {
	const attempts: number[] = [];
	const result = await generateProfileInBatches(
		refs("a"),
		{ maxSkills: 1, maxUtf8Bytes: 1_000, maxAttempts: 3 },
		async (batch, _index, _total, attempt) => {
			attempts.push(attempt);
			if (attempt === 1) return { status: "failed", reason: "provider unavailable", retryable: true };
			return generatedBatch(batch, ["a"]);
		},
	);
	assert.ok(result);
	assert.deepEqual(attempts, [1, 2]);
	assert.deepEqual([...result.applied], ["a"]);
});

test("generateProfileInBatches checkpoints each successful batch through onEvent", async () => {
	const events: Array<{ type: string; applied: string[]; names?: string[] }> = [];
	const result = await generateProfileInBatches(
		refs("a", "b", "c"),
		limits(1),
		async (batch) => generatedBatch(batch),
		async (event) => {
			if (event.type === "committed") {
				events.push({
					type: event.type,
					applied: [...event.applied],
					names: [...event.batchNames],
				});
			}
		},
	);
	assert.ok(result);
	assert.deepEqual(events, [
		{ type: "committed", applied: ["a"], names: ["a"] },
		{ type: "committed", applied: ["a", "b"], names: ["b"] },
		{ type: "committed", applied: ["a", "b", "c"], names: ["c"] },
	]);
	assert.deepEqual([...result.applied].sort(), ["a", "b", "c"]);
});

test("generateProfileInBatches reports incomplete coverage then accepts a complete retry", async () => {
	const events: Array<{ type: string; attempt?: number }> = [];
	const result = await generateProfileInBatches(
		refs("a", "b"),
		{ maxSkills: 2, maxUtf8Bytes: 1_000, maxAttempts: 2 },
		async (batch, _index, _total, attempt) => ({
			...generatedBatch(batch),
			processedSkills: attempt === 1 ? ["a"] : batch.map((skill) => skill.name),
		}),
		async (event) => {
			events.push(event.type === "rejected"
				? { type: event.type, attempt: event.attempt }
				: { type: event.type });
		},
	);
	assert.ok(result);
	assert.deepEqual(events, [
		{ type: "rejected", attempt: 1 },
		{ type: "committed" },
	]);
});

test("init retries receive validation feedback and split batches preserve every full source", async () => {
	const skills = refs("a", "b", "c", "d");
	skills[0]!.description = "Full source with unicode 日本語 and escaping ".repeat(200);
	const calls: Array<{ names: string[]; label: string; feedback?: string }> = [];
	const checkpoints: string[][] = [];
	const events: Array<{ willRetry: boolean; willSplit: boolean }> = [];
	const result = await generateProfileInBatches(
		skills,
		{ maxSkills: 4, maxUtf8Bytes: 100_000, maxAttempts: 2, maxRecoveryCalls: 8 },
		async (batch, _index, _total, _attempt, context) => {
			for (const skill of batch) assert.equal(skill.description, skills.find(({ name }) => name === skill.name)!.description);
			calls.push({ names: batch.map(({ name }) => name), label: context.label, feedback: context.previousFailure });
			if (batch.length > 2) return { status: "failed", reason: "missing catalogCards for d", retryable: true, splittable: true };
			return generatedBatch(batch);
		},
		(event) => {
			if (event.type === "committed") checkpoints.push([...event.applied]);
			else events.push({ willRetry: event.willRetry, willSplit: event.willSplit });
		},
	);
	assert.ok(result);
	assert.deepEqual([...result.applied], ["a", "b", "c", "d"]);
	assert.deepEqual(calls.map(({ names }) => names), [["a", "b", "c", "d"], ["a", "b", "c", "d"], ["a", "b"], ["c", "d"]]);
	assert.deepEqual(calls.map(({ label }) => label), ["1/1", "1/1", "1/1.1", "1/1.2"]);
	assert.equal(calls[0]!.feedback, undefined);
	assert.ok(calls.slice(1).every(({ feedback }) => feedback === "missing catalogCards for d"));
	assert.deepEqual(checkpoints, [["a", "b"], ["a", "b", "c", "d"]]);
	assert.deepEqual(events, [{ willRetry: true, willSplit: false }, { willRetry: false, willSplit: true }]);
});

test("adaptive recovery isolates an invalid skill without accepting any failed batch", async () => {
	const committed: string[][] = [];
	const result = await generateProfileInBatches(
		refs("a", "bad", "c", "d"),
		{ maxSkills: 4, maxUtf8Bytes: 1_000, maxAttempts: 2, maxRecoveryCalls: 8 },
		async (batch) => batch.some(({ name }) => name === "bad")
			? { status: "failed", reason: "invalid card for bad", retryable: true, splittable: true }
			: generatedBatch(batch),
		(event) => { if (event.type === "committed") committed.push([...event.batchNames]); },
	);
	assert.ok(result);
	assert.deepEqual([...result.applied], ["a", "c", "d"]);
	assert.deepEqual(Object.keys(result.partial.catalog!.cards).sort(), ["a", "c", "d"]);
	assert.deepEqual(committed, [["a"], ["c", "d"]]);
});

test("adaptive recovery has a per-root call budget and preserves attempts for later roots", async () => {
	const counts = new Map<number, number>();
	const events: Array<{ willRetry: boolean; willSplit: boolean }> = [];
	const result = await generateProfileInBatches(
		Array.from({ length: 40 }, (_, i) => ({ name: `s${i}`, description: `Full source ${i}` })),
		{ maxSkills: 20, maxUtf8Bytes: 10_000, maxAttempts: 2, maxRecoveryCalls: 8 },
		async (_batch, index) => {
			counts.set(index, (counts.get(index) ?? 0) + 1);
			return { status: "failed", reason: "invalid response", retryable: true, splittable: true };
		},
		(event) => { if (event.type === "rejected") events.push(event); },
	);
	assert.equal(result, undefined);
	assert.deepEqual([...counts], [[0, 10], [1, 10]]);
	assert.deepEqual(events.at(-1) && { willRetry: events.at(-1)!.willRetry, willSplit: events.at(-1)!.willSplit }, { willRetry: false, willSplit: false });
});

test("provider failures retry without splitting or feeding provider details to the model", async () => {
	const seen: number[] = [];
	const result = await generateProfileInBatches(
		refs("a", "b", "c", "d"), limits(4),
		async (batch, _index, _total, _attempt, context) => {
			seen.push(batch.length);
			assert.equal(context.previousFailure, undefined);
			return { status: "failed", reason: "provider network error", retryable: true };
		},
	);
	assert.equal(result, undefined);
	assert.deepEqual(seen, [4, 4]);
});

test("terminal failures stop every later root while keeping committed work", async () => {
	for (const reason of ["aborted", "quota exhausted"]) {
		const seen: string[] = [];
		const result = await generateProfileInBatches(refs("a", "b", "c"), limits(1), async (batch) => {
			seen.push(batch[0]!.name);
			return batch[0]!.name === "b" ? { status: "failed", reason, retryable: false } : generatedBatch(batch);
		});
		assert.deepEqual(seen, ["a", "b"]);
		assert.deepEqual([...(result?.applied ?? [])], ["a"]);
	}
});

test("terminal failure in a split stops its sibling and later roots", async () => {
	const seen: string[][] = [];
	const result = await generateProfileInBatches(refs("a", "b", "c", "d", "e"), limits(4), async (batch) => {
		seen.push(batch.map(({ name }) => name));
		return batch.length > 2
			? { status: "failed", reason: "invalid response", retryable: true, splittable: true }
			: { status: "failed", reason: "aborted", retryable: false };
	});
	assert.equal(result, undefined);
	assert.deepEqual(seen, [["a", "b", "c", "d"], ["a", "b", "c", "d"], ["a", "b"]]);
});

test("retry feedback is bounded JSON data and never changes source descriptions", () => {
	const skills = refs("a");
	const reason = 'invalid "summary"\n' + "x".repeat(10_000);
	const body = JSON.parse(serializeSkillBatch(skills, reason));
	assert.deepEqual(body.skills, skills);
	assert.equal(typeof body.retryFeedback, "string");
	assert.ok(body.retryFeedback.length <= 600);
	assert.match(body.retryFeedback, /^invalid "summary"/);
	assert.equal(Object.hasOwn(JSON.parse(serializeSkillBatch(skills)), "retryFeedback"), false);
});
