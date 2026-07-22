import assert from "node:assert/strict";
import { test } from "node:test";
import {
	collectSkillUsageEvidence,
	mergeUsageStats,
	pruneUsageStats,
	selectUsageRecordSkills,
	usageRecordSignature,
} from "../src/usage.ts";

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
