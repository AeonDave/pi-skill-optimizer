import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildUsagePrior,
	collectSkillUsageEvidence,
	mergeUsageStats,
	normalizeUsageFile,
	pruneUsageStats,
	recordSkillUsage,
	scoreSkillUsage,
	selectUsageRecordSkills,
	usageRecordSignature,
} from "../src/usage.ts";

test("usage records preserve prototype-colliding skill names without inherited counts", () => {
	const names = ["constructor", "toString", "__proto__"];
	const first = recordSkillUsage({}, names, 100);
	for (const name of names) {
		assert.ok(Object.hasOwn(first, name), `${name} must be an own record`);
		assert.deepEqual(first[name], { count: 1, lastUsed: 100 });
	}
	assert.equal(Object.getPrototypeOf(first), Object.prototype);
	const merged = mergeUsageStats({}, first);
	assert.deepEqual(merged, first);
	assert.deepEqual(recordSkillUsage(merged, names, 200), Object.fromEntries(
		names.map((name) => [name, { count: 2, lastUsed: 200 }]),
	));
	const restored = normalizeUsageFile(JSON.parse(JSON.stringify({ skills: merged })));
	assert.deepEqual(restored, merged);
	assert.equal(Object.getPrototypeOf(restored), Object.prototype);
});

test("usage evidence is stable across provider loops and distinct per event", () => {
	const messages = [
		{ id: "user-1", role: "user", content: [{ type: "text", text: "use /skill:alpha" }] },
		{
			id: "assistant-1",
			role: "assistant",
			content: [{ id: "tool-1", type: "tool_use", name: "activate_skill", input: { skillName: "alpha" } }],
		},
	];
	const payload = { messages };
	const first = collectSkillUsageEvidence(payload, ["alpha"]);
	assert.deepEqual(collectSkillUsageEvidence(payload, ["alpha"]), first);
	assert.deepEqual(collectSkillUsageEvidence(messages, ["alpha"]), first);
	assert.equal(first.length, 2);
	assert.equal(new Set(first.map((entry) => entry.key)).size, 2);
	assert.deepEqual(selectUsageRecordSkills(payload, ["alpha", "beta"]), ["alpha"]);
	assert.equal(usageRecordSignature(payload, ["alpha"]), usageRecordSignature(payload, ["alpha"]));
});

test("usage evidence recognizes native Pi skill activations, not catalog text, notices, acknowledgments, or searches", () => {
	const evidence = collectSkillUsageEvidence({ messages: [
		{ id: "system-1", role: "system", content: "Critical skill catalog: alpha; beta. These are metadata only." },
		{ id: "user-1", role: "user", content: "Continue the current task." },
		{ id: "check-in", role: "custom", customType: "pi-persona", content: "Use /skill:beta and review nuclei." },
		{ id: "assistant-text", role: "assistant", content: "Both alpha and beta are already loaded." },
		{
			id: "assistant-1",
			role: "assistant",
			content: [
				{ type: "toolCall", id: "load-alpha", name: "skill_search", arguments: { action: "load", name: "alpha" } },
				{ type: "toolCall", id: "search-beta", name: "skill_search", arguments: { action: "search", query: "beta" } },
				{ type: "toolCall", id: "activate-alpha", name: "activate_skill", arguments: { skillName: "alpha" } },
				{ type: "toolCall", id: "activate-beta", name: "activate_skill", arguments: { skillName: "beta" } },
			],
		},
	] }, ["alpha", "beta"]);

	assert.deepEqual(evidence.map((entry) => entry.name), ["alpha", "beta"]);
	assert.deepEqual(evidence.map((entry) => entry.key), [
		"tool:id:activate-alpha:alpha",
		"tool:id:activate-beta:beta",
	]);
});

test("distinct source IDs count identical user evidence as distinct events", () => {
	const payload = {
		messages: [
			{ id: "user-1", role: "user", content: "use /skill:alpha" },
			{ id: "user-2", role: "user", content: "use /skill:alpha" },
		],
	};
	const evidence = collectSkillUsageEvidence(payload, ["alpha"]);
	assert.equal(evidence.length, 2);
	assert.notEqual(evidence[0].key, evidence[1].key);
});

test("an identical provider loop produces the same evidence keys", () => {
	const payload = {
		messages: [
			{ id: "user-1", role: "user", content: "use /skill:alpha" },
			{
				role: "assistant",
				content: [{ id: "tool-1", type: "tool_use", name: "activate_skill", input: { skill: "alpha" } }],
			},
		],
	};
	const first = collectSkillUsageEvidence(payload, ["alpha"]);
	const repeated = collectSkillUsageEvidence(payload, ["alpha"]);
	assert.deepEqual(repeated, first);
	assert.equal(new Set([...first, ...repeated].map((entry) => entry.key)).size, first.length);
});

