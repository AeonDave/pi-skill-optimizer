import assert from "node:assert/strict";
import { test } from "node:test";
import { computeFinalHashes, diffSkills, hashSkill, mergeIncrementalProfile, mergeProfiles, normalizeProfile, pruneProfileNames, splitProfileByScope } from "../src/profile.ts";
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

test("normalizeProfile does not reinterpret structured fields as legacy aliases", () => {
	const profile = normalizeProfile({ critical: ["test-driven-development"] });
	assert.deepEqual(profile.aliases, {});
	assert.deepEqual(profile.critical, ["test-driven-development"]);
});

test("mergeProfiles unions aliases, critical, and name-keyed records (project extends global)", () => {
	const global = normalizeProfile({
		aliases: { apk: ["android"] },
		critical: ["test-driven-development"],
		queries: { hashcat: ["crack ntlm"] },
		clusters: { crypto: ["openssl"] },
		negativeHints: { tcpdump: ["python tests"] },
	});
	const project = normalizeProfile({
		aliases: { apk: ["mobile"], deploy: ["release"] },
		critical: ["my-project-skill"],
		queries: { "my-project-skill": ["run the project pipeline"] },
		clusters: { crypto: ["rsactftool"] },
	});
	const merged = mergeProfiles(global, project);
	assert.deepEqual(merged.aliases.apk.sort(), ["android", "mobile"]);
	assert.deepEqual(merged.aliases.deploy, ["release"]);
	assert.deepEqual(merged.critical.sort(), ["my-project-skill", "test-driven-development"]);
	assert.deepEqual(merged.queries["my-project-skill"], ["run the project pipeline"]);
	assert.deepEqual(merged.clusters.crypto.sort(), ["openssl", "rsactftool"]);
});

test("splitProfileByScope routes project-skill entries to the project slice, keeps aliases global", () => {
	const profile = normalizeProfile({
		aliases: { apk: ["android"] },
		critical: ["test-driven-development", "my-project-skill"],
		queries: { hashcat: ["crack ntlm"], "my-project-skill": ["deploy demo"] },
		clusters: { mix: ["hashcat", "my-project-skill"] },
		negativeHints: { "my-project-skill": ["unrelated"] },
	});
	const { global, project } = splitProfileByScope(profile, new Set(["my-project-skill"]));

	assert.deepEqual(global.aliases.apk, ["android"]);
	assert.deepEqual(global.critical, ["test-driven-development"]);
	assert.ok("hashcat" in global.queries);
	assert.ok(!("my-project-skill" in global.queries));
	assert.deepEqual(global.clusters.mix, ["hashcat"]);

	assert.deepEqual(project.aliases, {});
	assert.deepEqual(project.critical, ["my-project-skill"]);
	assert.deepEqual(project.queries["my-project-skill"], ["deploy demo"]);
	assert.deepEqual(project.clusters.mix, ["my-project-skill"]);
	assert.deepEqual(project.negativeHints["my-project-skill"], ["unrelated"]);
});

test("splitProfileByScope preserves global skills referenced only by clusters", () => {
	const profile = normalizeProfile({ clusters: { crypto: ["openssl", "project-crypto"] } });
	const { global, project } = splitProfileByScope(profile, new Set(["project-crypto"]));
	assert.deepEqual(global.clusters.crypto, ["openssl"]);
	assert.deepEqual(project.clusters.crypto, ["project-crypto"]);
});

test("hashSkill is stable for same input and changes when description changes", () => {
	const a = hashSkill("rsactftool", "RSA recovery tool.");
	assert.equal(a, hashSkill("rsactftool", "RSA recovery tool."));
	assert.notEqual(a, hashSkill("rsactftool", "RSA recovery tool. Updated."));
});

test("diffSkills detects new, modified, and removed skills", () => {
	const stored = {
		rsactftool: hashSkill("rsactftool", "RSA recovery tool."),
		hashcat: hashSkill("hashcat", "GPU cracking."),
	};
	const current = [
		{ name: "rsactftool", description: "RSA recovery tool." }, // unchanged
		{ name: "hashcat", description: "GPU cracking. Now with more formats." }, // modified
		{ name: "nmap", description: "Port scanner." }, // new
	];
	const { changed, removed, hashes } = diffSkills(current, stored);
	assert.deepEqual(changed.sort(), ["hashcat", "nmap"]);
	assert.deepEqual(removed, []);
	assert.equal(Object.keys(hashes).length, 3);

	// dropping hashcat from the catalog marks it removed
	const { removed: removed2 } = diffSkills([{ name: "rsactftool", description: "RSA recovery tool." }], stored);
	assert.deepEqual(removed2, ["hashcat"]);
});

test("computeFinalHashes drops failed skills so they re-run, keeps the rest, and no-ops on empty", () => {
	const hashes = { a: "h1", b: "h2", c: "h3" };
	const pruned = computeFinalHashes(hashes, ["b"]);
	assert.deepEqual(pruned, { a: "h1", c: "h3" });
	assert.ok(!("b" in pruned)); // next diffSkills sees 'b' as changed -> retried
	assert.equal(computeFinalHashes(hashes, []), hashes); // same ref when nothing failed
	assert.deepEqual(computeFinalHashes(hashes, ["x", "y"]), hashes); // unknown names are ignored
});

test("pruneProfileNames strips removed skills from critical, queries, clusters, hints", () => {
	const profile = normalizeProfile({
		aliases: { apk: ["android"] },
		critical: ["a", "b"],
		queries: { a: ["qa"], b: ["qb"] },
		clusters: { topic: ["a", "b"] },
		negativeHints: { b: ["nb"] },
	});
	const out = pruneProfileNames(profile, ["b"]);
	assert.deepEqual(out.critical, ["a"]);
	assert.ok(!("b" in out.queries));
	assert.deepEqual(out.clusters.topic, ["a"]);
	assert.ok(!("b" in out.negativeHints));
	assert.deepEqual(out.aliases.apk, ["android"]); // aliases left (runtime-filtered)
});

test("mergeIncrementalProfile replaces changed skills and keeps the rest", () => {
	const base = normalizeProfile({
		critical: ["keep", "was"],
		queries: { keep: ["old keep"], was: ["old was"] },
		clusters: { old: ["keep", "was"] },
		negativeHints: { was: ["old hint"] },
	});
	const partial = normalizeProfile({
		critical: [], // 'was' is changed and the model no longer marks it critical
		queries: { was: ["new was"], unexpected: ["must not leak"] },
		clusters: { fresh: ["was"], unexpected: ["other"] },
		negativeHints: { unexpected: ["must not leak"] },
	});
	const out = mergeIncrementalProfile(base, partial, ["was"]);
	assert.deepEqual(out.queries.keep, ["old keep"]); // unchanged kept
	assert.deepEqual(out.queries.was, ["new was"]); // changed replaced
	assert.ok(out.critical.includes("keep")); // unchanged critical kept
	assert.ok(!out.critical.includes("was")); // changed skill demoted per partial
	assert.ok(!("was" in out.negativeHints)); // changed skill's stale hint dropped (none in partial)
	assert.deepEqual(out.clusters.old, ["keep"]); // stale membership for changed skill removed
	assert.deepEqual(out.clusters.fresh, ["was"]); // replacement membership accepted
	assert.ok(!("unexpected" in out.queries));
	assert.ok(!("unexpected" in out.clusters));
	assert.ok(!("unexpected" in out.negativeHints));
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
