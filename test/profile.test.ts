import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeProfile } from "../src/profile.ts";
import { normalizeUsageFile, recordSkillUsage, selectPinnedSkills, selectUsageRecordSkills, toUsageFile, usageRecordSignature } from "../src/usage.ts";

test("normalizeProfile accepts enhanced init output and drops malformed fields", () => {
	const profile = normalizeProfile({
		aliases: { APK: ["Android app", "mobile"], bad: [1, ""] },
		critical: ["hashcat", "hashcat", ""],
		queries: { hashcat: ["crack ntlm", "offline password recovery"], bad: [1, ""] },
		clusters: { crypto: ["rsactftool", "openssl"] },
		negativeHints: { tcpdump: ["python tests"] },
	});
	assert.deepEqual(profile.aliases.apk, ["android", "app", "mobile"]);
	assert.deepEqual(profile.critical, ["hashcat"]);
	assert.deepEqual(profile.queries.hashcat, ["crack ntlm", "offline password recovery"]);
	assert.deepEqual(profile.clusters.crypto, ["rsactftool", "openssl"]);
	assert.deepEqual(profile.negativeHints.tcpdump, ["python tests"]);
});

test("usage stats record and select pinned skills by frequency plus recency", () => {
	let stats = normalizeUsageFile(undefined);
	stats = recordSkillUsage(stats, ["hashcat", "rsactftool"], 1_000_000);
	stats = recordSkillUsage(stats, ["hashcat"], 2_000_000);
	assert.equal(stats.hashcat.count, 2);
	assert.equal(stats.rsactftool.count, 1);
	const file = toUsageFile(stats, 2_000_000);
	assert.equal(file.version, 1);
	assert.deepEqual(normalizeUsageFile(file), stats);
	assert.deepEqual(selectPinnedSkills(stats, 1, 2_000_000), ["hashcat"]);
});

test("usage recording keeps only explicit mentions or real skill tool uses", () => {
	const selected = ["source-review-technique", "test-driven-development", "ctx-search"];
	const messages = [
		{
			role: "user",
			content: "Use source-review-technique for this review.",
		},
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					name: "Skill",
					input: { skill: "test-driven-development" },
				},
			],
		},
	];
	assert.deepEqual(selectUsageRecordSkills(messages, selected), ["source-review-technique", "test-driven-development"]);
});

test("usage recording ignores merely ranked skills", () => {
	const selected = ["source-review-technique", "test-driven-development", "ctx-search"];
	const messages = [{ role: "user", content: "Review this TypeScript code for security issues." }];
	assert.deepEqual(selectUsageRecordSkills(messages, selected), []);
});

test("usage recording ignores injected context-mode messages", () => {
	const selected = ["context-mode", "source-review-technique"];
	const messages = [
		{ role: "user", content: "Use source-review-technique for this review." },
		{ role: "user", content: "context-mode active. Hierarchy: ctx_batch_execute > ctx_execute." },
	];
	assert.deepEqual(selectUsageRecordSkills(messages, selected), ["source-review-technique"]);
});

test("usage signatures are stable across repeated tool-loop requests", () => {
	const selected = ["source-review-technique", "test-driven-development"];
	const first = [{ role: "user", content: "Use source-review-technique and test-driven-development." }];
	const later = [
		...first,
		{ role: "assistant", content: [{ type: "tool_use", name: "Read", input: { path: "src/skills.ts" } }] },
		{ role: "user", content: [{ type: "tool_result", content: "file contents" }] },
	];
	assert.equal(usageRecordSignature(first, selected), usageRecordSignature(later, selected));
});