test("ID-less evidence uses a deterministic index and content hash fallback", () => {
	const payload = { messages: [{ role: "user", content: "use /skill:alpha" }] };
	const first = collectSkillUsageEvidence(payload, ["alpha"]);
	const repeated = collectSkillUsageEvidence(payload, ["alpha"]);
	assert.deepEqual(repeated, first);
	assert.match(first[0].key, /^user:index:0:[a-z0-9]+:alpha$/);
});

test("usage evidence ignores injected context and distinguishes later messages", () => {
	const messages = [
		{ id: "context", role: "user", content: "context-mode active. /skill:alpha" },
		{ id: "user-1", role: "user", content: "use /skill:alpha" },
		{ id: "user-2", role: "user", content: "use /skill:alpha again" },
	];
	const evidence = collectSkillUsageEvidence({ messages }, ["alpha"]);
	assert.equal(evidence.length, 2);
	assert.notEqual(evidence[0].key, evidence[1].key);
});

test("a bounded evidence set suppresses loops without unbounded growth", () => {
	const seen = new Set<string>();
	const limit = 2;
	for (const id of ["one", "two", "three"]) {
		const [entry] = collectSkillUsageEvidence({ messages: [{ id, role: "user", content: "/skill:alpha" }] }, ["alpha"]);
		seen.add(entry.key);
		while (seen.size > limit) seen.delete(seen.values().next().value!);
	}
	assert.equal(seen.size, limit);
});

test("usage evidence reads user text from OpenAI Responses and Gemini payloads", () => {
	const openai = collectSkillUsageEvidence({ input: [{ role: "user", content: [{ type: "input_text", text: "use /skill:alpha" }] }] }, ["alpha"]);
	const gemini = collectSkillUsageEvidence({ contents: [{ role: "user", parts: [{ text: "use /skill:alpha" }] }] }, ["alpha"]);
	assert.deepEqual(openai.map((entry) => entry.name), ["alpha"]);
	assert.deepEqual(gemini.map((entry) => entry.name), ["alpha"]);
});

test("mergeUsageStats adds deltas and keeps the newest timestamp", () => {
	assert.deepEqual(
		mergeUsageStats(
			{ alpha: { count: 3, lastUsed: 100 }, beta: { count: 1, lastUsed: 200 } },
			{ alpha: { count: 2, lastUsed: 300 }, gamma: { count: 1, lastUsed: 50 } },
		),
		{
			alpha: { count: 5, lastUsed: 300 },
			beta: { count: 1, lastUsed: 200 },
			gamma: { count: 1, lastUsed: 50 },
		},
	);
});

test("usage pruning removes only stale one-off entries and protects named skills", () => {
	const day = 86_400_000;
	const now = 300 * day;
	const stats = {
		staleOnce: { count: 1, lastUsed: day },
		staleFrequent: { count: 2, lastUsed: day },
		critical: { count: 1, lastUsed: day },
		recent: { count: 1, lastUsed: 299 * day },
	};
	assert.deepEqual(pruneUsageStats(stats, { now, staleDays: 180, maxEntries: 100, protectedNames: ["critical"] }), {
		staleFrequent: stats.staleFrequent,
		critical: stats.critical,
		recent: stats.recent,
	});
});

test("usage cap is deterministic and never drops protected entries", () => {
	const stats = {
		protectedA: { count: 1, lastUsed: 1 },
		protectedB: { count: 1, lastUsed: 1 },
		frequent: { count: 10, lastUsed: 10 },
		recent: { count: 2, lastUsed: 100 },
		weak: { count: 1, lastUsed: 50 },
	};
	const options = { maxEntries: 3, staleDays: 0, protectedNames: ["protectedA", "protectedB"] };
	const first = pruneUsageStats(stats, options);
	assert.deepEqual(Object.keys(first), ["protectedA", "protectedB", "frequent"]);
	assert.deepEqual(pruneUsageStats(stats, options), first);
	assert.equal(pruneUsageStats(first, options), first);
});

