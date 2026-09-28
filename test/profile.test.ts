import assert from "node:assert/strict";
import { test } from "node:test";
import { needsProfileScopeRepair } from "../src/init-profile.ts";
import {
	computeFinalHashes,
	diffSkills,
	hashSkill,
	mergeIncrementalProfile,
	mergeProfiles,
	normalizeProfile,
	pruneProfileNames,
	splitProfileByScope,
} from "../src/profile.ts";

test("normalizeProfile keeps only name-owned routing fields and ignores legacy aliases", () => {
	const profile = normalizeProfile({
		aliases: { apk: ["android"] },
		critical: [" alpha ", "alpha", 42],
		queries: { alpha: [" deploy it ", "deploy it"], empty: [], bad: "x" },
		clusters: { release: ["alpha", " beta "] },
		negativeHints: { beta: [" unrelated "] },
	});
	assert.deepEqual(profile, {
		critical: ["alpha"],
		queries: { alpha: ["deploy it"] },
		clusters: { release: ["alpha", "beta"] },
		negativeHints: { beta: ["unrelated"] },
	});
	assert.ok(!("aliases" in profile));
	assert.deepEqual(normalizeProfile({ critical: ["critical"] }).critical, ["critical"]);
	assert.ok(!("activation" in normalizeProfile({ critical: ["critical"] })));
});

test("normalizeProfile retains only valid owner-keyed skill activation metadata", () => {
	const profile = normalizeProfile({
		activation: {
			" primary ": { kind: "specialist", tasks: [" software-change ", "software-change", "software-test", 42] },
			invalid: { kind: "unknown", tasks: ["software-change"] },
			badTasks: { kind: "workflow", tasks: "software-change" },
			empty: { kind: "behavioral", tasks: [] },
		},
	});
	assert.deepEqual(profile.activation, {
		primary: { kind: "specialist", tasks: ["software-change", "software-test"] },
	});
});

test("hashSkill is an unambiguous SHA-256 content fingerprint", () => {
	const hash = hashSkill("alpha", "description");
	assert.match(hash, /^[a-f0-9]{64}$/);
	assert.notEqual(hash, hashSkill("alpha", "description changed"));
	assert.notEqual(hashSkill("ab", "c"), hashSkill("a", "bc"));
});

test("diffSkills finds modifications, additions, and removals", () => {
	const stored = {
		alpha: hashSkill("alpha", "old"),
		removed: hashSkill("removed", "gone"),
	};
	const result = diffSkills([
		{ name: "alpha", description: "new" },
		{ name: "beta", description: "added" },
	], stored);
	assert.deepEqual(result.changed, ["alpha", "beta"]);
	assert.deepEqual(result.removed, ["removed"]);
	assert.deepEqual(Object.keys(result.hashes), ["alpha", "beta"]);
});

test("computeFinalHashes removes only failed current skills and preserves identity otherwise", () => {
	const hashes = { alpha: "a", beta: "b" };
	assert.deepEqual(computeFinalHashes(hashes, ["beta"]), { alpha: "a" });
	assert.equal(computeFinalHashes(hashes, []), hashes);
	assert.equal(computeFinalHashes(hashes, ["unknown"]), hashes);
});

test("pruneProfileNames removes every reference and drops empty clusters", () => {
	const profile = normalizeProfile({
		critical: ["alpha", "beta"],
		queries: { alpha: ["a"], beta: ["b"] },
		clusters: { mixed: ["alpha", "beta"], alpha_only: ["alpha"] },
		negativeHints: { alpha: ["x"], beta: ["y"] },
	});
	const result = pruneProfileNames(profile, ["alpha"]);
	assert.deepEqual(result, {
		critical: ["beta"],
		queries: { beta: ["b"] },
		clusters: { mixed: ["beta"] },
		negativeHints: { beta: ["y"] },
	});
	assert.equal(pruneProfileNames(result, []), result);
});

test("pruneProfileNames removes activation records by owner without treating tasks as names", () => {
	const profile = normalizeProfile({
		activation: {
			owner: { kind: "specialist", tasks: ["software-change", "software-review"] },
			removedOwner: { kind: "workflow", tasks: ["software-design"] },
		},
	});
	assert.deepEqual(pruneProfileNames(profile, ["software-change", "removedOwner"]), {
		critical: [], queries: {}, clusters: {}, negativeHints: {},
		activation: { owner: { kind: "specialist", tasks: ["software-change", "software-review"] } },
	});
	assert.equal(pruneProfileNames(profile, ["owner", "removedOwner"]).activation, undefined);
});

test("mergeIncrementalProfile replaces refreshed ownership and ignores batch leakage", () => {
	const base = normalizeProfile({
		critical: ["keep", "changed"],
		queries: { keep: ["old keep"], changed: ["old changed"] },
		clusters: { old: ["keep", "changed"] },
		negativeHints: { keep: ["keep hint"], changed: ["old hint"] },
	});
	const partial = normalizeProfile({
		critical: ["changed", "leaked"],
		queries: { changed: ["new changed"], leaked: ["must not appear"] },
		clusters: { fresh: ["changed", "leaked"] },
		negativeHints: { changed: ["new hint"], leaked: ["must not appear"] },
	});
	const result = mergeIncrementalProfile(base, partial, ["changed"]);
	assert.deepEqual(result, {
		critical: ["keep", "changed"],
		queries: { keep: ["old keep"], changed: ["new changed"] },
		clusters: { old: ["keep"], fresh: ["changed"] },
		negativeHints: { keep: ["keep hint"], changed: ["new hint"] },
	});
	assert.equal(mergeIncrementalProfile(base, partial, []), base);
});