test("usage prior decays exponentially instead of creating permanent pins", () => {
	const day = 86_400_000;
	const now = 120 * day;
	const recent = scoreSkillUsage({ count: 2, lastUsed: 119 * day }, now, 30);
	const stale = scoreSkillUsage({ count: 100, lastUsed: 20 * day }, now, 30);
	assert.ok(recent > stale);
	const prior = buildUsagePrior({
		recent: { count: 2, lastUsed: 119 * day },
		stale: { count: 100, lastUsed: 20 * day },
	}, { now, halfLifeDays: 30 });
	assert.ok(prior.recent > prior.stale);
});

test("buildUsagePrior is deterministic and can discard negligible evidence", () => {
	const stats = {
		beta: { count: 1, lastUsed: 1 },
		alpha: { count: 1, lastUsed: 1 },
	};
	assert.deepEqual(Object.keys(buildUsagePrior(stats, { now: 1 })), ["alpha", "beta"]);
	assert.deepEqual(buildUsagePrior(stats, { now: 365 * 86_400_000, minimumScore: 0.01 }), {});
});

test("usage evidence rejects every shared injected-context prefix, not only context-mode", async () => {
	const { INJECTED_CONTEXT_PREFIXES } = await import("../src/request.ts");
	assert.equal(INJECTED_CONTEXT_PREFIXES.length, 5);
	const messages: Array<Record<string, unknown>> = [];
	for (const prefix of INJECTED_CONTEXT_PREFIXES) {
		messages.push({ id: `injected-${prefix}`, role: "user", content: `${prefix} /skill:alpha` });
	}
	messages.push({ id: "human", role: "user", content: "use /skill:alpha" });

	const evidence = collectSkillUsageEvidence({ messages }, ["alpha"]);
	assert.deepEqual(evidence.map((entry) => entry.key), ["user:id:human:alpha"]);
	assert.deepEqual(evidence.map((entry) => entry.name), ["alpha"]);

	// Each persona/clock block alone must stay invisible to usage evidence.
	for (const message of messages.slice(0, -1)) {
		assert.deepEqual(
			collectSkillUsageEvidence({ messages: [message] }, ["alpha"]),
			[],
			`injected block must not become evidence: ${String(message.content)}`,
		);
	}
	// A control proves the fixture is not vacuous.
	assert.deepEqual(
		collectSkillUsageEvidence({ messages: [{ id: "human", role: "user", content: "use /skill:alpha" }] }, ["alpha"])
			.map((entry) => entry.name),
		["alpha"],
	);
});

test("token mention scan is exactly equivalent to the boundary matcher", () => {
	const boundary = (name: string): RegExp => {
		const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(^|[^a-z0-9:_-])(?:/skill:|/)?${escaped}($|[^a-z0-9:_-])`);
	};
	const skills = ["alpha", "beta", "skill:alpha", "c++", "digital", "a b"];
	const texts = [
		"use /skill:alpha",
		"/skill:alpha",
		"//skill:alpha",
		"x/skill:alpha",
		"x /skill:alpha",
		"skill:alpha",
		"x skill:alpha",
		"fooskill:alpha",
		"alpha",
		"alphabeta",
		"beta alpha",
		"use alpha.",
		"alpha_",
		"beta_alpha",
		"ALPHA",
		"digit alpha",
		"use c++ and stay",
		"c++",
		"xc++",
		"an a b here",
		"an ab here",
		"",
	];
	for (const text of texts) {
		const expected = skills.filter((name) => boundary(name).test(text.toLowerCase())).sort();
		const actual = collectSkillUsageEvidence({ messages: [{ id: "m", role: "user", content: text }] }, skills)
			.map((entry) => entry.name)
			.sort();
		assert.deepEqual(actual, expected, `mention parity failed for ${JSON.stringify(text)}`);
	}
});

test("user-message evidence scan is bounded to the most recent window", async () => {
	const { MAX_USAGE_SCAN_MESSAGES } = await import("../src/usage.ts");
	assert.ok(MAX_USAGE_SCAN_MESSAGES > 0 && MAX_USAGE_SCAN_MESSAGES < 1_000);
	const total = MAX_USAGE_SCAN_MESSAGES + 40;
	const messages = Array.from({ length: total }, (_, index) => ({
		id: `user-${index}`,
		role: "user",
		content: "use /skill:alpha",
	}));
	const keys = collectSkillUsageEvidence({ messages }, ["alpha"]).map((entry) => entry.key);
	assert.equal(keys.length, MAX_USAGE_SCAN_MESSAGES);
	assert.ok(!keys.includes("user:id:user-0:alpha"), "the oldest turns fall outside the window");
	assert.ok(keys.includes(`user:id:user-${total - 1}:alpha`), "the newest turns stay visible");
	assert.equal(new Set(keys).size, keys.length);
});