test("mergeIncrementalProfile replaces complete activation metadata for refreshed owners only", () => {
	const base = normalizeProfile({
		activation: {
			refreshed: { kind: "specialist", tasks: ["software-change"] },
			otherOwner: { kind: "workflow", tasks: ["software-design"] },
		},
	});
	const partial = normalizeProfile({
		activation: {
			refreshed: { kind: "behavioral", tasks: ["software-review"] },
			otherOwner: { kind: "specialist", tasks: ["software-test"] },
			foreignOwner: { kind: "workflow", tasks: ["software-change"] },
		},
	});
	assert.deepEqual(mergeIncrementalProfile(base, partial, ["refreshed"]).activation, {
		otherOwner: { kind: "workflow", tasks: ["software-design"] },
		refreshed: { kind: "behavioral", tasks: ["software-review"] },
	});
});

test("mergeProfiles unions global and project routing evidence deterministically", () => {
	const base = normalizeProfile({
		critical: ["alpha"],
		queries: { alpha: ["one"] },
		clusters: { family: ["alpha"] },
		negativeHints: { alpha: ["avoid"] },
	});
	const override = normalizeProfile({
		critical: ["beta"],
		queries: { alpha: ["two"], beta: ["three"] },
		clusters: { family: ["beta"] },
		negativeHints: { alpha: ["skip"] },
	});
	assert.deepEqual(mergeProfiles(base, override), {
		critical: ["alpha", "beta"],
		queries: { alpha: ["one", "two"], beta: ["three"] },
		clusters: { family: ["alpha", "beta"] },
		negativeHints: { alpha: ["avoid", "skip"] },
	});
});

test("mergeProfiles replaces activation metadata per owner and omits empty optional fields", () => {
	const base = normalizeProfile({ activation: {
		alpha: { kind: "specialist", tasks: ["software-change"] },
		shared: { kind: "workflow", tasks: ["software-design"] },
	} });
	const override = normalizeProfile({ activation: {
		alpha: { kind: "behavioral", tasks: ["software-review"] },
		shared: { kind: "specialist", tasks: ["software-test"] },
	} });
	assert.deepEqual(mergeProfiles(base, override).activation, {
		alpha: { kind: "behavioral", tasks: ["software-review"] },
		shared: { kind: "specialist", tasks: ["software-test"] },
	});
	assert.ok(!("activation" in mergeProfiles(normalizeProfile({}), normalizeProfile({}))));
});

test("splitProfileByScope preserves skills referenced only by clusters", () => {
	const profile = normalizeProfile({
		critical: ["global", "project"],
		queries: { global: ["g"], project: ["p"] },
		clusters: { mixed: ["global", "project"], only_cluster: ["orphan"] },
		negativeHints: { global: ["x"], project: ["y"] },
	});
	const { global, project } = splitProfileByScope(profile, new Set(["project"]));
	assert.deepEqual(global, {
		critical: ["global"],
		queries: { global: ["g"] },
		clusters: { mixed: ["global"], only_cluster: ["orphan"] },
		negativeHints: { global: ["x"] },
	});
	assert.deepEqual(project, {
		critical: ["project"],
		queries: { project: ["p"] },
		clusters: { mixed: ["project"] },
		negativeHints: { project: ["y"] },
	});
});

test("splitProfileByScope assigns activation metadata by owner key", () => {
	const profile = normalizeProfile({
		activation: {
			globalOwner: { kind: "specialist", tasks: ["software-change"] },
			projectOwner: { kind: "workflow", tasks: ["software-design"] },
		},
	});
	const { global, project } = splitProfileByScope(profile, new Set(["projectOwner", "projectTarget"]));
	assert.deepEqual(global.activation, { globalOwner: { kind: "specialist", tasks: ["software-change"] } });
	assert.deepEqual(project.activation, { projectOwner: { kind: "workflow", tasks: ["software-design"] } });
});

test("activation owner keys participate in profile scope repair but task labels do not", () => {
	const stored = (profile: unknown) => ({
		exists: true,
		profile: normalizeProfile(profile),
		hashes: {},
		initVersion: 4,
		revision: "revision",
	});
	const paths = { global: "global.json", project: "project.json" };
	assert.equal(needsProfileScopeRepair({
		paths,
		projectNames: new Set(["project-owner"]),
		global: stored({ activation: { "project-owner": { kind: "specialist", tasks: ["software-change"] } } }),
		project: stored({}),
	}), true);
	assert.equal(needsProfileScopeRepair({
		paths,
		projectNames: new Set(["project-owner"]),
		global: stored({ activation: { "global-owner": { kind: "specialist", tasks: ["software-change"] } } }),
		project: stored({}),
	}), false);
});
